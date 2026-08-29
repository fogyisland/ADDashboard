// router-v2.test.js — admin /api/admin/orphan-schemas CRUD only.
//
// R66 T13 cleanup: the V0 ZIP-installer endpoints (install / upgrade /
// ddl-preview / params / interval / uninstall with confirmDropSchema)
// were retired along with the V0 ZIP wrapper. The orphan-schemas CRUD
// (orphan-router.js) is independent of the V0/V1 split and stays
// covered here.
//
// Pattern follows router.test.js (supertest + admin token). Mock-DB
// only — orphan-schemas CRUD never needs a live DB.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { buildMockDb } from '../helpers/db-mock.js';
import { orphanRouter } from '../../src/packages/orphan-router.js';
import { signJwt } from '../../src/auth/jwt.js';

// I9 — Task 1: see tests/e2e/plugin-system.test.js. Match the buildMockDb
// default jwt_secret_current='test-secret' so userAuth accepts our tokens.
const SECRET = 'test-secret';
const noopLogger = () => ({ info() {}, warn() {}, error() {}, debug() {} });

function adminToken() {
  return signJwt({ sub: 'u1', role: 'admin', permissions: ['*'] }, SECRET, 60);
}
function operatorToken() {
  return signJwt({ sub: 'u2', role: 'operator', permissions: ['read:dash'] }, SECRET, 60);
}
function adminAuth() {
  return { Authorization: `Bearer ${adminToken()}` };
}

function buildApp(db) {
  const app = express();
  app.use(express.json());
  app.use(orphanRouter({
    db,
    config: { jwtSecret: SECRET },
    logger: noopLogger()
  }));
  return app;
}

// ─────────────────────────────────────────────────────────────────────
// Mock-DB tests: orphan-schemas CRUD endpoints (no live DB needed).
// ─────────────────────────────────────────────────────────────────────

describe('admin /api/admin/orphan-schemas (mock DB)', () => {
  describe('GET /orphan-schemas', () => {
    test('returns list of orphans', async () => {
      const db = buildMockDb([
        {
          match: /FROM\s+orphan_schemas/i,
          rows: [
            { name: 'pkg_foo', last_seen_at: new Date('2026-08-01'), note: 'drop failed' },
            { name: 'pkg_bar', last_seen_at: new Date('2026-08-02'), note: null }
          ]
        }
      ]).standard();
      const app = buildApp(db);
      const r = await supertest(app).get('/api/admin/orphan-schemas').set(adminAuth());
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.body.schemas));
      assert.equal(r.body.schemas.length, 2);
      assert.equal(r.body.schemas[0].name, 'pkg_foo');
    });

    test('401 when no Authorization header', async () => {
      const db = buildMockDb([]).standard();
      const app = buildApp(db);
      const r = await supertest(app).get('/api/admin/orphan-schemas');
      assert.equal(r.status, 401);
    });

    test('403 for operator token (missing admin:packages perm)', async () => {
      const db = buildMockDb([]).standard();
      const app = buildApp(db);
      const r = await supertest(app)
        .get('/api/admin/orphan-schemas')
        .set('Authorization', `Bearer ${operatorToken()}`);
      assert.equal(r.status, 403);
    });
  });

  describe('DELETE /orphan-schemas/:name', () => {
    test('drops schema + deletes row, returns ok', async () => {
      // Track which queries fired so we can assert both DROP SCHEMA and
      // DELETE FROM orphan_schemas were issued.
      const records = [];
      const db = buildMockDb([
        // schemaExists (introspection) — handled by the mock's default
        // empty result, dropSchema swallows "doesn't exist" so this is OK
        // without a row.
      ]).withRecording(records);
      const app = buildApp(db);
      const r = await supertest(app).delete('/api/admin/orphan-schemas/pkg_foo').set(adminAuth());
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      // Must have issued DROP DATABASE/SCHEMA for pkg_foo — dropSchema
      // interpolates the schema name into the SQL string (not a param)
      // for safety (no escaping needed for trusted names).
      const dropped = records.find(rec =>
        /DROP\s+(DATABASE|SCHEMA)\s+[`[]?pkg_foo[`\]]?/i.test(rec.sql)
      );
      assert.ok(dropped, 'expected DROP DATABASE/SCHEMA for pkg_foo');
      // Must have deleted the row
      const deleted = records.find(rec =>
        /DELETE\s+FROM\s+orphan_schemas/i.test(rec.sql) && rec.params[0] === 'pkg_foo'
      );
      assert.ok(deleted, 'expected DELETE FROM orphan_schemas for pkg_foo');
    });

    test('rejects bad schemaName (does not match ^pkg_[a-z0-9_]+$)', async () => {
      const db = buildMockDb([]).standard();
      const app = buildApp(db);
      // "DROP TABLE main" — too long, has spaces, doesn't start with pkg_
      const r = await supertest(app).delete('/api/admin/orphan-schemas/DROP%20TABLE%20main').set(adminAuth());
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, 'PKG_DDL_FORBIDDEN');
    });

    test('rejects schemaName without pkg_ prefix', async () => {
      const db = buildMockDb([]).standard();
      const app = buildApp(db);
      const r = await supertest(app).delete('/api/admin/orphan-schemas/other_foo').set(adminAuth());
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, 'PKG_DDL_FORBIDDEN');
    });

    test('401 when no Authorization header', async () => {
      const db = buildMockDb([]).standard();
      const app = buildApp(db);
      const r = await supertest(app).delete('/api/admin/orphan-schemas/pkg_foo');
      assert.equal(r.status, 401);
    });

    test('403 for operator token', async () => {
      const db = buildMockDb([]).standard();
      const app = buildApp(db);
      const r = await supertest(app)
        .delete('/api/admin/orphan-schemas/pkg_foo')
        .set('Authorization', `Bearer ${operatorToken()}`);
      assert.equal(r.status, 403);
    });
  });
});
