# Sub-project I: Multi-Database Backend (MySQL + SQL Server) — Design Spec

**Date:** 2026-07-12
**Status:** Design (pre-implementation)
**Author:** brainstorming session

## Goal

Make the AD Dashboard `center` service run against either MySQL 5.7+ or SQL Server 2014+ with the same codebase, deploy-time-selected. Operator picks one dialect in `appsettings.json`; the service boots against that DB and never switches at runtime.

**Out of scope:** cross-platform data migration, runtime hot-swap, dual-write to two DBs at once, ORM/query-builder adoption.

## Background & Motivation

The project was originally on SQL Server and migrated to MySQL 8+ in commit `a660ea5` (2026-07-11). Some deployment targets now require SQL Server, others are MySQL-native. The team wants both as first-class without forking the codebase.

## Constraints

| Constraint | Value | Rationale |
|---|---|---|
| MySQL version floor | 5.7 | Per user; allows broader legacy support |
| SQL Server version floor | 2014 | Per user; no `DROP IF EXISTS`, no JSON native, no `STRING_AGG` |
| Driver for MySQL | `mysql2/promise` | Already in deps; do not switch |
| Driver for SQL Server | `mssql` | Microsoft-maintained, promise-friendly, parallels `mysql2` ergonomics |
| Switching model | Deploy-time via `appsettings.json` | Per user; no hot-swap needed |
| Cross-platform data migration | None | Per user; each platform gets fresh-install only |
| Test infrastructure | env-gated real DB + mock for unit | Per user; CI matrix possible later |

## Architecture

### Components

```
appsettings.json
└── db:
    ├── dialect: "mysql" | "mssql"
    ├── mysql:  { host, port, database, user, password }
    └── mssql:  { server, database, user, password, encrypt }

center/src/db/
├── index.js          ← dialect-aware DB facade (the ONLY place driver is referenced)
├── sql.js            ← frozen per-dialect SQL registry
├── drivers/
│   ├── mysql.js      ← mysql2/promise wrapper, exposes same API
│   └── mssql.js      ← mssql wrapper, exposes same API
└── README.md         ← how to add a new SQL string / new dialect

center/src/services/*.js
└── (refactored) read sql from sql.js, call db.execute/query/transaction

center/tests/
├── helpers/db-mock.js              ← upgraded from mysql-pool.js, dialect-agnostic
├── db-adapter.test.js              ← unit: placeholder rewrite, result normalization
└── integration/                    ← env-gated (TEST_SQL_URL / TEST_MSSQL_URL)
    ├── replication.integration.test.js
    ├── discovery.integration.test.js
    ├── users.integration.test.js
    ├── audit.integration.test.js
    └── dashboard.integration.test.js
```

### Boot flow

1. `server.js` loads `appsettings.json`, reads `db.dialect`
2. `db/index.js` initializes the matching driver from `db/drivers/{dialect}.js`
3. Driver connects, returns an object conforming to `Db` interface
4. `db/sql.js` builds a flat frozen dictionary from the variant matching `db.dialect`
5. `db` exports `{ dialect, sql, execute, query, transaction, healthcheck, close }`
6. Services import `db` and `sql`; routes pass `db` to services

### Service refactor pattern

Before:
```js
import { getPool } from '../db.js';
export async function upsertStatus(rows) {
  const pool = getPool();
  await pool.execute(`INSERT INTO ad_replication_status (collected_at, ...) VALUES (?, ...) ON DUPLICATE KEY UPDATE ...`, [row.collectedAt, ...]);
}
```

After:
```js
import { db } from '../db/index.js';
export async function upsertStatus(rows) {
  for (const row of rows) {
    await db.execute(db.sql.replication.upsertStatus, [
      row.collectedAt, ...
    ]);
  }
}
```

Service code is dialect-agnostic. The `?` placeholders work for both drivers (adapter rewrites for mssql).

### Adapter API

```ts
interface Db {
  dialect: 'mysql' | 'mssql';
  sql: Record<string, string>;   // flat frozen registry; one dialect at a time

  execute(sql: string, params?: any[]): Promise<{
    rows: any[];
    affectedRows: number;
    insertId?: number;
  }>;

  query(sql: string, params?: any[]): Promise<{
    rows: any[];
  }>;

  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;

  healthcheck(): Promise<void>;
  close(): Promise<void>;
}

interface Tx {
  execute(sql: string, params?: any[]): Promise<{ rows: any[]; affectedRows: number; insertId?: number }>;
  query(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}
```

### Driver differences handled inside adapter

| Concern | mysql2 | mssql | Adapter action |
|---|---|---|---|
| Placeholders | `?` positional | `@p1, @p2, …` named | Adapter rewrites `?` → `@pN` in mssql driver; binds via `.input('p1', val)` |
| Result shape | `[rows, fields]` | `{ recordset, rowsAffected }` | Normalize to `{ rows, affectedRows, insertId }` |
| INSERT id | `result.insertId` (number) | `SCOPE_IDENTITY()` | mysql: read `result.insertId`; mssql: append `; SELECT SCOPE_IDENTITY() AS id` and read first row |
| Transaction | `pool.getConnection()` + `beginTransaction/commit/rollback` | `pool.transaction()` | Adapter exposes `db.transaction(work)`; both paths use it |
| Booleans | returned as `0/1` numbers | returned as `true/false` | Adapter normalizes to `0/1` (matches schema `tinyint(1)` / `bit` semantics) |
| Datetime input | rejects ISO with `Z` and fractional for naive `datetime` | accepts ISO with `Z` and fractional for `datetime2` | Adapter applies `toMysqlDatetime()` only on mysql path; mssql path passes through |

### SQL Registry

**Single file** `center/src/db/sql.js`, ~30 SQL statements organized by service domain. Each statement is a frozen object with two dialect variants selected at boot:

```js
const variants = {
  mysql: {
    replication: {
      upsertStatus: 'INSERT INTO ad_replication_status (...) VALUES (?, ...) ON DUPLICATE KEY UPDATE ...',
      listRecent: 'SELECT ... FROM ad_replication_status ORDER BY collected_at DESC LIMIT ?',
      // ...
    },
    discovery: { upsertDc: '...', ... },
    users: { create: '...', findByUsername: '...', list: '...', update: '...', delete: '...' },
    audit: { write: '...', list: '...' },
    config: { getAll: '...', set: '...' },
    sites: { list: '...', create: '...', update: '...', delete: '...' },
    dcs: { list: '...', assignSite: '...' },
    dashboard: { sites: '...', dcs: '...', siteMatrix: '...' },
    health: { ping: 'SELECT 1' },
  },
  mssql: {
    replication: {
      upsertStatus: 'MERGE INTO ad_replication_status AS t USING (VALUES (?, ...)) AS s (...) ON t.source_dc = s.source_dc AND t.dest_dc = s.dest_dc AND t.naming_context = s.naming_context WHEN MATCHED THEN UPDATE SET ... WHEN NOT MATCHED THEN INSERT (...) VALUES (...);',
      listRecent: 'SELECT TOP (@p1) ... FROM ad_replication_status ORDER BY collected_at DESC',
      // ...
    },
    // ... same shape, mssql-dialect SQL
  },
};

export function buildSql(dialect) {
  const flat = {};
  for (const [domain, queries] of Object.entries(variants[dialect])) {
    flat[domain] = { ...queries };
  }
  return Object.freeze(flat);
}
```

Service code reads `db.sql.replication.upsertStatus` — always a string for the active dialect, never a sub-object.

**Placeholder convention:** SQL strings use `?` only (mysql2 style). Adapter rewrites for mssql; service code never sees `@p1`.

### Schema bootstrap

- `db/schema/mysql/01-tables.sql` ← current MySQL schema, unchanged
- `db/schema/mssql/01-tables.sql` ← SQL Server version, with:
  - `bit` instead of `tinyint(1)`
  - `nvarchar(N)` instead of `varchar(N)`
  - `datetime2` instead of `datetime`
  - `IF OBJECT_ID('x','U') IS NULL` instead of `CREATE TABLE IF NOT EXISTS`
  - Identity columns: `site_id INT IDENTITY(1,1) PRIMARY KEY` instead of `INT AUTO_INCREMENT PRIMARY KEY`
  - Per-table unique indexes intact

### Migrations

- `db/migrations/mysql/001-dc-site-discovery.sql` ← current, kept as-is
- `db/migrations/mssql/001-dc-site-discovery.sql` ← SQL Server version using `IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('ad_dcs') AND name = 'when_created') ALTER TABLE ad_dcs ADD when_created DATETIME2 NULL;`
- Future migrations: parallel file per dialect, applied in lexicographic order

### Installer

`scripts/install-center.ps1` changes:
- Reads `db.dialect` from `appsettings.json` (or prompts if missing)
- mysql path: existing `mysql.exe` shell logic, untouched
- mssql path: shell out to `sqlcmd -S <server> -d <database> -U <user> -P <password> -i <file>`, with `-C` flag for trust server cert
- Schema bootstrap and migrations both branch by dialect
- Does NOT auto-create SQL Server instance — operator pre-creates empty database; installer only fills tables and seeds admin

## Error handling

- Adapter wraps both drivers' connection errors into a `DbError` with `{ code, message, originalError }`. `code` is one of:
  - `ER_DUP_ENTRY` (mysql) / `EREQUEST` with `number 2627` (mssql unique violation)
  - `ECONNREFUSED` / `ETIMEDOUT` (both drivers)
  - `ER_TRUNCATED_WRONG_VALUE` (mysql) / `EREQUEST` with `number 22001` (mssql truncation)
  - Adapter maps both to a normalized `code` namespace so route handlers don't need to know which driver produced the error
- `db.healthcheck()` returns `void` on success, throws `DbError` on failure
- `db.transaction(work)` rolls back on any thrown error from `work()`; propagates the error
- Connection-pool exhaustion / timeout bubbles up as `DbError` with `code: 'POOL_TIMEOUT'`

## Testing strategy

### Layer 1: Mock-based unit tests (default, all 70+ tests rerun)

- New `center/tests/helpers/db-mock.js` replaces `tests/helpers/mysql-pool.js`
- Same recording/replay API: `buildRecordingPool(records, { dialect })`
- Default dialect in tests: `'mysql'` (preserve current test expectations)
- Existing tests updated to import from new helper (mechanical rename, no behavior change)

### Layer 2: Adapter unit tests (default, new file)

`center/tests/db-adapter.test.js`:
- Placeholder rewrite correctness (`?` → `@p1, @p2, …` for mssql)
- `insertId` extraction (mysql: direct; mssql: SCOPE_IDENTITY append)
- `affectedRows` normalization
- Boolean normalization (`true/false` → `1/0` for mssql)
- Datetime normalization (mssql: passthrough; mysql: ISO → `YYYY-MM-DD HH:MM:SS`)
- Transaction commit/rollback (mock-driver level)
- Uses mock driver instances (no real DB)

### Layer 3: Real-DB integration tests (env-gated)

`center/tests/integration/`:
- `replication.integration.test.js`: upsertStatus + listRecent round-trip
- `discovery.integration.test.js`: upsertDc round-trip
- `users.integration.test.js`: createUser + findByUsername + update + delete
- `audit.integration.test.js`: writeAudit + listAudit
- `dashboard.integration.test.js`: site-replication-matrix complex query
- Each test file pattern:
  ```js
  test('integration: replication upsertStatus round-trip', async (t) => {
    if (!process.env.TEST_SQL_URL && !process.env.TEST_MSSQL_URL) return t.skip();
    const dialect = process.env.TEST_SQL_URL ? 'mysql' : 'mssql';
    const url = process.env.TEST_SQL_URL || process.env.TEST_MSSQL_URL;
    // ... real initPool against URL, run round-trip, verify
  });
  ```
- CI can set both env vars to run both dialects in matrix; local Windows dev typically only has mysql

### CI matrix (recommended but not blocking initial release)

`.github/workflows/test.yml`:
- Job 1: lint + Layer 1 + Layer 2 (no external deps)
- Job 2 (matrix: `[mysql, mssql]`):
  - Spin up `services: [mysql]` or `services: [mssql]` container
  - Wait for readiness
  - Run Layer 3 tests with corresponding env var

## Resolved date-time bug

The runtime bug surfaced during local dev (agent report fails with `Incorrect datetime value` on `collected_at`) is fixed inside the adapter:
- mysql driver path: every Date/ISO parameter in `execute()` is run through `toMysqlDatetime()` before binding
- mssql driver path: passthrough (datetime2 columns accept ISO strings natively)
- Service code continues to send ISO strings as today
- Adapter unit test covers both branches

## Migration plan (implementation order)

This is the implementation outline; the actual task list comes from the writing-plans skill afterward.

1. Add `mssql` to `center/package.json`; install
2. Create `center/src/db/sql.js` with all SQL in both dialects
3. Create `center/src/db/drivers/mysql.js` — wrap current `mysql2/promise` calls
4. Create `center/src/db/drivers/mssql.js` — `mssql` wrapper with placeholder rewrite, SCOPE_IDENTITY append, boolean normalization
5. Create `center/src/db/index.js` — `Db` facade, picks driver by `appsettings.db.dialect`
6. Refactor `center/src/services/*.js` to import from `db` facade and `db.sql`
7. Refactor `center/src/routes/*.js` (they call `pool.execute` directly in some places) to use facade
8. Refactor `center/src/db.js` (current file) to delegate to new `db/index.js` or be replaced
9. Add `db/schema/mssql/01-tables.sql` and `db/migrations/mssql/001-...sql`
10. Update `scripts/install-center.ps1` to branch by dialect
11. Update `center/tests/helpers/db-mock.js` (replacing `mysql-pool.js`)
12. Add `center/tests/db-adapter.test.js`
13. Add `center/tests/integration/*.integration.test.js`
14. Update `docs/operations/runbook.md` with SQL Server section
15. Update `README.md` to mention dual-DB

## Risks & Open questions

- **MERGE syntax fragility**: `MERGE` with `USING (VALUES …)` is the canonical cross-version pattern for SQL Server 2014+; verified to work but verbose. If SQL Server throws on a specific dialect combination, fallback to `IF EXISTS UPDATE ELSE INSERT` two-statement pattern (also at adapter level).
- **`mssql` connection pool defaults**: default `pool.max = 10`. May need tuning per deployment; expose via `appsettings.db.mssql.pool.max`.
- **SQL Server TLS**: when `encrypt: true` (Azure SQL default), self-signed certs cause `ESOCKET`. Operator must install trusted cert or set `encrypt: false` for on-prem SQL Server without TLS.
- **Windows auth**: not supported in this scope. SQL auth only. Operator pre-creates login.
- **MySQL 5.7 vs 8.0 quirks**: CTEs and window functions NOT used in current SQL (verified during exploration). If a future query needs them, the mysql variant must use compatible syntax or be guarded behind a version check.

## Acceptance criteria

- [ ] `appsettings.db.dialect = "mysql"` → service boots, runs existing test suite green
- [ ] `appsettings.db.dialect = "mssql"` → service boots against a SQL Server 2014 instance with empty database, runs adapter tests green
- [ ] Schema + migration 001 applied cleanly on a fresh SQL Server 2014 instance
- [ ] All existing 70+ center tests pass (with mock adapter)
- [ ] Layer 2 adapter tests pass (no real DB)
- [ ] Layer 3 integration tests pass against real MySQL when `TEST_SQL_URL` set
- [ ] Layer 3 integration tests pass against real SQL Server when `TEST_MSSQL_URL` set
- [ ] Installer branches correctly: same input produces mysql or mssql schema based on config
- [ ] No SQL string literals remain in `center/src/services/` or `center/src/routes/`
- [ ] `agent` and `frontend` unchanged