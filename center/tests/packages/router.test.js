// router.test.js — covers center/src/packages/router.js (admin endpoints).
// Uses supertest against a fresh express app. JWT auth is wired inside the
// router (per-route userAuth + requirePerm('admin:packages')), so tests
// must send a valid Bearer token to reach the handlers. The 401/403
// regression tests confirm the wiring is in place — this was the security
// regression that the reviewer flagged.
//
// Endpoints:
//   GET    /api/admin/packages
//   GET    /api/admin/packages/:name
//   POST   /api/admin/packages/install
//   POST   /api/admin/packages/:name/upgrade
//   POST   /api/admin/packages/:name/enable
//   POST   /api/admin/packages/:name/disable
//   DELETE /api/admin/packages/:name
//   PUT    /api/admin/packages/:name/params
//   GET    /api/admin/packages/registry/refresh

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { default as supertest } from 'supertest';
import { buildMockDb } from '../helpers/db-mock.js';
import { packageRouter } from '../../src/packages/router.js';
import { signJwt } from '../../src/auth/jwt.js';

// I9 — Task 1: see tests/e2e/plugin-system.test.js. Match the buildMockDb
// default jwt_secret_current='test-secret' so userAuth accepts our tokens.
const SECRET = 'test-secret';
const noopLogger = () => ({ info() {}, warn() {}, error() {}, debug() {} });

// Stable registry URL — the RegistryClient constructor permits http only
// on 127.0.0.1/localhost loopback for tests; production must use HTTPS.
const REGISTRY_URL = 'http://127.0.0.1:9999';

function buildApp(db, opts = {}) {
  const app = express();
  app.use(express.json());
  app.use(packageRouter({
    db,
    getLogger: noopLogger,
    getRegistryUrl: opts.getRegistryUrl || (async () => null),
    config: { jwtSecret: SECRET }
  }));
  return app;
}

// Admin token: '*' perm short-circuits requirePerm so all perms pass.
function adminToken() {
  return signJwt({ sub: 'u1', role: 'admin', permissions: ['*'] }, SECRET, 60);
}

// Operator token: read-only perm, missing admin:packages → 403 on every
// endpoint. Mirrors the admin.test.js operatorToken() pattern.
function operatorToken() {
  return signJwt({ sub: 'u2', role: 'operator', permissions: ['read:dash'] }, SECRET, 60);
}

function adminAuth() {
  return { Authorization: `Bearer ${adminToken()}` };
}

function buildFixtureZip({ name, version, type, centerVersion }) {
  const manifest = {
    name,
    version,
    type,
    description: 'fixture',
    agent: {
      minVersion: '1.0.0',
      script: 'collect.ps1',
      intervalSec: 60,
      timeoutMs: 30000
    },
    metrics: [{ key: 'm1', label: 'M1' }],
    params: { schema: { type: 'object' }, required: [] },
    widget: { type: 'builtin', component: 'GaugeTile' }
  };
  if (centerVersion) {
    manifest.center = { minVersion: centerVersion };
  }
  const ps1 = 'Write-Output \'{"metrics":{"m1":42}}\'';
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
  zip.addFile('collect.ps1', Buffer.from(ps1));
  return zip.toBuffer();
}

// getCenterVersion() is imported from config.js and reads the running
// version (default '0.0.0'). Tests that exercise the center-compat path
// need to override this — easiest is to set the package_registry_url
// never to be hit and to craft manifests with no center constraints.

describe('admin /api/admin/packages', () => {
  describe('GET /packages', () => {
    test('returns list of installed packages', async () => {
      const db = buildMockDb([
        {
          match: /FROM\s+installed_packages/i,
          rows: [
            {
              name: 'a',
              version: '1.0.0',
              type: 'gauge',
              manifest_json: JSON.stringify({ name: 'a', version: '1.0.0', type: 'gauge' }),
              enabled: 0,
              params_json: null
            }
          ]
        }
      ]).standard();
      const app = buildApp(db);
      const r = await supertest(app).get('/api/admin/packages').set(adminAuth());
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.body.packages));
      assert.equal(r.body.packages.length, 1);
      assert.equal(r.body.packages[0].name, 'a');
    });
  });

  describe('GET /packages/:name', () => {
    test('returns 404 when not found', async () => {
      const db = buildMockDb([
        { match: /FROM\s+installed_packages\s+WHERE\s+name\s*=\s*\?/i, rows: [] }
      ]).standard();
      const app = buildApp(db);
      const r = await supertest(app).get('/api/admin/packages/nope').set(adminAuth());
      assert.equal(r.status, 404);
      assert.equal(r.body.error.code, 'PKG_NOT_FOUND');
    });

    test('returns package + recentRuns when found', async () => {
      const db = buildMockDb([
        {
          match: /FROM\s+installed_packages\s+WHERE\s+name\s*=\s*\?/i,
          rows: [{
            name: 'a',
            version: '1.0.0',
            type: 'gauge',
            manifest_json: JSON.stringify({ name: 'a', version: '1.0.0', type: 'gauge' }),
            enabled: 1,
            params_json: null
          }]
        },
        {
          // package_runs SELECT
          match: /FROM\s+package_runs/i,
          rows: [{ id: 1, agent_id: 'ag1', package_name: 'a', exit_code: 0 }]
        }
      ]).standard();
      const app = buildApp(db);
      const r = await supertest(app).get('/api/admin/packages/a').set(adminAuth());
      assert.equal(r.status, 200);
      assert.equal(r.body.package.name, 'a');
      assert.ok(Array.isArray(r.body.recentRuns));
    });
  });

  describe('POST /packages/install', () => {
    let seedName = 'install-test-pkg';
    after(() => {
      fs.rmSync(path.join(process.cwd(), 'data', 'packages', seedName), {
        recursive: true,
        force: true
      });
    });

    test('installs a valid buffer and persists row', async () => {
      const db = buildMockDb([
        {
          // installedPackages.get returns [] for the new package name
          match: /FROM\s+installed_packages\s+WHERE\s+name\s*=\s*\?/i,
          rows: []
        }
      ]).standard();
      const app = buildApp(db);

      const buffer = buildFixtureZip({ name: seedName, version: '1.0.0', type: 'gauge' });
      const r = await supertest(app)
        .post('/api/admin/packages/install')
        .set(adminAuth())
        .send({ source: 'local', packageRef: seedName, buffer: buffer.toString('base64') });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      assert.equal(r.body.data.name, seedName);
      assert.equal(r.body.data.version, '1.0.0');

      // Cleanup
      fs.rmSync(path.join(process.cwd(), 'data', 'packages', seedName), {
        recursive: true,
        force: true
      });
    });

    test('rejects invalid manifest with PKG_INVALID_MANIFEST', async () => {
      const db = buildMockDb([]).standard();
      const app = buildApp(db);

      // Use a manifest that ajv will reject (unknown additional field —
      // additionalProperties is false).
      const manifest = {
        name: 'bad',
        version: '1.0.0',
        type: 'gauge',
        description: 'has-unknown-field',
        rogueField: 'should be rejected'
      };
      const zip = new AdmZip();
      zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
      zip.addFile('collect.ps1', Buffer.from('Write-Output "x"'));
      const buffer = zip.toBuffer();

      const r = await supertest(app)
        .post('/api/admin/packages/install')
        .set(adminAuth())
        .send({ source: 'local', packageRef: 'bad', buffer: buffer.toString('base64') });
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, 'PKG_INVALID_MANIFEST');
    });

    test('rejects center-incompatible manifest', async () => {
      const db = buildMockDb([]).standard();
      const app = buildApp(db);
      // Force a high min center version so 0.0.0 fails.
      const buffer = buildFixtureZip({
        name: 'incompat',
        version: '1.0.0',
        type: 'gauge',
        centerVersion: '99.0.0'
      });
      const r = await supertest(app)
        .post('/api/admin/packages/install')
        .set(adminAuth())
        .send({ source: 'local', packageRef: 'incompat', buffer: buffer.toString('base64') });
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, 'PKG_CENTER_INCOMPATIBLE');
    });

    test('rejects name conflict', async () => {
      const db = buildMockDb([
        {
          // installedPackages.get returns an existing row → conflict.
          match: /FROM\s+installed_packages\s+WHERE\s+name\s*=\s*\?/i,
          rows: [{
            name: 'exists',
            version: '1.0.0',
            type: 'gauge',
            manifest_json: JSON.stringify({ name: 'exists', version: '1.0.0', type: 'gauge' }),
            enabled: 1,
            params_json: null
          }]
        }
      ]).standard();
      const app = buildApp(db);
      const buffer = buildFixtureZip({ name: 'exists', version: '1.0.0', type: 'gauge' });
      const r = await supertest(app)
        .post('/api/admin/packages/install')
        .set(adminAuth())
        .send({ source: 'local', packageRef: 'exists', buffer: buffer.toString('base64') });
      assert.equal(r.status, 409);
      assert.equal(r.body.error.code, 'PKG_NAME_CONFLICT');
    });
  });

  describe('POST /packages/:name/enable + /disable', () => {
    test('enable toggles to true', async () => {
      const db = buildMockDb([]).standard();
      const app = buildApp(db);
      const r = await supertest(app).post('/api/admin/packages/foo/enable').set(adminAuth());
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
    });

    test('disable toggles to false', async () => {
      const db = buildMockDb([]).standard();
      const app = buildApp(db);
      const r = await supertest(app).post('/api/admin/packages/foo/disable').set(adminAuth());
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
    });
  });

  describe('PUT /packages/:name/params', () => {
    test('updates params_json', async () => {
      const db = buildMockDb([]).standard();
      const app = buildApp(db);
      const r = await supertest(app)
        .put('/api/admin/packages/foo/params')
        .set(adminAuth())
        .send({ params: { threshold: 75 } });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
    });
  });

  describe('DELETE /packages/:name', () => {
    test('uninstalls without purgeMetrics', async () => {
      const db = buildMockDb([
        // uninstallPackage calls installedPackages.get first; return a
        // row so the route proceeds. manifest_json is required by the
        // v2 routing check in installer.uninstallPackage (manifest.database).
        { match: /FROM\s+installed_packages\s+WHERE\s+name\s*=\s*\?/i, rows: [{ name: 'foo', version: '1.0.0', manifest_json: JSON.stringify({ name: 'foo', version: '1.0.0' }) }] }
      ]).standard();
      const app = buildApp(db);
      const r = await supertest(app).delete('/api/admin/packages/foo').set(adminAuth());
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
    });

    test('accepts purgeMetrics=true query param', async () => {
      const db = buildMockDb([
        { match: /FROM\s+installed_packages\s+WHERE\s+name\s*=\s*\?/i, rows: [{ name: 'foo', version: '1.0.0', manifest_json: JSON.stringify({ name: 'foo', version: '1.0.0' }) }] }
      ]).standard();
      const app = buildApp(db);
      const r = await supertest(app).delete('/api/admin/packages/foo?purgeMetrics=true').set(adminAuth());
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
    });
  });

  describe('GET /packages/registry/refresh', () => {
    test('400 when registry not configured', async () => {
      const db = buildMockDb([]).standard();
      const app = buildApp(db, { getRegistryUrl: async () => null });
      const r = await supertest(app).get('/api/admin/packages/registry/refresh').set(adminAuth());
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, 'PKG_VALIDATION_FAILED');
    });
  });

  describe('GET /packages/registry/list', () => {
    test('returns empty result when registry not configured', async () => {
      const db = buildMockDb([]).standard();
      const app = buildApp(db, { getRegistryUrl: async () => null });
      const r = await supertest(app).get('/api/admin/packages/registry/list').set(adminAuth());
      assert.equal(r.status, 200);
      assert.equal(r.body.url, null);
      assert.deepEqual(r.body.packages, []);
      assert.equal(r.body.updatedAt, null);
    });

    test('returns cached index (uses fetchIndex without force)', async () => {
      // Stub RegistryClient so we don't depend on real HTTP.
      const { RegistryClient } = await import('../../src/packages/registry.js');
      const original = RegistryClient.prototype.fetchIndex;
      RegistryClient.prototype.fetchIndex = async function (_force) {
        return {
          updatedAt: '2026-08-02T00:00:00Z',
          packages: [
            { name: 'cpu-monitor', latestVersion: '1.0.0', type: 'gauge', description: 'CPU gauge', author: 'me', versions: [] },
            { name: 'mem-monitor', latestVersion: '1.2.3', type: 'gauge', description: 'Mem gauge', author: 'me', versions: [] }
          ]
        };
      };
      try {
        const db = buildMockDb([]).standard();
        const app = buildApp(db, { getRegistryUrl: async () => REGISTRY_URL });
        const r = await supertest(app).get('/api/admin/packages/registry/list').set(adminAuth());
        assert.equal(r.status, 200);
        assert.equal(r.body.url, REGISTRY_URL);
        assert.equal(r.body.updatedAt, '2026-08-02T00:00:00Z');
        assert.ok(Array.isArray(r.body.packages));
        assert.equal(r.body.packages.length, 2);
        assert.equal(r.body.packages[0].name, 'cpu-monitor');
      } finally {
        RegistryClient.prototype.fetchIndex = original;
      }
    });

    test('401 when no Authorization header', async () => {
      const db = buildMockDb([]).standard();
      const app = buildApp(db, { getRegistryUrl: async () => REGISTRY_URL });
      const r = await supertest(app).get('/api/admin/packages/registry/list');
      assert.equal(r.status, 401);
    });
  });

  describe('POST /packages/:name/upgrade', () => {
    test('400 when registry not configured', async () => {
      const db = buildMockDb([]).standard();
      const app = buildApp(db, { getRegistryUrl: async () => null });
      const r = await supertest(app)
        .post('/api/admin/packages/foo/upgrade')
        .set(adminAuth())
        .send({});
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, 'PKG_VALIDATION_FAILED');
    });
  });

  // ---- AUTH WIRING (regression: must mirror adminRouter / agentRouter) ----

  describe('AUTH WIRING', () => {
    test('GET /packages: 401 when no Authorization header', async () => {
      const db = buildMockDb([]).standard();
      const app = buildApp(db);
      const r = await supertest(app).get('/api/admin/packages');
      assert.equal(r.status, 401);
    });

    test('GET /packages: 403 for operator token (missing admin:packages perm)', async () => {
      const db = buildMockDb([]).standard();
      const app = buildApp(db);
      const r = await supertest(app)
        .get('/api/admin/packages')
        .set('Authorization', `Bearer ${operatorToken()}`);
      assert.equal(r.status, 403);
      assert.equal(r.body.need, 'admin:packages');
    });

    test('POST /packages/install: 401 when no Authorization header', async () => {
      const db = buildMockDb([]).standard();
      const app = buildApp(db);
      const r = await supertest(app)
        .post('/api/admin/packages/install')
        .send({ source: 'local', packageRef: 'x' });
      assert.equal(r.status, 401);
    });

    test('DELETE /packages/foo: 403 for operator token (missing admin:packages perm)', async () => {
      const db = buildMockDb([]).standard();
      const app = buildApp(db);
      const r = await supertest(app)
        .delete('/api/admin/packages/foo')
        .set('Authorization', `Bearer ${operatorToken()}`);
      assert.equal(r.status, 403);
    });

    test('GET /packages/registry/list: 403 for operator token (missing admin:packages perm)', async () => {
      const db = buildMockDb([]).standard();
      const app = buildApp(db);
      const r = await supertest(app)
        .get('/api/admin/packages/registry/list')
        .set('Authorization', `Bearer ${operatorToken()}`);
      assert.equal(r.status, 403);
      assert.equal(r.body.need, 'admin:packages');
    });
  });
});