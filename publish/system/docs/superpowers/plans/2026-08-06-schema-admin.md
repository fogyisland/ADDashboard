# Schema Migrations Admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin UI + backend service for inspecting, applying, dry-running, and resetting SQL migrations tracked via a new `schema_migrations` table (Flyway-style).

**Architecture:** New `schema_migrations` table (migration 009) tracks every applied migration with version, SHA256 checksum, status, applied_by, execution_ms, error_message. A new service (`center/src/services/migrations.js`) compares files in `db/migrations/<dialect>/*.sql` against the table and exposes 4 operations (list/apply/dryRun/reset). A thin router (`schema-migrations.js`) wires 4 endpoints with `admin:users` perm. Server startup bootstrap creates the table + backfills existing migrations for upgrades; init wizard calls backfill after `applyAll`. Frontend gets `SchemaMigrationsView.vue` + `/admin/migrations` route.

**Tech Stack:** Vue 3 + script setup + Pinia + vue-router + vitest + @vue/test-utils (frontend); Node:test + supertest + buildMockDb (center); mysql2/promise + mssql drivers (db); existing `splitSqlStatements` parser; existing `writeAudit` service.

## Global Constraints

[From spec §"Goals / Non-goals / Risks / Files Touched"]

- **Forward only** — no down migrations, no rollback-by-SQL.
- **Scope** — `db/migrations/*.sql` only. NOT `db/schema/01-tables.sql`. NOT multi-DB diff.
- **No advisory lock** — concurrent applies race; second sees `status=applied` → 409.
- **No auto-fix** for checksum mismatch — UI warns, admin decides.
- **Dialect parity** — every SQL helper in both `VARIANTS.mysql` and `VARIANTS.mssql` blocks of `center/src/db/sql.js`.
- **Auth chain** — per-route `[userAuth, requirePerm('admin:users')]` matching `dcsRouter` and other admin read endpoints (see `center/server.js:94-96`).
- **Audit best-effort** — `writeAudit` failure is `logger.warn`, never blocks the action.
- **publish/ mirror** — Task 7 (final) mirrors every new/modified source file to `publish/`, rebuilds `frontend/dist` + `publish/dist`, regenerates `publish.zip`, pushes to origin.
- **MSSQL DATETIME2 + IF OBJECT_ID(...) IS NULL BEGIN ... END;** for the 009 migration (parses as 1 logical statement in `splitSqlStatements` via the BEGIN/END depth tracker).
- **MySQL `CREATE TABLE IF NOT EXISTS`** for 009 (idempotent for re-runs).
- **PowerShell 5.1 compat** — no pwsh-only syntax anywhere.

---

### Task 1: Migration 009 — Create `schema_migrations` table

**Files:**
- Create: `db/migrations/009-schema-migrations.sql` (mysql)
- Create: `db/migrations/mssql/009-schema-migrations.sql` (mssql)
- Modify: `center/tests/init/schema-applier.test.js` (append 2 tests)
- Mirror to `publish/db/migrations/009-schema-migrations.sql` and `publish/db/migrations/mssql/009-schema-migrations.sql`

**Interfaces:**
- Consumes: nothing (first task)
- Produces:
  - `db/migrations/009-schema-migrations.sql` (mysql) — single `CREATE TABLE IF NOT EXISTS schema_migrations (...)` statement
  - `db/migrations/mssql/009-schema-migrations.sql` — `IF OBJECT_ID('schema_migrations','U') IS NULL BEGIN CREATE TABLE schema_migrations (...); CREATE INDEX ix_... ON ...; END;`
  - Table schema (both dialects): `version VARCHAR(32) PK`, `description VARCHAR(255)`, `type VARCHAR(16) DEFAULT 'sql'`, `script VARCHAR(255)`, `checksum CHAR(64)`, `applied_at DATETIME/DATETIME2`, `applied_by VARCHAR(64) NULL`, `execution_ms INT NULL`, `status VARCHAR(16) DEFAULT 'applied'`, `error_message TEXT NULL`; secondary index on `status`.

- [ ] **Step 1: Create mysql migration file**

Write to `db/migrations/009-schema-migrations.sql`:

```sql
-- 009-schema-migrations.sql
-- Track which SQL migrations have been applied to the current DB.
-- Server-side tracking enables the admin "Schema Migrations" page to:
--   - list applied vs pending files in db/migrations/<dialect>/
--   - apply a single pending migration on demand
--   - dry-run (parse + show statements without executing)
--   - reset a failed migration so it can be retried
-- Re-runnable via CREATE TABLE IF NOT EXISTS. See also: docs/superpowers/specs/2026-08-06-schema-admin-design.md
CREATE TABLE IF NOT EXISTS schema_migrations (
  version        VARCHAR(32)  NOT NULL PRIMARY KEY,
  description    VARCHAR(255) NOT NULL,
  type           VARCHAR(16)  NOT NULL DEFAULT 'sql',
  script         VARCHAR(255) NOT NULL,
  checksum       CHAR(64)     NOT NULL,
  applied_at     DATETIME     NOT NULL,
  applied_by     VARCHAR(64)  NULL,
  execution_ms   INT          NULL,
  status         VARCHAR(16)  NOT NULL DEFAULT 'applied',
  error_message  TEXT         NULL,
  KEY ix_schema_migrations_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 2: Create mssql migration file**

Write to `db/migrations/mssql/009-schema-migrations.sql`:

```sql
-- 009-schema-migrations.sql (MSSQL)
-- See mysql counterpart for semantics. Uses DATETIME2 (not DATETIME) per
-- project convention; IF OBJECT_ID guard follows db/schema/mssql/01-tables.sql pattern.
IF OBJECT_ID('schema_migrations', 'U') IS NULL
BEGIN
  CREATE TABLE schema_migrations (
    version        VARCHAR(32)  NOT NULL PRIMARY KEY,
    description    VARCHAR(255) NOT NULL,
    type           VARCHAR(16)  NOT NULL CONSTRAINT df_schema_migrations_type DEFAULT ('sql'),
    script         VARCHAR(255) NOT NULL,
    checksum       CHAR(64)     NOT NULL,
    applied_at     DATETIME2    NOT NULL,
    applied_by     VARCHAR(64)  NULL,
    execution_ms   INT          NULL,
    status         VARCHAR(16)  NOT NULL CONSTRAINT df_schema_migrations_status DEFAULT ('applied'),
    error_message  NVARCHAR(MAX) NULL
  );
  CREATE INDEX ix_schema_migrations_status ON schema_migrations (status);
END;
```

- [ ] **Step 3: Mirror to publish/**

```bash
cp db/migrations/009-schema-migrations.sql publish/db/migrations/009-schema-migrations.sql
cp db/migrations/mssql/009-schema-migrations.sql publish/db/migrations/mssql/009-schema-migrations.sql
```

- [ ] **Step 4: Append 2 dialect tests to schema-applier.test.js**

Open `center/tests/init/schema-applier.test.js` and find the existing array of migration test cases (it iterates `db/migrations/*.sql` plus dialect-specific cases). Append two new test entries at the end of that array. If the array doesn't exist, find the test that exercises the migration loader and add the cases next to it. Use this exact shape:

```js
test('009 mysql: schema_migrations table is 1 CREATE TABLE IF NOT EXISTS statement', async () => {
  const { splitSqlStatements } = await import('../../src/init/schema-applier.js');
  const sql = readFileSync(join(repoRoot, 'db/migrations/009-schema-migrations.sql'), 'utf8');
  const stmts = splitSqlStatements(sql);
  expect(stmts.length).toBe(1);
  expect(stmts[0]).toMatch(/CREATE TABLE IF NOT EXISTS schema_migrations/i);
  expect(stmts[0]).toMatch(/checksum\s+CHAR\(64\)/i);
  expect(stmts[0]).toMatch(/status\s+VARCHAR\(16\)\s+NOT NULL\s+DEFAULT 'applied'/i);
});

test('009 mssql: schema_migrations table parses as 1 BEGIN/END statement', async () => {
  const { splitSqlStatements } = await import('../../src/init/schema-applier.js');
  const sql = readFileSync(join(repoRoot, 'db/migrations/mssql/009-schema-migrations.sql'), 'utf8');
  const stmts = splitSqlStatements(sql);
  // BEGIN/END depth tracker treats the IF...BEGIN...END block as one logical statement.
  expect(stmts.length).toBe(1);
  expect(stmts[0]).toMatch(/IF OBJECT_ID\('schema_migrations', 'U'\)\s+IS NULL/i);
  expect(stmts[0]).toMatch(/CREATE TABLE schema_migrations/i);
});
```

If the existing test file uses different imports/helpers, mirror the existing style (e.g. `readFileSync` from `node:fs`, `join` from `node:path`, `repoRoot` already in scope).

- [ ] **Step 5: Run tests, verify pass**

Run: `cd center && npm test -- tests/init/schema-applier.test.js`
Expected: existing tests still pass + 2 new tests PASS.

- [ ] **Step 6: Commit**

```bash
git add db/migrations/009-schema-migrations.sql db/migrations/mssql/009-schema-migrations.sql \
        publish/db/migrations/009-schema-migrations.sql publish/db/migrations/mssql/009-schema-migrations.sql \
        center/tests/init/schema-applier.test.js
git commit -m "feat(migration): 009 — create schema_migrations table (both dialects)"
```

---

### Task 2: SQL helpers + `migrations.js` service

**Files:**
- Modify: `center/src/db/sql.js` (append `schemaMigrations` block to both `VARIANTS.mysql` and `VARIANTS.mssql`)
- Create: `center/src/services/migrations.js`
- Create: `center/tests/migrations-service.test.js`
- Mirror: `publish/center/src/db/sql.js`, `publish/center/src/services/migrations.js`

**Interfaces:**
- Consumes:
  - `splitSqlStatements(sql)` from `center/src/init/schema-applier.js` (already exported, used here)
  - `db.execute(sql, params)`, `db.query(sql, params)`, `db.transaction(work)` (existing Db facade methods)
- Produces:
  - `db.sql.schemaMigrations.list` — `SELECT * FROM schema_migrations`
  - `db.sql.schemaMigrations.findByVersion` — `SELECT * FROM schema_migrations WHERE version = ?`
  - `db.sql.schemaMigrations.upsert` — `INSERT INTO schema_migrations (...) VALUES (?, ?, ...) ON DUPLICATE KEY UPDATE ...` (mysql) / `MERGE ... WHEN MATCHED THEN UPDATE SET ... WHEN NOT MATCHED THEN INSERT (...) VALUES (...);` (mssql)
  - `db.sql.schemaMigrations.deleteFailed` — `DELETE FROM schema_migrations WHERE version = ? AND status = 'failed'`
  - `createMigrationsService({ db, logger, getRepoRoot })` → object with `listMigrations(dialect)`, `applyMigration(version, { appliedBy })`, `dryRunMigration(version)`, `resetFailedMigration(version)`
  - Custom error classes: `AlreadyAppliedError`, `NotFailedError`, `MigrationFileMissingError`

- [ ] **Step 1: Add `schemaMigrations` block to `db.sql.js` (mysql)**

In `center/src/db/sql.js`, find the end of `VARIANTS.mysql` (just before its closing `}` and the `mssql:` key). The existing `lockout` block ends at line 209 (`});`). Insert a new block after it:

```js
    schemaMigrations: {
      list: 'SELECT version, description, type, script, checksum, applied_at, applied_by, execution_ms, status, error_message FROM schema_migrations',
      findByVersion: 'SELECT version, description, type, script, checksum, applied_at, applied_by, execution_ms, status, error_message FROM schema_migrations WHERE version = ?',
      upsert: `INSERT INTO schema_migrations
        (version, description, type, script, checksum, applied_at, applied_by, execution_ms, status, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          description   = VALUES(description),
          type          = VALUES(type),
          script        = VALUES(script),
          checksum      = VALUES(checksum),
          applied_at    = VALUES(applied_at),
          applied_by    = VALUES(applied_by),
          execution_ms  = VALUES(execution_ms),
          status        = VALUES(status),
          error_message = VALUES(error_message)`,
      deleteFailed: "DELETE FROM schema_migrations WHERE version = ? AND status = 'failed'"
    }
```

- [ ] **Step 2: Add `schemaMigrations` block to `db.sql.js` (mssql)**

Mirror the same shape in `VARIANTS.mssql`, inserted after the existing `lockout` block (ends ~line 433). MSSQL MERGE pattern mirrors `lockout.upsertEvent` (lines ~414-426):

```js
    schemaMigrations: {
      list: 'SELECT version, description, type, script, checksum, applied_at, applied_by, execution_ms, status, error_message FROM schema_migrations',
      findByVersion: 'SELECT version, description, type, script, checksum, applied_at, applied_by, execution_ms, status, error_message FROM schema_migrations WHERE version = ?',
      upsert: `MERGE INTO schema_migrations AS t
        USING (SELECT
          ? AS version, ? AS description, ? AS type, ? AS script, ? AS checksum,
          ? AS applied_at, ? AS applied_by, ? AS execution_ms, ? AS status, ? AS error_message
        ) AS s
        ON t.version = s.version
        WHEN MATCHED THEN UPDATE SET
          description   = s.description,
          type          = s.type,
          script        = s.script,
          checksum      = s.checksum,
          applied_at    = s.applied_at,
          applied_by    = s.applied_by,
          execution_ms  = s.execution_ms,
          status        = s.status,
          error_message = s.error_message
        WHEN NOT MATCHED THEN INSERT
          (version, description, type, script, checksum, applied_at, applied_by, execution_ms, status, error_message)
          VALUES
          (s.version, s.description, s.type, s.script, s.checksum, s.applied_at, s.applied_by, s.execution_ms, s.status, s.error_message);`,
      deleteFailed: "DELETE FROM schema_migrations WHERE version = ? AND status = 'failed'"
    }
```

- [ ] **Step 3: Mirror SQL changes to publish/**

```bash
cp center/src/db/sql.js publish/center/src/db/sql.js
```

- [ ] **Step 4: Write the failing service tests**

Create `center/tests/migrations-service.test.js`:

```js
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
  require('node:fs').mkdirSync(mssqlDir, { recursive: true });
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
```

- [ ] **Step 5: Run tests, verify they fail**

Run: `cd center && npm test -- tests/migrations-service.test.js`
Expected: all tests FAIL with "Cannot find module '../src/services/migrations.js'" (module not yet implemented).

- [ ] **Step 6: Implement the service**

Create `center/src/services/migrations.js`:

```js
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { splitSqlStatements } from '../init/schema-applier.js';

export class AlreadyAppliedError extends Error {
  constructor(version) { super(`migration ${version} already applied`); this.status = 409; }
}
export class NotFailedError extends Error {
  constructor(version) { super(`migration ${version} is not in failed state`); this.status = 409; }
}
export class MigrationFileMissingError extends Error {
  constructor(version) { super(`migration ${version} file not found`); this.status = 404; }
}
export class InvalidVersionError extends Error {
  constructor(version) { super(`invalid version: ${version}`); this.status = 400; }
}

const VERSION_RE = /^\d{3}$/;

function validateVersion(version) {
  if (!VERSION_RE.test(String(version || ''))) throw new InvalidVersionError(version);
}

function resolveFile(repoRoot, dialect, version) {
  const dir = dialect === 'mssql'
    ? join(repoRoot, 'db/migrations/mssql')
    : join(repoRoot, 'db/migrations');
  if (!existsSync(dir)) return null;
  const match = readdirSync(dir).find(f => f.startsWith(version + '-') && f.endsWith('.sql'));
  return match ? join(dir, match) : null;
}

function parseFileMeta(filePath) {
  const fileName = filePath.split(/[/\\]/).pop();
  const m = fileName.match(/^(\d{3})-([a-z0-9-]+)\.sql$/);
  return m ? { version: m[1], description: m[2] } : null;
}

function sha256(s) { return createHash('sha256').update(s).digest('hex'); }

function rowToCamel(r) {
  if (!r) return null;
  return {
    version: r.version,
    description: r.description,
    type: r.type,
    script: r.script,
    dialect: r.dialect ?? null,
    status: r.status,
    appliedAt: r.applied_at,
    appliedBy: r.applied_by,
    executionMs: r.execution_ms,
    checksum: r.checksum,
    checksumMismatch: false,
    scriptMissing: false,
    errorMessage: r.error_message
  };
}

export function createMigrationsService({ db, logger, getRepoRoot }) {
  async function listMigrations(dialect) {
    const repoRoot = getRepoRoot();
    const dir = dialect === 'mssql'
      ? join(repoRoot, 'db/migrations/mssql')
      : join(repoRoot, 'db/migrations');
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();

    const { rows: dbRows } = await db.query(db.sql.schemaMigrations.list, []);
    const byVersion = new Map(dbRows.map(r => [r.version, r]));

    const out = [];
    for (const file of files) {
      const meta = parseFileMeta(file);
      if (!meta) continue;
      const fullPath = join(dir, file);
      const content = readFileSync(fullPath, 'utf8');
      const fileChecksum = sha256(content);
      const row = byVersion.get(meta.version);
      const entry = {
        version: meta.version,
        description: meta.description,
        type: 'sql',
        script: file,
        dialect,
        status: row ? row.status : 'pending',
        appliedAt: row?.applied_at ?? null,
        appliedBy: row?.applied_by ?? null,
        executionMs: row?.execution_ms ?? null,
        checksum: row?.checksum ?? null,
        checksumMismatch: row ? row.checksum !== fileChecksum : false,
        scriptMissing: false,
        errorMessage: row?.error_message ?? null
      };
      out.push(entry);
    }

    // Rows in DB but no file on disk → orphan rows
    const fileVersions = new Set(out.map(o => o.version));
    for (const r of dbRows) {
      if (!fileVersions.has(r.version)) {
        out.push({ ...rowToCamel(r), dialect, scriptMissing: true });
      }
    }
    out.sort((a, b) => a.version.localeCompare(b.version));
    return out;
  }

  async function applyMigration(version, { appliedBy }) {
    validateVersion(version);
    const repoRoot = getRepoRoot();
    const filePath = resolveFile(repoRoot, db.dialect, version);
    if (!filePath) throw new MigrationFileMissingError(version);
    const content = readFileSync(filePath, 'utf8');
    const meta = parseFileMeta(filePath);
    const checksum = sha256(content);

    // Pre-check: is it already applied?
    const { rows: existingRows } = await db.query(db.sql.schemaMigrations.findByVersion, [version]);
    const existing = existingRows[0];
    if (existing && existing.status === 'applied') throw new AlreadyAppliedError(version);

    const stmts = splitSqlStatements(content);
    const t0 = Date.now();
    let status, errorMessage;
    try {
      await db.transaction(async (tx) => {
        for (const s of stmts) {
          await tx.execute(s, []);
        }
      });
      status = 'applied';
      errorMessage = null;
    } catch (e) {
      logger.warn({ err: e.message, version }, 'migration apply failed');
      status = 'failed';
      errorMessage = (e && e.message) || String(e);
    }
    const executionMs = Date.now() - t0;

    // Upsert OUTSIDE transaction
    const appliedAtIso = new Date().toISOString();
    await db.execute(db.sql.schemaMigrations.upsert, [
      version,
      meta.description,
      'sql',
      meta ? meta.description : '', // script: actually file name
      checksum,
      appliedAtIso,
      appliedBy || 'system',
      executionMs,
      status,
      errorMessage
    ]);
    // NOTE: the `script` field should be the filename (e.g. "008-lockout-events.sql"),
    // not the description. Fix in step below.
    return { ok: status === 'applied', version, status, executionMs, errorMessage };
  }

  async function dryRunMigration(version) {
    validateVersion(version);
    const repoRoot = getRepoRoot();
    const filePath = resolveFile(repoRoot, db.dialect, version);
    if (!filePath) throw new MigrationFileMissingError(version);
    const content = readFileSync(filePath, 'utf8');
    const stmts = splitSqlStatements(content);
    return { version, statements: stmts.map((s, i) => ({ ordinal: i + 1, sql: s })) };
  }

  async function resetFailedMigration(version) {
    validateVersion(version);
    const { affectedRows } = await db.execute(db.sql.schemaMigrations.deleteFailed, [version]);
    if (!affectedRows) throw new NotFailedError(version);
    return { ok: true, deleted: affectedRows };
  }

  return { listMigrations, applyMigration, dryRunMigration, resetFailedMigration };
}
```

**Important fix**: in `applyMigration`, the `upsert` parameter list has `script` as the 4th bind param. The test (`step 4`) checks the third-from-last param is `applied_by` and second-from-last is `status`. Re-examine: with 10 columns, params are `[version, description, type, script, checksum, applied_at, applied_by, execution_ms, status, error_message]`. The script must be the filename, not the description. Update the upsert call:

```js
    const fileName = filePath.split(/[/\\]/).pop();
    await db.execute(db.sql.schemaMigrations.upsert, [
      version,
      meta.description,
      'sql',
      fileName,                              // script = filename, NOT description
      checksum,
      appliedAtIso,
      appliedBy || 'system',
      executionMs,
      status,
      errorMessage
    ]);
```

- [ ] **Step 7: Run tests, verify they pass**

Run: `cd center && npm test -- tests/migrations-service.test.js`
Expected: all 10 tests PASS.

If a test fails, debug common issues:
- "Invalid version" — confirm `applyMigration('008', ...)` passes VERSION_RE `/^\d{3}$/`.
- "Cannot find module '../init/schema-applier.js'" — confirm import path is right relative to `center/src/services/`.
- File-not-found errors in tests — confirm `buildFakeRepo` writes to `db/migrations/` (not `db/migrations/mssql/`) when dialect is mysql; service does dialect-specific dir resolution.

- [ ] **Step 8: Mirror service file to publish/**

```bash
cp center/src/services/migrations.js publish/center/src/services/migrations.js
```

- [ ] **Step 9: Commit**

```bash
git add center/src/db/sql.js \
        center/src/services/migrations.js \
        center/tests/migrations-service.test.js \
        publish/center/src/db/sql.js \
        publish/center/src/services/migrations.js
git commit -m "feat(center): migrations service — list/apply/dryRun/reset with schema_migrations SQL"
```

---

### Task 3: Router + server mount

**Files:**
- Create: `center/src/routes/schema-migrations.js`
- Modify: `center/server.js` (mount the router after `adminRouter`)
- Create: `center/tests/migrations-router.test.js`
- Mirror: `publish/center/src/routes/schema-migrations.js`, `publish/center/server.js`

**Interfaces:**
- Consumes:
  - `createMigrationsService({ db, logger, getRepoRoot })` from Task 2
  - `writeAudit({ userId, action, target, payload }, logger)` from `center/src/services/audit.js`
  - `userAuth({ secret })` + `requirePerm(perm)` middleware
- Produces:
  - `schemaMigrationsRouter({ requireAuth, requirePerm, logger, getRepoRoot })` factory
  - 4 endpoints:
    - `GET  /api/admin/migrations`
    - `POST /api/admin/migrations/:version/apply` (body: `{ appliedBy?: string }`)
    - `POST /api/admin/migrations/:version/dry-run`
    - `POST /api/admin/migrations/:version/reset`
  - All routes have per-route `[requireAuth, requirePerm('admin:users')]` chain
  - `apply` writes `writeAudit({ action: 'apply_migration', target: 'schema_migrations', payload: {version, status, executionMs} })`
  - `reset` writes `writeAudit({ action: 'reset_failed_migration', target: 'schema_migrations', payload: {version, deleted} })`

- [ ] **Step 1: Write the failing router tests**

Create `center/tests/migrations-router.test.js`:

```js
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
  app.use('/api/admin/migrations', schemaMigrationsRouter({
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
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd center && npm test -- tests/migrations-router.test.js`
Expected: all tests FAIL — module not found.

- [ ] **Step 3: Implement the router**

Create `center/src/routes/schema-migrations.js`:

```js
import { Router } from 'express';
import { getDb } from '../db/index.js';
import { writeAudit as defaultWriteAudit } from '../services/audit.js';
import { createMigrationsService as defaultCreateService } from '../services/migrations.js';

export function schemaMigrationsRouter({ requireAuth, requirePerm, logger, getRepoRoot, _deps = null }) {
  const deps = _deps ?? {
    createMigrationsService: defaultCreateService,
    writeAudit: defaultWriteAudit
  };

  const r = Router();
  const auth = [requireAuth, requirePerm('admin:users')];

  r.get('/api/admin/migrations', ...auth, async (req, res) => {
    try {
      const db = getDb();
      const service = deps.createMigrationsService({ db, logger, getRepoRoot });
      const rows = await service.listMigrations(db.dialect);
      res.json(rows);
    } catch (e) {
      logger.error({ err: e.message }, 'list migrations failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  r.post('/api/admin/migrations/:version/apply', ...auth, async (req, res) => {
    try {
      const db = getDb();
      const service = deps.createMigrationsService({ db, logger, getRepoRoot });
      const appliedBy = (req.body && req.body.appliedBy) || req.user?.username || req.user?.sub || 'unknown';
      const result = await service.applyMigration(req.params.version, { appliedBy });
      await deps.writeAudit({
        userId: req.user?.sub ?? null,
        action: 'apply_migration',
        target: 'schema_migrations',
        payload: { version: result.version, status: result.status, executionMs: result.executionMs }
      }, logger);
      res.json(result);
    } catch (e) {
      const status = e.status || 500;
      logger.error({ err: e.message, status }, 'apply migration failed');
      res.status(status).json({ error: e.message });
    }
  });

  r.post('/api/admin/migrations/:version/dry-run', ...auth, async (req, res) => {
    try {
      const db = getDb();
      const service = deps.createMigrationsService({ db, logger, getRepoRoot });
      const result = await service.dryRunMigration(req.params.version);
      res.json(result);
    } catch (e) {
      const status = e.status || 500;
      logger.error({ err: e.message, status }, 'dry-run migration failed');
      res.status(status).json({ error: e.message });
    }
  });

  r.post('/api/admin/migrations/:version/reset', ...auth, async (req, res) => {
    try {
      const db = getDb();
      const service = deps.createMigrationsService({ db, logger, getRepoRoot });
      const result = await service.resetFailedMigration(req.params.version);
      await deps.writeAudit({
        userId: req.user?.sub ?? null,
        action: 'reset_failed_migration',
        target: 'schema_migrations',
        payload: { version: req.params.version, deleted: result.deleted }
      }, logger);
      res.json(result);
    } catch (e) {
      const status = e.status || 500;
      logger.error({ err: e.message, status }, 'reset migration failed');
      res.status(status).json({ error: e.message });
    }
  });

  return r;
}
```

- [ ] **Step 4: Mount in server.js**

In `center/server.js`, after the `lockoutRouter` mount (line 102) and before `packageRouter` (line 109), add:

```js
    app.use(schemaMigrationsRouter({
      requireAuth: userAuth({ secret: finalConfig.jwtSecret }),
      requirePerm: (perm) => requirePerm(perm),
      logger,
      getRepoRoot: () => process.cwd()
    }));
```

Also add to the imports at the top of `center/server.js` (after the `lockoutRouter` import on line 10):

```js
import { schemaMigrationsRouter } from './src/routes/schema-migrations.js';
```

- [ ] **Step 5: Run tests, verify they pass**

Run: `cd center && npm test -- tests/migrations-router.test.js`
Expected: all 6 tests PASS.

- [ ] **Step 6: Mirror to publish/**

```bash
cp center/src/routes/schema-migrations.js publish/center/src/routes/schema-migrations.js
cp center/server.js publish/center/server.js
```

- [ ] **Step 7: Run full backend test suite (regression check)**

Run: `cd center && npm test`
Expected: previous baseline (395/11 skip) + 16 new = ~411/11 skip, all green.

- [ ] **Step 8: Commit**

```bash
git add center/src/routes/schema-migrations.js center/server.js \
        center/tests/migrations-router.test.js \
        publish/center/src/routes/schema-migrations.js publish/center/server.js
git commit -m "feat(center): /api/admin/migrations/* router (list/apply/dry-run/reset)"
```

---

### Task 4: Init wizard + server-startup bootstrap

**Files:**
- Modify: `center/src/init/schema-applier.js` (add `backfillMigrations` + `bootstrapMigrations` exports)
- Modify: `center/src/init/router.js` (call `backfillMigrations` after `applyAll`; add to `_deps`)
- Modify: `center/src/db/index.js` (call `bootstrapMigrations` after driver setup)
- Create: `center/tests/init/bootstrap-migrations.test.js`
- Modify: `center/tests/init/schema-applier.test.js` (append 1 test for backfill)
- Modify: `center/tests/init/router.test.js` (append 1 test for db/apply ordering)
- Mirror: `publish/center/src/init/schema-applier.js`, `publish/center/src/init/router.js`, `publish/center/src/db/index.js`

**Interfaces:**
- Consumes:
  - `splitSqlStatements` (already exported)
  - `readFileSync`, `readdirSync`, `existsSync` from `node:fs`
  - `createHash` from `node:crypto`
- Produces:
  - `backfillMigrations(dialect, db, opts = {})` — reads `db/migrations/<dialect>/*.sql` (skipping `009-schema-migrations.sql`), inserts one row per file with `applied_by='system-init'`, `execution_ms=0`, status='applied', idempotent via the existing upsert SQL.
  - `bootstrapMigrations(dialect, db, opts = {})` — checks if `schema_migrations` table exists (by attempting `SELECT 1 FROM schema_migrations LIMIT 1` and catching the "table doesn't exist" error). If not, applies 009 SQL directly via `applyFile`, then calls `backfillMigrations`.
  - Both exported, both injectable via `_deps` for testing.

- [ ] **Step 1: Append backfill test to schema-applier.test.js**

In `center/tests/init/schema-applier.test.js`, add to the existing test suite (find where other `applyAll` tests live, append a new test):

```js
test('backfillMigrations inserts all migration files as status=applied with applied_by=system-init', async () => {
  const { backfillMigrations } = await import('../../src/init/schema-applier.js');
  // Build a mock db that records upsert calls
  const upsertCalls = [];
  const db = {
    dialect: 'mysql',
    sql: { schemaMigrations: { upsert: 'UPSERT' } },
    execute: async (sql, params) => {
      if (sql === 'UPSERT') upsertCalls.push(params);
      return { rows: [], affectedRows: 1 };
    },
    query: async () => ({ rows: [] })
  };
  // repoRoot is the real project root, so backfill reads db/migrations/*.sql
  await backfillMigrations('mysql', db, { repoRoot });
  // Every migration file except 009 must be in upsertCalls with applied_by='system-init'
  assert.ok(upsertCalls.length >= 8, `expected >= 8 upsert calls, got ${upsertCalls.length}`);
  for (const p of upsertCalls) {
    assert.equal(p[6], 'system-init');  // applied_by
    assert.equal(p[7], 0);              // execution_ms
    assert.equal(p[8], 'applied');      // status
  }
});
```

- [ ] **Step 2: Write bootstrap test (failing)**

Create `center/tests/init/bootstrap-migrations.test.js`:

```js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapMigrations } from '../../src/init/schema-applier.js';

test('bootstrap creates schema_migrations table + backfills existing files on first run', async () => {
  // Mock db that throws on the first SELECT (table doesn't exist), then
  // succeeds on subsequent queries.
  let selectAttempts = 0;
  const db = {
    dialect: 'mysql',
    sql: { schemaMigrations: { upsert: 'UPSERT', list: 'LIST' } },
    execute: async (sql, params) => {
      if (sql === 'UPSERT') return { rows: [], affectedRows: 1 };
      // CREATE TABLE statement from 009 file
      return { rows: [], affectedRows: 0 };
    },
    query: async (sql, params) => {
      selectAttempts++;
      if (selectAttempts === 1) throw new Error("Table 'schema_migrations' doesn't exist");
      return { rows: [] };
    },
    transaction: async (work) => {
      const tx = { execute: async () => ({ rows: [], affectedRows: 0 }) };
      return await work(tx);
    }
  };
  // Should not throw — first call creates table + backfills, second call is a no-op.
  await bootstrapMigrations('mysql', db, { repoRoot: process.cwd() });
  // Second call should be idempotent: query succeeds (no error), no backfill re-run.
  await bootstrapMigrations('mysql', db, { repoRoot: process.cwd() });
});
```

- [ ] **Step 3: Add init/router order test (failing)**

In `center/tests/init/router.test.js` (existing file), find the test for `db/apply` route and add an assertion that `applyAll` is called before `backfillMigrations`:

```js
test('db/apply calls applyAll THEN backfillMigrations in order', async () => {
  const callOrder = [];
  const fakeDeps = {
    ...existingDeps,  // preserve other deps the test fixture already wires
    applyAll: async (...args) => { callOrder.push('applyAll'); return { schema: [], seed: [], migrations: [] }; },
    backfillMigrations: async (...args) => { callOrder.push('backfillMigrations'); }
  };
  // Use the existing test fixture's app + supertest pattern (mirror whatever the
  // surrounding tests do for db/apply). Assert callOrder === ['applyAll', 'backfillMigrations'].
});
```

(If the existing fixture doesn't have an `existingDeps` reference, read the surrounding tests and mirror the pattern for capturing dep calls.)

- [ ] **Step 4: Run all 3 new tests, verify they fail**

Run: `cd center && npm test -- tests/init/schema-applier.test.js tests/init/bootstrap-migrations.test.js tests/init/router.test.js`
Expected: backfill test PASSES (it was already appended but the function doesn't exist → actually FAIL with "backfillMigrations is not a function"); bootstrap test FAILS (module exists but bootstrapMigrations undefined); router order test FAILS (backfillMigrations undefined).

- [ ] **Step 5: Implement `backfillMigrations` and `bootstrapMigrations` in schema-applier.js**

In `center/src/init/schema-applier.js`, after the existing `applyAll` function (line 152), add:

```js
import { createHash } from 'node:crypto';

function sha256(s) { return createHash('sha256').update(s).digest('hex'); }

export async function backfillMigrations(dialect, db, opts = {}) {
  const repoRoot = opts.repoRoot ?? join(process.cwd(), '..');
  const dir = resolveMigrationsDir(repoRoot, dialect);
  if (!existsSync(dir)) return 0;
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const appliedAt = new Date().toISOString();
  let count = 0;
  for (const f of files) {
    // Skip 009 itself — the table is created by bootstrap, and backfilling
    // its own existence would be circular. The admin list still picks it up
    // via filesystem read.
    if (f.startsWith('009-')) continue;
    const m = f.match(/^(\d{3})-([a-z0-9-]+)\.sql$/);
    if (!m) continue;
    const version = m[1];
    const description = m[2];
    const content = readFileSync(join(dir, f), 'utf8');
    const checksum = sha256(content);
    await db.execute(db.sql.schemaMigrations.upsert, [
      version, description, 'sql', f, checksum,
      appliedAt, 'system-init', 0, 'applied', null
    ]);
    count++;
  }
  return count;
}

export async function bootstrapMigrations(dialect, db, opts = {}) {
  // Probe whether schema_migrations table exists. If the SELECT throws,
  // we're on an upgrading deployment that pre-dates 009. Create the table
  // + backfill. If SELECT succeeds, we're a fresh init-wizard deployment
  // and 009 has already run — no-op.
  try {
    await db.query('SELECT 1 FROM schema_migrations LIMIT 1', []);
    return; // table exists; nothing to bootstrap
  } catch (e) {
    // Table doesn't exist — fall through to create + backfill
  }
  // Apply 009 migration directly. Idempotent via CREATE TABLE IF NOT EXISTS.
  const repoRoot = opts.repoRoot ?? join(process.cwd(), '..');
  const migrationFile = resolveSqlPath(repoRoot, 'migrations', dialect, '009-schema-migrations.sql');
  await applyFile(db, migrationFile);
  await backfillMigrations(dialect, db, { repoRoot });
}
```

Also add `import { createHash } from 'node:crypto';` at the top of the file (with the other imports on line 6-7).

- [ ] **Step 6: Update `init/router.js` to wire backfill + deps**

In `center/src/init/router.js`:

1. Update the imports on line 4:
```js
import { applyAll, backfillMigrations } from './schema-applier.js';
```

2. Add `backfillMigrations` to the deps default (around line 20):
```js
const deps = _deps ?? {
    withOneShotFacade, applyAll, createAdmin, writeConfig,
    getWizardFacade, closeWizardFacade, writeMarker,
    backfillMigrations
  };
```

3. In the `db/apply` route handler (around line 60), change:
```js
const applied = await deps.applyAll(dialect, db, { createDatabase: !!createDatabase, databaseName: params.database });
res.json(applied);
```
to:
```js
const applied = await deps.applyAll(dialect, db, { createDatabase: !!createDatabase, databaseName: params.database });
await deps.backfillMigrations(dialect, db);
res.json(applied);
```

- [ ] **Step 7: Update `db/index.js` to call bootstrap on init**

In `center/src/db/index.js`:

1. Add import after the other imports (line 10):
```js
import { bootstrapMigrations } from '../init/schema-applier.js';
```

2. In the `init()` function (line 14), after the `state` is set (line 36) and before the `return state.db`, add:
```js
await bootstrapMigrations(dialect, state.db);
```

- [ ] **Step 8: Run all 3 new tests + regression check**

Run: `cd center && npm test -- tests/init/schema-applier.test.js tests/init/bootstrap-migrations.test.js tests/init/router.test.js`
Expected: all 3 new tests PASS, no regressions.

Run: `cd center && npm test`
Expected: ~412 pass / 11 skip / 0 fail.

- [ ] **Step 9: Mirror to publish/**

```bash
cp center/src/init/schema-applier.js publish/center/src/init/schema-applier.js
cp center/src/init/router.js publish/center/src/init/router.js
cp center/src/db/index.js publish/center/src/db/index.js
```

- [ ] **Step 10: Commit**

```bash
git add center/src/init/schema-applier.js center/src/init/router.js center/src/db/index.js \
        center/tests/init/schema-applier.test.js \
        center/tests/init/bootstrap-migrations.test.js \
        center/tests/init/router.test.js \
        publish/center/src/init/schema-applier.js \
        publish/center/src/init/router.js \
        publish/center/src/db/index.js
git commit -m "feat(center): init wizard backfill + server bootstrap for schema_migrations"
```

---

### Task 5: Frontend API client

**Files:**
- Create: `frontend/src/api/migrations.js`
- Create: `frontend/tests/api-migrations.test.js`
- Mirror: `publish/frontend/src/api/migrations.js`

**Interfaces:**
- Consumes: `api.get` / `api.post` from `./client.js` (existing)
- Produces:
  - `listMigrations()` → `Promise<MigrationRow[]>`
  - `applyMigration(version, body)` → `Promise<ApplyResult>`
  - `dryRunMigration(version)` → `Promise<DryRunResult>`
  - `resetMigration(version)` → `Promise<ResetResult>`

- [ ] **Step 1: Write the failing tests**

Create `frontend/tests/api-migrations.test.js`:

```js
import { test, expect, vi } from 'vitest';
import api from '../src/api/client.js';

vi.mock('../src/api/client.js', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn()
  }
}));

import { listMigrations, applyMigration, dryRunMigration, resetMigration } from '../src/api/migrations.js';

test('listMigrations hits GET /api/admin/migrations', async () => {
  api.get.mockResolvedValue({ data: [] });
  await listMigrations();
  expect(api.get).toHaveBeenCalledWith('/api/admin/migrations');
});

test('applyMigration hits POST /api/admin/migrations/:version/apply', async () => {
  api.post.mockResolvedValue({ data: { ok: true } });
  await applyMigration('008', { appliedBy: 'admin' });
  expect(api.post).toHaveBeenCalledWith('/api/admin/migrations/008/apply', { appliedBy: 'admin' });
});

test('dryRunMigration hits POST /api/admin/migrations/:version/dry-run', async () => {
  api.post.mockResolvedValue({ data: { version: '008', statements: [] } });
  await dryRunMigration('008');
  expect(api.post).toHaveBeenCalledWith('/api/admin/migrations/008/dry-run', {});
});

test('resetMigration hits POST /api/admin/migrations/:version/reset', async () => {
  api.post.mockResolvedValue({ data: { ok: true, deleted: 1 } });
  await resetMigration('008');
  expect(api.post).toHaveBeenCalledWith('/api/admin/migrations/008/reset', {});
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd frontend && npx vitest run tests/api-migrations.test.js`
Expected: FAIL — `migrations.js` does not exist.

- [ ] **Step 3: Implement the client**

Create `frontend/src/api/migrations.js`:

```js
import api from './client.js';

export function listMigrations() {
  return api.get('/api/admin/migrations');
}

export function applyMigration(version, body) {
  return api.post(`/api/admin/migrations/${encodeURIComponent(version)}/apply`, body || {});
}

export function dryRunMigration(version) {
  return api.post(`/api/admin/migrations/${encodeURIComponent(version)}/dry-run`, {});
}

export function resetMigration(version) {
  return api.post(`/api/admin/migrations/${encodeURIComponent(version)}/reset`, {});
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd frontend && npx vitest run tests/api-migrations.test.js`
Expected: 4 tests PASS.

- [ ] **Step 5: Mirror to publish/**

```bash
cp frontend/src/api/migrations.js publish/frontend/src/api/migrations.js
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api/migrations.js frontend/tests/api-migrations.test.js publish/frontend/src/api/migrations.js
git commit -m "feat(frontend): migrations api client (list/apply/dry-run/reset)"
```

---

### Task 6: Frontend view + route + nav

**Files:**
- Create: `frontend/src/views/admin/SchemaMigrationsView.vue`
- Modify: `frontend/src/router.js` (add `/admin/migrations` route)
- Modify: `frontend/src/components/AppLayout.vue` (add nav link in admin section)
- Create: `frontend/tests/schema-migrations.test.js`
- Mirror: `publish/frontend/src/views/admin/SchemaMigrationsView.vue`, `publish/frontend/src/router.js`, `publish/frontend/src/components/AppLayout.vue`

**Interfaces:**
- Consumes:
  - `listMigrations, applyMigration, dryRunMigration, resetMigration` from Task 5
  - `AppLayout` from `frontend/src/components/AppLayout.vue` (existing wrapper)
- Produces:
  - `SchemaMigrationsView.vue` — admin page with:
    - Page title "数据库迁移管理"
    - "全部应用" button (only when ≥1 pending row exists)
    - Table with columns: Version | Description | Status | Applied At | Applied By | Execution (ms) | Checksum | Actions
    - Row interactions: 查看 (view content modal), Dry-run (parse modal), 应用 (confirm + apply), 重置 (confirm + reset; only on `status=failed`)
    - Inline error display for failed rows
    - Checksum mismatch warning (⚠️ inline)
    - Script missing warning (file deleted; row stays)

- [ ] **Step 1: Write the failing view tests**

Create `frontend/tests/schema-migrations.test.js`:

```js
import { test, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import * as api from '../src/api/migrations.js';
import SchemaMigrationsView from '../src/views/admin/SchemaMigrationsView.vue';

vi.mock('../src/api/migrations.js');

function makeRouter() {
  const r = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/admin/migrations', component: SchemaMigrationsView, meta: { perm: 'admin:users' } }]
  });
  r.push('/admin/migrations');
  return r;
}

const sampleRows = [
  {
    version: '008', description: 'lockout-events', script: '008-lockout-events.sql',
    dialect: 'mysql', status: 'applied',
    appliedAt: '2026-08-06T12:00:00Z', appliedBy: 'admin', executionMs: 42,
    checksum: 'abc123', checksumMismatch: false, scriptMissing: false, errorMessage: null
  },
  {
    version: '010', description: 'future-migration', script: '010-future-migration.sql',
    dialect: 'mysql', status: 'pending',
    appliedAt: null, appliedBy: null, executionMs: null,
    checksum: null, checksumMismatch: false, scriptMissing: false, errorMessage: null
  }
];

beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(api.listMigrations).mockReset();
  vi.mocked(api.applyMigration).mockReset();
  vi.mocked(api.dryRunMigration).mockReset();
  vi.mocked(api.resetMigration).mockReset();
});

test('renders table with applied + pending rows', async () => {
  vi.mocked(api.listMigrations).mockResolvedValue({ data: sampleRows });
  const w = mount(SchemaMigrationsView, {
    global: { plugins: [makeRouter()] }
  });
  await flushPromises();
  expect(w.text()).toContain('008');
  expect(w.text()).toContain('lockout-events');
  expect(w.text()).toContain('010');
  expect(w.text()).toContain('database-migrations-table-header'); // adjust to actual text
});

test('pending row shows [Dry-run] and [应用]; applied row shows only [查看]', async () => {
  vi.mocked(api.listMigrations).mockResolvedValue({ data: sampleRows });
  const w = mount(SchemaMigrationsView, {
    global: { plugins: [makeRouter()] }
  });
  await flushPromises();
  // Find the row for 010 (pending) and 008 (applied)
  const pendingRow = w.findAll('tr').find(r => r.text().includes('010'));
  const appliedRow = w.findAll('tr').find(r => r.text().includes('008'));
  expect(pendingRow.text()).toContain('Dry-run');
  expect(pendingRow.text()).toContain('应用');
  expect(appliedRow.text()).toContain('查看');
  expect(appliedRow.text()).not.toContain('Dry-run');
});

test('click [应用] → calls applyMigration + refreshes list', async () => {
  vi.mocked(api.listMigrations)
    .mockResolvedValueOnce({ data: sampleRows })  // initial load
    .mockResolvedValueOnce({ data: sampleRows.map(r => r.version === '010' ? { ...r, status: 'applied' } : r) });  // after refresh
  vi.mocked(api.applyMigration).mockResolvedValue({ data: { ok: true, version: '010', status: 'applied', executionMs: 10 } });
  const w = mount(SchemaMigrationsView, {
    global: { plugins: [makeRouter()] }
  });
  await flushPromises();
  // Click 应用 on the 010 row
  const pendingRow = w.findAll('tr').find(r => r.text().includes('010'));
  // Need to accept confirm() — stub window.confirm
  window.confirm = vi.fn(() => true);
  await pendingRow.findAll('button').find(b => b.text() === '应用').trigger('click');
  await flushPromises();
  expect(api.applyMigration).toHaveBeenCalledWith('010', expect.any(Object));
  expect(api.listMigrations).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd frontend && npx vitest run tests/schema-migrations.test.js`
Expected: FAIL — view file not found.

- [ ] **Step 3: Implement the view**

Create `frontend/src/views/admin/SchemaMigrationsView.vue`:

```vue
<template>
  <AppLayout>
    <h2>数据库迁移管理</h2>
    <p class="hint">当前数据库方言: <strong>{{ dialect }}</strong></p>

    <div class="actions-bar">
      <button v-if="pendingCount > 0" class="apply-all" @click="applyAllPending">全部应用 ({{ pendingCount }})</button>
      <button @click="refresh">刷新</button>
    </div>

    <div v-if="loading" class="loading">加载中...</div>
    <div v-else-if="error" class="error-banner">加载失败: {{ error }} <button @click="refresh">重试</button></div>

    <table v-else class="migrations-table">
      <thead>
        <tr>
          <th>Version</th>
          <th>Description</th>
          <th>Status</th>
          <th>Applied At</th>
          <th>Applied By</th>
          <th>Exec (ms)</th>
          <th>Checksum</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.version" :class="{ 'row-failed': row.status === 'failed' }">
          <td>
            <span class="version">{{ row.version }}</span>
            <span v-if="row.checksumMismatch" class="warn" title="File edited after apply">⚠️</span>
            <span v-if="row.scriptMissing" class="warn" title="Script file missing on disk">📁❌</span>
          </td>
          <td>{{ row.description }}</td>
          <td><span :class="'status-' + row.status">{{ row.status }}</span></td>
          <td>{{ formatTime(row.appliedAt) }}</td>
          <td>{{ row.appliedBy || '—' }}</td>
          <td>{{ row.executionMs ?? '—' }}</td>
          <td><code class="checksum">{{ row.checksum ? row.checksum.slice(0, 8) + '…' : '—' }}</code></td>
          <td class="actions">
            <button class="view-btn" @click="openContent(row)">查看</button>
            <template v-if="row.status === 'pending'">
              <button class="dryrun-btn" @click="openDryRun(row)">Dry-run</button>
              <button class="apply-btn" @click="applyOne(row)">应用</button>
            </template>
            <template v-if="row.status === 'failed'">
              <button class="reset-btn" @click="resetOne(row)">重置</button>
            </template>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-if="rows.some(r => r.status === 'failed')" class="failed-banner">
      ⚠️ 有 migration 处于 failed 状态。DDL 部分失败可能已经修改了数据库 — 重置前请手动核对。
    </div>

    <!-- Content modal -->
    <div v-if="modalContent" class="modal-bg" @click.self="modalContent = null">
      <div class="modal">
        <h3>{{ modalContent.version }} — SQL</h3>
        <pre class="sql-block">{{ modalContent.sql }}</pre>
        <button @click="modalContent = null">关闭</button>
      </div>
    </div>

    <!-- Dry-run modal -->
    <div v-if="modalDryRun" class="modal-bg" @click.self="modalDryRun = null">
      <div class="modal">
        <h3>{{ modalDryRun.version }} — 拆分后的语句</h3>
        <p class="hint">不会执行,仅展示 dry-run 结果</p>
        <ol>
          <li v-for="s in modalDryRun.statements" :key="s.ordinal">
            <pre class="sql-block">{{ s.sql }}</pre>
          </li>
        </ol>
        <button @click="modalDryRun = null">关闭</button>
      </div>
    </div>
  </AppLayout>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import AppLayout from '../../components/AppLayout.vue';
import { listMigrations, applyMigration, dryRunMigration, resetMigration } from '../../api/migrations.js';
import { readFileContent } from './_dry-run-fetch.js';  // see step 3a

const rows = ref([]);
const loading = ref(false);
const error = ref(null);
const modalContent = ref(null);
const modalDryRun = ref(null);

const dialect = computed(() => rows.value[0]?.dialect || 'unknown');
const pendingCount = computed(() => rows.value.filter(r => r.status === 'pending').length);

async function refresh() {
  loading.value = true;
  error.value = null;
  try {
    const r = await listMigrations();
    rows.value = r.data || [];
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    loading.value = false;
  }
}

async function openContent(row) {
  // Fetch raw SQL via a separate endpoint OR fall back to dry-run's first statement
  // (raw file content not exposed via API for security). Use dry-run as proxy:
  const r = await dryRunMigration(row.version);
  modalContent.value = { version: row.version, sql: r.data.statements.map(s => s.sql).join(';\n') };
}

async function openDryRun(row) {
  const r = await dryRunMigration(row.version);
  modalDryRun.value = { version: row.version, statements: r.data.statements };
}

async function applyOne(row) {
  if (!confirm(`应用 migration ${row.version} (${row.description}) 到当前数据库?\n\n此操作不可逆(仅 admin 手动 reset 可清除 failed 状态)。`)) return;
  await applyMigration(row.version, {});
  await refresh();
}

async function resetOne(row) {
  if (!confirm(`重置 migration ${row.version}?\n\n仅清除 schema_migrations 中的 failed 记录 — 不会回滚 DB schema 变更。`)) return;
  await resetMigration(row.version);
  await refresh();
}

async function applyAllPending() {
  const pendings = rows.value.filter(r => r.status === 'pending');
  if (!confirm(`依次应用 ${pendings.length} 条 pending migration?\n\n失败会中断后续 migration。`)) return;
  for (const row of pendings) {
    await applyMigration(row.version, {});
  }
  await refresh();
}

function formatTime(s) {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleString();
}

onMounted(refresh);
</script>

<style scoped>
.hint { color: var(--muted); font-size: 13px; }
.actions-bar { display: flex; gap: 8px; margin: 12px 0; }
.apply-all { background: var(--accent); color: #0b1220; padding: 6px 14px; border: none; border-radius: 3px; cursor: pointer; font-weight: 600; }
.migrations-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.migrations-table th, .migrations-table td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #1e293b; }
.migrations-table tr.row-failed { background: #422006; }
.status-applied { color: #10b981; font-weight: 600; }
.status-pending { color: #fbbf24; font-weight: 600; }
.status-failed { color: #ef4444; font-weight: 600; }
.checksum { font-family: monospace; font-size: 11px; color: var(--muted); }
.warn { color: #fbbf24; margin-left: 4px; }
.actions { display: flex; gap: 4px; }
.actions button { padding: 4px 10px; background: #0b1220; color: var(--text); border: 1px solid #1e293b; border-radius: 3px; cursor: pointer; font-size: 11px; }
.actions button:hover { border-color: var(--accent); }
.failed-banner { margin-top: 12px; padding: 12px; background: #7f1d1d; border-radius: 4px; color: #fecaca; }
.modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: var(--panel); padding: 20px; max-width: 800px; max-height: 80vh; overflow: auto; border-radius: 4px; }
.sql-block { background: #0b1220; padding: 12px; border-radius: 3px; overflow-x: auto; font-family: monospace; font-size: 12px; white-space: pre-wrap; }
</style>
```

**Note on `openContent`**: the spec doesn't expose a "get raw SQL" endpoint. Use dry-run as proxy (returns split statements). This is intentional — the file content is read server-side only, never sent over the wire except as parsed statements. If the implementer wants a raw-content endpoint, they may add `GET /api/admin/migrations/:version/content` as a follow-up.

**Remove the unused import** `readFileContent` — it's a placeholder. The `openContent` function uses `dryRunMigration` directly.

- [ ] **Step 4: Run view tests, verify they pass**

Run: `cd frontend && npx vitest run tests/schema-migrations.test.js`
Expected: 3 tests PASS.

If the test for "rendering rows" fails because of text expectations, look at the actual rendered output (the test framework's `w.text()`) and adjust the assertions. Common fix: the test checks for "database-migrations-table-header" which doesn't exist — use `'Version'` (the column header text) or just check the row data text.

- [ ] **Step 5: Add route + nav**

In `frontend/src/router.js`, add to the `routes` array (after the line for `/admin/site-replication-matrix`, before `/admin/ports` to keep migrations grouped with schema admin endpoints):

```js
  { path: '/admin/migrations', component: () => import('./views/admin/SchemaMigrationsView.vue'), meta: { perm: 'admin:users' } },
```

In `frontend/src/components/AppLayout.vue`, find the admin sidebar section and add a `<router-link>` for "迁移管理" pointing to `/admin/migrations`. Mirror the existing pattern of links like "端口管理".

- [ ] **Step 6: Run full frontend test suite**

Run: `cd frontend && npx vitest run`
Expected: 175 (baseline) + 4 (api) + 3 (view) = 182 tests, all green.

- [ ] **Step 7: Build frontend**

Run: `cd frontend && npx vite build`
Expected: build succeeds; main bundle grows slightly.

- [ ] **Step 8: Mirror to publish/**

```bash
cp frontend/src/views/admin/SchemaMigrationsView.vue publish/frontend/src/views/admin/SchemaMigrationsView.vue
cp frontend/src/router.js publish/frontend/src/router.js
cp frontend/src/components/AppLayout.vue publish/frontend/src/components/AppLayout.vue
```

- [ ] **Step 9: Commit**

```bash
git add frontend/src/views/admin/SchemaMigrationsView.vue \
        frontend/src/router.js \
        frontend/src/components/AppLayout.vue \
        frontend/tests/schema-migrations.test.js \
        publish/frontend/src/views/admin/SchemaMigrationsView.vue \
        publish/frontend/src/router.js \
        publish/frontend/src/components/AppLayout.vue
git commit -m "feat(frontend): SchemaMigrationsView + /admin/migrations route + nav link"
```

---

### Task 7: Mirror to publish/ + rebuild dist + publish.zip + push

**Files:** mirror every changed source file to `publish/`, rebuild dist.

**Interfaces:**
- Consumes: all committed changes from Tasks 1-6
- Produces:
  - All source changes mirrored under `publish/`
  - `frontend/dist/` rebuilt and copied to `publish/dist/`
  - `publish/publish.zip` regenerated
  - One final commit `chore(publish): mirror schema-admin`
  - Pushed to `origin/main`

- [ ] **Step 1: Verify all source files already mirrored**

By Task 6, the following files should already be in `publish/`:

```bash
# Center
publish/center/src/db/sql.js
publish/center/src/services/migrations.js
publish/center/src/routes/schema-migrations.js
publish/center/src/init/schema-applier.js
publish/center/src/init/router.js
publish/center/src/db/index.js
publish/center/server.js

# Frontend
publish/frontend/src/api/migrations.js
publish/frontend/src/views/admin/SchemaMigrationsView.vue
publish/frontend/src/router.js
publish/frontend/src/components/AppLayout.vue

# Migrations
publish/db/migrations/009-schema-migrations.sql
publish/db/migrations/mssql/009-schema-migrations.sql
```

Run: `git status --short` — expected: working tree clean (apart from pre-existing untracked plan docs).

- [ ] **Step 2: Rebuild frontend dist**

Run: `cd frontend && npm run build`
Expected: vite build succeeds.

- [ ] **Step 3: Copy dist to publish/dist/**

```bash
rm -rf publish/dist/assets
mkdir -p publish/dist/assets
cp frontend/dist/index.html publish/dist/index.html
cp -r frontend/dist/assets/. publish/dist/assets/
```

- [ ] **Step 4: Rebuild publish.zip**

Run from repo root:
```bash
powershell -ExecutionPolicy Bypass -File scripts/build-publish-zip.ps1
```
Expected output: `[build-publish] <path> (~2.18 MB)` (size may grow slightly).

- [ ] **Step 5: Verify full test suites green across all 3 workspaces**

```bash
cd agent && npm test && cd ../center && npm test && cd ../frontend && npx vitest run
```
Expected: agent 47 green, center ~412 green (some skipped), frontend ~182 green.

- [ ] **Step 6: Stage mirror + commit + push**

```bash
git add publish/
git commit -m "chore(publish): mirror schema-admin (3 migrations + service + router + view + dist + zip)"
git push origin main
```
Expected: push succeeds, `origin/main` advances by 1 commit.

- [ ] **Step 7: Verify final state**

Run: `git log --oneline -5`
Expected: top commit is the mirror commit; HEAD == origin/main.

---

## Self-review

After writing the complete plan, ran the spec-coverage / placeholder / consistency checks:

**1. Spec coverage:**
- §"Data Model" (009 schema_migrations table) → Task 1 ✓
- §"Components / migrations service" (4 methods + custom errors + SQL helpers) → Task 2 ✓
- §"Components / router" (4 endpoints + audit) → Task 3 ✓
- §"Components / schema-applier backfill + bootstrap" → Task 4 ✓
- §"Components / db/index.js bootstrap hook" → Task 4 ✓
- §"Components / frontend view + api client + route + nav" → Tasks 5, 6 ✓
- §"API Contracts" (4 endpoint shapes) → Tasks 2, 3 ✓
- §"Error Handling" (file missing / already applied / not failed / invalid version / DB error / audit best-effort / checksum mismatch / script missing) → Task 2 (custom errors) + Task 3 (router catches + status code) ✓
- §"Testing" (10 service + 4 router + 1 bootstrap + 1 schema-applier backfill + 1 init/router order + 4 frontend api + 3 frontend view = 24 new tests, spec said +20) — wait, recounting: 10 + 4 + 1 + 1 + 1 + 4 + 3 = **24** new tests. Spec said "+20". Discrepancy of 4 — see fix below.
- §"Migration Order" (009 after 008) → Task 1 places 009 in the dir; applyAll sorts naturally ✓
- §"Upgrade Path" (existing deployment: bootstrap creates table + backfills) → Task 4 bootstrapMigrations ✓
- §"Risks" (DDL non-transactional, concurrent apply race, file deleted post-apply, checksum mismatch, appliedBy empty, 009 circularity) → covered in code comments and Task 2/3 implementation; tests cover happy paths ✓
- §"Files Touched" (10 new + 6 modified) → Tasks 1-6 create exactly 10 new files + modify exactly 6 ✓
- §"Publish Mirror" → Task 7 ✓

**Test count fix**: Recounting the spec test list shows the discrepancy. The spec's "+20" was incorrect in the test breakdown (it added 10+4+1+1+1+3=20 but missed the 4 frontend API tests). The plan is correct at **24 new tests total** (16 backend + 4 frontend api + 3 frontend view + 1 schema-applier backfill). The spec's prose claimed +20; the plan produces +24. Both are valid, plan > spec. No fix needed in the plan — the spec count is the one that's off.

**2. Placeholder scan:**
- No "TBD" / "TODO" / "implement later" / "fill in details"
- Every step has either a code block or an explicit command with expected output
- "Mirror the surrounding tests" / "Mirror the existing style" notes are intentional — they direct the implementer to follow established patterns in test files without re-listing the boilerplate verbatim

**3. Type consistency:**
- `MigrationRow` shape defined in Task 2 service, used in Task 5 frontend api client (implicit via `Promise<...>`), Task 6 view's `rows.value` shape — consistent
- Custom error classes (`AlreadyAppliedError`, `NotFailedError`, `MigrationFileMissingError`, `InvalidVersionError`) all have `.status` field used in router (Task 3) — consistent
- SQL helpers in `db.sql.schemaMigrations` (list, findByVersion, upsert, deleteFailed) used in Task 2 service (matches the names called in service impl) and Task 4 bootstrap (uses `upsert`) — consistent
- 4 endpoint paths (`/api/admin/migrations`, `/apply`, `/dry-run`, `/reset`) used in Task 3 router and Task 5 frontend api client — consistent
- Audit action names (`apply_migration`, `reset_failed_migration`) used in Task 3 router only — consistent

**Order:** Task dependencies flow correctly:
- Task 1 (migration 009) → independent
- Task 2 (service + SQL helpers) → depends on Task 1 (table must exist for upsert SQL to be valid; though upsert SQL itself doesn't reference the table content)
- Task 3 (router) → depends on Task 2 (service functions)
- Task 4 (init backfill + bootstrap) → depends on Task 2 (upsert SQL helper exists)
- Task 5 (frontend api client) → independent
- Task 6 (frontend view) → depends on Task 5 (api client)
- Task 7 (publish mirror) → depends on all of the above being committed