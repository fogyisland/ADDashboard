// admin-schema-inventory.test.js — integration test for the new
// GET /api/admin/schemas/inventory route. Uses the project-standard
// buildMockDb + supertest pattern from tests/admin.test.js.
//
// The service is exercised via the real import (not stubbed) so the
// route's contract on the service is also covered. The listSchemas /
// listTables / listColumns SQL is intercepted by the mock db.

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

function buildApp(dataDir) {
  const a = express();
  a.use(express.json());
  const config = { jwtSecret: SECRET, schemaInventoryDataDir: dataDir };
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

function schemaInventoryMock({ pkgSchemas = [], systemSchemas = [] } = {}) {
  const list = [...pkgSchemas, ...systemSchemas];
  return buildMockDb([
    {
      match: /information_schema\.SCHEMATA|sys\.schemas/,
      rows: list.map((n) => ({ schema_name: n }))
    },
    {
      match: /information_schema\.TABLES/i,
      rows: []
    }
  ]).standard();
}

test('GET /api/admin/schemas/inventory: 401 when no token', async () => {
  _setDbForTest(schemaInventoryMock({ systemSchemas: ['users'] }));
  const app = buildApp();
  const r = await supertest(app).get('/api/admin/schemas/inventory');
  assert.equal(r.status, 401);
});

test('GET /api/admin/schemas/inventory: 403 for operator token', async () => {
  _setDbForTest(schemaInventoryMock({ systemSchemas: ['users'] }));
  const app = buildApp();
  const r = await supertest(app)
    .get('/api/admin/schemas/inventory')
    .set('Authorization', `Bearer ${operatorToken()}`);
  assert.equal(r.status, 403);
});

test('GET /api/admin/schemas/inventory: 200 with admin token', async () => {
  // Empty schema list — the response is `{ schemas: [] }`.
  const db = buildMockDb([
    {
      match: /information_schema\.SCHEMATA|sys\.schemas/,
      rows: []
    }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .get('/api/admin/schemas/inventory')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { schemas: [] });
});

test('GET /api/admin/schemas/inventory: pkg_* schema returns inventory with status', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-inv-route-'));
  try {
    // Drop a package manifest the service can resolve.
    const pkgDir = path.join(tmp, 'ad-local-port-check', '1.0.0');
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

    const db = buildMockDb([
      {
        match: /information_schema\.SCHEMATA|sys\.schemas/,
        rows: [{ schema_name: 'pkg_ad_local_port_check' }]
      },
      {
        match: /information_schema\.TABLES/i,
        rows: [{ table_name: 'metrics' }]
      },
      {
        match: /information_schema\.COLUMNS/i,
        rows: [
          { column_name: 'agent_id', column_type: 'varchar(64)', is_nullable: 'NO' },
          { column_name: 'ts',       column_type: 'datetime',    is_nullable: 'NO' },
          { column_name: 'port_135', column_type: 'json',        is_nullable: 'YES' }
        ]
      }
    ]).standard();
    _setDbForTest(db);
    const app = buildApp(tmp);
    const r = await supertest(app)
      .get('/api/admin/schemas/inventory')
      .set('Authorization', `Bearer ${adminToken()}`)
      .query({}); // no params accepted
    assert.equal(r.status, 200);
    assert.equal(r.body.schemas.length, 1);
    const s = r.body.schemas[0];
    assert.equal(s.name, 'pkg_ad_local_port_check');
    assert.equal(s.source, 'package:ad-local-port-check/1.0.0');
    assert.equal(s.status, 'in_sync');
    assert.equal(s.expected.length, 1);
    assert.equal(s.expected[0].name, 'metrics');
    assert.equal(s.actual.length, 1);
    assert.equal(s.actual[0].columns.length, 3);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('GET /api/admin/schemas/inventory: drift is reported when column is missing', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-inv-route-'));
  try {
    const pkgDir = path.join(tmp, 'ad-domain-consistency', '1.0.0');
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

    const db = buildMockDb([
      {
        match: /information_schema\.SCHEMATA|sys\.schemas/,
        rows: [{ schema_name: 'pkg_ad_domain_consistency' }]
      },
      {
        match: /information_schema\.TABLES/i,
        rows: [{ table_name: 'metrics' }]
      },
      {
        match: /information_schema\.COLUMNS/i,
        rows: [
          { column_name: 'agent_id', column_type: 'varchar(64)', is_nullable: 'NO' },
          { column_name: 'ts',       column_type: 'datetime',    is_nullable: 'NO' }
          // missing user_hash
        ]
      }
    ]).standard();
    _setDbForTest(db);
    const app = buildApp(tmp);
    const r = await supertest(app)
      .get('/api/admin/schemas/inventory')
      .set('Authorization', `Bearer ${adminToken()}`);
    assert.equal(r.status, 200);
    const s = r.body.schemas[0];
    assert.equal(s.status, 'drift');
    assert.equal(s.diff.missingColumns.length, 1);
    assert.equal(s.diff.missingColumns[0].name, 'user_hash');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
