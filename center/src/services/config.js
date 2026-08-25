// System config service. Reads/writes key-value rows in `system_config`
// and exposes the agent-facing config bundle (polling, latency threshold,
// token).

import { getDb } from '../db/index.js';

// Sentinel returned to UI callers when the SMTP password is present. The UI
// sends this back on PUT to mean "keep the existing value" (matches the
// putConfig contract below).
export const SMTP_PASSWORD_MASK = '********';

// Mask smtp_password on read. Only masks a real (non-empty) value so the UI
// can tell the difference between "no password set" (empty/undefined) and
// "password set but hidden" (the sentinel).
export function maskSmtpPasswordForRead(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  if (cfg.smtp_password && cfg.smtp_password !== SMTP_PASSWORD_MASK) {
    return { ...cfg, smtp_password: SMTP_PASSWORD_MASK };
  }
  return cfg;
}

export async function getConfig() {
  const db = getDb();
  const { rows } = await db.query(db.sql.config.getAll);
  const out = {};
  for (const row of rows) out[row.config_key] = row.config_value;
  return maskSmtpPasswordForRead(out);
}

export async function getConfigMap() {
  const db = getDb();
  const { rows } = await db.query(db.sql.config.getAll);
  const out = {};
  for (const row of rows) out[row.config_key] = row.config_value;
  return out;
}

// Returns the subset of system_config rows whose key is in `keys`. Always
// masks smtp_password for callers that don't pass through getConfig()
// (e.g. the test-mail route, which needs the real password to call
// email.send() — but the mask contract is documented; this helper enforces
// it for callers that don't need the real value). Callers that DO need the
// real password should read system_config directly.
//
// With no keys argument, returns the full table filtered through the same
// mask. SQL pushes the WHERE clause when keys are supplied so we don't
// round-trip rows that won't be used; the no-arg shape still scans the full
// table (callers that want everything use getConfig() instead).
export async function getConfigAll(keys = []) {
  const db = getDb();
  let rows;
  if (keys.length > 0) {
    const placeholders = keys.map(() => '?').join(',');
    ({ rows } = await db.query(
      `SELECT config_key, config_value FROM system_config WHERE config_key IN (${placeholders})`,
      keys
    ));
  } else {
    ({ rows } = await db.query(db.sql.config.getAll));
  }
  const out = {};
  for (const row of rows) out[row.config_key] = row.config_value;
  return maskSmtpPasswordForRead(out);
}

export async function setConfig(key, value) {
  const db = getDb();
  // Per-key UPDATE kept inline (config table has only a few rows; one round-trip per key is fine).
  await db.execute(
    'UPDATE system_config SET config_value = ?, updated_at = CURRENT_TIMESTAMP WHERE config_key = ?',
    [value == null ? null : String(value), key]
  );
}

// Applies a patch (object of key→value) to system_config, preserving the
// existing smtp_password when the patch value is empty or the masked
// sentinel. Audit rows are written inside the same transaction so the
// config-audit list always reflects what changed. Returns {auditCount}.
//
// Matches the contract used by PUT /api/admin/config (see admin.js): the UI
// sends the masked sentinel back on re-saves so we don't overwrite a real
// password with '********' on a partial-form re-save.
//
// `userId` is the caller's user id (or null). It's recorded as changed_by on
// every audit row inside the same transaction so the audit list reflects who
// made each change.
export async function putConfig(patch, userId = null) {
  const db = getDb();
  const auditRows = await db.transaction(async (tx) => putConfigInTx(tx, patch, userId));
  return { auditCount: auditRows.length };
}

// Tx-scoped putConfig — exposed for callers that need to add work inside the
// same transaction (e.g. PUT /api/admin/config bumps the listenPort pending
// version hash atomically with the row update). Returns the audit rows.
export async function putConfigWithin(tx, patch, userId = null) {
  return putConfigInTx(tx, patch, userId);
}

// Core putConfig logic. Strips masked/empty smtp_password (preserve-existing
// contract), redacts the password on the audit row so cleartext never lands
// in sys_config_audit, and pushes the change-detection through the same tx
// the caller opened.
async function putConfigInTx(tx, patch, userId) {
  const updates = { ...patch };
  // Strip masked/empty smtp_password — the caller didn't intend to change it.
  if ('smtp_password' in updates) {
    if (!updates.smtp_password || updates.smtp_password === SMTP_PASSWORD_MASK) {
      delete updates.smtp_password;
    }
  }
  // Redact smtp_password from any audit row we write — the audit log stores
  // cleartext old_value/new_value by design, and T12 introduces the SMTP
  // password as a config value, so we must scrub it here to avoid persisting
  // credentials to sys_config_audit. The system_config row itself is updated
  // with the real value (the UI submitted it on purpose); only the audit
  // trail gets masked.
  const REDACTED = SMTP_PASSWORD_MASK;
  const auditRows = [];
  if (Object.keys(updates).length === 0) return auditRows;

  const db = getDb();
  const before = {};
  const { rows } = await tx.query(db.sql.config.getAll);
  for (const row of rows) before[row.config_key] = row.config_value;
  // #167 I1 Option B: reject legacy ad_agent_token writes. After I3
  // (dual-key agent-token rotation), the runtime source of truth is
  // `agent_token_current`, NOT the legacy `ad_agent_token` row that
  // ConfigView used to edit. Allowing PUT /api/admin/config to write
  // `ad_agent_token` was a dead-UI surface — operators saw their edit
  // succeed but the runtime auth never saw the new value. Operators
  // must now rotate via /api/admin/agent-token/rotate instead.
  //
  // The check fires only when the submitted value DIFFERS from the
  // current row — same-value writes (the UI sends back the entire
  // `current` object, including legacy rows it now displays as
  // read-only) are a no-op and don't need to trip the rejection. A
  // value-different write to a blocked key is what indicates an
  // operator actually tried to change it.
  const AGENT_TOKEN_BLOCKED_KEYS = ['ad_agent_token'];
  for (const k of AGENT_TOKEN_BLOCKED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(updates, k)) continue;
    const oldVal = before[k];
    const newVal = updates[k];
    if (String(oldVal ?? null) === String(newVal ?? null)) continue;
    throw Object.assign(
      new Error(
        `config key '${k}' is managed by /api/admin/agent-token/rotate ` +
        `(I3 dual-key rotation); legacy ConfigView UI is deprecated. ` +
        `Use curl -X POST <center>/api/admin/agent-token/rotate.`
      ),
      { httpStatus: 400, blockedKey: k }
    );
  }
  for (const [k, v] of Object.entries(updates)) {
    await tx.execute(
      db.sql.config.upsert,
      [k, v == null ? null : String(v)]
    );
    const oldVal = before[k] ?? null;
    const newVal = v == null ? null : String(v);
    if (String(oldVal) !== String(newVal)) {
      const auditOld = k === 'smtp_password' ? REDACTED : oldVal;
      const auditNew = k === 'smtp_password' ? REDACTED : newVal;
      await tx.execute(db.sql.config.audit.write, [k, auditOld, auditNew, userId, 'UPDATE']);
      auditRows.push({ key: k, old: auditOld, new: auditNew });
    }
  }
  return auditRows;
}

// Seed the SMTP-related defaults into system_config on first boot. Idempotent
// — when a row already exists (operator has touched it), the existing value
// is preserved. Each default only writes if the row is absent.
export async function seedSmtpDefaultsIfMissing(logger) {
  const db = getDb();
  const defaults = {
    smtp_host: '',
    smtp_port: '25',
    smtp_secure: 'false',
    smtp_user: '',
    smtp_password: '',
    smtp_from: '',
    alert_default_to: '',
    alert_default_cc: '',
    alert_eval_interval_seconds: '60',
    alert_email_max_attempts: '5',
    alert_email_initial_backoff_seconds: '30',
    // I4: audit retention policy. Default 90 days. Set to 0 to disable
    // (purgeOldAuditLogs treats <= 0 as "retention disabled" — see
    // services/audit.js). Read by createAuditRetentionLoop on every tick
    // so operators can change it without restarting the center.
    audit_retention_days: '90',
    // Client + agent access domain. Empty means "use server IP" — the
    // GET /api/admin/config response carries serverIp (from utils/network.js
    // getPrimaryIPv4()) so ConfigView can render the resolved URL. Operators
    // set this when they want a friendly hostname (e.g. dashboard.corp.com)
    // instead of the server's raw IP. Affects both client app access AND
    // the agent centerUrl row in ConfigView.
    access_domain: ''
  };
  const { rows } = await db.query(db.sql.config.getAll);
  const existing = new Set(rows.map(r => r.config_key));
  let seeded = 0;
  for (const [k, v] of Object.entries(defaults)) {
    if (existing.has(k)) continue;
    await db.execute(db.sql.config.upsert, [k, v]);
    seeded++;
  }
  if (seeded > 0) {
    logger?.info?.({ seeded, keys: Object.keys(defaults) }, 'seeded SMTP defaults into system_config');
  }
  return { seeded, keys: Object.keys(defaults) };
}

export async function setAgentToken(token) {
  const db = getDb();
  await db.execute(db.sql.config.setAgentToken, [token]);
}

export async function getAgentConfig() {
  const all = await getConfig();
  return {
    pollingIntervalMinutes: Number(all.polling_interval_minutes || 15),
    latencyThresholdMinutes: Number(all.latency_threshold_minutes || 180),
    heartbeatIntervalSeconds: Number(all.heartbeat_interval_seconds || 5),
    discoveryIntervalHours: Number(all.discovery_interval_hours || 1),
    agentToken: all.agent_token ?? null,
    heartbeatPort: Number(all.heartbeat_port) || 8081,
    reportPort: Number(all.report_port) || 8082,
    heartbeatStaleSeconds: Number(all.heartbeat_stale_seconds) || 15
  };
}

// Returns `{ listenPort: <bool> }` indicating whether the running center's
// bound web port is out of sync with what the operator saved via the UI.
//
// Two system_config rows drive the answer:
//   - center_listen_port_started_version: written by the bootstrap IIFE in
//     server.js immediately before buildServerApps, hashed from
//     `nowIso + ':' + listenPort`. Reflects the port currently bound.
//   - center_listen_port_pending_version: written by the PUT /api/admin/config
//     route inside the same transaction as the listenPort UPDATE; reflects
//     the value the operator just saved.
//
// When the operator saves a new listenPort, pending and started diverge.
// The ConfigView (Task 6) uses this to render a "重启生效" badge. We only
// report true when BOTH rows are present and differ — fresh installs (no
// pending save) and uncommitted changes return false so the badge stays
// quiet.
export async function restartRequired() {
  const db = getDb();
  const { rows } = await db.query(
    `SELECT config_key, config_value FROM system_config
     WHERE config_key IN ('center_listen_port_pending_version', 'center_listen_port_started_version')`
  );
  const map = Object.fromEntries(rows.map(r => [r.config_key, r.config_value]));
  const pending = map.center_listen_port_pending_version ?? null;
  const started = map.center_listen_port_started_version ?? null;
  return {
    listenPort: pending != null && started != null && pending !== started
  };
}