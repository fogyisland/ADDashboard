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

test('GET /api/admin/audit?category=security: returns rows with parsed payload + label/category/severity', async () => {
  let capturedSql = '', capturedParams = [];
  const db = buildMockDb([
    {
      match: /FROM audit_logs/i,
      capture: true,
      onQuery: (sql, params) => {
        capturedSql = sql; capturedParams = params;
        if (/COUNT/i.test(sql)) return { rows: [{ total: 1 }] };
        return { rows: [{ id: 1, user_id: 1, username: 'admin', action: 'login_failed', target: null, payload: '{"ip":"1.2.3.4"}', created_at: new Date() }] };
      }
    }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .get('/api/admin/audit?category=security&page=1&size=100')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.rows.length, 1);
  assert.equal(r.body.rows[0].action, 'login_failed');
  assert.equal(r.body.rows[0].actionLabel, '登录失败');
  assert.equal(r.body.rows[0].category, 'security');
  assert.equal(r.body.rows[0].severity, 'high');
  assert.deepEqual(r.body.rows[0].payload, { ip: '1.2.3.4' });
  assert.match(capturedSql, /action\s+IN\s*\(/);
  assert.ok(capturedParams.includes('login_failed'));
  assert.ok(capturedParams.includes('delete_user'));
});

test('GET /api/admin/audit: invalid category returns 400', async () => {
  _setDbForTest(buildMockDb().standard());
  const r = await supertest(buildApp())
    .get('/api/admin/audit?category=evil')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /category/i);
});

test('GET /api/admin/audit: userId / from / to compose into WHERE', async () => {
  let capturedSql = '', capturedParams = [];
  const db = buildMockDb([
    {
      match: /FROM audit_logs/i, capture: true,
      onQuery: (sql, params) => {
        capturedSql = sql; capturedParams = params;
        if (/COUNT/i.test(sql)) return { rows: [{ total: 0 }] };
        return { rows: [] };
      }
    }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .get('/api/admin/audit?userId=7&from=2026-08-01&to=2026-08-07')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.match(capturedSql, /user_id\s*=\s*\?/);
  assert.match(capturedSql, /created_at\s*>=\s*\?/);
  assert.match(capturedSql, /created_at\s*<=\s*\?/);
  assert.ok(capturedParams.includes(7));
  assert.ok(capturedParams.includes('2026-08-01'));
  assert.ok(capturedParams.includes('2026-08-07'));
});

test('GET /api/admin/audit: pagination binds semantic size/offset order for MySQL', async () => {
  let capturedParams = [];
  const db = buildMockDb([
    {
      match: /FROM audit_logs/i, capture: true,
      onQuery: (sql, params) => {
        capturedParams = params;
        if (/COUNT/i.test(sql)) return { rows: [{ total: 200 }] };
        return { rows: [] };
      }
    }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .get('/api/admin/audit?page=3&size=50')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.deepEqual(capturedParams.slice(-2), [50, 100]);
});

test('GET /api/admin/audit: MSSQL pagination binds offset then size', async () => {
  let capturedSql = '', capturedParams = [];
  const db = buildMockDb([
    {
      match: /FROM audit_logs/i, capture: true,
      onQuery: (sql, params) => {
        capturedSql = sql; capturedParams = params;
        if (/COUNT/i.test(sql)) return { rows: [{ total: 200 }] };
        return { rows: [] };
      }
    }
  ], { dialect: 'mssql' }).standard();
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .get('/api/admin/audit?page=3&size=50')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.match(capturedSql, /OFFSET \? ROWS FETCH NEXT \? ROWS ONLY/);
  assert.deepEqual(capturedParams.slice(-2), [100, 50]);
});

test('GET /api/admin/audit: payload column returns parsed JSON object', async () => {
  const db = buildMockDb([
    {
      match: /FROM audit_logs/i, capture: true,
      onQuery: (sql, params) => {
        if (/COUNT/i.test(sql)) return { rows: [{ total: 1 }] };
        return { rows: [{ id: 1, user_id: null, username: null, action: 'login', target: null, payload: '{"foo":42}', created_at: new Date() }] };
      }
    }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .get('/api/admin/audit')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(typeof r.body.rows[0].payload, 'object');
  assert.equal(r.body.rows[0].payload.foo, 42);
});

test('GET /api/admin/audit: malformed JSON payload returns null', async () => {
  const db = buildMockDb([
    {
      match: /FROM audit_logs/i, capture: true,
      onQuery: (sql) => {
        if (/COUNT/i.test(sql)) return { rows: [{ total: 1 }] };
        return { rows: [{ id: 1, user_id: null, username: null, action: 'login', target: null, payload: 'not-json{', created_at: new Date() }] };
      }
    }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .get('/api/admin/audit')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.rows[0].payload, null);
});

test('GET /api/admin/audit: severity filter expands to action IN-list', async () => {
  let capturedParams = [];
  const db = buildMockDb([
    {
      match: /FROM audit_logs/i, capture: true,
      onQuery: (sql, params) => {
        capturedParams = params;
        if (/COUNT/i.test(sql)) return { rows: [{ total: 0 }] };
        return { rows: [] };
      }
    }
  ]).standard();
  _setDbForTest(db);
  await supertest(buildApp())
    .get('/api/admin/audit?severity=high')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.ok(capturedParams.includes('login_failed'));
  assert.ok(capturedParams.includes('delete_user'));
});

test('GET /api/admin/audit: size > 100 returns 400', async () => {
  _setDbForTest(buildMockDb().standard());
  const r = await supertest(buildApp())
    .get('/api/admin/audit?size=500')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 400);
});

test('GET /api/admin/audit: 401 without token', async () => {
  _setDbForTest(buildMockDb().standard());
  const r = await supertest(buildApp()).get('/api/admin/audit');
  assert.equal(r.status, 401);
});

test('GET /api/admin/audit/badge?category=security: returns {category, count}', async () => {
  const db = buildMockDb([
    { match: /COUNT\(\*\)/i, capture: true, onQuery: () => ({ rows: [{ total: 42 }] }) }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .get('/api/admin/audit/badge?category=security')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { category: 'security', count: 42 });
});

test('GET /api/admin/audit/badge: invalid category returns 400', async () => {
  _setDbForTest(buildMockDb().standard());
  const r = await supertest(buildApp())
    .get('/api/admin/audit/badge?category=evil')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 400);
});