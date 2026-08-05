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

test('POST /api/admin/config/rollback: reverts system_config and writes a ROLLBACK audit row', async () => {
  const executes = [];
  const db = buildMockDb([
    { match: /FROM\s+sys_config_audit\s+WHERE\s+id\s*=\s*\?/i, rows: [
      { id: 7, config_key: 'polling_interval_minutes', old_value: '5', new_value: '7', change_type: 'UPDATE' }
    ] },
    { match: /UPDATE\s+system_config/i, capture: true, onExecute: (sql, params) => executes.push({ sql, params }) },
    { match: /INSERT\s+INTO\s+sys_config_audit/i, capture: true, onExecute: (sql, params) => executes.push({ sql, params }) }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .post('/api/admin/config/rollback')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ auditId: 7 });
  assert.equal(r.status, 200);
  assert.equal(r.body.configKey, 'polling_interval_minutes');
  assert.equal(r.body.newValue, '5');
  // Expect 1 UPDATE system_config + 1 INSERT sys_config_audit
  assert.equal(executes.length, 2);
  const update = executes.find((e) => /UPDATE\s+system_config/i.test(e.sql));
  const insert = executes.find((e) => /INSERT\s+INTO\s+sys_config_audit/i.test(e.sql));
  assert.ok(update, 'system_config was updated');
  assert.ok(insert, 'rollback audit row was inserted');
  assert.equal(update.params[1], 'polling_interval_minutes');
  assert.equal(update.params[0], '5');
  assert.deepEqual(insert.params, ['polling_interval_minutes', '7', '5', 'u1', 'ROLLBACK']);
});

test('POST /api/admin/config/rollback: 404 when audit row not found', async () => {
  const db = buildMockDb([
    { match: /FROM\s+sys_config_audit\s+WHERE\s+id\s*=\s*\?/i, rows: [] }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .post('/api/admin/config/rollback')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ auditId: 999 });
  assert.equal(r.status, 404);
});

test('POST /api/admin/config/rollback: 400 when auditId missing', async () => {
  const db = buildMockDb().standard();
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .post('/api/admin/config/rollback')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({});
  assert.equal(r.status, 400);
});
