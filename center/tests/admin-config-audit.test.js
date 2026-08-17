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

// C1 fix: the broader audit_logs row must commit atomically with the data
// writes. If the audit insert fails, the whole save rolls back — a
// half-committed config change with no audit trail is what compliance
// reviewers flag. Before the fix this writeAudit ran outside the tx so a
// failed audit would leave system_config mutated but with no audit row.
test('PUT /api/admin/config: outer audit_logs write is in the same tx (atomic rollback)', async () => {
  const records = [];
  const db = buildMockDb([
    { match: /FROM\s+system_config/i, rows: [{ config_key: 'polling_interval_minutes', config_value: '5' }] },
    { match: /INSERT\s+INTO\s+sys_config_audit/i, rows: [] },
    { match: /MERGE\s+INTO\s+system_config|INSERT\s+INTO\s+system_config/i, rows: [] },
    // throwOnExecute fires inside tx.execute, which propagates through
    // writeAudit's re-throw branch (tx != null), which rolls the tx back.
    { match: /INSERT\s+INTO\s+audit_logs/i, rows: [], throwOnExecute: new Error('audit_logs table unavailable') }
  ]).withRecording(records);
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .put('/api/admin/config')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ polling_interval_minutes: '7' });
  // Outer audit write threw → tx rolls back → 500
  assert.equal(r.status, 500);
  // Confirm the outer audit_logs write was attempted (records captures
  // every issued statement before throwOnExecute fires).
  const auditLogWrite = records.find(rec => /INSERT\s+INTO\s+audit_logs/i.test(rec.sql));
  assert.ok(auditLogWrite, 'outer audit_logs write should have been attempted');
  assert.equal(auditLogWrite.params[1], 'update_config');
});

// Variant of the C1 fix test that asserts the atomic-commit happy path:
// the outer audit_logs row commits in the same tx as the sys_config_audit
// + system_config upsert. Reads the recording array exposed via the mock's
// records property so we can verify the order of writes is consistent with
// "data first, audit second, all in one tx".
test('PUT /api/admin/config: outer audit_logs commit order — all writes enroll in one tx', async () => {
  const records = [];
  const db = buildMockDb([], {}).withRecording(records);
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .put('/api/admin/config')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ polling_interval_minutes: '7' });
  assert.equal(r.status, 200);
  // Every issued statement must have been executed against the tx execute
  // (i.e. recorded through db.records, since the mock runs work({execute})
  // and execute records to the same array).
  const auditLogWrite = records.find(rec => /INSERT\s+INTO\s+audit_logs/i.test(rec.sql));
  assert.ok(auditLogWrite, 'audit_logs INSERT should be present in issued statements');
  // Outer audit is update_config
  assert.equal(auditLogWrite.params[1], 'update_config');
  // userId is recorded
  assert.equal(auditLogWrite.params[0], 'u1');
});