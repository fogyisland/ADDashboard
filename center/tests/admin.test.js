import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { adminRouter } from '../src/routes/admin.js';
import { signJwt } from '../src/auth/jwt.js';
import { buildMockPool, buildRecordingPool, buildThrowingPool } from './helpers/mysql-pool.js';

const SECRET = 'test-secret-please-do-not-use-in-prod';

function buildApp({ pool }) {
  const a = express();
  a.use(express.json());
  const config = { jwtSecret: SECRET };
  const logger = { info(){}, error(){}, warn(){}, debug(){} };
  a.use(adminRouter({ config, pool, logger }));
  return a;
}

function adminToken() {
  return signJwt(
    { sub: 'u1', role: 'admin', permissions: ['*'] },
    SECRET,
    60
  );
}

function operatorToken() {
  return signJwt(
    { sub: 'u2', role: 'operator', permissions: ['write:reports'] },
    SECRET,
    60
  );
}

// ----- AUTH WIRING -----

test('GET /api/admin/roles: 401 when no token', async () => {
  const app = buildApp({ pool: buildMockPool() });
  const r = await supertest(app).get('/api/admin/roles');
  assert.equal(r.status, 401);
});

test('GET /api/admin/roles: 403 for operator token (missing admin:users perm)', async () => {
  const app = buildApp({ pool: buildMockPool() });
  const r = await supertest(app)
    .get('/api/admin/roles')
    .set('Authorization', `Bearer ${operatorToken()}`);
  assert.equal(r.status, 403);
});

test('GET /api/admin/roles: 200 with admin token and JSON-parsed permissions', async () => {
  const pool = buildMockPool([
    {
      match: /FROM\s+sys_roles/i,
      rows: [
        { id: 1, role_name: 'admin', permissions: '["*"]' },
        { id: 2, role_name: 'operator', permissions: '["write:reports"]' }
      ]
    }
  ]);
  const app = buildApp({ pool });
  const r = await supertest(app)
    .get('/api/admin/roles')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
  assert.equal(r.body.length, 2);
  assert.equal(r.body[0].id, 1);
  assert.equal(r.body[0].roleName, 'admin');
  assert.deepEqual(r.body[0].permissions, ['*']);
  assert.equal(r.body[1].roleName, 'operator');
  assert.deepEqual(r.body[1].permissions, ['write:reports']);
});

// ----- USERS LIST -----

test('GET /api/admin/users: 200 returns array of users', async () => {
  const pool = buildMockPool([
    {
      match: /FROM\s+sys_users\s+u\s+JOIN\s+sys_roles\s+r/i,
      rows: [
        { id: 1, username: 'alice', status: 1, last_login_at: null, created_at: new Date('2026-07-10T00:00:00Z'), role_name: 'admin' },
        { id: 2, username: 'bob',   status: 1, last_login_at: null, created_at: new Date('2026-07-11T00:00:00Z'), role_name: 'operator' }
      ]
    }
  ]);
  const app = buildApp({ pool });
  const r = await supertest(app)
    .get('/api/admin/users')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
  assert.equal(r.body.length, 2);
  assert.equal(r.body[0].username, 'alice');
  assert.equal(r.body[0].roleName, 'admin');
});

// ----- CREATE USER -----

test('POST /api/admin/users: 400 when missing fields', async () => {
  const app = buildApp({ pool: buildMockPool() });
  const r = await supertest(app)
    .post('/api/admin/users')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ username: 'alice' }); // missing password and roleId
  assert.equal(r.status, 400);
});

test('POST /api/admin/users: 409 when username already exists', async () => {
  const pool = buildMockPool([
    {
      match: /FROM\s+sys_users\s+u\s+JOIN\s+sys_roles\s+r/i,
      rows: [{ id: 1, username: 'alice', password_hash: 'x', status: 1, role_id: 1, role_name: 'admin', permissions: '["*"]' }]
    }
  ]);
  const app = buildApp({ pool });
  const r = await supertest(app)
    .post('/api/admin/users')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ username: 'alice', password: 'pw', roleId: 1 });
  assert.equal(r.status, 409);
});

test('POST /api/admin/users: 201 on success and writes audit row', async () => {
  // Find-by-username returns empty (no conflict), then INSERT INTO sys_users,
  // then INSERT INTO audit_logs. We key on SQL fragments and capture params.
  const recorded = [];
  let auditCaptured = null;
  const pool = {
    async execute(sql, params = []) {
      recorded.push({ sql, params });
      if (/FROM\s+sys_users\s+u\s+JOIN\s+sys_roles\s+r/i.test(sql)) {
        return [[], []];
      }
      if (/INSERT\s+INTO\s+sys_users/i.test(sql)) {
        return [{ insertId: 42, affectedRows: 1 }, []];
      }
      if (/INSERT\s+INTO\s+audit_logs/i.test(sql)) {
        // [userId, action, target, payload_json]
        auditCaptured = {
          userId: params[0],
          action: params[1],
          target: params[2],
          payload: params[3]
        };
        return [{ insertId: 99, affectedRows: 1 }, []];
      }
      return [[], []];
    }
  };
  const app = buildApp({ pool });
  const r = await supertest(app)
    .post('/api/admin/users')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ username: 'charlie', password: 'pw', roleId: 1 });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body, { ok: true });
  assert.ok(auditCaptured, 'audit_logs INSERT should have been called');
  assert.equal(auditCaptured.action, 'create_user');
  assert.equal(auditCaptured.target, 'charlie');
  assert.equal(auditCaptured.userId, 'u1');
  assert.match(auditCaptured.payload, /"username":"charlie"/);
});

// ----- UPDATE USER -----

test('PUT /api/admin/users/:id: 200 with payload', async () => {
  const records = [];
  const pool = buildRecordingPool(records);
  const app = buildApp({ pool });
  const r = await supertest(app)
    .put('/api/admin/users/5')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ status: 0 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
});

// ----- DELETE USER -----

test('DELETE /api/admin/users/:id: 200', async () => {
  const records = [];
  const pool = buildRecordingPool(records);
  const app = buildApp({ pool });
  const r = await supertest(app)
    .delete('/api/admin/users/5')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
});

// ----- CONFIG -----

test('GET /api/admin/config: 200 returns dict from system_config', async () => {
  const pool = buildMockPool([
    {
      match: /FROM\s+system_config/i,
      rows: [
        { config_key: 'polling_interval_minutes', config_value: '15' },
        { config_key: 'agent_token', config_value: 'tok-123' }
      ]
    }
  ]);
  const app = buildApp({ pool });
  const r = await supertest(app)
    .get('/api/admin/config')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.polling_interval_minutes, '15');
  assert.equal(r.body.agent_token, 'tok-123');
});

test('PUT /api/admin/config: 200 updates multiple keys', async () => {
  let updateCount = 0;
  const pool = {
    async execute(sql, params = []) {
      if (/UPDATE\s+system_config/i.test(sql)) {
        updateCount++;
        return [{ affectedRows: 1 }, []];
      }
      return [[], []];
    }
  };
  const app = buildApp({ pool });
  const r = await supertest(app)
    .put('/api/admin/config')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ polling_interval_minutes: '10', agent_token: 'new-tok' });
  assert.equal(r.status, 200);
  assert.equal(updateCount, 2);
});

// ----- AUDIT -----

test('GET /api/admin/audit?limit=5: 200 returns at most 5 rows', async () => {
  const pool = buildMockPool([
    {
      match: /FROM\s+audit_logs/i,
      rows: [
        { id: 1, user_id: 1, action: 'login', target: 'alice', payload: null, created_at: new Date() },
        { id: 2, user_id: 1, action: 'create_user', target: 'bob', payload: '{"x":1}', created_at: new Date() }
      ]
    }
  ]);
  const app = buildApp({ pool });
  const r = await supertest(app)
    .get('/api/admin/audit?limit=5')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
  assert.ok(r.body.length <= 5);
  assert.equal(r.body[0].userId, 1);
  assert.equal(r.body[0].action, 'login');
});

// ----- DB ERROR PATH -----

test('admin route: 500 on DB error returns {error: "internal"}', async () => {
  const app = buildApp({ pool: buildThrowingPool('boom') });
  const r = await supertest(app)
    .get('/api/admin/users')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 500);
  assert.equal(r.body.error, 'internal');
});

// ----- SITES (derived from ad_replication_status) -----

test('GET /api/admin/sites: 200 returns camelCase rows with linkCount/errorCount/lastSeen', async () => {
  const last = new Date('2026-07-11T08:00:00Z');
  const pool = buildMockPool([
    {
      // The UNION ALL of source_site + dest_site grouped by site
      match: /FROM\s*\(\s*SELECT\s+source_site\s+AS\s+site/i,
      rows: [
        { name: 'SITE-A', link_count: 4, error_count: 1, last_seen: last },
        { name: 'SITE-B', link_count: 2, error_count: 0, last_seen: last }
      ]
    }
  ]);
  const app = buildApp({ pool });
  const r = await supertest(app)
    .get('/api/admin/sites')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 2);
  assert.deepEqual(Object.keys(r.body[0]).sort(),
    ['errorCount','lastSeen','linkCount','name']);
  assert.equal(r.body[0].name, 'SITE-A');
  assert.equal(r.body[0].linkCount, 4);
  assert.equal(r.body[0].errorCount, 1);
});

// ----- DCS (derived from ad_replication_status, grouped by dc+site) -----

test('GET /api/admin/dcs: 200 returns rows keyed on (name, site) pair', async () => {
  const last = new Date('2026-07-11T08:00:00Z');
  const pool = buildMockPool([
    {
      // The UNION ALL of source_dc + dest_dc grouped by dc, site
      match: /FROM\s*\(\s*SELECT\s+source_dc\s+AS\s+dc/i,
      rows: [
        { name: 'DC-A1', site: 'SITE-A', link_count: 3, error_count: 0, last_seen: last },
        { name: 'DC-B1', site: 'SITE-B', link_count: 2, error_count: 1, last_seen: last }
      ]
    }
  ]);
  const app = buildApp({ pool });
  const r = await supertest(app)
    .get('/api/admin/dcs')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 2);
  assert.deepEqual(Object.keys(r.body[0]).sort(),
    ['errorCount','lastSeen','linkCount','name','site']);
  assert.equal(r.body[0].name, 'DC-A1');
  assert.equal(r.body[0].site, 'SITE-A');
  assert.equal(r.body[0].linkCount, 3);
});

test('GET /api/admin/sites with empty replication_status -> empty array', async () => {
  const pool = buildMockPool([
    { match: /FROM\s*\(\s*SELECT\s+source_site\s+AS\s+site/i, rows: [] }
  ]);
  const app = buildApp({ pool });
  const r = await supertest(app)
    .get('/api/admin/sites')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, []);
});

// ----- SITES-CATALOG -----

test('GET /api/admin/sites-catalog: 200 returns array with dcCount', async () => {
  const pool = buildMockPool([
    {
      match: /FROM\s+ad_sites\s+s/i,
      rows: [
        { id: 1, site_name: 'Beijing-Site', region_code: 'BJ', is_hub: 1, description: 'BJ-DC', created_at: new Date(), updated_at: new Date(), dcCount: 3 },
        { id: 2, site_name: 'Shanghai-Site', region_code: 'SH', is_hub: 0, description: null, created_at: new Date(), updated_at: new Date(), dcCount: 0 }
      ]
    }
  ]);
  const app = buildApp({ pool });
  const r = await supertest(app)
    .get('/api/admin/sites-catalog')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 2);
  assert.equal(r.body[0].siteName, 'Beijing-Site');
  assert.equal(r.body[0].dcCount, 3);
  assert.equal(r.body[0].isHub, 1);
});

test('POST /api/admin/sites-catalog: 201 on success, 409 on duplicate', async () => {
  let insertCalls = 0;
  let insertError = null;
  const pool = {
    async execute(sql, params = []) {
      if (/INSERT\s+INTO\s+ad_sites/i.test(sql)) {
        insertCalls++;
        // Simulate duplicate-key error on second call
        if (insertCalls === 1) return [{ insertId: 99, affectedRows: 1 }, []];
        const err = new Error('Duplicate entry');
        err.code = 'ER_DUP_ENTRY';
        throw err;
      }
      return [[], []];
    }
  };
  const app = buildApp({ pool });

  // First call: success
  const r1 = await supertest(app)
    .post('/api/admin/sites-catalog')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ siteName: 'BJ', regionCode: 'BJ', isHub: true, description: 'test' });
  assert.equal(r1.status, 201);
  assert.equal(r1.body.id, 99);

  // Second call: duplicate -> 409
  const r2 = await supertest(app)
    .post('/api/admin/sites-catalog')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ siteName: 'BJ', regionCode: 'BJ' });
  assert.equal(r2.status, 409);
});

test('POST /api/admin/sites-catalog: 400 when siteName missing', async () => {
  const pool = buildMockPool();
  const app = buildApp({ pool });
  const r = await supertest(app)
    .post('/api/admin/sites-catalog')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ regionCode: 'BJ' });
  assert.equal(r.status, 400);
});

test('DELETE /api/admin/sites-catalog/:id: 200 and nullifies DCs first', async () => {
  const executed = [];
  const pool = {
    async execute(sql, params = []) {
      executed.push({ sql, params });
      return [{ affectedRows: 1 }, []];
    }
  };
  const app = buildApp({ pool });
  const r = await supertest(app)
    .delete('/api/admin/sites-catalog/1')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  // First execute should nullify DCs, second should delete site
  assert.match(executed[0].sql, /UPDATE\s+ad_dcs\s+SET\s+site_id\s*=\s*NULL/i);
  assert.match(executed[1].sql, /DELETE\s+FROM\s+ad_sites/i);
});

test('PUT /api/admin/sites-catalog/:id: 400 invalid id (non-numeric), no DB execute', async () => {
  let executeCalls = 0;
  const pool = {
    async execute() {
      executeCalls++;
      return [{ affectedRows: 0 }, []];
    }
  };
  const app = buildApp({ pool });
  const r = await supertest(app)
    .put('/api/admin/sites-catalog/abc')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ siteName: 'X' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'invalid id');
  assert.equal(executeCalls, 0, 'no DB query should fire on invalid id');
});

test('DELETE /api/admin/sites-catalog/:id: 400 invalid id (negative), no DB execute', async () => {
  let executeCalls = 0;
  const pool = {
    async execute() {
      executeCalls++;
      return [{ affectedRows: 0 }, []];
    }
  };
  const app = buildApp({ pool });
  const r = await supertest(app)
    .delete('/api/admin/sites-catalog/-1')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'invalid id');
  assert.equal(executeCalls, 0, 'no DB query should fire on invalid id');
});

test('PUT /api/admin/sites-catalog/:id: 400 invalid id (zero), no DB execute', async () => {
  let executeCalls = 0;
  const pool = {
    async execute() {
      executeCalls++;
      return [{ affectedRows: 0 }, []];
    }
  };
  const app = buildApp({ pool });
  const r = await supertest(app)
    .put('/api/admin/sites-catalog/0')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ siteName: 'X' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'invalid id');
  assert.equal(executeCalls, 0, 'no DB query should fire on zero id');
});

// ----- DCS-CATALOG -----

test('GET /api/admin/dcs-catalog: 200 returns LEFT JOIN with site', async () => {
  const pool = buildMockPool([
    {
      match: /FROM\s+ad_dcs\s+d\s+LEFT\s+JOIN\s+ad_sites/i,
      rows: [
        {
          dcName: 'DC-BJ-01', siteId: 1, siteName: 'Beijing-Site',
          siteHint: 'Beijing-Site', osVersion: 'Win2022', whenCreated: new Date(),
          isPdc: 0, isGc: 1, isRidMaster: 0, isSchemaMaster: 0,
          isDomainNamingMaster: 0, isInfrastructureMaster: 0,
          discoveredAt: new Date(), discoveredByAgentId: 'DC-BJ-01'
        },
        {
          dcName: 'DC-SH-01', siteId: null, siteName: null,
          siteHint: 'Shanghai-Site', osVersion: 'Win2019', whenCreated: null,
          isPdc: 0, isGc: 1, isRidMaster: 0, isSchemaMaster: 0,
          isDomainNamingMaster: 0, isInfrastructureMaster: 0,
          discoveredAt: new Date(), discoveredByAgentId: 'DC-SH-01'
        }
      ]
    }
  ]);
  const app = buildApp({ pool });
  const r = await supertest(app)
    .get('/api/admin/dcs-catalog')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 2);
  assert.equal(r.body[0].dcName, 'DC-BJ-01');
  assert.equal(r.body[0].siteName, 'Beijing-Site');
  assert.equal(r.body[1].siteId, null); // unassigned
});

test('PUT /api/admin/dcs-catalog/:dc_name/site: 200 sets siteId', async () => {
  let updateCalled = false;
  const pool = {
    async execute(sql, params = []) {
      if (/UPDATE\s+ad_dcs\s+SET\s+site_id\s*=/i.test(sql)) {
        updateCalled = true;
        assert.equal(params[0], 1);
        assert.equal(params[1], 'DC-BJ-01');
        return [{ affectedRows: 1 }, []];
      }
      return [[], []];
    }
  };
  const app = buildApp({ pool });
  const r = await supertest(app)
    .put('/api/admin/dcs-catalog/DC-BJ-01/site')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ siteId: 1 });
  assert.equal(r.status, 200);
  assert.equal(updateCalled, true);
});

test('PUT /api/admin/dcs-catalog/:dc_name/site with siteId:null unbinds', async () => {
  const records = [];
  const pool = buildRecordingPool(records);
  const app = buildApp({ pool });
  const r = await supertest(app)
    .put('/api/admin/dcs-catalog/DC-BJ-01/site')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ siteId: null });
  assert.equal(r.status, 200);
  assert.match(records[0].sql, /UPDATE\s+ad_dcs\s+SET\s+site_id\s*=\s*\?/i);
  assert.equal(records[0].params[0], null);
});
