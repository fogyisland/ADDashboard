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

  test('POST /:version/mark-applied 200 + writeAudit', async () => {
    let auditCalled = null;
    const app = buildApp({
      _deps: {
        createMigrationsService: () => ({
          ...mockService,
          markApplied: async () => ({ ok: true, version: '008', status: 'applied', executionMs: 0 })
        }),
        writeAudit: async (args) => { auditCalled = args; }
      }
    });
    const res = await request(app)
      .post('/api/admin/migrations/008/mark-applied')
      .set('Authorization', 'Bearer valid')
      .send({});
    assert.equal(res.status, 200);
    assert.equal(auditCalled.action, 'mark_applied');
  });

  test('POST /baseline 200 + audit', async () => {
    let auditCalled = null;
    const app = buildApp({
      _deps: {
        createMigrationsService: () => ({
          ...mockService,
          baseline: async () => ({ ok: true, versions: ['013', '014'], skipped: [] })
        }),
        writeAudit: async (args) => { auditCalled = args; }
      }
    });
    const res = await request(app)
      .post('/api/admin/migrations/baseline')
      .set('Authorization', 'Bearer valid')
      .send({ version: '014' });
    assert.equal(res.status, 200);
    assert.equal(auditCalled.action, 'baseline');
    assert.equal(auditCalled.payload.version, '014');
  });

  test('POST /apply-up-to 200 + audit', async () => {
    let auditCalled = null;
    const app = buildApp({
      _deps: {
        createMigrationsService: () => ({
          ...mockService,
          applyUpTo: async () => ({ ok: true, applied: [{ version: '008', status: 'applied', executionMs: 5 }], failed: [] })
        }),
        writeAudit: async (args) => { auditCalled = args; }
      }
    });
    const res = await request(app)
      .post('/api/admin/migrations/apply-up-to')
      .set('Authorization', 'Bearer valid')
      .send({ version: '014' });
    assert.equal(res.status, 200);
    assert.equal(auditCalled.action, 'apply_up_to');
  });

  test('POST /upgrade 200 + audit action=upgrade_db', async () => {
    let auditCalled = null;
    const app = buildApp({
      _deps: {
        createMigrationsService: () => ({
          ...mockService,
          upgrade: async () => ({ ok: true, migrations: { applied: [{ version: '014', executionMs: 5 }], failed: [] }, seed: { ran: false, reason: 'unchanged' }, message: 'ok' })
        }),
        writeAudit: async (args) => { auditCalled = args; }
      }
    });
    const res = await request(app)
      .post('/api/admin/migrations/upgrade')
      .set('Authorization', 'Bearer valid')
      .send({});
    assert.equal(res.status, 200);
    assert.equal(auditCalled.action, 'upgrade_db');
    assert.equal(auditCalled.target, 'schema_migrations');
    assert.equal(auditCalled.payload.applied, 1);
    assert.equal(auditCalled.payload.failed, 0);
    assert.equal(auditCalled.payload.seed, 'unchanged');
  });

  // 2026-08-28 round-55: refresh-checksum route. Three guards:
  //   - 401 without auth (consistent with siblings)
  //   - 200 success on applied row → writeAudit action=refresh_checksum
  //   - 409 when service throws NotAppliedError
  //   - 404 when service throws MigrationFileMissingError
  test('POST /:version/refresh-checksum 401 without token', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/admin/migrations/008/refresh-checksum');
    assert.equal(res.status, 401);
  });

  test('POST /:version/refresh-checksum 200 + writeAudit action=refresh_checksum', async () => {
    let auditCalled = null;
    const app = buildApp({
      _deps: {
        createMigrationsService: () => ({
          ...mockService,
          refreshChecksum: async (version) => ({
            ok: true, version, checksum: 'a'.repeat(64)
          })
        }),
        writeAudit: async (args) => { auditCalled = args; }
      }
    });
    const res = await request(app)
      .post('/api/admin/migrations/008/refresh-checksum')
      .set('Authorization', 'Bearer valid')
      .send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.version, '008');
    assert.equal(res.body.checksum.length, 64);
    assert.ok(auditCalled);
    assert.equal(auditCalled.action, 'refresh_checksum');
    assert.equal(auditCalled.target, 'schema_migrations');
    assert.equal(auditCalled.payload.version, '008');
    // checksum in audit is truncated to 8 chars + … to keep rows readable
    assert.match(auditCalled.payload.checksum, /^a{8}…$/);
  });

  test('POST /:version/refresh-checksum 409 when service throws NotAppliedError', async () => {
    const app = buildApp({
      _deps: {
        createMigrationsService: () => ({
          ...mockService,
          refreshChecksum: async () => {
            const e = new Error('migration 010 is not in applied state — use mark-applied or reset instead');
            e.status = 409;
            throw e;
          }
        })
      }
    });
    const res = await request(app)
      .post('/api/admin/migrations/010/refresh-checksum')
      .set('Authorization', 'Bearer valid')
      .send({});
    assert.equal(res.status, 409);
    assert.match(res.body.error, /not in applied state/);
  });

  test('POST /:version/refresh-checksum 404 when file missing on disk', async () => {
    const app = buildApp({
      _deps: {
        createMigrationsService: () => ({
          ...mockService,
          refreshChecksum: async () => {
            const e = new Error('migration 999 file not found');
            e.status = 404;
            throw e;
          }
        })
      }
    });
    const res = await request(app)
      .post('/api/admin/migrations/999/refresh-checksum')
      .set('Authorization', 'Bearer valid')
      .send({});
    assert.equal(res.status, 404);
    assert.match(res.body.error, /file not found/);
  });
});