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
//   target_user_name, subject_user_name, subject_domain, caller_computer_name
// (MySQL helper at sql.js:632; MSSQL MERGE helper at sql.js:1589 — both bind
// in the same order for the INSERT side, per R101 canonical pattern.)
const BIND_ORDER = [
  'occurredAt',
  'collectedAt',
  'agentId',
  'dcName',
  'eventRecordId',
  'targetUserName',
  'subjectUserName',
  'subjectDomain',
  'callerComputerName'
];

function pickField(evt, camelKey, snakeKey) {
  if (evt == null) return null;
  if (evt[camelKey] !== undefined && evt[camelKey] !== null) return evt[camelKey];
  if (evt[snakeKey] !== undefined && evt[snakeKey] !== null) return evt[snakeKey];
  return null;
}

function normalizeEvent(evt, fallbackAgentId) {
  // dc_name: explicit > evt.dcName > evt.dc_name > fallback (agentId).
  // In AD topology the agentId IS the DC hostname, so the fallback is the
  // canonical answer when collect.ps1 doesn't stamp dc_name.
  const dcName = pickField(evt, 'dcName', 'dc_name') || fallbackAgentId || null;
  const eventRecordId = pickField(evt, 'eventRecordId', 'event_record_id');
  if (eventRecordId === null || eventRecordId === undefined || eventRecordId === '') {
    return null; // dedupe key component missing — refuse to write a half-row
  }
  const occurredAtRaw = pickField(evt, 'occurredAt', 'occurred_at');
  const occurredAt = occurredAtRaw instanceof Date
    ? occurredAtRaw
    : new Date(occurredAtRaw || Date.now());
  return {
    agentId:           fallbackAgentId || null,
    dcName,
    eventRecordId,
    occurredAt,
    targetUserName:    pickField(evt, 'targetUserName', 'target_user_name'),
    subjectUserName:   pickField(evt, 'subjectUserName', 'subject_user_name'),
    subjectDomain:     pickField(evt, 'subjectDomain', 'subject_domain'),
    callerComputerName: pickField(evt, 'callerComputerName', 'caller_computer_name'),
    collectedAt:       new Date()
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
        dcName: pickField(evt, 'dcName', 'dc_name'),
        eventRecordId: pickField(evt, 'eventRecordId', 'event_record_id')
      }, 'lockout event upsert failed');
    }
  }
  return { upserted, skipped, errors };
}

// Re-export so routes/tests can introspect the dispatch without duplicating it.
export { normalizeEvent, bindParams };