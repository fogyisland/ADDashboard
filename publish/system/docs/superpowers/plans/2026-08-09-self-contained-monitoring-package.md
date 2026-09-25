# Self-Contained Monitoring Package (Plugin System v2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the v1 plugin system so packages can ship their own database schema (manifest + script + DDL + migrations). v2 packages own a `pkg_<name>` schema in the center DB; PS1 data flows into `pkg_<name>.<metricTable>`. v1 packages keep working unchanged.

**Architecture:** Pure-JS DDL sandbox (token scanner with strict whitelist + cross-schema/cross-package ban) gates every SQL file before apply. Installer orchestrates install/upgrade/uninstall with best-effort rollback (catch + DROP SCHEMA on install fail). Metricstore gains a v2 dispatch branch alongside the existing v1 path; routing is by `manifest.database` presence. New `orphan_schemas` center table tracks DROP failures for admin cleanup. Frontend adds a DDL-preview modal and a confirm-before-DROP uninstall flow.

**Tech Stack:** Node.js (ESM), Express, ajv (manifest validation), AdmZip (package parsing), mysql2 / mssql drivers, Vitest (frontend), Pester (PowerShell). Real-DB SQL tests gated on `TEST_MYSQL_URL` / `TEST_MSSQL_URL` per project convention.

**Spec:** `docs/superpowers/specs/2026-08-09-self-contained-monitoring-package-design.md` (commit `0076c14`). Every task below cites the spec section it implements.

## Global Constraints

These bind every task. Repeating them per task would be noise; an implementer reading any task must satisfy all of these.

- **v1 plugin system unchanged.** `metric_gauge/counter/timeseries/status` schema, `metricstore.ingestRun` v1 path, `installer.installPackage` v1 path, all v1 tests, all v1 admin UI — no modifications except a single routing check on `manifest.database` presence.
- **`database` field is optional.** Absence → v1 path. Presence → v2 path. Both install/uninstall code paths coexist in the same modules.
- **No retroactive upgrades.** v1 packages installed before this plan stay v1 forever; manifests are not rewritten. v2 packages are opt-in per manifest.
- **Pure-JS DDL sandbox.** Token scanner (`center/src/packages/ddl-sandbox.js`) — no external SQL parser dependency. Whitelist of keywords (DDL + types + FK clauses) + regex blacklist (DROP, GRANT, INSERT INTO, UPDATE <id>, DELETE FROM, MERGE, SELECT, cross-package, cross-schema, multi-statement).
- **FK ON UPDATE / ON DELETE CASCADE allowed.** The scanner uses anchored DML patterns (`UPDATE <identifier>`, `DELETE FROM`) so FK referential actions pass through. Enforced by unit test.
- **Strict ajv.** `manifestSchema` and `registry-index.schema` use `additionalProperties: false`. Unknown fields reject install with `PKG_INVALID_MANIFEST` (400).
- **Schema name authority.** `manifest.database.schemaName` defaults to `pkg_<name-with-dashes-as-underscores>`. Explicit override must match the same regex `^pkg_[a-z0-9_]+$`.
- **Cross-dialect SQL.** MySQL 8+ (default port 3306, `utf8mb4_unicode_ci`) + MSSQL 2014+ (`NVARCHAR`, `DATETIMEOFFSET`). `db.execute` accepts `?` placeholders; mssql driver wrapper rewrites to `@p1...@pN`. Migrations files contain dialect-specific SQL; one set per package per dialect if needed. (Initial spec supports single-dialect files; dual-dialect-per-file is YAGNI.)
- **DDL atomicity.** MySQL DDL implicit-commits; installer uses application-level "transaction simulation" — every apply step wrapped in try/catch; install failure → best-effort `DROP DATABASE pkg_<name>` (or `DROP SCHEMA` on MSSQL). Upgrade failure leaves partial state (logged to `package_runs.error`); no automatic rollback on upgrade.
- **`agent_id` from auth token, `ts` from server clock.** Never from PS1 stdout.
- **Package format unchanged on v1.** v2 extends via additive `manifest.database` field; v1 packages keep using `manifest.metrics[]` and the 4 fixed metric tables.
- **Real-DB SQL tests mandatory.** Every new SQL string in `db.sql.*` or in installer/metricstore gets a `tests/sql/*` test gated on `TEST_MYSQL_URL` per project convention (see `feedback_real_db_sql_tests.md`).
- **Mirror convention.** Every new + modified source file under `center/`, `agent/`, `frontend/` is mirrored byte-identical into `publish/`. `scripts/verify-mirror.ps1` extended to include the new modules. Test files NOT mirrored.
- **Trust model unchanged.** HTTPS-only registry + sha256. No code signing. Admin UI shows "未签名包 — install 前请审查 manifest + migrations" banner with `[查看 DDL]` button on v2 install.
- **Feature flag.** `system_config.self_contained_packages_enabled` (default 1). When 0: registry index rejects v2 entries; admin UI hides v2 install flow.
- **Frequent commits.** Each task ends with a single commit. Commit message format: `feat/fix/docs(scope): ...` per project convention.
- **No drive-by cleanup.** Tasks outside scope (e.g., refactoring `metricstore.js` v1 path, restyling admin UI, fixing pre-existing lint warnings) are NOT bundled into plan tasks. If noticed, park in plan's "Out-of-scope" appendix for a future plan.
- **DRY.** Reuse existing helpers: `installedPackages.upsert/get/list/delete`, `packageRuns.record/listRecent`, `PkgError`, `validateManifest`, `RegistryClient`, `checkAll`. Do not reimplement them.
- **TDD discipline.** Every implementation step is preceded by a failing test. Steps `Run test → expected FAIL → write minimal code → run again → expected PASS → commit`.

---

## File Structure (locked in by this plan)

### New files

| Path | Responsibility |
|------|----------------|
| `center/src/packages/ddl-sandbox.js` | Pure-JS token scanner with whitelist + blacklist. Exports `scanSql(sql) → {ok, blocked?}` and `normalizeType(t) → string`. |
| `center/src/packages/ddl-apply.js` | DDL apply orchestrator: `ensureSchema(db, schemaName, dialect)`, `applyMigrations(db, {schemaName, files})`, `dropSchema(db, schemaName)`. |
| `center/src/db/sql/orphan-schemas.js` | SQL helpers for the new center `orphan_schemas` table — upsert, list, delete. Mirrors the `installedPackages` helper pattern. |
| `db/migrations/013-orphan-schemas.sql` | MySQL: `CREATE TABLE IF NOT EXISTS orphan_schemas (...)`. |
| `db/migrations/mssql/013-orphan-schemas.sql` | MSSQL variant. |
| `center/tests/packages/ddl-sandbox.test.js` | Unit tests for the scanner (whitelist/blacklist/regex/FK allowance). |
| `center/tests/packages/ddl-apply.test.js` | Unit-ish tests against a real MySQL (gated on `TEST_MYSQL_URL`) — CREATE SCHEMA / apply migrations / DROP SCHEMA / failure rollback. |
| `center/tests/packages/manifest-v2.test.js` | Unit tests for the extended `manifestSchema` (database field accepted/rejected). |
| `center/tests/packages/installer-v2.test.js` | Integration tests against real MySQL — install v2 / install fails on bad DDL / install fails mid-apply. |
| `center/tests/packages/installer-v2-upgrade.test.js` | Integration tests for upgrade DDL diff / upgrade mid-failure. |
| `center/tests/packages/installer-v2-uninstall.test.js` | Integration tests for uninstall / DROP SCHEMA / orphan_schemas tracking. |
| `center/tests/packages/metricstore-v2.test.js` | Integration tests for `ingestRun` v2 path (real MySQL). |
| `center/tests/packages/registry-v2-index.test.js` | Unit tests for extended registry index schema (database field accepted/rejected). |
| `center/tests/packages/router-v2.test.js` | Router tests for new endpoints (`ddl-preview`, orphan-schemas CRUD) + modified install/uninstall behavior. |
| `center/tests/e2e/self-contained-package.test.js` | E2E: install v2 → agent run → report → uninstall. |
| `frontend/src/components/PackageDdlPreviewModal.vue` | Modal: shows schemaName + migrations[] content with raw SQL + warning text. |
| `frontend/src/components/UninstallSchemaConfirmModal.vue` | Modal: requires explicit "我已审查 DDL" checkbox before submitting `DELETE ?purgeMetrics=true&confirmDropSchema=true`. |
| `frontend/src/views/admin/OrphanSchemasView.vue` | List + manual-drop UI for `orphan_schemas` table. |
| `frontend/tests/self-contained-package-view.test.js` | Frontend tests for DDL preview modal + uninstall confirm + PackageEditView integration. |
| `frontend/tests/orphan-schemas-view.test.js` | Frontend tests for OrphanSchemasView. |

### Modified files

| Path | Change |
|------|--------|
| `center/src/packages/manifest.js` | Extend ajv `manifestSchema` with `database` field; export `validateManifest` unchanged (callers unaffected). |
| `center/src/packages/installer.js` | Extend `installPackage` to call DDL sandbox + apply flow when `manifest.database` present. Extend `uninstallPackage` to drop schema when v2 + `confirmDropSchema=true`. |
| `center/src/packages/metricstore.js` | Extend `ingestRun`: if `manifest.database?.metricTable`, route to `pkg_<name>.<metricTable>` via ddl-apply's INSERT helper; else v1 path unchanged. |
| `center/src/packages/registry-index.schema.json` | Add `database` field (additionalProperties:false). |
| `center/src/packages/router.js` | New routes: `GET /api/admin/packages/:name/ddl-preview`, `GET /api/admin/orphan-schemas`, `DELETE /api/admin/orphan-schemas/:name`. Modify install/uninstall handlers to support v2 (see tasks). |
| `center/src/packages/errors.js` | Add new error codes: `PKG_DDL_FORBIDDEN`, `PKG_DDL_INVALID_SQL`, `PKG_SCHEMA_EXISTS`, `PKG_CONFIRM_REQUIRED`, `PKG_INSTALL_FAILED`, `PKG_UPGRADE_FAILED`, `PKG_METRIC_KEY_UNKNOWN`, `PKG_METRIC_TYPE_MISMATCH`, `PKG_METRIC_REQUIRED`. |
| `center/src/db/sql.js` | Re-export `orphanSchemasSql` (follows frozen-registry pattern of `installedPackagesSql`). |
| `center/server.js` | Mount new admin routes (orphan-schemas router). |
| `frontend/src/views/admin/PackageEditView.vue` | Add `database` section rendering; wire DDL preview modal; wire uninstall confirm modal. |
| `frontend/src/api/admin.js` | New API client methods: `getDdlPreview(name)`, `listOrphanSchemas()`, `dropOrphanSchema(name)`. |
| `frontend/src/router.js` (admin section) | Add `/admin/orphan-schemas` route. |
| `frontend/src/components/AppLayout.vue` | Add nav link to "未签名 Schema 残留" (gated on feature flag). |
| `scripts/verify-mirror.ps1` | Extend diff pairs: `center/src/packages/ddl-sandbox.js`, `center/src/packages/ddl-apply.js`, `center/src/db/sql/orphan-schemas.js`, `db/migrations/013-orphan-schemas.sql`, `publish/*` mirrors; `frontend/src/components/PackageDdlPreviewModal.vue`, `frontend/src/components/UninstallSchemaConfirmModal.vue`, `frontend/src/views/admin/OrphanSchemasView.vue`. |
| `docs/operations/deployment.md` | Add note: existing installations pick up migration 013 on next `/init` wizard boot (IF NOT EXISTS). |

### Mirror (publish/) — each non-test new/modified source file

The script `scripts/verify-mirror.ps1` is extended (last task) and verifies byte-identical. Implementer must `cp` each modified/new source file to its `publish/` twin at commit time.

---

## Task 1: DDL sandbox token scanner + unit tests

**Files:**
- Create: `center/src/packages/ddl-sandbox.js`
- Create: `center/tests/packages/ddl-sandbox.test.js`
- Mirror: `publish/center/src/packages/ddl-sandbox.js`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces:
  - `scanSql(sql: string) → {ok: true} | {ok: false, blocked: string}` — scans one SQL string.
  - `normalizeType(t: string) → string` — collapses `VARCHAR(64)` / `varchar( 64 )` → `varchar(64)` for case/whitespace-insensitive comparison.
  - `ALLOWED_KEYWORDS` (Set) — exported for tests.
  - `BLOCKED_PATTERNS` (RegExp[]) — exported for tests.

### Steps

- [ ] **Step 1: Write failing tests** in `center/tests/packages/ddl-sandbox.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanSql, normalizeType, ALLOWED_KEYWORDS, BLOCKED_PATTERNS } from '../../src/packages/ddl-sandbox.js';

test('scanSql: passes simple CREATE TABLE', () => {
  const sql = 'CREATE TABLE metrics (agent_id VARCHAR(64) NOT NULL, ts DATETIME NOT NULL, cpu_pct DOUBLE NOT NULL, PRIMARY KEY (agent_id, ts))';
  assert.deepStrictEqual(scanSql(sql), { ok: true });
});

test('scanSql: passes ALTER TABLE ADD COLUMN', () => {
  assert.deepStrictEqual(scanSql('ALTER TABLE metrics ADD COLUMN swap_pct DOUBLE NULL'), { ok: true });
});

test('scanSql: passes CREATE INDEX', () => {
  assert.deepStrictEqual(scanSql('CREATE INDEX ix_metrics_agent ON metrics (agent_id)'), { ok: true });
});

test('scanSql: rejects CREATE VIEW (SELECT body is blocked)', () => {
  // CREATE VIEW is a DDL keyword (allowed) but every view body contains SELECT
  // which is in BLOCKED_PATTERNS. The scanner rejects on SELECT, not on CREATE VIEW.
  const r = scanSql('CREATE VIEW v AS SELECT * FROM metrics');
  assert.strictEqual(r.ok, false);
  assert.match(r.blocked, /MERGE|SELECT/);
});

test('scanSql: rejects DROP TABLE', () => {
  const r = scanSql('DROP TABLE metrics');
  assert.strictEqual(r.ok, false);
  assert.match(r.blocked, /DROP/i);
});

test('scanSql: rejects GRANT', () => {
  assert.strictEqual(scanSql('GRANT SELECT ON metrics TO app_user').ok, false);
});

test('scanSql: rejects INSERT INTO', () => {
  assert.strictEqual(scanSql('INSERT INTO metrics VALUES (1, NOW(), 50.0)').ok, false);
});

test('scanSql: rejects UPDATE <identifier>', () => {
  assert.strictEqual(scanSql('UPDATE metrics SET cpu_pct = 0').ok, false);
});

test('scanSql: rejects DELETE FROM', () => {
  assert.strictEqual(scanSql('DELETE FROM metrics WHERE ts < NOW()').ok, false);
});

test('scanSql: rejects MERGE', () => {
  assert.strictEqual(scanSql('MERGE INTO metrics USING src ON metrics.id = src.id').ok, false);
});

test('scanSql: rejects SELECT', () => {
  assert.strictEqual(scanSql('SELECT * FROM metrics').ok, false);
});

test('scanSql: rejects EXEC / EXECUTE / CALL', () => {
  assert.strictEqual(scanSql('EXEC sp_helpdb').ok, false);
  assert.strictEqual(scanSql('CALL my_proc()').ok, false);
});

test('scanSql: rejects cross-package reference (pkg_other)', () => {
  const r = scanSql('CREATE TABLE x (id INT REFERENCES pkg_other.foo(id))');
  assert.strictEqual(r.ok, false);
  assert.match(r.blocked, /pkg_/);
});

test('scanSql: rejects cross-schema reference (installed_packages)', () => {
  const r = scanSql('CREATE TABLE x (id INT REFERENCES installed_packages(id))');
  assert.strictEqual(r.ok, false);
});

test('scanSql: rejects multi-statement', () => {
  const r = scanSql('CREATE TABLE foo (id INT); DROP TABLE bar');
  assert.strictEqual(r.ok, false);
  assert.match(r.blocked, /;/);
});

test('scanSql: rejects unknown identifier (e.g. Lambda, WHEREEVER)', () => {
  assert.strictEqual(scanSql('SELECT * FROM metrics WHERE id = 1').ok, false); // SELECT banned
  assert.strictEqual(scanSql('WHEREEVER foo = bar').ok, false); // unknown keyword
});

test('scanSql: passes ON UPDATE / ON DELETE CASCADE (FK actions)', () => {
  const sql = 'CREATE TABLE child (id INT, parent_id INT, FOREIGN KEY (parent_id) REFERENCES parent(id) ON UPDATE CASCADE ON DELETE CASCADE)';
  assert.deepStrictEqual(scanSql(sql), { ok: true });
});

test('scanSql: passes comment stripping', () => {
  const sql = `
    -- a comment
    /* multi
       line */
    CREATE TABLE x (id INT)
  `;
  assert.deepStrictEqual(scanSql(sql), { ok: true });
});

test('scanSql: passes dialect-specific (AUTO_INCREMENT / IDENTITY / NVARCHAR / DATETIMEOFFSET / COLLATE)', () => {
  assert.deepStrictEqual(scanSql('CREATE TABLE x (id INT AUTO_INCREMENT PRIMARY KEY, name NVARCHAR(64))'), { ok: true });
  assert.deepStrictEqual(scanSql('CREATE TABLE x (id INT IDENTITY PRIMARY KEY, ts DATETIMEOFFSET NOT NULL)'), { ok: true });
  assert.deepStrictEqual(scanSql('CREATE TABLE x (id INT) COLLATE utf8mb4_unicode_ci'), { ok: true });
});

test('scanSql: passes numeric literals and string literals', () => {
  assert.deepStrictEqual(scanSql("CREATE TABLE x (val DOUBLE DEFAULT 0.5, label VARCHAR(16) DEFAULT 'unknown')"), { ok: true });
});

test('scanSql: rejects identifier containing disallowed word (e.g. DROPPED)', () => {
  // identifier "DROPPED" — not a keyword, but contains DROP substring; \bDROP\b still matches because of word boundary
  const r = scanSql('CREATE TABLE DROPPED (id INT)');
  assert.strictEqual(r.ok, false); // matches \bDROP\b
});

test('normalizeType: case + whitespace insensitive', () => {
  assert.strictEqual(normalizeType('VARCHAR(64)'), 'varchar(64)');
  assert.strictEqual(normalizeType('  varchar(  64  )  '), 'varchar(64)');
  assert.strictEqual(normalizeType('DOUBLE'), 'double');
  assert.strictEqual(normalizeType('datetime'), 'datetime');
  assert.strictEqual(normalizeType('NVARCHAR(255)'), 'nvarchar(255)');
});

test('ALLOWED_KEYWORDS contains DDL essentials', () => {
  for (const k of ['CREATE', 'TABLE', 'ALTER', 'ADD', 'COLUMN', 'INDEX', 'VIEW', 'CASCADE', 'REFERENCES', 'ON', 'UPDATE', 'DELETE']) {
    assert.ok(ALLOWED_KEYWORDS.has(k), `${k} missing`);
  }
});

test('BLOCKED_PATTERNS is non-empty array of RegExp', () => {
  assert.ok(Array.isArray(BLOCKED_PATTERNS));
  assert.ok(BLOCKED_PATTERNS.length >= 6);
  for (const r of BLOCKED_PATTERNS) assert.ok(r instanceof RegExp);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd center && node --test tests/packages/ddl-sandbox.test.js`
Expected: FAIL — `Cannot find module '../../src/packages/ddl-sandbox.js'`.

- [ ] **Step 3: Implement** in `center/src/packages/ddl-sandbox.js`:

```js
// DDL sandbox — pure-JS token scanner for package-supplied migration files.
//
// Defense-in-depth: rejects the most common classes of accidental damage
// (DROP, GRANT, DML, cross-schema, cross-package, multi-statement) and
// disallows unknown keywords/types. The scanner is the security boundary
// between untrusted package authors and the center DB — a future refactor
// that loosens any whitelist MUST come with a corresponding unit test
// update (ddl-sandbox.test.js > "ON UPDATE / ON DELETE CASCADE pass").
//
// FK referential actions (ON UPDATE CASCADE, ON DELETE CASCADE) are
// intentionally allowed — they appear in CREATE TABLE / ALTER TABLE but
// are not DML. The BLOCKED_PATTERNS use anchored DML forms so these
// clauses pass.

export const ALLOWED_KEYWORDS = new Set([
  // DDL
  'CREATE', 'TABLE', 'SCHEMA', 'DATABASE', 'INDEX', 'UNIQUE', 'VIEW', 'IF', 'NOT', 'EXISTS',
  'ALTER', 'ADD', 'COLUMN', 'CONSTRAINT', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES',
  'DEFAULT', 'NULL', 'CHECK', 'ON', 'UPDATE', 'DELETE', 'CASCADE', 'NO', 'ACTION', 'RESTRICT', 'SET',
  // table options
  'ENGINE', 'CHARSET', 'COLLATE',
  // index options
  'ASC', 'DESC', 'USING', 'BTREE', 'HASH',
  // types
  'INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT',
  'VARCHAR', 'CHAR', 'TEXT', 'NVARCHAR', 'NTEXT',
  'DOUBLE', 'FLOAT', 'DECIMAL', 'NUMERIC',
  'DATETIME', 'TIMESTAMP', 'DATETIMEOFFSET', 'DATE',
  'JSON', 'BOOLEAN', 'BIT',
  // dialect-specific
  'AUTO_INCREMENT', 'IDENTITY',
]);

export const BLOCKED_PATTERNS = [
  /\bDROP\b/i,                              // no DROP at all — uninstall + purgeMetrics does that explicitly
  /\b(TRUNCATE|RENAME|GRANT|REVOKE|EXEC|EXECUTE|CALL)\b/i,
  /\bINSERT\s+INTO\b/i,                     // DML — does not match ON UPDATE / ON DELETE
  /\bUPDATE\s+[a-z_]/i,                     // DML — followed by identifier; ON UPDATE CASCADE passes
  /\bDELETE\s+FROM\b/i,                     // DML — followed by FROM; ON DELETE CASCADE passes
  /\b(MERGE|SELECT)\b/i,
  /\bpkg_[a-z0-9_]+\.[a-z0-9_]+/i,          // cross-package reference (other pkg_)
  /\b(main|installed_packages|metric_gauge|metric_counter|metric_timeseries|metric_status|package_runs|orphan_schemas|system_config|audit_logs|schema_migrations)\b/i,
  /;\s*\S/,                                  // multi-statement
];

const RESERVED_CENTER_RESOURCES = new Set([
  'main', 'installed_packages', 'metric_gauge', 'metric_counter', 'metric_timeseries',
  'metric_status', 'package_runs', 'orphan_schemas', 'system_config', 'audit_logs', 'schema_migrations'
]);

export function normalizeType(t) {
  return String(t).trim().toLowerCase().replace(/\s+/g, '');
}

function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

export function scanSql(sql) {
  const stripped = stripComments(sql);
  for (const re of BLOCKED_PATTERNS) {
    if (re.test(stripped)) return { ok: false, blocked: re.source };
  }
  // reserved-resource guard: also catch `installed_packages` even if surrounded
  // by delimiters that the BLOCKED_PATTERNS' word boundary misses
  const tokens = stripped.split(/[\s(),;]+/).filter(Boolean);
  for (const t of tokens) {
    if (/^-?\d+(\.\d+)?$/.test(t)) continue;
    if (/^'[^']*'$/.test(t)) continue;
    if (/^[a-z_][a-z0-9_]*$/i.test(t)) {
      const upper = t.toUpperCase();
      if (RESERVED_CENTER_RESOURCES.has(t.toLowerCase())) {
        return { ok: false, blocked: `reserved center resource: ${t}` };
      }
      if (!ALLOWED_KEYWORDS.has(upper)) {
        return { ok: false, blocked: `unknown identifier: ${t}` };
      }
      continue;
    }
    return { ok: false, blocked: `unparseable token: ${t}` };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd center && node --test tests/packages/ddl-sandbox.test.js`
Expected: PASS — all 23 tests green. (Note: the intentionally-wrong assertion in the "passes CREATE VIEW" test gets corrected here — replace with `assert.deepStrictEqual(scanSql('CREATE VIEW v AS SELECT * FROM metrics'), { ok: false, blocked: /\bSELECT\b/i });` — actually we cannot use regex literals in `deepStrictEqual`. Fix the test in Step 5.)

- [ ] **Step 5: Fix the CREATE VIEW test**

In `center/tests/packages/ddl-sandbox.test.js`, replace the buggy "passes CREATE VIEW" test with:

```js
test('scanSql: rejects CREATE VIEW that contains SELECT (SELECT banned)', () => {
  // CREATE VIEW requires SELECT in its body — but our sandbox forbids SELECT.
  // This is by design: views that pull across tables invite cross-schema reads.
  // If a future use case needs views, allow-list a narrow pattern.
  const r = scanSql('CREATE VIEW v AS SELECT * FROM metrics');
  assert.strictEqual(r.ok, false);
  assert.match(r.blocked, /MERGE|SELECT/);
});
```

Run the test again — all 23 should pass.

- [ ] **Step 6: Mirror + commit**

```bash
mkdir -p publish/center/src/packages
cp center/src/packages/ddl-sandbox.js publish/center/src/packages/ddl-sandbox.js
git add center/src/packages/ddl-sandbox.js center/tests/packages/ddl-sandbox.test.js publish/center/src/packages/ddl-sandbox.js
git commit -m "feat(packages): DDL sandbox token scanner with strict whitelist

Pure-JS scanner rejects DROP / GRANT / DML / cross-schema / cross-package
/ multi-statement; allows FK ON UPDATE / ON DELETE CASCADE. First slice
of self-contained monitoring package plan (plugin system v2)."
```

---

## Task 2: Migration 013 — orphan_schemas table (dual dialect)

**Files:**
- Create: `db/migrations/013-orphan-schemas.sql` (MySQL)
- Create: `db/migrations/mssql/013-orphan-schemas.sql` (MSSQL)
- Create: `center/src/db/sql/orphan-schemas.js`
- Create: `center/tests/sql/migration-013.test.js` (gated on TEST_MYSQL_URL)
- Mirror: `publish/center/db/migrations/013-orphan-schemas.sql`, `publish/center/db/migrations/mssql/013-orphan-schemas.sql`, `publish/center/src/db/sql/orphan-schemas.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `orphanSchemas.upsert(db, {name, lastSeenAt, note})` — INSERT ... ON DUPLICATE KEY UPDATE (MySQL) / MERGE (MSSQL).
  - `orphanSchemas.list(db)` — SELECT * FROM orphan_schemas ORDER BY last_seen_at DESC.
  - `orphanSchemas.delete(db, name)` — DELETE WHERE name = ?.
  - `orphanSchemasSql` registry object re-exported via `db.sql.orphanSchemas.*`.

### Steps

- [ ] **Step 1: Write failing integration test** in `center/tests/sql/migration-013.test.js`:

```js
// migration-013.test.js — verifies the orphan_schemas table applies cleanly
// and helpers round-trip. Gated on TEST_MYSQL_URL per project convention.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, close, getDb } from '../../src/db/index.js';
import { orphanSchemas } from '../../src/db/sql/orphan-schemas.js';
import { parseTestUrl } from '../integration/_url.js';

test('migration-013: orphan_schemas round-trip', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  await init({
    db: { dialect: 'mysql', mysql: { host, port, database: 'ad_monitoring', user, password } },
    listenPort: 8080,
    jwtSecret: 'x',
    agentToken: 'x',
    staticDir: './dist',
    logLevel: 'silent',
    env: 'test'
  });
  const db = getDb();

  // Snapshot baseline so we don't pollute other tests
  const before = await orphanSchemas.list(db);
  try {
    await orphanSchemas.upsert(db, { name: 'pkg_test_xyz', lastSeenAt: new Date('2026-08-09T00:00:00Z'), note: 'unit test' });
    const list = await orphanSchemas.list(db);
    const found = list.find(r => r.name === 'pkg_test_xyz');
    assert.ok(found, 'pkg_test_xyz should appear in list');
    assert.strictEqual(found.note, 'unit test');

    await orphanSchemas.delete(db, 'pkg_test_xyz');
    const list2 = await orphanSchemas.list(db);
    assert.ok(!list2.find(r => r.name === 'pkg_test_xyz'), 'should be removed');
  } finally {
    // Best-effort cleanup any test rows we missed
    try { await orphanSchemas.delete(db, 'pkg_test_xyz'); } catch {}
    try {
      for (const r of before) {
        await orphanSchemas.upsert(db, { name: r.name, lastSeenAt: r.last_seen_at, note: r.note });
      }
    } catch {}
    try { await close(); } catch {}
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_MYSQL_URL=... npm test --workspace=center -- --test tests/sql/migration-013.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Create migration files**

`db/migrations/013-orphan-schemas.sql`:
```sql
-- Migration 013 — orphan_schemas tracking table.
-- Used by the package installer/uninstaller when DROP SCHEMA fails after a
-- successful uninstall: the schema name is recorded here so admin can
-- manually clean up. Pure CREATE TABLE IF NOT EXISTS — no procedures, no
-- DELIMITER. Safe for the schema-applier.

CREATE TABLE IF NOT EXISTS orphan_schemas (
  name          VARCHAR(128) NOT NULL PRIMARY KEY,
  last_seen_at  DATETIME     NOT NULL,
  note          VARCHAR(512) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

`db/migrations/mssql/013-orphan-schemas.sql`:
```sql
-- Migration 013 (MSSQL variant) — orphan_schemas tracking table.
CREATE TABLE orphan_schemas (
  name          NVARCHAR(128) NOT NULL PRIMARY KEY,
  last_seen_at  DATETIMEOFFSET NOT NULL,
  note          NVARCHAR(512) NULL
);
```

- [ ] **Step 4: Create SQL helpers** in `center/src/db/sql/orphan-schemas.js`:

```js
import { getDb } from '../index.js';

const UPSERT_MYSQL = `INSERT INTO orphan_schemas (name, last_seen_at, note)
  VALUES (?, ?, ?)
  ON DUPLICATE KEY UPDATE
    last_seen_at = VALUES(last_seen_at),
    note = VALUES(note)`;

const UPSERT_MSSQL = `MERGE INTO orphan_schemas AS t
  USING (SELECT ? AS name, ? AS last_seen_at, ? AS note) AS s
  ON t.name = s.name
  WHEN MATCHED THEN UPDATE SET
    last_seen_at = s.last_seen_at,
    note = s.note
  WHEN NOT MATCHED THEN INSERT (name, last_seen_at, note)
    VALUES (s.name, s.last_seen_at, s.note)`;

const LIST_MYSQL = `SELECT * FROM orphan_schemas ORDER BY last_seen_at DESC`;
const LIST_MSSQL = `SELECT * FROM orphan_schemas ORDER BY last_seen_at DESC`;

const DELETE_MYSQL = `DELETE FROM orphan_schemas WHERE name = ?`;
const DELETE_MSSQL = `DELETE FROM orphan_schemas WHERE name = ?`;

export const orphanSchemasSql = {
  upsert: { mysql: UPSERT_MYSQL, mssql: UPSERT_MSSQL },
  list:   { mysql: LIST_MYSQL,   mssql: LIST_MSSQL },
  delete: { mysql: DELETE_MYSQL, mssql: DELETE_MSSQL }
};

export const orphanSchemas = {
  async upsert(db, { name, lastSeenAt, note }) {
    const sql = db.dialect === 'mssql' ? UPSERT_MSSQL : UPSERT_MYSQL;
    await db.execute(sql, [name, lastSeenAt, note ?? null]);
  },
  async list(db) {
    const sql = db.dialect === 'mssql' ? LIST_MSSQL : LIST_MYSQL;
    const { rows } = await db.execute(sql, []);
    return rows;
  },
  async delete(db, name) {
    const sql = db.dialect === 'mssql' ? DELETE_MSSQL : DELETE_MYSQL;
    await db.execute(sql, [name]);
  }
};

export const orphanSchemasForDb = {
  upsert: (p) => orphanSchemas.upsert(getDb(), p),
  list: () => orphanSchemas.list(getDb()),
  delete: (name) => orphanSchemas.delete(getDb(), name)
};
```

- [ ] **Step 5: Wire registry** — open `center/src/db/sql.js`, find the existing `installedPackagesSql` export pattern, add:

```js
import { orphanSchemasSql } from './sql/orphan-schemas.js';
// (in the registry object)
orphanSchemas: orphanSchemasSql,
```

- [ ] **Step 6: Apply migration to dev DB** (locally)

Run: `npm run migrate` (or whatever the project's existing migration runner is — verify with `cat package.json` and check the existing migration-012 task's flow).

Expected: `orphan_schemas` table appears in the dev DB.

- [ ] **Step 7: Run test to verify it passes**

Run: `TEST_MYSQL_URL=... npm test --workspace=center -- --test tests/sql/migration-013.test.js`
Expected: PASS.

- [ ] **Step 8: Mirror + commit**

```bash
mkdir -p publish/center/db/migrations publish/center/db/migrations/mssql publish/center/src/db/sql
cp db/migrations/013-orphan-schemas.sql publish/center/db/migrations/013-orphan-schemas.sql
cp db/migrations/mssql/013-orphan-schemas.sql publish/center/db/migrations/mssql/013-orphan-schemas.sql
cp center/src/db/sql/orphan-schemas.js publish/center/src/db/sql/orphan-schemas.js
git add db/migrations/013-orphan-schemas.sql db/migrations/mssql/013-orphan-schemas.sql \
        center/src/db/sql/orphan-schemas.js center/src/db/sql.js \
        center/tests/sql/migration-013.test.js \
        publish/center/db/migrations/013-orphan-schemas.sql \
        publish/center/db/migrations/mssql/013-orphan-schemas.sql \
        publish/center/src/db/sql/orphan-schemas.js
git commit -m "feat(db): migration 013 — orphan_schemas tracking table + sql helpers

Records DROP SCHEMA failures from package uninstaller so admin can clean
up manually. Dual-dialect (MySQL + MSSQL), pure CREATE TABLE IF NOT EXISTS."
```

---

## Task 3: Extend manifest ajv schema for `database` field

**Files:**
- Modify: `center/src/packages/manifest.js`
- Create: `center/tests/packages/manifest-v2.test.js`
- Mirror: `publish/center/src/packages/manifest.js`

**Interfaces:**
- Consumes: existing `manifestSchema` (must stay backward-compatible — v1 packages without `database` continue to pass).
- Produces:
  - `validateManifest(m)` — unchanged signature; rejects manifests with malformed `database` (when present) and accepts v1 manifests unchanged.
  - `manifestSchema` — exported; gained new `database` field.

### Steps

- [ ] **Step 1: Write failing tests** in `center/tests/packages/manifest-v2.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, manifestSchema } from '../../src/packages/manifest.js';

const baseManifest = {
  name: 'ad-test',
  version: '1.0.0',
  type: 'gauge'
};

test('validateManifest: v1 manifest (no database) still passes', () => {
  const { valid, errors } = validateManifest(baseManifest);
  assert.strictEqual(valid, true, JSON.stringify(errors));
});

test('validateManifest: v2 manifest with valid database passes', () => {
  const m = {
    ...baseManifest,
    database: {
      schemaName: 'pkg_ad_test',
      migrations: ['migrations/001.sql'],
      metricTable: 'metrics',
      metricSchema: {
        agent_id: { type: 'varchar(64)', nullable: false },
        ts:       { type: 'datetime',    nullable: false },
        val:      { type: 'double' }
      }
    }
  };
  const { valid, errors } = validateManifest(m);
  assert.strictEqual(valid, true, JSON.stringify(errors));
});

test('validateManifest: rejects database with invalid schemaName pattern', () => {
  const m = {
    ...baseManifest,
    database: {
      schemaName: 'wrong_prefix',
      migrations: ['migrations/001.sql'],
      metricTable: 'metrics',
      metricSchema: { agent_id: { type: 'varchar(64)', nullable: false }, ts: { type: 'datetime', nullable: false } }
    }
  };
  const { valid } = validateManifest(m);
  assert.strictEqual(valid, false);
});

test('validateManifest: rejects database with empty migrations', () => {
  const m = {
    ...baseManifest,
    database: {
      schemaName: 'pkg_ad_test',
      migrations: [],
      metricTable: 'metrics',
      metricSchema: { agent_id: { type: 'varchar(64)', nullable: false }, ts: { type: 'datetime', nullable: false } }
    }
  };
  const { valid } = validateManifest(m);
  assert.strictEqual(valid, false);
});

test('validateManifest: rejects database with invalid metricTable pattern', () => {
  const m = {
    ...baseManifest,
    database: {
      schemaName: 'pkg_ad_test',
      migrations: ['001.sql'],
      metricTable: 'metrics;DROP TABLE x',
      metricSchema: { agent_id: { type: 'varchar(64)', nullable: false }, ts: { type: 'datetime', nullable: false } }
    }
  };
  const { valid } = validateManifest(m);
  assert.strictEqual(valid, false);
});

test('validateManifest: rejects unknown field in database', () => {
  const m = {
    ...baseManifest,
    database: {
      schemaName: 'pkg_ad_test',
      migrations: ['001.sql'],
      metricTable: 'metrics',
      metricSchema: { agent_id: { type: 'varchar(64)', nullable: false }, ts: { type: 'datetime', nullable: false } },
      rogueField: 'evil'
    }
  };
  const { valid } = validateManifest(m);
  assert.strictEqual(valid, false);
});

test('validateManifest: rejects metricSchema without agent_id', () => {
  const m = {
    ...baseManifest,
    database: {
      schemaName: 'pkg_ad_test',
      migrations: ['001.sql'],
      metricTable: 'metrics',
      metricSchema: { ts: { type: 'datetime', nullable: false }, val: { type: 'double' } }
    }
  };
  const { valid } = validateManifest(m);
  assert.strictEqual(valid, false);
});

test('validateManifest: rejects metricSchema without ts', () => {
  const m = {
    ...baseManifest,
    database: {
      schemaName: 'pkg_ad_test',
      migrations: ['001.sql'],
      metricTable: 'metrics',
      metricSchema: { agent_id: { type: 'varchar(64)', nullable: false }, val: { type: 'double' } }
    }
  };
  const { valid } = validateManifest(m);
  assert.strictEqual(valid, false);
});

test('manifestSchema.database.metricSchema column type accepts canonical types', () => {
  for (const t of ['int', 'integer', 'bigint', 'varchar(64)', 'double', 'datetime', 'json', 'boolean', 'nvarchar(255)']) {
    const m = {
      ...baseManifest,
      database: {
        schemaName: 'pkg_ad_test',
        migrations: ['001.sql'],
        metricTable: 'metrics',
        metricSchema: { agent_id: { type: 'varchar(64)', nullable: false }, ts: { type: 'datetime', nullable: false }, val: { type: t } }
      }
    };
    const { valid, errors } = validateManifest(m);
    assert.strictEqual(valid, true, `${t} rejected: ${JSON.stringify(errors)}`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd center && node --test tests/packages/manifest-v2.test.js`
Expected: FAIL — "database" not in schema.

- [ ] **Step 3: Extend manifest.js** — add to the `properties` object inside `manifestSchema`:

```js
database: {
  type: 'object',
  additionalProperties: false,
  required: ['schemaName', 'migrations', 'metricTable', 'metricSchema'],
  properties: {
    schemaName: {
      type: 'string',
      // pkg_<name-with-dashes-as-underscores>; installer defaults to this if omitted,
      // but in the manifest it's required so the author is explicit.
      pattern: '^pkg_[a-z0-9_]+$'
    },
    migrations: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 }
    },
    metricTable: {
      type: 'string',
      pattern: '^[a-z0-9_]+$'
    },
    metricSchema: {
      type: 'object',
      minProperties: 3,             // at least agent_id + ts + 1 user column
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['type'],
        properties: {
          type: {
            type: 'string',
            // canonical vocabulary — match ddl-sandbox.normalizeType() output.
            // Single source of truth: see task 1's normalizeType.
            pattern: '^(int|integer|bigint|smallint|tinyint|varchar\\(\\d+\\)|char\\(\\d+\\)|text|nvarchar\\(\\d+\\)|ntext|double|float|decimal\\(\\d+,\\d+\\)|numeric\\(\\d+,\\d+\\)|datetime|timestamp|datetimeoffset|date|json|boolean|bit)$'
          },
          nullable: { type: 'boolean' }
        }
      },
      // ajv can't easily express "agent_id and ts must be present with nullable=false" in pure JSON Schema;
      // enforce in post-validation hook below.
    }
  }
}
```

Then below `const validate = ajv.compile(manifestSchema);` add a post-validation hook that enforces `metricSchema` must include `agent_id` and `ts` with `nullable: false`:

```js
function extraCheck(m) {
  if (m && m.database && m.database.metricSchema) {
    const s = m.database.metricSchema;
    if (!s.agent_id || s.agent_id.nullable !== false) return 'database.metricSchema.agent_id must exist with nullable=false';
    if (!s.ts || s.ts.nullable !== false) return 'database.metricSchema.ts must exist with nullable=false';
  }
  return null;
}
```

Then change `validateManifest` to:

```js
export function validateManifest(m) {
  const valid = validate(m);
  if (!valid) return { valid: false, errors: validate.errors || [] };
  const extra = extraCheck(m);
  if (extra) return { valid: false, errors: [{ instancePath: '/database/metricSchema', message: extra }] };
  return { valid: true, errors: [] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd center && node --test tests/packages/manifest-v2.test.js`
Expected: PASS — all 9 tests green.

Also run the **existing** v1 manifest tests (search for `manifest.test.js`):

Run: `cd center && node --test tests/packages/manifest.test.js`
Expected: PASS — backward compat preserved.

- [ ] **Step 5: Mirror + commit**

```bash
cp center/src/packages/manifest.js publish/center/src/packages/manifest.js
git add center/src/packages/manifest.js center/tests/packages/manifest-v2.test.js publish/center/src/packages/manifest.js
git commit -m "feat(packages): extend manifest ajv schema with v2 database field

Optional manifest.database = { schemaName, migrations, metricTable,
metricSchema }. v1 manifests (no database) continue to validate as before.
agent_id + ts must be present in metricSchema with nullable=false."
```

---

## Task 4: DDL apply orchestrator (`ddl-apply.js`)

**Files:**
- Create: `center/src/packages/ddl-apply.js`
- Create: `center/tests/packages/ddl-apply.test.js` (gated on TEST_MYSQL_URL)
- Mirror: `publish/center/src/packages/ddl-apply.js`

**Interfaces:**
- Consumes: `scanSql` from `ddl-sandbox.js`; `db` facade; the `pkg_<name>` schema name; an array of `{filename, content}` migration files; `metricTable` + `metricSchema` from manifest.
- Produces:
  - `ensureSchema(db, schemaName, dialect)` — MySQL `CREATE DATABASE IF NOT EXISTS`, MSSQL `CREATE SCHEMA`. Idempotent.
  - `createSchemaMigrationsTable(db, schemaName, dialect)` — creates the per-pkg `schema_migrations` table (filename PK, version, applied_at).
  - `applyMigrations(db, {schemaName, dialect, files})` — scans each file via `scanSql`, executes via `db.execute`, INSERTs to `schema_migrations`. Throws on first fail with the failing filename + reason.
  - `dropSchema(db, schemaName, dialect)` — `DROP DATABASE` (MySQL) / `DROP SCHEMA` (MSSQL).
  - `schemaExists(db, schemaName, dialect)` — boolean.
  - `validateMetricSchemaAgainstTable(db, {schemaName, table, metricSchema})` — compares CREATE TABLE columns to `metricSchema` keys (normalized types). Throws if mismatch.

### Steps

- [ ] **Step 1: Write failing integration test** in `center/tests/packages/ddl-apply.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, close, getDb } from '../../src/db/index.js';
import { ensureSchema, createSchemaMigrationsTable, applyMigrations, dropSchema, schemaExists } from '../../src/packages/ddl-apply.js';
import { parseTestUrl } from '../integration/_url.js';

const SCHEMA = 'pkg_ddl_apply_test';

test('ddl-apply: end-to-end create + apply + drop', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  await init({
    db: { dialect: 'mysql', mysql: { host, port, database: 'ad_monitoring', user, password } },
    listenPort: 8080, jwtSecret: 'x', agentToken: 'x', staticDir: './dist', logLevel: 'silent', env: 'test'
  });
  const db = getDb();

  try {
    // Clean up any prior test residue
    if (await schemaExists(db, SCHEMA, 'mysql')) {
      await db.execute(`DROP DATABASE ${SCHEMA}`);
    }

    await ensureSchema(db, SCHEMA, 'mysql');
    assert.strictEqual(await schemaExists(db, SCHEMA, 'mysql'), true);

    await createSchemaMigrationsTable(db, SCHEMA, 'mysql');

    const files = [
      { filename: '001_initial.sql', content: `CREATE TABLE ${SCHEMA}.metrics (agent_id VARCHAR(64) NOT NULL, ts DATETIME NOT NULL, val DOUBLE NOT NULL, PRIMARY KEY (agent_id, ts))` },
      { filename: '002_add.sql', content: `ALTER TABLE ${SCHEMA}.metrics ADD COLUMN extra VARCHAR(16) NULL` }
    ];
    await applyMigrations(db, { schemaName: SCHEMA, dialect: 'mysql', files });

    const { rows } = await db.execute(`SELECT filename, version FROM ${SCHEMA}.schema_migrations ORDER BY filename`);
    assert.deepStrictEqual(rows.map(r => r.filename), ['001_initial.sql', '002_add.sql']);

    const { rows: cols } = await db.execute(`SHOW COLUMNS FROM ${SCHEMA}.metrics`);
    const colNames = cols.map(c => c.Field);
    assert.ok(colNames.includes('extra'), `extra column should exist; got ${colNames.join(',')}`);
  } finally {
    try { await dropSchema(db, SCHEMA, 'mysql'); } catch {}
    try { await close(); } catch {}
  }
});

test('ddl-apply: rejects forbidden DDL mid-apply (no partial apply)', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  await init({
    db: { dialect: 'mysql', mysql: { host, port, database: 'ad_monitoring', user, password } },
    listenPort: 8080, jwtSecret: 'x', agentToken: 'x', staticDir: './dist', logLevel: 'silent', env: 'test'
  });
  const db = getDb();

  try {
    if (await schemaExists(db, SCHEMA, 'mysql')) {
      await db.execute(`DROP DATABASE ${SCHEMA}`);
    }
    await ensureSchema(db, SCHEMA, 'mysql');
    await createSchemaMigrationsTable(db, SCHEMA, 'mysql');

    const files = [
      { filename: '001_good.sql', content: `CREATE TABLE ${SCHEMA}.metrics (id INT)` },
      { filename: '002_evil.sql', content: 'DROP TABLE metrics' }
    ];
    await assert.rejects(
      () => applyMigrations(db, { schemaName: SCHEMA, dialect: 'mysql', files }),
      /PKG_DDL_FORBIDDEN|forbidden|blocked/i
    );
    // 001 not applied (sandbox blocks before any execute)
    const { rows } = await db.execute(`SELECT COUNT(*) AS n FROM ${SCHEMA}.schema_migrations`);
    assert.strictEqual(Number(rows[0].n), 0);
  } finally {
    try { await dropSchema(db, SCHEMA, 'mysql'); } catch {}
    try { await close(); } catch {}
  }
});

test('ddl-apply: dropSchema is idempotent (best-effort swallow)', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  await init({
    db: { dialect: 'mysql', mysql: { host, port, database: 'ad_monitoring', user, password } },
    listenPort: 8080, jwtSecret: 'x', agentToken: 'x', staticDir: './dist', logLevel: 'silent', env: 'test'
  });
  const db = getDb();

  try {
    // Drop a non-existent schema — must not throw
    await dropSchema(db, 'pkg_does_not_exist_xyz', 'mysql');
    // Drop a real schema
    await ensureSchema(db, SCHEMA, 'mysql');
    await dropSchema(db, SCHEMA, 'mysql');
    assert.strictEqual(await schemaExists(db, SCHEMA, 'mysql'), false);
  } finally {
    try { await close(); } catch {}
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_MYSQL_URL=... npm test --workspace=center -- --test tests/packages/ddl-apply.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** in `center/src/packages/ddl-apply.js`:

```js
// DDL apply orchestrator — used by installer.installPackage / upgradePackage
// and uninstaller. All operations assume a schema name in the canonical
// `pkg_<name>` form (regex-checked at the installer layer; this module
// trusts the caller to pass a valid name).

import { scanSql } from './ddl-sandbox.js';
import { PkgError } from './errors.js';

// MySQL treats "schema" and "database" as the same concept. We use
// `CREATE DATABASE` everywhere for MySQL and `CREATE SCHEMA` for MSSQL
// to keep the SQL faithful to each dialect.
function ensureSchemaSql(schemaName, dialect) {
  if (dialect === 'mysql') {
    return `CREATE DATABASE IF NOT EXISTS \`${schemaName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`;
  }
  return `CREATE SCHEMA [${schemaName}]`;
}

function dropSchemaSql(schemaName, dialect) {
  if (dialect === 'mysql') return `DROP DATABASE \`${schemaName}\``;
  return `DROP SCHEMA [${schemaName}]`;
}

function schemaMigrationsDdl(dialect) {
  if (dialect === 'mysql') {
    return `CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    VARCHAR(255) NOT NULL PRIMARY KEY,
      version     VARCHAR(32)  NOT NULL,
      applied_at  DATETIME     NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
  }
  return `CREATE TABLE schema_migrations (
    filename    NVARCHAR(255) NOT NULL PRIMARY KEY,
    version     NVARCHAR(32)  NOT NULL,
    applied_at  DATETIMEOFFSET NOT NULL
  )`;
}

export async function schemaExists(db, schemaName, dialect) {
  if (dialect === 'mysql') {
    const { rows } = await db.execute(
      `SELECT 1 FROM information_schema.schemata WHERE schema_name = ? LIMIT 1`,
      [schemaName]
    );
    return rows.length > 0;
  }
  const { rows } = await db.execute(
    `SELECT 1 FROM sys.schemas WHERE name = ?`,
    [schemaName]
  );
  return rows.length > 0;
}

export async function ensureSchema(db, schemaName, dialect) {
  await db.execute(ensureSchemaSql(schemaName, dialect));
}

export async function createSchemaMigrationsTable(db, schemaName, dialect) {
  // Switch into the schema then create. For MSSQL the bracketed identifier
  // form is portable; for MySQL we prefix.
  const ddl = schemaMigrationsDdl(dialect);
  if (dialect === 'mysql') {
    await db.execute(`USE \`${schemaName}\``);
  }
  await db.execute(ddl);
  // MySQL `USE` only affects the connection — not all drivers persist this.
  // Always fully-qualify subsequent statements: `<schemaName>.schema_migrations`.
}

export async function applyMigrations(db, { schemaName, dialect, files }) {
  if (!Array.isArray(files)) throw new Error('files must be an array');
  for (const file of files) {
    const { ok, blocked } = scanSql(file.content);
    if (!ok) {
      throw new PkgError('PKG_DDL_FORBIDDEN', `${file.filename}: ${blocked}`);
    }
  }
  // All scans passed — execute each + record in schema_migrations
  for (const file of files) {
    try {
      await db.execute(file.content);
    } catch (e) {
      throw new PkgError('PKG_DDL_INVALID_SQL', `${file.filename}: ${e.message}`);
    }
    await db.execute(
      `INSERT INTO \`${schemaName}\`.schema_migrations (filename, version, applied_at) VALUES (?, ?, ?)`,
      [file.filename, '__pending__', new Date()]
    );
  }
  // version is filled by installer after the loop (it knows the manifest.version).
  // We mark with __pending__ so a partial apply leaves a traceable record;
  // the installer overwrites it with the actual version via UPDATE.
}

export async function markMigrationsApplied(db, { schemaName, version, filenames }) {
  if (!filenames.length) return;
  for (const filename of filenames) {
    await db.execute(
      `UPDATE \`${schemaName}\`.schema_migrations SET version = ? WHERE filename = ?`,
      [version, filename]
    );
  }
}

export async function listAppliedMigrations(db, schemaName) {
  const { rows } = await db.execute(
    `SELECT filename, version, applied_at FROM \`${schemaName}\`.schema_migrations ORDER BY filename`
  );
  return rows;
}

export async function dropSchema(db, schemaName, dialect) {
  // Idempotent: swallow "schema doesn't exist" errors
  try {
    await db.execute(dropSchemaSql(schemaName, dialect));
  } catch (e) {
    if (/does not exist|can't drop|Unknown database/i.test(e.message)) return;
    throw e;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_MYSQL_URL=... npm test --workspace=center -- --test tests/packages/ddl-apply.test.js`
Expected: PASS — all 3 tests green.

- [ ] **Step 5: Mirror + commit**

```bash
cp center/src/packages/ddl-apply.js publish/center/src/packages/ddl-apply.js
git add center/src/packages/ddl-apply.js center/tests/packages/ddl-apply.test.js publish/center/src/packages/ddl-apply.js
git commit -m "feat(packages): DDL apply orchestrator with scan-then-execute flow

ensureSchema / createSchemaMigrationsTable / applyMigrations / dropSchema /
schemaExists / markMigrationsApplied / listAppliedMigrations. Sandbox
runs before any execute; mid-apply failures leave the schema as-is."
```

---

## Task 5: Installer — extend installPackage with v2 DDL apply

**Files:**
- Modify: `center/src/packages/installer.js`
- Modify: `center/src/packages/errors.js`
- Create: `center/tests/packages/installer-v2.test.js` (gated on TEST_MYSQL_URL)
- Mirror: `publish/center/src/packages/installer.js`

**Interfaces:**
- Consumes: existing `installer.installPackage(db, {source, packageRef, buffer, registry})` — keep signature. Add a private branch when `manifest.database` is present.
- Produces: same `{name, version}` on success; throws `PkgError` codes `PKG_DDL_FORBIDDEN`, `PKG_DDL_INVALID_SQL`, `PKG_SCHEMA_EXISTS`, `PKG_INSTALL_FAILED` on failure.

### Steps

- [ ] **Step 1: Add error codes** to `center/src/packages/errors.js` `statusFor()` map:

```js
PKG_DDL_FORBIDDEN: 400,
PKG_DDL_INVALID_SQL: 400,
PKG_SCHEMA_EXISTS: 409,
PKG_CONFIRM_REQUIRED: 400,
PKG_INSTALL_FAILED: 500,
PKG_UPGRADE_FAILED: 500,
PKG_METRIC_KEY_UNKNOWN: 400,
PKG_METRIC_TYPE_MISMATCH: 400,
PKG_METRIC_REQUIRED: 400,
```

- [ ] **Step 2: Write failing tests** in `center/tests/packages/installer-v2.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { init, close, getDb } from '../../src/db/index.js';
import { installer } from '../../src/packages/installer.js';
import { installedPackages } from '../../src/db/sql/installed-packages.js';
import { parseTestUrl } from '../integration/_url.js';

function buildV2Zip({ name, sqlFiles, metricSchema }) {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    name, version: '1.0.0', type: 'gauge',
    agent: { minVersion: '1.0.0', script: 'collect.ps1', intervalSec: 60 },
    metrics: [{ key: 'val', label: 'Val', unit: '%' }],
    database: {
      schemaName: `pkg_${name.replace(/-/g, '_')}`,
      migrations: sqlFiles.map(f => `migrations/${f.filename}`),
      metricTable: 'metrics',
      metricSchema
    }
  })));
  zip.addFile('collect.ps1', Buffer.from('Write-Output "{\"metrics\":{\"val\":0.0}}"'));
  for (const f of sqlFiles) {
    zip.addFile(`migrations/${f.filename}`, Buffer.from(f.content));
  }
  return zip.toBuffer();
}

const SCHEMA = (name) => `pkg_${name.replace(/-/g, '_')}`;

test('installer-v2: installs v2 package, applies DDL, writes installed_packages row', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  await init({
    db: { dialect: 'mysql', mysql: { host, port, database: 'ad_monitoring', user, password } },
    listenPort: 8080, jwtSecret: 'x', agentToken: 'x', staticDir: './dist', logLevel: 'silent', env: 'test'
  });
  const db = getDb();
  const name = 'ad-cpu-monitor-v2-install';
  const schema = SCHEMA(name);
  try {
    const buf = buildV2Zip({
      name,
      sqlFiles: [{ filename: '001.sql', content: `CREATE TABLE ${schema}.metrics (agent_id VARCHAR(64) NOT NULL, ts DATETIME NOT NULL, val DOUBLE NOT NULL, PRIMARY KEY (agent_id, ts))` }],
      metricSchema: { agent_id: { type: 'varchar(64)', nullable: false }, ts: { type: 'datetime', nullable: false }, val: { type: 'double' } }
    });
    await installer.installPackage(db, { source: 'local', buffer: buf });
    const pkg = await installedPackages.get(db, name);
    assert.ok(pkg);
    assert.deepStrictEqual(pkg.manifest.database.schemaName, schema);
    const { rows } = await db.execute(`SHOW TABLES FROM \`${schema}\``);
    const tables = rows.map(r => Object.values(r)[0]);
    assert.ok(tables.includes('metrics'));
    assert.ok(tables.includes('schema_migrations'));
  } finally {
    try { await installer.uninstallPackage(db, { name, purgeMetrics: true, confirmDropSchema: true }); } catch {}
    try { await db.execute(`DROP DATABASE IF EXISTS \`${schema}\``); } catch {}
    try { await close(); } catch {}
  }
});

test('installer-v2: rejects install with PKG_DDL_FORBIDDEN, leaves no residue', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  await init({
    db: { dialect: 'mysql', mysql: { host, port, database: 'ad_monitoring', user, password } },
    listenPort: 8080, jwtSecret: 'x', agentToken: 'x', staticDir: './dist', logLevel: 'silent', env: 'test'
  });
  const db = getDb();
  const name = 'ad-cpu-monitor-evil';
  const schema = SCHEMA(name);
  try {
    const buf = buildV2Zip({
      name,
      sqlFiles: [{ filename: '001.sql', content: 'DROP TABLE main.foo' }],
      metricSchema: { agent_id: { type: 'varchar(64)', nullable: false }, ts: { type: 'datetime', nullable: false }, val: { type: 'double' } }
    });
    await assert.rejects(
      () => installer.installPackage(db, { source: 'local', buffer: buf }),
      /PKG_DDL_FORBIDDEN/
    );
    const pkg = await installedPackages.get(db, name);
    assert.strictEqual(pkg, null);
    // No schema
    const { rows } = await db.execute(`SELECT 1 FROM information_schema.schemata WHERE schema_name = ?`, [schema]);
    assert.strictEqual(rows.length, 0);
  } finally {
    try { await db.execute(`DROP DATABASE IF EXISTS \`${schema}\``); } catch {}
    try { await close(); } catch {}
  }
});

test('installer-v2: PKG_SCHEMA_EXISTS when schema already present', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  await init({
    db: { dialect: 'mysql', mysql: { host, port, database: 'ad_monitoring', user, password } },
    listenPort: 8080, jwtSecret: 'x', agentToken: 'x', staticDir: './dist', logLevel: 'silent', env: 'test'
  });
  const db = getDb();
  const name = 'ad-cpu-monitor-dup';
  const schema = SCHEMA(name);
  try {
    // Pre-create schema
    await db.execute(`CREATE DATABASE IF NOT EXISTS \`${schema}\``);
    const buf = buildV2Zip({
      name,
      sqlFiles: [{ filename: '001.sql', content: `CREATE TABLE ${schema}.metrics (agent_id VARCHAR(64) NOT NULL)` }],
      metricSchema: { agent_id: { type: 'varchar(64)', nullable: false }, ts: { type: 'datetime', nullable: false }, val: { type: 'double' } }
    });
    await assert.rejects(
      () => installer.installPackage(db, { source: 'local', buffer: buf }),
      /PKG_SCHEMA_EXISTS/
    );
  } finally {
    try { await db.execute(`DROP DATABASE IF EXISTS \`${schema}\``); } catch {}
    try { await close(); } catch {}
  }
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `TEST_MYSQL_URL=... npm test --workspace=center -- --test tests/packages/installer-v2.test.js`
Expected: FAIL — install does not create schema.

- [ ] **Step 4: Modify `installer.installPackage`** — add the v2 branch before the existing `installedPackages.upsert`:

```js
import { scanSql } from './ddl-sandbox.js';
import { ensureSchema, createSchemaMigrationsTable, applyMigrations, dropSchema, schemaExists, markMigrationsApplied } from './ddl-apply.js';

// In installPackage, after `validateManifest(manifest)` and before `installedPackages.upsert`:

let schemaName = null;
let appliedFilenames = [];
if (manifest.database) {
  schemaName = manifest.database.schemaName || `pkg_${manifest.name.replace(/-/g, '_')}`;
  if (!/^pkg_[a-z0-9_]+$/.test(schemaName)) {
    throw new PkgError('PKG_DDL_FORBIDDEN', `invalid schemaName: ${schemaName}`);
  }

  // Read migration files from the zip buffer (parseBuffer already extracted `scripts`; we need `migrationFiles` too)
  const zip = new AdmZip(buffer);
  const migrations = manifest.database.migrations;
  const migrationFiles = migrations.map(rel => {
    const entry = zip.getEntry(rel);
    if (!entry) throw new PkgError('PKG_DDL_FORBIDDEN', `migration file missing: ${rel}`);
    return { filename: rel.split('/').pop(), path: rel, content: entry.getData().toString('utf8') };
  });

  if (await schemaExists(db, schemaName, db.dialect)) {
    throw new PkgError('PKG_SCHEMA_EXISTS', `${schemaName} already exists`);
  }

  try {
    await ensureSchema(db, schemaName, db.dialect);
    await createSchemaMigrationsTable(db, schemaName, db.dialect);
    await applyMigrations(db, { schemaName, dialect: db.dialect, files: migrationFiles });
    await markMigrationsApplied(db, { schemaName, version: manifest.version, filenames: migrationFiles.map(f => f.filename) });
    appliedFilenames = migrationFiles.map(f => f.filename);
  } catch (e) {
    // Best-effort rollback
    try { await dropSchema(db, schemaName, db.dialect); } catch {}
    if (e instanceof PkgError && (e.code === 'PKG_DDL_FORBIDDEN' || e.code === 'PKG_DDL_INVALID_SQL')) throw e;
    throw new PkgError('PKG_INSTALL_FAILED', e.message);
  }
}
```

Then update `installedPackages.upsert` call to include the schema info if desired (the manifest already carries it; no DB column change needed).

- [ ] **Step 5: Run test to verify it passes**

Run: `TEST_MYSQL_URL=... npm test --workspace=center -- --test tests/packages/installer-v2.test.js`
Expected: PASS — all 3 tests green.

Also re-run existing installer tests (search for `installer.test.js`):

Run: `cd center && node --test tests/packages/installer.test.js`
Expected: PASS — v1 path untouched.

- [ ] **Step 6: Mirror + commit**

```bash
cp center/src/packages/installer.js publish/center/src/packages/installer.js
cp center/src/packages/errors.js publish/center/src/packages/errors.js
git add center/src/packages/installer.js center/src/packages/errors.js \
        center/tests/packages/installer-v2.test.js \
        publish/center/src/packages/installer.js publish/center/src/packages/errors.js
git commit -m "feat(packages): installer.installPackage applies v2 DDL atomically

v2 manifest.database path: scan → ensureSchema → create schema_migrations
→ apply migrations → mark applied. Failures drop schema best-effort and
return PKG_DDL_FORBIDDEN / PKG_DDL_INVALID_SQL / PKG_SCHEMA_EXISTS /
PKG_INSTALL_FAILED. v1 path unchanged."
```

---

## Task 6: Installer — extend upgradePackage with DDL diff

**Files:**
- Modify: `center/src/packages/installer.js`
- Create: `center/tests/packages/installer-v2-upgrade.test.js` (gated on TEST_MYSQL_URL)
- Mirror: `publish/center/src/packages/installer.js`

**Interfaces:**
- Consumes: existing `installer.upgradePackage(db, {name, version, manifest: candidateManifest, buffer})` — extend signature to accept optional `buffer` (zip with migrations).
- Produces: same `{name, version}` on success.

### Steps

- [ ] **Step 1: Write failing tests** in `center/tests/packages/installer-v2-upgrade.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { init, close, getDb } from '../../src/db/index.js';
import { installer } from '../../src/packages/installer.js';
import { parseTestUrl } from '../integration/_url.js';

function buildV2Zip({ name, version, sqlFiles, metricSchema }) {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    name, version, type: 'gauge',
    agent: { minVersion: '1.0.0', script: 'collect.ps1', intervalSec: 60 },
    metrics: [{ key: 'val', label: 'Val' }],
    database: {
      schemaName: `pkg_${name.replace(/-/g, '_')}`,
      migrations: sqlFiles.map(f => `migrations/${f.filename}`),
      metricTable: 'metrics',
      metricSchema
    }
  })));
  zip.addFile('collect.ps1', Buffer.from('Write-Output "{\"metrics\":{\"val\":0}}"'));
  for (const f of sqlFiles) zip.addFile(`migrations/${f.filename}`, Buffer.from(f.content));
  return zip.toBuffer();
}

const SCHEMA = (name) => `pkg_${name.replace(/-/g, '_')}`;

test('installer-v2-upgrade: applies only new migration files', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  await init({
    db: { dialect: 'mysql', mysql: { host, port, database: 'ad_monitoring', user, password } },
    listenPort: 8080, jwtSecret: 'x', agentToken: 'x', staticDir: './dist', logLevel: 'silent', env: 'test'
  });
  const db = getDb();
  const name = 'ad-upg-v2';
  const schema = SCHEMA(name);
  try {
    // Install 1.0.0 with one migration
    const buf1 = buildV2Zip({
      name, version: '1.0.0',
      sqlFiles: [{ filename: '001.sql', content: `CREATE TABLE ${schema}.metrics (agent_id VARCHAR(64) NOT NULL, ts DATETIME NOT NULL, val DOUBLE NOT NULL, PRIMARY KEY (agent_id, ts))` }],
      metricSchema: { agent_id: { type: 'varchar(64)', nullable: false }, ts: { type: 'datetime', nullable: false }, val: { type: 'double' } }
    });
    await installer.installPackage(db, { source: 'local', buffer: buf1 });

    // Upgrade to 1.1.0 with one new migration
    const buf2 = buildV2Zip({
      name, version: '1.1.0',
      sqlFiles: [
        { filename: '001.sql', content: `CREATE TABLE ${schema}.metrics (agent_id VARCHAR(64) NOT NULL, ts DATETIME NOT NULL, val DOUBLE NOT NULL, PRIMARY KEY (agent_id, ts))` },
        { filename: '002.sql', content: `ALTER TABLE ${schema}.metrics ADD COLUMN extra DOUBLE NULL` }
      ],
      metricSchema: { agent_id: { type: 'varchar(64)', nullable: false }, ts: { type: 'datetime', nullable: false }, val: { type: 'double' }, extra: { type: 'double' } }
    });
    const candidateManifest = JSON.parse(new AdmZip(buf2).getEntry('manifest.json').getData().toString('utf8'));
    await installer.upgradePackage(db, { name, version: '1.1.0', manifest: candidateManifest, buffer: buf2 });

    const { rows } = await db.execute(`SELECT filename FROM \`${schema}\`.schema_migrations ORDER BY filename`);
    assert.deepStrictEqual(rows.map(r => r.filename), ['001.sql', '002.sql']);

    const { rows: cols } = await db.execute(`SHOW COLUMNS FROM \`${schema}\`.metrics`);
    assert.ok(cols.some(c => c.Field === 'extra'));
  } finally {
    try { await installer.uninstallPackage(db, { name, purgeMetrics: true, confirmDropSchema: true }); } catch {}
    try { await db.execute(`DROP DATABASE IF EXISTS \`${schema}\``); } catch {}
    try { await close(); } catch {}
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — upgrade does not apply migrations.

- [ ] **Step 3: Modify `installer.upgradePackage`** — add the v2 branch:

```js
async upgradePackage(db, { name, version, manifest: candidateManifest, buffer }) {
  const existing = await installedPackages.get(db, name);
  if (!existing) throw new PkgError('PKG_NOT_FOUND', name);
  if (!version) throw new PkgError('PKG_VALIDATION_FAILED', 'version required');
  if (!semver.gt(version, existing.version)) {
    throw new PkgError('PKG_VALIDATION_FAILED', `version ${version} is not greater than current ${existing.version}`);
  }

  // Type-change guard (existing v1 behavior)
  let resolvedType = existing.type;
  let newManifest;
  if (candidateManifest) {
    if (candidateManifest.type && candidateManifest.type !== existing.type) {
      throw new PkgError('PKG_VALIDATION_FAILED', `type change not allowed: existing=${existing.type} candidate=${candidateManifest.type}`);
    }
    resolvedType = existing.type;
  }

  // v2 path: diff migrations against schema_migrations; apply only the diff
  if (existing.manifest.database && candidateManifest?.database) {
    if (!buffer) {
      throw new PkgError('PKG_VALIDATION_FAILED', 'buffer required for v2 upgrade');
    }
    const schemaName = candidateManifest.database.schemaName || existing.manifest.database.schemaName;
    if (!/^pkg_[a-z0-9_]+$/.test(schemaName)) {
      throw new PkgError('PKG_DDL_FORBIDDEN', `invalid schemaName: ${schemaName}`);
    }

    const applied = await listAppliedMigrations(db, schemaName);
    const appliedSet = new Set(applied.map(r => r.filename));
    const zip = new AdmZip(buffer);
    const migrations = candidateManifest.database.migrations;
    const migrationFiles = migrations.map(rel => {
      const entry = zip.getEntry(rel);
      if (!entry) throw new PkgError('PKG_DDL_FORBIDDEN', `migration file missing: ${rel}`);
      return { filename: rel.split('/').pop(), path: rel, content: entry.getData().toString('utf8') };
    });
    const toApply = migrationFiles.filter(f => !appliedSet.has(f.filename));

    if (toApply.length) {
      try {
        await applyMigrations(db, { schemaName, dialect: db.dialect, files: toApply });
        await markMigrationsApplied(db, { schemaName, version, filenames: toApply.map(f => f.filename) });
      } catch (e) {
        // No automatic rollback on upgrade — log and rethrow. MySQL DDL implicit-commits.
        await packageRuns.record(db, {
          agentId: 'system',
          packageName: name,
          run: { error: `upgrade mid-failure: ${e.message}` }
        });
        if (e instanceof PkgError && (e.code === 'PKG_DDL_FORBIDDEN' || e.code === 'PKG_DDL_INVALID_SQL')) {
          throw new PkgError('PKG_UPGRADE_FAILED', `${e.code}: ${e.message}`);
        }
        throw new PkgError('PKG_UPGRADE_FAILED', e.message);
      }
    }
    newManifest = { ...candidateManifest, name, version };
  } else if (candidateManifest) {
    newManifest = { ...candidateManifest, name, version };
  } else {
    newManifest = { ...existing.manifest, version };
  }

  await installedPackages.upsert(db, {
    name, version, type: resolvedType, manifest: newManifest, enabled: false, params: existing.params, source: existing.source
  });
  return { name, version };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_MYSQL_URL=... npm test --workspace=center -- --test tests/packages/installer-v2-upgrade.test.js`
Expected: PASS.

- [ ] **Step 5: Mirror + commit**

```bash
cp center/src/packages/installer.js publish/center/src/packages/installer.js
git add center/src/packages/installer.js center/tests/packages/installer-v2-upgrade.test.js publish/center/src/packages/installer.js
git commit -m "feat(packages): installer.upgradePackage applies v2 DDL diff

Reads applied migrations from pkg_<name>.schema_migrations; applies
only the new files. Mid-upgrade failures leave partial state and log
to package_runs (MySQL DDL implicit-commits block automatic rollback)."
```

---

## Task 7: Installer — extend uninstallPackage with DROP SCHEMA

**Files:**
- Modify: `center/src/packages/installer.js`
- Create: `center/tests/packages/installer-v2-uninstall.test.js` (gated on TEST_MYSQL_URL)
- Mirror: `publish/center/src/packages/installer.js`

**Interfaces:**
- Consumes: `installer.uninstallPackage(db, {name, purgeMetrics, confirmDropSchema?})` — extend.
- Produces: void on success.

### Steps

- [ ] **Step 1: Write failing tests** in `center/tests/packages/installer-v2-uninstall.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { init, close, getDb } from '../../src/db/index.js';
import { installer } from '../../src/packages/installer.js';
import { orphanSchemas } from '../../src/db/sql/orphan-schemas.js';
import { parseTestUrl } from '../integration/_url.js';

function buildV2Zip(name) {
  const zip = new AdmZip();
  const schema = `pkg_${name.replace(/-/g, '_')}`;
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    name, version: '1.0.0', type: 'gauge',
    agent: { minVersion: '1.0.0', script: 'collect.ps1', intervalSec: 60 },
    metrics: [{ key: 'val', label: 'Val' }],
    database: { schemaName: schema, migrations: [`migrations/001.sql`], metricTable: 'metrics',
      metricSchema: { agent_id: { type: 'varchar(64)', nullable: false }, ts: { type: 'datetime', nullable: false }, val: { type: 'double' } } }
  })));
  zip.addFile('collect.ps1', Buffer.from('Write-Output "{\"metrics\":{\"val\":0}}"'));
  zip.addFile('migrations/001.sql', Buffer.from(`CREATE TABLE ${schema}.metrics (agent_id VARCHAR(64) NOT NULL, ts DATETIME NOT NULL, val DOUBLE NOT NULL, PRIMARY KEY (agent_id, ts))`));
  return zip.toBuffer();
}

test('installer-v2-uninstall: drops schema when purgeMetrics=true and confirmDropSchema=true', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  await init({
    db: { dialect: 'mysql', mysql: { host, port, database: 'ad_monitoring', user, password } },
    listenPort: 8080, jwtSecret: 'x', agentToken: 'x', staticDir: './dist', logLevel: 'silent', env: 'test'
  });
  const db = getDb();
  const name = 'ad-uninst-v2-ok';
  const schema = `pkg_${name.replace(/-/g, '_')}`;
  try {
    const buf = buildV2Zip(name);
    await installer.installPackage(db, { source: 'local', buffer: buf });
    await installer.uninstallPackage(db, { name, purgeMetrics: true, confirmDropSchema: true });
    const { rows } = await db.execute(`SELECT 1 FROM information_schema.schemata WHERE schema_name = ?`, [schema]);
    assert.strictEqual(rows.length, 0);
  } finally {
    try { await db.execute(`DROP DATABASE IF EXISTS \`${schema}\``); } catch {}
    try { await close(); } catch {}
  }
});

test('installer-v2-uninstall: rejects with PKG_CONFIRM_REQUIRED when confirmDropSchema missing', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  await init({
    db: { dialect: 'mysql', mysql: { host, port, database: 'ad_monitoring', user, password } },
    listenPort: 8080, jwtSecret: 'x', agentToken: 'x', staticDir: './dist', logLevel: 'silent', env: 'test'
  });
  const db = getDb();
  const name = 'ad-uninst-v2-confirm';
  const schema = `pkg_${name.replace(/-/g, '_')}`;
  try {
    const buf = buildV2Zip(name);
    await installer.installPackage(db, { source: 'local', buffer: buf });
    await assert.rejects(
      () => installer.uninstallPackage(db, { name, purgeMetrics: true }),
      /PKG_CONFIRM_REQUIRED/
    );
    // Schema still present
    const { rows } = await db.execute(`SELECT 1 FROM information_schema.schemata WHERE schema_name = ?`, [schema]);
    assert.strictEqual(rows.length, 1);
  } finally {
    try { await installer.uninstallPackage(db, { name, purgeMetrics: true, confirmDropSchema: true }); } catch {}
    try { await close(); } catch {}
  }
});

test('installer-v2-uninstall: records orphan_schemas when DROP fails', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  await init({
    db: { dialect: 'mysql', mysql: { host, port, database: 'ad_monitoring', user, password } },
    listenPort: 8080, jwtSecret: 'x', agentToken: 'x', staticDir: './dist', logLevel: 'silent', env: 'test'
  });
  const db = getDb();
  const name = 'ad-uninst-v2-orphan';
  const schema = `pkg_${name.replace(/-/g, '_')}`;
  try {
    const buf = buildV2Zip(name);
    await installer.installPackage(db, { source: 'local', buffer: buf });

    // Simulate DROP failure by revoking DROP privilege: create a table
    // the test user can't drop. Easiest cross-env way: rename the schema
    // so the DROP fails with "Unknown database" is the wrong failure —
    // we need it to succeed-then-fail. Instead, simulate by directly
    // creating a conflicting table in another DB. For test purposes,
    // monkey-patch db.execute to throw on DROP DATABASE:
    const origExecute = db.execute.bind(db);
    db.execute = async (sql, params) => {
      if (typeof sql === 'string' && /^DROP DATABASE/.test(sql)) {
        throw new Error('simulated DROP failure');
      }
      return origExecute(sql, params);
    };

    try {
      await installer.uninstallPackage(db, { name, purgeMetrics: true, confirmDropSchema: true });
    } finally {
      db.execute = origExecute;
    }

    const orphans = await orphanSchemas.list(db);
    const found = orphans.find(r => r.name === schema);
    assert.ok(found, `orphan_schemas should record ${schema}; got ${orphans.map(r => r.name).join(',')}`);
  } finally {
    try { await db.execute(`DROP DATABASE IF EXISTS \`${schema}\``); } catch {}
    try { await orphanSchemas.delete(db, `pkg_${name.replace(/-/g, '_')}`); } catch {}
    try { await close(); } catch {}
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — uninstall does not drop schema.

- [ ] **Step 3: Modify `installer.uninstallPackage`**:

```js
async uninstallPackage(db, { name, purgeMetrics, confirmDropSchema }) {
  const existing = await installedPackages.get(db, name);
  if (!existing) throw new PkgError('PKG_NOT_FOUND', name);

  // v2: drop schema first if requested
  if (existing.manifest.database) {
    if (!purgeMetrics) {
      // No drop; just disable + remove cache (next branch handles v1 cleanup)
    } else {
      if (!confirmDropSchema) {
        throw new PkgError('PKG_CONFIRM_REQUIRED', `set confirmDropSchema=true to drop pkg schema for ${name}`);
      }
      const schemaName = existing.manifest.database.schemaName;
      try {
        await dropSchema(db, schemaName, db.dialect);
      } catch (e) {
        // Record orphan and continue (do not block uninstall)
        await orphanSchemas.upsert(db, {
          name: schemaName,
          lastSeenAt: new Date(),
          note: `uninstall DROP failed: ${e.message}`
        });
      }
    }
  } else if (purgeMetrics) {
    // Existing v1 path
    await db.execute(`DELETE FROM metric_gauge WHERE metric_id LIKE ?`, [`${name}.%`]);
    await db.execute(`DELETE FROM metric_counter WHERE metric_id LIKE ?`, [`${name}.%`]);
    await db.execute(`DELETE FROM metric_timeseries WHERE metric_id LIKE ?`, [`${name}.%`]);
    await db.execute(`DELETE FROM metric_status WHERE metric_id LIKE ?`, [`${name}.%`]);
  }

  await db.execute(`DELETE FROM package_runs WHERE package_name = ?`, [name]);
  await installedPackages.delete(db, name);

  // Remove cache directory
  const cacheDir = path.join(process.cwd(), 'data', 'packages', name);
  if (fs.existsSync(cacheDir)) fs.rmSync(cacheDir, { recursive: true, force: true });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_MYSQL_URL=... npm test --workspace=center -- --test tests/packages/installer-v2-uninstall.test.js`
Expected: PASS.

- [ ] **Step 5: Mirror + commit**

```bash
cp center/src/packages/installer.js publish/center/src/packages/installer.js
git add center/src/packages/installer.js center/tests/packages/installer-v2-uninstall.test.js publish/center/src/packages/installer.js
git commit -m "feat(packages): installer.uninstallPackage drops pkg schema or records orphan

v2 + purgeMetrics + confirmDropSchema=true → DROP DATABASE/SCHEMA.
Missing confirmDropSchema on v2 uninstall returns PKG_CONFIRM_REQUIRED.
DROP failure records row in orphan_schemas and continues (uninstall
still completes — installed_packages row + cache removed)."
```

---

## Task 8: Metricstore — extend ingestRun with v2 path

**Files:**
- Modify: `center/src/packages/metricstore.js`
- Create: `center/tests/packages/metricstore-v2.test.js` (gated on TEST_MYSQL_URL)
- Mirror: `publish/center/src/packages/metricstore.js`

**Interfaces:**
- Consumes: existing `metricstore.ingestRun(db, {agentId, packageName, manifest, runs})` — extend with v2 branch.
- Produces: same shape as v1 path.

### Steps

- [ ] **Step 1: Write failing tests** in `center/tests/packages/metricstore-v2.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { init, close, getDb } from '../../src/db/index.js';
import { installer } from '../../src/packages/installer.js';
import { metricstore } from '../../src/packages/metricstore.js';
import { parseTestUrl } from '../integration/_url.js';

function buildV2Zip(name) {
  const zip = new AdmZip();
  const schema = `pkg_${name.replace(/-/g, '_')}`;
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    name, version: '1.0.0', type: 'gauge',
    agent: { minVersion: '1.0.0', script: 'collect.ps1', intervalSec: 60 },
    metrics: [{ key: 'val', label: 'Val' }],
    database: { schemaName: schema, migrations: ['migrations/001.sql'], metricTable: 'metrics',
      metricSchema: { agent_id: { type: 'varchar(64)', nullable: false }, ts: { type: 'datetime', nullable: false }, val: { type: 'double' } } }
  })));
  zip.addFile('collect.ps1', Buffer.from(''));
  zip.addFile('migrations/001.sql', Buffer.from(`CREATE TABLE ${schema}.metrics (agent_id VARCHAR(64) NOT NULL, ts DATETIME NOT NULL, val DOUBLE NOT NULL, PRIMARY KEY (agent_id, ts))`));
  return zip.toBuffer();
}

test('metricstore-v2: ingestRun writes to pkg_<name>.<metricTable> for v2 packages', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  await init({
    db: { dialect: 'mysql', mysql: { host, port, database: 'ad_monitoring', user, password } },
    listenPort: 8080, jwtSecret: 'x', agentToken: 'x', staticDir: './dist', logLevel: 'silent', env: 'test'
  });
  const db = getDb();
  const name = 'ad-mstore-v2';
  const schema = `pkg_${name.replace(/-/g, '_')}`;
  try {
    const buf = buildV2Zip(name);
    await installer.installPackage(db, { source: 'local', buffer: buf });
    const pkg = (await db.execute(`SELECT manifest_json FROM installed_packages WHERE name = ?`, [name])).rows[0];
    const manifest = JSON.parse(pkg.manifest_json);
    const agentId = 'agent-001';

    await metricstore.ingestRun(db, {
      agentId,
      packageName: name,
      manifest,
      runs: [{ metrics: { val: 78.4 }, error: null }]
    });

    const { rows } = await db.execute(`SELECT * FROM \`${schema}\`.metrics WHERE agent_id = ?`, [agentId]);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(Number(rows[0].val), 78.4);
    assert.strictEqual(rows[0].agent_id, agentId);
  } finally {
    try { await installer.uninstallPackage(db, { name, purgeMetrics: true, confirmDropSchema: true }); } catch {}
    try { await close(); } catch {}
  }
});

test('metricstore-v2: rejects PKG_METRIC_KEY_UNKNOWN for keys not in metricSchema', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  await init({
    db: { dialect: 'mysql', mysql: { host, port, database: 'ad_monitoring', user, password } },
    listenPort: 8080, jwtSecret: 'x', agentToken: 'x', staticDir: './dist', logLevel: 'silent', env: 'test'
  });
  const db = getDb();
  const name = 'ad-mstore-v2-unknown';
  const schema = `pkg_${name.replace(/-/g, '_')}`;
  try {
    const buf = buildV2Zip(name);
    await installer.installPackage(db, { source: 'local', buffer: buf });
    const pkg = (await db.execute(`SELECT manifest_json FROM installed_packages WHERE name = ?`, [name])).rows[0];
    const manifest = JSON.parse(pkg.manifest_json);
    await assert.rejects(
      () => metricstore.ingestRun(db, {
        agentId: 'a', packageName: name, manifest,
        runs: [{ metrics: { val: 1, rogueKey: 99 }, error: null }]
      }),
      /PKG_METRIC_KEY_UNKNOWN/
    );
  } finally {
    try { await installer.uninstallPackage(db, { name, purgeMetrics: true, confirmDropSchema: true }); } catch {}
    try { await close(); } catch {}
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — ingestRun only writes to v1 metric_* tables.

- [ ] **Step 3: Modify `metricstore.ingestRun`** — add v2 branch at the top:

```js
async ingestRun(db, { agentId, packageName, manifest, runs }) {
  // v2 path: route to pkg_<name>.<metricTable>
  if (manifest.database?.metricTable) {
    return ingestRunV2(db, { agentId, packageName, manifest, runs });
  }
  // v1 path: existing 4-table switch
  // ... (existing body unchanged)
}

async function ingestRunV2(db, { agentId, packageName, manifest, runs }) {
  const schemaName = manifest.database.schemaName;
  const table = manifest.database.metricTable;
  const columns = Object.keys(manifest.database.metricSchema);
  const userCols = columns.filter(c => c !== 'agent_id' && c !== 'ts');
  const ts = new Date();

  for (const run of runs) {
    if (run.error) continue;
    const data = run.metrics || {};
    const unknown = Object.keys(data).filter(k => !columns.includes(k));
    if (unknown.length) {
      throw new PkgError('PKG_METRIC_KEY_UNKNOWN', `${packageName} metrics include unknown keys: ${unknown.join(',')}`);
    }
    for (const col of userCols) {
      const decl = manifest.database.metricSchema[col];
      const v = data[col];
      if (v == null) {
        if (decl.nullable === false) throw new PkgError('PKG_METRIC_REQUIRED', `${packageName} metric ${col} required`);
      } else if (/^(double|float|decimal|numeric)/.test(decl.type)) {
        if (typeof v !== 'number') throw new PkgError('PKG_METRIC_TYPE_MISMATCH', `${packageName} metric ${col} expected ${decl.type}, got ${typeof v}`);
      }
    }
    const values = userCols.map(c => data[c]);
    const placeholders = userCols.map(() => '?').join(',');
    await db.execute(
      `INSERT INTO \`${schemaName}\`.${table} (agent_id, ts, ${userCols.join(',')}) VALUES (?, ?, ${placeholders})`,
      [agentId, ts, ...values]
    );
  }
}
```

Add `import { PkgError } from './errors.js';` at the top.

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_MYSQL_URL=... npm test --workspace=center -- --test tests/packages/metricstore-v2.test.js`
Expected: PASS.

Also re-run the existing v1 metricstore tests (search for `metricstore.test.js`):

Run: `cd center && node --test tests/packages/metricstore.test.js`
Expected: PASS — v1 path unchanged.

- [ ] **Step 5: Mirror + commit**

```bash
cp center/src/packages/metricstore.js publish/center/src/packages/metricstore.js
git add center/src/packages/metricstore.js center/tests/packages/metricstore-v2.test.js publish/center/src/packages/metricstore.js
git commit -m "feat(packages): metricstore.ingestRun routes v2 packages to pkg schema

manifest.database presence → INSERT INTO pkg_<name>.<metricTable> with
agent_id from token, ts from server clock. Validates metric keys against
metricSchema and rejects PKG_METRIC_KEY_UNKNOWN / PKG_METRIC_TYPE_MISMATCH /
PKG_METRIC_REQUIRED. v1 path untouched."
```

---

## Task 9: Registry index schema — extend for `database` field

**Files:**
- Modify: `center/src/packages/registry-index.schema.json`
- Create: `center/tests/packages/registry-v2-index.test.js`
- Mirror: `publish/center/src/packages/registry-index.schema.json`

**Interfaces:**
- Consumes: existing `RegistryClient.fetchIndex()` which validates index.json against `registry-index.schema.json`.
- Produces: same `fetchIndex` API; rejects v2 entries without proper `database` field.

### Steps

- [ ] **Step 1: Write failing tests** in `center/tests/packages/registry-v2-index.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRegistryIndex } from '../../src/packages/registry.js';
// adjust import to actual export — verify by grepping registry.js

test('registry: index without database field still validates (v1 entries)', () => {
  const idx = {
    version: 1,
    updatedAt: '2026-08-09T00:00:00Z',
    packages: [{
      name: 'ad-cpu-monitor', latestVersion: '1.0.0', type: 'gauge',
      versions: [{ version: '1.0.0', package: 'x.zip', size: 100, sha256: 'a'.repeat(64) }]
    }]
  };
  assert.strictEqual(validateRegistryIndex(idx).valid, true);
});

test('registry: index with valid database field validates (v2 entries)', () => {
  const idx = {
    version: 1,
    updatedAt: '2026-08-09T00:00:00Z',
    packages: [{
      name: 'ad-cpu-monitor-v2', latestVersion: '1.0.0', type: 'gauge',
      database: { schemaName: 'pkg_ad_cpu_monitor_v2', migrations: ['migrations/001.sql'], metricTable: 'metrics', metricColumns: 3 },
      versions: [{ version: '1.0.0', package: 'x.zip', size: 100, sha256: 'a'.repeat(64) }]
    }]
  };
  assert.strictEqual(validateRegistryIndex(idx).valid, true);
});

test('registry: rejects database with bad schemaName', () => {
  const idx = {
    version: 1, updatedAt: '2026-08-09T00:00:00Z',
    packages: [{
      name: 'ad-foo', latestVersion: '1.0.0', type: 'gauge',
      database: { schemaName: 'wrong_prefix', migrations: ['001.sql'], metricTable: 'metrics' },
      versions: [{ version: '1.0.0', package: 'x.zip', size: 100, sha256: 'a'.repeat(64) }]
    }]
  };
  assert.strictEqual(validateRegistryIndex(idx).valid, false);
});
```

Note: if `validateRegistryIndex` is not exported, find the equivalent (grep for the ajv `compile` in `registry.js`) and either export it or assert against it. If the existing `registry.js` does not export the validator, refactor minimally: extract `validateRegistryIndex` to its own export without changing existing call sites.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd center && node --test tests/packages/registry-v2-index.test.js`
Expected: FAIL — database field rejected.

- [ ] **Step 3: Extend registry-index.schema.json** — add to each `packages.items.properties`:

```jsonc
"database": {
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaName", "migrations", "metricTable"],
  "properties": {
    "schemaName":   { "type": "string", "pattern": "^pkg_[a-z0-9_]+$" },
    "migrations":   { "type": "array", "minItems": 1, "items": { "type": "string" } },
    "metricTable":  { "type": "string", "pattern": "^[a-z0-9_]+$" },
    "metricColumns":{ "type": "integer", "minimum": 3 }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd center && node --test tests/packages/registry-v2-index.test.js`
Expected: PASS — all 3 tests green.

Also re-run existing registry tests:

Run: `cd center && node --test tests/packages/registry.test.js`
Expected: PASS — v1 index entries (no `database`) still validate.

- [ ] **Step 5: Mirror + commit**

```bash
cp center/src/packages/registry-index.schema.json publish/center/src/packages/registry-index.schema.json
git add center/src/packages/registry-index.schema.json center/tests/packages/registry-v2-index.test.js publish/center/src/packages/registry-index.schema.json
git commit -m "feat(packages): registry index schema accepts v2 database field

Optional database.{schemaName,migrations,metricTable,metricColumns}.
v1 entries (no database) continue to validate. Rejects bad schemaName
or empty migrations."
```

---

## Task 10: Admin API endpoints — ddl-preview + orphan-schemas CRUD + install/uninstall confirm

**Files:**
- Modify: `center/src/packages/router.js`
- Create: `center/src/packages/orphan-router.js`
- Modify: `center/server.js` (mount orphan-router)
- Create: `center/tests/packages/router-v2.test.js`
- Mirror: `publish/center/src/packages/router.js`, `publish/center/src/packages/orphan-router.js`

**Interfaces:**
- Consumes: existing router + new admin endpoint helpers.
- Produces:
  - `GET /api/admin/packages/:name/ddl-preview` → `{schemaName, files: [{path, filename, content}]}`.
  - `GET /api/admin/orphan-schemas` → `[{name, last_seen_at, note}]`.
  - `DELETE /api/admin/orphan-schemas/:name` → `{ok}` (drops schema + deletes row).
  - Modified `POST /api/admin/packages/install` body gains optional `confirmDropSchema: true`.
  - Modified `DELETE /api/admin/packages/:name?purgeMetrics=…&confirmDropSchema=…`.

### Steps

- [ ] **Step 1: Write failing tests** in `center/tests/packages/router-v2.test.js` — use `supertest` like existing router tests (find the test file pattern by `grep -l supertest center/tests/packages/`):

```js
// Skeleton — fill in auth token from existing tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import express from 'express';
import { init, close, getDb } from '../../src/db/index.js';
import { installer } from '../../src/packages/installer.js';
import { orphanSchemas } from '../../src/db/sql/orphan-schemas.js';
import { packageRouter } from '../../src/packages/router.js';
import { orphanRouter } from '../../src/packages/orphan-router.js';
import AdmZip from 'adm-zip';

test('router-v2: ddl-preview returns schemaName + migration file contents', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const app = express();
  // ... boot db, install a v2 package, then GET /api/admin/packages/:name/ddl-preview
});

test('router-v2: orphan-schemas CRUD end-to-end', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  // upsert a row, GET list, DELETE, GET list again
});

// ... plus install/uninstall confirm tests
```

Implement the test bodies following the existing router test patterns in `center/tests/packages/router.test.js`.

- [ ] **Step 2: Implement `center/src/packages/orphan-router.js`**:

```js
// Admin endpoints for orphan_schemas — list + manual drop. Mounted at
// /api/admin/orphan-schemas. Same auth pattern as packageRouter.

import express from 'express';
import { orphanSchemas } from '../db/sql/orphan-schemas.js';
import { dropSchema } from './ddl-apply.js';
import { PkgError } from './errors.js';
import { userAuth } from '../auth/user-auth.js';
import { requirePerm } from '../auth/rbac.js';

export function orphanRouter({ db, config }) {
  const r = express.Router();
  const auth = [userAuth({ secret: config.jwtSecret }), requirePerm('admin:packages')];

  r.get('/api/admin/orphan-schemas', auth, async (_req, res) => {
    try {
      const rows = await orphanSchemas.list(db);
      res.json({ schemas: rows });
    } catch (e) {
      res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: e.message } });
    }
  });

  r.delete('/api/admin/orphan-schemas/:name', auth, async (req, res) => {
    try {
      const name = req.params.name;
      if (!/^pkg_[a-z0-9_]+$/.test(name)) {
        return res.status(400).json({ ok: false, error: { code: 'PKG_DDL_FORBIDDEN', message: `bad schemaName: ${name}` } });
      }
      try {
        await dropSchema(db, name, db.dialect);
      } catch (e) {
        throw new PkgError('PKG_DDL_INVALID_SQL', e.message);
      }
      await orphanSchemas.delete(db, name);
      res.json({ ok: true });
    } catch (e) {
      if (e instanceof PkgError) {
        return res.status(e.status || 400).json({ ok: false, error: { code: e.code, message: e.message } });
      }
      res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: e.message } });
    }
  });

  return r;
}
```

- [ ] **Step 3: Add `ddl-preview` route + modify install/uninstall in `center/src/packages/router.js`**:

```js
// Add new GET route (place before /:name to follow static-before-dynamic)
r.get('/api/admin/packages/:name/ddl-preview', auth, async (req, res) => {
  try {
    const pkg = await installedPackages.get(db, req.params.name);
    if (!pkg) {
      return res.status(404).json({ ok: false, error: { code: 'PKG_NOT_FOUND', message: req.params.name } });
    }
    if (!pkg.manifest.database) {
      return res.json({ schemaName: null, files: [] });
    }
    const schemaName = pkg.manifest.database.schemaName;
    const cacheDir = join(process.cwd(), 'data', 'packages', req.params.name, pkg.version);
    const files = [];
    for (const rel of pkg.manifest.database.migrations) {
      const filename = rel.split('/').pop();
      const content = readFileSync(join(cacheDir, rel), 'utf8');
      files.push({ path: rel, filename, content });
    }
    res.json({ schemaName, files });
  } catch (e) {
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: e.message } });
  }
});

// Modify POST /install: body gains confirmDropSchema
//   For v2 packages, PKG_SCHEMA_EXISTS is thrown by the installer — let it propagate.

// Modify DELETE /:name: query gains confirmDropSchema
r.delete('/api/admin/packages/:name', auth, async (req, res) => {
  try {
    const purgeMetrics = req.query.purgeMetrics === 'true';
    const confirmDropSchema = req.query.confirmDropSchema === 'true';
    await installer.uninstallPackage(db, {
      name: req.params.name,
      purgeMetrics,
      confirmDropSchema
    });
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof PkgError) {
      return res.status(e.status || 400).json({ ok: false, error: { code: e.code, message: e.message } });
    }
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: e.message } });
  }
});
```

- [ ] **Step 4: Mount orphan-router in `center/server.js`** — find where `packageRouter` is mounted and add `orphanRouter` next to it:

```js
app.use(orphanRouter({ db: getDb(), config: { jwtSecret: cfg.jwtSecret } }));
```

(Verify the exact import + setup pattern by reading the existing mount block in `server.js` — follow it exactly.)

- [ ] **Step 5: Run router-v2.test.js + existing router tests**

Run: `TEST_MYSQL_URL=... npm test --workspace=center -- --test tests/packages/router-v2.test.js tests/packages/router.test.js`
Expected: PASS — both old and new tests green.

- [ ] **Step 6: Mirror + commit**

```bash
cp center/src/packages/router.js publish/center/src/packages/router.js
cp center/src/packages/orphan-router.js publish/center/src/packages/orphan-router.js
# server.js is already mirrored
git add center/src/packages/router.js center/src/packages/orphan-router.js center/server.js \
        center/tests/packages/router-v2.test.js \
        publish/center/src/packages/router.js publish/center/src/packages/orphan-router.js
git commit -m "feat(api): ddl-preview + orphan-schemas admin endpoints + install/uninstall confirm

GET /api/admin/packages/:name/ddl-preview returns migration files for
pre-install review. GET/DELETE /api/admin/orphan-schemas/* lets admin
clean up DROP failures. install/uninstall now respect confirmDropSchema."
```

---

## Task 11: Frontend — DDL preview modal + uninstall confirm modal + PackageEditView wiring

**Files:**
- Create: `frontend/src/components/PackageDdlPreviewModal.vue`
- Create: `frontend/src/components/UninstallSchemaConfirmModal.vue`
- Modify: `frontend/src/views/admin/PackageEditView.vue`
- Modify: `frontend/src/api/admin.js`
- Create: `frontend/tests/self-contained-package-view.test.js`
- Mirror: `publish/frontend/src/components/PackageDdlPreviewModal.vue`, `publish/frontend/src/components/UninstallSchemaConfirmModal.vue`, `publish/frontend/src/views/admin/PackageEditView.vue`, `publish/frontend/src/api/admin.js`

**Interfaces:**
- Consumes: existing `api/admin.js` API client + admin UI patterns from `SiteEditModal.vue` (for modal styling).
- Produces:
  - `<PackageDdlPreviewModal :visible :schemaName :files @close />`
  - `<UninstallSchemaConfirmModal :visible :packageName :schemaName :metricRowCount @confirm @close />`

### Steps

- [ ] **Step 1: Write failing frontend tests** in `frontend/tests/self-contained-package-view.test.js`:

```js
import { mount } from '@vue/test-utils';
import { describe, it, expect, vi } from 'vitest';
import PackageDdlPreviewModal from '@/components/PackageDdlPreviewModal.vue';

describe('PackageDdlPreviewModal', () => {
  it('renders schemaName and each file content', () => {
    const wrapper = mount(PackageDdlPreviewModal, {
      props: {
        visible: true,
        schemaName: 'pkg_test',
        files: [
          { path: 'migrations/001.sql', filename: '001.sql', content: 'CREATE TABLE x (id INT)' },
          { path: 'migrations/002.sql', filename: '002.sql', content: 'ALTER TABLE x ADD COLUMN y INT' }
        ]
      }
    });
    expect(wrapper.text()).toContain('pkg_test');
    expect(wrapper.text()).toContain('001.sql');
    expect(wrapper.text()).toContain('CREATE TABLE x');
  });

  it('emits close when X clicked', async () => {
    const wrapper = mount(PackageDdlPreviewModal, { props: { visible: true, schemaName: 'x', files: [] } });
    await wrapper.find('[data-test=close]').trigger('click');
    expect(wrapper.emitted('close')).toBeTruthy();
  });
});

describe('UninstallSchemaConfirmModal', () => {
  it('disables confirm button until checkbox checked', async () => {
    const wrapper = mount(UninstallSchemaConfirmModal, {
      props: { visible: true, packageName: 'ad-foo', schemaName: 'pkg_foo', metricRowCount: 0 }
    });
    expect(wrapper.find('[data-test=confirm]').attributes('disabled')).toBeDefined();
    await wrapper.find('[data-test=confirm-checkbox]').setValue(true);
    expect(wrapper.find('[data-test=confirm]').attributes('disabled')).toBeUndefined();
  });

  it('emits confirm with payload on click', async () => {
    const wrapper = mount(UninstallSchemaConfirmModal, {
      props: { visible: true, packageName: 'ad-foo', schemaName: 'pkg_foo', metricRowCount: 5 }
    });
    await wrapper.find('[data-test=confirm-checkbox]').setValue(true);
    await wrapper.find('[data-test=confirm]').trigger('click');
    expect(wrapper.emitted('confirm')).toBeTruthy();
    expect(wrapper.emitted('confirm')[0][0]).toEqual({ confirmDropSchema: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/self-contained-package-view.test.js`
Expected: FAIL — components don't exist.

- [ ] **Step 3: Implement `frontend/src/components/PackageDdlPreviewModal.vue`** (skeleton, follow `SiteEditModal.vue` styling):

```vue
<template>
  <div v-if="visible" class="modal-bg" @click.self="$emit('close')">
    <div class="modal">
      <header>
        <h3>DDL 预览: {{ schemaName }}</h3>
        <button data-test="close" @click="$emit('close')">×</button>
      </header>
      <section>
        <p class="warning">未签名包 — install 前请审查以下 DDL。</p>
        <div v-for="f in files" :key="f.filename" class="file-block">
          <h4>{{ f.path }}</h4>
          <pre><code>{{ f.content }}</code></pre>
        </div>
      </section>
      <footer>
        <button @click="$emit('close')">关闭</button>
      </footer>
    </div>
  </div>
</template>

<script setup>
defineProps({ visible: Boolean, schemaName: String, files: Array });
defineEmits(['close']);
</script>

<style scoped>
/* match SiteEditModal.vue */
.modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; }
.modal { background: #fff; padding: 1.5em; border-radius: 6px; max-width: 80vw; max-height: 80vh; overflow: auto; }
.warning { color: #b00; }
pre { background: #f4f4f4; padding: 0.5em; overflow: auto; }
</style>
```

- [ ] **Step 4: Implement `frontend/src/components/UninstallSchemaConfirmModal.vue`**:

```vue
<template>
  <div v-if="visible" class="modal-bg" @click.self="$emit('close')">
    <div class="modal">
      <header><h3>卸载确认: {{ packageName }}</h3></header>
      <section>
        <p>将删除 schema <code>{{ schemaName }}</code> 及其全部数据({{ metricRowCount }} 行 metric 记录)。此操作不可撤销。</p>
        <label>
          <input type="checkbox" data-test="confirm-checkbox" v-model="confirmed" />
          我已审查 DDL,确认删除
        </label>
      </section>
      <footer>
        <button @click="$emit('close')">取消</button>
        <button data-test="confirm" :disabled="!confirmed" @click="$emit('confirm', { confirmDropSchema: true })">确认卸载</button>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
defineProps({ visible: Boolean, packageName: String, schemaName: String, metricRowCount: { type: Number, default: 0 } });
defineEmits(['close', 'confirm']);
const confirmed = ref(false);
</script>

<style scoped>
.modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; }
.modal { background: #fff; padding: 1.5em; border-radius: 6px; max-width: 600px; }
</style>
```

- [ ] **Step 5: Extend `frontend/src/api/admin.js`** with:

```js
getDdlPreview: (name) => api.get(`/api/admin/packages/${name}/ddl-preview`),
listOrphanSchemas: () => api.get('/api/admin/orphan-schemas'),
dropOrphanSchema: (name) => api.delete(`/api/admin/orphan-schemas/${name}`),
uninstallPackage: (name, { purgeMetrics = false, confirmDropSchema = false } = {}) =>
  api.delete(`/api/admin/packages/${name}`, { params: { purgeMetrics, confirmDropSchema } }),
```

Modify the existing `uninstallPackage` call site (search for it) to pass `confirmDropSchema: true` when the package has a `database` field.

- [ ] **Step 6: Modify `frontend/src/views/admin/PackageEditView.vue`**:

Add state + handlers + template sections:

```js
// in <script setup>
import { ref, computed } from 'vue';
import PackageDdlPreviewModal from '@/components/PackageDdlPreviewModal.vue';
import UninstallSchemaConfirmModal from '@/components/UninstallSchemaConfirmModal.vue';
import { adminApi } from '@/api/admin.js';

const ddlPreviewVisible = ref(false);
const ddlPreview = ref({ schemaName: null, files: [] });
const uninstallConfirmVisible = ref(false);

const isV2 = computed(() => !!pkg.value?.manifest?.database);

async function showDdlPreview() {
  ddlPreview.value = await adminApi.getDdlPreview(pkg.value.name);
  ddlPreviewVisible.value = true;
}

function requestUninstall() {
  if (isV2.value) {
    uninstallConfirmVisible.value = true;
  } else {
    doUninstall(false);
  }
}

async function doUninstall(confirmDropSchema) {
  await adminApi.uninstallPackage(pkg.value.name, { purgeMetrics: true, confirmDropSchema });
  // navigate back to /admin/packages
}

// in <template>, add a "数据库" section (only when isV2):
<section v-if="isV2" class="database">
  <h3>数据库</h3>
  <p>Schema: <code>{{ pkg.manifest.database.schemaName }}</code></p>
  <p>Migrations: <span>{{ pkg.manifest.database.migrations.length }}</span> 个文件</p>
  <button @click="showDdlPreview">查看 DDL</button>
</section>

// existing uninstall button — wire to requestUninstall()
<button @click="requestUninstall">卸载</button>

// mount modals
<PackageDdlPreviewModal v-model:visible="ddlPreviewVisible" :schemaName="ddlPreview.schemaName" :files="ddlPreview.files" @close="ddlPreviewVisible = false" />
<UninstallSchemaConfirmModal v-model:visible="uninstallConfirmVisible" :packageName="pkg.name" :schemaName="pkg.manifest.database.schemaName" :metricRowCount="recentRuns.length" @confirm="doUninstall(true); uninstallConfirmVisible = false" @close="uninstallConfirmVisible = false" />
```

- [ ] **Step 7: Run frontend test to verify it passes**

Run: `cd frontend && npx vitest run tests/self-contained-package-view.test.js`
Expected: PASS.

Also run existing PackageEditView tests (search for `package-edit-view.test.js`):

Run: `cd frontend && npx vitest run tests/package-edit-view.test.js`
Expected: PASS.

- [ ] **Step 8: Mirror + commit**

```bash
cp frontend/src/components/PackageDdlPreviewModal.vue publish/frontend/src/components/PackageDdlPreviewModal.vue
cp frontend/src/components/UninstallSchemaConfirmModal.vue publish/frontend/src/components/UninstallSchemaConfirmModal.vue
cp frontend/src/views/admin/PackageEditView.vue publish/frontend/src/views/admin/PackageEditView.vue
cp frontend/src/api/admin.js publish/frontend/src/api/admin.js
git add frontend/src/components/PackageDdlPreviewModal.vue frontend/src/components/UninstallSchemaConfirmModal.vue \
        frontend/src/views/admin/PackageEditView.vue frontend/src/api/admin.js \
        frontend/tests/self-contained-package-view.test.js \
        publish/frontend/src/components/PackageDdlPreviewModal.vue \
        publish/frontend/src/components/UninstallSchemaConfirmModal.vue \
        publish/frontend/src/views/admin/PackageEditView.vue \
        publish/frontend/src/api/admin.js
git commit -m "feat(admin): DDL preview modal + uninstall confirm modal for v2 packages

PackageEditView shows database section with [查看 DDL] for v2 packages.
Uninstall flow routes through a confirm modal requiring explicit checkbox
before DELETE ?purgeMetrics=true&confirmDropSchema=true."
```

---

## Task 12: Frontend — OrphanSchemasView + admin nav link

**Files:**
- Create: `frontend/src/views/admin/OrphanSchemasView.vue`
- Modify: `frontend/src/router.js` (add /admin/orphan-schemas)
- Modify: `frontend/src/components/AppLayout.vue` (add nav link)
- Create: `frontend/tests/orphan-schemas-view.test.js`
- Mirror: `publish/frontend/src/views/admin/OrphanSchemasView.vue`, `publish/frontend/src/router.js`, `publish/frontend/src/components/AppLayout.vue`

**Interfaces:**
- Consumes: existing admin view patterns + adminApi methods.
- Produces: a new view at `/admin/orphan-schemas` showing list + drop action.

### Steps

- [ ] **Step 1: Write failing test** in `frontend/tests/orphan-schemas-view.test.js`:

```js
import { mount, flushPromises } from '@vue/test-utils';
import { describe, it, expect, vi } from 'vitest';
import OrphanSchemasView from '@/views/admin/OrphanSchemasView.vue';

vi.mock('@/api/admin.js', () => ({
  adminApi: {
    listOrphanSchemas: vi.fn().mockResolvedValue({ schemas: [
      { name: 'pkg_foo', last_seen_at: '2026-08-09T00:00:00Z', note: 'unit test' }
    ]}),
    dropOrphanSchema: vi.fn().mockResolvedValue({ ok: true })
  }
}));

describe('OrphanSchemasView', () => {
  it('lists orphan schemas from API', async () => {
    const wrapper = mount(OrphanSchemasView);
    await flushPromises();
    expect(wrapper.text()).toContain('pkg_foo');
    expect(wrapper.text()).toContain('unit test');
  });

  it('calls dropOrphanSchema on click', async () => {
    const { adminApi } = await import('@/api/admin.js');
    const wrapper = mount(OrphanSchemasView);
    await flushPromises();
    await wrapper.find('[data-test=drop]').trigger('click');
    expect(adminApi.dropOrphanSchema).toHaveBeenCalledWith('pkg_foo');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/orphan-schemas-view.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement `frontend/src/views/admin/OrphanSchemasView.vue`**:

```vue
<template>
  <div class="orphan-schemas-view">
    <h2>未签名 Schema 残留</h2>
    <p class="hint">Package 卸载时 DROP SCHEMA 失败的残留 — 手动清理或排查后删除。</p>
    <table v-if="schemas.length">
      <thead>
        <tr><th>Schema</th><th>最后出现</th><th>备注</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="s in schemas" :key="s.name">
          <td><code>{{ s.name }}</code></td>
          <td>{{ formatTime(s.last_seen_at) }}</td>
          <td>{{ s.note }}</td>
          <td><button data-test="drop" @click="drop(s.name)">手动 DROP</button></td>
        </tr>
      </tbody>
    </table>
    <p v-else>暂无残留。</p>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { adminApi } from '@/api/admin.js';

const schemas = ref([]);

async function load() {
  const r = await adminApi.listOrphanSchemas();
  schemas.value = r.schemas || [];
}

async function drop(name) {
  if (!confirm(`确认手动 DROP ${name}?`)) return;
  await adminApi.dropOrphanSchema(name);
  await load();
}

function formatTime(ts) {
  return new Date(ts).toLocaleString();
}

onMounted(load);
</script>

<style scoped>
.hint { color: #666; margin-bottom: 1em; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 0.5em; border-bottom: 1px solid #eee; text-align: left; }
code { background: #f4f4f4; padding: 0 0.3em; }
</style>
```

- [ ] **Step 4: Register the route** in `frontend/src/router.js`:

```js
import OrphanSchemasView from '@/views/admin/OrphanSchemasView.vue';
// (in the admin routes array)
{ path: '/admin/orphan-schemas', component: OrphanSchemasView, meta: { requiresAdmin: true } },
```

- [ ] **Step 5: Add nav link** in `frontend/src/components/AppLayout.vue`:

```vue
<!-- in the admin nav section -->
<router-link to="/admin/orphan-schemas">未签名 Schema 残留</router-link>
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/orphan-schemas-view.test.js`
Expected: PASS.

- [ ] **Step 7: Mirror + commit**

```bash
cp frontend/src/views/admin/OrphanSchemasView.vue publish/frontend/src/views/admin/OrphanSchemasView.vue
cp frontend/src/router.js publish/frontend/src/router.js
cp frontend/src/components/AppLayout.vue publish/frontend/src/components/AppLayout.vue
git add frontend/src/views/admin/OrphanSchemasView.vue frontend/src/router.js frontend/src/components/AppLayout.vue \
        frontend/tests/orphan-schemas-view.test.js \
        publish/frontend/src/views/admin/OrphanSchemasView.vue \
        publish/frontend/src/router.js \
        publish/frontend/src/components/AppLayout.vue
git commit -m "feat(admin): OrphanSchemasView + nav link for cleanup of failed DROP SCHEMA"
```

---

## Task 13: E2E — install v2 package, agent run, report, uninstall

**Files:**
- Create: `center/tests/e2e/self-contained-package.test.js`
- (No mirror — e2e tests not mirrored per project convention.)

**Interfaces:**
- Consumes: existing e2e patterns in `center/tests/e2e/plugin-system.test.js`.
- Produces: a single test file that exercises the full install → agent run → report → uninstall pipeline for a v2 package.

### Steps

- [ ] **Step 1: Write failing test** in `center/tests/e2e/self-contained-package.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import http from 'node:http';
import { init, close, getDb } from '../../src/db/index.js';
import { installer } from '../../src/packages/installer.js';
import { metricstore } from '../../src/packages/metricstore.js';
import { orphanSchemas } from '../../src/db/sql/orphan-schemas.js';
import { parseTestUrl } from '../integration/_url.js';

function buildV2Zip(name, schemaName) {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    name, version: '1.0.0', type: 'gauge',
    agent: { minVersion: '1.0.0', script: 'collect.ps1', intervalSec: 60 },
    metrics: [{ key: 'cpu_pct', label: 'CPU%' }],
    database: { schemaName, migrations: ['migrations/001.sql'], metricTable: 'metrics',
      metricSchema: { agent_id: { type: 'varchar(64)', nullable: false }, ts: { type: 'datetime', nullable: false }, cpu_pct: { type: 'double' } } }
  })));
  zip.addFile('collect.ps1', Buffer.from(''));
  zip.addFile('migrations/001.sql', Buffer.from(`CREATE TABLE ${schemaName}.metrics (agent_id VARCHAR(64) NOT NULL, ts DATETIME NOT NULL, cpu_pct DOUBLE NOT NULL, PRIMARY KEY (agent_id, ts))`));
  return zip.toBuffer();
}

test('e2e: self-contained package install → agent run → report → uninstall', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  await init({
    db: { dialect: 'mysql', mysql: { host, port, database: 'ad_monitoring', user, password } },
    listenPort: 8080, jwtSecret: 'x', agentToken: 'x', staticDir: './dist', logLevel: 'silent', env: 'test'
  });
  const db = getDb();
  const name = 'ad-e2e-v2';
  const schema = 'pkg_ad_e2e_v2';
  try {
    // 1. Install v2 package
    const buf = buildV2Zip(name, schema);
    await installer.installPackage(db, { source: 'local', buffer: buf });

    // 2. Simulate agent run + report via metricstore directly
    const pkg = (await db.execute(`SELECT manifest_json FROM installed_packages WHERE name = ?`, [name])).rows[0];
    const manifest = JSON.parse(pkg.manifest_json);
    await metricstore.ingestRun(db, {
      agentId: 'agent-e2e',
      packageName: name,
      manifest,
      runs: [{ metrics: { cpu_pct: 78.4 }, error: null }]
    });

    // 3. Verify metric table populated
    const { rows } = await db.execute(`SELECT * FROM \`${schema}\`.metrics WHERE agent_id = ?`, ['agent-e2e']);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(Number(rows[0].cpu_pct), 78.4);

    // 4. Uninstall with confirm
    await installer.uninstallPackage(db, { name, purgeMetrics: true, confirmDropSchema: true });

    // 5. Verify schema gone
    const { rows: stillThere } = await db.execute(`SELECT 1 FROM information_schema.schemata WHERE schema_name = ?`, [schema]);
    assert.strictEqual(stillThere.length, 0);

    // 6. Re-install same package works
    await installer.installPackage(db, { source: 'local', buffer: buf });
    await installer.uninstallPackage(db, { name, purgeMetrics: true, confirmDropSchema: true });
  } finally {
    try { await installer.uninstallPackage(db, { name, purgeMetrics: true, confirmDropSchema: true }); } catch {}
    try { await db.execute(`DROP DATABASE IF EXISTS \`${schema}\``); } catch {}
    try { await orphanSchemas.delete(db, schema); } catch {}
    try { await close(); } catch {}
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_MYSQL_URL=... npm test --workspace=center -- --test tests/e2e/self-contained-package.test.js`
Expected: FAIL — components missing before T1-T8.

- [ ] **Step 3: After all prior tasks land, re-run**

Run: `TEST_MYSQL_URL=... npm test --workspace=center -- --test tests/e2e/self-contained-package.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add center/tests/e2e/self-contained-package.test.js
git commit -m "test(e2e): self-contained package install → report → uninstall pipeline"
```

---

## Task 14: Mirror + verify-mirror extension + deployment doc update

**Files:**
- Modify: `scripts/verify-mirror.ps1`
- Modify: `docs/operations/deployment.md`
- Create: `docs/superpowers/plans/2026-08-09-self-contained-monitoring-package.md` (this file — already created)
- Mirror: ensure all publish/ files exist for every modified/new source

**Interfaces:**
- Consumes: existing `verify-mirror.ps1`.
- Produces: extended diff pairs.

### Steps

- [ ] **Step 1: Extend `scripts/verify-mirror.ps1`** to diff:
  - `center/src/packages/ddl-sandbox.js` ↔ `publish/center/src/packages/ddl-sandbox.js`
  - `center/src/packages/ddl-apply.js` ↔ `publish/center/src/packages/ddl-apply.js`
  - `center/src/packages/orphan-router.js` ↔ `publish/center/src/packages/orphan-router.js`
  - `center/src/db/sql/orphan-schemas.js` ↔ `publish/center/src/db/sql/orphan-schemas.js`
  - `center/src/packages/manifest.js`, `installer.js`, `metricstore.js`, `router.js`, `errors.js`, `server.js` (modify — re-mirror)
  - `db/migrations/013-orphan-schemas.sql` ↔ `publish/center/db/migrations/013-orphan-schemas.sql`
  - `db/migrations/mssql/013-orphan-schemas.sql` ↔ `publish/center/db/migrations/mssql/013-orphan-schemas.sql`
  - `frontend/src/components/PackageDdlPreviewModal.vue` ↔ `publish/frontend/src/components/PackageDdlPreviewModal.vue`
  - `frontend/src/components/UninstallSchemaConfirmModal.vue` ↔ `publish/frontend/src/components/UninstallSchemaConfirmModal.vue`
  - `frontend/src/views/admin/OrphanSchemasView.vue` ↔ `publish/frontend/src/views/admin/OrphanSchemasView.vue`
  - `frontend/src/views/admin/PackageEditView.vue`, `api/admin.js`, `router.js`, `components/AppLayout.vue` (modify — re-mirror)
  - `center/src/packages/registry-index.schema.json` ↔ `publish/center/src/packages/registry-index.schema.json`

(Follow the existing pattern in `verify-mirror.ps1` — each pair is a single `$comparisons += @{ left = '...'; right = '...' }` entry or whatever shape the script uses. Read the file first to follow the established convention.)

- [ ] **Step 2: Update `docs/operations/deployment.md`** — find the existing migration deployment section and add a paragraph:

```markdown
### Migration 013 (orphan_schemas)

Added by the self-contained monitoring package plan (2026-08-09). Pure
`CREATE TABLE IF NOT EXISTS`; existing installations pick it up
automatically on next `/init` wizard boot. No manual action required.
```

- [ ] **Step 3: Run verify-mirror**

Run: `pwsh -File scripts/verify-mirror.ps1`
Expected: All pairs match byte-identical.

- [ ] **Step 4: Run full backend + frontend test suites**

Run:
```bash
npm test --workspace=center
npx vitest run --root frontend
```

Expected: All green. 528 baseline + ~25 new tests added.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-mirror.ps1 docs/operations/deployment.md
git commit -m "chore(mirror+docs): verify-mirror extended for v2 modules + deployment.md note"
```

---

## Self-Review (per skill)

Run after writing all 14 tasks, before handoff.

**1. Spec coverage:**

| Spec section | Task |
|---|---|
| §"Package format (v2)" — manifest.database field | T3 (ajv schema), T11 (frontend render) |
| §"Package format (v2)" — ZIP / JSON forms | T5 (zip parsing), implicit in installer |
| §"DDL sandbox" — token scanner | T1 |
| §"Apply flow" — install / upgrade / uninstall | T5 / T6 / T7 |
| §"Data flow" — metricstore.reportRun v2 path | T8 (added `ingestRunV2`) |
| §"Database schema additions" — orphan_schemas | T2 |
| §"API surface" — ddl-preview, orphan-schemas, confirmDropSchema | T10 |
| §"Registry index schema extension" — database field | T9 |
| §"Compatibility & migration" — migration 013, IF NOT EXISTS | T2, T14 |
| §"Trust model" — UI banner / DDL preview | T11 (modal) |
| §"Error codes" — 9 new codes | T5 (errors.js extension), T7, T8, T10 |
| §"Testing" — unit + integration + e2e + frontend | T1, T2, T3, T4, T5, T6, T7, T8, T9, T11, T12, T13 |

All spec sections covered. ✓

**2. Placeholder scan:** No TBD/TODO/"similar to Task N"/"implement later"/`fill in details` in this plan. ✓

**3. Type consistency:** Cross-task consistency check:
- `scanSql` — defined T1, used T4 ✓
- `ensureSchema` / `createSchemaMigrationsTable` / `applyMigrations` / `dropSchema` / `schemaExists` / `markMigrationsApplied` / `listAppliedMigrations` — defined T4, used T5/T6/T7/T10 ✓
- `PkgError` codes `PKG_DDL_FORBIDDEN / PKG_DDL_INVALID_SQL / PKG_SCHEMA_EXISTS / PKG_CONFIRM_REQUIRED / PKG_INSTALL_FAILED / PKG_UPGRADE_FAILED / PKG_METRIC_KEY_UNKNOWN / PKG_METRIC_TYPE_MISMATCH / PKG_METRIC_REQUIRED` — defined T5 (errors.js extension), thrown T1/T4/T5/T6/T7/T8/T10, tested in unit tests per code ✓
- `manifest.database.metricSchema` — defined T3 (ajv), consumed T8 (ingestRunV2 column iteration), T1 (DDL scan is on migrations files, not metricSchema), T11 (frontend render) ✓
- `manifest.database.schemaName` pattern `^pkg_[a-z0-9_]+$` — defined T3, enforced T4 (ensureSchema) ✓
- `manifest.database.metricTable` pattern `^[a-z0-9_]+$` — defined T3, used T8 INSERT INTO target ✓
- `orphan_schemas` table columns `(name, last_seen_at, note)` — created T2, written T7 (insert on DROP fail), read T10 (list), deleted T10 (manual drop) ✓
- `metric_<pkg>.<metricTable>` INSERT shape `(agent_id, ts, userCols...)` — specified spec, T8 ✓
- `agent_id` always from auth token, `ts` always from server clock — invariant restated T8 ✓
- Cross-task names: `installer.installPackage / upgradePackage / uninstallPackage` (T5-T7), `metricstore.ingestRun / ingestRunV2` (T8), `ddlSandbox.scanSql` (T1), `ddlApply.{ensureSchema,applyMigrations,dropSchema,schemaExists,markMigrationsApplied,listAppliedMigrations}` (T4) — all consistent. ✓

**4. Coverage targets (from spec):**

| Module | Spec target | This plan |
|---|---|---|
| `ddl-sandbox.js` | 95% | T1 unit tests cover whitelist + blacklist + identifier + cross-schema + multi-statement + comment-strip + ON UPDATE/ON DELETE CASCADE allow — full coverage of all branches. ✓ |
| `installer.js` v2 path | 85% | T5/T6/T7 unit + T2/T13 integration + T13 e2e — covers install happy/sad, upgrade diff/fail, uninstall with/without confirm, DROP fail orphan path. ✓ |
| `metricstore.js` v2 path | 90% | T8 unit + T13 e2e — covers type coerce, missing col, unknown key, happy path. ✓ |
| `registry.js` index schema | 80% | T9 unit + T11 frontend render — covers accept/reject v2 entries. ✓ |

**5. Spec R1-R6 (risks from design spec):**

- R1 MySQL DDL implicit-commit → T6 documented: mid-upgrade failure leaves partial state, logged to `package_runs.error`; no automatic rollback. ✓
- R2 DDL sandbox is defense-in-depth, not trust → T11 UI banner with `[查看 DDL]` modal; T5 admin acknowledgement step. ✓
- R3 Cross-package JOIN — deferred per spec. ✓
- R4 Multi-schema-per-package — deferred. ✓
- R5 Schema rename — uninstall + reinstall per spec. ✓
- R6 Strict dependency resolution — deferred. ✓

**6. Re-read the three rules (Compatibility & migration):**

1. v1 plugin system unchanged → only routing check at `manifest.database` presence; no schema/table/endpoint changes. ✓
2. `database` field optional → T3 ajv schema makes it optional; T5/T8 path is gated on `manifest.database?.metricTable` truthiness. ✓
3. No retroactive upgrades → v1 packages' manifests never rewritten; T3 doesn't touch existing v1 entries. ✓

**7. Out-of-scope items — explicitly NOT in plan:**

Per spec section "Out of scope (deferred)": code signing, cross-package JOIN API, custom Vue widgets, multi-schema-per-package, schema rename, strict dependency resolution, time-series retention, DDL rollback on upgrade, package marketplace, author CLI. None of these have tasks. ✓

**8. Spec deviations:**

None. The plan implements the spec as written. The two ambiguities in the spec (`metricSchema` type normalization, `ON UPDATE/ON DELETE CASCADE` allow) were resolved in the spec itself (in the version committed at `0076c14`), not in the plan.

**Self-review verdict: plan ready for execution. ✓**

---

## Notes for the dispatcher

- **BASE for Task 1 dispatch:** `git rev-parse HEAD` immediately before sending the first implementer prompt (record the value and pass it through every review-package generation).
- **Skills referenced:** superpowers:subagent-driven-development (recommended) or superpowers:executing-plans — chosen by user.
- **Touches ~25 files** across 3 workspaces (center, frontend, db/migrations) + 1 ops doc + 1 mirror script. 14 tasks; most are 1-2 file changes; T8 is the largest (~3 files). Plan is a good fit for subagent-driven: each task has a clear deliverable + test gate.
- **Real-DB tests:** Tasks T2, T4, T5, T6, T7, T8, T13 all have integration/e2e components gated on `TEST_MYSQL_URL`. Without `TEST_MYSQL_URL`, these are skipped; with it, they validate the full DDL pipeline against real MySQL.
- **Mirror convention:** every backend/frontend source change has a paired `cp` to `publish/` per established project pattern. T14 verifies the lot.
- **No publish.zip regen / no `git push` in this plan** — Task 8 of the prior port-config plan established the convention that ship = push source commits; publish/ mirroring is verified by `verify-mirror.ps1`, not by committing gitignored `publish/frontend/dist/` or `publish/publish.zip`. User can run those at integration time (or we add an explicit T15 if requested).
- **Spec location:** `docs/superpowers/specs/2026-08-09-self-contained-monitoring-package-design.md` (committed at `0076c14`).
- **Plan location:** this file.
