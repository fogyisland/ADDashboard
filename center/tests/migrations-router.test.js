import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';

// Mock dependencies before importing the router
let mockListResult = [];
let mockApplyResult = { ok: true, version: '008', status: 'applied', executionMs: 10 };
let mockDryRunResult = { version: '008', statements: [{ ordinal: 1, sql: 'CREATE TABLE x;' }] };
let mockResetResult = { ok: true, deleted: 1 };

const mockService = {
  listMigrations: async () => mockListResult,
  applyMigration: async () => mockApplyResult,
  dryRunMigration: async () => mockDryRunResult,
  resetFailedMigration: async () => mockResetResult
};

const mockWriteAudit = async () => {};

// Inject mock service via dep override (the router factory accepts _deps)
const { schemaMigrationsRouter } = await import('../src/routes/schema-migrations.js');

function buildApp(opts = {}) {
  const app = express();
  app.use(express.json());
  // Trivial auth: pass-through if header matches, else 401
  const requireAuth = (req, res, next) => {
    if (req.headers['authorization'] === 'Bearer valid') { req.user = { sub: 1, username: 'admin' }; next(); }
    else res.status(401).json({ error: 'no auth' });
  };
  const requirePerm = () => (req, res, next) => next();
  app.use(schemaMigrationsRouter({
    requireAuth, requirePerm, logger: { warn() {}, error() {} },
    getRepoRoot: () => '/tmp', _deps: { createMigrationsService: () => mockService, writeAudit: mockWriteAudit, ...opts._deps }
  }));
  return app;
}

describe('schemaMigrationsRouter', () => {
  test('GET /api/admin/migrations 401 without token', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/admin/migrations');
    assert.equal(res.status, 401);
  });

  test('GET /api/admin/migrations 200 returns list', async () => {
    mockListResult = [{ version: '008', status: 'applied' }];
    const app = buildApp();
    const res = await request(app).get('/api/admin/migrations').set('Authorization', 'Bearer valid');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, mockListResult);
  });

  test('POST apply 200 success → writeAudit called with action=apply_migration', async () => {
    let auditCalled = null;
    const app = buildApp({
      _deps: { writeAudit: async (args) => { auditCalled = args; } }
    });
    const res = await request(app)
      .post('/api/admin/migrations/008/apply')
      .set('Authorization', 'Bearer valid')
      .send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(auditCalled);
    assert.equal(auditCalled.action, 'apply_migration');
    assert.equal(auditCalled.target, 'schema_migrations');
  });

  test('POST apply 409 on already-applied version', async () => {
    const app = buildApp({
      _deps: { createMigrationsService: () => ({
        ...mockService,
        applyMigration: async () => { const e = new Error('already applied'); e.status = 409; throw e; }
      }) }
    });
    const res = await request(app)
      .post('/api/admin/migrations/008/apply')
      .set('Authorization', 'Bearer valid')
      .send({});
    assert.equal(res.status, 409);
  });

  test('POST dry-run returns statements', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/admin/migrations/008/dry-run')
      .set('Authorization', 'Bearer valid')
      .send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.version, '008');
    assert.equal(res.body.statements.length, 1);
  });

  test('POST reset 200 success → writeAudit called with action=reset_failed_migration', async () => {
    let auditCalled = null;
    const app = buildApp({
      _deps: { writeAudit: async (args) => { auditCalled = args; } }
    });
    const res = await request(app)
      .post('/api/admin/migrations/008/reset')
      .set('Authorization', 'Bearer valid')
      .send({});
    assert.equal(res.status, 200);
    assert.ok(auditCalled);
    assert.equal(auditCalled.action, 'reset_failed_migration');
  });
});