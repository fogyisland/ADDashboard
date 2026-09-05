// 2026-09-05 R81 — admin route tests for /api/admin/member-commands/*.
//
// Four endpoints:
//   POST /api/admin/member-commands              (queue)
//   GET  /api/admin/member-commands              (list)
//   GET  /api/admin/member-commands/:id          (single)
//   GET  /api/admin/member-commands/hosts        (host picker)
//
// All auth-gated with userAuth + requirePerm('admin:users'). Mirrors
// the pattern in tests/routes/admin-ad-commands.test.js (R75).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import supertest from 'supertest';

import { signJwt } from '../../src/auth/jwt.js';
import { _setDbForTest } from '../../src/db/index.js';
import { buildMockDb } from '../helpers/db-mock.js';

import { adminRouter } from '../../src/routes/admin.js';

const SECRET = 'test-secret';

function adminToken(sub = 'u1') {
  return signJwt({ sub, role: 'admin', permissions: ['*'] }, SECRET, 60);
}

function makeDb({ hostsOnline = new Set() } = {}) {
  const auditRows = [];
  const inserted = [];
  const db = buildMockDb([
    {
      // hostname-online check (5min window): returns 1 row when online.
      match: /last_heartbeat_at\s+>=\s+UTC_TIMESTAMP\(\)\s*-\s*INTERVAL\s+5\s+MINUTE/i,
      rows: (params) => hostsOnline.has(params[0])
        ? [{ last_heartbeat_at: new Date().toISOString() }]
        : []
    },
    {
      // lastHeartbeatAt read-back for the 503 body.
      match: /SELECT\s+last_heartbeat_at\s+FROM\s+ad_agent_heartbeat/i,
      rows: () => []
    },
    {
      // rate-limit pre-check (countRecentForHost). For the happy path
      // we return 0 so the service queues; for rate-limit tests the
      // route stub is overridden.
      match: /COUNT\(\*\)\s+AS\s+n\s+FROM\s+ad_member_commands/i,
      rows: () => [{ n: 0 }]
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
    if (/INSERT\s+INTO\s+ad_member_commands/i.test(sql)) {
      const row = {
        id: 200 + inserted.length,
        hostname: params[0],
        command_type: params[1],
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
  const origQuery = db.query;
  db.query = async (sql, params = []) => {
    if (/FROM\s+ad_member_commands\s+c\s+LEFT\s+JOIN\s+sys_users/i.test(sql)) {
      const idMatch = sql.match(/WHERE\s+c\.id\s*=\s*\?/i);
      const hostMatch = sql.match(/WHERE\s+c\.hostname\s*=\s*\?/i);
      if (idMatch) {
        const id = Number(params[0]);
        const row = inserted.find(r => r.id === id);
        return { rows: row ? [row] : [] };
      }
      if (hostMatch) {
        const hostname = params.find(p => typeof p === 'string');
        return { rows: inserted.filter(r => r.hostname === hostname).reverse() };
      }
      return { rows: [...inserted].reverse() };
    }
    if (/SELECT\s+COUNT\(\*\)/i.test(sql)) {
      return { rows: [{ total: inserted.length }] };
    }
    if (/FROM\s+ad_agent_heartbeat\s+WHERE\s+agent_id/i.test(sql)) {
      // hosts list (tokenDeliveryList pattern). Return all known hosts.
      return {
        rows: [...hostsOnline].map(h => ({
          agent_id: h,
          last_heartbeat_at: new Date().toISOString()
        }))
      };
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

test('admin POST /api/admin/member-commands: 401 without auth', async () => {
  const db = makeDb({ hostsOnline: new Set(['HUB']) });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/admin/member-commands')
    .send({ hostname: 'HUB', params: { script: 'Get-Date' } });
  assert.equal(r.status, 401);
});

test('admin POST /api/admin/member-commands: 403 for non-admin role', async () => {
  const db = makeDb({ hostsOnline: new Set(['HUB']) });
  _setDbForTest(db);
  const nonAdminToken = signJwt({ sub: 'u2', role: 'viewer', permissions: [] }, SECRET, 60);
  const r = await supertest(buildApp(db))
    .post('/api/admin/member-commands')
    .set('Authorization', `Bearer ${nonAdminToken}`)
    .send({ hostname: 'HUB', params: { script: 'Get-Date' } });
  assert.equal(r.status, 403);
});

// ── Happy path ──────────────────────────────────────────────────────────

test('admin POST /api/admin/member-commands: 201 + queued row + audit row', async () => {
  const db = makeDb({ hostsOnline: new Set(['HUB']) });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/admin/member-commands')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({
      hostname: 'HUB',
      params: { script: 'Get-Date', timeoutSec: 15 }
    });
  assert.equal(r.status, 201);
  assert.equal(r.body.hostname, 'HUB');
  assert.equal(r.body.commandType, 'member_script');
  assert.equal(r.body.status, 'queued');
  assert.ok(r.body.id > 0);
  assert.ok(r.body.createdAt);
  // audit row
  const queued = db.auditRows.find(a => a.action === 'ad_member_command_queued');
  assert.ok(queued, 'must emit ad_member_command_queued audit row');
  assert.equal(queued.userId, 'u1');
  assert.equal(queued.target, 'host:HUB');
  assert.equal(queued.payload.hostname, 'HUB');
  assert.equal(queued.payload.commandType, 'member_script');
  assert.equal(queued.payload.timeoutSec, 15);
  assert.ok(typeof queued.payload.scriptSummary === 'string');
});

test('admin POST /api/admin/member-commands: 400 when hostname missing', async () => {
  const db = makeDb({ hostsOnline: new Set() });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/admin/member-commands')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ params: { script: 'Get-Date' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /hostname/);
});

test('admin POST /api/admin/member-commands: 503 when hostname has no online agent', async () => {
  const db = makeDb({ hostsOnline: new Set() });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/admin/member-commands')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ hostname: 'OFFLINE', params: { script: 'Get-Date' } });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /no agent currently online/);
});

test('admin POST /api/admin/member-commands: ?force=true bypasses online check', async () => {
  const db = makeDb({ hostsOnline: new Set() });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/admin/member-commands?force=true')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ hostname: 'OFFLINE', params: { script: 'Get-Date' } });
  assert.equal(r.status, 201);
});

test('admin POST /api/admin/member-commands: 400 when script > 32KB', async () => {
  const db = makeDb({ hostsOnline: new Set(['H']) });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/admin/member-commands')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ hostname: 'H', params: { script: 'x'.repeat(33 * 1024) } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /exceeds/);
});

test('admin POST /api/admin/member-commands: 400 when timeoutSec out of range', async () => {
  const db = makeDb({ hostsOnline: new Set(['H']) });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/admin/member-commands')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ hostname: 'H', params: { script: 'Get-Date', timeoutSec: 1 } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /timeoutSec/);
});

// ── List endpoint ───────────────────────────────────────────────────────

test('admin GET /api/admin/member-commands: returns rows + total + page meta', async () => {
  const db = makeDb({ hostsOnline: new Set(['H1', 'H2']) });
  _setDbForTest(db);
  // Seed one row.
  await supertest(buildApp(db))
    .post('/api/admin/member-commands')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ hostname: 'H1', params: { script: 'Get-Date' } });
  const r = await supertest(buildApp(db))
    .get('/api/admin/member-commands?hostname=H1')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 1);
  assert.equal(r.body.rows.length, 1);
  assert.equal(r.body.rows[0].hostname, 'H1');
  assert.equal(r.body.rows[0].commandType, 'member_script');
});

// ── Single endpoint ─────────────────────────────────────────────────────

test('admin GET /api/admin/member-commands/:id: returns parsed params_json', async () => {
  const db = makeDb({ hostsOnline: new Set(['H1']) });
  _setDbForTest(db);
  const queued = await supertest(buildApp(db))
    .post('/api/admin/member-commands')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ hostname: 'H1', params: { script: 'Get-Date', timeoutSec: 15 } });
  const r = await supertest(buildApp(db))
    .get(`/api/admin/member-commands/${queued.body.id}`)
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.id, queued.body.id);
  assert.deepEqual(r.body.params, { script: 'Get-Date', timeoutSec: 15 });
});

test('admin GET /api/admin/member-commands/:id: 404 for unknown id', async () => {
  const db = makeDb({ hostsOnline: new Set() });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .get('/api/admin/member-commands/999')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 404);
});

test('admin GET /api/admin/member-commands/:id: 400 for invalid id', async () => {
  const db = makeDb({ hostsOnline: new Set() });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .get('/api/admin/member-commands/abc')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 400);
});

// ── Hosts list ──────────────────────────────────────────────────────────

test('admin GET /api/admin/member-commands/hosts: returns heartbeat-known hosts', async () => {
  const db = makeDb({ hostsOnline: new Set(['H1', 'H2']) });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .get('/api/admin/member-commands/hosts')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.hosts));
  const names = r.body.hosts.map(h => h.hostname).sort();
  assert.deepEqual(names, ['H1', 'H2']);
});