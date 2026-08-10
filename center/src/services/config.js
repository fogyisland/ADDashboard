// System config service. Reads/writes key-value rows in `system_config`
// and exposes the agent-facing config bundle (polling, latency threshold,
// token).

import { getDb } from '../db/index.js';

// SMTP-related config keys. Used by:
//   - getConfigAll(keys) for the test-mail route (avoids reading the full
//     system_config table when only a subset is needed)
//   - maskSmtpPasswordForRead() to redact the password on every read path
//     that returns the SMTP bundle to the UI or another caller
//   - putConfig() / the seedSmtpDefaultsIfMissing helper to preserve the
//     password when the UI submits the masked sentinel
const SMTP_KEYS = [
  'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_password', 'smtp_from',
  'alert_default_to', 'alert_default_cc',
  'alert_eval_interval_seconds',
  'alert_email_max_attempts', 'alert_email_initial_backoff_seconds'
];

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
export async function getConfigAll(keys = []) {
  const db = getDb();
  const { rows } = await db.query(db.sql.config.getAll);
  const out = {};
  const keySet = keys.length > 0 ? new Set(keys) : null;
  for (const row of rows) {
    if (keySet && !keySet.has(row.config_key)) continue;
    out[row.config_key] = row.config_value;
  }
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
export async function putConfig(patch) {
  const db = getDb();
  const updates = { ...patch };
  // Strip masked/empty smtp_password — the caller didn't intend to change it.
  if ('smtp_password' in updates) {
    if (!updates.smtp_password || updates.smtp_password === SMTP_PASSWORD_MASK) {
      delete updates.smtp_password;
    }
  }
  if (Object.keys(updates).length === 0) return { auditCount: 0 };

  const auditRows = [];
  await db.transaction(async (tx) => {
    const before = {};
    const { rows } = await tx.query(db.sql.config.getAll);
    for (const row of rows) before[row.config_key] = row.config_value;
    for (const [k, v] of Object.entries(updates)) {
      await tx.execute(
        'UPDATE system_config SET config_value = ?, updated_at = CURRENT_TIMESTAMP WHERE config_key = ?',
        [v == null ? null : String(v), k]
      );
      const oldVal = before[k] ?? null;
      const newVal = v == null ? null : String(v);
      if (String(oldVal) !== String(newVal)) {
        await tx.execute(db.sql.config.audit.write, [k, oldVal, newVal, null, 'UPDATE']);
        auditRows.push({ key: k, old: oldVal, new: newVal });
      }
    }
  });
  return { auditCount: auditRows.length };
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
    alert_email_initial_backoff_seconds: '30'
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
    discoveryIntervalHours: Number(all.discovery_interval_hours || 4),
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