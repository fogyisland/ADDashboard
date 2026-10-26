// R157.4 — partner-discover cron scheduler (was R156 30-day cadence;
// R157.4 lowers it to 5-minute cadence so the centre view stays close
// to real-time replication topology).
//
// Operator directive 2026-09-30 30:
//   "ad_partner_inbound_discover 这个包有问题,我们需要的是在 ad 这台
//    服务器上上报他有多少个复制伙伴 inbound, ... 这两个数据都要写入
//    数据表, ... 复制伙伴增加则写入,复制伙伴少了则删除"
//
// Why centre-driven cron in addition to agent intervalSec:
//   Manifest intervalSec is what the AGENT uses to decide when to run
//   collect.ps1 locally. For partner-discover the agent runs on its
//   own 5-min clock (intervalSec=300 in manifest.json — R157.4), but
//   the centre cron ALSO fires every 5 min so any agent that drifts
//   (sleeping laptop, paused NSSM service, etc.) is re-woken within
//   minutes of returning online. The two timers are not redundant — the
//   agent interval is the primary cadence; the centre cron is a
//   wake-up insurance.
//
// Mechanism (same as R156, R157.4 keeps it):
//   The scheduler writes a "trigger" row to package_runs with
//   status='pending_trigger' + a synthetic agent_id='__cron__'.
//   The centre's `/api/agent/packages/poll` endpoint reads this
//   table on every agent heartbeat and includes the trigger in the
//   response payload (`{ triggers: [{ name, runImmediately: true }] }`).
//   The agent's package-manager.js (R119) already supports signal-
//   triggered runs for ReplicationStatusEvent — the same mechanism
//   triggers partner-discover.

import { getDb } from '../db/index.js';
// R158.X.99.report (2026-10-21) — triggerOnce 改走这个 helper 替掉硬编码
//   `FROM dbo.package_policies` (MSSQL-only, MySQL 上语法错 + 被 dedup 分支
//   吞成静默成功). 1:1 平行 runner.js / script-service.js / builtin-packages.js
//   的既有用法.
import { packagePolicies } from '../db/sql/package-policies.js';

// R158.72.x.5 (2026-10-16) — DEFAULT_SCHEDULES export 给 server.js boot 调用.
//   (1:1 平行 R158.100 中心端 cron 通用 scheduler 范式 — R158.69.3 0 改
//   agent binary, 0 改 5 老包.)
export const DEFAULT_SCHEDULES = [
  {
    name: 'ad_partner_inbound_discover',
    // R158.X.99.11 (2026-10-17) — R157.4 5min cadence 切 daily 2:00 (跟 R158.72.x.13
    //   6 包 1:1 平行). 操作员 directive 锁 "因为当前的数据爱在跑" 5min 1 拍
    //   fire row 持续产生数据, 1 天 1 拍才是 by-design. 老 cronExpr='*/5 * * * *'
    //   保留注释以备回滚 (R158.111 改 src/ 完 ≠ 服务 reload, 必 nssm restart).
    // R157.4 — every 5 min (was '0 2 1 * *' = monthly in R156).
    cronExpr: '0 2 * * *',
    jitterMinutes: 30,
    description: 'R158.X.99.11 daily 2:00 + Jitter 0~30min per-DC (操作员 2026-10-17 锁 1:1 平行 R158.72.x.13 6 包 daily 2:00)'
  }
  // R158.10 (2026-10-01) — ad_partner_outbound_discover cron row
  //   removed (operator decision: 不需要 outbound partner)。该包
  //   builtin-packages.js 已不在 register list, agent 端 enabled=0
  //   不再 UPSERT, DB 端 ad_partner_outbound 表 TRUNCATE 但保留结构
  //   (供未来回滚)。
  // R158.72.x.12 C (2026-10-17) — 临时 rescue 走 R158.72.x.5 范式方案
  //   撤, 改走 B' 大改 (改 center + 改 agent 双边匹配). 真因: 走
  //   R158.72.x.5 范式必破 builtin-packages.js:756-759 wantInterval
  //   真因链 (manifest.agent.intervalSec=86400 → policyChanged →
  //   setPolicy 覆盖回 86400 → cron_assert_failed throw 永久).
  //   引入新例外比 B' 大改更危险, 撤 C ship 走 B'.
  // R158.72.x.13 (2026-10-17) — 6 老包 daily 2:00 + Jitter 0~30min per-DC
  //   (操作员 directive 字面 "另外支持每天启动时间定义 2:00:00 + agent 端
  //   cron 字段"). 1:1 平行 R158.72.x.5 Jitter 范式 (0~30min 错峰, 防止
  //   33 DC 同分钟 fan-out 阻塞). 中心端 cron = 唯一 fire 源, agent 端
  //   0.1.1 走 manifest.agent.cronExpr setTimeout 1 拍/天 0 双 fire. 跟
  //   R158.60.10 on-demand skip 1:1 平行, 跟 R158.72.x.5 ad_account_change
  //   1:1 平行 (已 ship 但 ship 闭合 ship 完 ship 走 manifest self-interval,
  //   R158.72.x.13 ship 闭合走中心端 cron, 中心端 cron = 唯一 fire 源).
  //   1 包 = ad_account_change. (R158.72.x.16 ship 把 ad_dc_probe_inbound
  //   移出 6 daily 2:00 范式, R158.72.x.17 ship 再把 ad_lockout_summary /
  //   ad_lockout_list / ad_failed_logon_collector / ad_os_baseline 4 包移出,
  //   改回 R155.3 原始 intervalSec=900 15 分钟范式 — 4 包都是高频语义:
  //   锁/登录/性能需要 15 分钟级即时反映, 跟"账户/成员变更"1 天 1 拍合规
  //   型 1:1 平行不成立.) ad_partner_inbound_discover 保留 */5 (R157.4 1:1
  //   平行, 0 必改).  0 引新 endpoint / 0 改 shouldFire 5-field 解析器 /
  //   0 改 fireTriggers 11 列 (R158.72.x.5 加 jitter_at 1:1 平行 +1 列
  //   cron_expr).
  // R158.X.99.18 (2026-10-18) — aac 切 triggerOnce-only 范式 (操作员 directive
  //   "停止 ad_account_change 在后台包执行计划的立即触发按钮改成单次触发").
  //   删 aac cron row: 0 中心端 cron fire. 1-click 路径保留 (R158.72.x.12 B' 范式
  //   + 前端按钮改名 "立即触发"→"单次触发"). 0 必恢复 daily 2:00 (R158.X.99.17.b
  //   dual 范式 ship 闭合 1h probe 失败, agent 端 setInterval 60s cadence 真因未
  //   闭合, 操作员 directive 重切单范式). 1:1 平行 R158.X.99.17.a 1.0.7 ship 范式.
  //   agent 端 0.1.8 binary + R158.X.99.13 真闭合 (intervalSec<=0 skip + removeCache
  //   主动清老 timer) = 33 DC 必停 setInterval. 必 nssm restart (R158.111 lesson).
  // R158.X.99.18.c (2026-10-18) — 操作员 directive "默认走计划方向, 后台能够走单次执行路线, 这不是各类计划都固定走的方向吗". 恢复 aac daily 2:00 schedule + 1-click triggerOnce 双范式 (跟 R158.X.99.17.b 1.0.8 dual 范式 1:1 平行, 区别是这次 ship 闭合路径跟 aam 1.0.2 1:1 平行 = intervalSec=86400 + cronExpr='0 2 * * *' + cron-scheduler row 恢复, 0 必 triggerOnce 端点 toggle 临时 enabled=1 路径). 1:1 平行 ad_admin_members R158.72.x.15 ship 范式 (1.0.2 ship 完 0 burst, 真闭合).
  // R158.X.99.22 (2026-10-18) — 操作员 directive 锁 "删除 ad_eventlog_collector 和 ad_account_change 的包执行计划".
  //   删 aac + aec 2 个 schedule row (中心端 cron 0 fire = 包执行计划删除). 1:1 平行
  //   R158.10 (2026-10-01) ad_partner_outbound_discover 删 cron row 注释 precedent
  //   (老 cronExpr 保留注释以备回滚, 0 中心端 cron fire). 0 改 agent binary (per 操作员
  //   "其他不懂"), 0 改 builtin-packages.js scripts/policies (enabled=1 保留, triggerOnce
  //   1-click 路径可测), 0 改 triggerNow 端点 (走 package_policies WHERE enabled=1, 0 走
  //   DEFAULT_SCHEDULES, 0 破). 1:1 平行 R158.X.99.18.c 1:1 恢复 aac 双范式 precedent:
  //   "默认走计划方向" 闭合成 "0 计划方向, 仅 1-click triggerOnce 路径保留"
  //   ,{ name: 'ad_account_change',            cronExpr: '0 2 * * *', jitterMinutes: 30, description: 'R158.X.99.18.c (2026-10-18) — 操作员 directive "默认走计划方向, 后台能够走单次执行路线". 1:1 平行 ad_admin_members R158.72.x.15 1.0.2 ship 范式: manifest.intervalSec=86400 + cronExpr="0 2 * * *" + 中心端 cron daily 2:00 + Jitter 0~30min per-DC = 唯一 scheduled fire 源. 1-click triggerOnce 路径必 ship R158.X.99.18.d 端点 toggle 临时 enabled=1 路径 (待 ship).' }
  // R158.72.x.14 (2026-10-17) — ad_eventlog_collector 补 ship. 1:1 平行 R158.72.x.13
  //   6 包范式. 操作员 directive 锁 "ad_eventlog_collector 改 2 小时一次, 当前 5min
  //   一次错" (实际 24h probe: package_policies.interval_sec=7200 已 2h, 但
  //   DEFAULT_SCHEDULES 不含 → 中心端 cron 0 fire → 纯 agent 端 setInterval
  //   范式, 偏离 R158.72.x.13 双 fire 治本). 走 */2 hour 12 拍/天 + Jitter
  //   0~5min 错峰 (5 channel collector 单次 ~10-30s, 比 6 daily 包 fan-out 轻,
  //   jitter 缩到 5min). 0 引新 endpoint / 0 改 shouldFire 解析器 (0 */2 * * *
  //   shouldFire 测过支持, agent 端 cron-parser.js 1:1 平行支持).
  // R158.X.99.22 (2026-10-18) — 同 R158.X.99.22 aac 删 row 注释, 操作员 directive
  //   锁 "删除 ad_eventlog_collector 和 ad_account_change 的包执行计划". 1:1 平行
  //   R158.10 删 cron row 注释 precedent (老 cronExpr='0 */2 * * *' 保留以备回滚).
  //   0 改 agent binary, 0 改 builtin-packages.js, 0 改 triggerNow 端点.
  //   ,{ name: 'ad_eventlog_collector',        cronExpr: '0 */2 * * *', jitterMinutes: 5, description: 'R158.72.x.14 (2026-10-17) */2h 12 拍/天 + Jitter 0~5min per-DC (操作员 directive 锁, 1:1 平行 R158.72.x.13 范式)' }
  // R158.72.x.15 (2026-10-17) — ad_admin_members 补 ship. 1:1 平行 R158.72.x.13
  //   6 包 daily 2:00 范式 (操作员 directive 锁 "定义2点触发"). R158.95 ship
  //   时配 intervalSec=86400, AD agent 端 setInterval 24h 0 fire (跟 R158.X.99.10
  //   aac 1:1 平行 bug, 形态不同 aac=1ms 连续 fire, aam=0 fire). R158.72.x.13
  //   6 包切 cronExpr 范式时漏了 ad_admin_members, 本 ship 闭合. 中心端 cron =
  //   唯一 fire 源, agent 0.1.7 走 manifest.agent.cronExpr setTimeout 24h 1 拍
  //   0 双 fire.  0 改 agent binary (0.1.7 已吃 cronExpr 路径).
  ,{ name: 'ad_admin_members',              cronExpr: '0 2 * * *', jitterMinutes: 30, description: 'R158.72.x.15 (2026-10-17) daily 2:00 + Jitter 0~30min per-DC (操作员 directive 锁 "定义2点触发", 1:1 平行 R158.72.x.13 6 包 范式)' }
];

// SQLite-style "minute bucket" — collapse to Y/M/D/H:M so the same
// minute doesn't write two trigger rows even if shouldFire() matches
// twice within the same minute (defence against drift).
function minuteBucket(now) {
  const y = now.getFullYear();
  const mo = now.getMonth();
  const day = now.getDate();
  const h = now.getHours();
  const mi = now.getMinutes();
  return y * 12 * 31 * 24 * 60 + mo * 31 * 24 * 60 + day * 24 * 60 + h * 60 + mi;
}

/**
 * Decide whether the cron should fire on the current minute.
 *
 * Pure function — takes current Date + a cron expression, returns
 * true if the minute matches. We deliberately use a 1-minute polling
 * window inside the centre process (no setInterval) so any restart of
 * the centre gracefully resumes the schedule by simply running
 * `shouldFire()` on every tick.
 *
 * @param {Date} now
 * @param {string} cronExpr — standard 5-field cron (minute hour day-of-month month day-of-week)
 * @param {{ value: number|null }} [lastFireBucket] — mutable bucket ref so the
 *   closure-owned lastFireAt is shared across schedules / ticks. Pass `{ value: null }`
 *   on first call.
 */
export function shouldFire(now, cronExpr, lastFireBucket = { value: null }) {
  // Minimal cron parser — minute / hour / day-of-month / month / day-of-week.
  // Supports `*` (any), `N` (specific value), and `*/N` (every-N step). No list
  // (1,3,5) or range (1-5) support — our schedules are concrete or step forms
  // only (0 2 1 * *, */5 * * * *).
  function fieldMatches(field, value, max) {
    if (field === '*') return true;
    // `*/N` step form — fire when value % N === 0
    if (field.startsWith('*/')) {
      const step = Number(field.slice(2));
      if (!Number.isFinite(step) || step <= 0) return false;
      return value % step === 0;
    }
    // Concrete number
    return Number(field) === value;
  }
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) {
    // R157.9 — surface the bad cron expression instead of silently
    // returning false (code review M6). Operator sees a one-line
    // log warn per tick on the offending schedule. The schedule
    // itself is still skipped, but the operator now knows WHY.
    if (lastFireBucket.value !== 'BAD_EXPR:' + cronExpr) {
      lastFireBucket.value = 'BAD_EXPR:' + cronExpr;
      // eslint-disable-next-line no-console
      console.warn(`[cron-scheduler] shouldFire: cron expression must have 5 fields, got ${parts.length}: "${cronExpr}" — schedule will be skipped`);
    }
    return false;
  }
  const [m, h, dom, mon, dow] = parts;
  const min = now.getMinutes();
  const hour = now.getHours();
  const day = now.getDate();
  const month = now.getMonth() + 1;
  const weekday = now.getDay(); // 0 = Sunday
  if (!fieldMatches(m, min, 59)) return false;
  if (!fieldMatches(h, hour, 23)) return false;
  if (!fieldMatches(dom, day, 31)) return false;
  if (!fieldMatches(mon, month, 12)) return false;
  if (!fieldMatches(dow, weekday, 6)) return false;
  // Avoid double-firing within the same minute. lastFireBucket.value is
  // the last minute bucket we fired on; if it equals the current bucket
  // we already wrote a trigger this minute and shouldn't write another.
  const bucket = minuteBucket(now);
  if (lastFireBucket.value === bucket) return false;
  return true;
}

/**
 * Write a pending_trigger row to package_runs for each schedule that
 * should fire this minute. Idempotent on the (name, started_at minute)
 * pair — re-running the same minute is a no-op.
 *
 * Bug fix (2026-09-30 S1 — see dashboard-code-review-2026-09-30.md):
 * the original code used MSSQL-style named placeholders (`@name`,
 * `@since`) which the driver wrappers don't bind (`db/drivers/mssql.js`
 * only rewrites `?` → `@pN`). It also bound only 4 params while the SQL
 * referenced 6 names. We now rewrite the INSERT as a single statement
 * with positional `?` bindings (works on both dialects — MSSQL driver
 * routes through request.query and MySQL driver through pool.execute).
 *
 * @param {object} opts
 * @param {import('../db/index.js').Db} [opts.db]
 * @param {object|null} [opts.logger]
 * @param {Date} [opts.now]
 * @param {Array} [opts.schedules]
 * @param {{ value: number|null }} [opts.lastFireBucket] — shared minute-bucket
 *   ref so multiple calls in the same minute skip past.
 */
export async function fireTriggers({
  db = getDb(),
  logger = null,
  now = new Date(),
  schedules = DEFAULT_SCHEDULES,
  lastFireBucket = { value: null },
  // R158.72.x.12 B' (2026-10-17) — trigger once 大改 (改 center + 改 agent
  //   双边匹配, 跟 R158.60.10 "intervalSec 0=on-demand skip / 86400=self-setInterval"
  //   双 idiom 1:1 平行扩展为第 3 idiom). triggerOnce=true → INSERT 写
  //   trigger_once=1 字段, agent 端 1.0.7 看到后跑 1 次 0 启 setInterval
  //   (R158.60.10 on-demand skip 1:1 平行). triggerOnce=false (default)
  //   → trigger_once=0, agent 端 1.0.7 走 R158.72.x.11 self-interval anchor
  //   范式 启 setInterval intervalSec=86400 24h 1 拍 (跟 R158.60.10
  //   86400 idiom 1:1 平行). 0 引新 endpoint / 0 引新 wrapper / 0 改 schema
  //   (跟 R158.72.x.5 ALTER jitter_at 1:1 平行 1 次性 ALTER ADD trigger_once
  //   BIT NULL). 复用 trigger-now 端点 req.body.triggerOnce 透传.
  triggerOnce = false,
  // R158.X.99.20 (2026-10-18) — 中心端 triggerNow 接 targetDcs 闭合
  //   R158 (2026-09-30) ship 时留的 TODO "agentIds is advisory (currently
  //   NOT used to filter)". null/undefined/[] = 向后兼容 ("全 enabled DC
  //   触发"); 否则 = 只发到指定 DC subset. CSV 写 package_runs.target_agents
  //   (e.g. 'KDLDLOFADSRV1,KDLDLOFADSRV2'), NULL = 全员触发. agent 端
  //   claimPendingTriggers 加 WHERE (t.target_agents IS NULL OR
  //   CHARINDEX(?, t.target_agents) > 0) (MSSQL) / LOCATE (MySQL) 1:1 平行.
  targetDcs = null
} = {}) {
  const fired = [];
  for (const sched of schedules) {
    if (!shouldFire(now, sched.cronExpr, lastFireBucket)) continue;
    // R157.9 — truncate started_at to the minute boundary (code review
    // M7). Pre-fix, both the INSERT column and the NOT EXISTS
    // comparison used `now` (millisecond precision). Two fireTriggers
    // calls within the same minute but >1ms apart would write two
    // distinct rows because `started_at >= now` matched the prior
    // row using a different now value. Truncating to the minute
    // floor makes the idempotency window align with shouldFire()'s
    // minuteBucket dedup — both checks see the same minute.
    const nowMinute = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
      now.getHours(), now.getMinutes(), 0, 0);
    // R158 — add status='pending_trigger' to the INSERT column list. Pre-fix,
    // status was missing from the column list, so the trigger row had
    // status=NULL/default — making `WHERE status='pending_trigger'`
    // queries (src/db/sql.js:150 / :1493 pendingPartnerDiscovers, and the
    // new trigger-queue.js claim) return zero rows. The agent never
    // pulled the trigger, partner-discover collect.ps1 never ran, and
    // ad_partner_inbound/outbound stayed empty for every agent that didn't
    // also self-report via intervalSec. With status now in the INSERT,
    // the cron path produces a real pending_trigger row that the agent's
    // heartbeat (which reads packagesTriggers) consumes within ≤ 60s.
    // R158.9 (2026-09-30) — bug fix. Cron was writing status='__cron__'
    // instead of status='pending_trigger'. Effect: pendingPartnerDiscovers
    // (sql.js:150/1497) and claimPendingTriggers (trigger-queue.js:84/105)
    // both filter on status='pending_trigger' so they never matched the
    // actual rows cron wrote. Result: agents never claimed the partner-
    // discover triggers, collect.ps1 never executed, ad_partner_inbound/
    // outbound stayed at 0 rows forever. Fix: status MUST be the literal
    // string 'pending_trigger' (not 'cron-trigger' / '__cron__' / anything
    // else). The NOT EXISTS dedup sub-query at line 196 also uses the
    // literal 'pending_trigger' — both must agree, otherwise cron dedup
    // races and the trigger-queue claim races independently.
    // R158.72.x.5 (2026-10-16) — Jitter 错峰 (per-DC 随机 0~30min 偏移,
    //   schedules[].jitterMinutes 字段). R158.72.x.11 (2026-10-17) — 删
    //   ad_account_change schedule row 后, 这段通用 Jitter 计算保留
    //   给未来 schedule (jitterMinutes undefined 走 0 偏移, jitter_at=NULL
    //   write — 0 regression). jitter_at 仍 minute-floor (整秒) 跟 R157.9
    //   dedup 1:1 平行. ad_account_change 切到 manifest.intervalSec=86400
    //   agent self-setInterval 模式 (R158.60.10 + R158.69.3 锁 1:1 平行),
    //   0 中心端 cron fire.
    // R158.72.x.12 C (2026-10-17) — 临时 rescue 走 R158.72.x.5 范式方案
    //   撤, 改走 B' 大改 (改 center + 改 agent 双边匹配). 原因: 走 R158.72.x.5
    //   范式必破 builtin-packages.js:756-759 wantInterval 真因链
    //   (manifest.agent.intervalSec=86400 → policyChanged → setPolicy
    //   覆盖回 86400 → cron_assert_failed throw 永久). 引入新例外比 B'
    //   大改更危险, 撤 C ship 走 B'. Assert 段 (R158.72.x.5 加的) 也同
    //   步撤, 跟 R158.72.x.11 ship 闭合 0 加回 1:1 平行.
    let jitterAt = null;
    if (sched.jitterMinutes && sched.jitterMinutes > 0) {
      const offsetSec = Math.floor(Math.random() * sched.jitterMinutes * 60);
      jitterAt = new Date(nowMinute.getTime() + offsetSec * 1000);
    }
    const params = [
      '__cron__',
      sched.name,
      nowMinute,
      'cron-trigger',
      'pending_trigger',
      jitterAt,
      triggerOnce ? 1 : 0,  // R158.72.x.12 B' (2026-10-17) — trigger once 字段
      sched.cronExpr,        // R158.72.x.13 (2026-10-17) — +1 列 cron_expr
      // R158.X.99.20 (2026-10-18) — +1 列 target_agents (CSV, NULL = 向后兼容)
      targetDcs && Array.isArray(targetDcs) && targetDcs.length > 0
        ? targetDcs.join(',')
        : null,
      sched.name,
      nowMinute
    ];
    try {
      // INSERT ... SELECT ... WHERE NOT EXISTS — single statement,
      // positional placeholders, works on both MySQL and MSSQL. The
      // NOT EXISTS guard makes the row write idempotent on the
      // (package_name, started_at_minute, status='pending_trigger') triple
      // so re-running the same minute is safe even if shouldFire() races.
      // Both timestamps are truncated to the minute floor (R157.9) so
      // concurrent fireTriggers calls within the same JS event-loop tick
      // land on identical started_at values.
      // R158.72.x.5 — +1 列 jitter_at (per-DC 随机 0~30min, NULL = 老 schedule
      //   0 改). 跟 R158.69 trigger-queue.js claim 0 互撞 (claim 只看 started_at).
      // R158.72.x.12 B' (2026-10-17) — +1 列 trigger_once (BIT, default 0).
      //   0=走 R158.72.x.11 self-interval anchor 范式 24h 1 拍 (default
      //   schedule cron / agent 端 setInterval 启动), 1=走 R158.60.10
      //   on-demand skip 范式 1 click 1 跑 0 启 setInterval. 操作员
      //   directive 字面 "我们支持默认的 Schedule, 同时支持 trigger once,
      //   这个是必须两个都要支持, 否则我希望 agent 上报就没法实现".
      //   跟 R158.72.x.5 ALTER jitter_at 1:1 平行 1 次性 ALTER ADD.
      // R158.72.x.13 (2026-10-17) — +1 列 cron_expr (VARCHAR(64)).
      //   写 sched.cronExpr (e.g. '0 2 * * *') 供 R158.72.x.13 ship 后
      //   admin / report 端 observe (跟 R158.72.x.5 jitter_at NULL 1:1 平行,
      //   老 schedule 0 必改 cron_expr 字段). 1:1 平行 package_policies
      //   .cron_expr ADD 1 次性 ALTER. 0 改 shouldFire / 0 改 schedule 0
      //   改 fireTriggers 11 列其他字段.
      await db.execute(
        `INSERT INTO package_runs (agent_id, package_name, started_at, finished_at, exit_code, stdout_preview, stderr_preview, error, script_version, status, jitter_at, trigger_once, cron_expr, target_agents)
         SELECT ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM package_runs
           WHERE package_name = ? AND started_at >= ? AND status = 'pending_trigger'
         )`,
        params
      );
      fired.push(sched.name);
      logger?.info?.({
        event: 'partner_discover.cron_fired',
        packageName: sched.name,
        cronExpr: sched.cronExpr,
        firedAt: now.toISOString(),
        jitterAt: jitterAt ? jitterAt.toISOString() : null,
        offsetSec: jitterAt ? Math.floor((jitterAt.getTime() - nowMinute.getTime()) / 1000) : 0
      }, 'partner-discover cron trigger written');
    } catch (e) {
      logger?.error?.({
        event: 'partner_discover.cron_failed',
        packageName: sched.name,
        err: e?.message || String(e)
      }, 'partner-discover cron trigger write failed');
    }
  }
  if (fired.length) lastFireBucket.value = minuteBucket(now);
  // R158.X.99.24 (2026-10-18) — 改 30min → 1min DELETE 兜底. R158.Y
  //   (2026-10-16) ship 30min 兜底 0 救 0.1.6/0.1.7/0.1.8 binary agent
  //   端 setInterval 30s cadence 错位 (R158.69 真因 + lesson 14+20 锁)
  //   拉 老 trigger row 跑 1 拍 (1min cadence) 真因. 30min 内必 30 拍
  //   burst, 0.1.8 binary 端 fire 路径 0 走中心端 cron 0 走 triggerNow,
  //   1:1 平行 R158.X.99.10 setInterval 0 启真因. 修: 30min → 1min
  //   兜底 1:1 平行 aac 1min cadence 闭合. 0 改 agent, 0 改前端, 0
  //   改 wire shape, 0 改 1.0.11 disk, 0 push 0.1.8 fleet. 1 file +2
  //   line. nssm restart 必跑 (R158.111 lesson 锁, module cache stale
  //   0 加载新 setInterval 间隔). 1:1 平行 R158.X.99.9 completion
  //   1min→30min 窗口扩 (反向: 30min → 1min 兜底 = 1min cadence 闭
  //   合 100%). lesson 41 锁: 任何 ship 兜底时间 < 真因 cadence 1:1
  //   平行闭合. 24h+72h probe 必 0 重复 (R158.86 锁, 操作员 lock push
  //   0.1.8 fleet 前 100% 闭合).
  // R158.Y (2026-10-16) 原注释保留:
  //   clean up stuck pending_trigger rows older than 30min (改 1min).
  //   145 rows 24h 累积的根因是 markTriggerConsumed 死代码
  //   (trigger-queue.js:147-174 0 caller), 原 row 永远 status='pending_trigger'
  //   留 DB. 改后 1min 阈值 = 1min cadence × 1, fleet 拉到 + agent 跑 + 上报
  //   整链路 远 < 1min, 1min 前还没 dedup = 真 stuck. 独立 try/catch 不挡 fire.
  //   0 改 agent, 0 改前端, 0 改 wire shape, 0 改老包 (R158.69.3 + R158.69 锁).
  try {
    await db.execute(
      db.dialect === 'mssql'
        ? `DELETE FROM package_runs
           WHERE agent_id = '__cron__'
             AND status = 'pending_trigger'
             AND started_at < DATEADD(MINUTE, -1, SYSUTCDATETIME())`
        : `DELETE FROM package_runs
           WHERE agent_id = '__cron__'
             AND status = 'pending_trigger'
             AND started_at < UTC_TIMESTAMP() - INTERVAL 1 MINUTE`
    );
  } catch (_cleanupErr) {
    // 清理失败不挡 fire / 不挡 trigger; 下次 fireTriggers tick 还会再试
  }
  return fired;
}

/**
 * Start the cron scheduler. Polls every 60 s; on a match, writes a
 * pending_trigger row. Returns a `{ stop() }` handle so the server
 * can cancel the loop on shutdown without colliding with another
 * concurrent start (the previous module-level timer was a singleton
 * that silently swallowed a second `start` and let `stop` clear the
 * wrong timer — see dashboard-code-review-2026-09-30.md S5).
 *
 * @param {object} opts
 * @param {import('../db/index.js').Db} [opts.db]
 * @param {object|null} [opts.logger]
 * @param {Array} [opts.schedules]
 * @param {number} [opts.tickMs=60000]
 */
export function startPartnerDiscoverCron({
  db = getDb(),
  logger = null,
  schedules = DEFAULT_SCHEDULES,
  tickMs = 60_000
} = {}) {
  // R158.72.x.5 (2026-10-16) — R159 dead code 激活. 旧名 startPartnerDiscoverCron
  //   仅服务 R157.4 ad_partner_inbound_discover. R158.72.x.5 加 ad_account_change
  //   24h cadence + Jitter 0~30min, 改名 startCentreCron 1:1 反映 R158.159 retired
  //   后中心端 cron 通用 scheduler 角色. 老名 startPartnerDiscoverCron 保留 0 删
  //   (R158.X.99.6 0 删旧 export 1:1, 0 改任何 caller 兼容性).
  // Closure-owned state — mirrors dc-partners-refresh.js:185-231 so
  // each start gets its own (timer / stopped / inFlight / lastFireBucket)
  // and stop() only touches its own timer. No module-scope singletons.
  let stopped = false;
  let inFlight = false;
  let timerHandle = null;
  // lastFireBucket is referenced by both shouldFire() (read) and
  // fireTriggers() (write) — the bucket value is the last minute we
  // fired on; equals the current minute ⇒ skip.
  const lastFireBucket = { value: null };

  function schedule() {
    if (stopped) return;
    timerHandle = setTimeout(tick, tickMs);
  }

  async function tick() {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await fireTriggers({ db, logger, schedules, lastFireBucket });
    } catch (e) {
      logger?.error?.({
        event: 'partner_discover.cron_tick_error',
        err: e?.message || String(e)
      }, 'partner-discover cron tick failed');
    } finally {
      inFlight = false;
      schedule();
    }
  }

  logger?.info?.({
    event: 'partner_discover.cron_started',
    schedules: schedules.map((s) => ({ name: s.name, cron: s.cronExpr }))
  }, 'partner-discover cron scheduler started');
  schedule();

  return {
    stop() {
      stopped = true;
      if (timerHandle) {
        clearTimeout(timerHandle);
        timerHandle = null;
      }
    }
  };
}

/**
 * R158.X.99.26 (2026-10-18) — `triggerOnce` rename + shouldFire 旁路真闭合.
 *
 * 真因: R158.X.99.23 ship 把 triggerNow 调 fireTriggers 路径塞了
 *   cronExpr='0 0 31 2 *' 永不命中, 应该 fireTriggers 的 shouldFire 永 false
 *   → fired.push 永不执行 → 返回 fired:[] → 前端 UI 显"0 拍".
 *   实际 row 是别处 (cron DEFAULT_SCHEDULES daily 2:00 + agent setInterval
 *   60s cadence burst 真因未闭合) 写的, 跟 triggerNow 无关. 资深架构师
 *   2026-10-18 5 段真因链 100% 锁定 (DB 实测 fireTriggers 真 fire 返回
 *   [], 但 ad_account_change 15:19 一波 success row trigger_once=null).
 *
 * 操作员 directive (2026-10-18): 函数 + 端点 rename `triggerNow` →
 *   `triggerOnce`, 函数名语义更准确 (这条路径本来就 triggerOnce 的语义,
 *   跟 fireTriggers 的 cron 路径语义不同). 0 rename fireTriggers (cron 路径
 *   走 DEFAULT_SCHEDULES schedule array 0 变). 1 file 1 function rename +
 *   inline INSERT 14 列 1:1 平行 fireTriggers:332-340.
 *
 * Inline INSERT 14 列 (跟 fireTriggers:333-339 1:1 平行, 0 引新 SQL):
 *   agent_id='__cron__' / status='pending_trigger' / script_version=
 *   'admin-trigger:<actor>' (R158.100 ship 时留的注释说 'admin-trigger:<actor>'
 *   但实际 cron 路径 fireTriggers 写的是 'cron-trigger' — 这条 triggerOnce
 *   路径用 'admin-trigger:<actor>' 1:1 平行 docstring)/ trigger_once=1
 *   (R158.72.x.12 B' 透传)/ cron_expr='0 0 31 2 *' (永不命中, 留作
 *   audit/observe marker)/ target_agents=CSV 透传 (R158.X.99.20 透传).
 *   NOT EXISTS dedup 跟 fireTriggers:335-338 1:1 平行 (同 minute 同 package
 *   pending_trigger row 已存在则 dedup 跳过, 操作员观察 = "已触发过").
 *
 * 0 schema / 0 wire / 0 agent / 0 builtin-packages.js / 0 package_policies /
 *   0 fireTriggers 主路径 改. 1:1 平行 R158.X.99.18.c 1:1 恢复 aac 双范式
 *   precedent (cron + 1-click 各走各的 INSERT, 不混).
 *
 * Lesson 43: 任何 ship rename 函数名必 verify caller 1:1 同步 (router.js:336
 *   + scripts/ 3 文件 + 前端 packages.js:55 1:1). lesson 12 build:web 必跑
 *   (前端 dist 同步). lesson R158.111 nssm restart 必跑.
 *
 * @param {string} packageName
 * @param {object} opts
 * @param {import('../db/index.js').Db} [opts.db]
 * @param {object|null} [opts.logger]
 * @param {string|null} [opts.actor='unknown']
 * @param {string[]|null} [opts.targetDcs=null]
 * @returns {Promise<{ok: boolean, fired: boolean, at: Date, targetDcs: string[]|null, packageName: string, error?: string}>}
 */
export async function triggerOnce(packageName, {
  db = getDb(),
  logger = null,
  actor = 'unknown',
  targetDcs = null
} = {}) {
  // R158.100 (2026-10-14) — broaden trigger-now to any enabled package.
  // 0 schema change. 0 router change (router 必 1:1 同步 rename). 0 33-DC change.
  // 0 agent change. db.query returns { rows } across both mysql and mssql drivers.
  //
  // R158.X.99.report (2026-10-21) — 修 MySQL 下静默失败. 此前这里是 inline
  //   `FROM dbo.package_policies`, 而 `dbo.` 是 MSSQL 的 schema 前缀 —— 本项目
  //   双方言支持, 这是全仓**唯一**一处硬编码 `dbo.` 的地方. 在 MySQL 上该
  //   语句直接抛语法错, 被下面的 dedup 逻辑当成"已触发过"吞掉, UI 显示
  //   "已触发", 实际一次都没触发.
  //   改走 sql/package-policies.js 的 packagePolicies.getByName —— 1:1 平行
  //   runner.js:501 / script-service.js:473 / builtin-packages.js:824 三处
  //   既有用法 (import + 显式传 db). 注意它跟 `db.sql.packagePolicies.*` 的
  //   raw SQL 字符串对象**不是一回事**: 前者是 async helper, 返回 hydrated
  //   row 且 `enabled` 已是 boolean (package-policies.js:111), 后者是裸 SQL.
  //   hydrate 保证 mysql (0/1) 与 mssql (bit) 都归一成 boolean, 所以这里用
  //   truthy 判定即可; 双方言 SQL 在 helper 内部按 db.dialect 分支.
  const policyRow = await packagePolicies.getByName(db, packageName);
  if (!policyRow || !policyRow.enabled) {
    throw new Error(`unknown or disabled package: ${packageName}`);
  }

  // R158.X.99.26 — minute floor (跟 fireTriggers:249-250 + R157.9 M7 1:1 平行).
  const now = new Date();
  const nowMinute = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
    now.getHours(), now.getMinutes(), 0, 0);

  // R158.X.99.26 — inline INSERT 14 列, 1:1 平行 fireTriggers:332-340.
  // NOT EXISTS dedup: 同 minute 同 package pending_trigger row 已存在则跳过,
  // 操作员 UI 显示"已触发过" (跟 fireTriggers dedup 行为 1:1 平行).
  //
  // script_version 列 VARCHAR(32) 必 ≤ 32 chars. prefix 'admin-trigger:' = 14 chars
  //   + 后缀 actor ≤ 17 chars (32 - 14 - 1 separator). safeActor.slice(0, 17)
  //   强截断 + alphanumeric only 防止特殊字符.
  const safeActor = (typeof actor === 'string' && actor.length > 0)
    ? actor.replace(/[^a-zA-Z0-9_:\-]/g, '_').slice(0, 17)
    : 'unknown';
  const csvTargets = (Array.isArray(targetDcs) && targetDcs.length > 0)
    ? targetDcs.filter((s) => typeof s === 'string' && s.length > 0).join(',')
    : null;

  const params = [
    '__cron__',
    packageName,
    nowMinute,
    'admin-trigger:' + safeActor,
    'pending_trigger',
    null,                    // jitter_at (1-click 0 jitter, 跟 R158.72.x.5 1:1 平行)
    1,                       // trigger_once=1 (R158.72.x.12 B' 透传)
    '0 0 31 2 *',            // cron_expr 永不命中, 仅 audit/observe marker
    csvTargets               // R158.X.99.20 透传 target_agents CSV
  ];
  try {
    const r = await db.execute(
      `INSERT INTO package_runs (agent_id, package_name, started_at, finished_at, exit_code, stdout_preview, stderr_preview, error, script_version, status, jitter_at, trigger_once, cron_expr, target_agents)
       SELECT ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM package_runs
         WHERE package_name = ? AND started_at >= ? AND status = 'pending_trigger'
       )`,
      [...params, packageName, nowMinute]
    );
    const affected = (r && (r.affectedRows ?? r.rowsAffected ?? (Array.isArray(r.rows) ? r.rows.length : 0))) || 0;
    logger?.info?.({
      event: 'packages.trigger_once',
      packageName,
      actor: safeActor,
      cronExpr: '0 0 31 2 *',
      firedAt: now.toISOString(),
      targetDcs: csvTargets,
      affectedRows: affected
    }, 'trigger-once 1-click INSERT written');
    // Invalidate the partner-discover ad_dcs cache so the next ETL
    // batch re-queries (cheap, no harm).
    try {
      const { invalidateDcSetCache } = await import('./partner-discover.js');
      invalidateDcSetCache();
    } catch (e) {
      // circular import guard — module may not be loaded yet on first boot
    }
    return {
      ok: affected > 0,
      fired: affected > 0,
      at: now,
      targetDcs: csvTargets ? csvTargets.split(',') : null,
      packageName,
      deduplicated: affected === 0
    };
  } catch (e) {
    // mssql driver 在 NOT EXISTS 跳过时会抛 "SCOPE_IDENTITY() returned NULL" — 这是
    // dedup 命中的正常路径, 不是真错. 其它真异常才当真 error.
    //
    // R158.X.99.report (2026-10-21) — 收紧匹配. 此前是
    //   /SCOPE_IDENTITY|returned NULL|rowsAffected/i
    // 三个**子串**分支, 其中 `returned NULL` 和 `rowsAffected` 太泛: 任何提到
    // 这两个词的真错误 (连接超时、权限不足、语法错) 都会被判成 "dedup 正常跳过",
    // 于是 triggerOnce 返回 ok 但实际一次都没触发, UI 显示"已触发" —— 静默失败.
    // 改成整条特征的**完整**匹配: 驱动抛的就是这一句固定文本
    // (drivers/mssql.js:221 `SCOPE_IDENTITY() returned NULL after INSERT (rowsAffected=N)`),
    // 用完整短语做 includes 才既覆盖真 dedup 又不放行别的错误.
    const msg = e?.message || String(e);
    const isDedupNoise = /SCOPE_IDENTITY\(\) returned NULL after INSERT/i.test(msg);
    if (isDedupNoise) {
      logger?.info?.({
        event: 'packages.trigger_once_dedup',
        packageName,
        actor: safeActor,
        cronExpr: '0 0 31 2 *',
        firedAt: now.toISOString(),
        targetDcs: csvTargets
      }, 'trigger-once 1-click NOT EXISTS dedup skipped (mssql driver noise)');
      return {
        ok: false,
        fired: false,
        deduplicated: true,
        at: now,
        targetDcs: csvTargets ? csvTargets.split(',') : null,
        packageName
      };
    }
    logger?.error?.({
      event: 'packages.trigger_once_failed',
      packageName,
      actor: safeActor,
      err: msg
    }, 'trigger-once 1-click INSERT failed');
    return {
      ok: false,
      fired: false,
      at: now,
      targetDcs: csvTargets ? csvTargets.split(',') : null,
      packageName,
      error: msg
    };
  }
}

// R158.72.x.5 (2026-10-16) — R159 dead code 激活. 旧名 startPartnerDiscoverCron
//   仅服务 R157.4 ad_partner_inbound_discover. R158.72.x.5 加 ad_account_change
//   24h cadence + Jitter 0~30min, 改名 startCentreCron 1:1 反映 R158.159 retired
//   后中心端 cron 通用 scheduler 角色. 老名 startPartnerDiscoverCron 保留 0 删
//   (R158.X.99.6 0 删旧 export 1:1, 0 改任何 caller 兼容性).
//
//   server.js 重新 import + boot 调用: 在 directorySyncLoop / dcPartnersRefreshLoop
//   后面 1:1 平行. R158.69.3 铁律 0 改 agent binary, 0 改 5 老包
//   (ad_admin_members / ad_lockout_list / ad_partner_inbound_discover /
//   failed_logon_collector / ad_os_baseline).
//
//   Handle 挂 module-level ref (跟 R158.86.6 drainer / R158.89 member-port
//   scheduler 1:1 平行), 让 server.js shutdown 必能 stop, 0 必抓 handle
//   走回 boot 栈.
let centreCronHandle = null;

export function startCentreCron(opts = {}) {
  if (centreCronHandle) {
    // already started — R158.86.6 #3 lesson (drainer/scheduler 必 enumerate
    // 所有 runtime branch) — 防止双 start 导致 2 timer 互绕.
    return centreCronHandle;
  }
  centreCronHandle = startPartnerDiscoverCron(opts);
  return centreCronHandle;
}

export function stopCentreCron() {
  if (!centreCronHandle) return;
  try {
    centreCronHandle.stop();
  } catch (_) { /* best-effort */ }
  centreCronHandle = null;
}