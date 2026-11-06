// R107.1 — Centre-side ETL for ad_lockout_events.
//
// Data flow:
//   agent ad_lockout_list (v2 package)  -->  metricstore.ingestRunV2 (JSON column)
//                                       -->  THIS MODULE post-hook (per-event upsert)
//
// Why this exists: pkg_ad_lockout_list.metrics holds the whole events array as
// a single JSON column. /admin/lockout-troubleshooting reads from ad_lockout_events
// (one row per event). The ETL that flattens JSON-array -> individual rows was
// never wired — see progress_2026_09_25_r107_lockout_events_etl_missing.md.
//
// Dedupe key: (dc_name, event_record_id) — encoded in BOTH SQL helpers
// (MySQL via unique constraint + ON DUPLICATE; MSSQL via MERGE ON t.dc_name
// AND t.event_record_id). Re-uploading the same events is idempotent.

// Param order must match db.sql.lockout.upsertEvent in BOTH dialects:
//   occurred_at, collected_at, agent_id, dc_name, event_record_id,
//   target_user_name, target_user_display_name,
//   subject_user_name, subject_domain, caller_computer_name
// (MySQL helper at sql.js lockout block; MSSQL MERGE helper at the same
// block — both bind in the same order for the INSERT side, per R101
// canonical pattern.) R158.31 renamed target_user_description →
// target_user_display_name (7th slot) to match the new AD attribute
// (`displayName`) the agent now stamps.
const BIND_ORDER = [
  'occurredAt',
  'collectedAt',
  'agentId',
  'dcName',
  'eventRecordId',
  'targetUserName',
  'targetUserDisplayName',
  'subjectUserName',
  'subjectDomain',
  'callerComputerName'
];

function pickField(evt, ...keys) {
  if (evt == null) return null;
  for (const k of keys) {
    if (evt[k] !== undefined && evt[k] !== null) return evt[k];
  }
  return null;
}

// R134 — agent collect.ps1 emits `[PSCustomObject]@{ EventRecordId=...;
// OccurredAt=...; TargetUserName=...; SubjectUserName=...;
// SubjectDomain=...; CallerComputerName=... }` and the agent reporter
// does NOT convert keys (verified via stdout_preview for KDLFLOFADSRV2 —
// "EventRecordId":115839660 etc). pre-R134 normalizeEvent only accepted
// camelCase + snake_case, so PascalCase fell through and eventRecordId
// stayed undefined → normalizeEvent returned null → upserted=0 forever.
// Add PascalCase aliases alongside the existing camelCase / snake_case
// candidates (matches R132 partner-port-probe.js pattern: destDc +
// peer_dc all accepted).
const FIELD_ALIASES = {
  dcName:                ['dcName', 'dc_name', 'DcName'],
  eventRecordId:         ['eventRecordId', 'event_record_id', 'EventRecordId'],
  occurredAt:            ['occurredAt', 'occurred_at', 'OccurredAt'],
  targetUserName:        ['targetUserName', 'target_user_name', 'TargetUserName'],
  // R158.31: was targetUserDescription (R139.1, AD `description`). Now
  // agent emits `TargetUserDisplayName` after a 24h-cached Get-ADUser
  // -Properties displayName lookup. Accept PascalCase + snake/camel
  // variants, mirroring the existing alias pattern.
  targetUserDisplayName: ['targetUserDisplayName', 'target_user_display_name', 'TargetUserDisplayName'],
  subjectUserName:       ['subjectUserName', 'subject_user_name', 'SubjectUserName'],
  subjectDomain:         ['subjectDomain', 'subject_domain', 'SubjectDomain'],
  callerComputerName:    ['callerComputerName', 'caller_computer_name', 'CallerComputerName']
};

function normalizeEvent(evt, fallbackAgentId) {
  // dc_name: explicit > evt aliases > fallback (agentId).
  // In AD topology the agentId IS the DC hostname, so the fallback is the
  // canonical answer when collect.ps1 doesn't stamp dc_name.
  const dcName = pickField(evt, ...FIELD_ALIASES.dcName) || fallbackAgentId || null;
  const eventRecordId = pickField(evt, ...FIELD_ALIASES.eventRecordId);
  if (eventRecordId === null || eventRecordId === undefined || eventRecordId === '') {
    return null; // dedupe key component missing — refuse to write a half-row
  }
  const occurredAtRaw = pickField(evt, ...FIELD_ALIASES.occurredAt);
  const occurredAt = occurredAtRaw instanceof Date
    ? occurredAtRaw
    : new Date(occurredAtRaw || Date.now());
  return {
    agentId:              fallbackAgentId || null,
    dcName,
    eventRecordId,
    occurredAt,
    targetUserName:       pickField(evt, ...FIELD_ALIASES.targetUserName),
    targetUserDisplayName: pickField(evt, ...FIELD_ALIASES.targetUserDisplayName),
    subjectUserName:      pickField(evt, ...FIELD_ALIASES.subjectUserName),
    subjectDomain:        pickField(evt, ...FIELD_ALIASES.subjectDomain),
    callerComputerName:   pickField(evt, ...FIELD_ALIASES.callerComputerName),
    collectedAt:          new Date()
  };
}

// 9-param order for both dialects.
function bindParams(normalized) {
  return BIND_ORDER.map((k) => {
    const v = normalized[k];
    if (k === 'occurredAt' || k === 'collectedAt') {
      // Pass Date through — mysql2/mssql both accept Date objects; toMysqlDatetime
      // conversion is the route's responsibility on read, and ad_lockout_events
      // is DATETIME(3) which driver formats automatically.
      return v;
    }
    return v;
  });
}

export async function upsertEvent(db, evt, fallbackAgentId = null) {
  const normalized = normalizeEvent(evt, fallbackAgentId);
  if (!normalized) {
    return { ok: false, reason: 'missing event_record_id' };
  }
  const params = bindParams(normalized);
  // R101 canonical dispatch — sql helpers are dialect-specific, not function-form
  // here because the INSERT side binds identically for both. The MSSQL helper's
  // CAST casts are baked into the SQL string (sql.js:1589), not in param shape.
  const sql = db.sql.lockout.upsertEvent;
  await db.execute(sql, params);
  return { ok: true };
}

// Batch wrapper: skip null entries (missing dedupe key), swallow per-event errors
// so one bad event doesn't kill the batch — the metricstore INSERT already
// succeeded and /api/lockout-events/search still gets the good rows.
export async function upsertEvents(db, events, fallbackAgentId = null, log = null) {
  if (!Array.isArray(events)) {
    return { upserted: 0, skipped: 0, errors: [] };
  }
  let upserted = 0;
  let skipped = 0;
  const errors = [];
  for (let i = 0; i < events.length; i++) {
    const evt = events[i];
    try {
      const res = await upsertEvent(db, evt, fallbackAgentId);
      if (res.ok) upserted++;
      else skipped++;
    } catch (e) {
      errors.push({ index: i, error: e?.message || String(e) });
      log?.warn?.({
        event: 'lockout.etl.event_failed',
        index: i,
        err: e?.message,
        dcName: pickField(evt, ...FIELD_ALIASES.dcName),
        eventRecordId: pickField(evt, ...FIELD_ALIASES.eventRecordId)
      }, 'lockout event upsert failed');
    }
  }
  return { upserted, skipped, errors };
}

// Re-export so routes/tests can introspect the dispatch without duplicating it.
export { normalizeEvent, bindParams };

// ── reads ───────────────────────────────────────────────────────────

// R158.53 (2026-10-08) — 24h hourly event-log trend for the
// /lockout-accounts line chart. Reshapes DB rows to camelCase. The
// machine-account fail-safe (`target_user_name NOT LIKE '%$'`) is
// already baked into the SQL helper (R158.50.7e), so by the time rows
// reach here they're already filtered. `dc` deep-link from
// /lockout-accounts?dc=HOST overrides top-N — single agent only.
// Returns [{ agentId, bucketStart, eventCount }, ...] ordered
// (agentId ASC, bucketStart ASC) — the same shape ECharts' pivot
// helper in LockoutAccountsView.vue expects.
export async function trend24h(db, { dc = null, topN = 5 } = {}, log = null) {
  try {
    const { sql, params } = db.sql.lockout.trend24h({ dc, topN });
    const { rows } = await db.query(sql, params);
    return (rows || []).map((r) => ({
      agentId:     r.agent_id,
      bucketStart: r.bucket_start,    // 'YYYY-MM-DD HH:00:00' string OR Date
      eventCount:  Number(r.event_count)
    }));
  } catch (e) {
    log?.error?.({
      event: 'lockout.trend24h_failed',
      dc,
      topN,
      err: e?.message || String(e)
    }, 'lockout trend24h read failed');
    return [];
  }
}

// R158.109.b (2026-10-16) — daily aggregate 跟 trend24h 1:1 平行.
// 7d/全部 toggle 走 daily. 24h 仍走 trend24h (R158.53 行为 0 改).
// 跟 R158.109.a failedLogon.dailyAggregate (line 162) 范式 1:1 平行.
// 0 改 trend24h 签名, 0 改 wire shape. 路由层 0 reshape.
export async function dailyAggregate(db, { dc = null, topN = 5, windowDays = 7 } = {}, log = null) {
  try {
    const built = db.sql.lockout.dailyAggregate({ dc, topN, windowDays });
    const { rows } = await db.execute(built.sql, built.params);
    return (rows || []).map((r) => ({
      agentId:     r.agent_id,
      bucketStart: r.bucket_start,    // 'YYYY-MM-DD 00:00:00' string OR Date
      eventCount:  Number(r.event_count)
    }));
  } catch (e) {
    log?.error?.({
      event: 'lockout.daily_aggregate_failed',
      dc,
      topN,
      windowDays,
      err: e?.message || String(e)
    }, 'lockout daily aggregate read failed');
    return [];
  }
}

// R158.X.99.35 (2026-10-20) — /lockout-accounts chart 24h/7d bucket 粒度.
// 1:1 平行 eventlog.trendByBucketMinutes (services/eventlog.js:279) +
// 范式 1:1 平行 lockout.trend24h (本文件 line 170) / lockout.dailyAggregate
// (本文件 line 194). 返 `{ agentId, bucketStart, eventCount }` shape 跟
// 既有一致, pivot / renderChart 0 改 wire 透传即可. 24h 走 bucketMinutes=5
// (288 段 × 5 DC), 7d 走 bucketMinutes=240 (42 段 × 5 DC). 操作员 directive
// "24小时内窗口时间为5分钟, 7天窗口时间为4小时" 1:1 平行 R158.X.99.33+.34
// eventlog 范式. try/catch + [] 兜底跟既有一致. lesson 123/124 (chart 3-mode
// 平行 eventlog, GROUP BY 维度差异 = agent_id 替 channel).
export async function trendByBucketMinutes(db, { dc = null, topN = 5, hours = 24, bucketMinutes = 5 } = {}, log = null) {
  try {
    const built = db.sql.lockout.trendByBucketMinutes({ dc, topN, hours, bucketMinutes });
    const { rows } = await db.execute(built.sql, built.params);
    return (rows || []).map((r) => ({
      agentId:     r.agent_id,
      bucketStart: r.bucket_start,
      eventCount:  Number(r.event_count)
    }));
  } catch (e) {
    log?.error?.({
      event: 'lockout.trend_by_bucket_minutes_failed',
      dc,
      topN,
      hours,
      bucketMinutes,
      err: e?.message || String(e)
    }, 'lockout trendByBucketMinutes read failed');
    return [];
  }
}

// R158.1W.3 (2026-10-16) — 账户锁定分布图 service fn (跟
//   failedLogon.accountWorkstationLinks 1:1 平行, 字段映射:
//   ad_failed_logon_events → ad_lockout_events,
//   workstation_name → caller_computer_name).
//   数据源: ad_lockout_events 4740 事件 (锁定触发, 1:1 平行 4625
//   失败登录, 0 改 schema / 0 改 agent / 0 改 ETL). envelope shape
//   { nodes, links } 跟 R158.1W.1 1:1 平行, 0 改 wire → 0 改前端
//   AccountWorkstationGraphView 即可复用作新 view 模板.
export async function lockoutAccountLinks(db, { sinceHours = 168, minStations = 3, limit = 200 } = {}, log = null) {
  try {
    const built = db.sql.lockout.accountWorkstationLinks({ sinceHours, minStations, limit });
    const { rows } = await db.execute(built.sql, built.params);
    const linkArr = (rows || []).map((r) => ({
      source:    'u:' + r.sam,
      target:    'w:' + r.workstation,
      weight:    Number(r.event_count),
      firstSeen: r.first_seen,
      lastSeen:  r.last_seen
    }));
    const userMap = new Map();
    const wsMap = new Map();
    for (const r of rows || []) {
      const u = userMap.get(r.sam) || {
        weight: Number(r.total_count), stationCount: Number(r.station_count),
        dcList: r.dc_list || '', firstSeen: r.first_seen, lastSeen: r.last_seen
      };
      if (r.first_seen && (!u.firstSeen || new Date(r.first_seen) < new Date(u.firstSeen))) u.firstSeen = r.first_seen;
      if (r.last_seen  && (!u.lastSeen  || new Date(r.last_seen)  > new Date(u.lastSeen)))  u.lastSeen  = r.last_seen;
      const dcs = new Set((u.dcList ? u.dcList.split(',') : []).concat((r.dc_list || '').split(',')).filter(Boolean));
      u.dcList = [...dcs].sort().join(',');
      userMap.set(r.sam, u);
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
    log?.error?.({ event: 'lockout.account_workstation_graph_failed', sinceHours, minStations, limit, err: e?.message || String(e) }, 'lockout account-workstation graph read failed');
    return { nodes: [], links: [] };
  }
}