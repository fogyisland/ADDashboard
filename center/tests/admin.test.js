import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { adminRouter } from '../src/routes/admin.js';
import { signJwt } from '../src/auth/jwt.js';

const SECRET = 'test-secret-please-do-not-use-in-prod';

// Programmable mock pool matching the dashboard.test.js pattern.
// Returns rows keyed by SQL fragment match.
function buildMockPool(scripts) {
  return {
    request() {
      const self = {
        _inputs: {},
        input(k, v) { self._inputs[k] = v; return self; },
        async query(q) {
          for (const s of scripts) {
            if (s.match.test(q)) {
              const rows = typeof s.rows === 'function' ? s.rows() : s.rows;
              return { recordset: Array.isArray(rows) ? rows : [] };
            }
          }
          return { recordset: [] };
        }
      };
      return self;
    }
  };
}

function buildApp({ pool, scripts }) {
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
  const pool = buildMockPool([]);
  const app = buildApp({ pool, scripts: [] });
  const r = await supertest(app).get('/api/admin/roles');
  assert.equal(r.status, 401);
});

test('GET /api/admin/roles: 403 for operator token (missing admin:users perm)', async () => {
  const pool = buildMockPool([]);
  const app = buildApp({ pool, scripts: [] });
  const r = await supertest(app)
    .get('/api/admin/roles')
    .set('Authorization', `Bearer ${operatorToken()}`);
  assert.equal(r.status, 403);
});

test('GET /api/admin/roles: 200 with admin token and JSON-parsed permissions', async () => {
  const scripts = [
    {
      match: /FROM\s+sys_roles/i,
      rows: [
        { id: 1, role_name: 'admin', permissions: '["*"]' },
        { id: 2, role_name: 'operator', permissions: '["write:reports"]' }
      ]
    }
  ];
  const pool = buildMockPool(scripts);
  const app = buildApp({ pool, scripts });
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
  const scripts = [
    {
      match: /FROM\s+sys_users\s+u\s+JOIN\s+sys_roles\s+r/i,
      rows: [
        { id: 1, username: 'alice', status: 1, last_login_at: null, created_at: new Date('2026-07-10T00:00:00Z'), role_name: 'admin' },
        { id: 2, username: 'bob',   status: 1, last_login_at: null, created_at: new Date('2026-07-11T00:00:00Z'), role_name: 'operator' }
      ]
    }
  ];
  const pool = buildMockPool(scripts);
  const app = buildApp({ pool, scripts });
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
  const pool = buildMockPool([]);
  const app = buildApp({ pool, scripts: [] });
  const r = await supertest(app)
    .post('/api/admin/users')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ username: 'alice' }); // missing password and roleId
  assert.equal(r.status, 400);
});

test('POST /api/admin/users: 409 when username already exists', async () => {
  const scripts = [
    {
      match: /FROM\s+sys_users\s+u\s+JOIN\s+sys_roles\s+r/i,
      rows: [{ id: 1, username: 'alice', password_hash: 'x', status: 1, role_id: 1, role_name: 'admin', permissions: '["*"]' }]
    }
  ];
  const pool = buildMockPool(scripts);
  const app = buildApp({ pool, scripts });
  const r = await supertest(app)
    .post('/api/admin/users')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ username: 'alice', password: 'pw', roleId: 1 });
  assert.equal(r.status, 409);
});

test('POST /api/admin/users: 201 on success and writes audit row', async () => {
  let auditCalled = false;
  let lastAuditAction = null;
  let lastAuditTarget = null;
  let lastAuditUserId = null;
  const pool = {
    request() {
      const self = {
        _inputs: {},
        input(k, v) { self._inputs[k] = v; return self; },
        async query(q) {
          if (/FROM\s+sys_users\s+u\s+JOIN\s+sys_roles\s+r/i.test(q)) {
            return { recordset: [] };
          }
          if (/INSERT\s+INTO\s+audit_logs/i.test(q)) {
            auditCalled = true;
            lastAuditAction = self._inputs.a;
            lastAuditTarget = self._inputs.t;
            lastAuditUserId = self._inputs.u;
            return { recordset: [] };
          }
          return { recordset: [] };
        }
      };
      return self;
    }
  };
  const app = buildApp({ pool, scripts: [] });
  const r = await supertest(app)
    .post('/api/admin/users')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ username: 'charlie', password: 'pw', roleId: 1 });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body, { ok: true });
  assert.ok(auditCalled, 'audit_logs INSERT should have been called');
  assert.equal(lastAuditAction, 'create_user');
  assert.equal(lastAuditTarget, 'charlie');
  assert.equal(lastAuditUserId, 'u1');
});

// ----- UPDATE USER -----

test('PUT /api/admin/users/:id: 200 with payload', async () => {
  const pool = {
    request() {
      const self = {
        _inputs: {},
        input(k, v) { self._inputs[k] = v; return self; },
        async query(q) { return { recordset: [] }; }
      };
      return self;
    }
  };
  const app = buildApp({ pool, scripts: [] });
  const r = await supertest(app)
    .put('/api/admin/users/5')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ status: 0 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
});

// ----- DELETE USER -----

test('DELETE /api/admin/users/:id: 200', async () => {
  const pool = {
    request() {
      const self = {
        _inputs: {},
        input(k, v) { self._inputs[k] = v; return self; },
        async query(q) { return { recordset: [] }; }
      };
      return self;
    }
  };
  const app = buildApp({ pool, scripts: [] });
  const r = await supertest(app)
    .delete('/api/admin/users/5')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
});

// ----- CONFIG -----

test('GET /api/admin/config: 200 returns dict from system_config', async () => {
  const scripts = [
    {
      match: /FROM\s+system_config/i,
      rows: [
        { config_key: 'polling_interval_minutes', config_value: '15' },
        { config_key: 'agent_token', config_value: 'tok-123' }
      ]
    }
  ];
  const pool = buildMockPool(scripts);
  const app = buildApp({ pool, scripts });
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
    request() {
      const self = {
        _inputs: {},
        input(k, v) { self._inputs[k] = v; return self; },
        async query(q) {
          if (/UPDATE\s+system_config/i.test(q)) {
            updateCount++;
            return { recordset: [] };
          }
          return { recordset: [] };
        }
      };
      return self;
    }
  };
  const app = buildApp({ pool, scripts: [] });
  const r = await supertest(app)
    .put('/api/admin/config')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ polling_interval_minutes: '10', agent_token: 'new-tok' });
  assert.equal(r.status, 200);
  assert.equal(updateCount, 2);
});

// ----- AUDIT -----

test('GET /api/admin/audit?limit=5: 200 returns at most 5 rows', async () => {
  const scripts = [
    {
      match: /FROM\s+audit_logs/i,
      rows: [
        { id: 1, user_id: 1, action: 'login', target: 'alice', payload: null, created_at: new Date() },
        { id: 2, user_id: 1, action: 'create_user', target: 'bob', payload: '{"x":1}', created_at: new Date() }
      ]
    }
  ];
  const pool = buildMockPool(scripts);
  const app = buildApp({ pool, scripts });
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
  const pool = {
    request() {
      return {
        _inputs: {},
        input() { return this; },
        async query() { throw new Error('boom'); }
      };
    }
  };
  const app = buildApp({ pool, scripts: [] });
  const r = await supertest(app)
    .get('/api/admin/users')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 500);
  assert.equal(r.body.error, 'internal');
});
