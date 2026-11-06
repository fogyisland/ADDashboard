// R158.50 (2026-10-06) — ad_failed_logon_events post-hook helper.
//
// Why this exists:
//   ad_failed_logon_events is a PUBLIC table (operator's "公共表" intent,
//   like ad_dc_overview R110.A, ad_eventlog_events R112, ad_admin_members
//   R158.47), so the package manifest omits the `database` block to bypass
//   the v2 metricstore guards. The metricstore path therefore never runs
//   for this package; we have to write to the table ourselves from a
//   runner.js post-hook.
//
//   4625 events are high-frequency (per-second under attack scenarios),
//   so we iterate per-event MERGE with try/catch — one bad row does not
//   fail the whole /report envelope. Upsert key (dc_name, event_record_id)
//   collapses duplicate reports across the same DC (R93.4 / R101
//   canonical pattern, same as ad_lockout_events / ad_eventlog_events).
//
// Shape:
//   - dialect dispatch is BAKED INTO the SQL helper itself (sql.js
//     failedLogon.upsertEvent returns { sql, params } built from the
//     active dialect), not in this module — keeps the service
//     dialect-agnostic.
//   - per-record try/catch.
//   - returns { upserted, skipped, errors } summary for the route log.
//   - read helpers (recent, search, hourlyAggregate) all return plain
//     row arrays — router is responsible for camelCase reshaping.

import { toMysqlDatetime } from '../utils/datetime.js';

function pickField(o, camelKey, snakeKey, pascalKey = null) {
  if (o == null) return null;
  if (o[camelKey] !== undefined && o[camelKey] !== null) return o[camelKey];
  if (snakeKey && o[snakeKey] !== undefined && o[snakeKey] !== null) return o[snakeKey];
  if (pascalKey && o[pascalKey] !== undefined && o[pascalKey] !== null) return o[pascalKey];
  return null;
}

// PS1 wire shape (PascalCase per ConvertTo-Json). camelCase / snake_case
// variants are defensive fallbacks for older agent builds or direct
// hashtable-key serialization.
function normalizeEvent(raw, fallbackAgentId) {
  if (!raw || typeof raw !== 'object') return null;
  const eventRecordId = pickField(raw, 'eventRecordId', 'event_record_id', 'EventRecordId');
  if (eventRecordId == null) return null;

  const occurredAtRaw = pickField(raw, 'occurredAt', 'occurred_at', 'OccurredAt');
  const occurredAt = occurredAtRaw instanceof Date
    ? occurredAtRaw
    : (occurredAtRaw ? new Date(occurredAtRaw) : new Date());

  const dcName = pickField(raw, 'dcName', 'dc_name', 'DcName')
    || pickField(raw, 'agentId', 'agent_id', 'AgentId')
    || fallbackAgentId
    || null;

  const agentId = pickField(raw, 'agentId', 'agent_id', 'AgentId')
    || fallbackAgentId
    || null;

  const collectedAt = new Date();

  return {
    occurredAt,
    collectedAt,
    agentId:    agentId ? String(agentId) : null,
    dcName:     dcName  ? String(dcName)  : null,
    eventRecordId: Number(eventRecordId),
    targetUserName:          pickField(raw, 'targetUserName', 'target_user_name', 'TargetUserName'),
    targetUserDisplayName:   pickField(raw, 'targetUserDisplayName', 'target_user_display_name', 'TargetUserDisplayName'),
    targetDomainName:        pickField(raw, 'targetDomainName', 'target_domain_name', 'TargetDomainName'),
    targetSid:               pickField(raw, 'targetSid', 'target_sid', 'TargetSid'),
    subjectUserName:         pickField(raw, 'subjectUserName', 'subject_user_name', 'SubjectUserName'),
    subjectDomainName:       pickField(raw, 'subjectDomainName', 'subject_domain_name', 'SubjectDomainName'),
    callerComputerName:      pickField(raw, 'callerComputerName', 'caller_computer_name', 'CallerComputerName'),
    ipAddress:               pickField(raw, 'ipAddress', 'ip_address', 'IpAddress'),
    ipPort:                  pickField(raw, 'ipPort', 'ip_port', 'IpPort'),
    logonType:               pickField(raw, 'logonType', 'logon_type', 'LogonType'),
    logonProcessName:        pickField(raw, 'logonProcessName', 'logon_process_name', 'LogonProcessName'),
    authPackageName:         pickField(raw, 'authPackageName', 'auth_package_name', 'AuthenticationPackageName'),
    failureReason:           pickField(raw, 'failureReason', 'failure_reason', 'FailureReason'),
    status:                  pickField(raw, 'status', 'status', 'Status'),
    workstationName:         pickField(raw, 'workstationName', 'workstation_name', 'WorkstationName'),
    errorCode:               Number(pickField(raw, 'errorCode', 'error_code', 'ErrorCode') ?? 0)
  };
}

export function upsertEvent(db, raw, fallbackAgentId = null, log = null) {
  const n = normalizeEvent(raw, fallbackAgentId);
  if (!n) return Promise.resolve({ ok: false, reason: 'missing event_record_id' });
  return db.execute(db.sql.failedLogon.upsertEvent, [
    n.occurredAt, n.collectedAt, n.agentId, n.dcName, n.eventRecordId,
    n.targetUserName, n.targetUserDisplayName, n.targetDomainName,
    n.targetSid, n.subjectUserName, n.subjectDomainName,
    n.callerComputerName, n.ipAddress, n.ipPort, n.logonType,
    n.logonProcessName, n.authPackageName, n.failureReason,
    n.status, n.workstationName, n.errorCode
  ])
    .then(() => ({ ok: true }))
    .catch((e) => {
      log?.error?.({
        event: 'failed_logon.upsert_failed',
        dc: n.dcName,
        recordId: n.eventRecordId,
        targetUser: n.targetUserName,
        err: e?.message || String(e)
      }, 'failed-logon upsert failed');
      return { ok: false, reason: e?.message || String(e) };
    });
}

// R158.50 (2026-10-06) — bulk upsert with per-event try/catch.
// mirrors admin-members.js:103 pattern. Returns aggregate counters
// for the post-hook log line.
export async function upsertEvents(db, events, fallbackAgentId = null, log = null) {
  if (!Array.isArray(events)) {
    return { upserted: 0, skipped: 0, errors: [{ reason: 'events not array' }] };
  }
  let upserted = 0;
  let skipped = 0;
  const errors = [];
  for (const raw of events) {
    const r = await upsertEvent(db, raw, fallbackAgentId, log);
    if (r.ok) upserted++;
    else {
      skipped++;
      errors.push({ reason: r.reason });
    }
  }
  return { upserted, skipped, errors };
}

// ── reads ───────────────────────────────────────────────────────────

// Recent reverse-chronological events. sinceHours is bound; limit is
// bound (per R93.4 / R101 precedent for MSSQL TOP (?) syntax).
export async function recent(db, { sinceHours = 24, limit = 100 } = {}, log = null) {
  const sinceHoursN = Number(sinceHours);
  const limitN = Number(limit);
  try {
    // MSSQL 侧是 `SELECT TOP (?)` → limit 排第 1 (sql.js:5914).
    // MySQL 侧 `LIMIT ?` 必须在 SELECT 尾部 → limit 排最后 (sql.js:2391).
    // 两者文本顺序无法对齐 (LIMIT vs TOP), 只能在这里按 dialect 分支.
    const params = db.dialect === 'mssql'
      ? [limitN, sinceHoursN]
      : [sinceHoursN, limitN];
    const { rows } = await db.query(db.sql.failedLogon.recent, params);
    return rows || [];
  } catch (e) {
    log?.error?.({ event: 'failed_logon.recent_failed', err: e?.message }, 'failed-logon recent read failed');
    return [];
  }
}

// Hourly bucket aggregate for the 24h / 7d line chart. Returns
// [{ bucketStart: Date, count: number }, ...] already in chronological
// order (sql.js failedLogon.hourlyAggregate orders ASC).
export async function hourlyAggregate(db, { sinceHours = 24 } = {}, log = null) {
  const sinceHoursN = Number(sinceHours);
  try {
    const { rows } = await db.query(db.sql.failedLogon.hourlyAggregate, [sinceHoursN]);
    return rows || [];
  } catch (e) {
    log?.error?.({ event: 'failed_logon.hourly_aggregate_failed', err: e?.message }, 'failed-logon hourly aggregate read failed');
    return [];
  }
}

// R158.109 (2026-10-16) — daily aggregate 跟 hourlyAggregate 1:1 平行.
// 7d/全部 toggle 走 daily, 24h 仍走 hourly (R158.50 行为 0 改). 0 改
// hourlyAggregate 签名, 0 改 wire shape (路由层 re-shape 成 { bucketStart, count }).
export async function dailyAggregate(db, { days = 7 } = {}, log = null) {
  const daysN = Number(days);
  try {
    const built = db.sql.failedLogon.dailyAggregate({ days: daysN });
    const { rows } = await db.execute(built.sql, built.params);
    return rows || [];
  } catch (e) {
    log?.error?.({ event: 'failed_logon.daily_aggregate_failed', err: e?.message }, 'failed-logon daily aggregate read failed');
    return [];
  }
}

// R158.X.99.36 (2026-10-20) — /api/failed-logon/timeseries 24h bucket5m /
// 7d bucket4h 粒度. 1:1 平行 eventlog.trendByBucketMinutes
// (services/eventlog.js:279) + lockout.trendByBucketMinutes
// (services/lockout.js:215). 0 改 hourlyAggregate / dailyAggregate
// (R158.50.7n 既有 caller 0 破). 返 **raw DB rows** (snake_case
// bucket_start / event_count), 1:1 平行 dailyAggregate service
// (line 167 `return rows || []`) — 路由层 reshape 读 r.bucket_start /
// r.event_count, 若 service 层提前 camelCase 会让 reshape 读 undefined
// → count 全 0 (R158.X.99.36 fix 真因). 24h 走 bucketMinutes=5
// (288 段), 7d 走 bucketMinutes=240 (42 段). 操作员 directive "密码错误
// 监控也按照这种方式进行操作" 1:1 平行 R158.X.99.33+.34 eventlog +
// R158.X.99.35 lockout 范式. try/catch + [] 兜底 跟既有一致.
// lesson 125/126/127 (account mode = single series global count; bucket
// 维度走 occurred_at 事件触发时间) + lesson 128 (service 层 0 改 shape,
// 返 raw rows 交路由 reshape 单一真源).
export async function trendByBucketMinutes(db, { hours = 24, bucketMinutes = 5 } = {}, log = null) {
  const hoursN = Number(hours);
  try {
    const built = db.sql.failedLogon.trendByBucketMinutes({ hours: hoursN, bucketMinutes });
    const { rows } = await db.execute(built.sql, built.params);
    return rows || [];
  } catch (e) {
    log?.error?.({
      event: 'failed_logon.trend_by_bucket_minutes_failed',
      hours: hoursN,
      bucketMinutes,
      err: e?.message || String(e)
    }, 'failed-logon trendByBucketMinutes read failed');
    return [];
  }
}

// Drill-down search (filter by dc / user / ip). sinceHours is bound,
// limit is bound. Empty string filters mean "no filter on this column"
// (mirrors lockout.js search pattern).
export async function search(db, { sinceHours = 24, dcName = '', userName = '', ipAddress = '', limit = 200 } = {}, log = null) {
  const sinceHoursN = Number(sinceHours);
  const limitN = Number(limit);
  try {
    // 同 recent(): mssql = [limit, sinceHours, dcName×2, userName×2, ip×2]
    // (sql.js:5923), mysql = [sinceHours, dcName×2, userName×2, ip×2, limit]
    // (sql.js:2401, LIMIT 尾部). 之前固定按 mssql 传 → mysql 的
    // `(? = '' OR dc_name = ?)` 拿到 200/24 → 恒假 → 空数组且不报错.
    const filters = [
      dcName || '', dcName || '',
      userName || '', userName || '',
      ipAddress || '', ipAddress || ''
    ];
    const params = db.dialect === 'mssql'
      ? [limitN, sinceHoursN, ...filters]
      : [sinceHoursN, ...filters, limitN];
    const { rows } = await db.query(db.sql.failedLogon.search, params);
    return rows || [];
  } catch (e) {
    log?.error?.({ event: 'failed_logon.search_failed', err: e?.message }, 'failed-logon search read failed');
    return [];
  }
}

// R158.55 (2026-10-08) — top-N workstation aggregate for the
// "按锁定服务器" toggle on /failed-logon-2h. Reshapes DB rows to
// camelCase. machine-account fail-safe is already in the SQL helper.
export async function aggregateByWorkstation(db, { sinceHours = 24, topN = 5, dcName = null } = {}, log = null) {
  try {
    // R158.111 (2026-10-16) — dcName 透传 (报表中心 failed-logon 详情 by=workstation
    //   时进一步限定某 DC). dcName=null → 0 改老行为 (R158.50 caller).
    const built = db.sql.failedLogon.aggregateByWorkstation({ sinceHours, topN, dcName });
    const { rows } = await db.execute(built.sql, built.params);
    return (rows || []).map((r) => ({
      workstationName: r.workstation_name,
      eventCount:      Number(r.event_count)
    }));
  } catch (e) {
    log?.error?.({ event: 'failed_logon.aggregate_by_workstation_failed', sinceHours, topN, err: e?.message || String(e) }, 'failed-logon aggregate by workstation read failed');
    return [];
  }
}

// R158.1W.1 (2026-10-16) — 账户访问分布图 (原名: 账户-工作站关联网络图, graph + sankey 双形态).
//   跟 aggregateByWorkstation (line 197) 1:1 平行范式 (try/catch + log + return
//   rows.map), 但返 {nodes, links} envelope 供 ECharts graph/force + sankey
//   复用 (1:1 平行 TopologyView.vue:27,35 数据形状).
//   机器账户 NULLIF/trim 已在 SQL 层完成, service 层只做 camelCase reshape.
//   user node: id='u:'+sam, kind='user', weight=totalCount.
//   workstation node: id='w:'+workstation, kind='workstation', weight=该 workstation 跨 user 总 event_count.
//   link: source='u:'+sam, target='w:'+workstation, weight=eventCount.
export async function accountWorkstationLinks(db, { sinceHours = 168, minStations = 3, limit = 200 } = {}, log = null) {
  try {
    const built = db.sql.failedLogon.accountWorkstationLinks({ sinceHours, minStations, limit });
    const { rows } = await db.execute(built.sql, built.params);
    const linkArr = (rows || []).map((r) => ({
      source:    'u:' + r.sam,
      target:    'w:' + r.workstation,
      weight:    Number(r.event_count),
      firstSeen: r.first_seen,
      lastSeen:  r.last_seen
    }));
    // node 集去重 (link 出现 = node 必存在)
    const userMap = new Map();       // sam -> {weight, stationCount, dcList, firstSeen, lastSeen}
    const wsMap = new Map();         // workstation -> {weight, dcList, firstSeen, lastSeen}
    for (const r of rows || []) {
      // user 节点
      const u = userMap.get(r.sam) || {
        weight: Number(r.total_count), stationCount: Number(r.station_count),
        dcList: r.dc_list || '', firstSeen: r.first_seen, lastSeen: r.last_seen
      };
      // 跨多 row 累加 first/last + dc_list union (用 set 简单合并)
      if (r.first_seen && (!u.firstSeen || new Date(r.first_seen) < new Date(u.firstSeen))) u.firstSeen = r.first_seen;
      if (r.last_seen  && (!u.lastSeen  || new Date(r.last_seen)  > new Date(u.lastSeen)))  u.lastSeen  = r.last_seen;
      const dcs = new Set((u.dcList ? u.dcList.split(',') : []).concat((r.dc_list || '').split(',')).filter(Boolean));
      u.dcList = [...dcs].sort().join(',');
      userMap.set(r.sam, u);
      // workstation 节点
      const w = wsMap.get(r.workstation) || {
        weight: 0, dcList: r.dc_list || '', firstSeen: r.first_seen, lastSeen: r.last_seen
      };
      w.weight += Number(r.event_count);
      if (r.first_seen && (!w.firstSeen || new Date(r.first_seen) < new Date(w.firstSeen))) w.firstSeen = r.first_seen;
      if (r.last_seen  && (!w.lastSeen  || new Date(r.last_seen)  > new Date(w.lastSeen)))  w.lastSeen  = r.last_seen;
      const wdcs = new Set((w.dcList ? w.dcList.split(',') : []).concat((r.dc_list || '').split(',')).filter(Boolean));
      w.dcList = [...wdcs].sort().join(',');
      wsMap.set(r.workstation, w);
    }
    const nodes = [];
    for (const [sam, u] of userMap) {
      nodes.push({
        id: 'u:' + sam, label: sam, kind: 'user',
        weight: u.weight, stationCount: u.stationCount,
        dcList: u.dcList, firstSeen: u.firstSeen, lastSeen: u.lastSeen
      });
    }
    for (const [ws, w] of wsMap) {
      nodes.push({
        id: 'w:' + ws, label: ws, kind: 'workstation',
        weight: w.weight, dcList: w.dcList, firstSeen: w.firstSeen, lastSeen: w.lastSeen
      });
    }
    return { nodes, links: linkArr };
  } catch (e) {
    log?.error?.({ event: 'failed_logon.account_workstation_graph_failed', sinceHours, minStations, limit, err: e?.message || String(e) }, 'failed-logon account-workstation graph read failed');
    return { nodes: [], links: [] };
  }
}

// R158.55 — hourly bucket trend per workstation. workstation= override
// narrows to a single series; default is top-N mode. Returns flat
// [{ workstationName, bucketStart, eventCount }, ...] ordered
// (workstationName ASC, bucketStart ASC) so the ECharts pivot helper
// lines up across /lockout-accounts and /failed-logon-2h.
export async function trendByWorkstation(db, { windowHours = 24, topN = 5, workstation = null } = {}, log = null) {
  try {
    const built = db.sql.failedLogon.trendByWorkstation({ windowHours, topN, workstation });
    const { rows } = await db.execute(built.sql, built.params);
    return (rows || []).map((r) => ({
      workstationName: r.workstation_name,
      bucketStart:     r.bucket_start,
      eventCount:      Number(r.event_count)
    }));
  } catch (e) {
    log?.error?.({ event: 'failed_logon.trend_by_workstation_failed', windowHours, topN, workstation, err: e?.message || String(e) }, 'failed-logon trend by workstation read failed');
    return [];
  }
}

// R158.57 (2026-10-09) — top-N DC aggregate for the "按认证 DC" toggle
// on /failed-logon-2h. Mirrors aggregateByWorkstation shape (line 182).
// Helps the operator spot which DC is producing the most 4625s.
export async function aggregateByDc(db, { sinceHours = 24, topN = 5, dcName = null } = {}, log = null) {
  try {
    // R158.111 (2026-10-16) — dcName 透传 (报表中心 by=dc 时进一步限定某 DC,
    //   语义退化 — 结果集即只看该 DC 1 行). dcName=null → 0 改老行为.
    const built = db.sql.failedLogon.aggregateByDc({ sinceHours, topN, dcName });
    const { rows } = await db.execute(built.sql, built.params);
    return (rows || []).map((r) => ({
      dcName:     r.dc_name,
      eventCount: Number(r.event_count)
    }));
  } catch (e) {
    log?.error?.({ event: 'failed_logon.aggregate_by_dc_failed', sinceHours, topN, err: e?.message || String(e) }, 'failed-logon aggregate by dc read failed');
    return [];
  }
}

// R158.57 — hourly bucket trend per DC. dc= override narrows to a
// single series; default is top-N mode. Returns flat
// [{ dcName, bucketStart, eventCount }, ...] ordered (dcName ASC,
// bucketStart ASC) for the ECharts pivot helper.
export async function trendByDc(db, { windowHours = 24, topN = 5, dc = null } = {}, log = null) {
  try {
    const built = db.sql.failedLogon.trendByDc({ windowHours, topN, dc });
    const { rows } = await db.execute(built.sql, built.params);
    return (rows || []).map((r) => ({
      dcName:     r.dc_name,
      bucketStart: r.bucket_start,
      eventCount:  Number(r.event_count)
    }));
  } catch (e) {
    log?.error?.({ event: 'failed_logon.trend_by_dc_failed', windowHours, topN, dc, err: e?.message || String(e) }, 'failed-logon trend by dc read failed');
    return [];
  }
}

// ── retention ───────────────────────────────────────────────────────

// R158.50 (2026-10-06) — 168h retention covers both /failed-logon-2h
// 24h endpoint AND 7d endpoint. Hard-coded for now (same as eventlog
// 4h/24h precedent); system_config.failed_logon_retention_hours UI hook
// is a R158.51 follow-up ticket.
//
// R158.107 (2026-10-16) — 改读 ad_mgmt_retention_days (8 service 统一单点).
//   删 hard-coded 168h, 默认 30d. 0 = 永久保留 (return). 4625 频次高,
//   30d 数据量是 7d 4× — 操作员改 ad_mgmt_retention_days 7/14 缩可降.
const FAILED_LOGON_DEFAULT_RETENTION_DAYS = 30;
const FAILED_LOGON_RETENTION_INTERVAL_MS = 60 * 60 * 1000; // 1h cadence

export async function purgeOlderThan(db, { cutoffIso }, log = null) {
  try {
    // R161.5 (2026-10-26) — MySQL 5.7 的 DATETIME 列拒绝 ISO 8601 字符串。
    //   ad_failed_logon_events.occurred_at 是 DATETIME NOT NULL (MySQL 基线),
    //   之前把 `2026-09-26T00:30:00.655Z` 直接绑进去 ⇒ ER 1292
    //   "Incorrect datetime value" ⇒ **整条 DELETE 回滚** ⇒ 30 天前的
    //   failed_logon 记录永久残留 (生产日志 center.2026-10-25.1.log:59
    //   与 center.2026-10-26.1.log:20 已复现)。
    //   MSSQL 侧 datetime2 接受 ISO ⇒ 这个缺陷在 MSSQL 上完全看不出来。
    //   ⇒ 在这里 (唯一收口点) 按方言转换, 调用方仍传 ISO, 日志仍用 ISO。
    const cutoffParam = db?.dialect === 'mssql' ? cutoffIso : toMysqlDatetime(cutoffIso);
    await db.execute(db.sql.failedLogon.purgeOlderThan, [cutoffParam]);
    log?.info?.({ event: 'failed_logon.retention_purged', cutoffIso }, 'failed-logon retention purge');
    return { ok: true };
  } catch (e) {
    log?.error?.({ event: 'failed_logon.purge_failed', err: e?.message }, 'failed-logon purge failed');
    return { ok: false, error: e?.message || String(e) };
  }
}

// Mirrors eventlog.js:createEventlogRetentionLoop factory shape.
// R158.107 — 加 getSystemConfig 参数, 跟其它 7 service 1:1 平行
export function createFailedLogonRetentionLoop({ db, getSystemConfig, logger }) {
  let interval = null;
  let inFlight = false;
  async function tick() {
    if (inFlight) return;
    inFlight = true;
    try {
      let days = FAILED_LOGON_DEFAULT_RETENTION_DAYS;
      try {
        const cfg = (await getSystemConfig?.()) || {};
        // R158.107 — 改读 ad_mgmt_retention_days
        const raw = cfg.ad_mgmt_retention_days;
        const parsed = Number(raw);
        if (raw == null || raw === '') {
          days = FAILED_LOGON_DEFAULT_RETENTION_DAYS;
        } else if (Number.isFinite(parsed) && parsed <= 0) {
          logger?.info?.({ event: 'failed_logon.retention_disabled' }, 'failed-logon retention disabled (ad_mgmt_retention_days <= 0)');
          return;
        } else if (Number.isFinite(parsed) && parsed > 0) {
          days = Math.floor(parsed);
          // R158.X.99.32 (2026-10-19) — defensive floor guard
          if (days < 1) { return { skipped: true, reason: 'ad_mgmt_retention_days < 1 (defensive floor)' }; }
        } else {
          logger?.warn?.({ ad_mgmt_retention_days: raw },
            'failed-logon retention days is non-numeric, using default');
          days = FAILED_LOGON_DEFAULT_RETENTION_DAYS;
        }
      } catch (e) {
        logger?.warn?.({ err: e.message }, 'failed-logon retention: getSystemConfig failed (best-effort)');
        return;
      }
      const cutoffIso = new Date(Date.now() - days * 86400 * 1000).toISOString();
      await purgeOlderThan(db, { cutoffIso }, logger);
    } catch (e) {
      logger?.warn?.({ event: 'failed_logon.retention_tick_failed', err: e?.message }, 'failed-logon retention tick failed');
    } finally {
      inFlight = false;
    }
  }
  return {
    start() {
      if (interval) return;
      interval = setInterval(tick, FAILED_LOGON_RETENTION_INTERVAL_MS);
      tick();
    },
    async stop() {
      if (interval) clearInterval(interval);
      interval = null;
    },
    tick,
    isRunning: () => interval !== null
  };
}

export { normalizeEvent };
