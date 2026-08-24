// 2026-08-24 round-12 T5 — admin-initiated "report now" endpoint.
// POST /api/admin/agents/:agentId/request-report
//
// Auth gate: [userAuth, requirePerm('admin:users')] — same as the surrounding
// heartbeat-report routes. Calls heartbeatReportService.requestReport(agentId)
// (T3) and writes a `request_agent_report` audit row (T4 classifier).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { heartbeatReportRouter } from '../../src/routes/heartbeat-report.js';
import { signJwt } from '../../src/auth/jwt.js';
import { userAuth, invalidateJwtSecretCache } from '../../src/auth/user-auth.js';
import { requirePerm } from '../../src/auth/rbac.js';
import { buildMockDb } from '../helpers/db-mock.js';
import { _setDbForTest, getDb } from '../../src/db/index.js';

const SECRET = 'test-secret';

// The route factory expects { requireAuth, requirePerm } where requirePerm is
// a factory that builds the perm-check middleware (the route calls
// `requirePerm('admin:users')` internally). Pass the raw requirePerm factory
// from rbac.js, NOT its result. userAuth and the heartbeat-report service
// both reach the DB via getDb() — set it via _setDbForTest before each test.
function buildApp() {
  const a = express();
  a.use(express.json());
  a.use(heartbeatReportRouter({
    requireAuth: userAuth({ db: getDb(), logger: null }),
    requirePerm
  }));
  return a;
}

function adminToken() {
  return signJwt({ sub: 'u1', role: 'admin', permissions: ['*'] }, SECRET, 60);
}

function operatorToken() {
  return signJwt({ sub: 'u2', role: 'operator', permissions: ['dashboard:view'] }, SECRET, 60);
}

// userAuth runs BEFORE the route handler; its bundle SELECT and per-request
// auth-status SELECT must hit the mock or userAuth will 500 the request.
// buildMockDb's defaultQuery covers these when there are NO user scripts,
// but as soon as you provide scripts the fallthroughs are disabled. We
// merge the auth scripts with whichever heartbeat scripts the test needs.
const AUTH_SCRIPTS = [
  { match: /jwt_secret/i, rows: [{ config_key: 'jwt_secret_current', config_value: SECRET }] },
  { match: /sys_users/i, rows: [{ token_version: 0, status: 1 }] }
];

function hbDb(records, extraScripts = []) {
  return buildMockDb([...AUTH_SCRIPTS, ...extraScripts]).withRecording(records);
}

// _setDbForTest() between tests won't re-run the bundle SELECT because
// userAuth caches the JWT secret on first load. Invalidate the cache so
// each test sees fresh DB state.
test.beforeEach(() => invalidateJwtSecretCache());

// requestReport() issues three execute() calls:
//   1) SELECT 1 FROM ad_agent_heartbeat WHERE agent_id = ? LIMIT 1
//   2) SELECT report_requested_at FROM ad_agent_heartbeat WHERE agent_id = ? LIMIT 1
//   3) INSERT INTO ad_agent_heartbeat ... (the UPSERT — built by sql helpers)
//
// The first SELECT's `match` regex must distinguish "exists" vs "not found":
// we use a script that returns an empty array for the not-found case, and
// a positive row for the happy path.

test('POST /request-report returns 200 with shape { ok, agentId, requestedAt, alreadyPending } for admin', async () => {
  const records = [];
  const db = hbDb(records, [
    // (1) exists-check → return a row so AgentNotFoundError is not thrown.
    { match: /^SELECT\s+1\s+FROM\s+ad_agent_heartbeat/i, rows: [{}] },
    // (2) report_requested_at lookup → null (fresh install, first time requested).
    {
      match: /^SELECT\s+report_requested_at\s+FROM\s+ad_agent_heartbeat/i,
      rows: [{ report_requested_at: null }]
    }
    // (3) the UPSERT (via heartbeat.requestReport helper) → matched by default
    // mutation logic in buildMockDb (returns a single empty row + affectedRows=1).
  ]);
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .post('/api/admin/agents/KDLWXOFADSRV1/request-report')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.agentId, 'KDLWXOFADSRV1');
  assert.equal(r.body.alreadyPending, false);
  assert.match(r.body.requestedAt, /^\d{4}-\d{2}-\d{2}T/);
  // The UPSERT + the audit row should both have fired.
  const audits = records.filter(x => /audit/i.test(x.sql));
  assert.ok(audits.length >= 1, 'expected at least one audit row');
  const req = audits.find(a => a.params[1] === 'request_agent_report');
  assert.ok(req, 'expected request_agent_report action');
  assert.equal(req.params[2], 'agent:KDLWXOFADSRV1');
  assert.equal(req.params[0], 'u1');
});

test('POST /request-report returns 403 for operator (no admin:users perm)', async () => {
  // Auth scripts only — requirePerm fires before requestReport and 403s
  // without ever touching the heartbeat table.
  const records = [];
  _setDbForTest(hbDb(records, []));
  const app = buildApp();
  const r = await supertest(app)
    .post('/api/admin/agents/KDLWXOFADSRV1/request-report')
    .set('Authorization', `Bearer ${operatorToken()}`);
  assert.equal(r.status, 403);
});

test('POST /request-report returns 401 when no Authorization header', async () => {
  // userAuth rejects with 401 before any DB call when the header is missing.
  _setDbForTest(buildMockDb([]).standard());
  const app = buildApp();
  const r = await supertest(app)
    .post('/api/admin/agents/KDLWXOFADSRV1/request-report');
  assert.equal(r.status, 401);
});

test('POST /request-report returns 404 { error: agent_not_found } when agent is unknown', async () => {
  const records = [];
  // Force requestReport's exists-check to return zero rows. The second
  // SELECT + the UPSERT will never run because AgentNotFoundError throws
  // first; the regex for the first SELECT returns [].
  const db = hbDb(records, [
    { match: /^SELECT\s+1\s+FROM\s+ad_agent_heartbeat/i, rows: [] }
  ]);
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .post('/api/admin/agents/UNKNOWN/request-report')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 404);
  assert.deepEqual(r.body, { error: 'agent_not_found' });
  // Must NOT have written an audit row when the request never executed.
  const audits = records.filter(x => /audit/i.test(x.sql));
  assert.equal(audits.length, 0, 'no audit row should be written on 404');
});
