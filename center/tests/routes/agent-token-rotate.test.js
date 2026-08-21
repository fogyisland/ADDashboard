import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { adminRouter } from '../../src/routes/admin.js';
import { signJwt } from '../../src/auth/jwt.js';
import { buildMockDb } from '../helpers/db-mock.js';

// I9 — Task 1: see tests/e2e/plugin-system.test.js. Match the buildMockDb
// default jwt_secret_current='test-secret' so userAuth accepts our tokens.
const SECRET = 'test-secret';

function buildApp(db) {
  const a = express();
  a.use(express.json());
  const config = { jwtSecret: SECRET };
  const logger = { info(){}, error(){}, warn(){}, debug(){} };
  a.use(adminRouter({ config, logger, db }));
  return a;
}

function adminToken() {
  return signJwt({ sub: 'u1', role: 'admin', permissions: ['*'] }, SECRET, 60);
}

function operatorToken() {
  return signJwt({ sub: 'u2', role: 'operator', permissions: ['dashboard:view'] }, SECRET, 60);
}

// adminRouter uses requirePerm('admin:users') as its gate (per admin.js:54).
// Admin users get '*' which covers it; operator gets only dashboard:view.

test('POST /rotate returns 200 with new token for admin', async () => {
  const db = buildMockDb([{
    match: /agent_token/i,
    rows: [{ config_key: 'agent_token_current', config_value: 'OLD' }]
  }]).standard();
  const app = buildApp(db);
  const r = await supertest(app)
    .post('/api/admin/agent-token/rotate')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.match(r.body.newToken, /^[a-f0-9]{96}$/);
  assert.match(r.body.rotatedAt, /^\d{4}-\d{2}-\d{2}T/);
  // 2026-08-21: rotate now returns version (1 = initial rotate from version=0).
  // Confirmed via the service-level test that monotonic increments are
  // observed; here we only assert the field is present and is a number.
  assert.equal(typeof r.body.version, 'number');
  assert.ok(r.body.version >= 1);
});

test('POST /rotate returns 403 for non-admin', async () => {
  const db = buildMockDb([]).standard();
  const app = buildApp(db);
  const r = await supertest(app)
    .post('/api/admin/agent-token/rotate')
    .set('Authorization', `Bearer ${operatorToken()}`);
  assert.equal(r.status, 403);
});

test('POST /rotate writes audit row', async () => {
  const records = [];
  const db = buildMockDb([{
    match: /agent_token/i,
    rows: [{ config_key: 'agent_token_current', config_value: 'OLD' }]
  }]).withRecording(records);
  const app = buildApp(db);
  await supertest(app)
    .post('/api/admin/agent-token/rotate')
    .set('Authorization', `Bearer ${adminToken()}`);
  const audits = records.filter(x => /audit/i.test(x.sql));
  assert.ok(audits.length >= 1, 'expected at least one audit row');
});

test('POST /commit returns 200 and clears previous', async () => {
  const records = [];
  const db = buildMockDb([{
    match: /agent_token/i,
    rows: [
      { config_key: 'agent_token_current', config_value: 'NEW' },
      { config_key: 'agent_token_previous', config_value: 'OLD' }
    ]
  }]).withRecording(records);
  const app = buildApp(db);
  const r = await supertest(app)
    .post('/api/admin/agent-token/commit')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  // Should have upserted previous=''
  const prev = records.find(x => x.params[0] === 'agent_token_previous');
  assert.equal(prev.params[1], '');
});

test('GET /agent-token returns mode=single when no previous', async () => {
  const db = buildMockDb([{
    match: /agent_token/i,
    rows: [{ config_key: 'agent_token_current', config_value: 'A' }]
  }]).standard();
  const app = buildApp(db);
  const r = await supertest(app)
    .get('/api/admin/agent-token')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'single');
  assert.equal(r.body.rotatedAt, null);
  // 2026-08-21: GET /agent-token now returns `version` (so the modal can
  // render the serverVersion it last saw) — operator-facing TTL fields
  // are dropped.
  assert.equal(r.body.version, 0);
  // MUST NOT include the secret
  assert.equal(r.body.current, undefined);
  assert.equal(r.body.previous, undefined);
  assert.equal(r.body.newToken, undefined);
  // 2026-08-21: ttlDays + previousExpiresAt removed (INTERNAL_GRACE_MS is
  // hardcoded; no operator-set TTL).
  assert.equal(r.body.ttlDays, undefined);
  assert.equal(r.body.previousExpiresAt, undefined);
});

test('GET /agent-token returns mode=dual when previous is set + version', async () => {
  const db = buildMockDb([{
    match: /agent_token/i,
    rows: [
      { config_key: 'agent_token_current', config_value: 'NEW' },
      { config_key: 'agent_token_previous', config_value: 'OLD' },
      { config_key: 'agent_token_rotated_at', config_value: '2026-08-18T00:00:00.000Z' },
      { config_key: 'agent_token_version', config_value: '7' }
    ]
  }]).standard();
  const app = buildApp(db);
  const r = await supertest(app)
    .get('/api/admin/agent-token')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'dual');
  assert.equal(r.body.rotatedAt, '2026-08-18T00:00:00.000Z');
  assert.equal(r.body.version, 7);
  // Operator-facing TTL fields MUST NOT be present (the internal 5-min
  // grace is fixed, not surfaced for change).
  assert.equal(r.body.previousExpiresAt, undefined);
  assert.equal(r.body.ttlDays, undefined);
});

// GET /agent-token/reveal — operator-initiated read of the active agent
// auth token. Admin-only (admin:users perm, same gate as the other agent-
// token routes). Returns { token, revealedAt } on success. Every reveal
// writes a reveal_agent_token audit row (security/high per audit-classifier)
// so credential exposure leaves a trail.

test('GET /reveal returns 200 with token verbatim + version for admin', async () => {
  const db = buildMockDb([{
    match: /agent_token/i,
    rows: [
      { config_key: 'agent_token_current', config_value: 'LIVE-AGENT-TOKEN' },
      { config_key: 'agent_token_version', config_value: '7' }
    ]
  }]).standard();
  const app = buildApp(db);
  const r = await supertest(app)
    .get('/api/admin/agent-token/reveal')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.token, 'LIVE-AGENT-TOKEN');
  assert.match(r.body.revealedAt, /^\d{4}-\d{2}-\d{2}T/);
  // 2026-08-21: reveal now includes version so the 复制令牌 button can
  // stamp the operator's clipboard payload with the version they're seeing.
  assert.equal(r.body.version, 7);
});

test('GET /reveal returns 403 for non-admin', async () => {
  const db = buildMockDb([]).standard();
  const app = buildApp(db);
  const r = await supertest(app)
    .get('/api/admin/agent-token/reveal')
    .set('Authorization', `Bearer ${operatorToken()}`);
  assert.equal(r.status, 403);
});

test('GET /reveal writes reveal_agent_token audit row', async () => {
  const records = [];
  const db = buildMockDb([{
    match: /agent_token/i,
    rows: [{ config_key: 'agent_token_current', config_value: 'LIVE-TOK' }]
  }]).withRecording(records);
  const app = buildApp(db);
  const r = await supertest(app)
    .get('/api/admin/agent-token/reveal')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  const audits = records.filter(x => /audit/i.test(x.sql));
  assert.ok(audits.length >= 1, 'expected reveal_agent_token audit row');
  const reveal = audits.find(a => a.params[1] === 'reveal_agent_token');
  assert.ok(reveal, 'expected reveal_agent_token action');
  assert.equal(reveal.params[2], 'system_config');
});

// ----- /api/admin/agent-token/delivery (auto-delivery counter) -----
//
// 2026-08-21 UX redesign: read-only snapshot of every agent's last-reported
// agent_token_version, plus the server's current version. Powers the
// "已推送到 X / N 台 Agent" counter in the generate modal. The route joins
// getAgentTokenState (system_config) + tokenDeliveryList (ad_agent_heartbeat)
// in parallel.
//
// adminRouter is mounted WITHOUT a getDb()/db factory here — the production
// app uses getDb() from the singleton (set by boot via _setDbForTest or the
// real db/index.js). The route calls `getDb()` itself, so tests that need
// to control the heartbeat list must populate BOTH the agent-token bundle
// (via scripts) AND seed _setDbForTest for the tokenDeliveryList query.

// Tests for the delivery endpoint depend on getDb() returning a mock that
// supplies both the agent-token bundle (via buildMockDb scripts above) AND
// the heartbeat list. Since adminRouter's delivery route calls getDb() at
// request time, we need to swap the singleton via _setDbForTest. Build a
// merged mock that includes both scripts.
import { _setDbForTest, getDb } from '../../src/db/index.js';

function buildDeliveryDb({ bundleRows, agents }) {
  // NB: bundle regex must include `FROM system_config` so it does NOT
  // collide with the heartbeat SELECT (which contains `agent_token_version`
  // as a column name). The heartbeat regex must be checked first so the
  // script ordering does not silently pick up the bundle for the wrong
  // query — buildMockDb iterates scripts in declaration order.
  return buildMockDb([
    { match: /FROM\s+ad_agent_heartbeat/i, rows: agents },
    { match: /FROM\s+system_config[^]*agent_token_(current|previous|rotated_at|version)/i, rows: bundleRows }
  ]).standard();
}

test('GET /delivery returns serverVersion, total, delivered, and per-agent list', async () => {
  const bundleRows = [
    { config_key: 'agent_token_current', config_value: 'NEW-TOK' },
    { config_key: 'agent_token_version', config_value: '5' }
  ];
  const agents = [
    { agent_id: 'dc01', agent_token_version: 5, last_heartbeat_at: '2026-08-21T12:00:00Z' },
    { agent_id: 'dc02', agent_token_version: 5, last_heartbeat_at: '2026-08-21T12:00:05Z' },
    { agent_id: 'dc03', agent_token_version: 4, last_heartbeat_at: '2026-08-21T11:59:00Z' }
  ];
  const db = buildDeliveryDb({ bundleRows, agents });
  _setDbForTest(db);
  const app = buildApp(db);
  const r = await supertest(app)
    .get('/api/admin/agent-token/delivery')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.serverVersion, 5);
  assert.equal(r.body.total, 3);
  // 2 of 3 agents are on version 5 (delivered); dc03 is still on 4 (pending).
  assert.equal(r.body.delivered, 2);
  // Per-agent rows: agentId camelCase, reportedVersion numeric (not string),
  // lastSeenAt matches the heartbeat row.
  assert.deepEqual(r.body.agents, [
    { agentId: 'dc01', reportedVersion: 5, lastSeenAt: '2026-08-21T12:00:00Z' },
    { agentId: 'dc02', reportedVersion: 5, lastSeenAt: '2026-08-21T12:00:05Z' },
    { agentId: 'dc03', reportedVersion: 4, lastSeenAt: '2026-08-21T11:59:00Z' }
  ]);
  // MUST NOT include the secret anywhere in the response.
  assert.equal(r.body.newToken, undefined);
  assert.equal(r.body.current, undefined);
  assert.equal(r.body.token, undefined);
});

test('GET /delivery returns total=0 when no agents have heartbeat yet', async () => {
  const bundleRows = [
    { config_key: 'agent_token_current', config_value: 'NEW-TOK' },
    { config_key: 'agent_token_version', config_value: '1' }
  ];
  const db = buildDeliveryDb({ bundleRows, agents: [] });
  _setDbForTest(db);
  const app = buildApp(db);
  const r = await supertest(app)
    .get('/api/admin/agent-token/delivery')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.serverVersion, 1);
  assert.equal(r.body.total, 0);
  assert.equal(r.body.delivered, 0);
  assert.deepEqual(r.body.agents, []);
});

test('GET /delivery returns delivered=0 when all agents are on a stale version', async () => {
  // Server bumped to version 6, all 2 agents still reporting version 5 (the
  // previous rotate) — heartbeat hasn't fired since the bump. delivered=0
  // and the modal will keep polling until agents pick up.
  const bundleRows = [
    { config_key: 'agent_token_current', config_value: 'NEW-TOK' },
    { config_key: 'agent_token_version', config_value: '6' }
  ];
  const agents = [
    { agent_id: 'dc01', agent_token_version: 5, last_heartbeat_at: '2026-08-21T12:00:00Z' },
    { agent_id: 'dc02', agent_token_version: 5, last_heartbeat_at: '2026-08-21T12:00:05Z' }
  ];
  const db = buildDeliveryDb({ bundleRows, agents });
  _setDbForTest(db);
  const app = buildApp(db);
  const r = await supertest(app)
    .get('/api/admin/agent-token/delivery')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.serverVersion, 6);
  assert.equal(r.body.total, 2);
  assert.equal(r.body.delivered, 0);
});

test('GET /delivery returns 403 for non-admin', async () => {
  const db = buildDeliveryDb({
    bundleRows: [{ config_key: 'agent_token_current', config_value: 'X' }],
    agents: []
  });
  _setDbForTest(db);
  const app = buildApp(db);
  const r = await supertest(app)
    .get('/api/admin/agent-token/delivery')
    .set('Authorization', `Bearer ${operatorToken()}`);
  assert.equal(r.status, 403);
});

test('GET /delivery returns 500 when the heartbeat query throws (fail-soft server-side)', async () => {
  // Build a db where the token bundle is fine but the heartbeat query throws.
  // The route catches and returns 500 (NOT a 200 with empty data — the modal
  // needs to know the read failed so it can stop polling and surface a
  // network error to the operator).
  const db = buildMockDb([
    { match: /agent_token/i, rows: [
      { config_key: 'agent_token_current', config_value: 'X' },
      { config_key: 'agent_token_version', config_value: '1' }
    ] }
  ]).standard();
  // Override the heartbeat SELECT to throw — wrap the standard build so the
  // token bundle stays usable. Easiest path: replace db.query for ad_agent_heartbeat.
  const origQuery = db.query;
  db.query = async (sql, params) => {
    if (/FROM\s+ad_agent_heartbeat/i.test(sql)) {
      throw new Error('connection reset');
    }
    return origQuery(sql, params);
  };
  _setDbForTest(db);
  const app = buildApp(db);
  const r = await supertest(app)
    .get('/api/admin/agent-token/delivery')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 500);
  assert.equal(r.body.error, 'delivery list failed');
});

// Cleanup: ensure we don't leak _setDbForTest state into other tests.
test.afterEach(() => {
  // Best-effort: reset to a default empty mock so subsequent tests that
  // don't _setDbForTest themselves still have a defined getDb() shape.
  _setDbForTest(buildMockDb([]).standard());
});
