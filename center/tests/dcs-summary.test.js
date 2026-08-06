import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import supertest from 'supertest';
import { dcsRouter } from '../src/routes/dcs.js';
import { userAuth } from '../src/auth/user-auth.js';
import { requirePerm } from '../src/auth/rbac.js';
import { signJwt } from '../src/auth/jwt.js';
import { _setDbForTest } from '../src/db/index.js';
import { buildMockDb } from './helpers/db-mock.js';

const SECRET = 'test-secret';
function adminToken() { return signJwt({ sub: 'u1', role: 'admin', permissions: ['*'] }, SECRET, 60); }

function buildApp() {
  const a = express();
  a.use(express.json());
  return a.use(
    dcsRouter({
      requireAuth: userAuth({ secret: SECRET }),
      requirePerm
    })
  );
}

test('GET /api/dcs/summary returns empty array when no summary rows', async () => {
  // No script matches -> default empty rows for every query. pre-populated
  // routes for the DC-lookup join and partnersCount subquery also return [].
  _setDbForTest(buildMockDb().standard());
  const res = await supertest(buildApp())
    .get('/api/dcs/summary')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

test('GET /api/dcs/summary returns one row per DC from latestSummaryPerDc', async () => {
  const db = buildMockDb([
    {
      match: /SELECT\s+source_dc\s*,\s*users_count\s*,\s*groups_count\s*,\s*gpos_count\s*,\s*locked_count\s*,\s*collected_at\s+FROM\s*\(/is,
      rows: [
        { source_dc: 'DC01', users_count: 100, groups_count: 30, gpos_count: 5, locked_count: 2, collected_at: new Date('2026-08-06T10:00:00Z') },
        { source_dc: 'DC02', users_count: 110, groups_count: 31, gpos_count: 6, locked_count: 0, collected_at: new Date('2026-08-06T10:00:00Z') }
      ]
    },
    // DC-lookup join returns nothing — siteName falls back to null. PartnersCount
    // subquery also returns no rows, so each card's partnersCount stays 0.
    { match: /FROM\s+ad_dcs\s+d/i, rows: [] },
    { match: /COUNT\(\*\)\s+AS\s+c\s+FROM\s+ad_replication_status/i, rows: [{ c: 0 }] }
  ]).standard();
  _setDbForTest(db);

  const res = await supertest(buildApp())
    .get('/api/dcs/summary')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
  assert.equal(res.body[0].dcHost, 'DC01');
  assert.equal(res.body[0].usersCount, 100);
  assert.equal(res.body[0].groupsCount, 30);
  assert.equal(res.body[0].gposCount, 5);
  assert.equal(res.body[0].lockedCount, 2);
  assert.equal(res.body[0].partnersCount, 0);
  assert.equal(res.body[1].dcHost, 'DC02');
  assert.equal(res.body[1].lockedCount, 0);
});

test('GET /api/dcs/summary?siteId=1 filters out DCs not in that site', async () => {
  // The route calls latestSummaryPerDc, then a 2nd-pass join to ad_dcs to
  // resolve site_name + site_id, then filters client-side. We stage both
  // queries: latestSummary returns 2 DCs, the join returns site metadata
  // for DC01 only (siteId=1), and DC02 falls back to siteId=2 — so the
  // siteId=1 filter must drop DC02.
  const db = buildMockDb([
    {
      match: /SELECT\s+source_dc\s*,\s*users_count\s*,\s*groups_count\s*,\s*gpos_count\s*,\s*locked_count\s*,\s*collected_at\s+FROM\s*\(/is,
      rows: [
        { source_dc: 'DC01', users_count: 100, groups_count: 30, gpos_count: 5, locked_count: 2, collected_at: new Date('2026-08-06T10:00:00Z') },
        { source_dc: 'DC02', users_count: 110, groups_count: 31, gpos_count: 6, locked_count: 0, collected_at: new Date('2026-08-06T10:00:00Z') }
      ]
    },
    {
      match: /FROM\s+ad_dcs\s+d/i,
      rows: [
        { dcHost: 'DC01', siteName: 'Site-A', siteId: 1 },
        { dcHost: 'DC02', siteName: 'Site-B', siteId: 2 }
      ]
    },
    { match: /COUNT\(\*\)\s+AS\s+c\s+FROM\s+ad_replication_status/i, rows: [{ c: 0 }] }
  ]).standard();
  _setDbForTest(db);

  const res = await supertest(buildApp())
    .get('/api/dcs/summary?siteId=1')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].dcHost, 'DC01');
  assert.equal(res.body[0].siteName, 'Site-A');
});

test('GET /api/dcs/summary?siteId=abc returns 400 (must be a positive integer)', async () => {
  _setDbForTest(buildMockDb().standard());
  const res = await supertest(buildApp())
    .get('/api/dcs/summary?siteId=abc')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /siteId/i);
});

test('GET /api/dcs/summary?siteId=0 returns 400 (must be positive)', async () => {
  _setDbForTest(buildMockDb().standard());
  const res = await supertest(buildApp())
    .get('/api/dcs/summary?siteId=0')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 400);
});

test('GET /api/dcs/summary returns 401 when no auth token', async () => {
  _setDbForTest(buildMockDb().standard());
  const res = await supertest(buildApp()).get('/api/dcs/summary');
  assert.equal(res.status, 401);
});

test('GET /api/dcs/summary partnersCount reflects same-cycle count from subquery', async () => {
  // Two DCs from the latestSummary query; partnerCount for each comes from
  // a separate COUNT(*) query. Verify the route threads the result through.
  // Important: the latestSummaryPerDc regex must NOT match the COUNT(*) query
  // (the COUNT query also contains __dc_summary__), so the COUNT script is
  // listed first and the latestSummary script is restricted to the leading
  // SELECT shape.
  const db = buildMockDb([
    {
      match: /SELECT\s+source_dc\s*,\s*users_count\s*,\s*groups_count\s*,\s*gpos_count\s*,\s*locked_count\s*,\s*collected_at\s+FROM\s*\(/is,
      rows: [
        { source_dc: 'DC01', users_count: 100, groups_count: 30, gpos_count: 5, locked_count: 2, collected_at: new Date('2026-08-06T10:00:00Z') },
        { source_dc: 'DC02', users_count: 110, groups_count: 31, gpos_count: 6, locked_count: 0, collected_at: new Date('2026-08-06T10:00:00Z') }
      ]
    },
    // COUNT(*) script — must come BEFORE any generic ad_replication_status match
    // because the mock returns the FIRST matching script's rows.
    {
      match: /COUNT\(\*\)\s+AS\s+c\s+FROM\s+ad_replication_status/i,
      rows: (params) => {
        if (params[0] === 'DC01') return [{ c: 3 }];
        if (params[0] === 'DC02') return [{ c: 5 }];
        return [{ c: 0 }];
      }
    },
    { match: /FROM\s+ad_dcs\s+d/i, rows: [] }
  ]).standard();
  _setDbForTest(db);

  const res = await supertest(buildApp())
    .get('/api/dcs/summary')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
  assert.equal(res.body[0].dcHost, 'DC01');
  assert.equal(res.body[0].partnersCount, 3);
  assert.equal(res.body[1].dcHost, 'DC02');
  assert.equal(res.body[1].partnersCount, 5);
});
