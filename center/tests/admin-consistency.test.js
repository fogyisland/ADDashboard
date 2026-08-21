// admin-consistency.test.js — route integration tests for Task 5's
// GET /api/admin/consistency endpoint.
//
// Auth wiring is the same [userAuth, requirePerm('admin:users')] chain used
// by every other route in adminRouter — these tests pin the 401/403/200
// contract end-to-end (no per-route auth decisions). Shape assertions lock
// the snake_case JSON output: consensus_hash / consensus_count /
// agent_count / outliers, with each outlier carrying agent_id / hash /
// collected_at.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { adminRouter } from '../src/routes/admin.js';
import { signJwt } from '../src/auth/jwt.js';
import { _setDbForTest } from '../src/db/index.js';
import { buildMockDb } from './helpers/db-mock.js';

const SECRET = 'test-secret';

function buildApp() {
  const a = express();
  a.use(express.json());
  const config = { jwtSecret: SECRET };
  const logger = { info(){}, error(){}, warn(){}, debug(){} };
  a.use(adminRouter({ config, logger }));
  return a;
}

function adminToken() {
  return signJwt(
    { sub: 'u1', role: 'admin', permissions: ['*'] },
    SECRET,
    60
  );
}

function operatorToken() {
  return signJwt(
    { sub: 'u2', role: 'operator', permissions: ['write:reports'] },
    SECRET,
    60
  );
}

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

function row(agent_id, { user_hash, group_hash, gpo_hash, ts }) {
  return {
    agent_id,
    ts,
    user_count:  user_hash  ? 100 : null,
    user_hash,
    group_count: group_hash ? 50  : null,
    group_hash,
    gpo_count:   gpo_hash   ? 10  : null,
    gpo_hash,
    error_code: 0
  };
}

// ----- AUTH WIRING -----

test('GET /api/admin/consistency: 401 when no token', async () => {
  _setDbForTest(buildMockDb().standard());
  const app = buildApp();
  const r = await supertest(app).get('/api/admin/consistency');
  assert.equal(r.status, 401);
});

test('GET /api/admin/consistency: 403 for operator token (missing admin:users perm)', async () => {
  _setDbForTest(buildMockDb().standard());
  const app = buildApp();
  const r = await supertest(app)
    .get('/api/admin/consistency')
    .set('Authorization', `Bearer ${operatorToken()}`);
  assert.equal(r.status, 403);
});

// ----- HAPPY PATH -----

test('GET /api/admin/consistency: 200 with snake_case shape (all-agree scenario)', async () => {
  const ts = new Date('2026-08-21T10:00:00Z');
  const latestRows = [
    row('dc-1', { user_hash: HASH_A, group_hash: HASH_B, gpo_hash: HASH_C, ts }),
    row('dc-2', { user_hash: HASH_A, group_hash: HASH_B, gpo_hash: HASH_C, ts }),
    row('dc-3', { user_hash: HASH_A, group_hash: HASH_B, gpo_hash: HASH_C, ts })
  ];
  const db = buildMockDb([
    { match: /pkg_ad_domain_consistency/i, rows: latestRows }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get('/api/admin/consistency')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  // Top-level keys are the 3 classes
  assert.deepEqual(Object.keys(r.body).sort(), ['gpos', 'groups', 'users']);
  // Each class has the spec'd snake_case shape
  for (const className of ['users', 'groups', 'gpos']) {
    const c = r.body[className];
    assert.equal(c.class, className);
    assert.equal(c.consensus_count, 3);
    assert.equal(c.agent_count, 3);
    assert.deepEqual(c.outliers, []);
  }
  assert.equal(r.body.users.consensus_hash, HASH_A);
  assert.equal(r.body.groups.consensus_hash, HASH_B);
  assert.equal(r.body.gpos.consensus_hash, HASH_C);
});

test('GET /api/admin/consistency: 200 with outlier in users, others agree', async () => {
  const ts = new Date('2026-08-21T10:00:00Z');
  const HASH_X = 'd'.repeat(64);
  const latestRows = [
    row('dc-1', { user_hash: HASH_A, group_hash: HASH_B, gpo_hash: HASH_C, ts }),
    row('dc-2', { user_hash: HASH_A, group_hash: HASH_B, gpo_hash: HASH_C, ts }),
    row('dc-3', { user_hash: HASH_X, group_hash: HASH_B, gpo_hash: HASH_C, ts })
  ];
  const db = buildMockDb([
    { match: /pkg_ad_domain_consistency/i, rows: latestRows }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get('/api/admin/consistency')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  // users: 2 agree + 1 differs → outlier list contains dc-3
  assert.equal(r.body.users.consensus_hash, HASH_A);
  assert.equal(r.body.users.consensus_count, 2);
  assert.equal(r.body.users.agent_count, 3);
  assert.equal(r.body.users.outliers.length, 1);
  assert.equal(r.body.users.outliers[0].agent_id, 'dc-3');
  assert.equal(r.body.users.outliers[0].hash, HASH_X);
  // groups + gpos unaffected
  assert.equal(r.body.groups.consensus_count, 3);
  assert.equal(r.body.gpos.consensus_count, 3);
  assert.deepEqual(r.body.groups.outliers, []);
});

test('GET /api/admin/consistency: 200 with empty metrics table → null/0/[]', async () => {
  const db = buildMockDb([
    { match: /pkg_ad_domain_consistency/i, rows: [] }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get('/api/admin/consistency')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  for (const className of ['users', 'groups', 'gpos']) {
    const c = r.body[className];
    assert.equal(c.class, className);
    assert.equal(c.consensus_hash, null);
    assert.equal(c.consensus_count, 0);
    assert.equal(c.agent_count, 0);
    assert.deepEqual(c.outliers, []);
  }
});

test('GET /api/admin/consistency: outlier shape uses snake_case keys', async () => {
  const ts = new Date('2026-08-21T10:00:00Z');
  const HASH_X = 'd'.repeat(64);
  const latestRows = [
    row('dc-1', { user_hash: HASH_A, group_hash: HASH_B, gpo_hash: HASH_C, ts }),
    row('dc-2', { user_hash: HASH_A, group_hash: HASH_B, gpo_hash: HASH_C, ts }),
    row('dc-3', { user_hash: HASH_X, group_hash: HASH_B, gpo_hash: HASH_C, ts })
  ];
  const db = buildMockDb([
    { match: /pkg_ad_domain_consistency/i, rows: latestRows }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get('/api/admin/consistency')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  const outlier = r.body.users.outliers[0];
  // Pin the snake_case outlier shape
  assert.deepEqual(Object.keys(outlier).sort(), ['agent_id', 'collected_at', 'hash']);
  // collected_at is ISO 8601
  assert.match(outlier.collected_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});
