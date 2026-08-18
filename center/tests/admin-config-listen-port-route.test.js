// Unit tests for Task 2 — `GET /api/admin/config` and `PUT /api/admin/config`
// behavior with respect to the listenPort restart-detection contract.
//
// Pins the regression behavior:
//   - GET response includes `restartRequired: { listenPort: <bool> }` derived
//     from the two version hashes. UI depends on the key name + shape.
//   - PUT bumps `center_listen_port_pending_version` when listenPort changes,
//     inside the same transaction as the listenPort UPDATE.
//   - PUT does NOT bump the pending version when listenPort is unchanged or
//     absent from the body (other config keys must not flip the badge).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { adminRouter } from '../src/routes/admin.js';
import { signJwt } from '../src/auth/jwt.js';
import { _setDbForTest } from '../src/db/index.js';
import { buildMockDb } from './helpers/db-mock.js';

const SECRET = 'test-secret-please-do-not-use-in-prod';

function buildApp() {
  const a = express();
  a.use(express.json());
  const config = { jwtSecret: SECRET };
  const logger = { info(){}, error(){}, warn(){}, debug(){} };
  a.use(adminRouter({ config, logger }));
  return a;
}

function adminToken() {
  return signJwt(
    { sub: 'u1', role: 'admin', permissions: ['*'] },
    SECRET,
    60
  );
}

const PAIR_KEYS = /WHERE\s+config_key\s+IN\s*\(\s*'center_listen_port_pending_version'\s*,\s*'center_listen_port_started_version'\s*\)/i;

// ----- GET /api/admin/config -----

test('GET /api/admin/config: response includes restartRequired block derived from version hashes', async () => {
  const db = buildMockDb([
    {
      match: /FROM\s+system_config/i,
      rows: [
        { config_key: 'polling_interval_minutes', config_value: '15' },
        // pending != started → listenPort restart required
        { config_key: 'center_listen_port_pending_version', config_value: 'pending-hash' },
        { config_key: 'center_listen_port_started_version',  config_value: 'started-hash' }
      ]
    }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get('/api/admin/config')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.polling_interval_minutes, '15');
  assert.ok(r.body.restartRequired, 'response must include restartRequired');
  assert.equal(typeof r.body.restartRequired, 'object');
  assert.equal(r.body.restartRequired.listenPort, true);
});

test('GET /api/admin/config: restartRequired.listenPort=false when pending == started', async () => {
  const db = buildMockDb([
    {
      match: /FROM\s+system_config/i,
      rows: [
        { config_key: 'center_listen_port_pending_version', config_value: 'same' },
        { config_key: 'center_listen_port_started_version',  config_value: 'same' }
      ]
    }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get('/api/admin/config')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.restartRequired.listenPort, false);
});

test('GET /api/admin/config: restartRequired.listenPort=false when both version rows absent', async () => {
  const db = buildMockDb([
    { match: /FROM\s+system_config/i, rows: [] }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get('/api/admin/config')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.restartRequired.listenPort, false);
});

// ----- PUT /api/admin/config -----

test('PUT /api/admin/config: bumps center_listen_port_pending_version when listenPort changes', async () => {
  const txCalls = [];
  const { buildSql } = await import('../src/db/sql.js');
  const { AUTH_SUCCESS_ROW, isAuthStatusSelect } = await import('./helpers/db-mock.js');
  const db = {
    dialect: 'mysql',
    sql: buildSql('mysql'),
    async execute() { return { rows: [], affectedRows: 0, insertId: undefined }; },
    async query(sql) {
      // userAuth middleware (Task 5 — I1): per-request token_version/status
      // SELECT. Return an auth-success row so the request gets past the
      // middleware and lands on the route handler.
      if (isAuthStatusSelect(sql)) return { rows: [AUTH_SUCCESS_ROW] };
      // getConfigMap reads via config.getAll — return a `before` snapshot
      // that has the existing listenPort so the change is detected.
      if (/FROM\s+system_config/i.test(sql)) {
        return { rows: [
          { config_key: 'listenPort', config_value: '8080' }
        ] };
      }
      return { rows: [] };
    },
    async transaction(work) {
      const txWrapper = {
        sql: db.sql,
        async execute(sql, params = []) {
          txCalls.push({ sql, params });
          return { rows: [], affectedRows: 1, insertId: undefined };
        },
        // tx.query must also serve the snapshot — the new PUT route reads
        // the pre-image via tx.query(db.sql.config.getAll) inside the same
        // transaction as the write, so the listenPort change-detection and
        // the audit row's before-value see the same rows.
        async query(sql, params = []) {
          txCalls.push({ sql, params });
          if (/FROM\s+system_config/i.test(sql)) {
            return { rows: [
              { config_key: 'listenPort', config_value: '8080' }
            ] };
          }
          return { rows: [] };
        }
      };
      return await work(txWrapper);
    },
    async healthcheck() {},
    async close() {}
  };
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .put('/api/admin/config')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ listenPort: '9090' });
  assert.equal(r.status, 200);
  // Inside the transaction: UPDATE for listenPort + audit.write + the upsert
  // for the pending version hash.
  const upsertPending = txCalls.find(c =>
    /INSERT\s+INTO\s+system_config|MERGE\s+INTO\s+system_config/i.test(c.sql) &&
    c.params[0] === 'center_listen_port_pending_version'
  );
  assert.ok(upsertPending, 'pending_version upsert must be issued inside the transaction');
  // Hash value is 16 hex chars derived from `<iso>:<listenPort>`.
  assert.match(upsertPending.params[1], /^[0-9a-f]{16}$/);
});

test('PUT /api/admin/config: does NOT bump pending version when listenPort unchanged', async () => {
  const txCalls = [];
  const { buildSql } = await import('../src/db/sql.js');
  const { AUTH_SUCCESS_ROW, isAuthStatusSelect } = await import('./helpers/db-mock.js');
  const db = {
    dialect: 'mysql',
    sql: buildSql('mysql'),
    async execute() { return { rows: [], affectedRows: 0, insertId: undefined }; },
    async query(sql) {
      if (isAuthStatusSelect(sql)) return { rows: [AUTH_SUCCESS_ROW] };
      if (/FROM\s+system_config/i.test(sql)) {
        return { rows: [
          { config_key: 'listenPort', config_value: '8080' }
        ] };
      }
      return { rows: [] };
    },
    async transaction(work) {
      const txWrapper = {
        sql: db.sql,
        async execute(sql, params = []) {
          txCalls.push({ sql, params });
          return { rows: [], affectedRows: 1, insertId: undefined };
        },
        async query(sql) {
          txCalls.push({ sql });
          if (/FROM\s+system_config/i.test(sql)) {
            return { rows: [
              { config_key: 'listenPort', config_value: '8080' }
            ] };
          }
          return { rows: [] };
        }
      };
      return await work(txWrapper);
    },
    async healthcheck() {},
    async close() {}
  };
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .put('/api/admin/config')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ listenPort: '8080' }); // same as before
  assert.equal(r.status, 200);
  const upsertPending = txCalls.find(c =>
    /INSERT\s+INTO\s+system_config|MERGE\s+INTO\s+system_config/i.test(c.sql) &&
    c.params[0] === 'center_listen_port_pending_version'
  );
  assert.strictEqual(upsertPending, undefined,
    'pending_version must NOT be bumped when listenPort is unchanged');
});

test('PUT /api/admin/config: does NOT touch pending version when listenPort not in body', async () => {
  const txCalls = [];
  const { buildSql } = await import('../src/db/sql.js');
  const { AUTH_SUCCESS_ROW, isAuthStatusSelect } = await import('./helpers/db-mock.js');
  const db = {
    dialect: 'mysql',
    sql: buildSql('mysql'),
    async execute() { return { rows: [], affectedRows: 0, insertId: undefined }; },
    async query(sql) {
      if (isAuthStatusSelect(sql)) return { rows: [AUTH_SUCCESS_ROW] };
      if (/FROM\s+system_config/i.test(sql)) {
        return { rows: [
          { config_key: 'listenPort', config_value: '8080' }
        ] };
      }
      return { rows: [] };
    },
    async transaction(work) {
      const txWrapper = {
        sql: db.sql,
        async execute(sql, params = []) {
          txCalls.push({ sql, params });
          return { rows: [], affectedRows: 1, insertId: undefined };
        },
        async query(sql) {
          txCalls.push({ sql });
          if (/FROM\s+system_config/i.test(sql)) {
            return { rows: [
              { config_key: 'listenPort', config_value: '8080' }
            ] };
          }
          return { rows: [] };
        }
      };
      return await work(txWrapper);
    },
    async healthcheck() {},
    async close() {}
  };
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .put('/api/admin/config')
    .set('Authorization', `Bearer ${adminToken()}`)
    .send({ polling_interval_minutes: '20' }); // listenPort not in body
  assert.equal(r.status, 200);
  const upsertPending = txCalls.find(c =>
    /INSERT\s+INTO\s+system_config|MERGE\s+INTO\s+system_config/i.test(c.sql) &&
    c.params[0] === 'center_listen_port_pending_version'
  );
  assert.strictEqual(upsertPending, undefined,
    'pending_version must NOT be touched when listenPort is absent from the PUT body');
});

// Suppress lint warnings about the unused pair-keys regex (kept for readability
// of related tests in this file).
void PAIR_KEYS;
