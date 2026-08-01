import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSql } from '../../src/db/sql.js';
import { metricstore } from '../../src/packages/metricstore.js';
import { metricGauge, metricCounter, metricTimeseries } from '../../src/db/sql/metric-store.js';

function makeMockDb() {
  const calls = [];
  const scripts = [];
  const db = {
    dialect: 'mysql',
    sql: buildSql('mysql'),
    async execute(sql, params = []) {
      calls.push({ sql, params: [...params] });
      for (const script of scripts) {
        if (script.match.test(sql)) return typeof script.result === 'function' ? script.result() : script.result;
      }
      return { rows: [], affectedRows: 1 };
    },
    _calls: calls,
    _addScript(match, result) { scripts.push({ match, result }); }
  };
  return db;
}

describe('metricstore', () => {
  test('ingestRun writes gauge from single run', async () => {
    const db = makeMockDb();
    const manifest = { name: 'pkg1', type: 'gauge', metrics: [{ key: 'm1', label: 'M1', unit: '%', thresholds: { warn: 75, crit: 90 } }] };
    await metricstore.ingestRun(db, { agentId: 'a1', packageName: 'pkg1', manifest, runs: [{ metrics: { m1: 80 }, error: null }] });
    const rows = [{ value: 80, metric_id: 'pkg1.m1' }];
    db._addScript(/metric_gauge/i, { rows });
    const result = await metricGauge.listByAgent(db, 'a1');
    assert.equal(result.length, 1);
    assert.equal(result[0].value, 80);
    assert.equal(result[0].metric_id, 'pkg1.m1');
  });

  test('summary returns latest per (agent, metric)', async () => {
    const db = makeMockDb();
    db._addScript(/FROM metric_gauge/i, { rows: [{ agent_id: 'a1', metric_id: 'p.m', value: 3 }] });
    const rows = await metricstore.summary(db, { metricId: 'p.m', agentId: 'a1' });
    assert.deepEqual(rows, [{ agent_id: 'a1', metric_id: 'p.m', value: 3 }]);
  });

  test('timeseries filters by range', async () => {
    const db = makeMockDb();
    db._addScript(/FROM metric_timeseries/i, { rows: [{ value: 2 }] });
    const rows = await metricstore.timeseries(db, { metricId: 'p.m', agentId: 'a1', from: new Date('2026-01-01'), to: new Date('2026-01-02') });
    assert.deepEqual(rows, [{ value: 2 }]);
  });

  test('counterHistory computes delta', async () => {
    const db = makeMockDb();
    db._addScript(/FROM metric_counter/i, { rows: [{ value: 10 }, { value: 16 }] });
    const result = await metricstore.counterHistory(db, { metricId: 'p.m', agentId: 'a1', window: '24h' });
    assert.equal(result.delta, 6);
    assert.equal(result.rows.length, 2);
  });
});
