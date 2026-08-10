// Integration tests for the memberRouter (Task 6 of the non-AD server
// management plan). Covers:
//   - POST /api/admin/member-servers (manual entry → 200)
//   - GET  /api/admin/member-servers (list → items array)
//   - POST /api/admin/member-servers/self-register (idempotent; agent_token auth)
//   - PUT  /api/admin/member-servers/:hostname/packages/:package_name (toggle enabled)
//   - DELETE /api/admin/member-servers/:hostname/packages/:package_name
//     for the built-in 'ad-os-baseline' package (200 + audit row)
//   - DELETE without auth (401)
//
// Pattern: follow center/tests/admin-dcs-bulk-assign.test.js and
// center/tests/admin-sites-bulk.test.js — node:test + node:assert/strict,
// express app built with individual router, mock DB via _setDbForTest +
// buildMockDb scripts. No Jest, no supertest globals.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { memberRouter } from '../src/routes/member-servers.js';
import { signJwt } from '../src/auth/jwt.js';
import { _setDbForTest } from '../src/db/index.js';
import { buildMockDb, buildRecordingPool } from './helpers/db-mock.js';

const SECRET = 'test-secret-ms';
const AGENT_TOKEN = 'agent-token-1';

function adminToken() {
  return signJwt({ sub: 'u1', role: 'admin', permissions: ['*'] }, SECRET, 60);
}

function buildApp() {
  const a = express();
  a.use(express.json());
  const logger = { info() {}, error() {}, warn() {}, debug() {} };
  // memberRouter factory injects requireAuth (userAuth) + requirePerm.
  // For agent-token self-register we need a separate mount with agentToken;
  // we wire both on the same app so supertest hits either endpoint.
  a.use(memberRouter({
    config: { jwtSecret: SECRET, agentToken: AGENT_TOKEN },
    logger
  }));
  // Mirror the production wiring for /api/admin/member-servers/self-register
  // which is gated by agentToken (NOT userAuth). The router internally calls
  // the injected agentToken guard; verify by passing it through the factory.
  return a;
}

beforeEach(() => {
  // Each test starts from a clean db state — _setDbForTest is reset below.
});

// ---------------------------------------------------------------------------
// 1. POST /api/admin/member-servers — manual entry
// ---------------------------------------------------------------------------
describe('POST /api/admin/member-servers', () => {
  test('200 with admin token: upsert issued; audit row written', async () => {
    const records = [];
    const db = buildMockDb([
      { match: /INSERT\s+INTO\s+ad_member_servers|MERGE\s+INTO\s+ad_member_servers/i, capture: true, onExecute: (sql, params) => records.push({ kind: 'upsert', params }) },
      { match: /INSERT\s+INTO\s+audit_logs/i, capture: true, onExecute: (sql, params) => records.push({ kind: 'audit', params }) }
    ]).standard();
    _setDbForTest(db);
    const r = await supertest(buildApp())
      .post('/api/admin/member-servers')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ hostname: 'SRV-A', siteId: null, ipAddress: '10.0.0.1', osVersion: 'Windows Server 2022' });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    const upsert = records.find(x => x.kind === 'upsert');
    assert.ok(upsert, 'upsert should be recorded');
    // params: [hostname, site_id, ip_address, os_version, agent_type, enabled, discovered_via]
    assert.equal(upsert.params[0], 'SRV-A');
    assert.equal(upsert.params[1], null); // site_id null
    assert.equal(upsert.params[2], '10.0.0.1');
    assert.equal(upsert.params[3], 'Windows Server 2022');
    assert.equal(upsert.params[4], 'non-ad');
    assert.equal(upsert.params[5], 1); // enabled
    assert.equal(upsert.params[6], 'admin'); // discovered_via
    const audit = records.find(x => x.kind === 'audit');
    assert.ok(audit, 'audit row should be recorded');
    // audit.write: [user_id, action, target, payload_json]
    assert.equal(audit.params[1], 'create_member_server');
    assert.equal(audit.params[2], 'SRV-A');
  });

  test('401 without auth', async () => {
    _setDbForTest(buildMockDb().standard());
    const r = await supertest(buildApp())
      .post('/api/admin/member-servers')
      .send({ hostname: 'SRV-A' });
    assert.equal(r.status, 401);
  });

  test('400 when hostname missing', async () => {
    _setDbForTest(buildMockDb().standard());
    const r = await supertest(buildApp())
      .post('/api/admin/member-servers')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ ipAddress: '10.0.0.1' });
    assert.equal(r.status, 400);
  });
});

// ---------------------------------------------------------------------------
// 2. GET /api/admin/member-servers — list
// ---------------------------------------------------------------------------
describe('GET /api/admin/member-servers', () => {
  test('200 with admin token: returns items array', async () => {
    const db = buildMockDb([
      { match: /FROM\s+ad_member_servers/i, rows: [
        { hostname: 'SRV-A', site_id: null, site_name: null, ip_address: '10.0.0.1', os_version: 'Win2022', agent_type: 'non-ad', enabled: 1 },
        { hostname: 'SRV-B', site_id: 7,    site_name: 'Beijing', ip_address: '10.0.0.2', os_version: 'Win2019', agent_type: 'non-ad', enabled: 0 }
      ] }
    ]).standard();
    _setDbForTest(db);
    const r = await supertest(buildApp())
      .get('/api/admin/member-servers')
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.items));
    assert.equal(r.body.items.length, 2);
    assert.equal(r.body.items[0].hostname, 'SRV-A');
  });
});

// ---------------------------------------------------------------------------
// 3. POST /api/admin/member-servers/self-register — agent_token idempotent
// ---------------------------------------------------------------------------
describe('POST /api/admin/member-servers/self-register', () => {
  test('idempotent: two calls with same body each return 200', async () => {
    const upserts = [];
    const db = buildMockDb([
      { match: /INSERT\s+INTO\s+ad_member_servers|MERGE\s+INTO\s+ad_member_servers/i, capture: true, onExecute: (sql, params) => upserts.push(params) }
    ]).standard();
    _setDbForTest(db);
    const body = { hostname: 'SRV-A', agentVersion: '0.1.0', osVersion: 'Win2022', ipAddress: '10.0.0.1' };
    const r1 = await supertest(buildApp())
      .post('/api/admin/member-servers/self-register')
      .set('X-Agent-Token', AGENT_TOKEN)
      .send(body);
    const r2 = await supertest(buildApp())
      .post('/api/admin/member-servers/self-register')
      .set('X-Agent-Token', AGENT_TOKEN)
      .send(body);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    // Two upserts issued (idempotency = safe to re-run)
    assert.equal(upserts.length, 2);
    // discovered_via = 'self-register', enabled = 1
    assert.equal(upserts[0][6], 'self-register');
    assert.equal(upserts[0][5], 1);
  });

  test('401 with wrong agent token', async () => {
    _setDbForTest(buildMockDb().standard());
    const r = await supertest(buildApp())
      .post('/api/admin/member-servers/self-register')
      .set('X-Agent-Token', 'WRONG')
      .send({ hostname: 'SRV-A' });
    assert.equal(r.status, 401);
  });

  test('400 when hostname missing', async () => {
    _setDbForTest(buildMockDb().standard());
    const r = await supertest(buildApp())
      .post('/api/admin/member-servers/self-register')
      .set('X-Agent-Token', AGENT_TOKEN)
      .send({});
    assert.equal(r.status, 400);
  });
});

// ---------------------------------------------------------------------------
// 4. PUT /api/admin/member-servers/:hostname/packages/:package_name — toggle
// ---------------------------------------------------------------------------
// PUT uses db.sql.serverGroups.upsertPackage which is INSERT/MERGE-on-conflict
// (not a bare UPDATE) — the route idempotently inserts the row when missing
// and updates enabled when present. Tests match that shape: either an UPDATE
// (mysql ON DUPLICATE KEY branch) or an INSERT/MERGE counts as "the toggle
// SQL landed on ad_member_server_packages".
describe('PUT /api/admin/member-servers/:hostname/packages/:package_name', () => {
  test('200 toggles enabled flag', async () => {
    const records = [];
    _setDbForTest(buildRecordingPool(records));
    const r = await supertest(buildApp())
      .put('/api/admin/member-servers/SRV-A/packages/ad-os-baseline')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ enabled: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    // Either INSERT ... ON DUPLICATE KEY UPDATE (mysql) or MERGE (mssql).
    const update = records.find(r => /INSERT\s+INTO\s+ad_member_server_packages|MERGE\s+INTO\s+ad_member_server_packages/i.test(r.sql));
    assert.ok(update, 'upsert on ad_member_server_packages should be issued');
    // params: [hostname, package_name, enabled]
    assert.equal(update.params[0], 'SRV-A');
    assert.equal(update.params[1], 'ad-os-baseline');
    assert.equal(update.params[2], 1);
  });

  test('toggles from true → false (enabled=0 in SQL)', async () => {
    const records = [];
    _setDbForTest(buildRecordingPool(records));
    const r = await supertest(buildApp())
      .put('/api/admin/member-servers/SRV-A/packages/ad-os-baseline')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ enabled: false });
    assert.equal(r.status, 200);
    const update = records.find(r => /INSERT\s+INTO\s+ad_member_server_packages|MERGE\s+INTO\s+ad_member_server_packages/i.test(r.sql));
    assert.ok(update, 'upsert on ad_member_server_packages should be issued');
    assert.equal(update.params[2], 0);
  });
});

// ---------------------------------------------------------------------------
// 5. DELETE /api/admin/member-servers/:hostname/packages/:package_name
//    For built-in 'ad-os-baseline': audit row + DELETE.
// ---------------------------------------------------------------------------
describe('DELETE /api/admin/member-servers/:hostname/packages/:package_name', () => {
  test('200 for built-in ad-os-baseline + audit disable_builtin_ad_os_baseline written BEFORE the DELETE', async () => {
    const records = [];
    _setDbForTest(buildRecordingPool(records));
    const r = await supertest(buildApp())
      .delete('/api/admin/member-servers/SRV-A/packages/ad-os-baseline')
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    const audit = records.find(r => /INSERT\s+INTO\s+audit_logs/i.test(r.sql));
    assert.ok(audit, 'audit row should be written');
    assert.equal(audit.params[1], 'disable_builtin_ad_os_baseline');
    assert.equal(audit.params[2], 'SRV-A');
    const del = records.find(r => /DELETE\s+FROM\s+ad_member_server_packages/i.test(r.sql));
    assert.ok(del, 'DELETE should be issued');
    assert.deepEqual(del.params, ['SRV-A', 'ad-os-baseline']);
    // Audit (index) must come before DELETE (index) in execution order
    assert.ok(records.indexOf(audit) < records.indexOf(del), 'audit must be written before DELETE');
  });

  test('200 for non-built-in package: DELETE only, no audit row', async () => {
    const records = [];
    _setDbForTest(buildRecordingPool(records));
    const r = await supertest(buildApp())
      .delete('/api/admin/member-servers/SRV-A/packages/other-pkg')
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(r.status, 200);
    const audit = records.find(r => /INSERT\s+INTO\s+audit_logs/i.test(r.sql));
    assert.equal(audit, undefined, 'no audit row for non-built-in');
    const del = records.find(r => /DELETE\s+FROM\s+ad_member_server_packages/i.test(r.sql));
    assert.ok(del, 'DELETE should still be issued');
  });

  test('401 without auth', async () => {
    _setDbForTest(buildMockDb().standard());
    const r = await supertest(buildApp())
      .delete('/api/admin/member-servers/SRV-A/packages/ad-os-baseline');
    assert.equal(r.status, 401);
  });
});
