// Tests for audit-aware PUT /api/admin/config (Task 8 of the config page
// save-button plan). The route must:
//   1. write one sys_config_audit row per changed key
//   2. skip audit rows when value is unchanged
//   3. roll back the transaction (return 500) if the audit insert fails

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

test('PUT /api/admin/config writes one audit row per changed key', async () => {
  const writes = [];
  const db = buildMockDb([
    { match: /FROM\s+system_config/i, rows: [
      { config_key: 'polling_interval_minutes', config_value: '5' },
      { config_key: 'ad_agent_token', config_value: 'old-token-1234567890' }
    ] },
    { match: /INSERT\s+INTO\s+sys_config_audit/i, capture: true, onExecute: (sql, params) => writes.push(params) }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .put('/api/admin/config')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ polling_interval_minutes: '7', ad_agent_token: 'old-token-1234567890' });
  assert.equal(r.status, 200);
  // only polling_interval_minutes changed; ad_agent_token unchanged → one audit row
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], ['polling_interval_minutes', '5', '7', 'u1', 'UPDATE']);
});

test('PUT /api/admin/config: no audit rows when nothing changes', async () => {
  const writes = [];
  const db = buildMockDb([
    { match: /FROM\s+system_config/i, rows: [
      { config_key: 'polling_interval_minutes', config_value: '5' }
    ] },
    { match: /INSERT\s+INTO\s+sys_config_audit/i, capture: true, onExecute: (sql, params) => writes.push(params) }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .put('/api/admin/config')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ polling_interval_minutes: '5' });
  assert.equal(r.status, 200);
  assert.equal(writes.length, 0);
});

test('PUT /api/admin/config: 500 on transaction failure', async () => {
  const db = buildMockDb([
    { match: /FROM\s+system_config/i, rows: [{ config_key: 'polling_interval_minutes', config_value: '5' }] },
    { match: /INSERT\s+INTO\s+sys_config_audit/i, throwOnExecute: new Error('boom') }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .put('/api/admin/config')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ polling_interval_minutes: '7' });
  assert.equal(r.status, 500);
});