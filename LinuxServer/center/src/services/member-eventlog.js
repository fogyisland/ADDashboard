// R158.78 (2026-10-12) — ad_member_eventlog_* post-hook + read helpers.
//
// Why this exists:
//   ad_member_eventlog_events + ad_member_eventlog_summary are MEMBER
//   tables (operator's "专表 ad_member_eventlog_*" directive). The
//   member_eventlog_collector v1.0.0 package manifest omits its
//   `database` block so the v2 metricstore path never runs (same
//   precedent as ad_eventlog_collector 1.0.6 / R112). The runner
//   post-hook therefore writes to the member-eventlog tables directly.
//
// This module mirrors center/src/services/eventlog.js (R112 / R154 /
// R158.23) with one major divergence: hostname instead of dc_name,
// and a single 24h retention sweep (no 4h/24h split because the member
// fleet is much smaller than the DC fleet and a single sweep is enough
// for forensics + ops). Mirrors center/src/services/dc-overview.js
// (R110.A) and center/src/services/lockout.js (R107.1) for shape.
//
//   - dialect dispatch is BAKED INTO the SQL helpers
//     (db.sql.memberEventlog.* returns { sql, params } from the active
//     dialect), not in this module — keeps the service dialect-agnostic.
//   - per-record try/catch so one bad row doesn't fail the whole batch.
//   - returns { upserted, skipped, errors } summaries for the route log.
//
// Wire shape coming out of collect.ps1 (one package run per member-
// server per collection cycle): run.metrics carries an `events` array
// (per-event rows) AND a `summaries` array (per-(hostname,channel)
// counter rollups). The runner post-hook invokes upsertEvents +
// upsertSummaries in a single pass per package run.

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

function normalizeEvent(evt, fallbackHostname) {
  // R158.78 — member-server: field semantics are "hostname" (NOT dc_name).
  // collect.ps1 writes both `agent_id` and `hostname` in the wire envelope;
  // we accept either, prefer hostname when both are present.
  const hostname = pickField(evt, 'hostname') || pickField(evt, 'agentId', 'agent_id') || fallbackHostname || null;
  const agentId  = pickField(evt, 'agentId', 'agent_id') || hostname;
  if (!hostname) return null;

  const channel    = pickField(evt, 'channel');
  const severity   = pickField(evt, 'severity');
  const eventId    = pickField(evt, 'eventId', 'event_id');
  const recordId   = pickField(evt, 'recordId', 'record_id');
  const message    = pickField(evt, 'message');
  if (!channel || !severity || eventId == null || recordId == null || message == null) {
    return null;
  }

  return {
    agentId,
    hostname:  String(hostname),
    channel:   String(channel),
    severity:  String(severity),
    eventId:   Number(eventId),
    recordId:  Number(recordId),
    message:   String(message),
    collectedAt: asDate(pickField(evt, 'collectedAt', 'collected_at')),
    ts:          asDate(pickField(evt, 'ts'), asDate(null)),
    // R154 — audit_failure flag. PowerShell writes 1 for Security channel
    // events matching the 4625/4776 whitelist; 0 otherwise. Default to 0
    // when the field is missing (pre-1.0.0 packages — future-proofing).
    auditFailure: Number(pickField(evt, 'auditFailure', 'audit_failure')) || 0
  };
}

function normalizeSummary(s, fallbackHostname) {
  const hostname = pickField(s, 'hostname') || pickField(s, 'agentId', 'agent_id') || fallbackHostname || null;
  const agentId  = pickField(s, 'agentId', 'agent_id') || hostname;
  if (!hostname) return null;
  const channel = pickField(s, 'channel');
  if (!channel) return null;

  return {
    agentId,
    hostname: String(hostname),
    channel:  String(channel),
    warningCount:       Number(pickField(s, 'warningCount', 'warning_count'))         || 0,
    errorCount:         Number(pickField(s, 'errorCount', 'error_count'))             || 0,
    auditFailureCount:  Number(pickField(s, 'auditFailureCount', 'audit_failure_count')) || 0,
    droppedCount:       Number(pickField(s, 'droppedCount', 'dropped_count'))         || 0,
    collectedAt:        asDate(pickField(s, 'collectedAt', 'collected_at'))
  };
}

// ── events ──────────────────────────────────────────────────────────────
export async function upsertEvent(db, evt, fallbackHostname = null, log = null) {
  const normalized = normalizeEvent(evt, fallbackHostname);
  if (!normalized) {
    return { ok: false, reason: 'missing or malformed event fields' };
  }
  const built = db.sql.memberEventlog.upsertEvent(normalized);
  try {
    await db.execute(built.sql, built.params);
    return { ok: true, hostname: normalized.hostname, channel: normalized.channel };
  } catch (e) {
    log?.error?.({
      event: 'member_eventlog.upsert_event_failed',
      hostname: normalized.hostname,
      channel: normalized.channel,
      recordId: normalized.recordId,
      err: e?.message || String(e)
    }, 'member-eventlog event upsert failed');
    return { ok: false, reason: e?.message || String(e), hostname: normalized.hostname };
  }
}

export async function upsertEvents(db, events, fallbackHostname = null, log = null) {
  if (!Array.isArray(events)) {
    return { upserted: 0, skipped: 0, errors: [] };
  }
  let upserted = 0;
  let skipped = 0;
  const errors = [];
  for (let i = 0; i < events.length; i++) {
    try {
      const res = await upsertEvent(db, events[i], fallbackHostname, log);
      if (res.ok) {
        upserted++;
      } else if (res.reason === 'missing or malformed event fields') {
        skipped++;
      } else {
        errors.push({ index: i, hostname: res.hostname ?? null, error: res.reason });
      }
    } catch (e) {
      errors.push({ index: i, error: e?.message || String(e) });
    }
  }
  return { upserted, skipped, errors };
}

// ── summaries ───────────────────────────────────────────────────────────
export async function upsertSummary(db, summary, fallbackHostname = null, log = null) {
  const normalized = normalizeSummary(summary, fallbackHostname);
  if (!normalized) {
    return { ok: false, reason: 'missing hostname / channel' };
  }
  const built = db.sql.memberEventlog.upsertSummary(normalized);
  try {
    await db.execute(built.sql, built.params);
    return { ok: true, hostname: normalized.hostname, channel: normalized.channel };
  } catch (e) {
    log?.error?.({
      event: 'member_eventlog.upsert_summary_failed',
      hostname: normalized.hostname,
      channel: normalized.channel,
      err: e?.message || String(e)
    }, 'member-eventlog summary upsert failed');
    return { ok: false, reason: e?.message || String(e), hostname: normalized.hostname };
  }
}

export async function upsertSummaries(db, summaries, fallbackHostname = null, log = null) {
  if (!Array.isArray(summaries)) {
    return { upserted: 0, skipped: 0, errors: [] };
  }
  let upserted = 0;
  let skipped = 0;
  const errors = [];
  for (let i = 0; i < summaries.length; i++) {
    try {
      const res = await upsertSummary(db, summaries[i], fallbackHostname, log);
      if (res.ok) {
        upserted++;
      } else if (res.reason === 'missing hostname / channel') {
        skipped++;
      } else {
        errors.push({ index: i, hostname: res.hostname ?? null, channel: res.channel ?? null, error: res.reason });
      }
    } catch (e) {
      errors.push({ index: i, error: e?.message || String(e) });
    }
  }
  return { upserted, skipped, errors };
}

// ── reads (front-end driven) ────────────────────────────────────────────
// Latest summary row per (hostname, channel) within the retention window.
// Drives the /memberServer/eventlog first paint (3-channel counter grid).
export async function getLatestSummary(db, { sinceHours = 24 } = {}) {
  const built = db.sql.memberEventlog.latestSummary({ sinceHours });
  const { rows } = await db.execute(built.sql, built.params);
  return rows ?? [];
}

// Drill-down event list for one (hostname, channel[, severity]) tuple.
// severity is optional — null/empty disables that filter.
// auditOnly is a convenience over the audit_failure column (Security
// channel 4625/4776 events). Mirrors R112 queryEvents shape.
export async function queryEvents(db, { hostname, channel, severity = null, sinceHours = 24, limit = 200, auditOnly = false } = {}) {
  if (!hostname || !channel) {
    return [];
  }
  const built = db.sql.memberEventlog.queryEvents({ hostname, channel, severity, sinceHours, limit, auditOnly });
  const { rows } = await db.execute(built.sql, built.params);
  return rows ?? [];
}

// ── retention ───────────────────────────────────────────────────────────
// R158.101 (2026-10-13) — 24h hourly event log trend for the
//   /memberServer/eventlog line chart. Reshapes DB rows to camelCase.
//   3 channel fixed (System / Application / Security) per R158.78 member
//   spec; pivot happens client-side. Reuses eventlog.trend24h shape
//   (services/eventlog.js:231-248) so the chart code is generic
//   (channel instead of agentId) — same wire shape as /api/eventlog/trend.
export async function trend24h(db, { hours = 24 } = {}, log = null) {
  try {
    const built = db.sql.memberEventlog.trend24h({ hours });
    const { rows } = await db.execute(built.sql, built.params);
    return (rows || []).map((r) => ({
      channel:     r.channel,
      bucketStart: r.bucket_start,
      eventCount:  Number(r.event_count)
    }));
  } catch (e) {
    log?.error?.({
      event: 'member_eventlog.trend24h_failed',
      hours,
      err: e?.message || String(e)
    }, 'member-eventlog trend24h read failed');
    return [];
  }
}

// ── retention ───────────────────────────────────────────────────────────
// R158.78 — single 24h retention sweep (跟 R112 双 sweep 不同). Member
// fleet is small enough that one 24h sweep is enough for the 3
// channels; we don't need the 4h/24h split that R112's 5 channels
// (with 4h operational + 24h Security) require. Mirrors createAuditRetentionLoop
// shape (start/stop/tick/isRunning) so server.js can wire it uniformly
// alongside eventlogRetentionLoop.
export async function purgeOlderThan(db, { cutoffIso }, log = null) {
  const built = db.sql.memberEventlog.purgeOlderThan({ cutoffIso });
  const out = { eventsDeleted: 0, summaryDeleted: 0, errors: [] };
  try {
    const r = await db.execute(built.sqlEvents.sql, built.sqlEvents.params);
    out.eventsDeleted = r?.affectedRows ?? r?.rowCount ?? 0;
  } catch (e) {
    out.errors.push({ table: 'ad_member_eventlog_events', error: e?.message || String(e) });
    log?.error?.({ event: 'member_eventlog.purge_failed', table: 'ad_member_eventlog_events', err: e?.message }, 'member-eventlog events purge failed');
  }
  try {
    const r = await db.execute(built.sqlSummary.sql, built.sqlSummary.params);
    out.summaryDeleted = r?.affectedRows ?? r?.rowCount ?? 0;
  } catch (e) {
    out.errors.push({ table: 'ad_member_eventlog_summary', error: e?.message || String(e) });
    log?.error?.({ event: 'member_eventlog.purge_failed', table: 'ad_member_eventlog_summary', err: e?.message }, 'member-eventlog summary purge failed');
  }
  return out;
}

// Re-export for tests so the dispatch surface stays a single source of truth.
export { normalizeEvent, normalizeSummary };

// ── 24-hour retention loop factory ──────────────────────────────────────
//
// Mirrors createEventlogRetentionLoop shape (Global Constraint #8):
// start() schedules a setInterval with an inFlight guard; tick() runs
// a single purgeOlderThan sweep; stop() clears the interval and waits
// for the in-flight tick so a shutdown can't strand a half-written
// DELETE. Cadence is hard-coded at 1 hour — coarse-grained background
// work, no per-tick interval knob. To run a purge on demand (operator
// command, test), call `tick()` directly — it returns the same shape
// purgeOlderThan returns.
//
// R158.86 (2026-10-12) — operator directive "数据保留10天", 默认从 24h → 240h (10d).
// 跟 os_baseline 同 precedent: 1h cadence sweep, 10d retention.  3 channel
// 单独扫, 跟 R112 DC 端 4h/24h 双 sweep 不同 (member fleet 规模小, 1 sweep
// 够, R158.78 原话).
//
// R158.107 (2026-10-16) — 改读 ad_mgmt_retention_days (8 service 统一单点).
//   删 hard-coded 240h, 默认 30d. 0 = 永久保留 (return). member fleet 规模
//   小, 单 sweep 跟 R158.78 原话一致.
const MEMBER_EVENTLOG_RETENTION_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MEMBER_EVENTLOG_DEFAULT_RETENTION_DAYS = 30;

export function createMemberEventlogRetentionLoop({ db, getSystemConfig, logger }) {
  let interval = null;
  let inFlight = null;

  async function tick() {
    let days = MEMBER_EVENTLOG_DEFAULT_RETENTION_DAYS;
    try {
      const cfg = (await getSystemConfig?.()) || {};
      const raw = cfg.ad_mgmt_retention_days;
      const parsed = Number(raw);
      if (raw == null || raw === '') {
        days = MEMBER_EVENTLOG_DEFAULT_RETENTION_DAYS;
      } else if (Number.isFinite(parsed) && parsed <= 0) {
        return { skipped: true, reason: 'ad_mgmt_retention_days <= 0 (retention disabled)' };
      } else if (Number.isFinite(parsed) && parsed > 0) {
        days = Math.floor(parsed);
        // R158.X.99.32 (2026-10-19) — defensive floor guard
        if (days < 1) { return { skipped: true, reason: 'ad_mgmt_retention_days < 1 (defensive floor)' }; }
      } else {
        logger?.warn?.({ ad_mgmt_retention_days: raw },
          'member-eventlog retention days is non-numeric, using default');
        days = MEMBER_EVENTLOG_DEFAULT_RETENTION_DAYS;
      }
    } catch (e) {
      logger?.warn?.({ err: e.message }, 'member-eventlog retention: getSystemConfig failed (best-effort)');
      return { skipped: true, reason: `getSystemConfig failed: ${e.message}` };
    }
    const out = { eventsDeleted: 0, summaryDeleted: 0, errors: [], days };
    const cutoff = new Date(Date.now() - days * 86400_000);
    const result = await purgeOlderThan(db, { cutoffIso: cutoff }, logger);
    out.eventsDeleted  = result.eventsDeleted;
    out.summaryDeleted = result.summaryDeleted;
    out.errors         = result.errors;
    logger?.info?.({
      sweep: `member-eventlog ${days}d`,
      eventsDeleted: out.eventsDeleted,
      summaryDeleted: out.summaryDeleted,
      errorCount: out.errors.length
    }, 'member-eventlog retention sweep complete');
    return out;
  }

  function start() {
    if (interval) return;
    interval = setInterval(() => {
      inFlight = tick().catch((e) =>
        logger?.warn?.({ err: e?.message || String(e) }, 'member-eventlog retention tick failed (best-effort)')
      );
    }, MEMBER_EVENTLOG_RETENTION_INTERVAL_MS);
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
