// System config service. Reads/writes key-value rows in `system_config`
// and exposes the agent-facing config bundle (polling, latency threshold,
// token).

import { getDb } from '../db/index.js';

export async function getConfig() {
  const db = getDb();
  const { rows } = await db.query(db.sql.config.getAll);
  const out = {};
  for (const row of rows) out[row.config_key] = row.config_value;
  return out;
}

export async function getConfigMap() {
  const db = getDb();
  const { rows } = await db.query(db.sql.config.getAll);
  const out = {};
  for (const row of rows) out[row.config_key] = row.config_value;
  return out;
}

export async function setConfig(key, value) {
  const db = getDb();
  // Per-key UPDATE kept inline (config table has only a few rows; one round-trip per key is fine).
  await db.execute(
    'UPDATE system_config SET config_value = ?, updated_at = CURRENT_TIMESTAMP WHERE config_key = ?',
    [value == null ? null : String(value), key]
  );
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