// I9 — Task 5: 3 admin endpoints for the dual-key JWT secret rotation
// lifecycle. Mirrors the proven pattern from tests/routes/agent-token-rotate.test.js
// — real Express app + real adminRouter + real userAuth + supertest + signed JWT.
// The brief's literal code referenced a custom `call()` helper and `db.__calls`
// but the codebase has settled on `buildRecordingPool` + supertest, so we
// follow that established pattern (and gain the bonus of testing the auth chain).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { adminRouter } from '../../src/routes/admin.js';
import { signJwt } from '../../src/auth/jwt.js';
import { buildMockDb } from '../helpers/db-mock.js';
import { invalidateJwtSecretCache, _loadJwtSecretBundle } from '../../src/auth/user-auth.js';

// IMPORTANT: the userAuth middleware loads the JWT bundle from the mock db
// BEFORE our handler runs, and verifies our Bearer token against `current`.
// So the bundle's `jwt_secret_current` MUST equal the value we sign with.
// When a test overrides the bundle it must override with this same SECRET —
// or the auth middleware 401s before our handler ever fires.
const SECRET = 'test-secret';

// Sentinel value used by the "NEVER expose the secret" test. Still hex-shaped
// so it can pass for the auth check (which requires jwt_secret_current to
// match the value we signed the JWT with).
const SECRET_SENTINEL = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function buildApp(db) {
  const a = express();
  a.use(express.json());
  const config = { jwtSecret: SECRET };
  const logger = { info(){}, error(){}, warn(){}, debug(){} };
  a.use(adminRouter({ config, logger, db }));
  return a;
}

function tokenSignedWith(secret) {
  return signJwt({ sub: 'u1', role: 'admin', permissions: ['*'] }, secret, 60);
}

function adminToken() {
  return tokenSignedWith(SECRET);
}

function adminTokenWithSentinel() {
  return tokenSignedWith(SECRET_SENTINEL);
}

function operatorToken() {
  return signJwt({ sub: 'u2', role: 'operator', permissions: ['dashboard:view'] }, SECRET, 60);
}

// adminRouter uses requirePerm('admin:users') as its gate. Admin users get
// '*' which covers it; operator gets only dashboard:view.

test('POST /jwt-secret/rotate: returns 200 with new secret + rotatedAt for admin', async () => {
  const db = buildMockDb([{
    match: /jwt_secret/i,
    rows: [{ config_key: 'jwt_secret_current', config_value: SECRET }]
  }]).standard();
  const app = buildApp(db);
  // Reset cache between tests so each test sees a fresh bundle load.
  invalidateJwtSecretCache();
  const r = await supertest(app)
    .post('/api/admin/jwt-secret/rotate')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.match(r.body.newSecret, /^[a-f0-9]{64}$/);
  assert.match(r.body.rotatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('POST /jwt-secret/rotate: returns 403 for non-admin', async () => {
  const db = buildMockDb([]).standard();
  const app = buildApp(db);
  invalidateJwtSecretCache();
  const r = await supertest(app)
    .post('/api/admin/jwt-secret/rotate')
    .set('Authorization', `Bearer ${operatorToken()}`);
  assert.equal(r.status, 403);
});

test('POST /jwt-secret/rotate: writes audit row in same tx', async () => {
  const records = [];
  const db = buildMockDb([{
    match: /jwt_secret/i,
    rows: [{ config_key: 'jwt_secret_current', config_value: SECRET }]
  }]).withRecording(records);
  const app = buildApp(db);
  invalidateJwtSecretCache();
  await supertest(app)
    .post('/api/admin/jwt-secret/rotate')
    .set('Authorization', `Bearer ${adminToken()}`);
  const auditCalls = records.filter(c => /audit/i.test(c.sql));
  assert.ok(auditCalls.length >= 1, 'expected at least one audit row');
});

test('POST /jwt-secret/commit: returns 200 { ok:true } when previous is set', async () => {
  const records = [];
  const db = buildMockDb([{
    match: /jwt_secret/i,
    rows: [
      { config_key: 'jwt_secret_current', config_value: SECRET },
      { config_key: 'jwt_secret_previous', config_value: SECRET + '-PREV' }
    ]
  }]).withRecording(records);
  const app = buildApp(db);
  invalidateJwtSecretCache();
  const r = await supertest(app)
    .post('/api/admin/jwt-secret/commit')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  // Should have upserted previous=''
  const prev = records.find(x => x.params[0] === 'jwt_secret_previous');
  assert.equal(prev.params[1], '');
  // Should have written at least one audit row
  const auditCalls = records.filter(c => /audit/i.test(c.sql));
  assert.ok(auditCalls.length >= 1, 'expected at least one audit row when committing');
});

test('POST /jwt-secret/commit: no-op when no previous, no audit row', async () => {
  const records = [];
  const db = buildMockDb([{
    match: /jwt_secret/i,
    rows: [{ config_key: 'jwt_secret_current', config_value: SECRET }]
  }]).withRecording(records);
  const app = buildApp(db);
  invalidateJwtSecretCache();
  const r = await supertest(app)
    .post('/api/admin/jwt-secret/commit')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  const auditCalls = records.filter(c => /audit/i.test(c.sql));
  assert.equal(auditCalls.length, 0, 'no audit row on no-op commit');
});

test('GET /jwt-secret: returns mode/rotatedAt/ttlDays, NEVER the secret', async () => {
  // The sentinel value is intentionally distinctive and appears in the
  // bundle rows so we can assert the route's response body never contains
  // it (under any key, or in the serialized JSON). The signed JWT uses the
  // same sentinel — auth middleware compares against jwt_secret_current.
  const db = buildMockDb([{
    match: /jwt_secret/i,
    rows: [
      { config_key: 'jwt_secret_current', config_value: SECRET_SENTINEL },
      { config_key: 'jwt_secret_previous', config_value: 'aaaa' + SECRET_SENTINEL },
      { config_key: 'jwt_secret_rotated_at', config_value: '2026-08-01T00:00:00Z' },
      { config_key: 'jwt_secret_previous_ttl_days', config_value: '30' }
    ]
  }]).standard();
  const app = buildApp(db);
  invalidateJwtSecretCache();
  const r = await supertest(app)
    .get('/api/admin/jwt-secret')
    .set('Authorization', `Bearer ${adminTokenWithSentinel()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'dual');
  assert.equal(r.body.rotatedAt, '2026-08-01T00:00:00Z');
  assert.equal(r.body.ttlDays, 30);
  assert.ok(r.body.previousExpiresAt);
  // Body MUST NOT include the secret under any key
  assert.ok(!('current' in r.body), 'state endpoint must not expose current secret');
  assert.ok(!('previous' in r.body), 'state endpoint must not expose previous secret');
  assert.ok(!('newSecret' in r.body));
  assert.ok(!('secret' in r.body));
  // And the serialized body MUST NOT contain the sentinel value (neither
  // the current nor the previous sentinel substring).
  assert.ok(!JSON.stringify(r.body).includes(SECRET_SENTINEL),
    `response body must not leak the secret value; got: ${JSON.stringify(r.body)}`);
  assert.ok(!JSON.stringify(r.body).includes('aaaa' + SECRET_SENTINEL),
    `response body must not leak the previous secret value; got: ${JSON.stringify(r.body)}`);
});

test('GET /jwt-secret: mode=single when no previous', async () => {
  const db = buildMockDb([{
    match: /jwt_secret/i,
    rows: [{ config_key: 'jwt_secret_current', config_value: SECRET }]
  }]).standard();
  const app = buildApp(db);
  invalidateJwtSecretCache();
  const r = await supertest(app)
    .get('/api/admin/jwt-secret')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'single');
  assert.equal(r.body.rotatedAt, null);
  assert.equal(r.body.previousExpiresAt, null);
});

test('cache invalidation: rotate handler invalidates the userAuth cache', async () => {
  // Pre-warm the cache with a known bundle via a fake db.
  invalidateJwtSecretCache();
  const fakeDb = {
    sql: { config: { getJwtSecretBundle: 'SELECT config_key, config_value FROM system_config WHERE config_key IN (?)' } },
    query: async () => ({ rows: [{ config_key: 'jwt_secret_current', config_value: SECRET }] })
  };
  const before = await _loadJwtSecretBundle(fakeDb);
  assert.equal(before.current, SECRET);
  // Now hit rotate via the route — the handler must invalidateJwtSecretCache()
  // synchronously so the very next _loadJwtSecretBundle reads fresh from db.
  const db = buildMockDb([{
    match: /jwt_secret/i,
    rows: [{ config_key: 'jwt_secret_current', config_value: SECRET }]
  }]).standard();
  const app = buildApp(db);
  invalidateJwtSecretCache(); // reset so the route's auth load uses our mock db
  await supertest(app)
    .post('/api/admin/jwt-secret/rotate')
    .set('Authorization', `Bearer ${adminToken()}`);
  // After rotate the cache should be null. Loading from a FRESH db proves
  // we got fresh data (not a stale cache hit).
  const freshDb = {
    sql: { config: { getJwtSecretBundle: 'SELECT config_key, config_value FROM system_config WHERE config_key IN (?)' } },
    query: async () => ({ rows: [{ config_key: 'jwt_secret_current', config_value: 'FRESH-FRESH-FRESH-FRESH-FRESH-FRESH-FRESH-FRESH-FRESH-FRESH-FRESH-FRESH-FRESH-FRESH-FRESH-FRESH' }] })
  };
  const after = await _loadJwtSecretBundle(freshDb);
  assert.equal(after.current, 'FRESH-FRESH-FRESH-FRESH-FRESH-FRESH-FRESH-FRESH-FRESH-FRESH-FRESH-FRESH-FRESH-FRESH-FRESH-FRESH', 'rotate handler must invalidate the userAuth cache so the next load is fresh');
});