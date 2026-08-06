# Schema Migrations Admin — Design Spec

**Date:** 2026-08-06
**Status:** Draft

## Background

The AD Replication Dashboard ships SQL migration files in `db/migrations/{mysql,mssql}/*.sql`. Today:

- Migrations are applied **only** during the init wizard (`/api/init/db/apply`), which calls `applyAll(dialect, db)` to apply every file in sorted order.
- There is **no tracking table** of which migrations have been applied. Re-running relies on the SQL being self-idempotent (`CREATE TABLE IF NOT EXISTS`, etc.).
- **Migration 007 (`dc-card-counters`) is NOT idempotent**: `ALTER TABLE ... ADD COLUMN` will fail with `Duplicate column name` on second run. This is a latent footgun for any re-init or manual replay.
- No admin UI to inspect what's been applied, dry-run a pending migration, or selectively apply one.
- Operational pain: when shipping migration 010, ops have no way to confirm "is 010 already applied to production?" without ssh + manual SQL query.

## Goals

1. Give admins a UI to see "which migrations have been applied" vs "which are pending" for the current dialect.
2. Let admins apply a single pending migration on demand (with explicit confirmation).
3. Dry-run: show the parsed statements without executing.
4. Track SHA256 checksums to detect file tampering / post-apply edits.
5. Recover from partial failures: mark `status=failed`, allow manual `reset` to re-attempt.

## Non-goals (explicit)

- **No down migrations** (forward-only).
- **No multi-DB schema diff** (compare two DB instances). Scope is one DB vs the migration files in the repo.
- **No automatic migration on startup**. Migrations remain a deliberate admin action (init wizard or admin UI).
- **No initial schema comparison** (`db/schema/01-tables.sql` is not part of the diff). Scope is `db/migrations/*.sql` only — matches Liquibase / Flyway convention.
- **No advisory locking**. Concurrent applies race; the DB transaction serializes them and the second sees `status=applied` → 409.
- **No auto-fix** for checksum mismatch. UI warns; admin must decide.

## Architecture

```
                                  ┌──────────────────────────────┐
                                  │ db/migrations/<dialect>/*.sql │  (source of truth)
                                  └──────────────────────────────┘
                                              │ read
                                              ▼
   ┌─────────────────────────────────────────────────────────┐
   │ center/src/services/migrations.js  (new, business logic) │
   │   listMigrations(dialect)                                │
   │   applyMigration(version, {appliedBy})                   │
   │   dryRunMigration(version)                               │
   │   resetFailedMigration(version)                          │
   └─────────────────────────────────────────────────────────┘
                  ▲                              ▲
                  │ consume                      │ consume
                  │                              │
   ┌────────────────────────┐    ┌─────────────────────────────────┐
   │ center/src/init/       │    │ center/src/routes/              │
   │   schema-applier.js    │    │   schema-migrations.js (new)    │
   │   (init wizard +       │    │  4 endpoints, thin wrappers     │
   │    bootstrap)          │    │                                 │
   └────────────────────────┘    └─────────────────────────────────┘
                  ▲                              ▲
                  │                              │
                  │                              │ /api/admin/migrations/*
                  │                              ▼
                  │              ┌─────────────────────────────────┐
                  │              │ frontend/src/views/admin/       │
                  │              │   SchemaMigrationsView.vue      │
                  │              │   (list + apply + dry-run +     │
                  │              │    content viewer)              │
                  │              └─────────────────────────────────┘
                  │
                  │ backfillMigrations (init wizard)
                  │
                  │ bootstrap (server startup, see §5)
```

The `schema-applier.js` module grows by exactly one exported function (`backfillMigrations`) and one exported function for server-side bootstrap (`bootstrapMigrations`). The init wizard and the admin service share `splitSqlStatements` (already exported).

## Data Model

Migration `009` creates the `schema_migrations` tracking table:

**`db/migrations/009-schema-migrations.sql`** (mysql):
```sql
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

**`db/migrations/mssql/009-schema-migrations.sql`** (mssql): equivalent using `DATETIME2`, `NVARCHAR`, `IF OBJECT_ID(...) IS NULL BEGIN ... END;`.

Column meanings:

| Column | Meaning |
|---|---|
| `version` | e.g. `"008"`. Parsed from filename's leading numeric prefix. PK. |
| `description` | e.g. `"lockout-events"`. The trailing kebab-case part of the filename. |
| `type` | Always `'sql'` for v1. Reserved for future `'programmatic'` migrations. |
| `script` | Filename, e.g. `"008-lockout-events.sql"`. NOT the file content. |
| `checksum` | SHA256 hex (64 chars) of the file content at apply time. |
| `applied_at` | UTC datetime of apply (or backfill). |
| `applied_by` | Username from JWT (`req.user.username`) or `'system-init'` for backfill. |
| `execution_ms` | Wall-clock duration of the apply (ms). 0 for backfill. |
| `status` | `'applied'` (default) or `'failed'`. |
| `error_message` | Populated only when `status='failed'`. NULL otherwise. |

## Components

### `center/src/services/migrations.js` (new)

```js
// Factory. Injected deps: db (for queries), logger, getRepoRoot (for file lookup).
export function createMigrationsService({ db, logger, getRepoRoot })
  → { listMigrations, applyMigration, dryRunMigration, resetFailedMigration }
```

`listMigrations(dialect)`:
1. Read `db/migrations/<dialect>/*.sql` sorted by filename.
2. `SELECT * FROM schema_migrations` (entire table; PK lookup).
3. For each file, compute `status`:
   - if no row → `pending`
   - if row exists → use row.status (`applied` or `failed`)
4. For each file with a row, compute fresh SHA256 of the file content; if `!== row.checksum`, set `checksumMismatch: true`.
5. Return `[{ version, description, script, dialect, status, appliedAt, appliedBy, executionMs, checksum, checksumMismatch, errorMessage }]`.
6. If file is missing (row exists, file deleted) — emit `scriptMissing: true` flag; row stays at its DB status.

`applyMigration(version, { appliedBy })`:
1. Resolve file path; 404 if missing.
2. Read content, compute SHA256.
3. `SELECT * FROM schema_migrations WHERE version=?`:
   - If `status='applied'` → throw `AlreadyAppliedError` → router returns 409.
   - If `status='failed'` → allow retry; will overwrite the row.
   - If no row → fresh apply.
4. `splitSqlStatements(content)`.
5. **Best-effort transaction**: open `db.transaction(work)`. Inside, `for each stmt: await db.execute(stmt, [])`. On throw, transaction aborts (rollback for DML; MySQL DDL silently commits but the row insert below still aborts).
6. On success: insert/update `schema_migrations` row with `status='applied'`, `executionMs=<elapsed>`, `checksum=<sha256>`, `appliedBy=<user>`.
7. On failure: insert/update `schema_migrations` row with `status='failed'`, `errorMessage=<err.message>`, `executionMs=<elapsed>`.
8. Return `{ ok, version, status, executionMs, errorMessage? }`.

`dryRunMigration(version)`:
1. Resolve file path; 404 if missing.
2. `splitSqlStatements(content)`.
3. Return `{ version, statements: [{ ordinal: 1-based, sql }] }`. **No execution.**

`resetFailedMigration(version)`:
1. `DELETE FROM schema_migrations WHERE version=? AND status='failed'`.
2. If `affectedRows === 0` → throw `NotFailedError` → router returns 409 "version is not in failed state".
3. Return `{ ok: true, deleted: 1 }`.

### `center/src/routes/schema-migrations.js` (new)

```js
export function schemaMigrationsRouter({ requireAuth, requirePerm, logger, getRepoRoot })
```

Mounted at `/api/admin/migrations/*`. Per-route `[userAuth, requirePerm('admin:users')]` chain matches other admin endpoints.

| Method | Path | Body | 2xx | 4xx |
|---|---|---|---|---|
| GET | `/api/admin/migrations` | — | `[{ ...list result }]` | 500 internal |
| POST | `/api/admin/migrations/:version/apply` | `{ appliedBy?: string }` | `{ ok, version, status, executionMs }` | 400 invalid version, 404 file missing, 409 already applied, 500 apply failed |
| POST | `/api/admin/migrations/:version/dry-run` | — | `{ version, statements: [...] }` | 404 file missing |
| POST | `/api/admin/migrations/:version/reset` | — | `{ ok, deleted: 1 }` | 404 not failed, 500 internal |

`writeAudit` is called for `apply` (action `apply_migration`) and `reset` (action `reset_failed_migration`). Dry-run and list do NOT audit.

### `center/src/init/schema-applier.js` (extended)

Two new exports:

- `backfillMigrations(dialect, db)`: called by init wizard after `applyAll`. Reads `db/migrations/<dialect>/*.sql` (skipping `009-schema-migrations.sql`), inserts one row per file with `status='applied'`, `applied_by='system-init'`, `execution_ms=0`, `checksum=<sha256>`. Idempotent via `ON DUPLICATE KEY UPDATE` (MySQL) / `MERGE` (MSSQL) on `version`.
- `bootstrapMigrations(dialect, db)`: called by `center/src/db/index.js` `init()` after first DB connection. Checks if `schema_migrations` table exists; if not, runs `009-schema-migrations.sql` then calls `backfillMigrations`. Idempotent.

### `center/src/db/index.js` (extended)

`init(config)` calls `bootstrapMigrations(dialect, db)` after driver setup, before returning. This handles existing deployments upgrading to the new code: on first startup, schema_migrations table is created and all existing migration files are backfilled as `applied`.

### Frontend

**`frontend/src/views/admin/SchemaMigrationsView.vue`** (new): see §6.

**`frontend/src/api/migrations.js`** (new):
```js
listMigrations()                  → GET  /api/admin/migrations
applyMigration(version, body)     → POST /api/admin/migrations/:version/apply
dryRunMigration(version)          → POST /api/admin/migrations/:version/dry-run
resetMigration(version)           → POST /api/admin/migrations/:version/reset
```

**Route + nav**: new entry `/admin/migrations`, requires `meta.perm === 'admin:users'`. Nav link added to the existing admin sidebar (next to Packages / Sites Catalog).

## API Contracts

Response shapes:

```ts
// GET /api/admin/migrations
type MigrationRow = {
  version: string;              // "008"
  description: string;          // "lockout-events"
  script: string;               // "008-lockout-events.sql"
  dialect: 'mysql' | 'mssql';
  status: 'applied' | 'failed' | 'pending';
  appliedAt: string | null;     // ISO 8601 UTC
  appliedBy: string | null;     // username or "system-init"
  executionMs: number | null;
  checksum: string | null;      // 64-char hex SHA256 (null when pending)
  checksumMismatch: boolean;    // true if file content now differs from applied row
  scriptMissing: boolean;       // true if db/migrations/.../file.sql not found on disk
  errorMessage: string | null;  // populated when status === 'failed'
};

// POST /api/admin/migrations/:version/apply
type ApplyResult =
  | { ok: true;  version: string; status: 'applied';         executionMs: number }
  | { ok: false; version: string; status: 'failed';          executionMs: number; errorMessage: string };

// POST /api/admin/migrations/:version/dry-run
type DryRunResult = {
  version: string;
  statements: Array<{ ordinal: number; sql: string }>;
};

// POST /api/admin/migrations/:version/reset
type ResetResult = { ok: true; deleted: number };
```

## Error Handling

| Error | Where | Behavior |
|---|---|---|
| file missing | list / apply / dry-run / reset | 404 `error: "file not found"` |
| already applied | apply | 409 `error: "version already applied"` |
| not failed (reset) | reset | 409 `error: "version is not in failed state"` |
| invalid version format (non-numeric / non-3-digit) | apply / reset / dry-run | 400 `error: "invalid version"` |
| DB execute failure | apply | service catches, writes `status='failed'` + `error_message`, returns `{ok: false, status: 'failed', errorMessage}` (HTTP 200, body indicates failure). Frontend shows error inline. |
| `writeAudit` failure | apply / reset | logged warn; do not fail the user-facing action (audit is best-effort) |
| checksum mismatch | list | `checksumMismatch: true` flag; non-blocking warning |
| script missing | list | `scriptMissing: true` flag; non-blocking warning |

## Testing

**Backend (center)**, +14 tests:

`center/tests/migrations-service.test.js` (new, 8 tests):
- `list returns applied status for tracked versions`
- `list returns pending status for untracked files`
- `list detects checksum mismatch when file edited after apply`
- `list flags scriptMissing when db/migrations/.../file.sql deleted`
- `apply inserts schema_migrations row with status=applied`
- `apply rejects already-applied version (409 via AlreadyAppliedError)`
- `apply allows retry on status=failed (overwrites row)`
- `apply records failed status + error_message on exception`
- `reset deletes only status=failed rows (409 for applied)`
- `dryRun returns split statements without executing`

`center/tests/migrations-router.test.js` (new, 4 tests):
- `GET /api/admin/migrations 401 without token`
- `POST apply 200 success → writeAudit called with action=apply_migration`
- `POST apply 409 on already-applied version`
- `POST dry-run returns statements`

`center/tests/init/bootstrap-migrations.test.js` (new, 1 test):
- `bootstrap creates schema_migrations table + backfills existing files on first run`

**Init wizard extension**:
- `center/tests/init/schema-applier.test.js` (+1 test): `backfill inserts all migration files as status=applied with applied_by='system-init'`
- `center/tests/init/router.test.js` (+1 test): `db/apply calls applyAll THEN backfillMigrations in order`

**Frontend**, +3 tests:
`frontend/tests/schema-migrations.test.js` (new, 3 tests):
- `renders table with applied + pending rows`
- `pending row shows [Dry-run] [应用]; applied row shows only [查看]`
- `click [应用] → calls applyMigration + refreshes list`

## Migration Order

After this feature lands, `db/migrations/*.sql` contains:

| # | File | Description |
|---|---|---|
| 001 | dc-site-discovery.sql | (existing) |
| 002 | permissions-table.sql | (existing) |
| 003 | port-healthcheck.sql | (existing) |
| 004 | package-system.sql | (existing) |
| 005 | sys-config-audit.sql | (existing) |
| 006 | drop-public-host-port.sql | (existing) |
| 007 | dc-card-counters.sql | (existing) |
| 008 | lockout-events.sql | (existing) |
| **009** | **schema-migrations.sql** | **(new — creates `schema_migrations` table itself)** |

`009` is created with `CREATE TABLE IF NOT EXISTS` so re-runs are no-ops.

## Upgrade Path

Existing deployments upgrading to this version go through this on first startup:

1. `center/src/db/index.js init()` runs.
2. Driver connects; `bootstrapMigrations(dialect, db)` runs:
   - Checks if `schema_migrations` table exists. Yes (because 009 ran on prior init wizard) — no-op. **OR** No — runs 009 SQL manually, then backfills 001-008 as `status='applied'`.
3. Admin opens `/admin/migrations` and sees 9 rows, all `applied`, no `pending`.

Fresh deployments:

1. Init wizard runs `applyAll` → 001-009 all run (001-008 idempotent on fresh DB; 009 creates `schema_migrations`).
2. Wizard calls `backfillMigrations` → inserts 8 rows (001-008) as `status='applied'`. 009 itself is NOT backfilled (it's the table — bootstrap handles its own existence check; admin list still includes it via filesystem read).
3. Same end state: 9 applied, 0 pending.

## Risks & Open Questions

1. **MySQL DDL is not transactional**: An `ALTER TABLE` inside `db.transaction()` silently commits. If a multi-statement migration fails at statement 3, statements 1-2 have already modified the DB. Admin must manually reconcile. `status=failed` flag surfaces this in the UI; `reset` only clears the tracking row, NOT the DB changes. Documented in admin view tooltip.

2. **Concurrent apply**: Two admins clicking Apply on the same pending version at the same instant. Both transactions race; first commits with `status='applied'`; second sees the row and 409s. Acceptable — no advisory lock.

3. **Migration file deleted after apply**: row stays; UI shows `scriptMissing: true`; 查看/Dry-run/应用 all return 404. Out of band repair.

4. **Checksum mismatch (file edited post-apply)**: UI warns; admin decides. Apply still allowed (overwrites checksum on next apply).

5. **applyBy empty string**: if JWT lacks `username`, fall back to `req.user.sub` (user id) — never empty. Test covers this edge.

6. **Migration 009 is included in the admin list as `applied`**: bootstrap adds a row for it on first call (or backfill does on init wizard). The row is what marks "009 has been applied" — but the table itself is created by 009. Slight circularity: solved by bootstrap calling `applyFile` directly on 009, bypassing the schema_migrations row check.

## Files Touched

**New (10):**
- `center/src/services/migrations.js`
- `center/src/routes/schema-migrations.js`
- `db/migrations/009-schema-migrations.sql`
- `db/migrations/mssql/009-schema-migrations.sql`
- `frontend/src/views/admin/SchemaMigrationsView.vue`
- `frontend/src/api/migrations.js`
- `frontend/tests/schema-migrations.test.js`
- `center/tests/migrations-service.test.js`
- `center/tests/migrations-router.test.js`
- `center/tests/init/bootstrap-migrations.test.js`

**Modified (4):**
- `center/src/init/schema-applier.js` (add `backfillMigrations` + `bootstrapMigrations`)
- `center/src/init/router.js` (call `backfillMigrations` after `applyAll`)
- `center/src/db/index.js` (call `bootstrapMigrations` after driver init)
- `center/server.js` (mount `schemaMigrationsRouter`)
- `frontend/src/router.js` (add `/admin/migrations` route)
- `frontend/src/components/AppLayout.vue` (add nav link)

(The "Modified" count is 6 — listed for accuracy; the count grew as I reviewed.)

## Publish Mirror

The Task 9 mirror step (existing convention) propagates all new files to `publish/` and rebuilds `publish/dist/` + `publish.zip`. No special handling.