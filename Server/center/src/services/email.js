// center/src/services/email.js
// SMTP delivery facade (Task 9) + delivery loop (Task 11).
//
// Pure-function exports:
//   maskPassword(cfg)          strip password from a config blob for logging
//   nextAttemptDelay(attempts, initialSeconds)  exponential backoff capped at 1h
//   send({smtp, from, to, cc, subject, text, html}, _deps)
//                              hand off to nodemailer; returns {ok, error?}
//
// Factory export (Task 11):
//   createEmailDeliveryLoop({ db, getIntervalSeconds, getSystemConfig, sendImpl, _deps })
//                              matches the createProbeLoop shape (see
//                              center/src/services/probe.js) — {start, stop, tick,
//                              isRunning}. Reads pending rows from
//                              alert_email_outbox (sent_at IS NULL AND
//                              next_attempt_at <= NOW()), calls send() per row,
//                              stamps sent_at on success, schedules retries on
//                              failure, and emits a cooldown_skipped alert_event
//                              once attempt_count reaches alert_email_max_attempts.
//                              `_deps` is forwarded to send() so tests can inject
//                              a stub createTransport without monkey-patching
//                              nodemailer.
//
// Per Global Constraint #9: alert_eval_interval_seconds has a 10-second floor.
// Per Global Constraint #8: matches createProbeLoop shape; inFlight guard;
//   setInterval-based; mounted in server.js normal-mode only.

import nodemailer from 'nodemailer';
import { getConfig } from './config.js';
// R161.11 (2026-10-26) — DB 错误分类 (双方言), 用于给投递链路的失败日志
//   带上 kind。0 改任何行为, 只提供"看得懂"的日志字段。
import { classifyDbError } from '../utils/dbError.js';

export function maskPassword(cfg) {
  const masked = { ...cfg };
  if (masked.smtp_password) masked.smtp_password = '********';
  return masked;
}

export function nextAttemptDelay(attemptCount, initialSeconds) {
  return Math.min(3600, initialSeconds * Math.pow(2, attemptCount - 1));
}

export async function send(
  { smtp, from, to, cc, subject, text, html },
  _deps = {}
) {
  // R158.16 (2026-10-01) -- L2 兜底拦截. email.send() 是模块对外的纯函数,
  // 任何调用方都过这里, 因此即便 L1 (admin route 入口检查) 失效或未来新增
  // 调用路径, 关闭时也直接拒绝. 防御未来 admin route 之外的路径 (例如
  // 未来的 /api/system/test-email 或调试脚本) 绕过 L1.
  //
  // _deps 注入 (测试用) 可传 `emailEnabledOverride` 强制 true 跳过 L2, 让
  // 单元测试能在 email_enabled='0' 状态测 send() 实际 SMTP 路径而不需要
  // 全局 toggle. 默认无 override → 走真实 config.
  if (!_deps.emailEnabledOverride) {
    try {
      const cfg = await getConfig();
      const emailEnabled = String(cfg?.email_enabled ?? '0') === '1';
      if (!emailEnabled) {
        return { ok: false, error: '邮件功能已关闭 (email_enabled=0)', blocked: true };
      }
    } catch (err) {
      // best-effort: config 读失败时按 "关闭" 处理, fail-closed
      return { ok: false, error: `email_enabled read failed: ${err.message}`, blocked: true };
    }
  }
  try {
    const createTransport = _deps.createTransport ?? nodemailer.createTransport;
    const transport = createTransport({
      host: smtp.smtp_host,
      port: smtp.smtp_port,
      // R158.100-fix (2026-10-14) — 弃 Boolean(smtp.smtp_secure).
      // Boolean('false') === true, 'true'/'false' 字符串都走隐式 SSL.
      // 当时假设 smtp_secure 改 'true' 能修, 但 R158.100.A.1
      // (2026-10-14) operator 反向测试 + diag 验证:
      //   - port 465 + secure=false (STARTTLS)  → "Greeting never received" 永久卡死
      //     (qq.com 隐式 TLS 端口不发明文 220)
      //   - port 465 + secure=true  (隐式 TLS)  → 26 行历史 sent 铁证
      //     (id=8~33 全 sent_at 有值, last_error=—)
      // 改显式 'true' 字符串匹配, 跟 26 行历史行为 1:1.
      // DB 端 smtp_secure 必须配 'true' 才能走通.
      secure: String(smtp.smtp_secure) === 'true',
      auth: smtp.smtp_user ? { user: smtp.smtp_user, pass: smtp.smtp_password } : undefined
    });
    await transport.sendMail({ from, to, cc, subject, text, html });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// ---------------------------------------------------------------------------
// createEmailDeliveryLoop — Task 11 factory
// ---------------------------------------------------------------------------
//
// createEmailDeliveryLoop({ db, getIntervalSeconds, getSystemConfig, sendImpl })
//   → { start, stop, tick, isRunning }
//
// sendImpl is an optional dependency override used by tests (real callers get
// the default `send` exported above). Both loops share the same start/stop/tick/
// isRunning shape so server.js can manage them with the same shutdown idiom.
//
// Per tick:
//   1. Read up to 25 pending rows (system_alert_outbox + report_email_outbox
//      each scanned, total cap=25 — listPendingFromTable helper).
//   2. For each row: read SMTP config from system_config, call send().
//   3. On success: markSent on the row's _outboxTable (system_alert_outbox or
//      report_email_outbox) — sets sent_at + clears last_error.
//   4. On failure: scheduleRetry — markFailed on the row's _outboxTable
//      with exponential backoff (nextAttemptDelay capped at 1h). Once
//      attempt_count reaches alert_email_max_attempts, the row stays in the
//      outbox table marked exhausted (last_error set, no further retry).
//      R158.68 — cooldown_skipped alert_events row removed (alert_events
//      table dropped; system_alerts.cooldown 节流在 detector 层处理).
//
// Per Global Constraint #9: 10-second floor on the cadence (clamped both at
// start() and at the top of tick() so a misconfigured caller can't push the
// rate below the floor for a single evaluation).

const PENDING_LIMIT = 25;
const DEFAULT_INITIAL_BACKOFF_SECONDS = 30;
const DEFAULT_MAX_ATTEMPTS = 5;

// inFlight guard pattern (matches createProbeLoop at probe.js:111):
//   - setInterval callback captures the in-flight tick via `inFlight = tick().catch(...)`.
//   - stop() awaits the in-flight promise to drain so a slow tick doesn't get cut off.
//   - tick() itself has NO `if (inFlight) return;` re-entry guard; the setInterval callback
//     does not add one either. Two overlapping guards would silently swallow a slow tick
//     without surfacing it in logs. The natural setInterval cadence (>= 10s) plus the
//     drain-on-stop pattern are the contract. If a future requirement demands "skip the
//     next tick if the previous is still running", the guard belongs in tick() body —
//     not at the setInterval callback boundary.
export function createEmailDeliveryLoop({ db, getIntervalSeconds, getSystemConfig, sendImpl, logger, _deps = {} }) {
  const sendFn = sendImpl || send;
  // R161.11 (2026-10-26) — 错误必须落 pino。
  //   此前本文件全部用 console.error 报错, 而 NSSM 服务的 AppStderr='' 把
  //   stderr **整个丢弃** ⇒ 邮件投递链路 (读 outbox / 标记 sent / 退避重试)
  //   的任何失败在服务端**零痕迹**。现场表现就是"邮件没发出去, 日志里什么都没有"。
  //   logger 由 server.js 传入 (pino); 没有 logger 时退回 console.error。
  const logError = (payload, message) => {
    if (logger && typeof logger.error === 'function') {
      logger.error(payload, message);
      return;
    }
    console.error(`[email-outbox] ${message}`, payload);
  };
  let interval = null;
  let inFlight = null;
  // S11 (2026-09-30) — tick-level reentry guard, separate from `running`.
  // `running` reflects the start()/stop() lifecycle; `tickInFlight` is
  // set at the top of tick() and cleared in a finally block, so two
  // overlapping ticks (e.g. setInterval fires before the previous tick
  // finished because db.query hung) don't both attach inFlight promises.
  // Without this guard, every tick stays alive in setInterval's closure
  // when listPending blocks, and the captured row context + Promise tree
  // accumulate at ~10 KB/min until V8 heap hits 4 GB → FATAL OOM.
  let tickInFlight = false;
  let running = false;

  async function listPending() {
    // R158.AdminEmail (2026-10-15) — 扩 4 张 outbox 表: system_alert_outbox +
    //   report_email_outbox + ad_notify_outbox + license_email_outbox (License 通知).
    //   跟 R158.100.C 3 表 precedent 1:1 平行, cap 改 1/4 each.
    //   UNION ALL + table tag 让 deliver() 知道走哪个表 markSent/markFailed.
    //   4 张表 listPending SQL shape 不同 (mssql TOP 是函数, mysql LIMIT 是 ?),
    //   统一通过 listPendingFromTable 内部 try/catch 单边失败隔离 (R158.60.7).
    //   任何 1 张表失败不破其他 3 张, R158.AdminEmail 跟 R158.100.C 1:1 平行.
    //
    //   cap 分配: Math.floor(25/4) = 6, 4×6=24, +1 leftover 给 ad_notify 优先
    //   (跟 R158.100.C leftover 给 ad_notify 同 precedent).
    const quarter = Math.floor(PENDING_LIMIT / 4);
    const leftover = PENDING_LIMIT - quarter * 3;  // 余 1 给 ad_notify 优先
    const alertRows = await listPendingFromTable(db.sql.systemAlertOutbox.listPending, quarter, 'system_alert');
    const reportRows = await listPendingFromTable(db.sql.reportEmailOutbox.listPending, quarter, 'report');
    const adNotifyRows = await listPendingFromTable(db.sql.adNotifyOutbox.listPending, leftover, 'ad_notify');
    const licenseRows = await listPendingFromTable(db.sql.licenseEmailOutbox.listPending, quarter, 'license');
    return [...alertRows, ...reportRows, ...adNotifyRows, ...licenseRows];
  }

  // R158.68 — 抽 listPendingFromTable 辅助, 每张表独立 try/catch
  async function listPendingFromTable(pendingSQL, cap, tag) {
    const isFunction = typeof pendingSQL === 'function';
    const sql = isFunction ? pendingSQL(cap) : pendingSQL;
    const params = isFunction ? [] : [cap];
    let timeoutHandle;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(`${tag} listPending acquire timeout`)), 5_000);
    });
    try {
      const queryPromise = db.query(sql, params);
      const { rows } = await Promise.race([queryPromise, timeoutPromise]);
      clearTimeout(timeoutHandle);
      // 给每行加 tableTag, deliver() 据此走对应 markSent/markFailed
      return rows.map((r) => ({ ...r, _outboxTable: tag }));
    } catch (e) {
      clearTimeout(timeoutHandle);
      // R161.11 — 落 pino (表缺失/连接断都要留痕)。用 classifyDbError 带上
      //   kind, 让"队列表不存在"和"临时网络抖动"在日志里一眼可分。
      const info = classifyDbError(e);
      logError(
        { err: e.message, kind: info.kind, code: info.code, errno: info.errno, number: info.number, table: tag },
        `${tag} listPending failed`
      );
      return [];
    }
  }

  async function getSmtpCfg() {
    // Default to empty object so tests that don't supply SMTP config still
    // get a (failing) send attempt — the failure path is what's tested here.
    const cfg = await getSystemConfig();
    return cfg || {};
  }

  async function markSent(row) {
    // R158.100.C (2026-10-14) + R158.AdminEmail (2026-10-15) — 根据 _outboxTable 选 SQL helper.
    //   4 表: system_alert_outbox / report_email_outbox / ad_notify_outbox / license_email_outbox.
    //   ad_notify 0 关联 daily_reports (R158.69), 不动 reportRun.markStatus.
    //   license 0 关联 daily_reports, 不动 reportRun.markStatus (跟 ad_notify 1:1).
    const sqlHelper = row._outboxTable === 'report'
      ? db.sql.reportEmailOutbox
      : row._outboxTable === 'ad_notify'
      ? db.sql.adNotifyOutbox
      : row._outboxTable === 'license'
      ? db.sql.licenseEmailOutbox
      : db.sql.systemAlertOutbox;
    // markSent SQL has [last_error_placeholder, id] so we pass [null, rowId].
    await db.execute(sqlHelper.markSent, [null, row.id]);
    // R158.69 (2026-10-10) — operator "日报历史为啥都是 pending" 真因:
    // R158.61 ship 漏 — daily_reports.status 仅 enqueue 时被设 'pending',
    // 投递完成没回写. 这里补: report_email_outbox (kind='report') 关联的
    // daily_reports.status 回写 'success'. report_id 列在 outbox row 里.
    // 错误隔离 (R60.7): markSent 已 throw, 这里 catch 不让 listener 抛;
    // 但 daily_reports 状态不一致只是 UI 误导, 不应阻塞下一次投递.
    if (row._outboxTable === 'report' && row.report_id != null) {
      try {
        await db.execute(db.sql.reportRun.markStatus[db.dialect], ['success', null, row.report_id]);
      } catch (e) {
        logError({ err: e.message, runId: row.report_id }, 'markStatus success failed');
      }
    }
  }

  async function markFailed(row, errorMessage, backoffSeconds) {
    // R158.100.C + R158.AdminEmail — 4 表 sqlHelper 选 (跟 markSent 1:1 平行).
    const sqlHelper = row._outboxTable === 'report'
      ? db.sql.reportEmailOutbox
      : row._outboxTable === 'ad_notify'
      ? db.sql.adNotifyOutbox
      : row._outboxTable === 'license'
      ? db.sql.licenseEmailOutbox
      : db.sql.systemAlertOutbox;
    // markFailed SQL has [last_error, id] — attempt_count is bumped inline.
    // If a non-zero backoff was provided, scheduleRetry sets next_attempt_at
    // separately so the loop can vary the backoff per attempt.
    await db.execute(sqlHelper.markFailed, [errorMessage ?? 'unknown', row.id]);
    if (backoffSeconds && backoffSeconds > 0) {
      await db.execute(sqlHelper.scheduleRetry, [backoffSeconds, row.id]);
    } else {
      // R158.100-fix (2026-10-14) — exhausted path 双层防御. backoffSeconds=0
      // (max attempts reached) 时 listPending 过滤 + 把 next_attempt_at 推到
      // 9999, 即使未来有人去掉 listPending 过滤, 也不会再选到这行.
      // Bug B 修复: 历史 15 行 (id 7,10~15,22,28,29,34~37) 之前就是因
      // exhausted path 不动 next_attempt_at, 反复被 listPending 选到,
      // attempt_count 涨到 2700+.
      try {
        await db.execute(sqlHelper.markExhausted, [row.id]);
      } catch (e) {
        // best-effort: 不让 markExhausted 失败中断 markFailed 主流程.
        logError({ err: e.message, outboxId: row.id }, 'markExhausted failed');
      }
    }
    // R158.69 (2026-10-10) — markFailed 同样回写 daily_reports.status.
    // 注意: 这里只在"最后一投" (backoffSeconds === 0) 时才用 'failed' 终态;
    // 否则 markFailed 后面 scheduleRetry 会再次投递, 此时 status 应回到
    // 'pending' (跟 email loop 下一拍继续). 但 services/email.js:234-236
    // 的 maxAttempts exhausted 路径会传 backoffSeconds=0, 此时是终态 'failed'.
    // 中间失败 (有 backoff): status 保持 'pending' (UI 显示重试中), 不动
    // daily_reports. 这与 R158.68 system_alerts 的 state 设计对称.
    if (row._outboxTable === 'report' && row.report_id != null && (!backoffSeconds || backoffSeconds <= 0)) {
      try {
        await db.execute(db.sql.reportRun.markStatus[db.dialect], ['failed', errorMessage ?? 'unknown', row.report_id]);
      } catch (e) {
        logError({ err: e.message, runId: row.report_id }, 'markStatus failed');
      }
    }
  }

  async function scheduleRetry(row, errorMessage) {
    const cfg = await getSystemConfig();
    const maxAttempts = Number(cfg?.alert_email_max_attempts) || DEFAULT_MAX_ATTEMPTS;
    const initialSeconds = Number(cfg?.alert_email_initial_backoff_seconds) || DEFAULT_INITIAL_BACKOFF_SECONDS;
    const nextAttempt = Number(row.attempt_count || 0) + 1;

    if (nextAttempt >= maxAttempts) {
      // Cooldown exhausted: bump attempt_count to the cap so the row is
      // marked "exhausted", capture the error. R158.68 — 不再写 alert_events
      // (alert_events 表已删), 内置告警 (alert_id 存在) 把 last_error 反向
      // 写到 system_alerts 表; 报表 (alert_id=undefined) 不动.
      // R158.100.C (2026-10-14) — 防御严化: 只 _outboxTable='system_alert' 才
      // 写 system_alerts 表, 防止 ad_notify row 误触发 (它有 ad_command_id
      // 不是 alert_id, 但 0 写 system_alerts 表). 1:1 跟 listPending 形态.
      await markFailed(row, errorMessage ?? 'unknown', 0);
      if (row._outboxTable === 'system_alert' && row.alert_id) {
        try {
          await db.execute(
            `UPDATE system_alerts SET last_error = ? WHERE id = ?`,
            [errorMessage ?? 'unknown', row.alert_id]
          );
        } catch { /* best-effort */ }
      }
      return;
    }

    const backoffSeconds = nextAttemptDelay(nextAttempt, initialSeconds);
    await markFailed(row, errorMessage ?? 'unknown', backoffSeconds);
  }

  async function deliver(row) {
    // Pre-flight: if the NEXT attempt (current + 1) would reach
    // alert_email_max_attempts, treat the row as exhausted. Burn no more
    // retries on it. R158.68 — 不再 emitCooldownSkipped (alert_events 表已删).
    let cfg = {};
    try { cfg = await getSystemConfig(); } catch { /* keep empty */ }
    const maxAttempts = Number(cfg?.alert_email_max_attempts) || DEFAULT_MAX_ATTEMPTS;
    if (Number(row.attempt_count || 0) + 1 >= maxAttempts) {
      await markFailed(row, row.last_error || 'max attempts reached', 0);
      return;
    }

    let smtp;
    try {
      smtp = await getSmtpCfg();
    } catch (err) {
      await scheduleRetry(row, `config read failed: ${err.message}`);
      return;
    }
    if (!smtp.smtp_host) {
      // No SMTP configured — treat as a config error so the row gets
      // attempt_count + last_error captured for the operator (rather than
      // burning retries on a permanently-broken delivery).
      await scheduleRetry(row, 'smtp_host not configured');
      return;
    }
    let result;
    try {
      result = await sendFn({
        smtp,
        from: smtp.smtp_from,
        to: row.to_addrs,
        cc: row.cc_addrs,
        subject: row.subject,
        text: row.body_text,
        html: row.body_html
      }, _deps);
    } catch (err) {
      // send() already catches its own errors, but defensive try/catch
      // here means a thrown dependency (e.g. nodemailer import failure)
      // still flows through the retry path.
      await scheduleRetry(row, err.message);
      return;
    }
    if (result?.ok) {
      await markSent(row);
    } else {
      await scheduleRetry(row, result?.error || 'send failed');
    }
  }

  async function tick() {
    // S11 (2026-09-30) — reentry guard. Skip this tick if the previous
    // one is still in flight (db hung, SMTP slow, etc). Without this,
    // each interval fires a new tick that captures the row context in
    // a new Promise; combined with S10's 5s listPending timeout the
    // accumulated closures would still cap growth, but skipping the
    // overlap entirely is the cleanest fix. The setInterval cadence
    // is already >= 10 s so the next tick is acceptable.
    if (tickInFlight) {
      logError({}, 'tick skipped: previous tick still in flight');
      return;
    }
    // R158.16 (2026-10-01) — email_enabled 总开关. 关闭时完全不读 outbox,
    // 不发 SMTP. 双层防御 (另 system-alert-engine 的 detector 已经节流/不重复
    // enqueue 同样 kind+scope 的告警); 这里防御未来有测试 / 手动 INSERT outbox
    // 绕过上游开关. DB 读一次
    // /tick (廉价, system_config 行数 < 30); 失败抛错时 *不* 阻塞 tick
    // (跟 listPending 失败的 err 处理风格一致 — best-effort).
    let emailEnabled = false;
    try {
      const cfg = await getSystemConfig();
      emailEnabled = String(cfg?.email_enabled ?? '0') === '1';
    } catch (err) {
      logError({ err: err.message }, 'email_enabled read failed');
    }
    if (!emailEnabled) {
      // 关开关: 直接返. 不调用 listPending → DB 没负担; 不调 deliver
      // → 没 SMTP 流量. tickInFlight 不置 true (no async work below).
      return;
    }
    tickInFlight = true;
    try {
      let rows;
      try {
        rows = await listPending();
      } catch (err) {
        logError({ err: err.message }, 'listPending failed');
        return;
      }
      for (const row of rows) {
        try {
          await deliver(row);
        } catch (err) {
          // Per-row failure must not abort the rest of the batch — one bad
          // outbox row's data corruption can't starve the others.
          logError({ err: err.message, outboxId: row.id, table: row._outboxTable }, 'deliver failed');
        }
      }
    } finally {
      tickInFlight = false;
    }
  }

  function start() {
    if (running) return;
    // Mark running SYNCHRONOUSLY so isRunning() is correct immediately
    // after start() returns (matches the AlertEvaluationLoop fix in T11).
    running = true;
    Promise.resolve(getIntervalSeconds()).then((raw) => {
      if (!running) return; // stop() fired before getIntervalSeconds resolved
      const intervalSec = Math.max(10, Number(raw) || 60);
      interval = setInterval(() => {
        inFlight = tick().catch((e) => logError({ err: e.message }, 'tick failed'));
      }, intervalSec * 1000);
    }).catch((e) => logError({ err: e.message }, 'start failed'));
  }

  async function stop() {
    running = false;
    if (interval) clearInterval(interval);
    interval = null;
    if (inFlight) await inFlight.catch(() => {});
    inFlight = null;
  }

  return {
    start,
    stop,
    tick,
    isRunning: () => running
  };
}