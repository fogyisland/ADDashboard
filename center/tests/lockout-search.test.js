import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import supertest from 'supertest';
import { lockoutRouter } from '../src/routes/lockout.js';
import { userAuth } from '../src/auth/user-auth.js';
import { requirePerm } from '../src/auth/rbac.js';
import { signJwt } from '../src/auth/jwt.js';
import { _setDbForTest } from '../src/db/index.js';
import { buildSql } from '../src/db/sql.js';
import { buildMockDb } from './helpers/db-mock.js';

const SECRET = 'test-secret';
function adminToken() { return signJwt({ sub: 'u1', role: 'admin', permissions: ['*'] }, SECRET, 60); }

function buildApp() {
  const a = express();
  a.use(express.json());
  return a.use(
    lockoutRouter({
      requireAuth: userAuth({ secret: SECRET, db: { query: async () => ({ rows: [{ token_version: 0, status: 1 }] }), sql: buildSql('mysql') } }),
      requirePerm
    })
  );
}

function pad(n) { return String(n).padStart(2, '0'); }
function isoAt(baseIso, addMinutes) {
  const d = new Date(baseIso);
  d.setUTCMinutes(d.getUTCMinutes() + addMinutes);
  return d.toISOString();
}

test('GET /api/lockout-events/search with targetUser returns rows sorted by occurred_at ASC and isSource on first row', async () => {
  const baseTime = '2026-08-06T10:00:00.000Z';
  const rows = [
    { occurred_at: isoAt(baseTime, 0),  dc_name: 'DC01', target_user_name: 'alice', subject_user_name: 'DC01$', subject_domain: 'CORP', caller_computer_name: 'WS-DEV-42' },
    { occurred_at: isoAt(baseTime, 10), dc_name: 'DC02', target_user_name: 'alice', subject_user_name: 'DC02$', subject_domain: 'CORP', caller_computer_name: 'WS-DEV-42' }
  ];
  _setDbForTest(buildMockDb([
    { match: /FROM\s+ad_lockout_events/is, rows }
  ]).standard());

  const res = await supertest(buildApp())
    .get('/api/lockout-events/search?targetUser=alice&sinceHours=24')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
  // First row gets isSource=true (only targetUser set)
  assert.equal(res.body[0].isSource, true);
  assert.equal(res.body[0].dcName, 'DC01');
  assert.equal(res.body[0].targetUserName, 'alice');
  assert.equal(res.body[0].callerComputerName, 'WS-DEV-42');
  assert.equal(res.body[0].occurredAt, isoAt(baseTime, 0));
  // Second row isSource=false
  assert.equal(res.body[1].isSource, false);
  assert.equal(res.body[1].dcName, 'DC02');
});

test('GET /api/lockout-events/search with dc filter returns only matching dc rows and no isSource', async () => {
  const rows = [
    { occurred_at: '2026-08-06T10:00:00.000Z', dc_name: 'DC01', target_user_name: 'alice', subject_user_name: 'DC01$', subject_domain: 'CORP', caller_computer_name: 'WS-01' }
  ];
  _setDbForTest(buildMockDb([
    { match: /FROM\s+ad_lockout_events/is, rows }
  ]).standard());

  const res = await supertest(buildApp())
    .get('/api/lockout-events/search?targetUser=alice&dc=DC01&sinceHours=24')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  // dc is set → no row gets isSource (ambiguous which is earliest across DCs)
  assert.equal(res.body[0].isSource, false);
});

test('GET /api/lockout-events/search with caller filter returns only matching caller rows', async () => {
  // The mock emulates the SQL WHERE clause (? = '' OR caller_computer_name = ?)
  // by inspecting the caller bind param (params[5] / params[6] are both caller).
  const allRows = [
    { occurred_at: '2026-08-06T10:00:00.000Z', dc_name: 'DC01', target_user_name: 'alice', subject_user_name: 'DC01$', subject_domain: 'CORP', caller_computer_name: 'WS-BAD' },
    { occurred_at: '2026-08-06T10:05:00.000Z', dc_name: 'DC02', target_user_name: 'alice', subject_user_name: 'DC02$', subject_domain: 'CORP', caller_computer_name: 'WS-OK' }
  ];
  _setDbForTest(buildMockDb([
    {
      match: /FROM\s+ad_lockout_events/is,
      rows: (params) => {
        const caller = params[6] || '';
        return caller ? allRows.filter((r) => r.caller_computer_name === caller) : allRows;
      }
    }
  ]).standard());

  const res = await supertest(buildApp())
    .get('/api/lockout-events/search?targetUser=alice&caller=WS-BAD&sinceHours=24')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].callerComputerName, 'WS-BAD');
});

test('GET /api/lockout-events/search with all three filters returns intersection', async () => {
  const rows = [
    { occurred_at: '2026-08-06T10:00:00.000Z', dc_name: 'DC01', target_user_name: 'alice', subject_user_name: 'DC01$', subject_domain: 'CORP', caller_computer_name: 'WS-01' }
  ];
  _setDbForTest(buildMockDb([
    { match: /FROM\s+ad_lockout_events/is, rows }
  ]).standard());

  const res = await supertest(buildApp())
    .get('/api/lockout-events/search?targetUser=alice&dc=DC01&caller=WS-01&sinceHours=24')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].dcName, 'DC01');
  assert.equal(res.body[0].callerComputerName, 'WS-01');
});

test('GET /api/lockout-events/search with no filter dimension returns 400', async () => {
  _setDbForTest(buildMockDb().standard());
  const res = await supertest(buildApp())
    .get('/api/lockout-events/search?sinceHours=24')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /targetUser|dc|caller/i);
});

test('GET /api/lockout-events/search with sinceHours=999 returns 400', async () => {
  _setDbForTest(buildMockDb().standard());
  const res = await supertest(buildApp())
    .get('/api/lockout-events/search?targetUser=alice&sinceHours=999')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /sinceHours/i);
});