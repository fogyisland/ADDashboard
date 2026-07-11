// System config service.
// Reads/writes key-value rows in `system_config` and exposes
// the agent-facing config bundle (polling, latency threshold, token).

export async function getConfig(pool) {
  const r = await pool.request().query(`SELECT config_key, config_value FROM system_config`);
  const out = {};
  for (const row of r.recordset) out[row.config_key] = row.config_value;
  return out;
}

export async function setConfig(pool, key, value) {
  const v = value == null ? null : String(value);
  await pool.request()
    .input('v', v)
    .input('k', key)
    .query(`UPDATE system_config SET config_value = @v, updated_at = GETUTCDATE() WHERE config_key = @k`);
}

export async function getAgentConfig(pool) {
  const all = await getConfig(pool);
  return {
    pollingIntervalMinutes: Number(all.polling_interval_minutes || 15),
    latencyThresholdMinutes: Number(all.latency_threshold_minutes || 180),
    agentToken: all.agent_token ?? null
  };
}