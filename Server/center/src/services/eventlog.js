// R112 — ad_eventlog_* post-hook + read helpers.
//
// Why this exists:
//   ad_eventlog_events + ad_eventlog_summary are PUBLIC tables (operator's
//   "公共表" intent, like R110.A's ad_dc_overview and R107.1's
//   ad_lockout_events). The ad_eventlog_collector v2 package manifest
//   omits its `database` block so the v2 metricstore path never runs
//   (seedBuiltinPackages:218 + metricstore.ingestRunV2:97 both gate on
//   manifest.database). The runner post-hook therefore writes to the
//   eventlog tables directly.
//
// This module mirrors center/src/services/dc-overview.js (R110.A) and
// center/src/services/lockout.js (R107.1):
//   - dialect dispatch is BAKED INTO the SQL helpers (sql.js eventlog.*
//     returns { sql, params } from the active dialect), not in this
//     module — keeps the service dialect-agnostic.
//   - per-record try/catch so one bad row doesn't fail the whole batch.
//   - returns { upserted, skipped, errors } summaries for the route log.
//
// Wire shape coming out of collect.ps1 (one package run per DC per
// collection cycle): run.metrics carries an `events` array (per-event
// rows) AND a `summaries` array (per-(dc,channel) counter rollups).
// The runner post-hook invokes upsertEvents + upsertSummaries in a
// single pass per package run.

function pickField(o, camelKey, snakeKey) {
  if (o == null) return null;
  if (o[camelKey] !== undefined && o[camelKey] !== null) return o[camelKey];
  if (o[snakeKey] !== undefined && o[snakeKey] !== null) return o[snakeKey];
  return null;
}

function asDate(value, fallback) {
  if (value instanceof Date) return value;
  if (value) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return fallback ?? new Date();
}

function normalizeEvent(evt, fallbackAgentId) {
  const agentId = pickField(evt, 'agentId', 'agent_id') || fallbackAgentId || null;
  const dcName  = pickField(evt, 'dcName', 'dc_name')  || agentId;
  if (!agentId || !dcName) return null;

  const channel  = pickField(evt, 'channel');
  const severity = pickField(evt, 'severity');
  const eventId  = pickField(evt, 'eventId', 'event_id');
  const recordId = pickField(evt, 'recordId', 'record_id');
  const message  = pickField(evt, 'message');
  if (!channel || !severity || eventId == null || recordId == null || message == null) {
    return null;
  }

  return {
    agentId,
    dcName,
    channel:  String(channel),
    severity: String(severity),
    eventId:  Number(eventId),
    recordId: Number(recordId),
    message:  String(message),
    collectedAt: asDate(pickField(evt, 'collectedAt', 'collected_at')),
    ts:        asDate(pickField(evt, 'ts'), asDate(null)),
    // R154 — audit_failure flag. PowerShell writes 1 for Security channel
    // events matching the 4625/4776 whitelist; 0 otherwise. Default to 0
    // when the field is missing (v1.0.0 packages).
    auditFailure: Number(pickField(evt, 'auditFailure', 'audit_failure')) || 0
  };
}

function normalizeSummary(s, fallbackAgentId) {
  const agentId = pickField(s, 'agentId', 'agent_id') || fallbackAgentId || null;
  const dcName  = pickField(s, 'dcName', 'dc_name')  || agentId;
  if (!agentId || !dcName) return null;
  const channel = pickField(s, 'channel');
  if (!channel) return null;

  return {
    agentId,
    dcName,
    channel: String(channel),
    warningCount: Number(pickField(s, 'warningCount', 'warning_count')) || 0,
    errorCount:   Number(pickField(s, 'errorCount', 'error_count'))     || 0,
    // R154 — audit_failure_count on the summary row. Same shape as the
    // event-level flag; PowerShell writes it for the Security channel,
    // 0 for the other 4 channels.
    auditFailureCount: Number(pickField(s, 'auditFailureCount', 'audit_failure_count')) || 0,
    // R158.52 (v1.0.5) — operator directive "零或空 / 都修复, 避免数据
    // 出现错误": the PS1 collector tracks how many events were dropped
    // because the 1000-row per-channel limit was reached, so the centre
    // can surface "real activity was X+Y" instead of just "X". Pre-1.0.5
    // summary rows carry droppedCount=null; SQL is nullable so we accept
    // undefined and coerce null to 0 to keep the wire contract symmetric
    // with audit_failure_count.
    droppedCount:   Number(pickField(s, 'droppedCount', 'dropped_count')) || 0,
    collectedAt:  asDate(pickField(s, 'collectedAt', 'collected_at'))
  };
}

// ── events ──────────────────────────────────────────────────────────────
export async function upsertEvent(db, evt, fallbackAgentId = null, log = null) {
  const normalized = normalizeEvent(evt, fallbackAgentId);
  if (!normalized) {
    return { ok: false, reason: 'missing or malformed event fields' };
  }
  const built = db.sql.eventlog.upsertEvent(normalized);
  try {
    await db.execute(built.sql, built.params);
    return { ok: true, dcName: normalized.dcName, channel: normalized.channel };
  } catch (e) {
    log?.error?.({
      event: 'eventlog.upsert_event_failed',
      dcName: normalized.dcName,
      channel: normalized.channel,
      recordId: normalized.recordId,
      err: e?.message || String(e)
    }, 'eventlog event upsert failed');
    return { ok: false, reason: e?.message || String(e), dcName: normalized.dcName };
  }
}

export async function upsertEvents(db, events, fallbackAgentId = null, log = null) {
  if (!Array.isArray(events)) {
    return { upserted: 0, skipped: 0, errors: [] };
  }
  let upserted = 0;
  let skipped = 0;
  const errors = [];
  for (let i = 0; i < events.length; i++) {
    try {
      const res = await upsertEvent(db, events[i], fallbackAgentId, log);
      if (res.ok) {
        upserted++;
      } else if (res.reason === 'missing or malformed event fields') {
        skipped++;
      } else {
        errors.push({ index: i, dcName: res.dcName ?? null, error: res.reason });
      }
    } catch (e) {
      errors.push({ index: i, error: e?.message || String(e) });
    }
  }
  return { upserted, skipped, errors };
}

// ── summaries ───────────────────────────────────────────────────────────
// R131-fix: pass `fallbackAgentId` through upsertSummary / upsertSummaries
// the same way upsertEvent / upsertEvents do. Pre-fix, the runner post-hook
// for `ad_eventlog_collector` called `upsertSummaries(db, summaries, log)`
// without an agentId, and the function signature here accepted
// `log = null` as the second arg — meaning the centre had no way to know
// which agent the summaries belonged to. collect.ps1 writes summaries
// without agent_id / dc_name (those are wrapped at the metrics envelope
// level), so without the fallback the summary rows were rejected by
// `normalizeSummary` returning null on `if (!agentId || !dcName)`.
// Symptom: `ad_eventlog_summary` table was permanently empty,
// `eventlog.summaries_etl` log emitted `count:N upserted:0 skipped:N`
// on every run, and the public EventlogView grid rendered all-zeros /
// empty state. Mirror the upsertEvent signature so callers pass agentId
// the same way for both events and summaries.
export async function upsertSummary(db, summary, fallbackAgentId = null, log = null) {
  const normalized = normalizeSummary(summary, fallbackAgentId);
  if (!normalized) {
    return { ok: false, reason: 'missing agent_id / dc_name / channel' };
  }
  const built = db.sql.eventlog.upsertSummary(normalized);
  try {
    await db.execute(built.sql, built.params);
    return { ok: true, dcName: normalized.dcName, channel: normalized.channel };
  } catch (e) {
    log?.error?.({
      event: 'eventlog.upsert_summary_failed',
      dcName: normalized.dcName,
      channel: normalized.channel,
      err: e?.message || String(e)
    }, 'eventlog summary upsert failed');
    return { ok: false, reason: e?.message || String(e), dcName: normalized.dcName };
  }
}

export async function upsertSummaries(db, summaries, fallbackAgentId = null, log = null) {
  if (!Array.isArray(summaries)) {
    return { upserted: 0, skipped: 0, errors: [] };
  }
  let upserted = 0;
  let skipped = 0;
  const errors = [];
  for (let i = 0; i < summaries.length; i++) {
    try {
      const res = await upsertSummary(db, summaries[i], fallbackAgentId, log);
      if (res.ok) {
        upserted++;
      } else if (res.reason === 'missing agent_id / dc_name / channel') {
        skipped++;
      } else {
        errors.push({ index: i, dcName: res.dcName ?? null, channel: res.channel ?? null, error: res.reason });
      }
    } catch (e) {
      errors.push({ index: i, error: e?.message || String(e) });
    }
  }
  return { upserted, skipped, errors };
}

// ── reads (front-end driven) ────────────────────────────────────────────
// Latest summary row per (dc_name, channel) within the retention window.
// Drives the public EventlogView first paint (4-channel counter grid).
export async function getLatestSummary(db, { sinceHours = 2 } = {}) {
  const built = db.sql.eventlog.latestSummary({ sinceHours });
  const { rows } = await db.execute(built.sql, built.params);
  return rows ?? [];
}

// Drill-down event list for one (dc, channel[, severity]) tuple.
// severity is optional — null/empty disables that filter.
export async function queryEvents(db, { dcName, channel, severity = null, sinceHours = 2, limit = 200, auditOnly = false } = {}) {
  if (!dcName || !channel) {
    return [];
  }
  const built = db.sql.eventlog.queryEvents({ dcName, channel, severity, sinceHours, limit, auditOnly });
  const { rows } = await db.execute(built.sql, built.params);
  return rows ?? [];
}

// R158.54 (2026-10-08) — 24h hourly event log trend for the /eventlog
// line chart. Reshapes DB rows to camelCase. 5 channel fixed; pivot
// happens client-side. Reuses lockout.trend24h shape so the chart
// code is generic (channel instead of agentId).
export async function trend24h(db, { hours = 24 } = {}, log = null) {
  try {
    const built = db.sql.eventlog.trend24h({ hours });
    const { rows } = await db.execute(built.sql, built.params);
    return (rows || []).map((r) => ({
      channel:     r.channel,
      bucketStart: r.bucket_start,    // 'YYYY-MM-DD HH:00:00' string OR Date
      eventCount:  Number(r.event_count)
    }));
  } catch (e) {
    log?.error?.({
      event: 'eventlog.trend24h_failed',
      hours,
      err: e?.message || String(e)
    }, 'eventlog trend24h read failed');
    return [];
  }
}

// R158.108 (2026-10-16) — daily aggregate 跟 trend24h 1:1 平行.
// 7d/全部 toggle 走 daily. 5 channel × days bucket. 0 改 trend24h
// (24h 仍 hourly). 复用 trend24h shape (camelCase re-shape + try/catch
// 兜底返 []), 0 改 chart pivot 内部 logic.
export async function dailyAggregate(db, { days = 7 } = {}, log = null) {
  try {
    const built = db.sql.eventlog.dailyAggregate({ days });
    const { rows } = await db.execute(built.sql, built.params);
    return (rows || []).map((r) => ({
      channel:     r.channel,
      bucketStart: r.bucket_start,    // 'YYYY-MM-DD' string OR Date
      eventCount:  Number(r.event_count)
    }));
  } catch (e) {
    log?.error?.({
      event: 'eventlog.daily_aggregate_failed',
      days,
      err: e?.message || String(e)
    }, 'eventlog daily aggregate read failed');
    return [];
  }
}

// R158.X.99.33 (2026-10-19) — /eventlog 24h bucket-by-ts. Bucket 边界
// 走 `ts` (Windows TimeGenerated), 跟 hourly trend24h / dailyAggregate
// (都用 collected_at) 区分 — 操作员原意 "真实事件时间分布". 默认 5min
// bucket = 288 段/24h × 5 channel = 1440 点, 远比 hourly 24 段 细.
// 1:1 平行 trend24h / dailyAggregate shape (channel, bucketStart, eventCount).
// Reuses 相同 try/catch + [] 兜底范式. 7d/全部 不走本 helper, 仍 dailyAggregate.
export async function trendByBucketMinutes(db, { hours = 24, bucketMinutes = 5 } = {}, log = null) {
  try {
    const built = db.sql.eventlog.trendByBucketMinutes({ hours, bucketMinutes });
    const { rows } = await db.execute(built.sql, built.params);
    return (rows || []).map((r) => ({
      channel:     r.channel,
      bucketStart: r.bucket_start,    // 'YYYY-MM-DD HH:mm:ss' string OR Date
      eventCount:  Number(r.event_count)
    }));
  } catch (e) {
    log?.error?.({
      event: 'eventlog.trend_by_bucket_minutes_failed',
      hours, bucketMinutes,
      err: e?.message || String(e)
    }, 'eventlog trendByBucketMinutes read failed');
    return [];
  }
}

// ── retention ───────────────────────────────────────────────────────────
// Hourly retention sweep: caller resolves cutoffIso (24h ago in JS).
// Best-effort per-table — a failure on one must not block the other.
export async function purgeOlderThan(db, { cutoffIso }, log = null) {
  const built = db.sql.eventlog.purgeOlderThan({ cutoffIso });
  const out = { eventsDeleted: 0, summaryDeleted: 0, errors: [] };
  try {
    const r = await db.execute(built.sqlEvents.sql, built.sqlEvents.params);
    out.eventsDeleted = r?.affectedRows ?? r?.rowCount ?? 0;
  } catch (e) {
    out.errors.push({ table: 'ad_eventlog_events', error: e?.message || String(e) });
    log?.error?.({ event: 'eventlog.purge_failed', table: 'ad_eventlog_events', err: e?.message }, 'eventlog events purge failed');
  }
  try {
    const r = await db.execute(built.sqlSummary.sql, built.sqlSummary.params);
    out.summaryDeleted = r?.affectedRows ?? r?.rowCount ?? 0;
  } catch (e) {
    out.errors.push({ table: 'ad_eventlog_summary', error: e?.message || String(e) });
    log?.error?.({ event: 'eventlog.purge_failed', table: 'ad_eventlog_summary', err: e?.message }, 'eventlog summary purge failed');
  }
  return out;
}

// R158.X (2026-10-15) — 跨 DC 账户管理 event 列表 (Security log
//   event_id IN (4720, 4722, 4723, 4725, 4726, 4738, 4740)). 跟
//   queryEvents 平行 (camelCase re-shape, 500 wrap), 但跨 DC 视图
//   (AccountChangeDetailView 新 sub-tab 用). 不复用 queryEvents 是
//   因为它强制 dcName+channel 单 DC, 跟跨 DC 视图语义不符.
//
// 现有 ad_eventlog_events 索引 (3 个, R112 + R154 ship):
//   ix_eventlog_collected (collected_at)
//   ix_eventlog_dc_channel (dc_name, channel, ts)
//   ix_eventlog_severity (severity, ts)
//   ^ channel='Security' 跟 event_id IN 都不在这 3 个 index 里, SQL 走
//     全 collected_at 范围扫 (ix_eventlog_collected). 24h × 1 DC × <10
//     account-management event 体积很小, 性能可接受. 后续 ship 可加
//     ix_eventlog_channel_eventid_ts (channel, event_id, ts DESC) 复合
//     索引加速 (本期不动 schema, ship 风险最低).
export async function queryAccountManagementEvents(db, { eventIds, sinceHours = 24, limit = 200 } = {}) {
  if (!Array.isArray(eventIds) || eventIds.length === 0) {
    return [];
  }
  try {
    const built = db.sql.eventlog.queryAccountManagementEvents({ eventIds, sinceHours, limit });
    const { rows } = await db.execute(built.sql, built.params);
    return (rows ?? []).map((row) => ({
      collectedAt:  row.collected_at,
      dcName:       row.dc_name,
      channel:      row.channel,
      severity:     row.severity,
      eventId:      Number(row.event_id),
      recordId:     Number(row.record_id),
      message:      row.message,
      ts:           row.ts,
      auditFailure: Number(row.audit_failure ?? 0)
    }));
  } catch (e) {
    if (log?.error) {
      log.error({
        event: 'eventlog.query_account_management_failed',
        err: e?.message || String(e)
      }, 'eventlog queryAccountManagementEvents read failed');
    }
    return [];
  }
}

// Re-export for tests so the dispatch surface stays a single source of truth.
export { normalizeEvent, normalizeSummary };

// ── 24-hour retention loop factory ──────────────────────────────────────
//
// Mirrors createAuditRetentionLoop shape (Global Constraint #8): start()
// schedules a setInterval with an inFlight guard; tick() runs a single
// purgeOlderThan sweep; stop() clears the interval and waits for the
// in-flight tick so a shutdown can't strand a half-written DELETE.
//
// R154 — retention narrowed from 24h to 4h for the 4 operational channels
// (System / Application / ADWeb / DFSR). Scan window is 2h (collect.ps1
// 1.0.1), so 4h gives the retention sweep a 2h margin without growing
// the table. The public page is hard-coded to SINCE_HOURS=2 so the 4h
// retention is invisible to the operator.
//
// R158.23 (2026-10-02) — Security channel gets its OWN retention window
// of 24h, NOT 4h. Operator directive: "这个将来也只保留 24 小时". 4625/4776
// audit-failure events are the diagnostic trail for forensic incident
// response (who tried to log in, from where, how often), and the 4h
// default would've discarded evidence too quickly for the "上面有15条"
// type of investigation. 24h aligns with the operator's mental model
// (R112 product requirement: "数据只轮询保留24小时") while keeping the
// 4 operational channels lean.
//
// R158.107 (2026-10-16) — 4h/24h 双 tier 退场, 改读 ad_mgmt_retention_days
//   (8 service 统一单点). 5 channel 全走统一天数 sweep, 不再分 non-Security
//   4h + Security 24h. 操作员 directive "后续所有数据保留周期都统一". 默认 30d.
//   0 = 永久保留 (sweep 禁用, return). 单 sweep 走 db.sql.eventlog.purgeOlderThan
//   (跨 channel 删, 跟原 db.sql.eventlog.purgeOlderThanChannel 1:1 平行但
//   0 需 channel marker).
//
// Cadence is hard-coded at 1 hour — coarse-grained background work, no
// per-tick interval knob. To run a purge on demand (operator command,
// test), call `tick()` directly — it returns the same shape
// purgeOlderThan returns.
const EVENTLOG_RETENTION_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
// R158.107 — default 30d 跟 ad_mgmt_retention_days 1:1 平行
const EVENTLOG_DEFAULT_RETENTION_DAYS = 30;

export function createEventlogRetentionLoop({ db, getSystemConfig, logger }) {
  let interval = null;
  let inFlight = null;

  async function tick() {
    let days = EVENTLOG_DEFAULT_RETENTION_DAYS;
    try {
      const cfg = (await getSystemConfig?.()) || {};
      // R158.107 — 改读 ad_mgmt_retention_days
      const raw = cfg.ad_mgmt_retention_days;
      const parsed = Number(raw);
      if (raw == null || raw === '') {
        days = EVENTLOG_DEFAULT_RETENTION_DAYS;
      } else if (Number.isFinite(parsed) && parsed <= 0) {
        // operator disabled retention explicitly
        return { skipped: true, reason: 'ad_mgmt_retention_days <= 0 (retention disabled)' };
      } else if (Number.isFinite(parsed) && parsed > 0) {
        days = Math.floor(parsed);
        // R158.X.99.32 (2026-10-19) — defensive floor guard
        if (days < 1) { return { skipped: true, reason: 'ad_mgmt_retention_days < 1 (defensive floor)' }; }
      } else {
        logger?.warn?.({ ad_mgmt_retention_days: raw },
          'eventlog retention days is non-numeric, using default');
        days = EVENTLOG_DEFAULT_RETENTION_DAYS;
      }
    } catch (e) {
      logger?.warn?.({ err: e.message }, 'eventlog retention: getSystemConfig failed (best-effort)');
      return { skipped: true, reason: `getSystemConfig failed: ${e.message}` };
    }
    const cutoff = new Date(Date.now() - days * 86400_000);
    const out = { eventsDeleted: 0, summaryDeleted: 0, errors: [], days };
    const result = await purgeOlderThan(db, { cutoffIso: cutoff }, logger);
    out.eventsDeleted  = result.eventsDeleted;
    out.summaryDeleted = result.summaryDeleted;
    out.errors         = result.errors;
    logger?.info?.({
      sweep: `eventlog ${days}d`,
      eventsDeleted: out.eventsDeleted,
      summaryDeleted: out.summaryDeleted,
      errorCount: out.errors.length
    }, 'eventlog retention sweep complete');
    return out;
  }

  function start() {
    if (interval) return;
    interval = setInterval(() => {
      inFlight = tick().catch((e) =>
        logger?.warn?.({ err: e?.message || String(e) }, 'eventlog retention tick failed (best-effort)')
      );
    }, EVENTLOG_RETENTION_INTERVAL_MS);
  }

  async function stop() {
    if (interval) clearInterval(interval);
    interval = null;
    if (inFlight) await inFlight.catch(() => {});
    inFlight = null;
  }

  return {
    start,
    stop,
    tick,
    isRunning: () => interval !== null
  };
}