import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { adminRouter } from '../src/routes/admin.js';
import { signJwt } from '../src/auth/jwt.js';
import { _setDbForTest } from '../src/db/index.js';
import { buildMockDb } from './helpers/db-mock.js';

const SECRET = 'test-secret';
function adminToken() { return signJwt({ sub: 'u1', role: 'admin', permissions: ['*'] }, SECRET, 60); }
function buildApp() {
  const a = express(); a.use(express.json());
  return a.use(adminRouter({ config: { jwtSecret: SECRET }, logger: { info(){}, error(){}, warn(){}, debug(){} } }));
}

test('GET /api/admin/config/audit: 401 without token', async () => {
  _setDbForTest(buildMockDb().standard());
  const r = await supertest(buildApp()).get('/api/admin/config/audit');
  assert.equal(r.status, 401);
});

test('GET /api/admin/config/audit: 200 with admin token; returns array of rows', async () => {
  const db = buildMockDb([
    { match: /FROM\s+sys_config_audit/i, rows: [
      { id: 1, config_key: 'polling_interval_minutes', old_value: '5', new_value: '7', changed_by: 1, change_type: 'UPDATE', changed_at: '2026-08-05T10:00:00Z', changed_by_username: 'admin' },
      { id: 2, config_key: 'ad_agent_token', old_value: 'old', new_value: 'new', changed_by: 1, change_type: 'UPDATE', changed_at: '2026-08-05T10:01:00Z', changed_by_username: 'admin' }
    ] }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .get('/api/admin/config/audit')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
  assert.equal(r.body.length, 2);
  assert.equal(r.body[0].configKey, 'polling_interval_minutes');
  assert.equal(r.body[0].oldValue, '5');
  assert.equal(r.body[0].newValue, '7');
  assert.equal(r.body[0].changeType, 'UPDATE');
  assert.equal(r.body[0].changedByUsername, 'admin');
});
