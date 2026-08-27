// 2026-08-27 round-29: PUT /api/admin/dcs-catalog/:dc_name/flags
// Lets operators toggle the 5 FSMO roles + bridgehead directly from the
// DcsCatalogView UI. This test pins:
//   - happy path with a single flag → 200 + audit row
//   - happy path with multiple flags → SET clause contains all of them
//   - 404 when affectedRows=0 (dc_name not in ad_dcs)
//   - 400 on empty body / unknown flag key / non-boolean value
//   - 401 without token mirrors the existing admin route guards
//   - GET /api/admin/dcs-catalog surfaces isBridgehead as boolean

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

// Wrapper that captures both the UPDATE params issued by the route AND any
// audit rows written via writeAudit. Pass the existing db-mock scripts
// through unchanged and append the two capture entries at the END so the
// first-match-wins priority in db-mock.js still resolves any explicit
// test scripts first.
function withCaptures(existingScripts) {
  const updates = []; // [{ sql, params }]
  const audits = [];  // [{ sql, params }]
  const db = buildMockDb([
    ...existingScripts,
    { match: /UPDATE\s+ad_dcs\s+SET/i, capture: true, onExecute: (sql, params) => updates.push({ sql, params: [...params] }) },
    // Audit write — INSERT into the audit table. The audit module's
    // INSERT shape varies by dialect; we match loosely.
    { match: /INSERT\s+INTO\s+\w*audit/i, capture: true, onExecute: (sql, params) => audits.push({ sql, params: [...params] }) }
  ]).standard();
  return { db, updates, audits };
}

test('PUT /api/admin/dcs-catalog/:dc_name/flags: 200 + audit row when toggling one flag', async () => {
  const { db, updates, audits } = withCaptures([]);
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .put('/api/admin/dcs-catalog/DC-BJ-01/flags')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ isPdc: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.updated, ['is_pdc']);
  assert.equal(updates.length, 1);
  // Partial UPDATE — the SET clause should only mention is_pdc and the
  // params end with the dc_name. Strict booleans coerce to 1/0.
  assert.match(updates[0].sql, /is_pdc\s*=\s*\?/i);
  assert.doesNotMatch(updates[0].sql, /is_gc|is_rid_master|is_bridgehead/i);
  assert.deepEqual(updates[0].params, [1, 'DC-BJ-01']);
  // Audit row written (action + target + payload).
  assert.ok(audits.length >= 1, `expected at least one audit row, got ${audits.length}`);
  // Audit payload contains the dc name and the update diff somewhere in
  // the parameter array — keep the assertion loose so it's robust to
  // schema changes in the audit table.
  const flagAudit = audits.find(p => p.params.some(v => typeof v === 'string' && v.includes('update_dc_flags')));
  assert.ok(flagAudit, `expected update_dc_flags audit row, got ${JSON.stringify(audits)}`);
  // writeAudit JSON.stringifies the payload before insertion (capPayload),
  // so the dcName shows up embedded inside that string. Pin the structure
  // to guard against accidental schema drops.
  const payloadArg = flagAudit.params.find(v => typeof v === 'string' && v.startsWith('{') && v.includes('dcName'));
  assert.ok(payloadArg, 'audit payload JSON contains dcName');
  const parsed = JSON.parse(payloadArg);
  assert.equal(parsed.dcName, 'DC-BJ-01');
  assert.deepEqual(parsed.updates, { is_pdc: 1 });
});

test('PUT /api/admin/dcs-catalog/:dc_name/flags: multi-flag body issues a single UPDATE', async () => {
  const { db, updates } = withCaptures([]);
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .put('/api/admin/dcs-catalog/DC-BJ-01/flags')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ isPdc: true, isGc: false, isBridgehead: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.updated.length, 3);
  assert.equal(updates.length, 1);
  // Last param is dc_name; the three flags precede it.
  assert.equal(updates[0].params[updates[0].params.length - 1], 'DC-BJ-01');
  // Booleans coerced to 1/0 in the order they were supplied.
  const flags = updates[0].params.slice(0, -1);
  assert.deepEqual(flags, [1, 0, 1]);
});

test('PUT /api/admin/dcs-catalog/:dc_name/flags: 404 when UPDATE affects 0 rows', async () => {
  // Mock with a script that returns affectedRows=0 for the UPDATE so the
  // route takes the 404 branch. We override the mockDb's execute function
  // entirely so the standard affectedRows=1 default doesn't fire.
  const sql = (await import('../src/db/sql.js')).buildSql('mysql');
  // Hand-roll the minimal db stub: returns the auth-success + jwt_secret
  // rows for userAuth, returns affectedRows=0 for everything else.
  _setDbForTest({
    dialect: 'mysql',
    sql,
    async execute(q) {
      if (/UPDATE\s+ad_dcs\s+SET/i.test(q)) return { rows: [], affectedRows: 0 };
      return { rows: [], affectedRows: 1 };
    },
    async query(q) {
      if (/sys_users/i.test(q)) return { rows: [{ token_version: 0, status: 1 }] };
      if (/jwt_secret/i.test(q)) return { rows: [{ config_key: 'jwt_secret_current', config_value: SECRET }] };
      return { rows: [] };
    },
    async transaction(work) { return work({ execute: this.execute, query: this.query, sql }); },
    async healthcheck() {}, async close() {}
  });
  const r = await supertest(buildApp())
    .put('/api/admin/dcs-catalog/NOT-A-DC/flags')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ isPdc: true });
  assert.equal(r.status, 404);
  assert.match(r.body.error, /not found/i);
});

test('PUT /api/admin/dcs-catalog/:dc_name/flags: 400 on empty body', async () => {
  _setDbForTest(buildMockDb([]).standard());
  const r = await supertest(buildApp())
    .put('/api/admin/dcs-catalog/DC-BJ-01/flags')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({});
  assert.equal(r.status, 400);
  assert.match(r.body.error, /no flags/i);
});

test('PUT /api/admin/dcs-catalog/:dc_name/flags: 400 on unknown flag key', async () => {
  _setDbForTest(buildMockDb([]).standard());
  const r = await supertest(buildApp())
    .put('/api/admin/dcs-catalog/DC-BJ-01/flags')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ isPdc: true, isInventedRole: true });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /unknown flag/i);
  assert.match(r.body.error, /isInventedRole/);
});

test('PUT /api/admin/dcs-catalog/:dc_name/flags: 400 on non-boolean value', async () => {
  _setDbForTest(buildMockDb([]).standard());
  const r = await supertest(buildApp())
    .put('/api/admin/dcs-catalog/DC-BJ-01/flags')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ isPdc: 'true' }); // string, not boolean
  assert.equal(r.status, 400);
  assert.match(r.body.error, /isPdc must be boolean/i);
});

test('PUT /api/admin/dcs-catalog/:dc_name/flags: 401 without token', async () => {
  _setDbForTest(buildMockDb([]).standard());
  const r = await supertest(buildApp())
    .put('/api/admin/dcs-catalog/DC-BJ-01/flags')
    .send({ isPdc: true });
  assert.equal(r.status, 401);
});

test('GET /api/admin/dcs-catalog: surfaces isBridgehead as boolean', async () => {
  // round-28.5 / round-29: the list projection now includes is_bridgehead
  // and the route normalizes it to a JS boolean like the other role flags.
  const rows = [{
    dcName: 'DC-BJ-01', siteId: 1, siteName: 'Beijing-Site', siteHint: null,
    osVersion: 'Win2022', whenCreated: null,
    isPdc: 0, isGc: 1, isRidMaster: 0, isSchemaMaster: 0,
    isDomainNamingMaster: 0, isInfrastructureMaster: 0,
    isBridgehead: 1,
    discoveredAt: '2026-07-12T00:00:00Z', discoveredByAgentId: 'a-1'
  }];
  _setDbForTest(buildMockDb([
    { match: /FROM\s+ad_dcs\s+d/i, rows }
  ]).standard());
  const r = await supertest(buildApp())
    .get('/api/admin/dcs-catalog')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
  assert.equal(r.body[0].dcName, 'DC-BJ-01');
  assert.equal(r.body[0].isPdc, false);
  assert.equal(r.body[0].isGc, true);
  assert.equal(r.body[0].isBridgehead, true);
});