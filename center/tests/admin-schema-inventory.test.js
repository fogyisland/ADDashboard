// admin-schema-inventory.test.js — integration test for the
// GET /api/admin/schemas/inventory route.
//
// The new code-driven service scans center/src for SQL table references
// and compares each referenced table's expected shape (from CREATE TABLE
// in migrations + package manifests) against the DB's actual shape. Tests
// exercise both auth (401/403/200) and the route's wiring of the service
// with code fixtures + manifest fixtures + a columns-query mock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { default as supertest } from 'supertest';
import { adminRouter } from '../src/routes/admin.js';
import { signJwt } from '../src/auth/jwt.js';
import { _setDbForTest } from '../src/db/index.js';
import { buildMockDb } from './helpers/db-mock.js';

const SECRET = 'test-secret';

function buildApp(dataDir, srcRoot) {
  const a = express();
  a.use(express.json());
  const config = {
    jwtSecret: SECRET,
    schemaInventoryDataDir: dataDir,
    schemaInventorySrcRoot: srcRoot,
    schemaInventoryRepoRoot: srcRoot && path.resolve(srcRoot, '..', '..')
  };
  const logger = { info(){}, error(){}, warn(){}, debug(){} };
  a.use(adminRouter({ config, logger }));
  return a;
}

function adminToken() {
  return signJwt({ sub: 'u1', role: 'admin', permissions: ['*'] }, SECRET, 60);
}

function operatorToken() {
  return signJwt({ sub: 'u2', role: 'operator', permissions: ['read:dash'] }, SECRET, 60);
}

// Code-driven inventory calls db.execute(schemaInventory.listColumns,
// [schema, table]) — mock returns canned columns per table.
function columnsMock(actualByTable) {
  return buildMockDb([
    {
      match: /information_schema\.COLUMNS|FROM information_schema/i,
      rows: (params) => {
        const [, table] = params;
        return actualByTable[table] || [];
      }
    }
  ]).standard();
}

test('GET /api/admin/schemas/inventory: 401 when no token', async () => {
  _setDbForTest(columnsMock({}));
  const app = buildApp();
  const r = await supertest(app).get('/api/admin/schemas/inventory');
  assert.equal(r.status, 401);
});

test('GET /api/admin/schemas/inventory: 403 for operator token', async () => {
  _setDbForTest(columnsMock({}));
  const app = buildApp();
  const r = await supertest(app)
    .get('/api/admin/schemas/inventory')
    .set('Authorization', `Bearer ${operatorToken()}`);
  assert.equal(r.status, 403);
});

test('GET /api/admin/schemas/inventory: 200 with admin token, no code refs → empty', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-inv-'));
  try {
    const srcRoot = path.join(tmp, 'center', 'src');
    fs.mkdirSync(srcRoot, { recursive: true });
    fs.writeFileSync(path.join(srcRoot, 'a.js'), 'const x = 1 + 2;');
    _setDbForTest(columnsMock({}));
    const app = buildApp('', srcRoot);
    const r = await supertest(app)
      .get('/api/admin/schemas/inventory')
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { schemas: [] });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('GET /api/admin/schemas/inventory: pkg_* table from manifest returns in_sync', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-inv-'));
  try {
    const repoRoot = tmp;
    const srcRoot = path.join(repoRoot, 'center', 'src');
    const dataDir = path.join(repoRoot, 'center', 'data', 'packages');
    fs.mkdirSync(srcRoot, { recursive: true });
    fs.writeFileSync(path.join(srcRoot, 'a.js'),
      'const q = "INSERT INTO pkg_ad_local_port_check.metrics (agent_id) VALUES (?)";');
    const pkgDir = path.join(dataDir, 'ad-local-port-check', '1.0.0');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'manifest.json'), JSON.stringify({
      name: 'ad-local-port-check',
      version: '1.0.0',
      database: {
        schemaName: 'pkg_ad_local_port_check',
        metricTable: 'metrics',
        metricSchema: {
          agent_id: { type: 'varchar(64)', nullable: false },
          ts:       { type: 'datetime',    nullable: false },
          port_135: { type: 'json' }
        }
      }
    }));
    _setDbForTest(columnsMock({
      metrics: [
        { column_name: 'agent_id', column_type: 'varchar(64)', is_nullable: 'NO' },
        { column_name: 'ts',       column_type: 'datetime',    is_nullable: 'NO' },
        { column_name: 'port_135', column_type: 'json',        is_nullable: 'YES' }
      ]
    }));
    const app = buildApp(dataDir, srcRoot);
    const r = await supertest(app)
      .get('/api/admin/schemas/inventory')
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.schemas.length, 1);
    const s = r.body.schemas[0];
    assert.equal(s.name, 'pkg_ad_local_port_check');
    assert.equal(s.tables.length, 1);
    const tbl = s.tables[0];
    assert.equal(tbl.name, 'metrics');
    assert.equal(tbl.source, 'package');
    assert.equal(tbl.status, 'in_sync');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('GET /api/admin/schemas/inventory: drift is reported when a column is missing', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-inv-'));
  try {
    const repoRoot = tmp;
    const srcRoot = path.join(repoRoot, 'center', 'src');
    const dataDir = path.join(repoRoot, 'center', 'data', 'packages');
    fs.mkdirSync(srcRoot, { recursive: true });
    fs.writeFileSync(path.join(srcRoot, 'a.js'),
      'const q = "INSERT INTO pkg_ad_domain_consistency.metrics (agent_id) VALUES (?)";');
    const pkgDir = path.join(dataDir, 'ad-domain-consistency', '1.0.0');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'manifest.json'), JSON.stringify({
      name: 'ad-domain-consistency',
      version: '1.0.0',
      database: {
        schemaName: 'pkg_ad_domain_consistency',
        metricTable: 'metrics',
        metricSchema: {
          agent_id: { type: 'varchar(64)', nullable: false },
          ts:       { type: 'datetime',    nullable: false },
          user_hash:{ type: 'varchar(64)' }
        }
      }
    }));
    _setDbForTest(columnsMock({
      metrics: [
        { column_name: 'agent_id', column_type: 'varchar(64)', is_nullable: 'NO' },
        { column_name: 'ts',       column_type: 'datetime',    is_nullable: 'NO' }
        // missing user_hash
      ]
    }));
    const app = buildApp(dataDir, srcRoot);
    const r = await supertest(app)
      .get('/api/admin/schemas/inventory')
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(r.status, 200);
    const s = r.body.schemas[0];
    const tbl = s.tables[0];
    assert.equal(tbl.name, 'metrics');
    assert.equal(tbl.status, 'drift');
    assert.equal(tbl.diff.missingColumns.length, 1);
    assert.equal(tbl.diff.missingColumns[0].name, 'user_hash');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});