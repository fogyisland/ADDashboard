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

test('POST /api/admin/dcs-catalog/bulk-assign: 200 assigns site for each row; returns assigned count', async () => {
  const siteLookup = [];
  const assigns = [];
  const db = buildMockDb([
    { match: /SELECT\s+site_id\s+FROM\s+ad_sites\s+WHERE\s+site_name\s*=\s*\?/i, capture: true, rows: (params) => {
        siteLookup.push(params[0]);
        if (params[0] === 'Site-A') return [{ site_id: 11 }];
        if (params[0] === 'Site-B') return [{ site_id: 22 }];
        return [];
      }
    },
    { match: /UPDATE\s+ad_dcs\s+SET\s+site_id\s*=\s*\?\s+WHERE\s+dc_name\s*=\s*\?/i, capture: true, onExecute: (sql, params) => assigns.push({ type: 'assign', params }) }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .post('/api/admin/dcs-catalog/bulk-assign')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ rows: [
      { dcName: 'DC01', siteName: 'Site-A' },
      { dcName: 'DC02', siteName: 'Site-B' }
    ] });
  assert.equal(r.status, 200);
  assert.equal(r.body.assigned, 2);
  assert.equal(r.body.skipped, 0);
  assert.equal(assigns.length, 2);
  assert.deepEqual(assigns[0].params, [11, 'DC01']);
  assert.deepEqual(assigns[1].params, [22, 'DC02']);
});

test('POST /api/admin/dcs-catalog/bulk-assign: unbind when siteName empty (sets site_id NULL)', async () => {
  const unbinds = [];
  const assigns = [];
  const db = buildMockDb([
    { match: /SELECT\s+site_id\s+FROM\s+ad_sites\s+WHERE\s+site_name\s*=\s*\?/i, rows: [] },
    { match: /UPDATE\s+ad_dcs\s+SET\s+site_id\s*=\s*NULL\s+WHERE\s+dc_name\s*=\s*\?/i, capture: true, onExecute: (sql, params) => unbinds.push(params) },
    { match: /UPDATE\s+ad_dcs\s+SET\s+site_id\s*=\s*\?\s+WHERE\s+dc_name\s*=\s*\?/i, capture: true, onExecute: (sql, params) => assigns.push(params) }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .post('/api/admin/dcs-catalog/bulk-assign')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ rows: [{ dcName: 'DC01', siteName: '' }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.unassigned, 1);
  assert.equal(unbinds.length, 1);
  assert.deepEqual(unbinds[0], ['DC01']);
  assert.equal(assigns.length, 0);
});

test('POST /api/admin/dcs-catalog/bulk-assign: skips row when siteName not found; per-row error', async () => {
  const assigns = [];
  const db = buildMockDb([
    { match: /SELECT\s+site_id\s+FROM\s+ad_sites\s+WHERE\s+site_name\s*=\s*\?/i, rows: [] },
    { match: /UPDATE\s+ad_dcs\s+SET\s+site_id\s*=\s*\?\s+WHERE\s+dc_name\s*=\s*\?/i, capture: true, onExecute: (sql, params) => assigns.push(params) }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .post('/api/admin/dcs-catalog/bulk-assign')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ rows: [{ dcName: 'DC01', siteName: 'NONEXISTENT' }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.assigned, 0);
  assert.equal(r.body.skipped, 1);
  assert.equal(r.body.errors.length, 1);
  assert.equal(r.body.errors[0].rowIndex, 0);
  assert.match(r.body.errors[0].reason, /site.*not found|NONEXISTENT/i);
  assert.equal(assigns.length, 0);
});

test('POST /api/admin/dcs-catalog/bulk-assign: 401 without token', async () => {
  _setDbForTest(buildMockDb().standard());
  const r = await supertest(buildApp())
    .post('/api/admin/dcs-catalog/bulk-assign')
    .send({ rows: [{ dcName: 'DC01', siteName: 'X' }] });
  assert.equal(r.status, 401);
});