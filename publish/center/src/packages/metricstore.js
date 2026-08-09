import { metricGauge, metricCounter, metricTimeseries, metricStatus } from '../db/sql/metric-store.js';
import { PkgError } from './errors.js';

export const metricstore = {
  async ingestRun(db, { agentId, packageName, manifest, runs }) {
    // v2 path: route to pkg_<name>.<metricTable>
    if (manifest.database?.metricTable) {
      return ingestRunV2(db, { agentId, packageName, manifest, runs });
    }
    // v1 path: existing 4-table switch
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

// ingestRunV2 — v2 package path: write agent-reported metrics into the
// package's own `pkg_<name>.<metricTable>`. The v1 `metric_*` tables are
// untouched for v2 packages.
//
// Algorithm (per agent-run posted to /api/agent/packages/report):
//   1. Resolve columns from manifest.database.metricSchema; agent_id + ts
//      are reserved and always prepended by the center (never taken from PS1
//      stdout, per the spec's trust model).
//   2. For each non-errored run:
//      a. Reject if metrics include keys outside the declared metricSchema
//         (PKG_METRIC_KEY_UNKNOWN).
//      b. Reject if a declared non-nullable column is missing/null
//         (PKG_METRIC_REQUIRED).
//      c. Reject if a DOUBLE/FLOAT/DECIMAL/NUMERIC column receives a
//         non-number (PKG_METRIC_TYPE_MISMATCH).
//      d. INSERT INTO `schemaName`.`metricTable` (agent_id, ts, <userCols>)
//         VALUES (?, ?, ...).
//
// Note: schema/table identifiers come from the installed manifest (validated
// by T3 ajv + T5 install DDL), not from any user-supplied runtime input.
async function ingestRunV2(db, { agentId, packageName, manifest, runs }) {
  const { schemaName, metricTable: table, metricSchema } = manifest.database;
  const columns = Object.keys(metricSchema);
  const userCols = columns.filter(c => c !== 'agent_id' && c !== 'ts');
  // Server clock — never from PS1 stdout.
  const ts = new Date();

  for (const run of runs) {
    if (run.error) continue;
    const data = run.metrics || {};

    const unknown = Object.keys(data).filter(k => !columns.includes(k));
    if (unknown.length) {
      throw new PkgError(
        'PKG_METRIC_KEY_UNKNOWN',
        `${packageName} metrics include unknown keys: ${unknown.join(',')}`
      );
    }

    for (const col of userCols) {
      const decl = metricSchema[col];
      const v = data[col];
      if (v == null) {
        if (decl.nullable === false) {
          throw new PkgError(
            'PKG_METRIC_REQUIRED',
            `${packageName} metric ${col} required`
          );
        }
      } else if (/^(double|float|decimal|numeric)/i.test(decl.type || '')) {
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          throw new PkgError(
            'PKG_METRIC_TYPE_MISMATCH',
            `${packageName} metric ${col} expected ${decl.type}, got ${typeof v}`
          );
        }
      }
    }

    const values = userCols.map(c => data[c]);
    const placeholders = userCols.map(() => '?').join(',');
    await db.execute(
      `INSERT INTO \`${schemaName}\`.${table} (agent_id, ts, ${userCols.join(',')}) VALUES (?, ?, ${placeholders})`,
      [agentId, ts, ...values]
    );
  }
}
