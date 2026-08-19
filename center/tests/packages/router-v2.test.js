// router-v2.test.js — covers the v2 admin endpoints added in Task 10:
//   GET    /api/admin/packages/:name/ddl-preview
//   GET    /api/admin/orphan-schemas
//   DELETE /api/admin/orphan-schemas/:name
// Plus the modified DELETE /api/admin/packages/:name that now accepts the
// confirmDropSchema query param.
//
// Two test styles co-exist here:
//   1. mock-DB tests (default — work on dev machines with no live DB) for
//      the orphan-schemas CRUD endpoints, since they only need the SQL
//      helper facade.
//   2. real-DB integration tests (gated on TEST_MYSQL_URL) for the
//      ddl-preview endpoint and the install/uninstall confirmDropSchema
//      wiring — these need the actual package install + DDL apply to
//      produce the cached migration files the ddl-preview endpoint reads.
//
// Pattern follows router.test.js (supertest + admin token).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { default as supertest } from 'supertest';
import { buildMockDb } from '../helpers/db-mock.js';
import { packageRouter } from '../../src/packages/router.js';
import { orphanRouter } from '../../src/packages/orphan-router.js';
import { signJwt } from '../../src/auth/jwt.js';
import { init, close, getDb } from '../../src/db/index.js';
import { installer } from '../../src/packages/installer.js';
import { installedPackages } from '../../src/db/sql/installed-packages.js';
import { parseTestUrl } from '../integration/_url.js';

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
  app.use(packageRouter({
    db,
    getLogger: noopLogger,
    getRegistryUrl: async () => null,
    config: { jwtSecret: SECRET }
  }));
  app.use(orphanRouter({
    db,
    config: { jwtSecret: SECRET }
  }));
  return app;
}

function buildV2Manifest({ name, schemaName }) {
  return {
    name,
    version: '1.0.0',
    type: 'gauge',
    description: 'fixture v2',
    agent: {
      minVersion: '1.0.0',
      script: 'collect.ps1',
      intervalSec: 60,
      timeoutMs: 30000
    },
    metrics: [{ key: 'val', label: 'Val', unit: '%' }],
    params: { schema: { type: 'object' }, required: [] },
    widget: { type: 'builtin', component: 'GaugeTile' },
    database: {
      schemaName,
      migrations: ['migrations/001.sql'],
      metricTable: 'metrics',
      metricSchema: {
        agent_id: { type: 'varchar(64)', nullable: false },
        ts: { type: 'datetime', nullable: false },
        val: { type: 'double', nullable: false }
      }
    }
  };
}

function buildV2Zip({ name, schemaName, sqlFiles }) {
  const manifest = buildV2Manifest({ name, schemaName });
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
  zip.addFile('collect.ps1', Buffer.from('Write-Output \'{"metrics":{"val":0.0}}\''));
  for (const f of sqlFiles) {
    zip.addFile(`migrations/${f.filename}`, Buffer.from(f.content));
  }
  return zip.toBuffer();
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

// ─────────────────────────────────────────────────────────────────────
// Mock-DB tests: ddl-preview endpoint shape (cache file existence is
// not asserted; the route returns 404 PKG_NOT_FOUND or 500 if the row
// is not present, which is enough for shape coverage).
// ─────────────────────────────────────────────────────────────────────

describe('admin /api/admin/packages/:name/ddl-preview (mock DB)', () => {
  test('returns 404 PKG_NOT_FOUND when not installed', async () => {
    const db = buildMockDb([
      { match: /FROM\s+installed_packages\s+WHERE\s+name\s*=\s*\?/i, rows: [] }
    ]).standard();
    const app = buildApp(db);
    const r = await supertest(app).get('/api/admin/packages/nope/ddl-preview').set(adminAuth());
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, 'PKG_NOT_FOUND');
  });

  test('returns empty preview for v1 packages (no manifest.database)', async () => {
    const db = buildMockDb([
      {
        match: /FROM\s+installed_packages\s+WHERE\s+name\s*=\s*\?/i,
        rows: [{
          name: 'v1pkg',
          version: '1.0.0',
          type: 'gauge',
          // No `database` field — v1 package
          manifest_json: JSON.stringify({ name: 'v1pkg', version: '1.0.0', type: 'gauge' }),
          enabled: 1,
          params_json: null
        }]
      }
    ]).standard();
    const app = buildApp(db);
    const r = await supertest(app).get('/api/admin/packages/v1pkg/ddl-preview').set(adminAuth());
    assert.equal(r.status, 200);
    assert.equal(r.body.schemaName, null);
    assert.deepEqual(r.body.files, []);
  });

  test('401 when no Authorization header', async () => {
    const db = buildMockDb([]).standard();
    const app = buildApp(db);
    const r = await supertest(app).get('/api/admin/packages/foo/ddl-preview');
    assert.equal(r.status, 401);
  });

  test('403 for operator token', async () => {
    const db = buildMockDb([]).standard();
    const app = buildApp(db);
    const r = await supertest(app)
      .get('/api/admin/packages/foo/ddl-preview')
      .set('Authorization', `Bearer ${operatorToken()}`);
    assert.equal(r.status, 403);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Mock-DB tests: install + uninstall endpoints honor confirmDropSchema.
// ─────────────────────────────────────────────────────────────────────

describe('DELETE /api/admin/packages/:name?confirmDropSchema=... (mock DB)', () => {
  test('passes confirmDropSchema=true through to installer (v2 path)', async () => {
    const db = buildMockDb([
      {
        match: /FROM\s+installed_packages\s+WHERE\s+name\s*=\s*\?/i,
        rows: [{
          name: 'v2pkg',
          version: '1.0.0',
          manifest_json: JSON.stringify({
            name: 'v2pkg', version: '1.0.0', type: 'gauge',
            database: { schemaName: 'pkg_v2pkg', migrations: ['migrations/001.sql'] }
          })
        }]
      }
    ]).standard();
    const app = buildApp(db);
    const r = await supertest(app)
      .delete('/api/admin/packages/v2pkg?purgeMetrics=true&confirmDropSchema=true')
      .set(adminAuth());
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });

  test('returns 400 PKG_CONFIRM_REQUIRED when v2 uninstall missing confirmDropSchema', async () => {
    const db = buildMockDb([
      {
        match: /FROM\s+installed_packages\s+WHERE\s+name\s*=\s*\?/i,
        rows: [{
          name: 'v2pkg',
          version: '1.0.0',
          manifest_json: JSON.stringify({
            name: 'v2pkg', version: '1.0.0', type: 'gauge',
            database: { schemaName: 'pkg_v2pkg', migrations: ['migrations/001.sql'] }
          })
        }]
      }
    ]).standard();
    const app = buildApp(db);
    const r = await supertest(app)
      .delete('/api/admin/packages/v2pkg?purgeMetrics=true')
      .set(adminAuth());
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'PKG_CONFIRM_REQUIRED');
  });

  test('v1 uninstall without purgeMetrics still works (no confirm needed)', async () => {
    const db = buildMockDb([
      { match: /FROM\s+installed_packages\s+WHERE\s+name\s*=\s*\?/i, rows: [{ name: 'v1pkg', version: '1.0.0', manifest_json: JSON.stringify({ name: 'v1pkg', version: '1.0.0' }) }] }
    ]).standard();
    const app = buildApp(db);
    const r = await supertest(app).delete('/api/admin/packages/v1pkg').set(adminAuth());
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });
});

function buildFixtureV1Zip({ name, version }) {
  const manifest = {
    name,
    version,
    type: 'gauge',
    description: 'v1 fixture',
    agent: { minVersion: '1.0.0', script: 'collect.ps1', intervalSec: 60, timeoutMs: 30000 },
    metrics: [{ key: 'm1', label: 'M1' }],
    params: { schema: { type: 'object' }, required: [] },
    widget: { type: 'builtin', component: 'GaugeTile' }
  };
  const ps1 = 'Write-Output \'{"metrics":{"m1":42}}\'';
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
  zip.addFile('collect.ps1', Buffer.from(ps1));
  return zip.toBuffer();
}

describe('POST /api/admin/packages/install body parsing (mock DB)', () => {
  const seedName = 'router-v2-install-body';
  test('accepts confirmDropSchema in body without 400 (currently inert for install)', async () => {
    const db = buildMockDb([
      { match: /FROM\s+installed_packages\s+WHERE\s+name\s*=\s*\?/i, rows: [] }
    ]).standard();
    const app = buildApp(db);
    const buffer = buildFixtureV1Zip({ name: seedName, version: '1.0.0' });
    const r = await supertest(app)
      .post('/api/admin/packages/install')
      .set(adminAuth())
      .send({ source: 'local', packageRef: seedName, buffer: buffer.toString('base64'), confirmDropSchema: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    fs.rmSync(path.join(process.cwd(), 'data', 'packages', seedName), { recursive: true, force: true });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Real-DB integration: install v2 → GET ddl-preview reads cached files.
// Gated on TEST_MYSQL_URL.
// ─────────────────────────────────────────────────────────────────────

describe('admin /api/admin/packages/:name/ddl-preview (real DB)', () => {
  const name = 'router-v2-ddl-preview';
  const schema = `pkg_${name.replace(/-/g, '_')}`;

  before(async () => {
    if (!process.env.TEST_MYSQL_URL) return;
    const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
    await init({
      db: { dialect: 'mysql', mysql: { host, port, database: 'ad_monitoring', user, password } },
      listenPort: 8080, jwtSecret: 'x', agentToken: 'x', staticDir: './dist', logLevel: 'silent', env: 'test'
    });
  });

  after(async () => {
    if (!process.env.TEST_MYSQL_URL) return;
    const db = getDb();
    try { await installer.uninstallPackage(db, { name, purgeMetrics: true, confirmDropSchema: true }); } catch {}
    try { await db.execute(`DROP DATABASE IF EXISTS \`${schema}\``); } catch {}
    try { await close(); } catch {}
  });

  test('returns schemaName + migration file contents for installed v2 package', { skip: !process.env.TEST_MYSQL_URL }, async () => {
    const db = getDb();
    // Install a v2 package first so the cache dir + installed_packages row exist
    const buf = buildV2Zip({
      name,
      schemaName: schema,
      sqlFiles: [{ filename: '001.sql', content: `CREATE TABLE ${schema}.metrics (agent_id VARCHAR(64) NOT NULL, ts DATETIME NOT NULL, val DOUBLE NOT NULL, PRIMARY KEY (agent_id, ts))` }]
    });
    await installer.installPackage(db, { source: 'local', buffer: buf });

    const app = buildApp(db);
    const r = await supertest(app).get(`/api/admin/packages/${name}/ddl-preview`).set(adminAuth());
    assert.equal(r.status, 200);
    assert.equal(r.body.schemaName, schema);
    assert.ok(Array.isArray(r.body.files));
    assert.equal(r.body.files.length, 1);
    assert.equal(r.body.files[0].filename, '001.sql');
    assert.equal(r.body.files[0].path, 'migrations/001.sql');
    assert.ok(r.body.files[0].content.includes(`CREATE TABLE ${schema}.metrics`));
  });
});