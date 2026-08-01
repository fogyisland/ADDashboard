import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSql } from '../../src/db/sql.js';
import { metricstore } from '../../src/packages/metricstore.js';

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

function findCall(calls, predicate) {
  return calls.find(predicate);
}

describe('metricstore', () => {
  test('ingestRun writes gauge from single run', async () => {
    const db = makeMockDb();
    const manifest = {
      name: 'pkg1',
      type: 'gauge',
      metrics: [{ key: 'm1', label: 'M1', unit: '%', thresholds: { warn: 75, crit: 90 } }]
    };
    await metricstore.ingestRun(db, {
      agentId: 'a1',
      packageName: 'pkg1',
      manifest,
      runs: [{ metrics: { m1: 80 }, error: null }]
    });

    // Verify the actual INSERT/UPSERT into metric_gauge was issued with the
    // expected SQL shape and parameter binding. This is the production code
    // path (metricGauge.upsertLatest -> GAUGE_UPSERT_MYSQL), not a re-mock.
    const gaugeCall = findCall(
      db._calls,
      (c) => /INSERT\s+INTO\s+metric_gauge/i.test(c.sql)
    );
    assert.ok(gaugeCall, 'expected an INSERT INTO metric_gauge SQL call');
    assert.match(gaugeCall.sql, /ON DUPLICATE KEY/i);

    // Param order matches GAUGE_UPSERT_MYSQL:
    //   (agent_id, metric_id, ts, value, unit, threshold_warn, threshold_crit)
    const [agentId, metricId, _ts, value, unit, thresholdWarn, thresholdCrit] = gaugeCall.params;
    assert.equal(agentId, 'a1');
    assert.equal(metricId, 'pkg1.m1');
    assert.equal(value, 80);
    assert.equal(unit, '%');
    assert.equal(thresholdWarn, 75);
    assert.equal(thresholdCrit, 90);
    assert.ok(_ts instanceof Date, 'ts param should be a Date instance');
  });

  test('summary returns latest per (agent, metric)', async () => {
    const db = makeMockDb();
    // All three branches of the Promise.all must be exercised; otherwise the
    // counter/status SELECTs are dead code as far as tests are concerned.
    db._addScript(/FROM\s+metric_gauge/i, { rows: [{ agent_id: 'a1', metric_id: 'p.m', value: 3 }] });
    db._addScript(/FROM\s+metric_counter/i, { rows: [{ agent_id: 'a1', metric_id: 'p.m', value: 42 }] });
    db._addScript(/FROM\s+metric_status/i, { rows: [{ agent_id: 'a1', metric_id: 'p.m', status: 'OK' }] });

    const rows = await metricstore.summary(db, { metricId: 'p.m', agentId: 'a1' });

    // All three SELECTs should have been issued with the same WHERE clause
    // and the same bound params.
    const gaugeCall = findCall(db._calls, (c) => /FROM\s+metric_gauge/i.test(c.sql));
    const counterCall = findCall(db._calls, (c) => /FROM\s+metric_counter/i.test(c.sql));
    const statusCall = findCall(db._calls, (c) => /FROM\s+metric_status/i.test(c.sql));
    assert.ok(gaugeCall && counterCall && statusCall, 'all three metric_* SELECTs must be issued');

    for (const c of [gaugeCall, counterCall, statusCall]) {
      assert.match(c.sql, /metric_id\s*=\s*\?/);
      assert.match(c.sql, /agent_id\s*=\s*\?/);
      assert.deepEqual(c.params, ['p.m', 'a1']);
    }

    // Rows from all three sources should be merged in the return value.
    assert.equal(rows.length, 3);
    assert.deepEqual(rows, [
      { agent_id: 'a1', metric_id: 'p.m', value: 3 },
      { agent_id: 'a1', metric_id: 'p.m', value: 42 },
      { agent_id: 'a1', metric_id: 'p.m', status: 'OK' }
    ]);
  });

  test('timeseries filters by range', async () => {
    const db = makeMockDb();
    db._addScript(/FROM\s+metric_timeseries/i, { rows: [{ value: 2 }] });
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-01-02T00:00:00Z');
    const rows = await metricstore.timeseries(db, {
      metricId: 'p.m',
      agentId: 'a1',
      from,
      to
    });

    // Verify the SELECT was issued with the from/to params actually bound
    // (not just the WHERE clause present but with empty params).
    const call = findCall(db._calls, (c) => /FROM\s+metric_timeseries/i.test(c.sql));
    assert.ok(call, 'expected a SELECT FROM metric_timeseries SQL call');
    assert.match(call.sql, /ts\s*>=\s*\?/);
    assert.match(call.sql, /ts\s*<=\s*\?/);
    assert.deepEqual(call.params, ['p.m', 'a1', from, to]);

    assert.deepEqual(rows, [{ value: 2 }]);
  });

  test('counterHistory computes delta', async () => {
    const db = makeMockDb();
    db._addScript(/FROM\s+metric_counter/i, { rows: [{ value: 10 }, { value: 16 }] });
    const result = await metricstore.counterHistory(db, {
      metricId: 'p.m',
      agentId: 'a1',
      window: '24h'
    });
    assert.equal(result.delta, 6);
    assert.equal(result.rows.length, 2);
  });
});
