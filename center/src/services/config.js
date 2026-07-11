// System config service (MySQL).
// Reads/writes key-value rows in `system_config` and exposes the
// agent-facing config bundle (polling, latency threshold, token).

export async function getConfig(pool) {
  const [rows] = await pool.execute(`SELECT config_key, config_value FROM system_config`);
  const out = {};
  for (const row of rows) out[row.config_key] = row.config_value;
  return out;
}

export async function setConfig(pool, key, value) {
  await pool.execute(
    `UPDATE system_config SET config_value = ?, updated_at = CURRENT_TIMESTAMP WHERE config_key = ?`,
    [value == null ? null : String(value), key]
  );
}

export async function getAgentConfig(pool) {
  const all = await getConfig(pool);
  return {
    pollingIntervalMinutes: Number(all.polling_interval_minutes || 15),
    latencyThresholdMinutes: Number(all.latency_threshold_minutes || 180),
    agentToken: all.agent_token ?? null
  };
}