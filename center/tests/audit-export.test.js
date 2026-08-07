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
const SAMPLE_ROW = {
  id: 1, user_id: 1, username: 'admin', action: 'login_failed',
  target: null, payload: '{"ip":"1.2.3.4"}',
  created_at: new Date('2026-08-06T10:00:00Z')
};

function exportDb(dialect = 'mysql') {
  return buildMockDb([
    {
      match: /FROM audit_logs/i, capture: true,
      onQuery: (sql) => {
        if (/COUNT/i.test(sql)) return { rows: [{ total: 1 }] };
        return { rows: [SAMPLE_ROW] };
      }
    }
  ], { dialect }).standard();
}

test('GET /api/admin/audit/export?format=json: returns application/json array, content-disposition matches audit-security-*.json', async () => {
  const db = buildMockDb([
    {
      match: /FROM audit_logs/i, capture: true,
      onQuery: (sql) => {
        if (/COUNT/i.test(sql)) return { rows: [{ total: 1 }] };
        return { rows: [SAMPLE_ROW] };
      }
    }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .get('/api/admin/audit/export?format=json&category=security')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /application\/json/);
  assert.match(r.headers['content-disposition'] || '', /attachment.*audit-security-.*\.json/);
  const body = JSON.parse(r.text);
  assert.ok(Array.isArray(body));
  assert.equal(body.length, 1);
  assert.equal(body[0].action, 'login_failed');
});

test('GET /api/admin/audit/export?format=json: MSSQL returns one row', async () => {
  _setDbForTest(exportDb('mssql'));
  const r = await supertest(buildApp())
    .get('/api/admin/audit/export?format=json&category=security')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.text).map(row => row.action), ['login_failed']);
});
test('GET /api/admin/audit/export?format=csv: header line + data rows, content-type text/csv', async () => {
  _setDbForTest(exportDb());
  const r = await supertest(buildApp())
    .get('/api/admin/audit/export?format=csv')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/csv/);
  const lines = r.text.trim().split('\n');
  assert.ok(lines.length >= 2);
  assert.match(lines[0], /时间.*用户.*动作.*目标.*严重性.*类别/);
  assert.match(lines[1], /登录失败/);
});

test('GET /api/admin/audit/export: 413 when count exceeds 50000', async () => {
  const db = buildMockDb([
    {
      match: /FROM audit_logs/i, capture: true,
      onQuery: (sql) => {
        if (/COUNT/i.test(sql)) return { rows: [{ total: 50001 }] };
        return { rows: [] };
      }
    }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .get('/api/admin/audit/export?format=json')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 413);
  assert.match(r.body.error, /50000|narrow|缩小/);
});

test('GET /api/admin/audit/export: invalid format returns 400', async () => {
  _setDbForTest(buildMockDb().standard());
  const r = await supertest(buildApp())
    .get('/api/admin/audit/export?format=xml')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 400);
});
