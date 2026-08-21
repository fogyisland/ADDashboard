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
  // MUST NOT include the secret
  assert.equal(r.body.current, undefined);
  assert.equal(r.body.previous, undefined);
  assert.equal(r.body.newToken, undefined);
});

test('GET /agent-token returns mode=dual when previous is set', async () => {
  const db = buildMockDb([{
    match: /agent_token/i,
    rows: [
      { config_key: 'agent_token_current', config_value: 'NEW' },
      { config_key: 'agent_token_previous', config_value: 'OLD' },
      { config_key: 'agent_token_rotated_at', config_value: '2026-08-18T00:00:00.000Z' },
      { config_key: 'agent_token_previous_ttl_days', config_value: '30' }
    ]
  }]).standard();
  const app = buildApp(db);
  const r = await supertest(app)
    .get('/api/admin/agent-token')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'dual');
  assert.equal(r.body.rotatedAt, '2026-08-18T00:00:00.000Z');
  assert.match(r.body.previousExpiresAt, /^\d{4}-\d{2}-\d{2}T/);
});

// GET /agent-token/reveal — operator-initiated read of the active agent
// auth token. Admin-only (admin:users perm, same gate as the other agent-
// token routes). Returns { token, revealedAt } on success. Every reveal
// writes a reveal_agent_token audit row (security/high per audit-classifier)
// so credential exposure leaves a trail.

test('GET /reveal returns 200 with token verbatim for admin', async () => {
  const db = buildMockDb([{
    match: /agent_token/i,
    rows: [{ config_key: 'agent_token_current', config_value: 'LIVE-AGENT-TOKEN' }]
  }]).standard();
  const app = buildApp(db);
  const r = await supertest(app)
    .get('/api/admin/agent-token/reveal')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.token, 'LIVE-AGENT-TOKEN');
  assert.match(r.body.revealedAt, /^\d{4}-\d{2}-\d{2}T/);
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
