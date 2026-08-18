// e2e for the package-system + dashboard metric read path (Task 9).
//
// Goal: cover the end-to-end flow without a live DB. Mocks the db facade
// the same way as tests/packages/router.test.js (via buildMockDb) and
// spins up a fresh express app that wires the metricstore, the package
// admin router, and the dashboard router.
//
// Coverage:
//   - GET /api/dashboard/metrics/summary: shape + packageName/agentId filter
//   - GET /api/dashboard/metrics/timeseries: shape + metricId/agentId/from/to
//   - 401/403 wiring (no token / no read:dash perm)
//   - ingestRun → summary returns merged rows

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { dashboardRouter } from '../../src/routes/dashboard.js';
import { signJwt } from '../../src/auth/jwt.js';
import { _setDbForTest } from '../../src/db/index.js';
import { buildMockDb } from '../helpers/db-mock.js';
import { metricstore } from '../../src/packages/metricstore.js';

const SECRET = 'test-secret-please-do-not-use-in-prod';
const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

function buildApp() {
  const a = express();
  a.use(express.json());
  a.use(dashboardRouter({ config: { jwtSecret: SECRET }, logger: noopLogger }));
  return a;
}

function adminToken(extraPerms) {
  return signJwt(
    { sub: 'u1', role: 'admin', permissions: extraPerms ?? ['*'] },
    SECRET,
    60
  );
}

function noPermToken() {
  return signJwt({ sub: 'u2', role: 'viewer', permissions: ['read:something-else'] }, SECRET, 60);
}

function authHeader(perms) {
  // Default: admin token (wildcard '*') which short-circuits requirePerm.
  // Pass `null` to get the no-perm viewer token.
  const tok = perms === null ? noPermToken() : adminToken(perms);
  return { Authorization: `Bearer ${tok}` };
}

// ---- auth wiring -------------------------------------------------------

test('dashboard metrics summary: 401 when no token', async () => {
  _setDbForTest(buildMockDb().standard());
  const app = buildApp();
  const r = await supertest(app).get('/api/dashboard/metrics/summary');
  assert.equal(r.status, 401);
});

test('dashboard metrics summary: 403 when missing read:dash perm', async () => {
  _setDbForTest(buildMockDb().standard());
  const app = buildApp();
  const r = await supertest(app)
    .get('/api/dashboard/metrics/summary')
    .set('Authorization', `Bearer ${noPermToken()}`);
  assert.equal(r.status, 403);
});

test('dashboard metrics timeseries: 400 when metricId missing', async () => {
  _setDbForTest(buildMockDb().standard());
  const app = buildApp();
  const r = await supertest(app)
    .get('/api/dashboard/metrics/timeseries?agentId=a1')
    .set(authHeader());
  assert.equal(r.status, 400);
});

test('dashboard metrics timeseries: 400 when agentId missing', async () => {
  _setDbForTest(buildMockDb().standard());
  const app = buildApp();
  const r = await supertest(app)
    .get('/api/dashboard/metrics/timeseries?metricId=pkg.m')
    .set(authHeader());
  assert.equal(r.status, 400);
});

// ---- happy-path shape --------------------------------------------------

describe('GET /api/dashboard/metrics/summary', () => {
  test('returns { rows: [...] } shape with mixed gauge/counter/status', async () => {
    const db = buildMockDb([
      { match: /FROM\s+metric_gauge/i,   rows: [{ agent_id: 'a1', metric_id: 'p.m', value: 3 }] },
      { match: /FROM\s+metric_counter/i, rows: [{ agent_id: 'a1', metric_id: 'p.m', value: 42, delta: 5 }] },
      { match: /FROM\s+metric_status/i,  rows: [{ agent_id: 'a1', metric_id: 'p.m', status: 'OK' }] }
    ]).standard();
    _setDbForTest(db);
    const app = buildApp();
    const r = await supertest(app)
      .get('/api/dashboard/metrics/summary?metricId=p.m&agentId=a1')
      .set(authHeader());
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.rows), 'rows must be an array');
    assert.equal(r.body.rows.length, 3);
    const hasGauge = r.body.rows.some((x) => x.metric_id === 'p.m' && 'value' in x && !('status' in x));
    const hasCounter = r.body.rows.some((x) => x.delta === 5);
    const hasStatus = r.body.rows.some((x) => x.status === 'OK');
    assert.ok(hasGauge, 'gauge row present');
    assert.ok(hasCounter, 'counter row present');
    assert.ok(hasStatus, 'status row present');
  });

  test('packageName filter uses installed_packages to expand to metricIds', async () => {
    // When packageName is given, the route fetches installed_packages to
    // enumerate metric IDs and calls the helper per metric. We mock
    // installed_packages.get + the metric_* SELECTs.
    const manifest = {
      name: 'cpu-monitor',
      type: 'gauge',
      metrics: [{ key: 'm1', label: 'M1' }, { key: 'm2', label: 'M2' }]
    };
    const db = buildMockDb([
      { match: /FROM\s+installed_packages/i, rows: [{
          name: 'cpu-monitor',
          version: '1.0.0',
          type: 'gauge',
          manifest_json: JSON.stringify(manifest),
          enabled: 1,
          params_json: null,
          installed_at: new Date('2026-08-01'),
          updated_at: new Date('2026-08-01'),
          source: 'local'
        }] },
      { match: /FROM\s+metric_gauge/i,   rows: [] },
      { match: /FROM\s+metric_counter/i, rows: [] },
      { match: /FROM\s+metric_status/i,  rows: [] }
    ]).standard();
    _setDbForTest(db);
    const app = buildApp();
    const r = await supertest(app)
      .get('/api/dashboard/metrics/summary?packageName=cpu-monitor')
      .set(authHeader());
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.rows));
  });

  test('agentId filter is passed through to the helper', async () => {
    const db = buildMockDb([
      { match: /FROM\s+metric_gauge/i,   rows: [] },
      { match: /FROM\s+metric_counter/i, rows: [] },
      { match: /FROM\s+metric_status/i,  rows: [] }
    ]).standard();
    _setDbForTest(db);
    const app = buildApp();
    const r = await supertest(app)
      .get('/api/dashboard/metrics/summary?metricId=p.m&agentId=agent-7')
      .set(authHeader());
    assert.equal(r.status, 200);
    // Verify agent_id = ? was bound for every metric_* SELECT
    for (const call of db._calls || []) {
      if (/FROM\s+metric_(gauge|counter|status)/i.test(call.sql)) {
        assert.ok(call.params.includes('agent-7'),
          `expected agent_id=agent-7 bound for ${call.sql}`);
      }
    }
  });
});

describe('GET /api/dashboard/metrics/timeseries', () => {
  test('returns { points: [...] } shape with ts/value', async () => {
    const db = buildMockDb([
      { match: /FROM\s+metric_timeseries/i, rows: [
        { agent_id: 'a1', metric_id: 'p.m', ts: new Date('2026-01-01T00:00:00Z'), value: 1 },
        { agent_id: 'a1', metric_id: 'p.m', ts: new Date('2026-01-01T00:01:00Z'), value: 2 }
      ] }
    ]).standard();
    _setDbForTest(db);
    const app = buildApp();
    const r = await supertest(app)
      .get('/api/dashboard/metrics/timeseries?metricId=p.m&agentId=a1&from=2026-01-01T00:00:00Z&to=2026-01-01T00:05:00Z')
      .set(authHeader());
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.points));
    assert.equal(r.body.points.length, 2);
    assert.equal(r.body.points[0].value, 1);
    assert.ok(r.body.points[0].ts, 'ts must be ISO string');
  });

  test('rejects invalid from/to timestamp', async () => {
    const db = buildMockDb().standard();
    _setDbForTest(db);
    const app = buildApp();
    const r = await supertest(app)
      .get('/api/dashboard/metrics/timeseries?metricId=p.m&agentId=a1&from=not-a-date')
      .set(authHeader());
    assert.equal(r.status, 400);
  });
});

// ---- ingest → summary end-to-end --------------------------------------

// Helper: an in-memory mock db that captures INSERTs and replays them as
// SELECT results. Mirrors what a real SQL store would do for a single
// (agent, metric_id) round trip.
function makeInMemoryDb() {
  const gauges = [];      // { agent_id, metric_id, value, unit, threshold_warn, threshold_crit, ts }
  const counters = [];    // { agent_id, metric_id, value, delta, unit, ts }
  const statuses = [];    // { agent_id, metric_id, status, message, ts }
  const timeseries = [];  // { agent_id, metric_id, value, tags_json, unit, ts }
  const db = {
    dialect: 'mysql',
    sql: {},
    async execute(sql, params = []) {
      if (/INSERT\s+INTO\s+metric_gauge/i.test(sql)) {
        const [agent_id, metric_id, ts, value, unit, threshold_warn, threshold_crit] = params;
        const existing = gauges.find((g) => g.agent_id === agent_id && g.metric_id === metric_id);
        if (existing) {
          existing.ts = ts; existing.value = value; existing.unit = unit;
          existing.threshold_warn = threshold_warn; existing.threshold_crit = threshold_crit;
        } else {
          gauges.push({ agent_id, metric_id, ts, value, unit, threshold_warn, threshold_crit });
        }
        return { rows: [], affectedRows: 1 };
      }
      if (/INSERT\s+INTO\s+metric_counter/i.test(sql)) {
        const [agent_id, metric_id, ts, value, delta, unit] = params;
        const existing = counters.find((c) => c.agent_id === agent_id && c.metric_id === metric_id);
        if (existing) { existing.ts = ts; existing.value = value; existing.delta = delta; existing.unit = unit; }
        else counters.push({ agent_id, metric_id, ts, value, delta, unit });
        return { rows: [], affectedRows: 1 };
      }
      if (/INSERT\s+INTO\s+metric_status/i.test(sql)) {
        const [agent_id, metric_id, ts, status, message] = params;
        const existing = statuses.find((s) => s.agent_id === agent_id && s.metric_id === metric_id);
        if (existing) { existing.ts = ts; existing.status = status; existing.message = message; }
        else statuses.push({ agent_id, metric_id, ts, status, message });
        return { rows: [], affectedRows: 1 };
      }
      if (/INSERT\s+INTO\s+metric_timeseries/i.test(sql)) {
        const [agent_id, metric_id, ts, value, tags_json, unit] = params;
        timeseries.push({ agent_id, metric_id, ts, value, tags_json, unit });
        return { rows: [], affectedRows: 1 };
      }
      if (/SELECT\s+\*\s+FROM\s+metric_gauge/i.test(sql)) {
        const [metric_id, agent_id] = params;
        const rows = gauges.filter((g) =>
          (!metric_id || g.metric_id === metric_id) && (!agent_id || g.agent_id === agent_id)
        );
        return { rows };
      }
      if (/SELECT\s+\*\s+FROM\s+metric_counter/i.test(sql)) {
        const [metric_id, agent_id] = params;
        const rows = counters.filter((c) =>
          (!metric_id || c.metric_id === metric_id) && (!agent_id || c.agent_id === agent_id)
        );
        return { rows };
      }
      if (/SELECT\s+\*\s+FROM\s+metric_status/i.test(sql)) {
        const [metric_id, agent_id] = params;
        const rows = statuses.filter((s) =>
          (!metric_id || s.metric_id === metric_id) && (!agent_id || s.agent_id === agent_id)
        );
        return { rows };
      }
      if (/SELECT\s+\*\s+FROM\s+metric_timeseries/i.test(sql)) {
        const [metric_id, agent_id, from, to] = params;
        const rows = timeseries.filter((r) =>
          r.metric_id === metric_id && r.agent_id === agent_id &&
          (!from || r.ts >= from) && (!to || r.ts <= to)
        );
        return { rows };
      }
      return { rows: [], affectedRows: 0 };
    },
    async query(sql, params = []) { return this.execute(sql, params); },
    async transaction(work) { return work(this); },
    async healthcheck() {},
    async close() {}
  };
  return db;
}

describe('ingestRun → summary round trip', () => {
  test('ingested gauge row shows up in summary', async () => {
    const db = makeInMemoryDb();
    _setDbForTest(db);
    const manifest = {
      name: 'pkg1',
      type: 'gauge',
      metrics: [{ key: 'm1', label: 'M1', unit: '%', thresholds: { warn: 75, crit: 90 } }]
    };
    await metricstore.ingestRun(db, {
      agentId: 'agent-1',
      packageName: 'pkg1',
      manifest,
      runs: [{ metrics: { m1: 42 }, error: null }]
    });
    const rows = await metricstore.summary(db, { metricId: 'pkg1.m1', agentId: 'agent-1' });
    assert.ok(rows.length >= 1, 'summary should have at least one row');
    const gauge = rows.find((r) => 'value' in r && !('status' in r));
    assert.ok(gauge, 'gauge row present');
    assert.equal(Number(gauge.value), 42);
    assert.equal(gauge.metric_id, 'pkg1.m1');
  });

  test('ingested status row shows up in summary with status/message', async () => {
    const db = makeInMemoryDb();
    _setDbForTest(db);
    const manifest = {
      name: 'pkg2',
      type: 'status',
      metrics: [{ key: 'health', label: 'Health' }]
    };
    await metricstore.ingestRun(db, {
      agentId: 'agent-2',
      packageName: 'pkg2',
      manifest,
      runs: [{ metrics: { health: 'WARN', message: 'replication lag' }, error: null }]
    });
    const rows = await metricstore.summary(db, { metricId: 'pkg2.health', agentId: 'agent-2' });
    const statusRow = rows.find((r) => 'status' in r);
    assert.ok(statusRow, 'status row present');
    assert.equal(statusRow.status, 'WARN');
    assert.equal(statusRow.message, 'replication lag');
  });

  test('ingested timeseries points show up in timeseries query', async () => {
    const db = makeInMemoryDb();
    _setDbForTest(db);
    const manifest = {
      name: 'pkg3',
      type: 'timeseries',
      metrics: [{ key: 'lat', label: 'Latency', unit: 'ms' }]
    };
    // ingestRun uses one shared ts per call, so we run two separate ingests
    // to produce two distinct points.
    await metricstore.ingestRun(db, {
      agentId: 'agent-3',
      packageName: 'pkg3',
      manifest,
      runs: [{ metrics: { lat: 10 }, error: null }]
    });
    // small delay to get a different ts
    await new Promise((r) => setTimeout(r, 5));
    await metricstore.ingestRun(db, {
      agentId: 'agent-3',
      packageName: 'pkg3',
      manifest,
      runs: [{ metrics: { lat: 20 }, error: null }]
    });
    const all = await metricstore.timeseries(db, {
      metricId: 'pkg3.lat',
      agentId: 'agent-3',
      from: new Date(Date.now() - 60_000),
      to: new Date(Date.now() + 60_000)
    });
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((r) => Number(r.value)).sort(), [10, 20]);
  });
});
