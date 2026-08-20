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

describe('migrationsService.markApplied', () => {
  test('writes applied row without executing SQL', async () => {
    const repo = buildFakeRepo({
      '014-member-servers.sql': 'CREATE TABLE ad_member_servers (id INT);'
    });
    const { db, calls } = buildMockDb({ initialRows: [] });
    const svc = createMigrationsService({ db, logger: { warn() {}, error() {} }, getRepoRoot: () => repo.repoRoot });
    const r = await svc.markApplied('014', { appliedBy: 'admin' });
    assert.equal(r.ok, true);
    assert.equal(r.version, '014');
    assert.equal(r.status, 'applied');
    assert.equal(r.executionMs, 0);
    // Exactly one UPSERT call (no transaction, no other execute)
    const upsertCalls = calls.execute.filter(c => c.sql === 'UPSERT_PLACEHOLDER');
    assert.equal(upsertCalls.length, 1);
    const params = upsertCalls[0].params;
    assert.equal(params[0], '014');                  // version
    assert.equal(params[params.length - 2], 'applied'); // status
    assert.equal(params[params.length - 3], 'admin');   // applied_by
    repo.cleanup();
  });

  test('throws MigrationFileMissingError when file not found', async () => {
    const repo = buildFakeRepo({}); // empty
    const { db } = buildMockDb({ initialRows: [] });
    const svc = createMigrationsService({ db, logger: { warn() {}, error() {} }, getRepoRoot: () => repo.repoRoot });
    await assert.rejects(
      svc.markApplied('999', { appliedBy: 'admin' }),
      (e) => e instanceof MigrationFileMissingError && e.status === 404
    );
    repo.cleanup();
  });
});

describe('migrationsService.baseline', () => {
  test('marks all versions ≤ N as applied when markers pass', async () => {
    const repo = buildFakeRepo({
      '008-lockout-events.sql': 'CREATE TABLE ad_lockout_events (id INT);',
      '014-member-servers.sql': 'CREATE TABLE ad_member_servers (id INT);'
    });
    const { db, calls } = buildMockDb({ initialRows: [] });
    const svc = createMigrationsService({ db, logger: { warn() {}, error() {} }, getRepoRoot: () => repo.repoRoot });
    const r = await svc.baseline('014', { appliedBy: 'admin' });
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.versions));
    assert.ok(r.versions.length >= 1);
    // 008 should be in versions (≤ 014, no markers, so passes)
    assert.ok(r.versions.includes('008'));
    repo.cleanup();
  });

  test('skips files with failing verify markers', async () => {
    const repo = buildFakeRepo({
      '008-lockout-events.sql': '-- verify: table nonexistent_table\nCREATE TABLE ad_lockout_events (id INT);'
    });
    const { db } = buildMockDb({ initialRows: [] });
    // verifyMarkers reads db.sql.probe; add minimal stub
    db.sql.probe = { table: 'PROBE_TABLE_SQL', column: 'PROBE_COLUMN_SQL' };
    // verifyMarkers will query db.query with a probe SQL — return empty rows to simulate missing table
    db.query = async () => ({ rows: [] });
    const svc = createMigrationsService({ db, logger: { warn() {}, error() {} }, getRepoRoot: () => repo.repoRoot });
    const r = await svc.baseline('014', { appliedBy: 'admin' });
    assert.equal(r.ok, true);
    assert.equal(r.versions.length, 0); // skipped
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].version, '008');
    repo.cleanup();
  });
});

describe('migrationsService.applyUpTo', () => {
  test('applies all pending versions up to N in order', async () => {
    const repo = buildFakeRepo({
      '008-lockout-events.sql': 'CREATE TABLE ad_lockout_events (id INT);',
      '014-member-servers.sql': 'CREATE TABLE ad_member_servers (id INT);'
    });
    const { db, calls } = buildMockDb({ initialRows: [] });
    const svc = createMigrationsService({ db, logger: { warn() {}, error() {} }, getRepoRoot: () => repo.repoRoot });
    const r = await svc.applyUpTo('014', { appliedBy: 'admin' });
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.applied));
    // Tightened: assert exactly 2 applied (008 + 014) and that they're in
    // ascending order — matches "sequentially applies ... ordered ascending"
    // guarantee from the brief.
    assert.equal(r.applied.length, 2);
    assert.equal(r.applied[0].version, '008');
    assert.equal(r.applied[1].version, '014');
    repo.cleanup();
  });
});

describe('migrationsService.upgrade', () => {
  // Helper to add a seed file to the fake repo, matching the path the service
  // expects (db/schema/02-seed-roles.sql for mysql, db/schema/mssql/ for mssql).
  function seedFile(repo, dialect, content) {
    const dir = dialect === 'mssql'
      ? join(repo.repoRoot, 'db/schema/mssql')
      : join(repo.repoRoot, 'db/schema');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '02-seed-roles.sql'), content);
  }

  test('skips seed when stored checksum matches file (reason=unchanged)', async () => {
    const seedContent = 'INSERT INTO sys_roles (role_name) VALUES (\'admin\');';
    const repo = buildFakeRepo({
      '008-lockout-events.sql': 'CREATE TABLE ad_lockout_events (id INT);'
    });
    seedFile(repo, 'mysql', seedContent);
    const { db, calls } = buildMockDb({ initialRows: [] });
    // Seed checksum already stored = same as file -> skip
    db.sql.systemConfig = { getByKey: 'GET_CFG', upsertByKey: 'UPSERT_CFG' };
    db.query = async (sql) => {
      calls.query.push({ sql });
      if (sql === 'GET_CFG') return { rows: [{ config_key: 'db.schema_seed.checksum', config_value: sha(seedContent) }] };
      return { rows: [] };
    };
    const svc = createMigrationsService({ db, logger: { warn() {}, error() {} }, getRepoRoot: () => repo.repoRoot });
    const r = await svc.upgrade({ appliedBy: 'admin' });
    assert.equal(r.seed.ran, false);
    assert.equal(r.seed.reason, 'unchanged');
    // Upsert should NOT have been called for seed checksum
    const upsertCfgCalls = calls.execute.filter(c => c.sql === 'UPSERT_CFG');
    assert.equal(upsertCfgCalls.length, 0);
    repo.cleanup();
  });

  test('re-applies seed when stored checksum differs (reason=changed) + records new checksum', async () => {
    const seedContent = 'INSERT INTO sys_roles (role_name) VALUES (\'admin\');';
    const repo = buildFakeRepo({});
    seedFile(repo, 'mysql', seedContent);
    const { db, calls } = buildMockDb({ initialRows: [] });
    db.sql.systemConfig = { getByKey: 'GET_CFG', upsertByKey: 'UPSERT_CFG' };
    db.query = async (sql) => {
      if (sql === 'GET_CFG') return { rows: [{ config_key: 'db.schema_seed.checksum', config_value: 'stale-checksum' }] };
      return { rows: [] };
    };
    const svc = createMigrationsService({ db, logger: { warn() {}, error() {} }, getRepoRoot: () => repo.repoRoot });
    const r = await svc.upgrade({ appliedBy: 'admin' });
    assert.equal(r.seed.ran, true);
    assert.equal(r.seed.reason, 'changed');
    // Upsert was called with the new (correct) checksum
    const upsertCfgCalls = calls.execute.filter(c => c.sql === 'UPSERT_CFG');
    assert.equal(upsertCfgCalls.length, 1);
    assert.equal(upsertCfgCalls[0].params[0], 'db.schema_seed.checksum');
    assert.equal(upsertCfgCalls[0].params[1], sha(seedContent));
    repo.cleanup();
  });

  test('first-run applies seed and records checksum (reason=first-run)', async () => {
    const seedContent = 'INSERT INTO sys_roles (role_name) VALUES (\'admin\');';
    const repo = buildFakeRepo({});
    seedFile(repo, 'mysql', seedContent);
    const { db, calls } = buildMockDb({ initialRows: [] });
    db.sql.systemConfig = { getByKey: 'GET_CFG', upsertByKey: 'UPSERT_CFG' };
    db.query = async (sql) => {
      // No stored checksum → first run
      if (sql === 'GET_CFG') return { rows: [] };
      return { rows: [] };
    };
    const svc = createMigrationsService({ db, logger: { warn() {}, error() {} }, getRepoRoot: () => repo.repoRoot });
    const r = await svc.upgrade({ appliedBy: 'admin' });
    assert.equal(r.seed.ran, true);
    assert.equal(r.seed.reason, 'first-run');
    const upsertCfgCalls = calls.execute.filter(c => c.sql === 'UPSERT_CFG');
    assert.equal(upsertCfgCalls.length, 1);
    assert.equal(upsertCfgCalls[0].params[1], sha(seedContent));
    repo.cleanup();
  });

  test('applies pending migrations and reports them in result.migrations.applied', async () => {
    const repo = buildFakeRepo({
      '008-lockout-events.sql': 'CREATE TABLE ad_lockout_events (id INT);',
      '014-member-servers.sql': 'CREATE TABLE ad_member_servers (id INT);'
    });
    const { db, calls } = buildMockDb({ initialRows: [] });
    db.sql.systemConfig = { getByKey: 'GET_CFG', upsertByKey: 'UPSERT_CFG' };
    // Seed check returns existing checksum (skip)
    db.query = async (sql) => {
      if (sql === 'GET_CFG') return { rows: [{ config_key: 'db.schema_seed.checksum', config_value: 'any' }] };
      return { rows: [] };
    };
    const svc = createMigrationsService({ db, logger: { warn() {}, error() {} }, getRepoRoot: () => repo.repoRoot });
    const r = await svc.upgrade({ appliedBy: 'admin' });
    assert.ok(Array.isArray(r.migrations.applied));
    assert.equal(r.migrations.applied.length, 2);
    assert.equal(r.migrations.applied[0].version, '008');
    assert.equal(r.migrations.applied[1].version, '014');
    assert.equal(r.migrations.failed.length, 0);
    repo.cleanup();
  });

  test('reports migration failures without aborting the run', async () => {
    const repo = buildFakeRepo({
      '008-lockout-events.sql': 'CREATE TABLE ad_lockout_events (id INT);',
      '014-member-servers.sql': 'CREATE TABLE ad_member_servers (id INT);'
    });
    const { db, calls } = buildMockDb({ initialRows: [] });
    db.sql.systemConfig = { getByKey: 'GET_CFG', upsertByKey: 'UPSERT_CFG' };
    db.query = async (sql) => {
      if (sql === 'GET_CFG') return { rows: [{ config_key: 'db.schema_seed.checksum', config_value: 'any' }] };
      return { rows: [] };
    };
    // Make transaction throw so migration is recorded as failed (applyMigration
    // catches and records, doesn't rethrow)
    db.transaction = async () => { throw new Error('mock migration failure'); };
    const svc = createMigrationsService({ db, logger: { warn() {}, error() {} }, getRepoRoot: () => repo.repoRoot });
    const r = await svc.upgrade({ appliedBy: 'admin' });
    assert.equal(r.migrations.failed.length, 2);
    assert.equal(r.ok, false);
    assert.match(r.message, /失败/);
    repo.cleanup();
  });
});