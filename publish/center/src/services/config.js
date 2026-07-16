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
    centerPublicHost: all.center_public_host ?? null,
    centerPublicPort: all.center_public_port ?? null
  };
}