// Tests for Task 5 — `listProbeStatus()` service helper + the
// GET /api/admin/heartbeat-report/probe endpoint.
//
// The service reads `probe_state` rows via `db.sql.probeState.getAll` and
// returns camelCase probe entries plus a 30 s stale sentinel:
//   - nowCenterProbeStale = (any row's last_probe_at > 30 s ago)
//                          OR (all rows have status='unknown' (boot window))
//
// The route wires it up under /api/admin/heartbeat-report/probe, gated by
// [userAuth, requirePerm('admin:users')] like the sibling admin endpoints.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import supertest from 'supertest';
import { heartbeatReportService } from '../src/services/heartbeat-report.js';
import { heartbeatReportRouter } from '../src/routes/heartbeat-report.js';
import { userAuth } from '../src/auth/user-auth.js';
import { requirePerm } from '../src/auth/rbac.js';
import { signJwt } from '../src/auth/jwt.js';
import { _setDbForTest } from '../src/db/index.js';
import { buildMockDb } from './helpers/db-mock.js';

const SECRET = 'test-secret';
function adminToken() { return signJwt({ sub: 'u1', role: 'admin', permissions: ['*'] }, SECRET, 60); }

function buildApp() {
  const a = express();
  a.use(express.json());
  return a.use(
    heartbeatReportRouter({
      requireAuth: userAuth({ secret: SECRET }),
      requirePerm
    })
  );
}

// Mock row fixture: snake_case columns from probeState.getAll.
function fakeProbeRow(overrides = {}) {
  const now = new Date();
  return {
    port_role: 'web',
    status: 'up',
    latency_ms: 5,
    last_probe_at: now,
    last_up_at: now,
    consecutive_failures: 0,
    ...overrides
  };
}

const PROBE_GETALL = /SELECT\s+port_role\s*,\s*status\s*,\s*latency_ms\s*,\s*last_probe_at\s*,\s*last_up_at\s*,\s*consecutive_failures\s+FROM\s+probe_state/i;

// --- listProbeStatus unit tests -------------------------------------------

test('listProbeStatus: returns 3 probe rows in fixed order with nowCenterProbeStale=false', async () => {
  const now = new Date();
  const db = buildMockDb([
    {
      match: PROBE_GETALL,
      rows: [
        fakeProbeRow({ port_role: 'web',      latency_ms: 3 }),
        fakeProbeRow({ port_role: 'heartbeat', latency_ms: 7 }),
        fakeProbeRow({ port_role: 'report',    latency_ms: 11 })
      ]
    }
  ]).standard();
  _setDbForTest(db);

  const out = await heartbeatReportService.listProbeStatus();
  assert.deepEqual(Object.keys(out.probes).sort(), ['heartbeat', 'report', 'web']);
  assert.equal(out.probes.web.status, 'up');
  assert.equal(out.probes.web.latencyMs, 3);
  assert.equal(out.probes.web.consecutiveFailures, 0);
  assert.equal(typeof out.probes.web.lastProbeAt, 'string');
  assert.equal(typeof out.probes.web.lastUpAt, 'string');
  assert.equal(out.nowCenterProbeStale, false);
});

test('listProbeStatus: returns nowCenterProbeStale=true when lastProbeAt > 30s ago', async () => {
  const sixtySecondsAgo = new Date(Date.now() - 60_000);
  const db = buildMockDb([
    {
      match: PROBE_GETALL,
      rows: [
        fakeProbeRow({ port_role: 'web',       last_probe_at: sixtySecondsAgo }),
        fakeProbeRow({ port_role: 'heartbeat',  last_probe_at: sixtySecondsAgo }),
        fakeProbeRow({ port_role: 'report',     last_probe_at: sixtySecondsAgo })
      ]
    }
  ]).standard();
  _setDbForTest(db);

  const out = await heartbeatReportService.listProbeStatus();
  assert.equal(out.nowCenterProbeStale, true);
});

test('listProbeStatus: returns nowCenterProbeStale=true when all rows status=unknown (boot)', async () => {
  const now = new Date();
  const db = buildMockDb([
    {
      match: PROBE_GETALL,
      rows: [
        fakeProbeRow({ port_role: 'web',       status: 'unknown', last_probe_at: now, last_up_at: null }),
        fakeProbeRow({ port_role: 'heartbeat', status: 'unknown', last_probe_at: now, last_up_at: null }),
        fakeProbeRow({ port_role: 'report',    status: 'unknown', last_probe_at: now, last_up_at: null })
      ]
    }
  ]).standard();
  _setDbForTest(db);

  const out = await heartbeatReportService.listProbeStatus();
  assert.equal(out.probes.web.status, 'unknown');
  assert.equal(out.probes.web.lastUpAt, null);
  assert.equal(out.nowCenterProbeStale, true);
});

// --- endpoint integration tests -------------------------------------------

test('GET /api/admin/heartbeat-report/probe: returns 200 with expected shape', async () => {
  const now = new Date();
  const db = buildMockDb([
    {
      match: PROBE_GETALL,
      rows: [
        fakeProbeRow({ port_role: 'web',       latency_ms: 4 }),
        fakeProbeRow({ port_role: 'heartbeat',  latency_ms: 8 }),
        fakeProbeRow({ port_role: 'report',     latency_ms: 12 })
      ]
    }
  ]).standard();
  _setDbForTest(db);

  const res = await supertest(buildApp())
    .get('/api/admin/heartbeat-report/probe')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body.probes).sort(), ['heartbeat', 'report', 'web']);
  assert.equal(typeof res.body.nowCenterProbeStale, 'boolean');
  assert.equal(res.body.nowCenterProbeStale, false);
  assert.equal(res.body.probes.heartbeat.latencyMs, 8);
});

test('GET /api/admin/heartbeat-report/probe: returns 401 without token', async () => {
  _setDbForTest(buildMockDb().standard());
  const res = await supertest(buildApp())
    .get('/api/admin/heartbeat-report/probe');
  assert.equal(res.status, 401);
});