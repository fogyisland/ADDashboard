import { getDb } from '../db/index.js';
import {
  CATEGORY_ACTIONS, SEVERITY_ACTIONS, TARGET_LABEL, classifyAction
} from './audit-classifier.js';

// I7: payload cap — refuse to write audit rows whose payload JSON exceeds
// PAYLOAD_MAX_BYTES. Without a cap, a single bulk-import of 1000 sites
// produces an audit row whose payload alone is > 1 MB; audit_logs becomes
// the largest table in the DB and every listAudit query drags the giant
// TEXT/NVARCHAR(MAX) over the wire. Truncate at the cap, append a
// `_truncated: true` + `_truncatedOriginalBytes` marker so an operator
// reading the audit row can still see what was lost. The marker is small
// enough that the truncated row stays under the cap regardless of input.
export const PAYLOAD_MAX_BYTES = 16 * 1024; // 16 KB

function capPayload(payload) {
  if (payload == null) return null;
  const json = JSON.stringify(payload);
  if (json.length <= PAYLOAD_MAX_BYTES) return json;
  // The truncated row wraps the kept portion of `payload` in a marker so an
  // operator reading the audit row can see that data was lost and how much.
  // The marker itself takes some bytes — we work in absolute JSON length so
  // the final truncated string stays <= PAYLOAD_MAX_BYTES regardless of input.
  const marker = { _truncated: true, originalBytes: json.length };
  // Walk the parsed payload's keys, accumulating until the next key would
  // push the JSON over the cap. We re-stringify the full probe on each
  // iteration rather than tracking a delta so the budget check is exact
  // (Object.assign / spread cost is small — N stops at <100 keys once the
  // payload is over 16 KB).
  let parsed;
  try { parsed = JSON.parse(json); } catch { parsed = null; }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    // Primitive, array, or unparseable — slice the JSON string at the budget
    // boundary. Not strictly valid JSON mid-escape, but the audit row is
    // already lossy and the parsePayload reader on read-back falls back to
    // returning whatever it can.
    const markerJson = JSON.stringify(marker);
    const sliced = json.slice(0, Math.max(0, PAYLOAD_MAX_BYTES - markerJson.length - 24));
    return JSON.stringify({ ...marker, truncatedData: sliced });
  }
  const out = { ...marker };
  for (const key of Object.keys(parsed)) {
    const probe = { ...out, [key]: parsed[key] };
    if (JSON.stringify(probe).length > PAYLOAD_MAX_BYTES) break;
    out[key] = parsed[key];
  }
  return JSON.stringify(out);
}

// Write one audit row. Pass `tx` to enroll the audit write in a caller's open
// transaction — the audit row will commit (or fail) atomically with the
// surrounding data writes. Without `tx`, the write uses the global db facade
// and is best-effort (caught + warn-logged). Used as best-effort for
// fire-and-forget events (login, login_failed, test-mail) and as atomic for
// data-mutating routes (config PUT, server-group membership diff, bulk
// import, agent self-register).
//
// I2: best-effort callers must NEVER see a rejection — writeAudit always
// resolves; the function returns void in both paths. tx callers see the
// throw so their tx rolls back atomically.
export async function writeAudit({ userId, action, target, payload }, logger, tx = null) {
  const conn = tx ?? getDb();
  try {
    await conn.execute(conn.sql.audit.write, [
      userId ?? null,
      action,
      target ?? null,
      capPayload(payload)
    ]);
  } catch (e) {
    if (logger) logger.warn({ err: e.message, action, target }, 'audit write failed (best-effort)');
    // Re-throw when called inside a tx so the caller's transaction rolls back
    // — silent audit loss is unacceptable when the surrounding data writes
    // are about to commit. Best-effort callers (no tx) swallow so a transient
    // audit-table hiccup doesn't take down login/heartbeat paths.
    if (tx) throw e;
  }
}

function buildWhere({ category, actions, severities, userId, from, to }) {
  const conds = [];
  const params = [];
  if (category) {
    const list = CATEGORY_ACTIONS.get(category);
    if (!list) throw Object.assign(new Error('invalid category'), { httpStatus: 400 });
    conds.push(`a.action IN (${list.map(() => '?').join(',')})`);
    params.push(...list);
  }
  if (Array.isArray(actions) && actions.length) {
    conds.push(`a.action IN (${actions.map(() => '?').join(',')})`);
    params.push(...actions);
  }
  if (Array.isArray(severities) && severities.length) {
    const list = severities.flatMap(s => SEVERITY_ACTIONS.get(s) ?? []);
    if (list.length) {
      conds.push(`a.action IN (${list.map(() => '?').join(',')})`);
      params.push(...list);
    }
  }
  if (Number.isInteger(userId)) { conds.push('a.user_id = ?'); params.push(userId); }
  if (from) { conds.push('a.created_at >= ?'); params.push(from); }
  if (to)   { conds.push('a.created_at <= ?'); params.push(to); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return { where, params };
}

function parsePayload(raw, logger) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (e) {
    logger?.warn?.({ err: e.message }, 'audit payload parse failed');
    return null;
  }
}

export async function listAudit({ category, actions, severities, userId, from, to, page = 1, size = 100 } = {}) {
  const db = getDb();
  const { where, params } = buildWhere({ category, actions, severities, userId, from, to });
  const { rows: countRows } = await db.query(`${db.sql.audit.count} ${where}`, params);
  const total = Number(countRows[0].total);
  const offset = (page - 1) * size;
  const listQuery = db.sql.audit.list(where);
  const listParams = listQuery.listParams(params, size, offset);
  const { rows } = await db.query(listQuery.sql, listParams);
  return {
    rows: rows.map(r => ({
      id: r.id,
      userId: r.userId,
      username: r.username ?? null,
      action: r.action,
      actionLabel: classifyAction(r.action).label,
      category: classifyAction(r.action).category,
      severity: classifyAction(r.action).severity,
      target: r.target,
      targetLabel: r.target ? (TARGET_LABEL.get(r.target) ?? r.target) : null,
      payload: parsePayload(r.payload),
      createdAt: r.createdAt
    })),
    total,
    filtered: total,
    page,
    size
  };
}

export async function getAuditBadge(category) {
  const list = CATEGORY_ACTIONS.get(category);
  if (!list) throw Object.assign(new Error('invalid category'), { httpStatus: 400 });
  const db = getDb();
  const { rows } = await db.query(db.sql.audit.badge(list), list);
  return Number(rows[0].total);
}

// I4: retention purge — delete audit_logs rows older than `retentionDays`.
// Returns the affected row count so the caller can log "purged N rows".
// No-op when retentionDays <= 0 (operator disabled retention). Best-effort:
// errors are warn-logged and swallowed so a transient DB hiccup doesn't take
// down the scheduler. Callers wire this into a setInterval at boot — see
// startAuditRetentionLoop in server.js.
export async function purgeOldAuditLogs(retentionDays, logger) {
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
    return { skipped: true, reason: 'retentionDays <= 0 (retention disabled)' };
  }
  const cutoff = new Date(Date.now() - retentionDays * 86400_000);
  const db = getDb();
  try {
    const { affectedRows } = await db.execute(db.sql.audit.purge, [cutoff]);
    return { skipped: false, deleted: Number(affectedRows ?? 0), cutoff: cutoff.toISOString() };
  } catch (e) {
    if (logger) logger.warn({ err: e.message, retentionDays }, 'audit retention purge failed (best-effort)');
    return { skipped: true, reason: e.message, deleted: 0 };
  }
}

// I4: retention loop factory. Mirrors the createProbeLoop / createEmailDeliveryLoop
// shape (Global Constraint #8): start() schedules a setInterval with an inFlight
// guard; tick() reads audit_retention_days from system_config and runs
// purgeOldAuditLogs; stop() clears the interval and waits for the in-flight tick
// so a shutdown can't strand a half-written DELETE.
//
// Cadence is hard-coded at 1 hour — retention is coarse-grained background work
// and doesn't need a per-tick interval knob. Operators tune the policy via
// system_config.audit_retention_days (default 90), not the cadence. To run a
// purge on demand (operator command, test), call `tick()` directly — it returns
// the same shape purgeOldAuditLogs returns.
//
// Caller responsibility: wire the loop into server.js AFTER the DB is ready and
// AFTER seedSmtpDefaultsIfMissing has had a chance to write the default. The
// 1-hour cadence means a fresh-install first tick fires ~60 minutes after
// startup, which is fine — the seed row is already present by then.
const AUDIT_RETENTION_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_AUDIT_RETENTION_DAYS = 90;

export function createAuditRetentionLoop({ getSystemConfig, logger }) {
  let interval = null;
  let inFlight = null;

  async function tick() {
    let days;
    try {
      const cfg = (await getSystemConfig?.()) || {};
      const raw = cfg.audit_retention_days;
      // Distinguish "missing" (operator hasn't configured — use default) from
      // "explicitly 0" (operator disabled retention — pass through to
      // purgeOldAuditLogs which treats <= 0 as disabled) from "non-numeric"
      // (operator typo — warn-log + use default).
      if (raw == null || raw === '') {
        days = DEFAULT_AUDIT_RETENTION_DAYS;
      } else {
        const n = Number(raw);
        if (Number.isInteger(n)) {
          days = n;
        } else {
          logger?.warn?.({ audit_retention_days: raw },
            'audit retention days is non-numeric, using default');
          days = DEFAULT_AUDIT_RETENTION_DAYS;
        }
      }
    } catch (e) {
      logger?.warn?.({ err: e.message }, 'audit retention loop: getSystemConfig failed (best-effort)');
      return { skipped: true, reason: `getSystemConfig failed: ${e.message}` };
    }
    return await purgeOldAuditLogs(days, logger);
  }

  function start() {
    if (interval) return;
    interval = setInterval(() => {
      inFlight = tick().catch((e) =>
        logger?.warn?.({ err: e.message }, 'audit retention tick failed (best-effort)')
      );
    }, AUDIT_RETENTION_INTERVAL_MS);
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