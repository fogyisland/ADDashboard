import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createMigrationsService,
  AlreadyAppliedError,
  NotFailedError,
  MigrationFileMissingError
} from '../src/services/migrations.js';

// Helper: SHA256 hex of a string
const sha = (s) => createHash('sha256').update(s).digest('hex');

// Build a fake `db` with execute/query/transaction that records calls and
// returns canned responses, plus a queue of rows to return from `query`.
function buildMockDb({ initialRows = [], executeImpl } = {}) {
  const calls = { execute: [], query: [], transaction: [] };
  const state = { rows: [...initialRows] };
  const db = {
    dialect: 'mysql',
    sql: {
      schemaMigrations: {
        list: 'SELECT version, description, type, script, checksum, applied_at, applied_by, execution_ms, status, error_message FROM schema_migrations',
        findByVersion: 'SELECT version, description, type, script, checksum, applied_at, applied_by, execution_ms, status, error_message FROM schema_migrations WHERE version = ?',
        upsert: 'UPSERT_PLACEHOLDER',
        deleteFailed: "DELETE FROM schema_migrations WHERE version = ? AND status = 'failed'"
      }
    },
    execute: async (sql, params) => {
      calls.execute.push({ sql, params });
      if (executeImpl) return executeImpl(sql, params);
      // Default: pretend UPSERT affected 1 row
      return { rows: [], affectedRows: 1 };
    },
    query: async (sql, params) => {
      calls.query.push({ sql, params });
      // The list query returns all rows from state
      return { rows: state.rows };
    },
    transaction: async (work) => {
      calls.transaction.push(true);
      // The service runs migration stmts INSIDE transaction; the upsert
      // runs OUTSIDE. For tests, we run the work() and just track call count.
      const tx = {
        execute: async (sql, params) => {
          calls.execute.push({ sql, params, inTx: true });
          return { rows: [], affectedRows: 0 };
        }
      };
      return await work(tx);
    }
  };
  return { db, calls, state };
}

// Build a fake file repo on disk so listMigrations/dryRunMigration/applyMigration
// can resolve files. Returns { repoRoot, addFile, removeFile }.
function buildFakeRepo(files) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'migrations-svc-'));
  const mysqlDir = join(repoRoot, 'db/migrations');
  const mssqlDir = join(repoRoot, 'db/migrations/mssql');
  mkdirSync(mssqlDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(mysqlDir, name), content);
    writeFileSync(join(mssqlDir, name), content); // same content for both dialects in tests
  }
  return {
    repoRoot,
    addFile(name, content) {
      writeFileSync(join(mysqlDir, name), content);
      writeFileSync(join(mssqlDir, name), content);
    },
    removeFile(name) {
      try { rmSync(join(mysqlDir, name)); } catch {}
      try { rmSync(join(mssqlDir, name)); } catch {}
    },
    cleanup() { rmSync(repoRoot, { recursive: true, force: true }); }
  };
}

describe('migrationsService.listMigrations', () => {
  let repo, db;
  beforeEach(() => {
    repo = buildFakeRepo({
      '008-lockout-events.sql': 'CREATE TABLE ad_lockout_events (id INT);',
      '009-schema-migrations.sql': 'CREATE TABLE schema_migrations (id INT);'
    });
    ({ db } = buildMockDb({
      initialRows: [{
        version: '008', description: 'lockout-events', type: 'sql',
        script: '008-lockout-events.sql',
        checksum: sha('CREATE TABLE ad_lockout_events (id INT);'),
        applied_at: '2026-08-06 12:00:00',
        applied_by: 'admin', execution_ms: 42,
        status: 'applied', error_message: null
      }]
    }));
  });

  test('returns applied status for tracked versions', async () => {
    const svc = createMigrationsService({ db, logger: { warn() {}, error() {} }, getRepoRoot: () => repo.repoRoot });
    const rows = await svc.listMigrations('mysql');
    const applied = rows.find(r => r.version === '008');
    assert.equal(applied.status, 'applied');
    assert.equal(applied.appliedBy, 'admin');
    assert.equal(applied.checksumMismatch, false);
    assert.equal(applied.scriptMissing, false);
  });

  test('returns pending status for untracked files', async () => {
    const svc = createMigrationsService({ db, logger: { warn() {}, error() {} }, getRepoRoot: () => repo.repoRoot });
    const rows = await svc.listMigrations('mysql');
    const pending = rows.find(r => r.version === '009');
    assert.equal(pending.status, 'pending');
    assert.equal(pending.checksum, null);
    assert.equal(pending.errorMessage, null);
  });

  test('detects checksum mismatch when file edited after apply', async () => {
    // Simulate post-apply edit: change the file content so its hash differs
    repo.addFile('008-lockout-events.sql', 'CREATE TABLE ad_lockout_events (id BIGINT);');
    const svc = createMigrationsService({ db, logger: { warn() {}, error() {} }, getRepoRoot: () => repo.repoRoot });
    const rows = await svc.listMigrations('mysql');
    const applied = rows.find(r => r.version === '008');
    assert.equal(applied.status, 'applied');
    assert.equal(applied.checksumMismatch, true);
  });

  test('flags scriptMissing when db/migrations/.../file.sql deleted', async () => {
    repo.removeFile('008-lockout-events.sql');
    const svc = createMigrationsService({ db, logger: { warn() {}, error() {} }, getRepoRoot: () => repo.repoRoot });
    const rows = await svc.listMigrations('mysql');
    const applied = rows.find(r => r.version === '008');
    assert.equal(applied.scriptMissing, true);
    assert.equal(applied.status, 'applied'); // status is DB truth, not file truth
  });
});

describe('migrationsService.applyMigration', () => {
  let repo, db, calls;
  beforeEach(() => {
    repo = buildFakeRepo({
      '008-lockout-events.sql': 'CREATE TABLE ad_lockout_events (id INT);'
    });
    ({ db, calls } = buildMockDb({ initialRows: [] }));
  });

  test('inserts schema_migrations row with status=applied on success', async () => {
    const svc = createMigrationsService({ db, logger: { warn() {}, error() {} }, getRepoRoot: () => repo.repoRoot });
    const result = await svc.applyMigration('008', { appliedBy: 'admin' });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'applied');
    assert.ok(result.executionMs >= 0);
    // UPSERT was called with the correct version + status='applied'
    const upsertCall = calls.execute.find(c => c.sql === 'UPSERT_PLACEHOLDER');
    assert.ok(upsertCall, 'expected upsert call');
    assert.equal(upsertCall.params[0], '008');
    assert.equal(upsertCall.params[upsertCall.params.length - 2], 'applied'); // status
    assert.equal(upsertCall.params[upsertCall.params.length - 3], 'admin');   // applied_by
  });

  test('rejects already-applied version (409 via AlreadyAppliedError)', async () => {
    // Pre-populate schema_migrations with status='applied' for 008
    ({ db, calls } = buildMockDb({
      initialRows: [{
        version: '008', description: 'lockout-events', type: 'sql',
        script: '008-lockout-events.sql', checksum: sha('CREATE TABLE ad_lockout_events (id INT);'),
        applied_at: '2026-08-06 12:00:00', applied_by: 'admin', execution_ms: 42,
        status: 'applied', error_message: null
      }]
    }));
    const svc = createMigrationsService({ db, logger: { warn() {}, error() {} }, getRepoRoot: () => repo.repoRoot });
    await assert.rejects(
      svc.applyMigration('008', { appliedBy: 'admin' }),
      (e) => e instanceof AlreadyAppliedError && e.status === 409
    );
  });

  test('allows retry on status=failed (overwrites row)', async () => {
    ({ db, calls } = buildMockDb({
      initialRows: [{
        version: '008', description: 'lockout-events', type: 'sql',
        script: '008-lockout-events.sql', checksum: 'oldchecksum',
        applied_at: '2026-08-06 12:00:00', applied_by: 'admin', execution_ms: 42,
        status: 'failed', error_message: 'prev error'
      }]
    }));
    const svc = createMigrationsService({ db, logger: { warn() {}, error() {} }, getRepoRoot: () => repo.repoRoot });
    const result = await svc.applyMigration('008', { appliedBy: 'admin' });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'applied');
  });

  test('records failed status + error_message on exception', async () => {
    // Make transaction throw
    db.transaction = async () => { throw new Error('mock execute failure'); };
    const svc = createMigrationsService({ db, logger: { warn() {}, error() {} }, getRepoRoot: () => repo.repoRoot });
    const result = await svc.applyMigration('008', { appliedBy: 'admin' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.match(result.errorMessage, /mock execute failure/);
    // Upsert was called with status='failed'
    const upsertCall = calls.execute.find(c => c.sql === 'UPSERT_PLACEHOLDER');
    assert.ok(upsertCall);
    const statusIdx = upsertCall.params.length - 2;
    assert.equal(upsertCall.params[statusIdx], 'failed');
  });
});

describe('migrationsService.resetFailedMigration', () => {
  test('deletes only status=failed rows', async () => {
    const { db, calls } = buildMockDb({ initialRows: [] });
    let deleteAffected = 1;
    db.execute = async (sql, params) => {
      calls.execute.push({ sql, params });
      if (sql.includes('DELETE FROM schema_migrations')) return { rows: [], affectedRows: deleteAffected };
      return { rows: [], affectedRows: 1 };
    };
    const svc = createMigrationsService({ db, logger: { warn() {}, error() {} }, getRepoRoot: () => tmpdir() });
    const result = await svc.resetFailedMigration('008');
    assert.equal(result.ok, true);
    assert.equal(result.deleted, 1);
  });

  test('throws NotFailedError when 0 rows affected', async () => {
    const { db } = buildMockDb({ initialRows: [] });
    db.execute = async () => ({ rows: [], affectedRows: 0 });
    const svc = createMigrationsService({ db, logger: { warn() {}, error() {} }, getRepoRoot: () => tmpdir() });
    await assert.rejects(
      svc.resetFailedMigration('008'),
      (e) => e instanceof NotFailedError && e.status === 409
    );
  });
});

describe('migrationsService.dryRunMigration', () => {
  test('returns split statements without executing', async () => {
    const repo = buildFakeRepo({
      '008-lockout-events.sql': 'CREATE TABLE ad_lockout_events (id INT);\nCREATE INDEX ix_test ON ad_lockout_events (id);'
    });
    const { db, calls } = buildMockDb({ initialRows: [] });
    const svc = createMigrationsService({ db, logger: { warn() {}, error() {} }, getRepoRoot: () => repo.repoRoot });
    const result = await svc.dryRunMigration('008');
    assert.equal(result.version, '008');
    assert.equal(result.statements.length, 2);
    assert.equal(result.statements[0].ordinal, 1);
    assert.match(result.statements[0].sql, /CREATE TABLE/);
    assert.match(result.statements[1].sql, /CREATE INDEX/);
    // No execute calls were made
    assert.equal(calls.execute.length, 0);
    repo.cleanup();
  });

  test('throws MigrationFileMissingError when file not found', async () => {
    const repo = buildFakeRepo({}); // empty
    const { db } = buildMockDb({ initialRows: [] });
    const svc = createMigrationsService({ db, logger: { warn() {}, error() {} }, getRepoRoot: () => repo.repoRoot });
    await assert.rejects(
      svc.dryRunMigration('999'),
      (e) => e instanceof MigrationFileMissingError && e.status === 404
    );
    repo.cleanup();
  });
});