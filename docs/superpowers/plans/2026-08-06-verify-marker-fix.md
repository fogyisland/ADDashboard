# Verify-Marker Root-Cause Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `backfillMigrations()`'s blind filesystem trust with marker-based DB probing — each migration file declares its artifacts via `-- verify:` headers; backfill only marks a file as `applied` when the probed artifacts actually exist in the DB.

**Architecture:** New pure-function module `center/src/init/verify-marker.js` (parse + verify). `db.sql.probe.{table,column}` SQL helpers (mysql + mssql). `backfillMigrations()` rewritten to call verifyMarkers before each upsert. Each of 8 migration files gets marker headers. The 009 circular skip becomes unnecessary — its marker `verify: table schema_migrations` probes the table 009 itself just created.

**Tech Stack:** Node.js ES modules, vitest (Node test runner), MySQL 8 / SQL Server. No new npm deps.

## Global Constraints

- **Spec source**: `docs/superpowers/specs/2026-08-06-verify-marker-fix-design.md` (commit 9674379)
- **Marker syntax** (verbatim from spec):
  - `-- verify: table <name>` — single space between `--` and `verify:`, single space between `verify:` and `table`, single space between `table` and name
  - `-- verify: column <table>.<col>` — same shape, dot separator
  - Optional marker: file without markers is backfilled as before (006 is DELETE-only, exempt)
- **Marker scan rule**: only lines in the first 50 lines of the file; ignore `-- verify:` inside `/* ... */` block comments; case-insensitive; whitespace-tolerant between tokens
- **Marker list** (verbatim from spec, 28 markers across 8 files):
  - 001: 12 column markers — `ad_sites.description`, `ad_sites.created_at`, `ad_sites.updated_at`, `ad_dcs.when_created`, `ad_dcs.is_gc`, `ad_dcs.is_rid_master`, `ad_dcs.is_schema_master`, `ad_dcs.is_domain_naming_master`, `ad_dcs.is_infrastructure_master`, `ad_dcs.site_hint`, `ad_dcs.discovered_at`, `ad_dcs.discovered_by_agent_id`
  - 002: 1 table marker — `role_permissions`
  - 003: 2 table markers — `system_ports`, `ad_agent_port_status`
  - 004: 6 table markers — `installed_packages`, `metric_gauge`, `metric_counter`, `metric_timeseries`, `metric_status`, `package_runs`
  - 005: 1 table marker — `sys_config_audit`
  - 006: **NO markers** (DELETE-only)
  - 007: 4 column markers — `ad_replication_status.users_count`, `ad_replication_status.groups_count`, `ad_replication_status.gpos_count`, `ad_replication_status.locked_count`
  - 008: 1 table marker — `ad_lockout_events`
  - 009: 1 table marker — `schema_migrations`
- **Mismatch behavior**: `logger.warn({file, version, missing}, 'verify markers missing — skipping backfill')` + skip the file; other files continue. NO throw, NO halt.
- **009 circular skip removed**: `if (f.startsWith('009-')) continue;` in `backfillMigrations` must be DELETED. 009's marker probes the table 009 itself just created (in bootstrap path) — passes naturally.
- **`backfillMigrations` return type changes**: `number` → `{ count: number, skipped: Array<{file, version, missing: string[]}> }`. Callers (`bootstrapMigrations` + init wizard) don't read the return value — ABI change is source-compatible.
- **`db.sql.probe.{table, column}` SQL** (mysql + mssql both, flat at the dialect-resolved registry root — NOT nested under dialect since `db.sql` is already resolved by `buildSql()` at boot):
  - mysql `probe.table`: `SELECT 1 AS ok FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`
  - mysql `probe.column`: `SELECT 1 AS ok FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`
  - mssql `probe.table`: `SELECT TOP 1 1 AS ok FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = ?`
  - mssql `probe.column`: `SELECT TOP 1 1 AS ok FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ? AND COLUMN_NAME = ?`
- **`verifyMarkers` signature**: `verifyMarkers(db, markers)` — NO `dialect` parameter. The `db.sql` facade is already dialect-resolved at `db.init()` time (`db/index.js:27 calls buildSql(dialect)`), so the dialect is baked into `db.sql.probe.{table,column}` strings. Adding a `dialect` param would recreate a runtime bug: calling `db.sql[dialect].probe` returns `undefined`, throwing `Cannot read properties of undefined (reading 'probe')` and being silently swallowed by the non-fatal try/catch in `db/index.js:43-47` — exactly the bug class this plan exists to kill.
- **Mirror to publish/**: 4 source files (`center/src/init/verify-marker.js`, `center/src/db/sql.js`, `center/src/init/schema-applier.js`) + 8 migration files (`db/migrations/001,002,003,004,005,007,008,009-*.sql`; 006 stays as-is). No mirror for tests or for `center/src/init/verify-marker.js`'s siblings.
- **No frontend / router / package.json changes.** No new npm dependencies.

---

### Task 1: parseVerifyMarker + tests (RED → GREEN)

**Files:**
- Create: `center/src/init/verify-marker.js`
- Create: `center/tests/verify-marker.test.js`

**Interfaces:**
- Consumes: a SQL string (the migration file content as text)
- Produces: `Marker[]` where `Marker = { kind: 'table'|'column', name: string }`. Empty array if no markers found.

- [ ] **Step 1: Create the test file with 8 failing tests**

Write `center/tests/verify-marker.test.js` using **`node:test` + `node:assert/strict`** (matching center's existing test runner — `npm test` runs `node --test`, NOT vitest):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerifyMarker } from '../src/init/verify-marker.js';

test('parses single table marker', () => {
  const sql = '-- verify: table sys_config_audit\nCREATE TABLE foo (...);';
  assert.deepStrictEqual(parseVerifyMarker(sql), [
    { kind: 'table', name: 'sys_config_audit' }
  ]);
});

test('parses single column marker', () => {
  const sql = '-- verify: column ad_dcs.is_pdc\nALTER TABLE ...;';
  assert.deepStrictEqual(parseVerifyMarker(sql), [
    { kind: 'column', name: 'ad_dcs.is_pdc' }
  ]);
});

test('parses multiple markers in same file', () => {
  const sql = [
    '-- 001-foo.sql',
    '-- verify: column ad_sites.description',
    '-- verify: column ad_dcs.is_gc',
    'CREATE TABLE bar (...);'
  ].join('\n');
  assert.deepStrictEqual(parseVerifyMarker(sql), [
    { kind: 'column', name: 'ad_sites.description' },
    { kind: 'column', name: 'ad_dcs.is_gc' }
  ]);
});

test('returns empty array for SQL with no markers', () => {
  const sql = 'CREATE TABLE foo (id INT);\nINSERT INTO foo VALUES (1);';
  assert.deepStrictEqual(parseVerifyMarker(sql), []);
});

test('stops scanning after 50 lines', () => {
  // 50 non-marker lines, then marker on line 51 — should NOT be parsed
  const lines = [];
  for (let i = 0; i < 50; i++) lines.push(`-- comment line ${i}`);
  lines.push('-- verify: table should_not_be_seen');
  const sql = lines.join('\n');
  assert.deepStrictEqual(parseVerifyMarker(sql), []);
});

test('ignores markers inside block comments', () => {
  const sql = [
    '/*',
    '-- verify: table inside_comment',
    '*/',
    '-- verify: table outside_comment',
    'CREATE TABLE foo;'
  ].join('\n');
  assert.deepStrictEqual(parseVerifyMarker(sql), [
    { kind: 'table', name: 'outside_comment' }
  ]);
});

test('case-insensitive verify keyword', () => {
  const sql = '-- VERIFY: TABLE sys_config_audit\n';
  assert.deepStrictEqual(parseVerifyMarker(sql), [
    { kind: 'table', name: 'sys_config_audit' }
  ]);
});

test('whitespace tolerant between tokens', () => {
  const sql = '--   verify:    table   sys_config_audit   \n';
  assert.deepStrictEqual(parseVerifyMarker(sql), [
    { kind: 'table', name: 'sys_config_audit' }
  ]);
});
```

- [ ] **Step 2: Run tests — verify all 8 fail**

Run: `cd center && npm test -- tests/verify-marker.test.js`
Expected: All 8 tests FAIL with "Cannot find module '../src/init/verify-marker.js'" (or similar — module doesn't exist yet).

- [ ] **Step 3: Implement parseVerifyMarker**

Create `center/src/init/verify-marker.js`:

```js
// Parses `-- verify: table X` / `-- verify: column X.Y` markers from the top
// of a SQL migration file. Returns an array of {kind, name} objects.
// Returns [] when no markers are present.
//
// Scan rules:
//   - only the first 50 non-empty lines (marker must live near the top so
//     reviewers see it before the body);
//   - lines inside /* ... */ block comments are ignored (the marker must be
//     outside any block-comment wrapping);
//   - the keyword is case-insensitive;
//   - whitespace between the tokens is collapsed.
const MAX_SCAN_LINES = 50;
const MARKER_RE = /^\s*--\s*verify:\s*(table|column)\s+(\S+)\s*$/i;

export function parseVerifyMarker(sql) {
  const lines = sql.split('\n').slice(0, MAX_SCAN_LINES);
  const out = [];
  let inBlockComment = false;
  for (const line of lines) {
    if (inBlockComment) {
      const closeIdx = line.indexOf('*/');
      if (closeIdx >= 0) {
        // resume after */
        const rest = line.slice(closeIdx + 2);
        inBlockComment = false;
        // process the rest of this line as if it were a new line
        if (rest.trim().length > 0) {
          // recurse via a one-shot: extract marker from `rest`
          const m = MARKER_RE.exec(rest);
          if (m) out.push({ kind: m[1].toLowerCase(), name: m[2] });
        }
      }
      continue;
    }
    // Look for block-comment start
    const bcStart = line.indexOf('/*');
    const beforeBc = bcStart >= 0 ? line.slice(0, bcStart) : line;
    const m = MARKER_RE.exec(beforeBc);
    if (m) out.push({ kind: m[1].toLowerCase(), name: m[2] });
    if (bcStart >= 0 && line.indexOf('*/', bcStart + 2) < 0) {
      inBlockComment = true;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests — verify all 8 pass**

Run: `cd center && npm test -- tests/verify-marker.test.js`
Expected: All 8 tests PASS.

- [ ] **Step 5: Run full center test suite — verify no regressions**

Run: `cd center && npm test`
Expected: All 431 existing tests pass + 8 new tests pass = 439 total, 0 fail. (No existing test touches this module yet, so no expected regressions.)

- [ ] **Step 6: Commit**

```bash
cd D:/ToolDevelop/ADDashboard
git add center/src/init/verify-marker.js center/tests/verify-marker.test.js
git commit -m "feat(center): parseVerifyMarker — extract verify: markers from migration headers"
```

---

### Task 2: db.sql.probe helpers + verifyMarkers + tests

**Files:**
- Modify: `center/src/db/sql.js` (add `probe` block to both mysql + mssql)
- Modify: `center/src/init/verify-marker.js` (add `verifyMarkers` function)
- Modify: `center/tests/verify-marker.test.js` (add verifyMarkers tests)

**Interfaces:**
- Consumes (from T1): `parseVerifyMarker` returns `Marker[]`
- Produces: `verifyMarkers(db, markers)` returns `Promise<{ ok: boolean, missing: string[] }>` where `missing` is human-readable like `'table sys_config_audit'` or `'column ad_dcs.is_pdc'`. `db.sql.probe.table` and `db.sql.probe.column` are new SQL string properties (flat at the dialect-resolved registry root — NOT nested under dialect, since `db.sql` is already dialect-resolved by `buildSql()` at boot).

- [ ] **Step 1: Add 3 failing tests for verifyMarkers to verify-marker.test.js**

Append to `center/tests/verify-marker.test.js` (continue using **`node:test` + `node:assert/strict`** syntax — `assert.deepStrictEqual` for objects, `assert.equal` / `assert.ok` for primitives):

```js
import { verifyMarkers } from '../src/init/verify-marker.js';
import { buildSql } from '../src/db/sql.js';

// IMPORTANT: db.sql is the already dialect-resolved registry built by
// buildSql() at db.init() time (see src/db/index.js:27), so the live facade
// is FLAT: db.sql.probe.{table,column} — NOT db.sql[dialect].probe. Mocks
// must use the real buildSql() output so wiring mistakes fail the test
// instead of passing against hand-written SQL that production never sees.
function mockDb(dialect, { presentTables = new Set(), presentColumns = new Set() } = {}) {
  const sql = buildSql(dialect);
  const calls = [];
  return {
    dialect,
    sql,
    calls,
    query: (text, params) => {
      calls.push({ text, params });
      if (text === sql.probe.table) {
        return Promise.resolve({ rows: presentTables.has(params[0]) ? [{ ok: 1 }] : [] });
      }
      if (text === sql.probe.column) {
        const colKey = `${params[0]}.${params[1]}`;
        return Promise.resolve({ rows: presentColumns.has(colKey) ? [{ ok: 1 }] : [] });
      }
      throw new Error(`unexpected probe SQL: ${text}`);
    }
  };
}

test('verifyMarkers: all present → ok=true, missing=[]', async () => {
  const db = mockDb('mysql', { presentTables: new Set(['sys_config_audit']) });
  const markers = [{ kind: 'table', name: 'sys_config_audit' }];
  const result = await verifyMarkers(db, markers);
  assert.deepStrictEqual(result, { ok: true, missing: [] });
});

test('verifyMarkers: one table missing → ok=false, missing=[table X]', async () => {
  const db = mockDb('mysql', { presentTables: new Set() });
  const markers = [{ kind: 'table', name: 'sys_config_audit' }];
  const result = await verifyMarkers(db, markers);
  assert.equal(result.ok, false);
  assert.deepStrictEqual(result.missing, ['table sys_config_audit']);
});

test('verifyMarkers: mixed kinds, column missing → ok=false, column missing in list', async () => {
  const db = mockDb('mysql', {
    presentTables: new Set(['sys_config_audit']),
    presentColumns: new Set()  // ad_dcs.is_pdc missing
  });
  const markers = [
    { kind: 'table', name: 'sys_config_audit' },
    { kind: 'column', name: 'ad_dcs.is_pdc' }
  ];
  const result = await verifyMarkers(db, markers);
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('column ad_dcs.is_pdc'));
  assert.ok(!result.missing.includes('table sys_config_audit'));
});

test('verifyMarkers: column marker splits name into [table, column] params', async () => {
  const db = mockDb('mysql', { presentColumns: new Set(['ad_dcs.is_pdc']) });
  const result = await verifyMarkers(db, [{ kind: 'column', name: 'ad_dcs.is_pdc' }]);
  assert.equal(result.ok, true);
  assert.deepStrictEqual(db.calls[0].params, ['ad_dcs', 'is_pdc']);
});

test('verifyMarkers: works against mssql probe SQL too', async () => {
  const db = mockDb('mssql', {
    presentTables: new Set(['schema_migrations']),
    presentColumns: new Set()
  });
  const result = await verifyMarkers(db, [
    { kind: 'table', name: 'schema_migrations' },
    { kind: 'column', name: 'ad_dcs.is_pdc' }
  ]);
  assert.equal(result.ok, false);
  assert.deepStrictEqual(result.missing, ['column ad_dcs.is_pdc']);
});

test('verifyMarkers: empty marker list → ok=true without querying', async () => {
  const db = mockDb('mysql');
  const result = await verifyMarkers(db, []);
  assert.deepStrictEqual(result, { ok: true, missing: [] });
  assert.equal(db.calls.length, 0);
});

test('verifyMarkers: unqualified column marker is reported missing, not probed', async () => {
  const db = mockDb('mysql');
  const result = await verifyMarkers(db, [{ kind: 'column', name: 'is_pdc' }]);
  assert.equal(result.ok, false);
  assert.deepStrictEqual(result.missing, ['column is_pdc (malformed)']);
  assert.equal(db.calls.length, 0);
});
```

- [ ] **Step 2: Run tests — verify the 3 new ones fail**

Run: `cd center && npm test -- tests/verify-marker.test.js`
Expected: The original 8 pass (parseVerifyMarker works). The 3 new tests fail with "verifyMarkers is not a function" / module not exporting it.

- [ ] **Step 3: Add `db.sql.probe` block to both dialects in db/sql.js**

Read the current `center/src/db/sql.js` to find the right insertion points. The `schemaMigrations` block in `mysql` is around line 208; the `schemaMigrations` block in `mssql` is around line 451. Insert a new `probe` block as a sibling at the same level (inside the dialect object, alongside `schemaMigrations`, `health`, `replication`, etc.).

For the `mysql` block, after the `schemaMigrations` block (line ~225), add:

```js
    probe: {
      table:  `SELECT 1 AS ok FROM information_schema.TABLES
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
      column: `SELECT 1 AS ok FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`
    }
```

For the `mssql` block, after its `schemaMigrations` block, add:

```js
    probe: {
      table:  `SELECT TOP 1 1 AS ok FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = ?`,
      column: `SELECT TOP 1 1 AS ok FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_NAME = ? AND COLUMN_NAME = ?`
    }
```

(If the structure has closing braces that make the insertion awkward, use Edit to insert at the right point — read the file first to confirm the exact structure before editing.)

- [ ] **Step 4: Implement verifyMarkers in verify-marker.js**

Append to `center/src/init/verify-marker.js`:

```js
// Probes each marker against the live DB. Returns {ok, missing}, where
// `missing` is a human-readable array like ['table sys_config_audit',
// 'column ad_dcs.is_pdc'] in marker order.
//
// IMPORTANT: db.sql is the already dialect-resolved registry built by
// buildSql() at db.init() time — so probe SQL lives at db.sql.probe (flat),
// NOT db.sql[dialect].probe. The dialect is baked into the SQL strings.
//
//   kind='table'  -> probe.table  with params [name]
//   kind='column' -> probe.column with params [table, column]
//                    (the marker name is '<table>.<column>', split on first '.')
export async function verifyMarkers(db, markers) {
  const probe = db.sql.probe;
  const missing = [];
  for (const m of markers) {
    if (m.kind === 'table') {
      const { rows } = await db.query(probe.table, [m.name]);
      if (!rows || rows.length === 0) missing.push(`table ${m.name}`);
    } else if (m.kind === 'column') {
      const dot = m.name.indexOf('.');
      if (dot < 0) {
        // A column marker without a table qualifier can't be probed. Treat it
        // as missing so the migration is skipped rather than blindly backfilled.
        missing.push(`column ${m.name} (malformed)`);
        continue;
      }
      const { rows } = await db.query(probe.column, [m.name.slice(0, dot), m.name.slice(dot + 1)]);
      if (!rows || rows.length === 0) missing.push(`column ${m.name}`);
    }
  }
  return { ok: missing.length === 0, missing };
}
```

- [ ] **Step 5: Run verify-marker tests — verify all 15 pass**

Run: `cd center && npm test -- tests/verify-marker.test.js`
Expected: All 15 tests pass (8 parseVerifyMarker + 7 verifyMarkers).

- [ ] **Step 6: Run full center test suite — verify no regressions**

Run: `cd center && npm test`
Expected: All 439 (431 + 8 + 3) tests pass, 0 fail.

- [ ] **Step 7: Commit**

```bash
cd D:/ToolDevelop/ADDashboard
git add center/src/init/verify-marker.js center/src/db/sql.js center/tests/verify-marker.test.js
git commit -m "feat(center): verifyMarkers probes DB via db.sql.probe, both dialects"
```

---

### Task 3: backfillMigrations integration + tests

**Files:**
- Modify: `center/src/init/schema-applier.js`
- Create: `center/tests/backfill-verify.test.js`

**Interfaces:**
- Consumes (from T1+T2): `parseVerifyMarker`, `verifyMarkers` from `./verify-marker.js`; `db.sql.<dialect>.probe.{table,column}`
- Produces: `backfillMigrations(dialect, db, opts)` returns `Promise<{ count: number, skipped: Array<{file, version, missing: string[]}> }>`. The `if (f.startsWith('009-')) continue;` skip is deleted. `opts.logger` is honored (defaults to `console`).

- [ ] **Step 1: Create backfill-verify.test.js with 6 failing tests**

Write `center/tests/backfill-verify.test.js` using **`node:test` + `node:assert/strict`** (NOT vitest — `npm test` runs `node --test`):

```js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backfillMigrations } from '../src/init/schema-applier.js';

let repoRoot;
let migrationsDir;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'mig-test-'));
  migrationsDir = join(repoRoot, 'db', 'migrations');
  mkdirSync(migrationsDir, { recursive: true });
});

// Build a mock DB that records executed upserts and answers probe queries
// based on a configurable set of "present" tables/columns.
function buildMockDb({ presentTables = new Set(), presentColumns = new Set(), upserts = [] } = {}) {
  return {
    sql: {
      mysql: {
        schemaMigrations: {
          upsert: 'INSERT INTO schema_migrations ... ON DUPLICATE KEY UPDATE ...'
        },
        probe: {
          table: 'SELECT 1 AS ok FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1',
          column: 'SELECT 1 AS ok FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1'
        }
      }
    },
    query: (sql, params) => {
      if (/FROM\s+information_schema\.TABLES/i.test(sql)) {
        return Promise.resolve({ rows: presentTables.has(params[0]) ? [{ ok: 1 }] : [] });
      }
      if (/FROM\s+information_schema\.COLUMNS/i.test(sql)) {
        const key = `${params[0]}.${params[1]}`;
        return Promise.resolve({ rows: presentColumns.has(key) ? [{ ok: 1 }] : [] });
      }
      return Promise.resolve({ rows: [] });
    },
    execute: (sql, params) => {
      upserts.push({ sql, params });
      return Promise.resolve({ affectedRows: 1 });
    }
  };
}

function makeFile(version, desc, body) {
  const path = join(migrationsDir, `${version}-${desc}.sql`);
  writeFileSync(path, body);
  return path;
}

const silentLogger = { warn: () => {} };

test('all markers present → all rows backfilled', async () => {
  makeFile('001', 'sites', '-- verify: column ad_sites.description\nALTER TABLE ad_sites ADD COLUMN description VARCHAR(256);');
  makeFile('005', 'audit', '-- verify: table sys_config_audit\nCREATE TABLE sys_config_audit (...);');
  const upserts = [];
  const db = buildMockDb({
    presentTables: new Set(['sys_config_audit']),
    presentColumns: new Set(['ad_sites.description']),
    upserts
  });
  const result = await backfillMigrations('mysql', db, { repoRoot, logger: silentLogger });
  assert.equal(result.count, 2);
  assert.deepStrictEqual(result.skipped, []);
  assert.equal(upserts.length, 2);
});

test('005 marker missing → skip 005 with warn, others backfilled', async () => {
  makeFile('001', 'sites', '-- verify: column ad_sites.description\nALTER TABLE ...');
  makeFile('005', 'audit', '-- verify: table sys_config_audit\nCREATE TABLE ...');
  const warns = [];
  const upserts = [];
  const db = buildMockDb({
    presentTables: new Set(),           // sys_config_audit NOT present
    presentColumns: new Set(['ad_sites.description']),
    upserts
  });
  const result = await backfillMigrations('mysql', db, {
    repoRoot,
    logger: { warn: (...args) => warns.push(args) }
  });
  assert.equal(result.count, 1);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].version, '005');
  assert.ok(result.skipped[0].missing.includes('table sys_config_audit'));
  assert.equal(warns.length, 1);
  // 005 was skipped → only 001 was upserted
  const upsertedVersions = upserts.map(u => u.params[0]);
  assert.deepStrictEqual(upsertedVersions, ['001']);
});

test('file without markers is backfilled without probe', async () => {
  makeFile('006', 'cleanup', 'DELETE FROM system_config WHERE config_key IN (...);');
  const upserts = [];
  const db = buildMockDb({ upserts });
  const result = await backfillMigrations('mysql', db, { repoRoot, logger: silentLogger });
  assert.equal(result.count, 1);
  assert.deepStrictEqual(result.skipped, []);
  assert.equal(upserts.length, 1);
});

test('multiple markers on same file, one missing → skip entire file', async () => {
  makeFile(
    '001', 'sites',
    [
      '-- verify: column ad_sites.description',
      '-- verify: column ad_dcs.is_pdc',
      'ALTER TABLE ...'
    ].join('\n')
  );
  const db = buildMockDb({
    presentColumns: new Set(['ad_sites.description'])  // ad_dcs.is_pdc missing
  });
  const result = await backfillMigrations('mysql', db, { repoRoot, logger: silentLogger });
  assert.equal(result.count, 0);
  assert.equal(result.skipped.length, 1);
  assert.ok(result.skipped[0].missing.includes('column ad_dcs.is_pdc'));
});

test('returns { count, skipped } shape', async () => {
  makeFile('001', 'sites', '-- verify: column ad_sites.description\nALTER TABLE ...');
  const db = buildMockDb({ presentColumns: new Set(['ad_sites.description']) });
  const result = await backfillMigrations('mysql', db, { repoRoot, logger: silentLogger });
  assert.ok('count' in result);
  assert.ok('skipped' in result);
  assert.ok(Array.isArray(result.skipped));
});

test('009 is backfilled via marker (no circular skip)', async () => {
  makeFile('009', 'schema-migrations', '-- verify: table schema_migrations\nCREATE TABLE schema_migrations (...);');
  const upserts = [];
  const db = buildMockDb({
    presentTables: new Set(['schema_migrations']),
    upserts
  });
  const result = await backfillMigrations('mysql', db, { repoRoot, logger: silentLogger });
  assert.equal(result.count, 1);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].params[0], '009');  // version is first upsert param
});
```

- [ ] **Step 2: Run tests — verify all 6 fail**

Run: `cd center && npm test -- tests/backfill-verify.test.js`
Expected: All 6 tests FAIL (backfillMigrations still uses the old blind-upert path; return type is `number`, not `{count, skipped}`; 009 is hard-skipped).

- [ ] **Step 3: Modify backfillMigrations in schema-applier.js**

Read `center/src/init/schema-applier.js:1-10` (imports) and `:165-193` (`backfillMigrations` body). Make these changes:

**3a. Update imports** (line ~6) — add the verify-marker import:

Find the existing import block:
```js
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
```

Add a new line after `import { createHash } ...`:
```js
import { parseVerifyMarker, verifyMarkers } from './verify-marker.js';
```

**3b. Replace `backfillMigrations` body** (lines 165-193):

Current body:
```js
export async function backfillMigrations(dialect, db, opts = {}) {
  const repoRoot = opts.repoRoot ?? join(process.cwd(), '..');
  const dir = resolveMigrationsDir(repoRoot, dialect);
  if (!existsSync(dir)) return 0;
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const appliedAt = new Date().toISOString();
  let count = 0;
  for (const f of files) {
    // Skip 009 itself — it is the migration that creates schema_migrations,
    // so backfilling a row for it from inside that same table is circular.
    // The admin list still surfaces it by reading the filesystem.
    if (f.startsWith('009-')) continue;
    const m = f.match(/^(\d{3})-([a-z0-9-]+)\.sql$/);
    if (!m) continue;
    const version = m[1];
    const description = m[2];
    const content = readFileSync(join(dir, f), 'utf8');
    const checksum = sha256(content);
    // Param order matches the upsert column list in db/sql.js:
    // (version, description, type, script, checksum, applied_at,
    //  execution_ms, applied_by, status, error_message)
    await db.execute(db.sql.schemaMigrations.upsert, [
      version, description, 'sql', f, checksum,
      appliedAt, 0, 'system-init', 'applied', null
    ]);
    count++;
  }
  return count;
}
```

Replace with:
```js
export async function backfillMigrations(dialect, db, opts = {}) {
  const repoRoot = opts.repoRoot ?? join(process.cwd(), '..');
  const dir = resolveMigrationsDir(repoRoot, dialect);
  if (!existsSync(dir)) return { count: 0, skipped: [] };
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const appliedAt = new Date().toISOString();
  const logger = opts.logger ?? console;
  let count = 0;
  const skipped = [];
  for (const f of files) {
    const m = f.match(/^(\d{3})-([a-z0-9-]+)\.sql$/);
    if (!m) continue;
    const version = m[1];
    const content = readFileSync(join(dir, f), 'utf8');

    // If the file declares verify markers, probe the DB — only backfill the
    // row when every marker is present. A missing marker means the migration
    // was never actually applied to this DB; warn + skip so the admin
    // /api/admin/migrations list surfaces it as pending.
    const markers = parseVerifyMarker(content);
    if (markers.length > 0) {
      const { ok, missing } = await verifyMarkers(db, markers);
      if (!ok) {
        logger.warn?.({ file: f, version, missing }, 'verify markers missing — skipping backfill');
        skipped.push({ file: f, version, missing });
        continue;
      }
    }

    const checksum = sha256(content);
    const description = m[2];
    // Param order matches the upsert column list in db/sql.js:
    // (version, description, type, script, checksum, applied_at,
    //  execution_ms, applied_by, status, error_message)
    await db.execute(db.sql.schemaMigrations.upsert, [
      version, description, 'sql', f, checksum,
      appliedAt, 0, 'system-init', 'applied', null
    ]);
    count++;
  }
  return { count, skipped };
}
```

Note: the `if (f.startsWith('009-')) continue;` is GONE — 009 is now handled by its own marker (`verify: table schema_migrations`), which probes the table 009 itself just created.

- [ ] **Step 4: Run backfill-verify tests — verify all 6 pass**

Run: `cd center && npm test -- tests/backfill-verify.test.js`
Expected: All 6 tests PASS.

- [ ] **Step 5: Run full center test suite — verify no regressions**

Run: `cd center && npm test`
Expected: All 445 (431 + 8 + 3 + 6 — minus the existing `admin.test.js` and `migrations.test.js` tests that called backfillMigrations expecting a number; those need adjustment — see Step 5a below) tests pass, 0 fail.

**5a. Fix any existing test that compared backfillMigrations's return to a number**:

Run: `cd center && grep -rln "backfillMigrations" tests/`

For each test file that calls `backfillMigrations` and asserts on the result:
- If the assertion uses `node:assert/strict` like `assert.equal(result, N)` or `assert.strictEqual(typeof result, 'number')`, change to `assert.equal(result.count, N)`.
- If the test does not read the return value (e.g., just calls it for side effects), no change.

Common pattern: tests in `center/tests/schema-applier.test.js` or `center/tests/bootstrap-migrations.test.js` (if they exist) will be affected. Update them in place.

If no existing test references backfillMigrations, skip this sub-step.

- [ ] **Step 6: Commit**

```bash
cd D:/ToolDevelop/ADDashboard
git add center/src/init/schema-applier.js center/tests/backfill-verify.test.js
# Also add any test files updated in Step 5a
git commit -m "feat(center): backfillMigrations probes verify markers, removes 009 circular skip"
```

---

### Task 4: Add markers to 8 migration files (data annotation, no tests)

**Files:**
- Modify: `db/migrations/001-dc-site-discovery.sql`
- Modify: `db/migrations/002-permissions-table.sql`
- Modify: `db/migrations/003-port-healthcheck.sql`
- Modify: `db/migrations/004-package-system.sql`
- Modify: `db/migrations/005-sys-config-audit.sql`
- Modify: `db/migrations/007-dc-card-counters.sql`
- Modify: `db/migrations/008-lockout-events.sql`
- Modify: `db/migrations/009-schema-migrations.sql`

006-drop-public-host-port.sql stays unchanged (DELETE-only, no markers).

- [ ] **Step 1: Add 12 column markers to 001-dc-site-discovery.sql**

Read `db/migrations/001-dc-site-discovery.sql`. Insert at the very top of the file (line 1, before `-- AD Dashboard DC/Site Discovery migration (MySQL 8+)`), add:

```sql
-- verify: column ad_sites.description
-- verify: column ad_sites.created_at
-- verify: column ad_sites.updated_at
-- verify: column ad_dcs.when_created
-- verify: column ad_dcs.is_gc
-- verify: column ad_dcs.is_rid_master
-- verify: column ad_dcs.is_schema_master
-- verify: column ad_dcs.is_domain_naming_master
-- verify: column ad_dcs.is_infrastructure_master
-- verify: column ad_dcs.site_hint
-- verify: column ad_dcs.discovered_at
-- verify: column ad_dcs.discovered_by_agent_id

```

(Keep the existing `-- AD Dashboard DC/Site Discovery migration (MySQL 8+)` line — the marker block sits above it.)

- [ ] **Step 2: Add 1 table marker to 002-permissions-table.sql**

Read `db/migrations/002-permissions-table.sql`. Insert at line 1 (before `-- AD Dashboard migration 002:`), add:

```sql
-- verify: table role_permissions

```

- [ ] **Step 3: Add 2 table markers to 003-port-healthcheck.sql**

Insert at line 1 (before `-- AD Dashboard migration 003:`), add:

```sql
-- verify: table system_ports
-- verify: table ad_agent_port_status

```

- [ ] **Step 4: Add 6 table markers to 004-package-system.sql**

Insert at line 1 (before `-- AD Dashboard migration 004:`), add:

```sql
-- verify: table installed_packages
-- verify: table metric_gauge
-- verify: table metric_counter
-- verify: table metric_timeseries
-- verify: table metric_status
-- verify: table package_runs

```

- [ ] **Step 5: Add 1 table marker to 005-sys-config-audit.sql**

The file already starts with `-- 005-sys-config-audit.sql` on line 1. Insert at line 1, BEFORE that line:

```sql
-- verify: table sys_config_audit

```

(Keep the existing `-- 005-sys-config-audit.sql` line below the new marker.)

- [ ] **Step 6: Add 4 column markers to 007-dc-card-counters.sql**

The file already starts with `-- 007-dc-card-counters.sql` on line 1. Insert at line 1, BEFORE that line:

```sql
-- verify: column ad_replication_status.users_count
-- verify: column ad_replication_status.groups_count
-- verify: column ad_replication_status.gpos_count
-- verify: column ad_replication_status.locked_count

```

- [ ] **Step 7: Add 1 table marker to 008-lockout-events.sql**

The file already starts with `-- 008-lockout-events.sql` on line 1. Insert at line 1, BEFORE that line:

```sql
-- verify: table ad_lockout_events

```

- [ ] **Step 8: Add 1 table marker to 009-schema-migrations.sql**

The file already starts with `-- 009-schema-migrations.sql` on line 1. Insert at line 1, BEFORE that line:

```sql
-- verify: table schema_migrations

```

- [ ] **Step 9: Run full center test suite — verify no regressions from marker additions**

Run: `cd center && npm test`
Expected: All 445+ tests still pass. (The marker additions are pure annotation — no migration file is executed by tests against a real DB in this suite, so no behavior change is expected. The integration tests in T3 use their own temp migration files, not the real ones.)

- [ ] **Step 10: Commit**

```bash
cd D:/ToolDevelop/ADDashboard
git add db/migrations/001-dc-site-discovery.sql \
        db/migrations/002-permissions-table.sql \
        db/migrations/003-port-healthcheck.sql \
        db/migrations/004-package-system.sql \
        db/migrations/005-sys-config-audit.sql \
        db/migrations/007-dc-card-counters.sql \
        db/migrations/008-lockout-events.sql \
        db/migrations/009-schema-migrations.sql
git commit -m "feat(migration): add verify markers to 001-009 (28 markers across 8 files; 006 unchanged)"
```

---

### Task 5: Mirror to publish/ + final verify + push

**Files:**
- Mirror: `publish/center/src/init/verify-marker.js`
- Mirror: `publish/center/src/db/sql.js`
- Mirror: `publish/center/src/init/schema-applier.js`
- Mirror: `publish/db/migrations/001-dc-site-discovery.sql`
- Mirror: `publish/db/migrations/002-permissions-table.sql`
- Mirror: `publish/db/migrations/003-port-healthcheck.sql`
- Mirror: `publish/db/migrations/004-package-system.sql`
- Mirror: `publish/db/migrations/005-sys-config-audit.sql`
- Mirror: `publish/db/migrations/007-dc-card-counters.sql`
- Mirror: `publish/db/migrations/008-lockout-events.sql`
- Mirror: `publish/db/migrations/009-schema-migrations.sql`

(006 unchanged — no mirror needed.)

- [ ] **Step 1: Copy 3 source files to publish mirror**

```bash
cd D:/ToolDevelop/ADDashboard
cp center/src/init/verify-marker.js publish/center/src/init/verify-marker.js
cp center/src/db/sql.js              publish/center/src/db/sql.js
cp center/src/init/schema-applier.js publish/center/src/init/schema-applier.js
```

- [ ] **Step 2: Copy 8 migration files to publish mirror**

```bash
cd D:/ToolDevelop/ADDashboard
cp db/migrations/001-dc-site-discovery.sql publish/db/migrations/001-dc-site-discovery.sql
cp db/migrations/002-permissions-table.sql publish/db/migrations/002-permissions-table.sql
cp db/migrations/003-port-healthcheck.sql  publish/db/migrations/003-port-healthcheck.sql
cp db/migrations/004-package-system.sql    publish/db/migrations/004-package-system.sql
cp db/migrations/005-sys-config-audit.sql publish/db/migrations/005-sys-config-audit.sql
cp db/migrations/007-dc-card-counters.sql  publish/db/migrations/007-dc-card-counters.sql
cp db/migrations/008-lockout-events.sql   publish/db/migrations/008-lockout-events.sql
cp db/migrations/009-schema-migrations.sql publish/db/migrations/009-schema-migrations.sql
```

- [ ] **Step 3: Verify all 11 mirrors are byte-identical**

```bash
cd D:/ToolDevelop/ADDashboard
diff center/src/init/verify-marker.js publish/center/src/init/verify-marker.js
diff center/src/db/sql.js              publish/center/src/db/sql.js
diff center/src/init/schema-applier.js publish/center/src/init/schema-applier.js
for f in 001-dc-site-discovery 002-permissions-table 003-port-healthcheck 004-package-system 005-sys-config-audit 007-dc-card-counters 008-lockout-events 009-schema-migrations; do
  diff db/migrations/${f}.sql publish/db/migrations/${f}.sql || echo "MISMATCH: ${f}"
done
```
Expected: No diff output, no MISMATCH lines (exit 0 for every diff).

- [ ] **Step 4: Run full test suite — final confirmation**

```bash
cd D:/ToolDevelop/ADDashboard/center
npm test
```
Expected: All tests pass (445+ pass, 0 fail). Same state as T4 Step 9 — just confirming the mirror didn't desync anything.

- [ ] **Step 5: Commit publish mirror**

```bash
cd D:/ToolDevelop/ADDashboard
git add publish/center/src/init/verify-marker.js \
        publish/center/src/db/sql.js \
        publish/center/src/init/schema-applier.js \
        publish/db/migrations/001-dc-site-discovery.sql \
        publish/db/migrations/002-permissions-table.sql \
        publish/db/migrations/003-port-healthcheck.sql \
        publish/db/migrations/004-package-system.sql \
        publish/db/migrations/005-sys-config-audit.sql \
        publish/db/migrations/007-dc-card-counters.sql \
        publish/db/migrations/008-lockout-events.sql \
        publish/db/migrations/009-schema-migrations.sql
git commit -m "chore(publish): mirror verify-marker fix (verify-marker.js, sql.js, schema-applier.js, 8 migrations)"
```

- [ ] **Step 6: Push to origin**

```bash
cd D:/ToolDevelop/ADDashboard
git push origin main
```
Expected: Push succeeds. `git log --oneline origin/main -6` shows the 5 new commits (T1 + T2 + T3 + T4 + T5 mirror).

- [ ] **Step 7: Manual smoke test (recommended)**

If a deployment is available, verify the bootstrap path:

```bash
# On a deployment where schema_migrations was previously missing:
node -e "import('./center/src/init/schema-applier.js').then(m =>
  m.bootstrapMigrations('mysql', db).then(() => console.log('bootstrap ok'))
)"
```

Expected: bootstrap completes; schema_migrations has rows for 001-009 (no skipped files in a healthy DB; if any markers are genuinely missing, they appear in the warning log with `verify markers missing — skipping backfill` and the file shows up in admin `/api/admin/migrations` as pending).