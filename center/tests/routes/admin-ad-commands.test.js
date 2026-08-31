// 2026-08-31 R75 — admin route tests for /api/admin/ad-commands/*.
//
// Three endpoints:
//   POST /api/admin/ad-commands         (queue)
//   GET  /api/admin/ad-commands         (list)
//   GET  /api/admin/ad-commands/:id     (single)
//
// All auth-gated with userAuth + requirePerm('admin:users'). Tests use
// the existing buildMockDb + signJwt pattern from tests/file-push.test.js.
// The db facade intercepts INSERT INTO audit_logs to capture rows for
// assertions (matches the file-push test convention).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import supertest from 'supertest';

import { signJwt } from '../../src/auth/jwt.js';
import { _setDbForTest } from '../../src/db/index.js';
import { buildMockDb } from '../helpers/db-mock.js';

import { adminRouter } from '../../src/routes/admin.js';

// ── Test plumbing ────────────────────────────────────────────────────────

const SECRET = 'test-secret';

function adminToken(sub = 'u1') {
  return signJwt({ sub, role: 'admin', permissions: ['*'] }, SECRET, 60);
}

// Tracks the in-memory ad_admin_commands rows so we can assert what got
// queued across requests. Each entry mirrors the SQL helper column shape.
function makeDb({ dcsOnline = new Set() } = {}) {
  const auditRows = [];
  const inserted = [];
  const db = buildMockDb([
    {
      // DC-online check: spec §2.5 ruling #10.
      match: /last_heartbeat_at\s+>=\s+UTC_TIMESTAMP\(\)\s*-\s*INTERVAL\s+5\s+MINUTE/i,
      rows: (params) => dcsOnline.has(params[0])
        ? [{ last_heartbeat_at: new Date().toISOString() }]
        : []
    },
    {
      // Read-back of last heartbeat for the 503 body (any DC).
      match: /SELECT\s+last_heartbeat_at\s+FROM\s+ad_agent_heartbeat/i,
      rows: () => []
    }
  ]).standard();

  const origExecute = db.execute;
  db.execute = async (sql, params = []) => {
    if (/INSERT\s+INTO\s+audit_logs/i.test(sql)) {
      const payloadStr = params[3];
      let parsed = null;
      if (typeof payloadStr === 'string') {
        try { parsed = JSON.parse(payloadStr); } catch { parsed = payloadStr; }
      } else if (payloadStr && typeof payloadStr === 'object') {
        parsed = payloadStr;
      }
      auditRows.push({
        userId: params[0],
        action: params[1],
        target: params[2],
        payload: parsed
      });
      return { rows: [], affectedRows: 1 };
    }
    if (/INSERT\s+INTO\s+ad_admin_commands/i.test(sql)) {
      const row = {
        id: 100 + inserted.length,
        command_type: params[0],
        target_dc: params[1],
        params_json: params[2],
        status: 'queued',
        operator_id: params[3],
        operator_username: null,
        result_json: null,
        error_message: null,
        duration_ms: null,
        created_at: new Date().toISOString(),
        claimed_at: null,
        completed_at: null
      };
      inserted.push(row);
      return { rows: [], affectedRows: 1, insertId: row.id };
    }
    return origExecute(sql, params);
  };
  // Patch query to expose inserted rows for the list/single endpoints.
  const origQuery = db.query;
  db.query = async (sql, params = []) => {
    if (/FROM\s+ad_admin_commands\s+c\s+LEFT\s+JOIN\s+sys_users/i.test(sql)) {
      // getById or listBy*.
      const idMatch = sql.match(/WHERE\s+c\.id\s*=\s*\?/i);
      if (idMatch) {
        const id = Number(params[0]);
        const row = inserted.find(r => r.id === id);
        return { rows: row ? [row] : [] };
      }
      // No WHERE → listAll.
      return { rows: [...inserted].reverse() };
    }
    if (/SELECT\s+COUNT\(\*\)/i.test(sql)) {
      return { rows: [{ total: inserted.length }] };
    }
    return origQuery(sql, params);
  };
  db.auditRows = auditRows;
  db.inserted = inserted;
  return db;
}

function buildApp(db) {
  const a = express();
  a.use(express.json());
  return a.use(adminRouter({
    config: { jwtSecret: SECRET },
    logger: { info(){}, error(){}, warn(){}, debug(){} },
    db
  }));
}

// ── Auth ────────────────────────────────────────────────────────────────

test('admin POST /api/admin/ad-commands: 401 without auth', async () => {
  const db = makeDb({ dcsOnline: new Set(['HUB']) });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/admin/ad-commands')
    .send({ targetDc: 'HUB', commandType: 'user_search', params: { filter: 'a' } });
  assert.equal(r.status, 401);
});

test('admin POST /api/admin/ad-commands: 403 for non-admin role', async () => {
  const db = makeDb({ dcsOnline: new Set(['HUB']) });
  _setDbForTest(db);
  const nonAdminToken = signJwt({ sub: 'u2', role: 'viewer', permissions: [] }, SECRET, 60);
  const r = await supertest(buildApp(db))
    .post('/api/admin/ad-commands')
    .set('Authorization', `Bearer ${nonAdminToken}`)
    .send({ targetDc: 'HUB', commandType: 'user_search', params: { filter: 'a' } });
  assert.equal(r.status, 403);
});

// ── Happy path ──────────────────────────────────────────────────────────

test('admin POST /api/admin/ad-commands: happy 201 + returns id+queued status', async () => {
  const db = makeDb({ dcsOnline: new Set(['HUB']) });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/admin/ad-commands')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ targetDc: 'HUB', commandType: 'user_search', params: { filter: 'admin' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.commandType, 'user_search');
  assert.equal(r.body.targetDc, 'HUB');
  assert.equal(r.body.status, 'queued');
  assert.ok(r.body.id > 0);
});

// ── 400 paths ───────────────────────────────────────────────────────────

test('admin POST: 400 when targetDc missing', async () => {
  const db = makeDb({ dcsOnline: new Set(['HUB']) });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/admin/ad-commands')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ commandType: 'user_search', params: { filter: 'a' } });
  assert.equal(r.status, 400);
});

test('admin POST: 400 on unknown commandType', async () => {
  const db = makeDb({ dcsOnline: new Set(['HUB']) });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/admin/ad-commands')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ targetDc: 'HUB', commandType: 'fake_command', params: {} });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /unknown command_type/);
});

test('admin POST: 400 when params invalid (user_create missing password)', async () => {
  const db = makeDb({ dcsOnline: new Set(['HUB']) });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/admin/ad-commands')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ targetDc: 'HUB', commandType: 'user_create', params: { sam: 'jdoe' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /password/);
});

// ── 503 path ────────────────────────────────────────────────────────────

test('admin POST: 503 when DC offline (no heartbeat within 5min)', async () => {
  const db = makeDb({ dcsOnline: new Set() }); // no DCs online
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/admin/ad-commands')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ targetDc: 'OFFLINE', commandType: 'user_search', params: { filter: 'a' } });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /no agent currently online/);
});

test('admin POST: ?force=true bypasses DC-online check', async () => {
  const db = makeDb({ dcsOnline: new Set() }); // no DCs online
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/admin/ad-commands?force=true')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ targetDc: 'OFFLINE', commandType: 'user_search', params: { filter: 'a' } });
  assert.equal(r.status, 201);
});

// ── Audit row ───────────────────────────────────────────────────────────

test('admin POST: writes audit row derived from commandType', async () => {
  const db = makeDb({ dcsOnline: new Set(['HUB']) });
  _setDbForTest(db);
  await supertest(buildApp(db))
    .post('/api/admin/ad-commands')
    .set('Authorization', `Bearer ${adminToken('u-7')}`)
    .send({ targetDc: 'HUB', commandType: 'user_create', params: { sam: 'jdoe', password: 'P@ssw' } });
  const created = db.auditRows.find(x => x.action === 'ad_user_create');
  assert.ok(created, 'ad_user_create audit row must be present');
  assert.equal(created.userId, 'u-7');
  // Target is the sam (matches spec §3.2 table).
  assert.equal(created.target, 'jdoe');
  // Password is REDACTED in the audit payload — never cleartext.
  assert.equal(created.payload.paramsSummary.password.passwordLength, 5);
  assert.equal(created.payload.paramsSummary.password.hasPassword, true);
});

test('admin POST: audit row for user_search targets dc:<targetDc>', async () => {
  const db = makeDb({ dcsOnline: new Set(['HUB']) });
  _setDbForTest(db);
  await supertest(buildApp(db))
    .post('/api/admin/ad-commands')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ targetDc: 'HUB', commandType: 'user_search', params: { filter: 'a' } });
  const r = db.auditRows.find(x => x.action === 'ad_user_search');
  assert.equal(r.target, 'dc:HUB');
});

// ── GET list / single ───────────────────────────────────────────────────

test('admin GET /api/admin/ad-commands: returns paginated list', async () => {
  const db = makeDb({ dcsOnline: new Set(['HUB']) });
  _setDbForTest(db);
  const app = buildApp(db);
  // Seed two rows
  await supertest(app).post('/api/admin/ad-commands')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ targetDc: 'HUB', commandType: 'user_search', params: { filter: 'a' } });
  await supertest(app).post('/api/admin/ad-commands')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ targetDc: 'HUB', commandType: 'user_search', params: { filter: 'b' } });
  const list = await supertest(app).get('/api/admin/ad-commands')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 2);
  assert.equal(list.body.rows.length, 2);
  // result_json not exposed in list view
  assert.equal(list.body.rows[0].result, undefined);
});

test('admin GET /api/admin/ad-commands/:id: returns full row incl. params+result', async () => {
  const db = makeDb({ dcsOnline: new Set(['HUB']) });
  _setDbForTest(db);
  const app = buildApp(db);
  const queued = await supertest(app).post('/api/admin/ad-commands')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ targetDc: 'HUB', commandType: 'user_search', params: { filter: 'a' } });
  const id = queued.body.id;
  const got = await supertest(app).get(`/api/admin/ad-commands/${id}`)
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.id, id);
  assert.equal(got.body.params.filter, 'a');
});

test('admin GET /api/admin/ad-commands/:id: 404 for unknown id', async () => {
  const db = makeDb({ dcsOnline: new Set(['HUB']) });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .get('/api/admin/ad-commands/999')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 404);
});

test('admin GET /api/admin/ad-commands/:id: 400 for invalid id', async () => {
  const db = makeDb({ dcsOnline: new Set(['HUB']) });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .get('/api/admin/ad-commands/abc')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 400);
});