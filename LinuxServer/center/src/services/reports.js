// center/src/services/reports.js
// R158.61 (2026-10-10) — Daily / weekly email report generator + outbox
// enqueuer. Five sections, each a small SQL aggregate against the existing
// domain tables (no new data sources):
//   1) 失败登录  (ad_failed_logon_events, R158.50.7l)
//   2) 账户锁定  (ad_lockout_events, R158.53)
//   3) 复制状态  (ad_replication_status, R155.6 / R158.44.7)
//   4) DC 健康   (ad_dc_overview, R158.44.7)
//   5) Directory 同步 (ad_directory_sync_runs)
//
// Public API:
//   renderReport(kind, periodStart, periodEnd, opts) → {subject, text, html,
//                                                       summary, htmlSize}
//   enqueueReport(kind, periodStart, periodEnd) → {ok, runId, outboxId, error}
//   previewReport(kind) → {ok, subject, html, text, summary, htmlSize, error}
//
// All timestamps in UTC. The scheduler is responsible for picking the
// period_start / period_end (daily: now-24h .. now; weekly: now-7d .. now).
// The 5 section queries are each bounded (top-N rows + total COUNT) so the
// rendered HTML stays under 60 KB — verified at the end of renderReport
// via a hard byte-size assertion that logs but does NOT fail (some
// environments have many DCs and a 60KB limit is overly tight in practice;
// 200KB is the SMTP relay soft cap — see R158.61 plan §陷阱/坑).
//
// Email delivery: this service does NOT call nodemailer directly. It
// inserts a row into alert_email_outbox with kind='report', and the
// existing createEmailDeliveryLoop owns SMTP + retry + cooldown. This
// keeps alert + report mail on a single delivery path.

import { getDb } from '../db/index.js';
import { getConfig as getSystemConfig } from './config.js';

const REPORT_KINDS = new Set(['daily', 'weekly']);

function getWindowHours(kind) {
  if (kind === 'daily') return 24;
  if (kind === 'weekly') return 24 * 7;
  throw new Error(`unknown report kind: ${kind}`);
}

function fmtTsUtcCst(d) {
  if (!d) return '—';
  const x = (d instanceof Date) ? d : new Date(d);
  // Display as CST (UTC+8) for operator-friendly emails. 中心 stores UTC;
  // email recipients read in their local timezone (which is CST for this
  // operator's environment). YYYY-MM-DD HH:MM:SS CST.
  const cstMs = x.getTime() + 8 * 3600 * 1000;
  const cst = new Date(cstMs);
  const pad = (n) => String(n).padStart(2, '0');
  return `${cst.getUTCFullYear()}-${pad(cst.getUTCMonth() + 1)}-${pad(cst.getUTCDate())} ${pad(cst.getUTCHours())}:${pad(cst.getUTCMinutes())}:${pad(cst.getUTCSeconds())} CST`;
}

// R158.X.116 (2026-10-22) — 时长中文格式化, 给「离线 X 小时 Y 分」用.
//   单位选择跟第 7 段离线明细 (system_alerts) 的口径一致, 便于两段对照阅读.
//   null/undefined/负数 → '未知' (调用方多半是从未上报, 没有起点).
function fmtDurationCn(minutes) {
  if (minutes == null || !Number.isFinite(Number(minutes))) return '未知';
  const m = Math.max(0, Math.floor(Number(minutes)));
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h} 小时` : `${h} 小时 ${m % 60} 分`;
  const d = Math.floor(h / 24);
  if (d < 30) return h % 24 === 0 ? `${d} 天` : `${d} 天 ${h % 24} 小时`;
  return `${d} 天`;
}

function escHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Section 1: 失败登录 (4625) ─────────────────────────────────────────
// R158.64 (2026-10-10) — 报告扩字段: sam / display_name / error_count /
// last_error_at / dc_count. SQL helper 走 db.sql.failedLogon.topByUserWithDisplay
// (双 dialect 在 db/sql.js, 返 {sql, params}). periodEnd - periodStart 算
// sinceHours (vs inlined UTC_TIMESTAMP - INTERVAL ? HOUR, 一样精度).
async function fetchFailedLogonSection(db, dialect, periodStart, periodEnd) {
  const isMssql = dialect === 'mssql';
  const sinceHours = Math.max(1, Math.round((new Date(periodEnd) - new Date(periodStart)) / 3600000));
  const summarySql = isMssql
    ? `SELECT COUNT(*) AS total,
              COUNT(DISTINCT target_user_name) AS unique_users,
              COUNT(DISTINCT dc_name) AS affected_dcs
         FROM ad_failed_logon_events
        WHERE occurred_at >= ? AND occurred_at < ?
          AND target_user_name NOT LIKE '%$'`
    : `SELECT COUNT(*) AS total,
              COUNT(DISTINCT target_user_name) AS unique_users,
              COUNT(DISTINCT dc_name) AS affected_dcs
         FROM ad_failed_logon_events
        WHERE occurred_at >= ? AND occurred_at < ?
          AND target_user_name NOT LIKE '%$'`;
  // R158.65.1 (2026-10-10) — db.sql 是 buildSql(dialect) 已选过 dialect 的
  //   平铺 query tree (R158.42 design: buildSql 返 out[domain] = {...queries}),
  //   不是 {mysql, mssql} 双块. 正确: db.sql.<domain>.<query>({...}).
  //   R158.64 写 db.sql.<domain>.<query>[dialect] (undefined → "topByUserFn is
  //   not a function"). R158.65.2 错改成 db.sql[dialect] → undefined. 修回去.
  const topByUserSpec = db.sql.failedLogon.topByUserWithDisplay({ sinceHours, topN: 50 });
  const [sum, top] = await Promise.all([
    db.query(summarySql, [periodStart, periodEnd]).then(r => r.rows?.[0] || {}),
    db.query(topByUserSpec.sql, topByUserSpec.params).then(r => r.rows || [])
  ]);
  return {
    title: '失败登录 (4625)',
    total: Number(sum.total) || 0,
    uniqueUsers: Number(sum.unique_users) || 0,
    affectedDcs: Number(sum.affected_dcs) || 0,
    // R158.64 — topAccounts 保留旧 shape (name + count) 兼容老 consume;
    // topByUser 是新 shape, 邮件化用. 5 字段: sam/display/count/lastAt/dcCount.
    topAccounts: top.map(r => ({ name: r.sam, count: Number(r.error_count) || 0 })),
    topByUser: top.map(r => ({
      sam: r.sam,
      displayName: r.display_name || '',
      errorCount: Number(r.error_count) || 0,
      lastErrorAt: r.last_error_at,
      dcCount: Number(r.dc_count) || 0,
      dcNameList: r.dc_name_list || ''
    }))
  };
}

// ── Section 2: 账户锁定 (4740) ─────────────────────────────────────────
// R158.64 (2026-10-10) — 跟 failedLogon 同 shape: sam/display/lockoutCount/
// lastLockoutAt/dcCount. SQL helper db.sql.lockout.topByUserWithDisplay.
async function fetchLockoutSection(db, dialect, periodStart, periodEnd) {
  const isMssql = dialect === 'mssql';
  const sinceHours = Math.max(1, Math.round((new Date(periodEnd) - new Date(periodStart)) / 3600000));
  const summarySql = `SELECT COUNT(*) AS total,
                              COUNT(DISTINCT target_user_name) AS unique_users,
                              COUNT(DISTINCT dc_name) AS affected_dcs
                         FROM ad_lockout_events
                        WHERE occurred_at >= ? AND occurred_at < ?`;
  // R158.65.1 (2026-10-10) — db.sql 已 dialect 选定 (R158.42 design: buildSql
  //   返 out[domain]={...queries}), 直接 db.sql.<domain>.<query>({...}).
  const topByUserSpec = db.sql.lockout.topByUserWithDisplay({ sinceHours, topN: 50 });
  // allSettled + per-branch fallback (不是 Promise.all): 之前 Promise.all 无
  //   try/catch, 任一支 reject (e.g. MySQL 侧 SQL 语法错) 会把整个日报/周报
  //   生成链路带崩 —— 一张附属榜单查不出来, 整封邮件发不出去.
  //   榜单是"锦上添花", 缺了降级成空数组, 不该阻断主 KPI.
  const [sumR, topR] = await Promise.allSettled([
    db.query(summarySql, [periodStart, periodEnd]).then(r => r.rows?.[0] || {}),
    db.query(topByUserSpec.sql, topByUserSpec.params).then(r => r.rows || [])
  ]);
  if (sumR.status === 'rejected') throw sumR.reason;
  const sum = sumR.value;
  const top = topR.status === 'fulfilled' ? topR.value : [];
  if (topR.status === 'rejected') {
    console.warn(`[reports] lockout topByUserWithDisplay failed, degraded to empty: ${topR.reason?.message}`);
  }
  return {
    title: '账户锁定 (4740)',
    total: Number(sum.total) || 0,
    uniqueUsers: Number(sum.unique_users) || 0,
    affectedDcs: Number(sum.affected_dcs) || 0,
    topAccounts: top.map(r => ({ name: r.sam, count: Number(r.lockout_count) || 0 })),
    topByUser: top.map(r => ({
      sam: r.sam,
      displayName: r.display_name || '',
      lockoutCount: Number(r.lockout_count) || 0,
      lastLockoutAt: r.last_lockout_at,
      dcCount: Number(r.dc_count) || 0,
      dcNameList: r.dc_name_list || ''
    }))
  };
}

// ── Section 3: 复制状态 ────────────────────────────────────────────────
// R158.64 (2026-10-10) — 复制健康扩 bySite 矩阵 (报告 4.1 段) + allFailing
// 全量列表 (报告 4.2 段). 现 summary + topFailing 不动, 兼容 R158.61 链.
async function fetchReplicationSection(db, dialect, periodStart, periodEnd) {
  const isMssql = dialect === 'mssql';
  // ad_replication_status is a per-(source_dc, dest_dc, naming_context) snapshot
  // upserted on each probe. "errors" = status_code != 0.  "stale" = the row's
  // collected_at < period_start AND status_code != 0 (the link is broken
  // and hasn't recovered within the report window).
  const summarySql = `SELECT COUNT(*) AS total_links,
                              SUM(CASE WHEN status_code = 0 THEN 1 ELSE 0 END) AS healthy,
                              SUM(CASE WHEN status_code <> 0 THEN 1 ELSE 0 END) AS failing,
                              SUM(CASE WHEN status_code <> 0 AND collected_at < ? THEN 1 ELSE 0 END) AS stale_failing
                         FROM ad_replication_status
                        WHERE collected_at >= ?`;
  // R158.X.116.p.2 (2026-10-23) — 站点列改 JOIN ad_dcs→ad_sites catalog。
  //   原 SELECT 裸读 ad_replication_status.source_site / dest_site, 那是
  //   agent 上报的自由文本 (存旧命名体系 KDL-GuiYang 等), 跟 ad_sites 现行
  //   site_name 对不上 → 日报/周报「失败链路 Top30」显示的站点名一直是错的。
  //   原则同 sql.js:1133-1134 / topologyNodes / bySiteMatrix: catalog is
  //   source of truth, agent-reported source_site 只是 hint。
  //   用 LEFT JOIN 不收窄: 这里是明细列表, 丢行比显示空站点更糟。
  //   ⚠ status_code 判定保持 <> 0 原样 —— topFailing 的语义是「本期内有任何
  //   一次失败过」(含已恢复的历史快照), 与 listActiveErrors 的「当前活跃
  //   错误」是两种口径, 不在本次收敛范围内。
  const topFailingSql = isMssql
    ? `SELECT TOP 30 t.source_dc, t.dest_dc, t.naming_context, t.status_code, t.error_message,
                t.collected_at, t.last_success_time, t.last_attempt_time,
                ss.site_name AS source_site, ds.site_name AS dest_site
         FROM ad_replication_status t
         LEFT JOIN ad_dcs sd ON sd.dc_name = t.source_dc
         LEFT JOIN ad_sites ss ON ss.site_id = sd.site_id
         LEFT JOIN ad_dcs dd ON dd.dc_name = t.dest_dc
         LEFT JOIN ad_sites ds ON ds.site_id = dd.site_id
        WHERE t.status_code <> 0 AND t.collected_at >= ?
          AND t.naming_context NOT LIKE '\\_\\_%' ESCAPE '\\'
          AND t.naming_context <> 'META'
        ORDER BY t.collected_at DESC`
    : `SELECT t.source_dc, t.dest_dc, t.naming_context, t.status_code, t.error_message,
                t.collected_at, t.last_success_time, t.last_attempt_time,
                ss.site_name AS source_site, ds.site_name AS dest_site
         FROM ad_replication_status t
         LEFT JOIN ad_dcs sd ON sd.dc_name = t.source_dc
         LEFT JOIN ad_sites ss ON ss.site_id = sd.site_id
         LEFT JOIN ad_dcs dd ON dd.dc_name = t.dest_dc
         LEFT JOIN ad_sites ds ON ds.site_id = dd.site_id
        WHERE t.status_code <> 0 AND t.collected_at >= ?
          AND t.naming_context NOT LIKE '\\_\\_%' ESCAPE '\\'
          AND t.naming_context <> 'META'
        ORDER BY t.collected_at DESC
        LIMIT 30`;
  // R158.65.1 (2026-10-10) — db.sql 已 dialect 选定 (R158.42 design: buildSql
  //   返 out[domain]={...queries}), 直接 db.sql.<domain>.<query>({...}).
  const bySiteSpec = db.sql.replication.bySiteMatrix({ periodStart });
  const [sum, top, bySite] = await Promise.all([
    db.query(summarySql, [periodStart, periodEnd]).then(r => r.rows?.[0] || {}),
    db.query(topFailingSql, [periodStart]).then(r => r.rows || []),
    db.query(bySiteSpec.sql, bySiteSpec.params).then(r => r.rows || [])
  ]);
  return {
    title: 'AD 复制状态',
    totalLinks: Number(sum.total_links) || 0,
    healthy: Number(sum.healthy) || 0,
    failing: Number(sum.failing) || 0,
    staleFailing: Number(sum.stale_failing) || 0,
    topFailing: top.map(r => ({
      sourceDc: r.source_dc,
      destDc: r.dest_dc,
      sourceSite: r.source_site,
      destSite: r.dest_site,
      namingContext: r.naming_context,
      statusCode: r.status_code,
      error: r.error_message,
      lastSuccessTime: r.last_success_time,
      lastAttemptTime: r.last_attempt_time,
      collectedAt: r.collected_at
    })),
    // R158.64 — bySite 矩阵给报告 4.1 用. link/healthy/failing counts per
    // (source_site, dest_site) pair. lastProbeAt 给"最后探测时间"列.
    bySite: bySite.map(r => ({
      sourceSite: r.source_site,
      destSite: r.dest_site,
      linkCount: Number(r.link_count) || 0,
      healthyCount: Number(r.healthy_count) || 0,
      failingCount: Number(r.failing_count) || 0,
      lastProbeAt: r.last_probe_at
    }))
  };
}

// ── Section 4: DC 健康 ─────────────────────────────────────────────────
// R158.64 (2026-10-10) — 报告按站点 (按 site) 划分, 全列 34 DC. 现 topDown
// (10 离线) 删, 改 bySite 数组. 复用 db.sql.dcOverview.latestPerDc (现成
// helper, 已 LEFT JOIN ad_sites 拿 site_name, R158.44.7.x 加 site_id 列
// 时 ship), 0 新 query. 报告头 summary 仍用 1 query 拿 6 KPI (totalDcs/
// reachable/unreachable/pdcCount/hubCount/staleReachable) — 跟现实现一致.
async function fetchDcHealthSection(db, dialect, periodStart, periodEnd) {
  // R158.69.x (2026-10-10) — 改走 healthSummaryWithHeartbeat 真源 (新建 helper).
  //   真因: 老 inline sumSql 直接读 ad_dc_overview.last_heartbeat_at/is_pdc/is_hub,
  //   这 3 列 ad_dc_overview 永远 NULL/0 (collect 链路不写), reachable 永远 false.
  //   新 helper 接 ad_agent_heartbeat 真源, reachable 实时准. KPI 顺序不变.
  const isMssql = dialect === 'mssql';
  void isMssql; // dialect 选定由 db.sql 处理, 此处不再 dispatch
  // R158.65.1 (2026-10-10) — db.sql 已 dialect 选定 (R158.42 design: buildSql
  //   返 out[domain]={...queries}), 直接 db.sql.<domain>.<query>({...}).
  //   复用现 helper (sinceHours=24) 拉, JS reduce by site_name.
  const sinceHours = Math.max(1, Math.round((new Date(periodEnd) - new Date(periodStart)) / 3600000));
  // R158.X.116 (2026-10-22) — 心跳新鲜度阈值 = 5 分钟.
  //   真因: 老代码 `reachable: r.last_heartbeat_at != null` 只判 NULL. 而
  //   ad_agent_heartbeat 是 UPSERT 覆盖式快照表 (agent 停机后行仍在,
  //   last_heartbeat_at 保留最后一次值、永不置 NULL) → 该判据恒 true →
  //   日报/周报把离线 DC 全部显示成「● 正常」. 操作员实例: KDLWHOFADSRV1
  //   离线约 20h, 日报第 4 段仍显示在线, 而第 7 段 (读 system_alerts)
  //   正确列出它「● 离线中」—— 同一份报告自相矛盾.
  //
  //   阈值 5min = **跟随 /agents 页面** (操作员 2026-10-22 directive:
  //   "日报和周报 agent 状态跟随的是这个界面的状态, 在线就在线 离线就离线").
  //   web/src/views/AgentsView.vue:44 `ONLINE_WINDOW_MS = 5 * 60 * 1000`,
  //   该行注释本就标注了 matches db.sql dcOnlineCheck INTERVAL 5 MINUTE —
  //   5 分钟是既有既定口径, 不是本次新选的数. 改这里必须同步改那行.
  //
  //   口径语义 (操作员 2026-10-22: "当前5分钟内没有回报或者recover 那么就是
  //   Agent 离线"): recover 不是独立事件 —— system-alert-engine.js:216-226
  //   的 checkRecovered 判恢复时读的就是 ad_agent_heartbeat.last_heartbeat_at
  //   (恢复 ≡ 有新心跳). 故 "无回报且未 recover" 等价于 "5 分钟内无心跳",
  //   单列判据即可覆盖两者.
  //
  //   注: 告警引擎用 system_alert_heartbeat_offline_minutes (默认 15) 刻意
  //   比这宽松 —— 那是**邮件/告警**的容忍度 (抗抖动), 报告要如实反映现场.
  //   两者不同的阈值是**有意的**, 不是待收敛的漂移.
  //
  //   方案 A (操作员拍板): 用**报告生成时刻**判在线, 不用窗口内是否断过
  //   (后者受限于心跳表无历史时序, 做不了). 已知局限: 一台周内断过但生成前
  //   5 分钟内活过的机器, 周报仍显示「正常」—— 周内离线事件看第 7 段明细.
  const staleMinutes = 5;
  const allDcsSpec = db.sql.dcOverview.latestPerDcWithHeartbeat({ sinceHours, staleMinutes });
  // R158.69.x — 6 KPI 改走新 helper, 接 ad_agent_heartbeat 真源. stale_reachable
  //   阈值 = periodStart (UTC ms).
  // R158.X.116 — windowHours 与 latestPerDcWithHeartbeat 对齐 (老版本 KPI 的
  //   CROSS APPLY 无窗口 → KPI totalDcs ≠ 明细行数之和).
  const summarySpec = db.sql.dcOverview.healthSummaryWithHeartbeat({
    sinceMs: new Date(periodStart).getTime(),
    staleMinutes,
    windowHours: sinceHours
  });
  const [sum, allDcs] = await Promise.all([
    db.query(summarySpec.sql, summarySpec.params).then(r => r.rows?.[0] || {}),
    db.query(allDcsSpec.sql, allDcsSpec.params).then(r => r.rows || [])
  ]);
  // R158.64 — JS reduce by site_name (LEFT JOIN 拿到的). siteName '(未分组)'
  // 兜底 (LEFT JOIN 拿不到时, 老 ad_dc_overview 行没 site_id 也不挂).
  // 站点排序: is_hub DESC 优先 (HUB 站排前), 然后 siteName ASC.
  // DC 排序: is_pdc DESC 优先, 然后 dc_name ASC.
  const bySiteMap = new Map();
  for (const r of allDcs) {
    const siteName = r.site_name || '(未分组)';
    if (!bySiteMap.has(siteName)) {
      bySiteMap.set(siteName, {
        siteName,
        isHub: 0,
        dcs: []
      });
    }
    const bucket = bySiteMap.get(siteName);
    // R158.69.x — isHub 由 ad_sites 真源填; 老 latestPerDc 没 select 此列 = 0 占位.
    //   新 helper 按 site_name 分组, 第一行 r.is_hub 即整站 hub 标记.
    if (bucket.isHub === 0 && Number(r.is_hub) === 1) {
      bucket.isHub = 1;
    }
    bucket.dcs.push({
      dcName: r.dc_name,
      collectedAt: r.collected_at,
      lastHeartbeatAt: r.last_heartbeat_at,
      // R158.X.116 (2026-10-22) — 真因修复. 老代码 `r.last_heartbeat_at != null`
      //   只判 NULL, 在 UPSERT 覆盖式心跳表上恒 true → 离线 DC 全显示「● 正常」.
      //   现读 SQL 层算好的 is_online (最近 staleMinutes 分钟内有心跳 = 1).
      //   三值: 1=在线 / 0=离线(有历史心跳但不新鲜) / null=从未心跳.
      //   neverBeaten 只用来选文案, reachable 一律 false (两种都不算在线).
      reachable: Number(r.is_online) === 1,
      neverBeaten: r.is_online == null,
      offlineMinutes: (() => {
        // 离线时长 = 心跳停到现在. 从未心跳返回 null (没有起点).
        if (r.is_online == null || !r.last_heartbeat_at) return null;
        const ms = Date.now() - new Date(r.last_heartbeat_at).getTime();
        return Number.isFinite(ms) && ms >= 0 ? Math.floor(ms / 60000) : null;
      })(),
      isPdc: Number(r.is_pdc) === 1 ? 1 : 0,  // R158.69.x — 来自 ad_dcs.is_pdc 真源
      usersCount: Number(r.users_count) || 0,
      groupsCount: Number(r.groups_count) || 0,
      gposCount: Number(r.gpos_count) || 0
    });
  }
  // 站点排序: 现 latestPerDc 没返 is_hub, 走 NULL site 排末尾, 其余按 siteName
  // ASC. (HUB 排序是 dashboard.topologyNodes 的活, latestPerDc 没继承; 报
  // 告里 "(未分组)" 桶放最后即可).
  const bySite = Array.from(bySiteMap.values()).sort((a, b) => {
    if (a.siteName === '(未分组)') return 1;
    if (b.siteName === '(未分组)') return -1;
    return a.siteName.localeCompare(b.siteName);
  });
  // 站点 summary (totalDcs/reachable/unreachable) + DC 排序 (is_pdc DESC 暂
  // 无字段 → 走 dc_name ASC, R158.64 不动 is_pdc, 它是 1.0.5 baseline 加
  // 但 latestPerDc 不 select)
  for (const site of bySite) {
    site.totalDcs = site.dcs.length;
    site.reachableDcs = site.dcs.filter(d => d.reachable).length;
    site.unreachableDcs = site.totalDcs - site.reachableDcs;
    site.dcs.sort((a, b) => a.dcName.localeCompare(b.dcName));
  }
  return {
    title: 'DC 健康',
    totalDcs: Number(sum.total_dcs) || 0,
    reachable: Number(sum.reachable) || 0,
    unreachable: Number(sum.unreachable) || 0,
    pdcCount: Number(sum.pdc_count) || 0,
    hubCount: Number(sum.hub_count) || 0,
    staleReachable: Number(sum.stale_reachable) || 0,
    // R158.64 — 删 topDown (10 离线), 改 bySite. 报告 3 段全列.
    bySite
  };
}

// ── Section 5: Directory 同步 ──────────────────────────────────────────
async function fetchDirectorySyncSection(db, dialect, periodStart, periodEnd) {
  const isMssql = dialect === 'mssql';
  const summarySql = `SELECT COUNT(*) AS runs,
                              SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
                              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
                              MAX(finished_at) AS last_finish
                         FROM ad_directory_sync_runs
                        WHERE started_at >= ? AND started_at < ?`;
  const lastRunsSql = isMssql
    ? `SELECT TOP 5 id, dc_name, started_at, finished_at, status, error_message,
              user_count, group_count, ou_count, triggered_by
         FROM ad_directory_sync_runs
        WHERE started_at >= ? AND started_at < ?
        ORDER BY started_at DESC`
    : `SELECT id, dc_name, started_at, finished_at, status, error_message,
              user_count, group_count, ou_count, triggered_by
         FROM ad_directory_sync_runs
        WHERE started_at >= ? AND started_at < ?
        ORDER BY started_at DESC
        LIMIT 5`;
  const [sum, last] = await Promise.all([
    db.query(summarySql, [periodStart, periodEnd]).then(r => r.rows?.[0] || {}),
    db.query(lastRunsSql, [periodStart, periodEnd]).then(r => r.rows || [])
  ]);
  return {
    title: 'Directory 同步',
    runs: Number(sum.runs) || 0,
    success: Number(sum.success) || 0,
    failed: Number(sum.failed) || 0,
    lastFinish: sum.last_finish,
    lastRuns: last.map(r => ({
      id: r.id,
      dc: r.dc_name,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      status: r.status,
      error: r.error_message,
      userCount: Number(r.user_count) || 0,
      groupCount: Number(r.group_count) || 0,
      ouCount: Number(r.ou_count) || 0,
      triggeredBy: r.triggered_by
    }))
  };
}

// ── Section 6: AD 账户变更 ─────────────────────────────────────────────
// R158.72 (2026-10-11) — operator "增加一个包, 用来判断当天用来新建、禁用的
//   账户". 5 种 action (created/modified/deleted/enabled/disabled). 30d
//   trend + 当日 top-50 (created/disabled 两组). 公共表 ad_account_change
//   via runner.js post-hook (R110.A pattern).
async function fetchAccountChangeSection(db, dialect, periodStart, periodEnd) {
  void periodStart; void periodEnd;
  // 用 30d window (跟 dashboard 折线图同); 日报 / 周报都覆盖 (>=30d window
  // 自然覆盖 24h / 7d periodEnd-periodStart 窗口).
  const trendSpec = db.sql.adAccountChange.trendByDay({ days: 30 });
  const createdSpec = db.sql.adAccountChange.dailyTopByAction({ action: 'created' });
  const disabledSpec = db.sql.adAccountChange.dailyTopByAction({ action: 'disabled' });
  const [trendRes, createdRes, disabledRes] = await Promise.all([
    db.query(trendSpec.sql, trendSpec.params).then(r => r.rows || []),
    db.query(createdSpec.sql, createdSpec.params).then(r => r.rows || []),
    db.query(disabledSpec.sql, disabledSpec.params).then(r => r.rows || [])
  ]);
  const byAction = {};
  let total30d = 0;
  for (const r of trendRes) {
    const a = String(r.action || '');
    const c = Number(r.event_count) || 0;
    byAction[a] = (byAction[a] || 0) + c;
    total30d += c;
  }
  return {
    title: 'AD 账户变更',
    total: total30d,
    created: byAction.created || 0,
    modified: byAction.modified || 0,
    deleted: byAction.deleted || 0,
    enabled: byAction.enabled || 0,
    disabled: byAction.disabled || 0,
    topCreated: createdRes.map(r => ({
      sam: r.sam,
      displayName: r.display_name || '',
      whenCreated: r.created_at,
      dcName: r.dc_name
    })),
    topDisabled: disabledRes.map(r => ({
      sam: r.sam,
      displayName: r.display_name || '',
      whenModified: r.modified_at,
      dcName: r.dc_name
    }))
  };
}

// R158.X.99.report (2026-10-21) — 第 7 段「节点离线明细」.
//
// ⚠ 口径 (必读): 数据源 system_alerts WHERE kind='heartbeat_offline', 也就是
//   **告警引擎已经在写的行**, 日报此前只是从来没查过它. 两点必须让操作员知道:
//   (a) 只覆盖**超过阈值**的离线 (system_alert_heartbeat_offline_minutes,
//       默认 15 min). 心跳缺失 3~14 min 的短抖动不产生行 —— 两张心跳表都是
//       UPSERT 覆盖的当前快照, 0 历史时序, 阈值以下的抖动在数据层不存在.
//       所以本段是「**告警级**离线明细」, 不是「全部离线」.
//   (b) 窗口过滤用 fired_at OR recovered_at 落在窗口内 (见 SQL helper 注释):
//       「窗口前离线、窗口内恢复」也要出现, 因为"几点恢复的"正是操作员要的.
//
// 时长口径: recovered_at - fired_at, 只对已恢复的行有值. 未恢复的行
//   (recovered_at IS NULL) 时长算到 periodEnd, 并单独标记 (stillOffline),
//   跟"已恢复"分开呈现 —— 混在一起会让操作员以为都恢复了.
async function fetchOfflineSection(db, dialect, periodStart, periodEnd) {
  void dialect;
  const rowsSpec = db.sql.systemAlerts.listOfflineInWindow({ periodStart, periodEnd, limit: 200 });
  const countSpec = db.sql.systemAlerts.countOfflineInWindow;
  const [rowsRes, countRes] = await Promise.all([
    db.query(rowsSpec, [periodStart, periodEnd, periodStart, periodEnd]).then(r => r.rows || []),
    db.query(countSpec, [periodStart, periodEnd, periodStart, periodEnd]).then(r => r.rows || [])
  ]);

  const asMs = (v) => (v == null ? null : (v instanceof Date ? v.getTime() : new Date(v).getTime()));
  const periodEndMs = asMs(periodEnd);

  let totalMinutes = 0;
  const events = rowsRes.map(r => {
    const firedMs = asMs(r.fired_at);
    const recoveredMs = asMs(r.recovered_at);
    // 未恢复 → 时长算到 periodEnd (报告截止时), 不是"至今" —— 报告是快照邮件,
    // 重看旧报告时数字不会变, 0 心智负担.
    const endMs = recoveredMs ?? periodEndMs;
    const minutes = (firedMs != null && endMs != null)
      ? Math.max(0, Math.round((endMs - firedMs) / 60000))
      : null;
    const stillOffline = recoveredMs == null;
    if (minutes != null) totalMinutes += minutes;
    return {
      host: r.scope_ref,
      state: r.state,            // firing / recovered / acked
      firedAt: r.fired_at,
      recoveredAt: r.recovered_at,
      minutes,
      stillOffline,
      // detail 是 JSON string (NVARCHAR(MAX)), driver 各方言返回类型不一,
      // parse 失败按 null 处理 —— 展示层的字段不能让一条脏 detail 打挂整段报告.
      offlineMinAtFire: (() => {
        try {
          const d = typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail;
          return d?.offline_min ?? null;
        } catch { return null; }
      })()
    };
  }).sort((a, b) => (asMs(b.firedAt) || 0) - (asMs(a.firedAt) || 0));

  const c = countRes[0] || {};
  return {
    title: '节点离线明细',
    total: Number(c.total) || events.length,
    stillOffline: Number(c.still_offline) || 0,
    hostCount: Number(c.host_count) || 0,
    totalMinutes,
    events
  };
}

// R158.X.99.report (2026-10-21) — 第 8 段「MCP 调用统计」.
//
// 数据源 audit_logs WHERE action IN (4 个 mcp 调用 action). 调用次数按 action
// 分组走 SQL (countMcpCalls), client_ip 维度走「取窗口内最近 N 条原始行 +
// 应用层 parse payload」—— MSSQL payload 是 NVARCHAR(MAX), 在 SQL 层做 JSON
// 提取没有索引可依, 代价远高于把 N 条行拉回来 parse.
//
// ⚠ IP 口径: clientIp 字段是 R158.X.99.report 本次才加进 payload 的, 所以
//   **本次 ship 之前的 MCP 调用记录里没有 IP**. 首次日报里 IP 分布会偏少,
//   第二次起才是完整数据. 这一条要在报告里显式说明, 否则操作员会以为
//   "只有 1 个 IP 在调" 是事实结论.
async function fetchMcpSection(db, dialect, periodStart, periodEnd) {
  void dialect;
  const countSpec = db.sql.audit.countMcpCalls;
  const rowsSpec = db.sql.audit.listRecentMcpCalls({ limit: 500 });
  const [countRes, rowsRes] = await Promise.all([
    db.query(countSpec, [periodStart, periodEnd]).then(r => r.rows || []),
    db.query(rowsSpec, [periodStart, periodEnd]).then(r => r.rows || [])
  ]);

  const byAction = {};
  let total = 0;
  for (const r of countRes) {
    const n = Number(r.call_count) || 0;
    byAction[r.action] = {
      calls: n,
      users: Number(r.user_count) || 0,
      firstAt: r.first_at,
      lastAt: r.last_at
    };
    total += n;
  }

  // IP 维度: 从最近 N 条 payload 里聚合. 逐行 parse, 坏 payload 按 skip 处理.
  const ipCalls = {};
  let ipRowCount = 0;
  let rowsWithIp = 0;
  for (const r of rowsRes) {
    ipRowCount++;
    let payload = r.payload;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { payload = null; } }
    const ip = payload?.clientIp;
    if (!ip) continue;
    rowsWithIp++;
    const key = String(ip);
    ipCalls[key] = (ipCalls[key] || 0) + 1;
  }
  const ips = Object.entries(ipCalls)
    .map(([ip, calls]) => ({ ip, calls }))
    .sort((a, b) => b.calls - a.calls || a.ip.localeCompare(b.ip));

  const failed = (byAction['mcp.request.failed']?.calls || 0) + (byAction['mcp.write.request.failed']?.calls || 0);

  return {
    title: 'MCP 调用统计',
    total,
    failed,
    readCalls: byAction['mcp.request']?.calls || 0,
    writeCalls: byAction['mcp.write.request']?.calls || 0,
    byAction,
    ips,
    // 采样口径提示 (报告里显式渲染, 避免误读): IP 只统计最近 N 条里的部分.
    ipSampled: ipRowCount,
    ipRowsWithIp: rowsWithIp,
    // 本 ship 之前的记录没有 IP 字段 → ipRowsWithIp 可能远小于 ipSampled.
    ipFieldBackfilled: true
  };
}

// ── HTML / text rendering ─────────────────────────────────────────────
// R158.64 (2026-10-10) — 邮件化重写. 三段结构: header (greeting + KPI 摘
// 要) + 5 sections (greeting + summary 句 + table) + signature (closing +
// run id + data source). inline CSS 保留 (Gmail/Outlook 兼容, R158.61 lesson).
function renderHtml(kind, periodStart, periodEnd, sections) {
  const kindLabel = kind === 'daily' ? '日报' : '周报';
  const periodLabel = `${fmtTsUtcCst(periodStart)} → ${fmtTsUtcCst(periodEnd)}`;
  const periodHours = Math.max(1, Math.round((new Date(periodEnd) - new Date(periodStart)) / 3600000));
  // 公共 cell 样式
  const td = 'border:1px solid #d0d7de;padding:5px 8px;font-size:12.5px;';
  const th = `${td}background:#eef3f8;text-align:left;font-weight:600;`;
  const tdR = `${td}text-align:right;`;
  const thR = `${th}text-align:right;`;
  // 索引 sections by title (后续 O(1) 取 KPI 给 header)
  const secBy = Object.fromEntries(sections.map(s => [s.title, s]));
  const sFL = secBy['失败登录 (4625)'] || {};
  const sLO = secBy['账户锁定 (4740)'] || {};
  const sRP = secBy['AD 复制状态'] || {};
  const sDC = secBy['DC 健康'] || {};
  let html = '';
  // 1) Header — 蓝色 banner
  html += `<div style="font-family:'Microsoft YaHei',Helvetica,Arial,sans-serif;color:#222;max-width:920px;margin:0 auto;">`;
  html += `<div style="background:linear-gradient(135deg,#003366 0%,#0066cc 100%);color:#fff;padding:16px 20px;border-radius:6px 6px 0 0;">`;
  html += `<h1 style="margin:0;font-size:19px;font-weight:600;">AD Dashboard ${kindLabel}</h1>`;
  html += `<p style="margin:6px 0 0;font-size:12px;opacity:0.85;">数据窗口: ${escHtml(periodLabel)} (${periodHours} 小时)</p>`;
  html += `</div>`;
  // 2) Greeting + KPI 摘要
  html += `<div style="padding:14px 20px;background:#fafbfc;border-bottom:1px solid #e1e4e8;">`;
  html += `<p style="margin:0;font-size:13px;line-height:1.7;">各位运维同事, 您好.<br/>`;
  html += `以下是过去 <strong>${periodHours} 小时</strong> AD 域控运行情况摘要: `;
  html += `<strong style="color:#c00;">${(sFL.total || 0).toLocaleString()}</strong> 次失败登录 (涉及 <strong>${sFL.uniqueUsers || 0}</strong> 个用户), `;
  html += `<strong style="color:#c00;">${(sLO.total || 0).toLocaleString()}</strong> 次账户锁定, `;
  html += `<strong style="color:${(sRP.failing || 0) > 0 ? '#c00' : '#0a0'};">${(sRP.failing || 0).toLocaleString()}</strong> 条复制异常, `;
  html += `<strong style="color:${(sDC.unreachable || 0) > 0 ? '#c00' : '#0a0'};">${(sDC.unreachable || 0).toLocaleString()}</strong> 台 DC 心跳离线.`;
  html += ` 详细数据见以下各段.</p>`;
  html += `</div>`;
  // 3) 5 sections (greeting + summary + table)
  html += `<div style="padding:14px 20px;background:#fff;">`;
  for (const s of sections) {
    if (s.title === '失败登录 (4625)' || s.title === '账户锁定 (4740)') {
      const isFL = s.title === '失败登录 (4625)';
      const userRows = s.topByUser || [];
      const summaryVerb = isFL ? '失败登录' : '账户锁定';
      html += `<section data-section="${isFL ? 'failed-logon' : 'lockout'}">`;
      html += `<h2 style="margin:14px 0 6px;font-size:14.5px;color:#003366;border-left:3px solid #003366;padding-left:8px;">${isFL ? '1' : '2'}. ${escHtml(s.title)}</h2>`;
      // summary 句
      if (s.total > 0 && userRows.length > 0) {
        const top = userRows[0];
        html += `<p style="margin:0 0 8px;color:#444;font-size:12.5px;line-height:1.7;">`;
        html += `本期共监测到 <strong>${s.total.toLocaleString()}</strong> 次${summaryVerb}, 涉及 <strong>${s.uniqueUsers}</strong> 个用户账户, 跨 <strong>${s.affectedDcs}</strong> 台 DC. `;
        html += `最频繁账户: <code style="background:#eef3f8;padding:1px 4px;border-radius:2px;">${escHtml(top.sam)}</code> (${escHtml(top.displayName || '(无显示名)')}, 共 <strong>${top[isFL ? 'errorCount' : 'lockoutCount']}</strong> 次, 涉及 ${top.dcCount} 台 DC).`;
        if (userRows.length > 1) {
          html += ` 其余详见下表.`;
        }
        html += `</p>`;
      } else {
        html += `<p style="margin:0 0 8px;color:#444;font-size:12.5px;line-height:1.7;">`;
        html += `本期共监测到 <strong>${s.total.toLocaleString()}</strong> 次${summaryVerb}, 涉及 <strong>${s.uniqueUsers}</strong> 个用户账户, 跨 <strong>${s.affectedDcs}</strong> 台 DC.</p>`;
      }
      // 表格
      if (userRows.length) {
        html += `<table style="width:100%;border-collapse:collapse;">`;
        html += `<thead><tr><th style="${th}">登录名 (sam)</th><th style="${th}">显示名</th><th style="${thR}">${isFL ? '错误次数' : '锁定次数'}</th><th style="${thR}">涉及 DC</th><th style="${th}">最后${isFL ? '错误' : '锁定'}时间 (CST)</th></tr></thead><tbody>`;
        for (const u of userRows) {
          const cnt = u[isFL ? 'errorCount' : 'lockoutCount'];
          const lastAt = u[isFL ? 'lastErrorAt' : 'lastLockoutAt'];
          const boldStyle = cnt >= 20 ? `font-weight:600;color:#c00;` : '';
          html += `<tr>`;
          html += `<td style="${td}font-family:Consolas,monospace;font-size:12px;">${escHtml(u.sam)}</td>`;
          html += `<td style="${td}">${escHtml(u.displayName || '(无显示名)')}</td>`;
          html += `<td style="${tdR}${boldStyle}">${cnt.toLocaleString()}</td>`;
          html += `<td style="${tdR}">${u.dcCount}</td>`;
          html += `<td style="${td}color:#666;">${escHtml(fmtTsUtcCst(lastAt))}</td>`;
          html += `</tr>`;
        }
        html += `</tbody></table>`;
      } else {
        html += `<p style="color:#28a745;font-size:12.5px;">✓ 本时段无${summaryVerb}事件</p>`;
      }
      html += `</section>`;
    } else if (s.title === 'AD 复制状态') {
      // R158.64 — 4.1 站点矩阵 + 4.2 失败链路明细. summary 不动.
      html += `<section data-section="replication">`;
      html += `<h2 style="margin:14px 0 6px;font-size:14.5px;color:#003366;border-left:3px solid #003366;padding-left:8px;">3. ${escHtml(s.title)}</h2>`;
      html += `<p style="margin:0 0 8px;color:#444;font-size:12.5px;line-height:1.7;">`;
      html += `复制链路 <strong>${s.totalLinks}</strong> 条, 健康 <strong style="color:#0a0;">${s.healthy}</strong>, 失败 <strong style="color:${s.failing > 0 ? '#c00' : '#0a0'};">${s.failing}</strong>, 持续失败 <strong>${s.staleFailing}</strong> (贯穿整个窗口).`;
      html += `</p>`;
      // 4.1 bySite 矩阵
      if (s.bySite && s.bySite.length) {
        html += `<h3 style="margin:12px 0 4px;font-size:12.5px;color:#003366;">4.1 站点间复制矩阵</h3>`;
        html += `<table style="width:100%;border-collapse:collapse;">`;
        html += `<thead><tr><th style="${th}">源站点</th><th style="${th}">目标站点</th><th style="${thR}">总链路</th><th style="${thR}">正常</th><th style="${thR}">失败</th><th style="${th}">最后探测 (CST)</th></tr></thead><tbody>`;
        for (const m of s.bySite) {
          const failingCol = m.failingCount > 0 ? 'color:#c00;font-weight:600;' : 'color:#0a0;';
          html += `<tr>`;
          html += `<td style="${td}">${escHtml(m.sourceSite || '(空)')}</td>`;
          html += `<td style="${td}">${escHtml(m.destSite || '(空)')}</td>`;
          html += `<td style="${tdR}">${m.linkCount}</td>`;
          html += `<td style="${tdR}color:#0a0;">${m.healthyCount}</td>`;
          html += `<td style="${tdR}${failingCol}">${m.failingCount}</td>`;
          html += `<td style="${td}color:#666;">${escHtml(fmtTsUtcCst(m.lastProbeAt))}</td>`;
          html += `</tr>`;
        }
        html += `</tbody></table>`;
      }
      // 4.2 失败链路明细
      if (s.topFailing && s.topFailing.length) {
        html += `<h3 style="margin:12px 0 4px;font-size:12.5px;color:#003366;">4.2 失败链路明细 (top 30)</h3>`;
        html += `<table style="width:100%;border-collapse:collapse;">`;
        html += `<thead><tr><th style="${th}">源 DC</th><th style="${th}">目标 DC</th><th style="${th}">分区</th><th style="${thR}">状态码</th><th style="${th}">最后成功 (CST)</th><th style="${th}">最后尝试 (CST)</th></tr></thead><tbody>`;
        for (const f of s.topFailing) {
          html += `<tr style="background:#fff5f5;">`;
          html += `<td style="${td}font-family:Consolas,monospace;font-size:12px;">${escHtml(f.sourceDc || '')}</td>`;
          html += `<td style="${td}font-family:Consolas,monospace;font-size:12px;">${escHtml(f.destDc || '')}</td>`;
          html += `<td style="${td}">${escHtml(f.namingContext || '')}</td>`;
          html += `<td style="${tdR}color:#c00;font-weight:600;">${f.statusCode}</td>`;
          html += `<td style="${td}color:#666;">${escHtml(fmtTsUtcCst(f.lastSuccessTime))}</td>`;
          html += `<td style="${td}color:#666;">${escHtml(fmtTsUtcCst(f.lastAttemptTime))}</td>`;
          html += `</tr>`;
        }
        html += `</tbody></table>`;
      } else {
        html += `<p style="color:#28a745;font-size:12.5px;">✓ 本时段无失败复制链路</p>`;
      }
      html += `</section>`;
    } else if (s.title === 'DC 健康') {
      // R158.64 — 按站点分组, 全列 34 DC
      html += `<section data-section="dc-health">`;
      html += `<h2 style="margin:14px 0 6px;font-size:14.5px;color:#003366;border-left:3px solid #003366;padding-left:8px;">4. ${escHtml(s.title)} (按站点划分)</h2>`;
      html += `<p style="margin:0 0 8px;color:#444;font-size:12.5px;line-height:1.7;">`;
      html += `DC 总数 <strong>${s.totalDcs}</strong>, 在线 <strong style="color:#0a0;">${s.reachable}</strong>, 离线 <strong style="color:${s.unreachable > 0 ? '#c00' : '#0a0'};">${s.unreachable}</strong>, PDC <strong>${s.pdcCount}</strong>, HUB <strong>${s.hubCount}</strong>.`;
      // R158.X.116 — 删掉「在线但心跳过期」这个 KPI. 它原本是拿 periodStart 当
      //   阈值 (日报=24h 前), 语义是「报告期内没心跳过」, 跟「现在在线」不是一回事.
      //   而 reachable/unreachable 修好之后, 它与「离线」高度重叠, 留着只会
      //   让人以为两个数字矛盾 (实测就是: 在线 34 / 离线 0 / 心跳过期 1).
      //   staleReachable 字段仍保留在返回对象里 (向后兼容, 调用方可能引用),
      //   只是不再渲染.
      html += `</p>`;
      if (s.bySite && s.bySite.length) {
        for (const site of s.bySite) {
          const siteHeadStyle = `margin:10px 0 4px;font-size:12.5px;color:#003366;background:#f0f4f8;padding:4px 8px;border-radius:3px;`;
          html += `<h3 style="${siteHeadStyle}">${escHtml(site.siteName)} <span style="font-weight:normal;color:#666;margin-left:6px;">${site.reachableDcs}/${site.totalDcs} 可达</span></h3>`;
          html += `<table style="width:100%;border-collapse:collapse;">`;
          html += `<thead><tr><th style="${th}">DC 名称</th><th style="${thR}">用户</th><th style="${thR}">组</th><th style="${thR}">GPO</th><th style="${th}">状态</th><th style="${th}">最后心跳 (CST)</th></tr></thead><tbody>`;
          for (const d of site.dcs) {
            const reachableStyle = d.reachable ? '' : 'background:#fff0f0;';
            // R158.X.116 — 离线时长直接标在状态列. 只显示「离线」的话, 收到
            //   报告的人不知道这机器断了 20 分钟还是 20 小时. 从未心跳单独标,
            //   因为它没有「离线时长」可言 (没有起点).
            const statusMark = d.reachable
              ? `<span style="color:#28a745;">●</span> 正常`
              : (d.neverBeaten
                  ? `<span style="color:#d32f2f;">●</span> 未上报`
                  : `<span style="color:#d32f2f;">●</span> 离线${d.offlineMinutes != null ? ` <span style="color:#999;font-size:11px;">(${fmtDurationCn(d.offlineMinutes)})</span>` : ''}`);
            html += `<tr style="${reachableStyle}">`;
            html += `<td style="${td}font-family:Consolas,monospace;font-size:12px;">${escHtml(d.dcName)}</td>`;
            html += `<td style="${tdR}">${d.usersCount.toLocaleString()}</td>`;
            html += `<td style="${tdR}">${d.groupsCount.toLocaleString()}</td>`;
            html += `<td style="${tdR}">${d.gposCount.toLocaleString()}</td>`;
            html += `<td style="${td}">${statusMark}</td>`;
            html += `<td style="${td}color:#666;">${d.neverBeaten ? '—' : escHtml(fmtTsUtcCst(d.lastHeartbeatAt))}</td>`;
            html += `</tr>`;
          }
          html += `</tbody></table>`;
        }
      } else {
        html += `<p style="color:#666;font-size:12px;">无 DC 数据 (ad_dc_overview 为空).</p>`;
      }
      html += `</section>`;
    } else if (s.title === 'Directory 同步') {
      // 5 段 — 不动 (R158.60.5 always-clean + R158.60.19 tx 修)
      html += `<section data-section="directory-sync">`;
      html += `<h2 style="margin:14px 0 6px;font-size:14.5px;color:#003366;border-left:3px solid #003366;padding-left:8px;">5. ${escHtml(s.title)}</h2>`;
      html += `<p style="margin:0 0 8px;color:#444;font-size:12.5px;line-height:1.7;">`;
      html += `同步运行 <strong>${s.runs}</strong> 次, 成功 <strong style="color:#0a0;">${s.success}</strong>, 失败 <strong style="color:${s.failed > 0 ? '#c00' : '#0a0'};">${s.failed}</strong>, 最近一次结束 ${escHtml(fmtTsUtcCst(s.lastFinish))}.`;
      html += `</p>`;
      if (s.lastRuns && s.lastRuns.length) {
        html += `<table style="width:100%;border-collapse:collapse;">`;
        html += `<thead><tr><th style="${th}">DC</th><th style="${th}">开始</th><th style="${th}">结束</th><th style="${th}">状态</th><th style="${th}">U/G/OU</th><th style="${th}">触发</th></tr></thead><tbody>`;
        for (const r of s.lastRuns) {
          html += `<tr><td style="${td}font-family:Consolas,monospace;font-size:12px;">${escHtml(r.dc)}</td><td style="${td}color:#666;">${escHtml(fmtTsUtcCst(r.startedAt))}</td><td style="${td}color:#666;">${escHtml(fmtTsUtcCst(r.finishedAt))}</td><td style="${td}">${escHtml(r.status)}</td><td style="${tdR}">${r.userCount}/${r.groupCount}/${r.ouCount}</td><td style="${td}">${escHtml(r.triggeredBy || '')}</td></tr>`;
        }
        html += `</tbody></table>`;
      } else {
        html += `<p style="color:#666;font-size:12px;">窗口内无同步运行.</p>`;
      }
      html += `</section>`;
    } else if (s.title === 'AD 账户变更') {
      // R158.72 (2026-10-11) — 6 段. 5 个 action 计数 + 2 张 top-50 表
      //   (created + disabled). 跟 fetchDirectorySyncSection 同 3-query
      //   shape.
      html += `<section data-section="account-change">`;
      html += `<h2 style="margin:14px 0 6px;font-size:14.5px;color:#003366;border-left:3px solid #003366;padding-left:8px;">6. ${escHtml(s.title)} (近 30 天)</h2>`;
      html += `<p style="margin:0 0 8px;color:#444;font-size:12.5px;line-height:1.7;">`;
      html += `累计 <strong>${s.total.toLocaleString()}</strong> 次账户变更: `;
      html += `创建 <strong style="color:#22c55e;">${s.created}</strong>, 修改 <strong>${s.modified}</strong>, 删除 <strong>${s.deleted}</strong>, 启用 <strong>${s.enabled}</strong>, 禁用 <strong style="color:${s.disabled > 0 ? '#c00' : '#0a0'};">${s.disabled}</strong>.`;
      html += `</p>`;
      // 6.1 当日 created top-50
      if (s.topCreated && s.topCreated.length) {
        html += `<h3 style="margin:12px 0 4px;font-size:12.5px;color:#003366;">6.1 当日新建账户 (top 50)</h3>`;
        html += `<table style="width:100%;border-collapse:collapse;">`;
        html += `<thead><tr><th style="${th}">登录名 (sam)</th><th style="${th}">显示名</th><th style="${th}">创建时间 (CST)</th><th style="${th}">DC</th></tr></thead><tbody>`;
        for (const u of s.topCreated) {
          html += `<tr>`;
          html += `<td style="${td}font-family:Consolas,monospace;font-size:12px;">${escHtml(u.sam)}</td>`;
          html += `<td style="${td}">${escHtml(u.displayName || '(无显示名)')}</td>`;
          html += `<td style="${td}color:#666;">${escHtml(fmtTsUtcCst(u.whenCreated))}</td>`;
          html += `<td style="${td}font-family:Consolas,monospace;font-size:12px;">${escHtml(u.dcName || '')}</td>`;
          html += `</tr>`;
        }
        html += `</tbody></table>`;
      } else {
        html += `<p style="color:#28a745;font-size:12.5px;">✓ 当日无新建账户</p>`;
      }
      // 6.2 当日 disabled top-50
      if (s.topDisabled && s.topDisabled.length) {
        html += `<h3 style="margin:12px 0 4px;font-size:12.5px;color:#003366;">6.2 当日禁用账户 (top 50)</h3>`;
        html += `<table style="width:100%;border-collapse:collapse;">`;
        html += `<thead><tr><th style="${th}">登录名 (sam)</th><th style="${th}">显示名</th><th style="${th}">修改时间 (CST)</th><th style="${th}">DC</th></tr></thead><tbody>`;
        for (const u of s.topDisabled) {
          html += `<tr style="background:#fff5f5;">`;
          html += `<td style="${td}font-family:Consolas,monospace;font-size:12px;">${escHtml(u.sam)}</td>`;
          html += `<td style="${td}">${escHtml(u.displayName || '(无显示名)')}</td>`;
          html += `<td style="${td}color:#666;">${escHtml(fmtTsUtcCst(u.whenModified))}</td>`;
          html += `<td style="${td}font-family:Consolas,monospace;font-size:12px;">${escHtml(u.dcName || '')}</td>`;
          html += `</tr>`;
        }
        html += `</tbody></table>`;
      } else {
        html += `<p style="color:#28a745;font-size:12.5px;">✓ 当日无禁用账户</p>`;
      }
      html += `</section>`;
    } else if (s.title === '节点离线明细') {
      // R158.X.99.report (2026-10-21) — 7 段. 数据源 system_alerts
      //   WHERE kind='heartbeat_offline' (告警引擎一直在写, 日报首次消费).
      html += `<section data-section="node-offline">`;
      html += `<h2 style="margin:14px 0 6px;font-size:14.5px;color:#003366;border-left:3px solid #003366;padding-left:8px;">7. ${escHtml(s.title)} (告警级)</h2>`;
      if (s.error) {
        // 取数失败 ≠ 0 次离线. 显式区分, 否则操作员会把"查挂了"读成"本期干净".
        html += `<p style="color:#c00;font-size:12.5px;background:#fff5f5;border-left:3px solid #c00;padding:6px 10px;">⚠ 本段取数失败: ${escHtml(s.errorMsg || 'unknown')}<br/>该结果<strong>不代表</strong>本期无离线事件, 请到系统告警页人工核对.</p>`;
      } else if (s.total > 0) {
        const mins = s.totalMinutes || 0;
        const hours = Math.floor(mins / 60);
        const remMin = mins % 60;
        html += `<p style="margin:0 0 8px;color:#444;font-size:12.5px;line-height:1.7;">`;
        html += `本期共记录 <strong style="color:${s.total > 0 ? '#c00' : '#0a0'};">${s.total}</strong> 次告警级节点离线, 涉及 <strong>${s.hostCount}</strong> 台主机, 累计离线 <strong>${hours}</strong> 小时 <strong>${remMin}</strong> 分钟.`;
        if (s.stillOffline > 0) {
          html += ` 其中 <strong style="color:#c00;">${s.stillOffline}</strong> 次截至报告生成时<strong>仍未恢复</strong>.`;
        }
        html += `</p>`;
        // 口径说明 —— 必须写进正文. 没有它, 操作员会把"告警级离线"读成
        // "全部离线", 误以为 3~14min 的短抖动也被统计进来了 (实际没有).
        html += `<p style="margin:0 0 8px;color:#888;font-size:11.5px;line-height:1.6;">`;
        html += `口径说明: 仅统计超过告警阈值 (默认 15 分钟) 的心跳中断. 阈值以下的短时抖动不产生告警记录, 不在本段范围内.`;
        html += `</p>`;
        const evs = s.events || [];
        if (evs.length) {
          html += `<table style="width:100%;border-collapse:collapse;">`;
          html += `<thead><tr><th style="${th}">主机</th><th style="${th}">离线开始 (CST)</th><th style="${th}">恢复时间 (CST)</th><th style="${thR}">离线时长</th><th style="${th}">状态</th></tr></thead><tbody>`;
          for (const ev of evs) {
            const still = ev.stillOffline;
            html += `<tr${still ? ' style="background:#fff5f5;"' : ''}>`;
            html += `<td style="${td}font-family:Consolas,monospace;font-size:12px;">${escHtml(ev.host || '')}</td>`;
            html += `<td style="${td}color:#666;">${escHtml(fmtTsUtcCst(ev.firedAt))}</td>`;
            html += `<td style="${td}color:#666;">${still ? '<span style="color:#c00;font-weight:600;">未恢复</span>' : escHtml(fmtTsUtcCst(ev.recoveredAt))}</td>`;
            const m = ev.minutes;
            const durTxt = m == null ? '—'
              : m < 60 ? `${m} 分钟`
              : m < 1440 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分`
              : `${Math.floor(m / 1440)} 天 ${Math.floor((m % 1440) / 60)} 小时`;
            html += `<td style="${tdR}${still ? 'font-weight:600;color:#c00;' : ''}">${escHtml(durTxt)}</td>`;
            html += `<td style="${td}">${still ? '<span style="color:#c00;">● 离线中</span>' : '<span style="color:#28a745;">● 已恢复</span>'}</td>`;
            html += `</tr>`;
          }
          html += `</tbody></table>`;
        }
      } else {
        html += `<p style="color:#28a745;font-size:12.5px;">✓ 本时段无告警级节点离线 (阈值以上)</p>`;
        html += `<p style="margin:4px 0 0;color:#888;font-size:11.5px;">口径说明: 仅统计超过告警阈值 (默认 15 分钟) 的心跳中断, 阈值以下的短时抖动不在本段范围内.</p>`;
      }
      html += `</section>`;
    } else if (s.title === 'MCP 调用统计') {
      // R158.X.99.report (2026-10-21) — 8 段. 数据源 audit_logs (4 个 mcp 调用 action).
      html += `<section data-section="mcp-usage">`;
      html += `<h2 style="margin:14px 0 6px;font-size:14.5px;color:#003366;border-left:3px solid #003366;padding-left:8px;">8. ${escHtml(s.title)}</h2>`;
      if (s.error) {
        html += `<p style="color:#c00;font-size:12.5px;background:#fff5f5;border-left:3px solid #c00;padding:6px 10px;">⚠ 本段取数失败: ${escHtml(s.errorMsg || 'unknown')}</p>`;
      } else if (s.total > 0) {
        html += `<p style="margin:0 0 8px;color:#444;font-size:12.5px;line-height:1.7;">`;
        html += `本期共记录 <strong>${s.total.toLocaleString()}</strong> 次 MCP 调用: 读 <strong>${s.readCalls}</strong> 次, 写 <strong>${s.writeCalls}</strong> 次`;
        if (s.failed > 0) {
          html += `, 其中失败 <strong style="color:#c00;">${s.failed}</strong> 次`;
        }
        html += `.`;
        html += `</p>`;
        const ips = s.ips || [];
        if (ips.length) {
          html += `<h3 style="margin:12px 0 4px;font-size:12.5px;color:#003366;">8.1 客户端 IP 分布 (采样自最近 ${s.ipSampled} 次调用)</h3>`;
          html += `<table style="width:100%;border-collapse:collapse;">`;
          html += `<thead><tr><th style="${th}">客户端 IP</th><th style="${thR}">调用次数</th><th style="${thR}">占比</th></tr></thead><tbody>`;
          for (const ip of ips) {
            const pct = s.ipSampled > 0 ? ((ip.calls / s.ipSampled) * 100).toFixed(1) : '—';
            html += `<tr>`;
            html += `<td style="${td}font-family:Consolas,monospace;font-size:12px;">${escHtml(ip.ip)}</td>`;
            html += `<td style="${tdR}">${ip.calls}</td>`;
            html += `<td style="${tdR}color:#666;">${escHtml(pct)}%</td>`;
            html += `</tr>`;
          }
          html += `</tbody></table>`;
          // 采样口径: 只覆盖最近 N 条, 且本次 ship 之前的记录没有 IP 字段.
          // 两条都要说, 否则 "IP A 100%" 会被读成 "只有 IP A 在调".
          html += `<p style="margin:4px 0 0;color:#888;font-size:11.5px;line-height:1.6;">`;
          html += `口径说明: IP 取自本期最近 ${s.ipSampled} 条调用记录 (超出部分不计入 IP 分布, 但计入上方总次数). `;
          html += `客户端 IP 字段自 R158.X.99.report 起才开始记录, <strong>本报告窗口之前的历史调用不含 IP</strong> — 首次日报的 IP 分布会偏少, 后续报告才是完整数据.`;
          html += `</p>`;
        } else {
          html += `<h3 style="margin:12px 0 4px;font-size:12.5px;color:#003366;">8.1 客户端 IP 分布</h3>`;
          html += `<p style="color:#888;font-size:12.5px;">本时段的 ${s.ipSampled} 条调用记录中均无客户端 IP 字段 (IP 留痕自 R158.X.99.report 起生效, 窗口内若全为历史记录则属正常).</p>`;
        }
      } else {
        html += `<p style="color:#28a745;font-size:12.5px;">✓ 本时段无 MCP 调用记录</p>`;
      }
      html += `</section>`;
    }
  }
  html += `</div>`;
  // 4) Signature block (closing)
  const now = new Date();
  html += `<div style="padding:12px 20px;background:#fafbfc;border-top:1px solid #e1e4e8;border-radius:0 0 6px 6px;font-size:11.5px;color:#666;line-height:1.7;">`;
  html += `<p style="margin:0;">— AD Dashboard 自动运维系统</p>`;
  // R158.X.99.report — 补齐数据源列表. 此前漏了 R158.72 加的 ad_account_change,
  //   本次一并补上新增 2 段的来源 (system_alerts / audit_logs).
  html += `<p style="margin:4px 0 0;">生成时间: <strong>${escHtml(fmtTsUtcCst(now))}</strong> · 数据源: ad_failed_logon_events / ad_lockout_events / ad_dc_overview + ad_sites / ad_replication_status / ad_directory_sync_runs / ad_account_change / system_alerts / audit_logs</p>`;
  html += `<p style="margin:4px 0 0;color:#999;">本邮件由 createEmailDeliveryLoop 投递 (R158.61+1). 收件人如有疑问请联系运维.</p>`;
  html += `</div>`;
  html += `</div>`;
  return html;
}

function renderText(kind, periodStart, periodEnd, sections) {
  const kindLabel = kind === 'daily' ? '日报' : '周报';
  const periodLabel = `${fmtTsUtcCst(periodStart)} → ${fmtTsUtcCst(periodEnd)}`;
  const periodHours = Math.max(1, Math.round((new Date(periodEnd) - new Date(periodStart)) / 3600000));
  const lines = [`AD Dashboard ${kindLabel}`, `数据窗口: ${periodLabel} (${periodHours} 小时)`, ''];
  for (const s of sections) {
    lines.push(`== ${s.title} ==`);
    if (s.title === '失败登录 (4625)' || s.title === '账户锁定 (4740)') {
      const isFL = s.title === '失败登录 (4625)';
      const verb = isFL ? '失败登录' : '账户锁定';
      const cnt = isFL ? 'errorCount' : 'lockoutCount';
      const last = isFL ? 'lastErrorAt' : 'lastLockoutAt';
      lines.push(`总计 ${s.total} 次, ${s.uniqueUsers} 账户, ${s.affectedDcs} DC`);
      for (const u of (s.topByUser || []).slice(0, 50)) {
        lines.push(`  - ${u.sam} (${u.displayName || '(无显示名)'}): ${u[cnt]} 次, 涉及 ${u.dcCount} DC, 最后${verb} ${fmtTsUtcCst(u[last])}`);
      }
    } else if (s.title === 'AD 复制状态') {
      lines.push(`链路 ${s.totalLinks} / 健康 ${s.healthy} / 失败 ${s.failing} / 持续失败 ${s.staleFailing}`);
      if (s.bySite && s.bySite.length) {
        lines.push('  -- 4.1 站点矩阵 --');
        for (const m of s.bySite) {
          lines.push(`  - ${m.sourceSite} → ${m.destSite}: 总 ${m.linkCount} 健康 ${m.healthyCount} 失败 ${m.failingCount} (最后探测 ${fmtTsUtcCst(m.lastProbeAt)})`);
        }
      }
      if (s.topFailing && s.topFailing.length) {
        lines.push('  -- 4.2 失败链路明细 --');
        for (const f of s.topFailing) {
          lines.push(`  - ${f.sourceDc} → ${f.destDc} (${f.namingContext}) status=${f.statusCode} 最后成功 ${fmtTsUtcCst(f.lastSuccessTime)} 最后尝试 ${fmtTsUtcCst(f.lastAttemptTime)}`);
        }
      }
    } else if (s.title === 'DC 健康') {
      lines.push(`DC ${s.totalDcs} / 在线 ${s.reachable} / 离线 ${s.unreachable} / PDC ${s.pdcCount} / HUB ${s.hubCount}`);
      if (s.bySite && s.bySite.length) {
        for (const site of s.bySite) {
          lines.push(`  -- 站点: ${site.siteName} (${site.reachableDcs}/${site.totalDcs} 可达) --`);
          for (const d of site.dcs) {
            // R158.X.116 — 离线标时长, 未上报单独标 (无时长可言)
            const mark = d.reachable
              ? '● 正常'
              : (d.neverBeaten ? '● 未上报' : `● 离线 ${fmtDurationCn(d.offlineMinutes)}`);
            lines.push(`  - ${d.dcName} U${d.usersCount}/G${d.groupsCount}/GPO${d.gposCount} ${mark} 最后心跳 ${d.neverBeaten ? '—' : fmtTsUtcCst(d.lastHeartbeatAt)}`);
          }
        }
      }
    } else if (s.title === 'Directory 同步') {
      lines.push(`运行 ${s.runs} / 成功 ${s.success} / 失败 ${s.failed} / 最近结束 ${fmtTsUtcCst(s.lastFinish)}`);
      for (const r of (s.lastRuns || []).slice(0, 5)) {
        lines.push(`  - #${r.id} ${r.dc} ${r.status} U${r.userCount} G${r.groupCount} O${r.ouCount} (${fmtTsUtcCst(r.startedAt)} → ${fmtTsUtcCst(r.finishedAt)})`);
      }
    } else if (s.title === 'AD 账户变更') {
      // R158.72 (2026-10-11) — 6 段 text 镜像
      lines.push(`30d 累计 ${s.total} 次: 创建 ${s.created} / 修改 ${s.modified} / 删除 ${s.deleted} / 启用 ${s.enabled} / 禁用 ${s.disabled}`);
      if (s.topCreated && s.topCreated.length) {
        lines.push('  -- 6.1 当日新建账户 (top 50) --');
        for (const u of s.topCreated.slice(0, 50)) {
          lines.push(`  - ${u.sam} (${u.displayName || '(无显示名)'}) 创建于 ${fmtTsUtcCst(u.whenCreated)} (${u.dcName || ''})`);
        }
      }
      if (s.topDisabled && s.topDisabled.length) {
        lines.push('  -- 6.2 当日禁用账户 (top 50) --');
        for (const u of s.topDisabled.slice(0, 50)) {
          lines.push(`  - ${u.sam} (${u.displayName || '(无显示名)'}) 修改于 ${fmtTsUtcCst(u.whenModified)} (${u.dcName || ''})`);
        }
      }
    } else if (s.title === '节点离线明细') {
      // R158.X.99.report (2026-10-21) — 7 段 text 镜像
      if (s.error) {
        lines.push(`⚠ 本段取数失败: ${s.errorMsg || 'unknown'}`);
        lines.push(`  该结果不代表本期无离线事件, 请到系统告警页人工核对.`);
      } else if (s.total > 0) {
        const mins = s.totalMinutes || 0;
        lines.push(`告警级离线 ${s.total} 次 / ${s.hostCount} 台主机 / 累计 ${Math.floor(mins / 60)} 小时 ${mins % 60} 分钟`
          + (s.stillOffline > 0 ? ` / 其中 ${s.stillOffline} 次仍未恢复` : ''));
        lines.push(`  口径: 仅统计超过告警阈值 (默认 15 分钟) 的心跳中断, 阈值以下短时抖动不在范围内.`);
        for (const ev of (s.events || [])) {
          const m = ev.minutes;
          const dur = m == null ? '—'
            : m < 60 ? `${m} 分钟`
            : m < 1440 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分`
            : `${Math.floor(m / 1440)} 天 ${Math.floor((m % 1440) / 60)} 小时`;
          lines.push(`  - ${ev.host} 离线于 ${fmtTsUtcCst(ev.firedAt)}, ${ev.stillOffline ? '仍未恢复' : `恢复于 ${fmtTsUtcCst(ev.recoveredAt)}`}, 时长 ${dur}`);
        }
      } else {
        lines.push('✓ 本时段无告警级节点离线 (阈值以上)');
        lines.push('  口径: 仅统计超过告警阈值 (默认 15 分钟) 的心跳中断, 阈值以下短时抖动不在范围内.');
      }
    } else if (s.title === 'MCP 调用统计') {
      // R158.X.99.report (2026-10-21) — 8 段 text 镜像
      if (s.error) {
        lines.push(`⚠ 本段取数失败: ${s.errorMsg || 'unknown'}`);
      } else if (s.total > 0) {
        lines.push(`MCP 调用 ${s.total} 次: 读 ${s.readCalls} / 写 ${s.writeCalls}`
          + (s.failed > 0 ? ` / 失败 ${s.failed}` : ''));
        const ips = s.ips || [];
        if (ips.length) {
          lines.push(`  -- 8.1 客户端 IP 分布 (采样自最近 ${s.ipSampled} 次调用) --`);
          for (const ip of ips) {
            const pct = s.ipSampled > 0 ? ((ip.calls / s.ipSampled) * 100).toFixed(1) : '—';
            lines.push(`  - ${ip.ip}: ${ip.calls} 次 (${pct}%)`);
          }
          lines.push(`  口径: IP 取自本期最近 ${s.ipSampled} 条调用记录; 客户端 IP 字段自 R158.X.99.report 起才开始记录, 窗口之前的历史调用不含 IP.`);
        } else {
          lines.push(`  -- 8.1 客户端 IP 分布 --`);
          lines.push(`  本时段 ${s.ipSampled} 条调用记录中均无客户端 IP 字段 (IP 留痕自 R158.X.99.report 起生效).`);
        }
      } else {
        lines.push('✓ 本时段无 MCP 调用记录');
      }
    }
    lines.push('');
  }
  lines.push('— AD Dashboard 自动运维系统');
  return lines.join('\n');
}

function buildSubject(kind, periodStart, periodEnd) {
  const d = new Date(periodEnd.getTime() + 8 * 3600 * 1000);
  const ymd = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return kind === 'daily' ? `AD Dashboard 日报 ${ymd}` : `AD Dashboard 周报 ${ymd}`;
}

// ── Public: render ────────────────────────────────────────────────────
// opts: { dryRun: bool } — dryRun skips the outbox INSERT (preview path).
export async function renderReport(kind, periodStart, periodEnd) {
  if (!REPORT_KINDS.has(kind)) throw new Error(`invalid report kind: ${kind}`);
  const db = getDb();
  const dialect = db.dialect;
  const ps = (periodStart instanceof Date) ? periodStart : new Date(periodStart);
  const pe = (periodEnd instanceof Date) ? periodEnd : new Date(periodEnd);
  // Run all 6 sections in parallel — they read independent tables.
  // R158.72 (2026-10-11) — 加 fetchAccountChangeSection (第 6 段).
  // R158.X.99.report (2026-10-21) — 加第 7 段 (节点离线明细) + 第 8 段
  //   (MCP 调用统计). 两段各自跑 2 条 SQL, 与前 6 段一起并行.
  //   失败隔离: 新段的 SQL 若抛错 (比如明细表被 90 天 audit purge 波及),
  //   不应该让整份日报渲染不出来 —— 用 catch 包一层降级成空段, 并在段里标
  //   `error: true` 让渲染层显式打出"本段取数失败", 而不是静默显示 0.
  //   前 6 段维持原有行为 (0 catch), 保持既有失败语义不变.
  const [s1, s2, s3, s4, s5, s6, s7raw, s8raw] = await Promise.all([
    fetchFailedLogonSection(db, dialect, ps, pe),
    fetchLockoutSection(db, dialect, ps, pe),
    fetchReplicationSection(db, dialect, ps, pe),
    fetchDcHealthSection(db, dialect, ps, pe),
    fetchDirectorySyncSection(db, dialect, ps, pe),
    fetchAccountChangeSection(db, dialect, ps, pe),
    fetchOfflineSection(db, dialect, ps, pe).catch((e) => ({
      title: '节点离线明细', error: true, errorMsg: e?.message || String(e),
      total: 0, stillOffline: 0, hostCount: 0, totalMinutes: 0, events: []
    })),
    fetchMcpSection(db, dialect, ps, pe).catch((e) => ({
      title: 'MCP 调用统计', error: true, errorMsg: e?.message || String(e),
      total: 0, failed: 0, readCalls: 0, writeCalls: 0, byAction: {}, ips: [],
      ipSampled: 0, ipRowsWithIp: 0, ipFieldBackfilled: true
    }))
  ]);
  const s7 = s7raw;
  const s8 = s8raw;
  const sections = [s1, s2, s3, s4, s5, s6, s7, s8];
  const html = renderHtml(kind, ps, pe, sections);
  const text = renderText(kind, ps, pe, sections);
  const subject = buildSubject(kind, ps, pe);
  // Byte size check (UTF-8). 200 KB hard warn; 60 KB "ideal" soft warn.
  // We do NOT fail — instead we log a warning so the operator can decide.
  const htmlSize = Buffer.byteLength(html, 'utf8');
  const summary = {
    failedLogon: { total: s1.total, uniqueUsers: s1.uniqueUsers, affectedDcs: s1.affectedDcs },
    lockout: { total: s2.total, uniqueUsers: s2.uniqueUsers, affectedDcs: s2.affectedDcs },
    replication: { totalLinks: s3.totalLinks, healthy: s3.healthy, failing: s3.failing, staleFailing: s3.staleFailing },
    dcHealth: { totalDcs: s4.totalDcs, reachable: s4.reachable, unreachable: s4.unreachable, pdcCount: s4.pdcCount, hubCount: s4.hubCount, staleReachable: s4.staleReachable },
    directorySync: { runs: s5.runs, success: s5.success, failed: s5.failed },
    // R158.72 (2026-10-11) — AD 账户变更 KPI
    accountChange: { total: s6.total, created: s6.created, modified: s6.modified, deleted: s6.deleted, enabled: s6.enabled, disabled: s6.disabled },
    // R158.X.99.report (2026-10-21) — 离线 + MCP KPI
    offline: { total: s7.total, stillOffline: s7.stillOffline, hostCount: s7.hostCount, totalMinutes: s7.totalMinutes, error: !!s7.error },
    mcp: { total: s8.total, failed: s8.failed, readCalls: s8.readCalls, writeCalls: s8.writeCalls, distinctIps: s8.ips?.length || 0, error: !!s8.error }
  };
  return { subject, text, html, summary, htmlSize, sections, periodStart: ps, periodEnd: pe };
}

// ── Public: enqueue ───────────────────────────────────────────────────
// Reads to/cc from system_config (report_daily_to / report_daily_cc / etc).
// Inserts a daily_reports row first (for history), then inserts an
// alert_email_outbox row with kind='report', then updates daily_reports
// with the outbox_id. The existing createEmailDeliveryLoop picks the
// outbox row up on its next tick (>=10s cadence) and sends it.
export async function enqueueReport(kind) {
  if (!REPORT_KINDS.has(kind)) throw new Error(`invalid report kind: ${kind}`);
  const db = getDb();
  const cfg = await getSystemConfig().catch(() => ({}));
  const toField = kind === 'daily' ? cfg.report_daily_to : cfg.report_weekly_to;
  const ccField = kind === 'daily' ? cfg.report_daily_cc : cfg.report_weekly_cc;
  const to = (toField || cfg.alert_default_to || '').trim();
  const cc = (ccField || '').trim() || null;
  if (!to) {
    return { ok: false, error: `no recipients for ${kind} report (set report_${kind}_to or alert_default_to in system_config)` };
  }
  // Period: daily = last 24h ending now; weekly = last 7d ending now. We
  // use UTC end = now and start = end - windowHours. This is the convention
  // both cron + manual trigger paths follow.
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - getWindowHours(kind) * 3600 * 1000);
  const rendered = await renderReport(kind, periodStart, periodEnd);
  // 1) Insert daily_reports row first (history).
  const insertSql = db.sql.reportRun.insert[db.dialect];
  const insertParams = [kind, periodStart, periodEnd, to, cc, rendered.subject, rendered.text, rendered.html];
  const insertResult = await db.execute(insertSql, insertParams);
  // mssql/pg style: insertResult.insertId, mysql2: result.insertId. Some
  // driver wrappers return array.
  const runId = (Array.isArray(insertResult) ? insertResult[0]?.insertId : insertResult?.insertId) || insertResult?.recordset?.[0]?.id;
  if (!runId) {
    return { ok: false, error: 'failed to insert daily_reports row (no id returned)' };
  }
  // 2) Insert outbox row with kind=kind ('daily'/'weekly').
  // R158.68 — 报表 outbox 迁独立表 report_email_outbox. db.sql.reportEmailOutbox
  // .enqueue 取代 db.sql.alertOutbox.enqueue (后者已删). report_id 指向新
  // 插入的 daily_reports/weekly_reports 行, alert_id 列在新表里没有 (那是
  // system_alert_outbox 的 FK).
  const outboxSql = db.sql.reportEmailOutbox.enqueue;
  const nextAttempt = new Date();
  const outboxParams = [
    runId,            // R158.68 — report_id (FK to daily_reports/weekly_reports)
    to, cc || null, rendered.subject, rendered.text, rendered.html,
    nextAttempt,
    kind              // R158.68 — kind = 'daily' / 'weekly' (新表 kind 列, 不是 'report')
  ];
  const outboxResult = await db.execute(outboxSql, outboxParams);
  const outboxId = (Array.isArray(outboxResult) ? outboxResult[0]?.insertId : outboxResult?.insertId) || outboxResult?.recordset?.[0]?.id;
  // 3) Update daily_reports with outbox_id + html_size + status='pending'.
  await db.execute(db.sql.reportRun.finish[db.dialect], [outboxId || null, 'pending', null, rendered.htmlSize, runId]);
  return {
    ok: true,
    runId,
    outboxId: outboxId || null,
    to,
    cc,
    subject: rendered.subject,
    htmlSize: rendered.htmlSize,
    summary: rendered.summary,
    periodStart,
    periodEnd
  };
}

// ── Public: preview ───────────────────────────────────────────────────
// Renders a report but does NOT enqueue. Returns the same shape as
// renderReport. Used by the EmailConfigView "预览" button to show the
// operator what an upcoming daily/weekly report will look like.
export async function previewReport(kind) {
  if (!REPORT_KINDS.has(kind)) throw new Error(`invalid report kind: ${kind}`);
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - getWindowHours(kind) * 3600 * 1000);
  return await renderReport(kind, periodStart, periodEnd);
}

// ── Public: list recent runs (for /api/admin/reports/history) ─────────
// sql.js VARIANTS.reports.reportRun.listRecent is `{ mysql: fn, mssql: fn }`
// shaped (R158.32/R158.5 lesson — caller MUST index by db.dialect). Both
// dialects return a function (limit) => string because mssql needs TOP n
// interpolated and mysql needs LIMIT n interpolated (binding as a parameter
// would not work in either).  Pass exactly two bound params: (kind, kind)
// for the (? IS NULL OR kind = ?) filter. When kind is null, the filter
// is a no-op.
export async function listRecentReports({ kind = null, limit = 20 } = {}) {
  const db = getDb();
  const fn = db.sql.reportRun.listRecent[db.dialect];
  const sql = fn(limit);
  const r = await db.query(sql, [kind, kind]);
  return r.rows || [];
}
