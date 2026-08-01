import { metricGauge, metricCounter, metricTimeseries, metricStatus } from '../db/sql/metric-store.js';

export const metricstore = {
  async ingestRun(db, { agentId, packageName, manifest, runs }) {
    const metrics = manifest.metrics || [];
    const ts = new Date();
    for (const run of runs) {
      if (run.error) continue;
      const data = run.metrics || {};
      for (const m of metrics) {
        const value = data[m.key];
        if (value === undefined || value === null) continue;
        const metricId = `${packageName}.${m.key}`;
        switch (manifest.type) {
          case 'gauge':
            await metricGauge.upsertLatest(db, { agentId, metricId, ts, value, unit: m.unit ?? null, thresholdWarn: m.thresholds?.warn ?? null, thresholdCrit: m.thresholds?.crit ?? null });
            break;
          case 'counter': {
            const prev = await metricCounter.listByAgent(db, agentId, { metricId });
            const delta = prev.length ? Number(value) - Number(prev[0].value) : 0;
            await metricCounter.upsertLatest(db, { agentId, metricId, ts, value: Number(value), delta, unit: m.unit ?? null });
            break;
          }
          case 'timeseries':
            await metricTimeseries.append(db, { agentId, metricId, ts, value: Number(value), tags: data.tags || null, unit: m.unit ?? null });
            break;
          case 'status':
            await metricStatus.upsertLatest(db, { agentId, metricId, ts, status: String(value), message: data.message ?? null });
            break;
        }
      }
    }
  },

  async summary(db, { metricId, agentId } = {}) {
    const where = [];
    const params = [];
    if (metricId) { where.push('metric_id = ?'); params.push(metricId); }
    if (agentId) { where.push('agent_id = ?'); params.push(agentId); }
    const suffix = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const [gauges, counters, statuses] = await Promise.all([
      db.execute(`SELECT * FROM metric_gauge${suffix} ORDER BY agent_id, metric_id`, params),
      db.execute(`SELECT * FROM metric_counter${suffix} ORDER BY agent_id, metric_id`, params),
      db.execute(`SELECT * FROM metric_status${suffix} ORDER BY agent_id, metric_id`, params)
    ]);
    return [...gauges.rows, ...counters.rows, ...statuses.rows];
  },

  async timeseries(db, { metricId, agentId, from, to }) {
    const where = ['metric_id = ?', 'agent_id = ?', 'ts >= ?', 'ts <= ?'];
    const { rows } = await db.execute(`SELECT * FROM metric_timeseries WHERE ${where.join(' AND ')} ORDER BY ts ASC`, [metricId, agentId, from, to]);
    return rows;
  },

  async counterHistory(db, { metricId, agentId, window }) {
    const from = new Date(Date.now() - parseWindow(window));
    const { rows } = await db.execute('SELECT * FROM metric_counter WHERE metric_id = ? AND agent_id = ? AND ts >= ? ORDER BY ts ASC', [metricId, agentId, from]);
    const first = rows[0];
    const last = rows[rows.length - 1];
    return { rows, delta: first && last ? Number(last.value) - Number(first.value) : 0 };
  }
};

function parseWindow(window) {
  const match = /^(\d+)([smhd])$/.exec(window);
  if (!match) throw new Error(`invalid window: ${window}`);
  return Number(match[1]) * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]];
}
