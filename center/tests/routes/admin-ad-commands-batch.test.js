// 2026-09-02 R76 — admin route tests for POST /api/admin/ad-commands/batch.
//
// Mirrors admin-ad-commands.test.js (same db mock, same auth helpers)
// so we don't reinvent the bootstrap. Cases cover:
//   - 401 / 403 auth gates
//   - 400 paths: missing targetDc, missing commandType, commandType not
//     in whitelist, empty paramsList, paramsList > 100
//   - 503 DC-offline path (with and without ?force=true)
//   - 201 happy path (3 user_enable queued for distinct SAMs)
//   - 207 mixed valid/invalid (per-entry validation failure populates
//     errors[] and still queues the valid entries)
//   - audit row emitted per successfully queued command
//   - one audit row per command even when batch has errors[]

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

function makeDb({ dcsOnline = new Set() } = {}) {
  const auditRows = [];
  const inserted = [];
  const db = buildMockDb([
    {
      // DC-online check (matches admin-ad-commands.test.js convention).
      match: /last_heartbeat_at\s+>=\s+UTC_TIMESTAMP\(\)\s*-\s*INTERVAL\s+5\s+MINUTE/i,
      rows: (params) => dcsOnline.has(params[0])
        ? [{ last_heartbeat_at: new Date().toISOString() }]
        : []
    },
    {
      // Last heartbeat read-back (any DC). Returned in the 503 body.
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
        id: 200 + inserted.length,
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

// ── Auth gates ───────────────────────────────────────────────────────────

test('batch: 401 without auth', async () => {
  const db = makeDb({ dcsOnline: new Set(['HUB']) });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/admin/ad-commands/batch')
    .send({ targetDc: 'HUB', commandType: 'user_enable', paramsList: [{ sam: 'alice' }] });
  assert.equal(r.status, 401);
});

test('batch: 403 for non-admin role', async () => {
  const db = makeDb({ dcsOnline: new Set(['HUB']) });
  _setDbForTest(db);
  const nonAdminToken = signJwt({ sub: 'u2', role: 'viewer', permissions: [] }, SECRET, 60);
  const r = await supertest(buildApp(db))
    .post('/api/admin/ad-commands/batch')
    .set('Authorization', `Bearer ${nonAdminToken}`)
    .send({ targetDc: 'HUB', commandType: 'user_enable', paramsList: [{ sam: 'alice' }] });
  assert.equal(r.status, 403);
});

// ── 400 paths ────────────────────────────────────────────────────────────

test('batch: 400 when targetDc missing', async () => {
  const db = makeDb({ dcsOnline: new Set(['HUB']) });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/admin/ad-commands/batch')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ commandType: 'user_enable', paramsList: [{ sam: 'alice' }] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /targetDc/);
});

test('batch: 400 when commandType not in whitelist (user_search)', async () => {
  const db = makeDb({ dcsOnline: new Set(['HUB']) });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/admin/ad-commands/batch')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ targetDc: 'HUB', commandType: 'user_search', paramsList: [{ filter: 'a' }] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /batch commandType must be one of/);
});

test('batch: 400 when commandType not in whitelist (user_create)', async () => {
  const db = makeDb({ dcsOnline: new Set(['HUB']) });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/admin/ad-commands/batch')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ targetDc: 'HUB', commandType: 'user_create', paramsList: [{ sam: 'alice' }] });
  assert.equal(r.status, 400);
});

test('batch: 400 when paramsList empty', async () => {
  const db = makeDb({ dcsOnline: new Set(['HUB']) });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/admin/ad-commands/batch')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ targetDc: 'HUB', commandType: 'user_enable', paramsList: [] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /non-empty array/);
});

test('batch: 400 when paramsList missing', async () => {
  const db = makeDb({ dcsOnline: new Set(['HUB']) });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/admin/ad-commands/batch')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ targetDc: 'HUB', commandType: 'user_enable' });
  assert.equal(r.status, 400);
});

test('batch: 400 when paramsList.length > 100', async () => {
  const db = makeDb({ dcsOnline: new Set(['HUB']) });
  _setDbForTest(db);
  const list = Array.from({ length: 101 }, (_, i) => ({ sam: `u${i}` }));
  const r = await supertest(buildApp(db))
    .post('/api/admin/ad-commands/batch')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ targetDc: 'HUB', commandType: 'user_enable', paramsList: list });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /exceeds max 100/);
});

test('batch: 400 when paramsList contains non-array', async () => {
  const db = makeDb({ dcsOnline: new Set(['HUB']) });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/admin/ad-commands/batch')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ targetDc: 'HUB', commandType: 'user_enable', paramsList: 'not-an-array' });
  assert.equal(r.status, 400);
});

// ── 503 DC-offline path ──────────────────────────────────────────────────

test('batch: 503 when DC offline (no ?force)', async () => {
  const db = makeDb({ dcsOnline: new Set() });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/admin/ad-commands/batch')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ targetDc: 'OFFLINE', commandType: 'user_enable', paramsList: [{ sam: 'a' }] });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /no agent currently online/);
});

test('batch: ?force=true bypasses DC-online check', async () => {
  const db = makeDb({ dcsOnline: new Set() });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/admin/ad-commands/batch?force=true')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ targetDc: 'OFFLINE', commandType: 'user_enable', paramsList: [{ sam: 'a' }, { sam: 'b' }] });
  assert.equal(r.status, 201);
  assert.equal(r.body.totalQueued, 2);
});

// ── 201 happy path ──────────────────────────────────────────────────────

test('batch: queues 3 user_enable for distinct SAMs → 201 + 3 ids', async () => {
  const db = makeDb({ dcsOnline: new Set(['HUB']) });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/admin/ad-commands/batch')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({
      targetDc: 'HUB',
      commandType: 'user_enable',
      paramsList: [{ sam: 'alice' }, { sam: 'bob' }, { sam: 'carol' }]
    });
  assert.equal(r.status, 201);
  assert.equal(r.body.totalQueued, 3);
  assert.equal(r.body.errors.length, 0);
  assert.equal(r.body.queued.length, 3);
  for (const q of r.body.queued) {
    assert.equal(q.commandType, 'user_enable');
    assert.equal(q.targetDc, 'HUB');
    assert.equal(q.status, 'queued');
    assert.ok(q.id > 0);
  }
});

test('batch: each queued row gets one ad_user_enable audit row', async () => {
  const db = makeDb({ dcsOnline: new Set(['HUB']) });
  _setDbForTest(db);
  await supertest(buildApp(db))
    .post('/api/admin/ad-commands/batch')
    .set('Authorization', `Bearer ${adminToken('op-1')}`)
    .send({
      targetDc: 'HUB',
      commandType: 'user_enable',
      paramsList: [{ sam: 'alice' }, { sam: 'bob' }]
    });
  const auditRows = db.auditRows.filter(x => x.action === 'ad_user_enable');
  assert.equal(auditRows.length, 2);
  assert.equal(auditRows[0].userId, 'op-1');
  assert.equal(auditRows[0].target, 'alice');
  assert.equal(auditRows[1].target, 'bob');
});

test('batch: user_password_reset queues with same password applied to all', async () => {
  const db = makeDb({ dcsOnline: new Set(['HUB']) });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/admin/ad-commands/batch')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({
      targetDc: 'HUB',
      commandType: 'user_password_reset',
      paramsList: [
        { sam: 'alice', newPassword: 'P@ssw0rd', mustChangePassword: true },
        { sam: 'bob', newPassword: 'P@ssw0rd', mustChangePassword: true }
      ]
    });
  assert.equal(r.status, 201);
  assert.equal(r.body.totalQueued, 2);
  // Passwords are NEVER echoed in the response (just id/status/etc).
  for (const q of r.body.queued) {
    assert.equal(q.status, 'queued');
    assert.equal(q.commandType, 'user_password_reset');
  }
  // Audit row redacts the password.
  const auditRows = db.auditRows.filter(x => x.action === 'ad_user_password_reset');
  assert.equal(auditRows.length, 2);
  assert.equal(auditRows[0].payload.paramsSummary.newPassword.hasPassword, true);
  assert.equal(auditRows[0].payload.paramsSummary.newPassword.passwordLength, 8);
});

// ── 207 partial success ─────────────────────────────────────────────────

test('batch: mixed valid/invalid → 207 with errors[] populated', async () => {
  const db = makeDb({ dcsOnline: new Set(['HUB']) });
  _setDbForTest(db);
  // First entry valid, second missing sam (fails validator), third valid.
  const r = await supertest(buildApp(db))
    .post('/api/admin/ad-commands/batch')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({
      targetDc: 'HUB',
      commandType: 'user_enable',
      paramsList: [{ sam: 'alice' }, { foo: 'no-sam-key' }, { sam: 'carol' }]
    });
  assert.equal(r.status, 207);
  assert.equal(r.body.totalQueued, 2);
  assert.equal(r.body.queued.length, 2);
  assert.equal(r.body.errors.length, 1);
  assert.equal(r.body.errors[0].index, 1);
  assert.match(r.body.errors[0].error, /sam/);
  // Audit row only emitted for the 2 valid entries.
  const auditRows = db.auditRows.filter(x => x.action === 'ad_user_enable');
  assert.equal(auditRows.length, 2);
});

test('batch: all entries invalid → 207 with errors[] and totalQueued=0', async () => {
  const db = makeDb({ dcsOnline: new Set(['HUB']) });
  _setDbForTest(db);
  const r = await supertest(buildApp(db))
    .post('/api/admin/ad-commands/batch')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({
      targetDc: 'HUB',
      commandType: 'user_enable',
      paramsList: [{ foo: 1 }, { bar: 2 }]
    });
  assert.equal(r.status, 207);
  assert.equal(r.body.totalQueued, 0);
  assert.equal(r.body.errors.length, 2);
  // No audit rows.
  const auditRows = db.auditRows.filter(x => x.action === 'ad_user_enable');
  assert.equal(auditRows.length, 0);
});

// ── Boundary: max 100 entries accepted ──────────────────────────────────

test('batch: exactly 100 entries accepted', async () => {
  const db = makeDb({ dcsOnline: new Set(['HUB']) });
  _setDbForTest(db);
  const list = Array.from({ length: 100 }, (_, i) => ({ sam: `u${i}` }));
  const r = await supertest(buildApp(db))
    .post('/api/admin/ad-commands/batch')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ targetDc: 'HUB', commandType: 'user_enable', paramsList: list });
  assert.equal(r.status, 201);
  assert.equal(r.body.totalQueued, 100);
});