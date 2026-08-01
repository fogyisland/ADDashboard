// metric-store.test.js — covers the four metric_* helper modules
// (gauge, counter, timeseries, status) against a mock db.
//
// Pattern: matches installed-packages.test.js — makeMockDb + per-test
// _addScript(match, result) to shape SQL responses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSql } from '../../src/db/sql.js';
import {
  metricGauge,
  metricCounter,
  metricTimeseries,
  metricStatus,
  metricStoreSql
} from '../../src/db/sql/metric-store.js';

function makeMockDb({ dialect = 'mysql' } = {}) {
  const calls = [];
  const scripts = [];
  function lookup(sql) {
    for (const s of scripts) {
      if (s.match.test(sql)) {
        if (typeof s.result === 'function') return s.result();
        return s.result;
      }
    }
    return { rows: [], affectedRows: 0, insertId: undefined };
  }
  return {
    dialect,
    sql: buildSql(dialect),
    async execute(sql, params = []) {
      calls.push({ sql, params: [...params] });
      return lookup(sql);
    },
    async query(sql, params = []) {
      calls.push({ sql, params: [...params] });
      return { rows: lookup(sql).rows };
    },
    async transaction(work) {
      return work({
        execute: async (sql, params = []) => {
          calls.push({ sql, params: [...params] });
          return lookup(sql);
        },
        query: async (sql, params = []) => {
          calls.push({ sql, params: [...params] });
          return { rows: lookup(sql).rows };
        }
      });
    },
    _calls: calls,
    _addScript(match, result) { scripts.push({ match, result }); }
  };
}

// ---- SQL registry shape ----

test('metricStoreSql: gauge upsert mysql uses ON DUPLICATE KEY UPDATE with 7 placeholders', () => {
  assert.match(metricStoreSql.gauge.upsert.mysql, /INSERT INTO metric_gauge/);
  assert.match(metricStoreSql.gauge.upsert.mysql, /ON DUPLICATE KEY UPDATE/);
  assert.strictEqual((metricStoreSql.gauge.upsert.mysql.match(/\?/g) || []).length, 7);
});

test('metricStoreSql: gauge upsert mssql uses MERGE', () => {
  assert.match(metricStoreSql.gauge.upsert.mssql, /MERGE INTO metric_gauge/i);
  assert.match(metricStoreSql.gauge.upsert.mssql, /ON t\.agent_id = s\.agent_id AND t\.metric_id = s\.metric_id/);
  assert.strictEqual((metricStoreSql.gauge.upsert.mssql.match(/\?/g) || []).length, 7);
});

test('metricStoreSql: counter upsert has 6 placeholders (no thresholds)', () => {
  assert.match(metricStoreSql.counter.upsert.mysql, /INSERT INTO metric_counter/);
  assert.strictEqual((metricStoreSql.counter.upsert.mysql.match(/\?/g) || []).length, 6);
  assert.match(metricStoreSql.counter.upsert.mssql, /MERGE INTO metric_counter/i);
  assert.strictEqual((metricStoreSql.counter.upsert.mssql.match(/\?/g) || []).length, 6);
});

test('metricStoreSql: timeseries.append has 6 placeholders', () => {
  assert.match(metricStoreSql.timeseries.append.mysql, /INSERT INTO metric_timeseries/);
  assert.strictEqual((metricStoreSql.timeseries.append.mysql.match(/\?/g) || []).length, 6);
});

test('metricStoreSql: status upsert has 5 placeholders', () => {
  assert.match(metricStoreSql.status.upsert.mysql, /INSERT INTO metric_status/);
  assert.strictEqual((metricStoreSql.status.upsert.mysql.match(/\?/g) || []).length, 5);
  assert.match(metricStoreSql.status.upsert.mssql, /MERGE INTO metric_status/i);
});

test('metricStoreSql: gauge listByAgent mysql uses parameterized WHERE clause', () => {
  const withMetric = metricStoreSql.gauge.list.mysql('?');
  assert.match(withMetric, /WHERE agent_id = \? AND metric_id = \?/);
  const withoutMetric = metricStoreSql.gauge.list.mysql(null);
  assert.match(withoutMetric, /WHERE agent_id = \?/);
  assert.doesNotMatch(withoutMetric, /AND metric_id/);
});

test('metricStoreSql: gauge listByAgent mssql mirrors the mysql shape', () => {
  const withMetric = metricStoreSql.gauge.list.mssql('?');
  assert.match(withMetric, /WHERE agent_id = \? AND metric_id = \?/);
  const withoutMetric = metricStoreSql.gauge.list.mssql(null);
  assert.match(withoutMetric, /WHERE agent_id = \?/);
  assert.doesNotMatch(withoutMetric, /AND metric_id/);
});

test('metricStoreSql: timeseries.list adds range filters conditionally', () => {
  const full = metricStoreSql.timeseries.list.mysql({ from: '?', to: '?' });
  assert.match(full, /agent_id = \? AND metric_id = \? AND ts >= \? AND ts <= \?/);
  const noRange = metricStoreSql.timeseries.list.mysql({});
  assert.match(noRange, /agent_id = \? AND metric_id = \?/);
  assert.doesNotMatch(noRange, /ts >=/);
  const fromOnly = metricStoreSql.timeseries.list.mysql({ from: '?' });
  assert.match(fromOnly, /ts >= \?/);
  assert.doesNotMatch(fromOnly, /ts <=/);
});

// ---- metricGauge ----

test('metricGauge.upsertLatest: passes agent/metric/ts/value + optional thresholds', async () => {
  const db = makeMockDb();
  db._addScript(/INSERT\s+INTO\s+metric_gauge/i, { rows: [], affectedRows: 1 });
  const ts = new Date('2026-01-01T00:00:00Z');
  await metricGauge.upsertLatest(db, {
    agentId: 'a1',
    metricId: 'cpu.usage',
    ts,
    value: 73.5,
    unit: '%',
    thresholdWarn: 75,
    thresholdCrit: 90
  });
  const call = db._calls[0];
  assert.match(call.sql, /INSERT INTO metric_gauge/);
  assert.equal(call.params[0], 'a1');
  assert.equal(call.params[1], 'cpu.usage');
  assert.equal(call.params[2], ts);
  assert.equal(call.params[3], 73.5);
  assert.equal(call.params[4], '%');
  assert.equal(call.params[5], 75);
  assert.equal(call.params[6], 90);
});

test('metricGauge.upsertLatest: missing unit/thresholds become null', async () => {
  const db = makeMockDb();
  db._addScript(/INSERT\s+INTO\s+metric_gauge/i, { rows: [], affectedRows: 1 });
  await metricGauge.upsertLatest(db, {
    agentId: 'a1',
    metricId: 'm',
    ts: new Date(),
    value: 1
  });
  const p = db._calls[0].params;
  assert.equal(p[4], null);
  assert.equal(p[5], null);
  assert.equal(p[6], null);
});

test('metricGauge.listByAgent: returns all metrics for an agent when metricId omitted', async () => {
  const db = makeMockDb();
  db._addScript(/FROM metric_gauge WHERE agent_id = \?/i, {
    rows: [
      { agent_id: 'a1', metric_id: 'cpu', value: 50 },
      { agent_id: 'a1', metric_id: 'mem', value: 70 }
    ],
    affectedRows: 0
  });
  const rows = await metricGauge.listByAgent(db, 'a1');
  assert.equal(rows.length, 2);
  assert.deepEqual(db._calls[0].params, ['a1']);
});

test('metricGauge.listByAgent: filters by metricId when provided', async () => {
  const db = makeMockDb();
  db._addScript(/FROM metric_gauge WHERE agent_id = \? AND metric_id = \?/i, {
    rows: [{ agent_id: 'a1', metric_id: 'cpu', value: 60 }],
    affectedRows: 0
  });
  const rows = await metricGauge.listByAgent(db, 'a1', { metricId: 'cpu' });
  assert.equal(rows.length, 1);
  assert.deepEqual(db._calls[0].params, ['a1', 'cpu']);
});

test('metricGauge.upsertLatest: mssql uses MERGE', async () => {
  const db = makeMockDb({ dialect: 'mssql' });
  db._addScript(/MERGE\s+INTO\s+metric_gauge/i, { rows: [], affectedRows: 1 });
  await metricGauge.upsertLatest(db, { agentId: 'a', metricId: 'm', ts: new Date(), value: 1 });
  assert.match(db._calls[0].sql, /MERGE INTO metric_gauge/i);
});

// ---- metricCounter ----

test('metricCounter.upsertLatest: passes 6 params (agent/metric/ts/value/delta/unit)', async () => {
  const db = makeMockDb();
  db._addScript(/INSERT\s+INTO\s+metric_counter/i, { rows: [], affectedRows: 1 });
  await metricCounter.upsertLatest(db, {
    agentId: 'a1',
    metricId: 'requests.total',
    ts: new Date(),
    value: 12345,
    delta: 100,
    unit: 'req'
  });
  const p = db._calls[0].params;
  assert.equal(p.length, 6);
  assert.equal(p[3], 12345);
  assert.equal(p[4], 100);
  assert.equal(p[5], 'req');
});

test('metricCounter.listByAgent: returns rows', async () => {
  const db = makeMockDb();
  db._addScript(/FROM metric_counter WHERE agent_id = \?/i, {
    rows: [{ agent_id: 'a1', metric_id: 'reqs', value: 100 }],
    affectedRows: 0
  });
  const rows = await metricCounter.listByAgent(db, 'a1');
  assert.equal(rows.length, 1);
});

// ---- metricTimeseries ----

test('metricTimeseries.append: stringifies tags and passes 6 params', async () => {
  const db = makeMockDb();
  db._addScript(/INSERT\s+INTO\s+metric_timeseries/i, { rows: [], affectedRows: 1 });
  await metricTimeseries.append(db, {
    agentId: 'a1',
    metricId: 'cpu.usage',
    ts: new Date(),
    value: 42.5,
    tags: { region: 'cn-east', host: 'h01' },
    unit: '%'
  });
  const p = db._calls[0].params;
  assert.equal(p.length, 6);
  assert.equal(p[4], JSON.stringify({ region: 'cn-east', host: 'h01' }));
  assert.equal(p[5], '%');
});

test('metricTimeseries.append: null tags stays null', async () => {
  const db = makeMockDb();
  db._addScript(/INSERT\s+INTO\s+metric_timeseries/i, { rows: [], affectedRows: 1 });
  await metricTimeseries.append(db, {
    agentId: 'a1',
    metricId: 'm',
    ts: new Date(),
    value: 1
  });
  assert.equal(db._calls[0].params[4], null);
});

test('metricTimeseries.list: throws when agentId/metricId missing', async () => {
  const db = makeMockDb();
  await assert.rejects(() => metricTimeseries.list(db, { agentId: 'a1' }), /agentId and metricId are required/);
  await assert.rejects(() => metricTimeseries.list(db, { metricId: 'm' }), /agentId and metricId are required/);
  await assert.rejects(() => metricTimeseries.list(db, {}), /agentId and metricId are required/);
});

test('metricTimeseries.list: builds WHERE with optional from/to range', async () => {
  const db = makeMockDb();
  db._addScript(/FROM metric_timeseries WHERE agent_id = \? AND metric_id = \? AND ts >= \? AND ts <= \?/i, {
    rows: [],
    affectedRows: 0
  });
  await metricTimeseries.list(db, {
    agentId: 'a1',
    metricId: 'cpu',
    from: new Date('2026-01-01'),
    to: new Date('2026-01-02')
  });
  const call = db._calls[0];
  assert.match(call.sql, /ts >= \? AND ts <= \?/);
  assert.equal(call.params.length, 4);
});

test('metricTimeseries.list: parses tags_json on returned rows', async () => {
  const db = makeMockDb();
  db._addScript(/FROM metric_timeseries/i, {
    rows: [{
      id: 1, agent_id: 'a1', metric_id: 'cpu',
      ts: new Date(), value: 50,
      tags_json: JSON.stringify({ region: 'cn-east' }),
      unit: '%'
    }],
    affectedRows: 0
  });
  const rows = await metricTimeseries.list(db, { agentId: 'a1', metricId: 'cpu' });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].tags, { region: 'cn-east' });
});

// ---- metricStatus ----

test('metricStatus.upsertLatest: passes 5 params including status/message', async () => {
  const db = makeMockDb();
  db._addScript(/INSERT\s+INTO\s+metric_status/i, { rows: [], affectedRows: 1 });
  await metricStatus.upsertLatest(db, {
    agentId: 'a1',
    metricId: 'svc.health',
    ts: new Date(),
    status: 'CRIT',
    message: 'replication lag > 60m'
  });
  const p = db._calls[0].params;
  assert.equal(p.length, 5);
  assert.equal(p[3], 'CRIT');
  assert.equal(p[4], 'replication lag > 60m');
});

test('metricStatus.upsertLatest: null message becomes null', async () => {
  const db = makeMockDb();
  db._addScript(/INSERT\s+INTO\s+metric_status/i, { rows: [], affectedRows: 1 });
  await metricStatus.upsertLatest(db, {
    agentId: 'a1',
    metricId: 'svc.health',
    ts: new Date(),
    status: 'OK'
  });
  assert.equal(db._calls[0].params[4], null);
});

test('metricStatus.listByAgent: filters by metricId when provided', async () => {
  const db = makeMockDb();
  db._addScript(/FROM metric_status WHERE agent_id = \? AND metric_id = \?/i, {
    rows: [{ agent_id: 'a1', metric_id: 'svc', status: 'OK' }],
    affectedRows: 0
  });
  const rows = await metricStatus.listByAgent(db, 'a1', { metricId: 'svc' });
  assert.equal(rows.length, 1);
  assert.deepEqual(db._calls[0].params, ['a1', 'svc']);
});

test('metricStatus.upsertLatest: mssql uses MERGE', async () => {
  const db = makeMockDb({ dialect: 'mssql' });
  db._addScript(/MERGE\s+INTO\s+metric_status/i, { rows: [], affectedRows: 1 });
  await metricStatus.upsertLatest(db, { agentId: 'a', metricId: 'm', ts: new Date(), status: 'OK' });
  assert.match(db._calls[0].sql, /MERGE INTO metric_status/i);
});
