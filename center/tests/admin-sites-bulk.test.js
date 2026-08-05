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

test('POST /api/admin/sites-catalog/bulk: 200 upserts all rows; returns imported count', async () => {
  const upserts = [];
  const db = buildMockDb([
    { match: /MERGE\s+INTO\s+ad_sites|INSERT\s+INTO\s+ad_sites/i, capture: true, onExecute: (sql, params) => upserts.push(params) }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .post('/api/admin/sites-catalog/bulk')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ rows: [
      { siteName: 'Site-A', regionCode: 'CN-North', isHub: 0, description: 'HQ' },
      { siteName: 'Site-B', regionCode: 'CN-South', isHub: 1, description: 'DR' }
    ] });
  assert.equal(r.status, 200);
  assert.equal(r.body.imported, 2);
  assert.equal(r.body.skipped, 0);
  assert.deepEqual(r.body.errors, []);
  assert.equal(upserts.length, 2);
  assert.deepEqual(upserts[0], ['Site-A', 'CN-North', 0, 'HQ']);
  assert.deepEqual(upserts[1], ['Site-B', 'CN-South', 1, 'DR']);
});

test('POST /api/admin/sites-catalog/bulk: skips row with empty siteName; per-row error reported', async () => {
  const upserts = [];
  const db = buildMockDb([
    { match: /MERGE\s+INTO\s+ad_sites|INSERT\s+INTO\s+ad_sites/i, capture: true, onExecute: (sql, params) => upserts.push(params) }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .post('/api/admin/sites-catalog/bulk')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ rows: [
      { siteName: '', regionCode: 'X', isHub: 0, description: '' },
      { siteName: 'Site-A', regionCode: 'X', isHub: 0, description: '' }
    ] });
  assert.equal(r.status, 200);
  assert.equal(r.body.imported, 1);
  assert.equal(r.body.skipped, 1);
  assert.equal(r.body.errors.length, 1);
  assert.equal(r.body.errors[0].rowIndex, 0);
  assert.match(r.body.errors[0].reason, /siteName/);
  assert.equal(upserts.length, 1);
});

test('POST /api/admin/sites-catalog/bulk: 400 on empty rows array', async () => {
  _setDbForTest(buildMockDb().standard());
  const r = await supertest(buildApp())
    .post('/api/admin/sites-catalog/bulk')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ rows: [] });
  assert.equal(r.status, 400);
});

test('POST /api/admin/sites-catalog/bulk: 401 without token', async () => {
  _setDbForTest(buildMockDb().standard());
  const r = await supertest(buildApp())
    .post('/api/admin/sites-catalog/bulk')
    .send({ rows: [{ siteName: 'X' }] });
  assert.equal(r.status, 401);
});