# Self-Contained Monitoring Package — Design Spec (Plugin System v2)

**Date**: 2026-08-09
**Status**: Draft (pending user approval of written spec)
**Scope**: plugin system v1 → v2 — extend with self-contained packages (manifest + script + DDL)
**Supersedes**: nothing — additive on top of `2026-07-29-plugin-system-design.md`

## Goal

Extend the v1 plugin system so admins can author **self-contained monitoring packages** that ship their own database schema, table layout, and migration history. Packages = manifest + PowerShell script + SQL DDL files; install applies DDL atomically, uninstall drops the schema, and PS1 data flows into the package's own tables under `pkg_<name>.<table>`. v1 packages (fixed `metric_gauge/counter/timeseries/status` tables) keep working unchanged.

## Motivation (why v1 is not enough)

The v1 plugin system has a fixed schema (4 metric tables) that all packages share. A package can only **declare which keys it writes** via `manifest.metrics[]`; it cannot add columns, create its own tables, or evolve its data model across versions. This blocks the most useful monitoring packages — those whose value comes from a domain-specific shape (CPU/Memory/GPO correlation, replication lag by site, dcdiag topology, etc.). Admins authoring these today must hand-edit `db/migrations/` and ship a hard-fork of center, which breaks the upgrade story.

v2 adds the missing piece: a **per-package schema-per-DB** that the package owns end-to-end. The package zip carries the DDL; install applies it under a sandbox; uninstall cleans it up. The package's PS1 still speaks the same stdout-JSON contract it always did — only the **destination table** changes.

## Scope

**In scope (additive)**:
1. `manifest.database` field — declares schema name + migrations list + metric table + per-column SQL types.
2. ZIP / JSON package forms extended to carry `migrations/*.sql`.
3. DDL sandbox: pure-JS token scanner with strict whitelist + cross-schema/cross-package ban + multi-statement ban.
4. Apply flow: install / upgrade / uninstall orchestrate DDL with **best-effort rollback**; failures leave center state as if the operation never happened.
5. Data flow: `metricstore.reportRun` routes to `pkg_<name>.<metricTable>` for v2 packages; v1 packages keep the existing 4-table path.
6. Registry index schema gains `database` field.
7. Orphan-schema tracking table for failed uninstall drops.
8. Admin UI: pre-install DDL preview, explicit purge-confirmation for `DROP SCHEMA`.
9. Tests: unit (sandbox) + integration (real MySQL + MSSQL) + e2e + frontend.

**Out of scope (deferred)**:
- Code signing / Ed25519 (deferred since v1, still deferred).
- Cross-package JOIN — packages can read across schemas by fully-qualified name only if admin grants SELECT permission separately; not exposed in API surface.
- Custom Vue widgets loading from `widget.vue` (v1 deferred, still deferred).
- Multi-schema-per-package (one package = one schema).
- Schema rename (DROP old + CREATE new requires uninstall + reinstall).
- Strict dependency resolution (v1 deferred, still deferred).
- Time-series retention (v1 deferred, still deferred).
- DDL rollback on upgrade (MySQL DDL implicit-commits; upgrade DDL failure leaves partial state, recorded to `package_runs.error`).
- Package marketplace / author CLI (v1 deferred, still deferred).

## Architecture

```
                     ┌──────────────────┐
                     │  Package ZIP     │
                     │  manifest.json   │
                     │  collect.ps1     │
                     │  migrations/     │
                     │  ├ 001.sql       │
                     │  └ 002.sql       │
                     └────────┬─────────┘
                              │ upload / pull from registry
                              ▼
  ┌──────────────────────────────────────────────────────────┐
  │                       Center                              │
  │                                                           │
  │   installer.installPackage                                │
  │     1. validateManifest(manifest)         ← v1 unchanged   │
  │     2. ddlSandbox.scanAll(migrationFiles)  ← NEW         │
  │     3. CREATE SCHEMA pkg_<name>           ← NEW          │
  │     4. for each sqlFile:                                   │
  │          db.execute(sqlFile.content)     ← NEW          │
  │          INSERT INTO pkg_<name>.schema_migrations        │
  │     5. installedPackages.upsert(...)      ← v1 unchanged  │
  │     6. cache scripts → data/packages/<name>/<version>/   │
  │                                                           │
  │   metricstore.reportRun                                   │
  │     if pkg.manifest.database:                             │
  │         INSERT INTO pkg_<name>.<metricTable> (...)       │  ← NEW (v2 path)
  │     else:                                                 │
  │         legacyReport(...)                  ← v1 unchanged│
  │                                                           │
  │   uninstallPackage                                        │
  │     if purgeMetrics: DROP SCHEMA pkg_<name>  ← NEW       │
  │     else: leave schema, disable only       ← NEW         │
  └──────────────────────────────────────────────────────────┘
                              │
                  package_runs INSERT (both paths)
                              │
                              ▼
                     ┌──────────────────┐
                     │  metric_<pkg>    │
                     │  tables          │
                     └──────────────────┘
```

**Two paths, one runtime**: `manifest.database` presence is the routing flag. v1 packages never see the sandbox or new schema; v2 packages never touch `metric_gauge/counter/timeseries/status`.

## Package format (v2)

### ZIP layout (v2 packages)

```
ad-cpu-monitor-1.0.0.zip
├── manifest.json
├── collect.ps1
├── icon.svg                       ← optional
├── default-config.json            ← optional
├── widget.vue                     ← optional (v1 deferred; still not loaded)
└── migrations/                    ← NEW (only present on v2 packages)
    ├── 001_initial.sql
    └── 002_add_swap_pct.sql
```

### JSON form (v2)

```json
{
  "manifest": { ... },
  "scripts": { "collect": "<base64>" },
  "migrations": [
    "CREATE TABLE IF NOT EXISTS metrics (agent_id VARCHAR(64) NOT NULL, ts DATETIME NOT NULL, cpu_pct DOUBLE NOT NULL, PRIMARY KEY (agent_id, ts));",
    "ALTER TABLE metrics ADD COLUMN swap_pct DOUBLE NULL;"
  ]
}
```

`migrations` in JSON form is an array of SQL strings — order matters, applied top-to-bottom.

### Manifest — new field

```jsonc
{
  "name": "ad-cpu-monitor",                  // required (v1)
  "version": "1.0.0",                        // required (v1)
  "type": "gauge",                           // required (v1; still used for legacy routing hint)
  "description": "...",                      // optional (v1)
  "author": "team@corp.local",               // optional (v1)
  "license": "MIT",                          // optional (v1)
  "agent": {                                 // optional (v1)
    "minVersion": "1.1.0",
    "script": "collect.ps1",
    "intervalSec": 60,
    "timeoutMs": 30000
  },
  "metrics": [ /* ...v1 metrics[] (used for legacy path + UI hint) */ ],
  "params":   { /* ...v1 params (unchanged) */ },
  "widget":   { /* ...v1 widget (unchanged) */ },
  "dependencies": [ /* ...v1 (unchanged) */ ],

  "database": {                              // NEW — presence routes to v2 path
    "schemaName": "pkg_ad_cpu_monitor",      // pattern ^pkg_[a-z0-9_]+$; default = "pkg_<name>"
    "migrations": [                           // relative paths inside zip; in JSON form = SQL strings
      "migrations/001_initial.sql",
      "migrations/002_add_swap_pct.sql"
    ],
    "metricTable": "metrics",                // pattern ^[a-z0-9_]+$
    "metricSchema": {                        // MUST match the CREATE TABLE in 001.sql exactly
      "agent_id":   { "type": "varchar(64)", "nullable": false },
      "ts":         { "type": "datetime",    "nullable": false },
      "cpu_pct":    { "type": "double",      "nullable": false }
    }
  }
}
```

**Validation rules at install time**:
1. `database.schemaName` matches `^pkg_[a-z0-9_]+$` AND equals `"pkg_" + name.replace(/-/g, '_')` (default value; explicit override only allowed to match same pattern).
2. Every path in `database.migrations` resolves to a file inside the zip.
3. `database.metricTable` is created by at least one migration file (verified by scanning CREATE TABLE statements for that table name).
4. Columns in `database.metricSchema` exactly equal columns declared in the `metricTable` CREATE TABLE — types compared **case-insensitive and whitespace-insensitive** after normalizing both sides to a canonical form (lowercase + collapse internal whitespace). The canonical type vocabulary is: `int`, `integer`, `bigint`, `smallint`, `tinyint`, `varchar(n)`, `char(n)`, `text`, `nvarchar(n)`, `ntext`, `double`, `float`, `decimal(p,s)`, `numeric(p,s)`, `datetime`, `timestamp`, `datetimeoffset`, `date`, `json`, `boolean`, `bit`. `agent_id` and `ts` must exist in `metricSchema` with `nullable: false`. Other columns may set `nullable: true`; if omitted, `nullable` defaults to `true`.
5. ajv still rejects unknown top-level fields (`additionalProperties: false`) — extend schema.

## DDL sandbox

### Token scanner (`center/src/packages/ddl-sandbox.js`)

```js
const ALLOWED_KEYWORDS = new Set([
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

const BLOCKED_PATTERNS = [
  /;\s*\S/,                                      // multi-statement — checked first so blocked string is `;`
  /\bDROP\b/i,                  // no DROP at all — uninstall + purgeMetrics does that explicitly
  /\b(TRUNCATE|RENAME|GRANT|REVOKE|EXEC|EXECUTE|CALL)\b/i,
  /\bINSERT\s+INTO\b/i,                           // DML (specific — does not match ON UPDATE / ON DELETE)
  /\bUPDATE\s+(?!CASCADE\b)[a-z_]/i,              // DML — followed by identifier; ON UPDATE CASCADE passes (negative lookahead on the identifier character class)
  /\bDELETE\s+FROM\b/i,                           // DML — followed by FROM; ON DELETE CASCADE passes
  /\b(MERGE|SELECT)\b/i,
  /\bpkg_[a-z0-9_]+\.[a-z0-9_]+/i,               // cross-package reference (other pkg_)
  /\b(main|installed_packages|metric_gauge|metric_counter|metric_timeseries|metric_status|package_runs|orphan_schemas|system_config|audit_logs|schema_migrations)\b/i,
];

export function scanSql(sql) {
  if (typeof sql !== 'string') return { ok: false, blocked: 'non-string input' };
  // 1. strip /* ... */ block comments and -- line comments
  const stripped = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
  // 2. reject if any BLOCKED_PATTERNS match — order matters: multi-statement
  //    (`; <non-ws>`) is checked FIRST so the `blocked` string reflects the
  //    most-specific cause (the test asserts `assert.match(r.blocked, /;/)` for
  //    `CREATE TABLE foo (id INT); DROP TABLE bar`).
  for (const re of BLOCKED_PATTERNS) {
    if (re.test(stripped)) return { ok: false, blocked: re.source };
  }
  // 3. tokenize on whitespace + `(),;`. Identifier policy:
  //    a. Numeric literal `^-?\d+(\.\d+)?$` → allowed.
  //    b. String literal `^'[^']*'$` → allowed.
  //    c. Identifier `/^[a-z_][a-z0-9_]*$/i` → allowed freely (table/column/
  //       index names are user-chosen and not on any list). The DDL-keyword
  //       safety is enforced by ALLOWED_KEYWORDS for known DDL tokens that
  //       appear in the schema, not for arbitrary identifiers.
  //    d. Defense-in-depth heuristic: an identifier that is entirely
  //       UPPERCASE letters/underscores (looks like a SQL keyword, not a
  //       typical lowercase table name) and is NOT in ALLOWED_KEYWORDS is
  //       rejected. This catches typos like `DROPPED` (a table named
  //       DROPPED that slipped past `\bDROP\b` because of the boundary),
  //       `WHEREEVER`, etc. A package author wanting to use an uppercase
  //       table name like `METRICS` would be rejected by this heuristic —
  //       this is a deliberate trade-off documented in the unit tests and
  //       in the BLOCKED_PATTERNS test coverage.
  //    e. Any token not matching (a), (b), or (c) → unparseable, reject.
  const tokens = stripped.split(/[\s(),;]+/).filter(Boolean);
  for (const t of tokens) {
    if (/^-?\d+(\.\d+)?$/.test(t)) continue;       // numeric literal
    if (/^'[^']*'$/.test(t)) continue;             // string literal
    if (/^[a-z_][a-z0-9_]*$/i.test(t)) {
      if (/^[A-Z_]+$/.test(t) && !ALLOWED_KEYWORDS.has(t.toUpperCase())) {
        return { ok: false, blocked: `unknown identifier: ${t}` };
      }
      continue;
    }
    return { ok: false, blocked: `unparseable token: ${t}` };
  }
  return { ok: true };
}
```

**Sandbox output**: `{ok: true}` or `{ok: false, blocked: '<pattern or token>'}`. Installer surfaces this as `PkgError('PKG_DDL_FORBIDDEN', blocked, 400)`.

**FK ON UPDATE / ON DELETE allowance**: `ON UPDATE CASCADE` and `ON DELETE CASCADE` are FK referential actions, not DML. They are intentionally allowed. The `BLOCKED_PATTERNS` use anchored DML forms (`UPDATE <identifier>`, `DELETE FROM`) so these FK clauses pass through. The `UPDATE` pattern uses a negative lookahead `(?!\bCASCADE\b)` so `UPDATE C` inside `ON UPDATE CASCADE` does not match the `[a-z_]` identifier character class. This is enforced by the unit test `ddl-sandbox.test.js > "ON UPDATE / ON DELETE CASCADE pass"` — if a future refactor breaks this, the test catches it.

**Identifier policy**: Arbitrary table / column / index names are allowed by the scanner (they are user-chosen, not on any list). The DDL-keyword safety boundary is the `ALLOWED_KEYWORDS` Set (must contain every reserved word used in a DDL statement) and the `BLOCKED_PATTERNS` array (must catch every dangerous pattern). A defense-in-depth heuristic rejects identifiers that are entirely UPPERCASE and not in `ALLOWED_KEYWORDS` — this catches typos like `DROPPED` (a table named DROPPED that the `\bDROP\b` pattern misses because of the word boundary on the trailing `D`) and `WHEREEVER` (a misspelling of WHERE). The trade-off: package authors who want uppercase table names like `METRICS` are rejected. Documented and tested.

### Schema-name authority

`pkg_<name>` is the canonical namespace. Naming is fixed by `manifest.name` to prevent squatting — `name = ad-cpu-monitor` ⇒ `schemaName = pkg_ad_cpu_monitor`. Manifest may omit `database.schemaName`; installer defaults it. Explicit override must match `pkg_<name-with-dashes-as-underscores>` exactly.

## Apply flow

### installPackage (extended)

```
1. validateManifest(manifest)            ← v1
2. parseBuffer(zip) → {manifest, scripts, migrationFiles}
3. if manifest.database:
     for each sqlFile in migrationFiles:
       scanSql(sqlFile.content)          ← throws PKG_DDL_FORBIDDEN on first fail
     schemaName = manifest.database.schemaName || 'pkg_' + name.replace(/-/g, '_')
     check !installedPackages.get(db, name)         ← PKG_NAME_CONFLICT
     check !schemaExists(db, schemaName)            ← PKG_SCHEMA_EXISTS (409)
     db.execute("CREATE SCHEMA <schemaName>")      ← dialect-specific:
                                                     MySQL: CREATE DATABASE IF NOT EXISTS ...
                                                     MSSQL: CREATE SCHEMA <name>
     try:
       for each (sqlFile, i):
         try:
           db.execute(sqlFile.content)
         catch (e):
           bestEffortDrop(db, schemaName)
           throw PkgError('PKG_INSTALL_FAILED', e.message, 500)
         db.execute("INSERT INTO <schemaName>.schema_migrations (version, filename, applied_at) VALUES (?, ?, ?)",
                    [manifest.version, sqlFile.filename, new Date()])
     installedPackages.upsert(...)       ← v1
     cache scripts + manifest to disk    ← v1
4. else:
     // v1 path — unchanged
     installedPackages.upsert(...)
     cache scripts
```

`schema_migrations` (per-package table inside `pkg_<name>`):

```sql
CREATE TABLE schema_migrations (
  filename    VARCHAR(255) NOT NULL PRIMARY KEY,
  version     VARCHAR(32)  NOT NULL,        -- manifest version at apply time
  applied_at  DATETIME     NOT NULL
);
```

This table is created by the installer **before** applying user migrations, not by the user's first migration file. The installer's pre-step is:

```sql
MySQL:  CREATE TABLE IF NOT EXISTS <schemaName>.schema_migrations (...);
MSSQL:  IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'schema_migrations' AND schema_id = SCHEMA_ID(<schemaName>))
        CREATE TABLE <schemaName>.schema_migrations (...);
```

### upgradePackage (extended)

```
existing = installedPackages.get(db, name)
if !existing → PKG_NOT_FOUND
newManifest = parseBuffer(newZip).manifest
validateManifest(newManifest)
if existing.manifest.database exists AND newManifest.database exists:
  schemaName = newManifest.database.schemaName || existing.manifest.database.schemaName
  appliedFiles = db.query("SELECT filename FROM <schemaName>.schema_migrations")
  newFiles = newManifest.database.migrations
  toApply = newFiles.filter(f => !appliedFiles.map(r => r.filename).includes(f))
  for each sqlFile in toApply:
    scanSql(sqlFile.content)
    try db.execute(sqlFile.content)
    catch:
      // best-effort: log to package_runs; do NOT touch already-applied files
      throw PkgError('PKG_UPGRADE_FAILED', e.message, 500)
    db.execute("INSERT INTO <schemaName>.schema_migrations ...", [newManifest.version, sqlFile.filename, new Date()])
// type-change guard (existing v1 behavior):
if (existing.type !== newManifest.type) → PKG_VALIDATION_FAILED
installedPackages.upsert(name, newManifest, enabled=false)
```

**MySQL DDL implicit-commit caveat**: a partial upgrade leaves the schema mid-state (some new columns added, others not). This is logged to `package_runs.error` with the failing filename. There is **no automatic rollback** — admin must either fix forward (re-upload corrected migration) or uninstall + reinstall.

### uninstallPackage (extended)

```
existing = installedPackages.get(db, name)
if !existing → PKG_NOT_FOUND
if existing.manifest.database AND purgeMetrics:
  if !confirmDropSchema:
    throw PkgError('PKG_CONFIRM_REQUIRED', 'set confirmDropSchema=true to drop pkg_<name>', 400)
  try db.execute("DROP SCHEMA <schemaName>")   // MySQL: DROP DATABASE; MSSQL: DROP SCHEMA
  catch (e):
    db.execute("INSERT INTO orphan_schemas (name, last_seen_at, note) VALUES (?, ?, ?)",
               [schemaName, new Date(), e.message])
    // continue — don't block uninstall
installedPackages.delete(db, name)
if purgeMetrics:
  delete package_runs rows for name   ← v1
// else (v1 purgeMetrics only — no schema): do not touch metric_* or package_runs
remove cache directory   ← v1
```

`orphan_schemas` (new center table; added by a new migration `00X-orphan-schemas.sql` shipped alongside this plan):

```sql
CREATE TABLE orphan_schemas (
  name          VARCHAR(128) NOT NULL PRIMARY KEY,
  last_seen_at  DATETIME     NOT NULL,
  note          VARCHAR(512) NULL
);
```

This table is **not** inside any `pkg_*` schema — it lives in the center's main schema. Listed by admin UI; admin can drop manually.

## Data flow — `metricstore.reportRun` (extended)

```js
// center/src/packages/metricstore.js
export async function reportRun(db, { agentId, runs }) {
  const out = [];
  // group runs by package name (a single POST can carry multiple packages)
  const byPkg = groupBy(runs, 'packageName');

  for (const [pkgName, pkgRuns] of Object.entries(byPkg)) {
    const pkg = await installedPackages.get(db, pkgName);
    if (!pkg) {
      out.push({ packageName: pkgName, error: 'PKG_NOT_FOUND' });
      continue;
    }

    if (pkg.manifest.database?.metricTable) {
      // ──── v2 path ────
      const schemaName = pkg.manifest.database.schemaName;
      const table = pkg.manifest.database.metricTable;
      const columns = Object.keys(pkg.manifest.database.metricSchema);
      const userCols = columns.filter(c => c !== 'agent_id' && c !== 'ts');
      const tsCol = pkg.manifest.database.metricSchema.ts;       // default 'datetime'
      const ts = new Date();

      for (const run of pkgRuns) {
        if (run.error) {
          await packageRuns.record(db, { agentId, packageName: pkgName, run });
          continue;
        }
        // validate keys
        const metrics = run.metrics || {};
        const unknownKeys = Object.keys(metrics).filter(k => !columns.includes(k));
        if (unknownKeys.length) {
          out.push({ packageName: pkgName, error: 'PKG_METRIC_KEY_UNKNOWN', keys: unknownKeys });
          await packageRuns.record(db, { agentId, packageName: pkgName, run, error: 'unknown keys' });
          continue;
        }
        // type coerce check (string→DOUBLE → reject)
        for (const col of userCols) {
          const decl = pkg.manifest.database.metricSchema[col];
          const v = metrics[col];
          if (v == null) {
            if (!decl.nullable) { out.push({ packageName: pkgName, error: 'PKG_METRIC_REQUIRED', column: col }); continue; }
          } else if (decl.type.startsWith('double') || decl.type.startsWith('float') || decl.type.startsWith('decimal')) {
            if (typeof v !== 'number') { out.push({ packageName: pkgName, error: 'PKG_METRIC_TYPE_MISMATCH', column: col }); continue; }
          }
        }

        const values = userCols.map(c => metrics[c]);
        await db.execute(
          `INSERT INTO ${schemaName}.${table} (agent_id, ts, ${userCols.join(',')}) VALUES (?, ?, ${userCols.map(_ => '?').join(',')})`,
          [agentId, ts, ...values]
        );
        await packageRuns.record(db, { agentId, packageName: pkgName, run, status: 'recorded' });
        out.push({ packageName: pkgName, recorded: true, ts });
      }
    } else {
      // ──── v1 legacy path — unchanged ────
      await legacyReport(db, { agentId, pkg, runs: pkgRuns, out });
    }
  }
  return out;
}
```

**Invariants** (apply to both paths, restated for v2):

- `agent_id` always comes from the auth token (JWT for admin, agent token for agent) — never from PS1 stdout.
- `ts` always comes from `center` server clock — never from PS1 stdout.
- PS1 stdout JSON shape `{"metrics": {...}, "error": null}` is unchanged — only the destination table moves.
- `package_runs` is recorded for every run regardless of v1/v2 path.

## Database schema additions

### `orphan_schemas` (new, main schema)

```sql
CREATE TABLE orphan_schemas (
  name          VARCHAR(128) NOT NULL PRIMARY KEY,
  last_seen_at  DATETIME     NOT NULL,
  note          VARCHAR(512) NULL
);
```

New migration `db/migrations/00X-orphan-schemas.sql` (MySQL) and `db/migrations/mssql/00X-orphan-schemas.sql` (MSSQL), applied automatically by the init wizard and listed by `/admin/schema-migrations`.

### `pkg_<name>.schema_migrations` (per-package, created by installer)

Already specified above.

### Existing tables — unchanged

`installed_packages`, `metric_gauge/counter/timeseries/status`, `package_runs`, plus all 12 pre-package tables: no schema changes. `installed_packages.manifest_json` carries the new `database` field for v2 packages; v1 packages' manifest_json is unchanged.

## API surface

### Admin (`/api/admin/packages/*`)

| Method | Path | Change |
|--------|------|--------|
| POST | `/api/admin/packages/install` | Body gains optional `{confirmDropSchema?: true}`. If installing into a `pkg_<name>` that already exists, **install is rejected with PKG_SCHEMA_EXISTS (409)** — admin must uninstall + reinstall. |
| POST | `/api/admin/packages/:name/upgrade` | Same as install's confirm rule doesn't apply; upgrade is diff-based. |
| DELETE | `/api/admin/packages/:name?purgeMetrics=true&confirmDropSchema=true` | New required `confirmDropSchema=true` query param when the package is a v2 package; forces admin to acknowledge the `DROP SCHEMA`. |
| GET | `/api/admin/packages/:name/ddl-preview` | **NEW** — returns `{schemaName, files: [{filename, content}]}` for pre-install review (read-only). |

### Agent (`/api/agent/packages/*`)

Unchanged. Agent receives the full manifest (including `database` field) and the script. Agent has no awareness of DDL — it's a center-side concern.

### Metric query (`/api/dashboard/metrics/*`)

Unchanged for v1 packages. **NEW** for v2 packages:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/dashboard/metrics/pkg/:name/latest?metricId=<column>` | Latest row from `pkg_<name>.<metricTable>` filtered by metricId column. |
| GET | `/api/dashboard/metrics/pkg/:name/history?metricId=<column>&agentId=<>&from=<>&to=<>` | Time-range query. |
| GET | `/api/dashboard/metrics/pkg/:name/ddl-preview` | Mirror of admin's preview (used by PackageEditView to show DDL). |

### Orphan schema admin

| Method | Path | Purpose |
|--------|------|--------|
| GET | `/api/admin/orphan-schemas` | List rows. |
| DELETE | `/api/admin/orphan-schemas/:name` | Manually DROP SCHEMA + delete row. |

### Error codes (additions)

| Code | HTTP | Trigger |
|------|------|---------|
| `PKG_DDL_FORBIDDEN` | 400 | sandbox scanner rejected a SQL file |
| `PKG_DDL_INVALID_SQL` | 400 | scanner passed but driver rejected at execute |
| `PKG_SCHEMA_EXISTS` | 409 | `pkg_<name>` already exists on disk (leftover or admin re-install) |
| `PKG_CONFIRM_REQUIRED` | 400 | uninstall+purgeMetrics without `confirmDropSchema=true` |
| `PKG_INSTALL_FAILED` | 500 | mid-install apply failure; schema dropped best-effort |
| `PKG_UPGRADE_FAILED` | 500 | mid-upgrade apply failure; partial state logged |
| `PKG_METRIC_KEY_UNKNOWN` | 400 | PS1 stdout key not in `manifest.database.metricSchema` |
| `PKG_METRIC_TYPE_MISMATCH` | 400 | type coercion failed |
| `PKG_METRIC_REQUIRED` | 400 | nullable=false column missing from PS1 stdout |

Existing v1 error codes unchanged.

## Registry index schema extension

```jsonc
// registry-index.schema.json (additionalProperties:false)
{
  "$schema": "https://addashboard.local/schemas/registry-index-v1.json",
  "type": "object",
  "required": ["version", "packages"],
  "properties": {
    "version": { "type": "integer", "const": 1 },
    "updatedAt": { "type": "string", "format": "date-time" },
    "packages": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name", "latestVersion", "type"],
        "properties": {
          // ...existing fields (name, latestVersion, type, description, author, license, tags, icon, versions[])...
          "database": {
            "type": "object",
            "additionalProperties": false,
            "required": ["schemaName", "migrations", "metricTable"],
            "properties": {
              "schemaName":   { "type": "string", "pattern": "^pkg_[a-z0-9_]+$" },
              "migrations":   { "type": "array", minItems: 1, items: { "type": "string" } },
              "metricTable":  { "type": "string", "pattern": "^[a-z0-9_]+$" },
              "metricColumns":{ "type": "integer", "minimum": 3 }  // agent_id + ts + at least one user column
            }
          }
        }
      }
    }
  }
}
```

Existing v1 entries without `database` keep working — registry schema is additive.

## Compatibility & migration

### Three rules

1. **v1 plugin system unchanged.** `metric_gauge/counter/timeseries/status` schema, `metricstore.js` v1 path, `installer.installPackage` v1 path, all v1 tests, all v1 admin UI — no modifications except routing at the `manifest.database` presence check.
2. **`database` field is optional.** Absence → v1 path. Presence → v2 path. Both install/uninstall code paths coexist in the same modules.
3. **No retroactive upgrades.** v1 packages installed before this plan stay v1 forever; their manifests are not rewritten. v2 packages are opt-in per manifest.

### New center migration

`db/migrations/00X-orphan-schemas.sql` (MySQL) and `db/migrations/mssql/00X-orphan-schemas.sql` (MSSQL) — both pure `CREATE TABLE IF NOT EXISTS`, no stored procedures, no `DELIMITER`. Applied by the init wizard alongside existing migrations. Listed in `/admin/schema-migrations` view.

### Init wizard / existing installations

- New installations: `00X-orphan-schemas.sql` runs in the normal migration sequence.
- Existing installations: the migration is automatically picked up on next `/init` wizard boot (since `IF NOT EXISTS`).
- No breaking changes to any existing endpoint.

### Rollout

- Ship behind feature flag `system_config.self_contained_packages_enabled` (default 1).
- Registry index validation rejects v2 entries when flag is off.
- Agent side: zero changes — agent sees only `manifest + script` as before.

## Trust model

Inherited from v1 (`2026-07-29-plugin-system-design.md`):

- **HTTPS only** + sha256 verification on registry downloads.
- **No code signing.** Any package from the registry is trusted; admin is responsible for vetting.
- Admin UI surfaces a banner on v2 install: **"未签名包 — install 前请审查 manifest + migrations"**, with a `[查看 DDL]` button that fetches `/api/admin/packages/:name/ddl-preview`.

The DDL sandbox is **defense-in-depth** — it blocks the most common classes of accidental damage (DROP, GRANT, cross-schema) but does **not** substitute for trust. A malicious author who controls a package can still write a CREATE TABLE that fills the disk or uses every reserved word to break things. Trust assumption is unchanged.

## Testing

### Unit (`center/tests/packages/ddl-sandbox.test.js`)

- Whitelist token pass: CREATE TABLE, ALTER TABLE ADD COLUMN, CREATE INDEX, CREATE VIEW (with all listed types and clauses).
- Blacklist token fail: DROP TABLE, DROP COLUMN, TRUNCATE, GRANT, REVOKE, RENAME, INSERT, UPDATE, DELETE, MERGE, SELECT, EXEC, EXECUTE, CALL.
- Identifier fail: `INSERT` (uppercase), `DrOp` (mixed case).
- Cross-package reference fail: `pkg_other.metrics` literal.
- Cross-schema reference fail: `installed_packages`, `metric_gauge`, `package_runs`, `audit_logs`, `system_config`, `schema_migrations`, `orphan_schemas`, `main`.
- Multi-statement fail: `CREATE TABLE foo (id INT); DROP TABLE bar`.
- Comment stripping: `--` and `/* */` do not bypass scanner.
- Dialect-specific pass: `AUTO_INCREMENT`, `IDENTITY`, `NVARCHAR`, `DATETIMEOFFSET`, `COLLATE utf8mb4_unicode_ci`.
- DDL forbidden token regex false positive guard: `ON UPDATE CASCADE` and `ON DELETE CASCADE` (FK clauses) must pass — these contain `UPDATE`/`DELETE` but are FK actions, not DML. BLOCKED_PATTERNS uses anchored DML forms (`UPDATE <identifier>`, `DELETE FROM`) so FK clauses pass. Tested explicitly.

### Integration (`center/tests/packages/installer-v2.test.js`, gated on TEST_MYSQL_URL)

- install valid v2 package → `installed_packages` row + `pkg_<name>.schema_migrations` populated + `pkg_<name>.<metricTable>` exists.
- install v2 with malicious DDL → 400 PKG_DDL_FORBIDDEN, no schema created.
- install v2 with mid-failure (2nd migration file is `INVALID SQL`) → first file applied + second fails + installer catches + DROP pkg_<name> + installed_packages row absent.
- install v2 with `pkg_<name>` already on disk → 409 PKG_SCHEMA_EXISTS.
- upgrade 1.0.0 → 1.1.0 (one new migration) → only new file applied + schema_migrations shows both.
- upgrade with bad new migration → first new file applied + second fails + old version's schema_migrations preserved + installed_packages not updated.
- uninstall + `purgeMetrics=true&confirmDropSchema=true` → schema gone.
- uninstall + `purgeMetrics=true` without `confirmDropSchema` → 400 PKG_CONFIRM_REQUIRED.
- uninstall + `purgeMetrics=false` (v2 package) → schema preserved + installed_packages row removed + cache dir removed.
- uninstall + DROP fails → `orphan_schemas` row inserted + installed_packages still removed.
- v1 package install (no `database` field) → unchanged behavior, no schema created.

### E2E (`center/tests/e2e/self-contained-package.test.js`)

1. Build fixture `ad-cpu-monitor` 1.0.0 with manifest + `migrations/001_initial.sql` + `collect.ps1` that emits `{"metrics":{"cpu_pct":78.4}}`.
2. POST `/api/admin/packages/install` with base64 zip.
3. Boot mock agent that GETs `/api/agent/packages`, runs PS1, POSTs `/api/agent/packages/report`.
4. Verify `pkg_ad_cpu_monitor.metrics` has 1 row with `agent_id` from token, `ts` near now, `cpu_pct=78.4`.
5. Verify `package_runs` row recorded.
6. POST `/api/admin/packages/ad-cpu-monitor/disable`.
7. DELETE `/api/admin/packages/ad-cpu-monitor?purgeMetrics=true&confirmDropSchema=true`.
8. Verify `pkg_ad_cpu_monitor` schema gone (information_schema check).
9. Re-install same package → succeeds (no PKG_SCHEMA_EXISTS).

### Dual-dialect requirement

`TEST_MYSQL_URL` for MySQL; `TEST_MSSQL_URL` for MSSQL. The same integration tests run on both. Schema-name quoting in `db.execute("DROP DATABASE " + schemaName)` is dialect-specific and is its own test case (one per dialect).

### Frontend (`frontend/tests/self-contained-package-view.test.js`)

- PackageEditView shows `database.schemaName` / `metricTable` / `migrations[]` when present.
- Uninstall button shows DDL-preview modal when package has `database` field; requires explicit "我已审查 DDL" checkbox before submitting.
- MetricDashboardView can render metrics from `pkg_<name>.<metricTable>` via the new `/api/dashboard/metrics/pkg/:name/*` endpoints.

### Coverage targets

| Module | Line coverage |
|--------|---------------|
| `ddl-sandbox.js` | 95% (whitelist is the security boundary) |
| `installer.js` (v2 path only) | 85% |
| `metricstore.js` (v2 path) | 90% |
| `registry.js` (index schema) | 80% |

Overall backend coverage must not regress from baseline (528/0/23 baseline established in 2026-08-09).

### Mirror verification

Extend `scripts/verify-mirror.ps1` to diff new files:
- `center/src/packages/ddl-sandbox.js` ↔ `publish/center/src/packages/ddl-sandbox.js`
- `db/migrations/00X-orphan-schemas.sql` ↔ `publish/center/db/migrations/00X-orphan-schemas.sql`
- Same for the MSSQL variants.
- Existing plugin-system mirror rules unchanged.

## Open questions / backlog (deferred)

- Code signing of packages (Ed25519 public-key allow-list).
- DDL rollback on upgrade — MySQL implicit-commit blocks trivial rollback; would need a forward-fix migration system or shadow-schema migration.
- Cross-package JOIN — packages needing shared state today must coordinate via fully-qualified `pkg_<name>.<table>` references in the admin's own queries; not surfaced in API yet.
- Multi-schema-per-package (e.g., one package wants staging + production tables).
- Author CLI (`npx addashboard-pkg new`, `validate`, `pack`).
- Package marketplace UI.
- Per-agent package overrides (subset of DCs gets this package).

## Migration / rollout summary

- **New installations**: init wizard applies the new `00X-orphan-schemas.sql` alongside existing migrations; existing tables (004-package-system + 12 earlier) untouched.
- **Existing installations**: next `/init` wizard boot applies `00X-orphan-schemas.sql` automatically (IF NOT EXISTS).
- **No breaking changes**: every v1 endpoint, schema, package format, agent behavior, or admin UI element keeps working without modification.
- **Feature flag**: `system_config.self_contained_packages_enabled` (default 1; set 0 to hide v2 admin UI + reject v2 packages from registry).
- **First ship**: behind flag for one release cycle, then enable by default — same rollout pattern as v1 plugin system.