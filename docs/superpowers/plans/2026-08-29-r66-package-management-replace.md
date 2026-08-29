# R66 — Package Management Replace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `installed_packages` with a two-table split (`package_scripts` + `package_policies`) so the operator can upload raw PS1 scripts and edit execution policy (interval/timeout/enabled/params/scope) from the admin UI without repackaging ZIPs. Agent protocol stays byte-identical so no in-field agent restart is required.

**Architecture:**
- **Layer 1** `package_scripts(name PK, version, script_content LONGTEXT, script_sha256, manifest_json, source)` — one row per script; overwrite on edit.
- **Layer 2** `package_policies(name FK→scripts, interval_sec, timeout_ms, enabled, params_json, scope)` — one row per script; FK CASCADE delete.
- **Layer 3** `/api/agent/packages` JOINs both at request time and bakes `intervalSec`/`timeoutMs` into `manifest.agent.*` so the agent receives the same `{ name, version, manifest, script(b64), params }` shape as R6 today.

**Tech Stack:** Node.js 20 LTS, Express, MySQL + MSSQL dual-dialect via `center/src/db/sql.js` registry, AJV JSON Schema for input validation, Vue 3 SFC + Pinia, Vitest, `installer/verify-mirror.ps1` for mirror sync.

**Spec:** `docs/superpowers/specs/2026-08-29-r66-package-management-replace-design.md`

---

## Global Constraints

- **Dialect-portable SQL**: every new helper ships in BOTH the `mysql` and `mssql` branches. `?` placeholders only — the mssql driver wrapper rewrites them to `@p1, @p2, ...` at `execute()` time.
- **UTC clock** for all `created_at`/`updated_at`: `new Date()` (JS) — the mssql/mysql wrappers reject `NOW()`/`GETDATE()` because of session-tz drift (round-15 hot-fix).
- **Mirror sync required**: every modified file has a mirror under `D:\ToolDevelop\ADDashboard\publish\system\...`. Run `installer/verify-mirror.ps1` — zero-drift must pass before commit.
- **No agent restart required**: `runner.js` MUST emit byte-identical JSON shape to the existing `PackageManager.syncFromCenter()`. The spec's Risk 6 requires explicit shape-regression tests.
- **Built-in re-seed is loud**: `seedBuiltinPackages` overwrites any operator edit on every center startup. This is the "宽松" choice — but the audit log shows each overwrite (action `upload_script`, source `builtin-seed`) so the operator sees the cycle. Do NOT add a "sticky locked" flag in V1.
- **Auth closure**: admin routes require `userAuth + requirePerm('admin:users')`. Agent routes keep `agentToken` middleware. Tests pass `db` directly to bypass the singleton (`getDb()` would pull in MSSQL driver wrappers).
- **Script body size cap**: 1 MB at both the modal (frontend validation) and the route (`script-service.installScript`). Out-of-range → 400 with explicit error.
- **writeAudit signature**: `({action, targetType?, targetId?, details})`. Always async, never throw — best-effort. Audit failures do NOT block the operation.
- **Mock-first** (standing operator directive): backend changes ship first; mock daemons are updated to read/write the new tables in the same commit. Agent protocol is byte-identical so real agents are unaffected.
- **No auto-restart of 8080 NSSM** (standing operator directive): Claude commits + tells the operator to restart manually. Do NOT call `nssm restart`.
- **All changes are YES** (standing operator directive): no AskUserQuestion for within-scope changes.
- **DO NOT touch `installed_packages` after migration**: it's gone. Any remaining references in the repo are bug — grep + delete.

---

## Critical Files (reuse pointers)

- **Existing SQL helper pattern** — `center/src/db/sql/installed-packages.js:107-194` (UPSERT_MYSQL / UPSERT_MSSQL / hydrate / function-style helpers + bound `installedPackagesForDb`). Mirror the structure exactly for the two new helpers.
- **Audit classifier** — `center/src/services/audit-classifier.js:5-91, 93-173, 175-253` (3 Maps: ACTION_CATEGORY / ACTION_SEVERITY / ACTION_LABEL). Each new action requires entries in all 3 maps.
- **Builtin-seed seeder** — `center/src/services/builtin-packages.js:132-261` (idempotent file copy + DB upsert + DDL apply + writeAudit on copy). Replace the `installedPackages.upsert` call with `script-service.installScript(...)` followed by `script-service.setPolicy(...)`.
- **Agent-facing runner** — `center/src/packages/runner.js:47-74` (`GET /api/agent/packages` reads on-disk `collect.ps1` + base64 + `manifest` + `params`). REWRITE: JOIN two tables, return `script_content` from `package_scripts`, bake `intervalSec`/`timeoutMs` into `manifest.agent.*`.
- **Admin router** — `center/src/packages/router.js` (per-route auth, `resolveBuffer`/`candidateManifestFromBuffer` ZIP helpers for legacy). REWRITE to use `script-service`. Drop ZIP path entirely (raw PS1 only now).
- **Migration applier** — find by searching `db/migrations/0*.sql` boot path; follow the R50 `splitSqlStatements` + `request.batch` pattern; add `023-*.sql` files for both dialects and the JS-level data-migration helper.
- **Mirror paths** — every file under `center/src/` and `center/web/src/` and `center/tests/` and `center/web/tests/` has a mirror under `publish/system/center/...`.

---

## Task 1 — DDL migration 023 (both dialects)

**Files:**
- Create: `db/migrations/023-package-scripts-policies-split.sql`
- Create: `db/migrations/mssql/023-package-scripts-policies-split.sql`
- Mirror: `publish/system/db/migrations/023-package-scripts-policies-split.sql`
- Mirror: `publish/system/db/migrations/mssql/023-package-scripts-policies-split.sql`

**Interfaces:**
- Produces: two new tables `package_scripts` and `package_policies` (data migration is JS, see Task 2).
- Consumes: existing `installed_packages` (read for the JS data migration; DROP happens in Task 2 once data is migrated).

### Step 1: Write MySQL DDL file

```sql
-- 2026-08-29 R66 — split installed_packages into scripts + policies.
-- Re-runnable: drops the new tables first if they exist (defensive — never
-- needed on a fresh DB but harmless because both CREATE statements are
-- idempotent for the migration runner). The JS data migration that follows
-- must run BEFORE the installed_packages DROP — see migration-applier for
-- the orchestration.

DROP TABLE IF EXISTS package_policies;
DROP TABLE IF EXISTS package_scripts;

CREATE TABLE package_scripts (
  id              BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name            VARCHAR(128) NOT NULL,
  version         VARCHAR(32)  NOT NULL,
  script_content  LONGTEXT     NOT NULL,
  script_sha256   CHAR(64)     NOT NULL,
  manifest_json   JSON         NOT NULL,
  source          VARCHAR(255) NOT NULL,
  created_at      DATETIME     NOT NULL,
  updated_at      DATETIME     NOT NULL,
  CONSTRAINT uq_package_scripts_name UNIQUE (name)
);

CREATE INDEX ix_package_scripts_updated_at ON package_scripts(updated_at);

CREATE TABLE package_policies (
  id              BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name            VARCHAR(128) NOT NULL,
  interval_sec    INT          NOT NULL,
  timeout_ms      INT          NOT NULL,
  enabled         TINYINT(1)   NOT NULL DEFAULT 1,
  params_json     JSON         NULL,
  scope           VARCHAR(64)  NOT NULL DEFAULT 'global',
  created_at      DATETIME     NOT NULL,
  updated_at      DATETIME     NOT NULL,
  CONSTRAINT fk_package_policies_name FOREIGN KEY (name)
    REFERENCES package_scripts(name) ON DELETE CASCADE,
  CONSTRAINT uq_package_policies_name UNIQUE (name)
);

CREATE INDEX ix_package_policies_enabled ON package_policies(enabled);
```

### Step 2: Write MSSQL DDL file (mirror, dialect-portable)

`publish/system/db/migrations/mssql/023-package-scripts-policies-split.sql` + `db/migrations/mssql/023-package-scripts-policies-split.sql` — same shape, MSSQL syntax:

```sql
-- 2026-08-29 R66 — MSSQL variant. JSON columns use NVARCHAR(MAX) +
-- ISJSON() check; BIGINT IDENTITY; TINYINT replaced with BIT; index
-- creation explicit.

DROP TABLE IF EXISTS package_policies;
DROP TABLE IF EXISTS package_scripts;

CREATE TABLE package_scripts (
  id              BIGINT       IDENTITY(1,1) PRIMARY KEY,
  name            NVARCHAR(128) NOT NULL,
  version         NVARCHAR(32)  NOT NULL,
  script_content  NVARCHAR(MAX) NOT NULL,
  script_sha256   CHAR(64)      NOT NULL,
  manifest_json   NVARCHAR(MAX) NOT NULL
                     CONSTRAINT ck_package_scripts_manifest_json_isjson CHECK (ISJSON(manifest_json) = 1),
  source          NVARCHAR(255) NOT NULL,
  created_at      DATETIME2     NOT NULL,
  updated_at      DATETIME2     NOT NULL,
  CONSTRAINT uq_package_scripts_name UNIQUE (name)
);

CREATE INDEX ix_package_scripts_updated_at ON package_scripts(updated_at);

CREATE TABLE package_policies (
  id              BIGINT       IDENTITY(1,1) PRIMARY KEY,
  name            NVARCHAR(128) NOT NULL,
  interval_sec    INT           NOT NULL,
  timeout_ms      INT           NOT NULL,
  enabled         BIT           NOT NULL DEFAULT 1,
  params_json     NVARCHAR(MAX) NULL,
  scope           NVARCHAR(64)  NOT NULL DEFAULT 'global',
  created_at      DATETIME2     NOT NULL,
  updated_at      DATETIME2     NOT NULL,
  CONSTRAINT fk_package_policies_name FOREIGN KEY (name)
    REFERENCES package_scripts(name) ON DELETE CASCADE,
  CONSTRAINT uq_package_policies_name UNIQUE (name)
);

CREATE INDEX ix_package_policies_enabled ON package_policies(enabled);
```

### Step 3: Verify the migration runner finds the new files

```bash
cd center
node -e "
import('./src/services/migrations.js').then(m => {
  console.log('MySQL:', m.MYSQL_FILES.filter(f => f.includes('023')));
  console.log('MSSQL:', m.MSSQL_FILES.filter(f => f.includes('023')));
});
"
# Expect: 023-package-scripts-policies-split.sql on both lines
```

If the boot path uses a different name (e.g. `migrations.js` is a thin wrapper around a config array), grep for the existing `022-` file name pattern and follow it.

### Step 4: Mirror

```bash
mkdir -p publish/system/db/migrations/mssql
cp db/migrations/023-package-scripts-policies-split.sql publish/system/db/migrations/
cp db/migrations/mssql/023-package-scripts-policies-split.sql publish/system/db/migrations/mssql/
pwsh -NoProfile -File installer/verify-mirror.ps1
# Expect: PASS (only the new files; no drift yet)
```

### Step 5: Commit

```bash
git add db/migrations/023-package-scripts-policies-split.sql \
        db/migrations/mssql/023-package-scripts-policies-split.sql \
        publish/system/db/migrations/023-package-scripts-policies-split.sql \
        publish/system/db/migrations/mssql/023-package-scripts-policies-split.sql
git commit -m "feat(r66): migration 023 DDL — package_scripts + package_policies"
```

**Done when:** Both `.sql` files exist in `db/migrations/` and `publish/system/db/migrations/`, with the FK + CHECK constraint visible. `verify-mirror.ps1` passes. Commit done.

**Complexity:** small (mechanical DDL port).

---

## Task 2 — JS data migration helper + applier wiring

**Files:**
- Modify: `center/src/services/migrations.js` (or the applier that loops over `.sql` files) — add `023-package-scripts-policies-split.js` invocation
- Create: `db/migrations/023-package-scripts-policies-split.js` (the JS-level data migration)
- Create: `db/migrations/mssql/023-package-scripts-policies-split.js` (dialect dispatcher, delegates to mysql version or has its own)
- Create: `center/tests/migrations/023-package-scripts-policies-split.test.js` (mock-DB unit test)

**Interfaces:**
- Produces: rows migrated from `installed_packages` → `package_scripts` + `package_policies`, then `installed_packages` dropped.
- Consumes: existing `installed_packages` rows + on-disk `data/packages/<name>/<version>/collect.ps1` files.

### Step 1: Write the failing test

`center/tests/migrations/023-package-scripts-policies-split.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateInstalledPackagesToTwoTable } from '../../../db/migrations/023-package-scripts-policies-split.js';

function makeFakeDb() {
  const calls = [];
  const fake = {
    dialect: 'mysql',
    execute: async (sql, params) => {
      calls.push({ sql: sql.trim().split('\n')[0].slice(0, 60), params });
      if (sql.includes('SELECT name, version, type, manifest_json')) {
        return { rows: [
          { name: 'pkg-a', version: '1.0.0', type: 'gauge',
            manifest_json: '{"name":"pkg-a","version":"1.0.0","type":"gauge","agent":{"type":"ad","script":"collect.ps1","intervalSec":3600,"timeoutMs":30000}}',
            enabled: 1, params_json: null, interval_override_sec: null,
            script_content_on_disk: 'Write-Host hi' },
          { name: 'pkg-b', version: '1.0.0', type: 'status',
            manifest_json: '{"name":"pkg-b","version":"1.0.0","type":"status","agent":{"type":"non-ad","script":"collect.ps1","intervalSec":1800,"timeoutMs":60000}}',
            enabled: 0, params_json: '{"key":"val"}', interval_override_sec: 60,
            script_content_on_disk: 'Write-Host bye' }
        ] };
      }
      return { rows: [] };
    }
  };
  return { fake, calls };
}

test('migrates each row to package_scripts + package_policies, drops old', async () => {
  const { fake, calls } = makeFakeDb();
  await migrateInstalledPackagesToTwoTable({ db: fake, dataDir: '/tmp/pkgtest' });

  // Expect 1 SELECT (read installed_packages), 2 INSERTs per script (script + policy), 1 DROP
  const insertScriptCalls = calls.filter(c => c.sql.includes('INSERT INTO package_scripts'));
  const insertPolicyCalls = calls.filter(c => c.sql.includes('INSERT INTO package_policies'));
  const dropCalls = calls.filter(c => c.sql.includes('DROP TABLE installed_packages'));
  assert.equal(insertScriptCalls.length, 2, 'two scripts migrated');
  assert.equal(insertPolicyCalls.length, 2, 'two policies migrated');
  assert.equal(dropCalls.length, 1, 'installed_packages dropped once');
});

test('interval_override_sec wins over manifest.agent.intervalSec', async () => {
  const { fake } = makeFakeDb();
  await migrateInstalledPackagesToTwoTable({ db: fake, dataDir: '/tmp/pkgtest' });
  // The policy INSERT for pkg-b (which had interval_override_sec = 60) should bind 60
  // ... assertion against calls[].params for the pkg-b INSERT INTO package_policies
});
```

### Step 2: Run test to confirm it fails

```bash
cd center && node --test tests/migrations/023-package-scripts-policies-split.test.js
# Expect: import fails — module doesn't exist yet
```

### Step 3: Implement the migration helper

`db/migrations/023-package-scripts-policies-split.js`:

```js
// 2026-08-29 R66 — data migration from installed_packages to
// package_scripts + package_policies. Runs as JS (not raw SQL) because
// each row needs:
//   - read on-disk data/packages/<name>/<version>/collect.ps1
//   - compute SHA256 hex of bytes
//   - synthesize new manifest_json (strip intervalSec/timeoutMs out of agent block)
//   - write two rows with FK satisfied (script first)
//   - one audit row per script with action='bulk_migrate'
//
// After all rows are migrated, drops installed_packages. The DROP is
// idempotent — if the table is already gone (re-run), it's a no-op.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const INSERT_SCRIPT_MYSQL = `INSERT INTO package_scripts (name, version, script_content, script_sha256, manifest_json, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const INSERT_SCRIPT_MSSQL = `INSERT INTO package_scripts (name, version, script_content, script_sha256, manifest_json, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const INSERT_POLICY_MYSQL = `INSERT INTO package_policies (name, interval_sec, timeout_ms, enabled, params_json, scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const INSERT_POLICY_MSSQL = `INSERT INTO package_policies (name, interval_sec, timeout_ms, enabled, params_json, scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const DROP_MYSQL = `DROP TABLE installed_packages`;
const DROP_MSSQL = `DROP TABLE installed_packages`;

const SELECT_MYSQL = `SELECT name, version, type, manifest_json, enabled, params_json, interval_override_sec FROM installed_packages ORDER BY name`;
const SELECT_MSSQL = `SELECT name, version, type, manifest_json, enabled, params_json, interval_override_sec FROM installed_packages ORDER BY name`;

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Strip intervalSec + timeoutMs from the agent block — they live in
// package_policies now, not in the manifest. Returns a fresh object.
function stripPolicyFromManifest(manifest) {
  const out = JSON.parse(JSON.stringify(manifest));
  if (out.agent) {
    delete out.agent.intervalSec;
    delete out.agent.timeoutMs;
  }
  return out;
}

export async function migrateInstalledPackagesToTwoTable({ db, dataDir, writeAudit }) {
  const sqlScript = db.dialect === 'mssql' ? INSERT_SCRIPT_MSSQL : INSERT_SCRIPT_MYSQL;
  const sqlPolicy = db.dialect === 'mssql' ? INSERT_POLICY_MSSQL : INSERT_POLICY_MYSQL;
  const sqlDrop = db.dialect === 'mssql' ? DROP_MSSQL : DROP_MYSQL;
  const sqlSelect = db.dialect === 'mssql' ? SELECT_MSSQL : SELECT_MYSQL;

  const { rows } = await db.execute(sqlSelect, []);
  if (rows.length === 0) return { migrated: 0 };

  const now = new Date();
  let count = 0;
  for (const row of rows) {
    // manifest_json: mssql returns string; mysql2 may auto-parse
    const manifest = typeof row.manifest_json === 'string'
      ? JSON.parse(row.manifest_json)
      : row.manifest_json;

    // Read script bytes from disk — best effort. If file is missing
    // (operator deleted data/packages/... manually) fall back to a
    // placeholder so the migration still completes; the operator can
    // re-upload via UI.
    const scriptPath = path.join(dataDir, row.name, row.version, 'collect.ps1');
    let scriptBytes;
    try {
      scriptBytes = fs.readFileSync(scriptPath);
    } catch (e) {
      scriptBytes = Buffer.from(`# collect.ps1 missing for ${row.name}@${row.version} — re-upload required\n`);
    }
    const scriptSha = sha256Hex(scriptBytes);

    // 1. INSERT script row first (FK)
    await db.execute(sqlScript, [
      row.name,
      row.version,
      scriptBytes.toString('utf8'),
      scriptSha,
      JSON.stringify(stripPolicyFromManifest(manifest)),
      'legacy-installed_packages',
      now, now
    ]);

    // 2. INSERT policy row
    const intervalSec = row.interval_override_sec ?? manifest.agent?.intervalSec ?? 3600;
    const timeoutMs = manifest.agent?.timeoutMs ?? 30000;
    const enabledBit = row.enabled === 1 || row.enabled === true ? 1 : 0;
    const paramsStr = row.params_json == null
      ? null
      : (typeof row.params_json === 'string' ? row.params_json : JSON.stringify(row.params_json));
    await db.execute(sqlPolicy, [
      row.name,
      Number(intervalSec),
      Number(timeoutMs),
      enabledBit,
      paramsStr,
      'global',
      now, now
    ]);
    count++;
  }

  // 3. DROP installed_packages (idempotent — IF EXISTS in MySQL, check sys.tables in MSSQL)
  if (db.dialect === 'mysql') {
    await db.execute('DROP TABLE IF EXISTS installed_packages', []);
  } else {
    // MSSQL guard
    const probe = await db.execute(
      `SELECT 1 AS x FROM sys.tables WHERE name = 'installed_packages'`, []);
    if (probe.rows.length > 0) {
      await db.execute(sqlDrop, []);
    }
  }

  // 4. One audit summary
  if (writeAudit) {
    await writeAudit({
      action: 'bulk_migrate',
      targetType: 'packages',
      details: { source: 'installed_packages', count, destination: 'package_scripts+package_policies' }
    });
  }
  return { migrated: count };
}
```

### Step 4: Run test to confirm it passes

```bash
cd center && node --test tests/migrations/023-package-scripts-policies-split.test.js
# Expect: PASS
```

### Step 5: Wire into the applier

Find where existing `0*.sql` migrations are loaded — typically a list of filenames like:

```js
export const MYSQL_MIGRATIONS = [
  '001-...', '002-...', ..., '022-...'
];
```

Add `'023-package-scripts-policies-split.sql'` AND `'023-package-scripts-policies-split.js'` to the lists. The applier should:
1. Run the `.sql` (DDL — CREATE tables).
2. Run the `.js` (data migration + DROP old).
3. Append both to `schema_migrations` once each succeeds.

If the applier only handles `.sql`, add a sibling `.js` invocation step (parallel to `baseline` / `apply-up-to` / etc., see R20 SDD).

### Step 6: Mirror

```bash
cp db/migrations/023-package-scripts-policies-split.js publish/system/db/migrations/
[ -f db/migrations/mssql/023-package-scripts-policies-split.js ] && cp db/migrations/mssql/023-package-scripts-policies-split.js publish/system/db/migrations/mssql/
pwsh -NoProfile -File installer/verify-mirror.ps1
```

### Step 7: Commit

```bash
git add db/migrations/023-package-scripts-policies-split.js \
        center/src/services/migrations.js \
        center/tests/migrations/023-package-scripts-policies-split.test.js \
        publish/system/db/migrations/023-package-scripts-policies-split.js \
        publish/system/center/src/services/migrations.js \
        publish/system/center/tests/migrations/023-package-scripts-policies-split.test.js
git commit -m "feat(r66): migration 023 JS data migration installed_packages → package_scripts+package_policies"
```

**Done when:** Migration test passes; applier recognizes 023 in both dialects; mirror clean.

**Complexity:** small (the helper is mechanical; applier wiring follows the R20 pattern).

---

## Task 3 — `package-scripts` SQL helper

**Files:**
- Create: `center/src/db/sql/package-scripts.js`
- Mirror: `publish/system/center/src/db/sql/package-scripts.js`

**Interfaces:**
- Produces: `packageScriptsSql` (registry object), `packageScripts` (function-style helpers taking `(db, ...)`), `packageScriptsForDb` (singleton-bound wrappers).
- Consumes: `db.execute`, `db.dialect`.

### Step 1: Write the failing test

`center/tests/db/sql/package-scripts.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packageScripts, packageScriptsSql } from '../../../src/db/sql/package-scripts.js';

test('upsert preserves sha256 + manifest shape', async () => {
  const calls = [];
  const db = {
    dialect: 'mysql',
    execute: async (sql, params) => {
      calls.push({ sql: sql.trim().split('\n')[0], params });
      return { rows: [] };
    }
  };
  await packageScripts.upsert(db, {
    name: 'pkg-a', version: '1.0.0', scriptContent: 'Write-Host hi',
    scriptSha256: 'a'.repeat(64), manifest: { name: 'pkg-a', type: 'gauge', agent: { type: 'ad', script: 'collect.ps1' } },
    source: 'admin-upload'
  });
  assert.match(calls[0].sql, /INSERT INTO package_scripts/);
  assert.equal(calls[0].params[0], 'pkg-a');
  assert.equal(calls[0].params[3], 'a'.repeat(64));
  assert.equal(calls[0].params[5], 'admin-upload');
});

test('list returns rows hydrated into { manifest: object, ...row }', async () => {
  const db = {
    dialect: 'mysql',
    execute: async () => ({ rows: [{ id: 1, name: 'pkg-a', version: '1.0.0',
      script_sha256: 'a'.repeat(64), manifest_json: '{"name":"pkg-a","type":"gauge"}',
      source: 'admin-upload', created_at: new Date(), updated_at: new Date() }] })
  };
  const rows = await packageScripts.list(db);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].manifest, { name: 'pkg-a', type: 'gauge' });
});

test('registry exposes both mysql + mssql variants', () => {
  assert.ok(packageScriptsSql.upsert.mysql);
  assert.ok(packageScriptsSql.upsert.mssql);
  assert.ok(packageScriptsSql.list.mysql);
  assert.ok(packageScriptsSql.list.mssql);
});
```

### Step 2: Run test (expect import failure)

```bash
cd center && node --test tests/db/sql/package-scripts.test.js
```

### Step 3: Implement

`center/src/db/sql/package-scripts.js` — mirror `center/src/db/sql/installed-packages.js` exactly. Both dialects:

```js
import { getDb } from '../index.js';

const UPSERT_MYSQL = `INSERT INTO package_scripts
  (name, version, script_content, script_sha256, manifest_json, source, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    version = VALUES(version),
    script_content = VALUES(script_content),
    script_sha256 = VALUES(script_sha256),
    manifest_json = VALUES(manifest_json),
    updated_at = VALUES(updated_at)`;

const UPSERT_MSSQL = `MERGE INTO package_scripts AS t
USING (SELECT ? AS name, ? AS version, ? AS script_content, ? AS script_sha256,
              ? AS manifest_json, ? AS source, ? AS created_at, ? AS updated_at) AS s
ON t.name = s.name
WHEN MATCHED THEN UPDATE SET
  version = s.version, script_content = s.script_content,
  script_sha256 = s.script_sha256, manifest_json = s.manifest_json,
  updated_at = s.updated_at
WHEN NOT MATCHED THEN INSERT
  (name, version, script_content, script_sha256, manifest_json, source, created_at, updated_at)
  VALUES (s.name, s.version, s.script_content, s.script_sha256, s.manifest_json, s.source, s.created_at, s.updated_at)`;

const LIST_MYSQL = `SELECT * FROM package_scripts ORDER BY name`;
const LIST_MSSQL = `SELECT * FROM package_scripts ORDER BY name`;

const GET_MYSQL = `SELECT * FROM package_scripts WHERE name = ?`;
const GET_MSSQL = `SELECT * FROM package_scripts WHERE name = ?`;

const DELETE_MYSQL = `DELETE FROM package_scripts WHERE name = ?`;
const DELETE_MSSQL = `DELETE FROM package_scripts WHERE name = ?`;

const UPDATE_SCRIPT_MYSQL = `UPDATE package_scripts SET script_content = ?, script_sha256 = ?, updated_at = ? WHERE name = ?`;
const UPDATE_SCRIPT_MSSQL = `UPDATE package_scripts SET script_content = ?, script_sha256 = ?, updated_at = ? WHERE name = ?`;

export const packageScriptsSql = {
  upsert: { mysql: UPSERT_MYSQL, mssql: UPSERT_MSSQL },
  list:   { mysql: LIST_MYSQL, mssql: LIST_MSSQL },
  get:    { mysql: GET_MYSQL, mssql: GET_MSSQL },
  delete: { mysql: DELETE_MYSQL, mssql: DELETE_MSSQL },
  updateScript: { mysql: UPDATE_SCRIPT_MYSQL, mssql: UPDATE_SCRIPT_MSSQL }
};

function hydrate(row) {
  if (!row) return row;
  const parseJson = (v) => {
    if (v == null) return null;
    if (typeof v === 'object') return v;
    if (typeof v === 'string') return JSON.parse(v);
    return v;
  };
  return {
    ...row,
    scriptContent: row.script_content,
    scriptSha256: row.script_sha256,
    manifest: parseJson(row.manifest_json),
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export const packageScripts = {
  async upsert(db, { name, version, scriptContent, scriptSha256, manifest, source }) {
    const sql = db.dialect === 'mssql' ? UPSERT_MSSQL : UPSERT_MYSQL;
    const now = new Date();
    await db.execute(sql, [
      name, version, scriptContent, scriptSha256,
      JSON.stringify(manifest), source, now, now
    ]);
  },

  async updateScript(db, { name, scriptContent, scriptSha256 }) {
    const sql = db.dialect === 'mssql' ? UPDATE_SCRIPT_MSSQL : UPDATE_SCRIPT_MYSQL;
    await db.execute(sql, [scriptContent, scriptSha256, new Date(), name]);
  },

  async list(db) {
    const sql = db.dialect === 'mssql' ? LIST_MSSQL : LIST_MYSQL;
    const { rows } = await db.execute(sql, []);
    return rows.map(hydrate);
  },

  async get(db, name) {
    const sql = db.dialect === 'mssql' ? GET_MSSQL : GET_MYSQL;
    const { rows } = await db.execute(sql, [name]);
    if (!rows || rows.length === 0) return null;
    return hydrate(rows[0]);
  },

  async delete(db, name) {
    const sql = db.dialect === 'mssql' ? DELETE_MSSQL : DELETE_MYSQL;
    await db.execute(sql, [name]);
  }
};

export const packageScriptsForDb = {
  upsert: (p) => packageScripts.upsert(getDb(), p),
  updateScript: (p) => packageScripts.updateScript(getDb(), p),
  list: () => packageScripts.list(getDb()),
  get: (name) => packageScripts.get(getDb(), name),
  delete: (name) => packageScripts.delete(getDb(), name)
};
```

### Step 4: Run test

```bash
cd center && node --test tests/db/sql/package-scripts.test.js
# Expect: 3 pass
```

### Step 5: Register in sql.js (if the central registry imports individual files)

If `center/src/db/sql.js` explicitly imports + aggregates:

```js
import { packageScriptsSql } from './sql/package-scripts.js';
// ... merge into the dialect-conditional registry at db.sql.packageScripts.*
```

If `sql.js` reads dynamically, no change needed (the helper exposes `packageScriptsSql` for ad-hoc access).

### Step 6: Mirror

```bash
cp center/src/db/sql/package-scripts.js publish/system/center/src/db/sql/
cp center/tests/db/sql/package-scripts.test.js publish/system/center/tests/db/sql/
pwsh -NoProfile -File installer/verify-mirror.ps1
```

### Step 7: Commit

```bash
git add center/src/db/sql/package-scripts.js \
        center/src/db/sql.js \
        center/tests/db/sql/package-scripts.test.js \
        publish/system/center/src/db/sql/package-scripts.js \
        publish/system/center/tests/db/sql/package-scripts.test.js
git commit -m "feat(r66): packageScripts SQL helper (upsert/list/get/delete/updateScript)"
```

**Done when:** Helper exists in both dialects; 3 tests pass; sql.js aware; mirror clean.

**Complexity:** trivial (mechanical port of installed-packages pattern).

---

## Task 4 — `package-policies` SQL helper

**Files:**
- Create: `center/src/db/sql/package-policies.js`
- Mirror: `publish/system/center/src/db/sql/package-policies.js`

**Interfaces:**
- Same shape as Task 3 but for the policies table.
- Adds `updatePartial(db, name, fields)` — partial UPDATE that only writes the columns the caller passes.

### Step 1: Write the failing test

`center/tests/db/sql/package-policies.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packagePolicies } from '../../../src/db/sql/package-policies.js';

test('upsert writes 8 columns', async () => {
  const calls = [];
  const db = { dialect: 'mysql', execute: async (sql, p) => { calls.push({ sql, params: p }); return { rows: [] }; } };
  await packagePolicies.upsert(db, {
    name: 'pkg-a', intervalSec: 3600, timeoutMs: 30000, enabled: true,
    params: { x: 1 }, scope: 'global'
  });
  assert.match(calls[0].sql, /INSERT INTO package_policies/);
  assert.equal(calls[0].params.length, 8);
});

test('updatePartial emits only present columns', async () => {
  const calls = [];
  const db = { dialect: 'mysql', execute: async (sql, p) => { calls.push({ sql, params: p }); return { rows: [] }; } };
  await packagePolicies.updatePartial(db, 'pkg-a', { intervalSec: 60, enabled: false });
  assert.match(calls[0].sql, /UPDATE package_policies SET interval_sec = \?, enabled = \?, updated_at = \?/);
  assert.equal(calls[0].params.length, 3, 'only 3 binds: interval_sec, enabled, updated_at — plus name WHERE');
});

test('listEnabled returns enabled=1 rows', async () => {
  const db = { dialect: 'mysql', execute: async () => ({ rows: [{ name: 'pkg-a', enabled: 1 }] }) };
  const rows = await packagePolicies.listEnabled(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].enabled, true);
});
```

### Step 2: Run test (expect import failure)

### Step 3: Implement

`center/src/db/sql/package-policies.js`:

```js
import { getDb } from '../index.js';

const UPSERT_MYSQL = `INSERT INTO package_policies
  (name, interval_sec, timeout_ms, enabled, params_json, scope, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    interval_sec = VALUES(interval_sec),
    timeout_ms = VALUES(timeout_ms),
    enabled = VALUES(enabled),
    params_json = VALUES(params_json),
    scope = VALUES(scope),
    updated_at = VALUES(updated_at)`;

const UPSERT_MSSQL = `MERGE INTO package_policies AS t
USING (SELECT ? AS name, ? AS interval_sec, ? AS timeout_ms, ? AS enabled,
              ? AS params_json, ? AS scope, ? AS created_at, ? AS updated_at) AS s
ON t.name = s.name
WHEN MATCHED THEN UPDATE SET
  interval_sec = s.interval_sec, timeout_ms = s.timeout_ms,
  enabled = s.enabled, params_json = s.params_json,
  scope = s.scope, updated_at = s.updated_at
WHEN NOT MATCHED THEN INSERT
  (name, interval_sec, timeout_ms, enabled, params_json, scope, created_at, updated_at)
  VALUES (s.name, s.interval_sec, s.timeout_ms, s.enabled, s.params_json, s.scope, s.created_at, s.updated_at)`;

const LIST_MYSQL = `SELECT * FROM package_policies ORDER BY name`;
const LIST_MSSQL = `SELECT * FROM package_policies ORDER BY name`;

const LIST_ENABLED_MYSQL = `SELECT * FROM package_policies WHERE enabled = 1 ORDER BY name`;
const LIST_ENABLED_MSSQL = `SELECT * FROM package_policies WHERE enabled = 1 ORDER BY name`;

const GET_BY_NAME_MYSQL = `SELECT * FROM package_policies WHERE name = ?`;
const GET_BY_NAME_MSSQL = `SELECT * FROM package_policies WHERE name = ?`;

const DELETE_MYSQL = `DELETE FROM package_policies WHERE name = ?`;
const DELETE_MSSQL = `DELETE FROM package_policies WHERE name = ?`;

// Partial update — emits SET clauses for only the fields the caller passes.
// Order of columns in `assign` matches the order of values in `params`.
function buildUpdatePartial(dialect, fields) {
  const allowed = ['intervalSec', 'timeoutMs', 'enabled', 'params', 'scope'];
  const setClauses = [];
  const params = [];
  const colMap = { intervalSec: 'interval_sec', timeoutMs: 'timeout_ms', enabled: 'enabled', params: 'params_json', scope: 'scope' };
  for (const f of allowed) {
    if (fields[f] === undefined) continue;
    setClauses.push(`${colMap[f]} = ?`);
    let v;
    if (f === 'enabled') v = fields[f] ? 1 : 0;
    else if (f === 'params') v = fields[f] == null ? null : JSON.stringify(fields[f]);
    else v = fields[f];
    params.push(v);
  }
  setClauses.push('updated_at = ?');
  params.push(new Date());
  params.push(fields._name); // private — caller passes the name under _name
  return { sql: `UPDATE package_policies SET ${setClauses.join(', ')} WHERE name = ?`, params };
}

export const packagePoliciesSql = {
  upsert: { mysql: UPSERT_MYSQL, mssql: UPSERT_MSSQL },
  list:   { mysql: LIST_MYSQL, mssql: LIST_MSSQL },
  listEnabled: { mysql: LIST_ENABLED_MYSQL, mssql: LIST_ENABLED_MSSQL },
  getByName: { mysql: GET_BY_NAME_MYSQL, mssql: GET_BY_NAME_MSSQL },
  delete: { mysql: DELETE_MYSQL, mssql: DELETE_MSSQL }
};

function hydrate(row) {
  if (!row) return row;
  const parseJson = (v) => {
    if (v == null) return null;
    if (typeof v === 'object') return v;
    if (typeof v === 'string') return JSON.parse(v);
    return v;
  };
  return {
    ...row,
    intervalSec: row.interval_sec,
    timeoutMs: row.timeout_ms,
    enabled: row.enabled === 1 || row.enabled === true,
    params: parseJson(row.params_json),
    scope: row.scope,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export const packagePolicies = {
  async upsert(db, { name, intervalSec, timeoutMs, enabled, params, scope }) {
    const sql = db.dialect === 'mssql' ? UPSERT_MSSQL : UPSERT_MYSQL;
    const now = new Date();
    await db.execute(sql, [
      name, Number(intervalSec), Number(timeoutMs),
      enabled ? 1 : 0,
      params == null ? null : JSON.stringify(params),
      scope || 'global',
      now, now
    ]);
  },

  async updatePartial(db, name, fields) {
    const { sql, params } = buildUpdatePartial(db.dialect, { ...fields, _name: name });
    await db.execute(sql, params);
  },

  async list(db) {
    const sql = db.dialect === 'mssql' ? LIST_MSSQL : LIST_MYSQL;
    const { rows } = await db.execute(sql, []);
    return rows.map(hydrate);
  },

  async listEnabled(db) {
    const sql = db.dialect === 'mssql' ? LIST_ENABLED_MSSQL : LIST_ENABLED_MYSQL;
    const { rows } = await db.execute(sql, []);
    return rows.map(hydrate);
  },

  async getByName(db, name) {
    const sql = db.dialect === 'mssql' ? GET_BY_NAME_MSSQL : GET_BY_NAME_MYSQL;
    const { rows } = await db.execute(sql, [name]);
    if (!rows || rows.length === 0) return null;
    return hydrate(rows[0]);
  },

  async delete(db, name) {
    const sql = db.dialect === 'mssql' ? DELETE_MSSQL : DELETE_MYSQL;
    await db.execute(sql, [name]);
  }
};

export const packagePoliciesForDb = {
  upsert: (p) => packagePolicies.upsert(getDb(), p),
  updatePartial: (name, fields) => packagePolicies.updatePartial(getDb(), name, fields),
  list: () => packagePolicies.list(getDb()),
  listEnabled: () => packagePolicies.listEnabled(getDb()),
  getByName: (name) => packagePolicies.getByName(getDb(), name),
  delete: (name) => packagePolicies.delete(getDb(), name)
};
```

### Step 4: Run test

```bash
cd center && node --test tests/db/sql/package-policies.test.js
# Expect: 3 pass
```

### Step 5: Mirror

```bash
cp center/src/db/sql/package-policies.js publish/system/center/src/db/sql/
cp center/tests/db/sql/package-policies.test.js publish/system/center/tests/db/sql/
pwsh -NoProfile -File installer/verify-mirror.ps1
```

### Step 6: Commit

```bash
git add center/src/db/sql/package-policies.js \
        center/tests/db/sql/package-policies.test.js \
        publish/system/center/src/db/sql/package-policies.js \
        publish/system/center/tests/db/sql/package-policies.test.js
git commit -m "feat(r66): packagePolicies SQL helper (upsert/list/listEnabled/getByName/delete/updatePartial)"
```

**Done when:** Helper exists in both dialects; 3 tests pass; mirror clean.

**Complexity:** small.

---

## Task 5 — `script-service` (installScript / editScript / setPolicy / deleteScript + audit)

**Files:**
- Create: `center/src/packages/script-service.js`
- Create: `center/tests/packages/script-service.test.js`
- Mirror: `publish/system/center/src/packages/script-service.js`
- Mirror: `publish/system/center/tests/packages/script-service.test.js`

**Interfaces:**
- Produces: 4 functions used by the admin router + builtin seeder.
- Consumes: `packageScripts` + `packagePolicies` SQL helpers + `writeAudit` (best-effort).

### Step 1: Write the failing tests (~15)

`center/tests/packages/script-service.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { installScript, editScript, setPolicy, deleteScript } from '../../src/packages/script-service.js';

// Helper: build a fake db + audit recorder
function makeFakeDb({ existingScripts = [], existingPolicies = [] } = {}) {
  const scriptRows = [...existingScripts];
  const policyRows = [...existingPolicies];
  const auditCalls = [];
  const db = {
    dialect: 'mysql',
    async execute(sql, params) {
      const trimmed = sql.trim();
      if (trimmed.startsWith('INSERT INTO package_scripts')) {
        scriptRows.push({ name: params[0], script_sha256: params[3], source: params[5] });
        return { rows: [] };
      }
      if (trimmed.startsWith('INSERT INTO package_policies')) {
        policyRows.push({ name: params[0], interval_sec: params[1], enabled: params[3] });
        return { rows: [] };
      }
      if (trimmed.startsWith('UPDATE package_scripts SET script_content')) {
        const r = scriptRows.find(r => r.name === params[3]);
        if (r) r.script_sha256 = params[1];
        return { rows: [] };
      }
      if (trimmed.startsWith('UPDATE package_policies')) {
        return { rows: [] };
      }
      if (trimmed.startsWith('DELETE FROM package_scripts')) {
        const i = scriptRows.findIndex(r => r.name === params[0]);
        if (i >= 0) scriptRows.splice(i, 1);
        return { rows: [] };
      }
      return { rows: [] };
    }
  };
  return { db, scriptRows, policyRows, auditCalls };
}

const writeAudit = async (args) => auditCalls.push(args);

test('installScript writes script + default policy + audit row', async () => {
  const { db, scriptRows, policyRows } = makeFakeDb();
  const auditCalls = [];
  const r = await installScript({
    db, name: 'pkg-a', content: 'Write-Host hi', type: 'gauge', agentType: 'ad',
    description: 'test', intervalSec: 3600, timeoutMs: 30000,
    writeAudit: async (a) => auditCalls.push(a)
  });
  assert.equal(scriptRows.length, 1);
  assert.equal(policyRows.length, 1);
  assert.equal(scriptRows[0].source, 'admin-upload');
  assert.equal(policyRows[0].interval_sec, 3600);
  assert.equal(auditCalls[0].action, 'upload_script');
  assert.match(auditCalls[0].details.scriptSha, /^[0-9a-f]{8}$/);
});

test('installScript rejects duplicate name', async () => {
  const { db } = makeFakeDb({ existingScripts: [{ name: 'pkg-a' }] });
  await assert.rejects(
    installScript({ db, name: 'pkg-a', content: 'x', type: 'gauge', agentType: 'ad',
                    description: 't', intervalSec: 60, timeoutMs: 1000, writeAudit: async () => {} }),
    /already exists/i
  );
});

test('installScript rejects oversized content (>1 MB)', async () => {
  const { db } = makeFakeDb();
  const huge = 'x'.repeat(1024 * 1024 + 1);
  await assert.rejects(
    installScript({ db, name: 'pkg-x', content: huge, type: 'gauge', agentType: 'ad',
                    description: 't', intervalSec: 60, timeoutMs: 1000, writeAudit: async () => {} }),
    /too large/i
  );
});

test('installScript strips intervalSec + timeoutMs from manifest.agent', async () => {
  let capturedManifest = null;
  const db = {
    dialect: 'mysql',
    async execute(sql, params) {
      if (sql.trim().startsWith('INSERT INTO package_scripts')) {
        capturedManifest = JSON.parse(params[4]);
      }
      return { rows: [] };
    }
  };
  await installScript({ db, name: 'pkg-z', content: 'x', type: 'gauge', agentType: 'ad',
    description: 't', intervalSec: 60, timeoutMs: 1000, writeAudit: async () => {} });
  assert.equal(capturedManifest.agent.intervalSec, undefined);
  assert.equal(capturedManifest.agent.timeoutMs, undefined);
});

test('editScript updates sha256 + writes audit', async () => {
  const { db } = makeFakeDb({ existingScripts: [{ name: 'pkg-a', script_sha256: 'old'.repeat(16) }] });
  const auditCalls = [];
  const r = await editScript({ db, name: 'pkg-a', content: 'new', writeAudit: async (a) => auditCalls.push(a) });
  assert.equal(r.oldSha, 'old'.repeat(16));
  assert.match(r.newSha, /^[0-9a-f]{64}$/);
  assert.equal(auditCalls[0].action, 'edit_script');
});

test('editScript no-op when sha unchanged → skip audit', async () => {
  const { db } = makeFakeDb({ existingScripts: [{ name: 'pkg-a', script_sha256: crypto.createHash('sha256').update('same').digest('hex') }] });
  const auditCalls = [];
  await editScript({ db, name: 'pkg-a', content: 'same', writeAudit: async (a) => auditCalls.push(a) });
  assert.equal(auditCalls.length, 0);
});

test('editScript throws on missing', async () => {
  const { db } = makeFakeDb();
  await assert.rejects(editScript({ db, name: 'no-such', content: 'x', writeAudit: async () => {} }), /not found/i);
});

test('setPolicy partial body writes only present fields + audit', async () => {
  const { db } = makeFakeDb({ existingPolicies: [{ name: 'pkg-a' }] });
  const auditCalls = [];
  await setPolicy({ db, name: 'pkg-a', intervalSec: 60, writeAudit: async (a) => auditCalls.push(a) });
  assert.equal(auditCalls[0].action, 'set_policy');
  assert.deepEqual(auditCalls[0].details.fields, ['intervalSec']);
});

test('setPolicy rejects intervalSec < 5', async () => {
  const { db } = makeFakeDb();
  await assert.rejects(
    setPolicy({ db, name: 'pkg-a', intervalSec: 1, writeAudit: async () => {} }),
    /intervalSec.*5/
  );
});

test('setPolicy rejects timeoutMs < 1000', async () => {
  const { db } = makeFakeDb();
  await assert.rejects(
    setPolicy({ db, name: 'pkg-a', timeoutMs: 500, writeAudit: async () => {} }),
    /timeoutMs.*1000/
  );
});

test('setPolicy rejects scope not in enum', async () => {
  const { db } = makeFakeDb();
  await assert.rejects(
    setPolicy({ db, name: 'pkg-a', scope: 'host:X', writeAudit: async () => {} }),
    /scope.*global|agent_type:ad|agent_type:non-ad/
  );
});

test('deleteScript cascade — script gone, audit written', async () => {
  const { db, scriptRows, policyRows } = makeFakeDb({
    existingScripts: [{ name: 'pkg-a' }],
    existingPolicies: [{ name: 'pkg-a' }]
  });
  const auditCalls = [];
  // FK cascade — script delete triggers policy delete (DB-level). But our
  // service also deletes explicitly to be safe under both dialects.
  const r = await deleteScript({ db, name: 'pkg-a', writeAudit: async (a) => auditCalls.push(a) });
  assert.equal(scriptRows.length, 0);
  assert.equal(auditCalls[0].action, 'delete_script');
});

test('SHA256 determinism (same content → same hash)', () => {
  const a = crypto.createHash('sha256').update('hello').digest('hex');
  const b = crypto.createHash('sha256').update('hello').digest('hex');
  assert.equal(a, b);
});

test('SHA256 collision (different content → different hash)', () => {
  const a = crypto.createHash('sha256').update('hello').digest('hex');
  const b = crypto.createHash('sha256').update('world').digest('hex');
  assert.notEqual(a, b);
});
```

### Step 2: Run test (expect import failure)

```bash
cd center && node --test tests/packages/script-service.test.js
```

### Step 3: Implement

`center/src/packages/script-service.js`:

```js
// Script + Policy service — used by admin router + builtin seeder.
// Replaces center/src/packages/installer.js for V1 (installer.js keeps
// its legacy ZIP install path around for V1 transition; DELETE in
// task 10 once router + seeder migrate).

import crypto from 'node:crypto';
import { packageScripts } from '../db/sql/package-scripts.js';
import { packagePolicies } from '../db/sql/package-policies.js';
import { PkgError } from './errors.js';

const MAX_SCRIPT_BYTES = 1024 * 1024; // 1 MB
const VALID_SCOPES = ['global', 'agent_type:ad', 'agent_type:non-ad'];

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function validateScriptBody(content) {
  if (typeof content !== 'string') throw new PkgError('script content must be string', 'INVALID_CONTENT');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_SCRIPT_BYTES) {
    throw new PkgError(`script too large (${bytes} > ${MAX_SCRIPT_BYTES})`, 'SCRIPT_TOO_LARGE');
  }
}

function validateName(name) {
  if (!/^[a-z0-9][a-z0-9_-]{2,127}$/i.test(name)) {
    throw new PkgError(`invalid package name: ${name}`, 'INVALID_NAME');
  }
}

function buildManifest({ name, type, agentType, description }) {
  return {
    name,
    version: '1.0.0',
    type,
    description: description || '',
    schemaVersion: 1,
    agent: {
      type: agentType,
      script: 'collect.ps1'
      // NOTE: intervalSec and timeoutMs live in package_policies V1+
    }
  };
}

export async function installScript({ db, name, content, type, agentType, description, intervalSec, timeoutMs, source = 'admin-upload', writeAudit }) {
  validateName(name);
  validateScriptBody(content);
  if (!['gauge', 'counter', 'status', 'timeseries'].includes(type)) {
    throw new PkgError(`invalid type: ${type}`, 'INVALID_TYPE');
  }
  if (!['ad', 'non-ad'].includes(agentType)) {
    throw new PkgError(`invalid agentType: ${agentType}`, 'INVALID_AGENT_TYPE');
  }

  const existing = await packageScripts.get(db, name);
  if (existing) {
    throw new PkgError(`package '${name}' already exists`, 'PACKAGE_EXISTS');
  }

  const scriptSha = sha256Hex(Buffer.from(content, 'utf8'));
  const manifest = buildManifest({ name, type, agentType, description });

  // 1. INSERT script
  await packageScripts.upsert(db, {
    name, version: manifest.version,
    scriptContent: content, scriptSha256: scriptSha,
    manifest, source
  });
  // 2. INSERT policy (default enabled=false so the operator can review before running)
  await packagePolicies.upsert(db, {
    name,
    intervalSec: intervalSec ?? 3600,
    timeoutMs: timeoutMs ?? 30000,
    enabled: false,
    params: null,
    scope: 'global'
  });

  if (writeAudit) {
    await writeAudit({
      action: 'upload_script',
      targetType: 'packages',
      targetId: name,
      details: { name, scriptSha: scriptSha.slice(0, 8), source }
    });
  }
  return { name, version: manifest.version, scriptSha };
}

export async function editScript({ db, name, content, writeAudit }) {
  validateName(name);
  validateScriptBody(content);

  const existing = await packageScripts.get(db, name);
  if (!existing) {
    throw new PkgError(`package '${name}' not found`, 'PACKAGE_NOT_FOUND');
  }

  const newSha = sha256Hex(Buffer.from(content, 'utf8'));
  if (newSha === existing.scriptSha256) {
    // No-op — same content. Skip audit + skip UPDATE to avoid noise.
    return { name, oldSha: existing.scriptSha256, newSha, updatedAt: existing.updatedAt, noOp: true };
  }

  const oldSha = existing.scriptSha256;
  await packageScripts.updateScript(db, { name, scriptContent: content, scriptSha256: newSha });

  if (writeAudit) {
    await writeAudit({
      action: 'edit_script',
      targetType: 'packages',
      targetId: name,
      details: { name, oldSha: oldSha.slice(0, 8), newSha: newSha.slice(0, 8) }
    });
  }
  return { name, oldSha, newSha, updatedAt: new Date(), noOp: false };
}

export async function setPolicy({ db, name, intervalSec, timeoutMs, enabled, params, scope, writeAudit }) {
  validateName(name);

  const fields = {};
  if (intervalSec !== undefined) {
    const n = Number(intervalSec);
    if (!Number.isInteger(n) || n < 5 || n > 86400) {
      throw new PkgError(`intervalSec must be integer 5..86400 (got ${n})`, 'INVALID_INTERVAL');
    }
    fields.intervalSec = n;
  }
  if (timeoutMs !== undefined) {
    const n = Number(timeoutMs);
    if (!Number.isInteger(n) || n < 1000 || n > 600000) {
      throw new PkgError(`timeoutMs must be integer 1000..600000 (got ${n})`, 'INVALID_TIMEOUT');
    }
    fields.timeoutMs = n;
  }
  if (enabled !== undefined) fields.enabled = !!enabled;
  if (params !== undefined) fields.params = params;
  if (scope !== undefined) {
    if (!VALID_SCOPES.includes(scope)) {
      throw new PkgError(`scope must be one of ${VALID_SCOPES.join('|')} (got '${scope}')`, 'INVALID_SCOPE');
    }
    fields.scope = scope;
  }
  if (Object.keys(fields).length === 0) {
    throw new PkgError('setPolicy: no fields provided', 'EMPTY_POLICY');
  }

  await packagePolicies.updatePartial(db, name, fields);

  if (writeAudit) {
    await writeAudit({
      action: 'set_policy',
      targetType: 'packages',
      targetId: name,
      details: { name, fields: Object.keys(fields) }
    });
  }
  return { name, fields, updatedAt: new Date() };
}

export async function deleteScript({ db, name, writeAudit }) {
  validateName(name);
  const existing = await packageScripts.get(db, name);
  if (!existing) {
    throw new PkgError(`package '${name}' not found`, 'PACKAGE_NOT_FOUND');
  }
  // Delete from BOTH tables explicitly (FK cascade handles policy under
  // MySQL but not always under MSSQL if the FK is set with NO ACTION; the
  // explicit DELETE is the safe universal path).
  await packagePolicies.delete(db, name);
  await packageScripts.delete(db, name);

  if (writeAudit) {
    await writeAudit({
      action: 'delete_script',
      targetType: 'packages',
      targetId: name,
      details: { name, deleted: { script: true, policy: true } }
    });
  }
  return { name, deleted: { script: true, policy: true } };
}

export const __testHelpers = {
  buildManifest, validateName, validateScriptBody, VALID_SCOPES, MAX_SCRIPT_BYTES
};
```

### Step 4: Run test

```bash
cd center && node --test tests/packages/script-service.test.js
# Expect: 14 pass
```

### Step 5: Mirror

```bash
cp center/src/packages/script-service.js publish/system/center/src/packages/
cp center/tests/packages/script-service.test.js publish/system/center/tests/packages/
pwsh -NoProfile -File installer/verify-mirror.ps1
```

### Step 6: Commit

```bash
git add center/src/packages/script-service.js \
        center/tests/packages/script-service.test.js \
        publish/system/center/src/packages/script-service.js \
        publish/system/center/tests/packages/script-service.test.js
git commit -m "feat(r66): script-service — installScript/editScript/setPolicy/deleteScript + audit"
```

**Done when:** All 14 tests pass; service ready for router + seeder.

**Complexity:** medium.

---

## Task 6 — audit-classifier additions (5 entries)

**Files:**
- Modify: `center/src/services/audit-classifier.js` — add 5 entries each to ACTION_CATEGORY / ACTION_SEVERITY / ACTION_LABEL maps
- Modify: `center/tests/audit-classifier.test.js` — assert the 5 new keys are mapped
- Mirror all

### Step 1: Write the failing test (in the existing classifier test file)

If `center/tests/audit-classifier.test.js` exists, add to it:

```js
import { classifyAction, ACTION_CATEGORY, ACTION_SEVERITY, ACTION_LABEL } from '../src/services/audit-classifier.js';

test('classifies the 5 new R66 package audit actions', () => {
  const expected = ['upload_script', 'edit_script', 'set_policy', 'delete_script', 'bulk_migrate'];
  for (const k of expected) {
    const r = classifyAction(k);
    assert.ok(ACTION_CATEGORY.has(k), `${k} missing from CATEGORY`);
    assert.ok(ACTION_SEVERITY.has(k), `${k} missing from SEVERITY`);
    assert.ok(ACTION_LABEL.has(k), `${k} missing from LABEL`);
    assert.equal(typeof r.label, 'string');
  }
});

test('package actions are category=changes and severity not low', () => {
  for (const k of ['upload_script', 'edit_script', 'set_policy', 'delete_script']) {
    assert.equal(ACTION_CATEGORY.get(k), 'changes');
    assert.notEqual(ACTION_SEVERITY.get(k), 'low');
  }
});
```

### Step 2: Run test (expect 5 new actions fail classification)

### Step 3: Update `center/src/services/audit-classifier.js`

Insert at the end of each map (before the closing `])`):

```js
  // 2026-08-29 R66 — package management replace. The 4 main actions
  // (upload/edit/set_policy/delete_script) are operator-initiated
  // changes to either the script body or execution policy; bulk_migrate
  // is a one-time migration row emitted by the data migration step.
  // All are 'changes' category because they mutate package_scripts /
  // package_policies rows. delete_script is 'medium' severity (a
  // mis-click wipes the script and all its history). The others are
  // 'low' severity (data-bearing but recoverable — old sha is in audit).
  ['upload_script',   'changes'],
  ['edit_script',     'changes'],
  ['set_policy',      'changes'],
  ['delete_script',   'changes'],
  ['bulk_migrate',    'changes']
```

And for SEVERITY:

```js
  ['upload_script',   'low'],
  ['edit_script',     'low'],
  ['set_policy',      'low'],
  ['delete_script',   'medium'],
  ['bulk_migrate',    'info']
```

And for LABEL (Chinese labels to match the surrounding taxonomy):

```js
  ['upload_script',   '上传脚本'],
  ['edit_script',     '编辑脚本'],
  ['set_policy',      '设置执行策略'],
  ['delete_script',   '删除脚本'],
  ['bulk_migrate',    '批量迁移脚本']
```

### Step 4: Run test (expect pass)

```bash
cd center && node --test tests/audit-classifier.test.js
```

### Step 5: Mirror

```bash
cp center/src/services/audit-classifier.js publish/system/center/src/services/
cp center/tests/audit-classifier.test.js publish/system/center/tests/
pwsh -NoProfile -File installer/verify-mirror.ps1
```

### Step 6: Commit

```bash
git add center/src/services/audit-classifier.js \
        center/tests/audit-classifier.test.js \
        publish/system/center/src/services/audit-classifier.js \
        publish/system/center/tests/audit-classifier.test.js
git commit -m "feat(r66): audit-classifier — 5 new package actions (upload/edit/set_policy/delete_script/bulk_migrate)"
```

**Done when:** Tests pass; all 3 maps have the new keys; mirror clean.

**Complexity:** trivial.

---

## Task 7 — admin router rewrite (9 endpoints)

**Files:**
- Modify: `center/src/packages/router.js` — REWRITE to use script-service
- Modify: `center/tests/packages/router.test.js` — REWRITE for 9 endpoints
- Mirror both

**Interfaces:**
- Produces: 9 admin endpoints + AJV schemas for input validation.
- Consumes: `script-service` (Task 5) + `packageScripts.list`/`get`/`delete` (Task 3) + `packagePolicies.list`/`listEnabled` (Task 4).

### Step 1: Write the failing tests (~20)

`center/tests/packages/router.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createPackagesRouter } from '../../src/packages/router.js';

// Fake services + db
function buildApp() {
  const scripts = new Map();
  const policies = new Map();
  const auditCalls = [];
  const db = {
    dialect: 'mysql',
    async execute(sql, params) {
      const t = sql.trim();
      if (t.startsWith('SELECT * FROM package_scripts')) {
        const name = params[0];
        if (name) {
          const s = scripts.get(name);
          return { rows: s ? [{ name: s.name, version: s.version, script_sha256: s.scriptSha256, manifest_json: JSON.stringify(s.manifest), source: s.source, created_at: s.createdAt, updated_at: s.updatedAt, script_content: s.content }] : [] };
        }
        return { rows: [...scripts.values()].map(s => ({ name: s.name, version: s.version, script_sha256: s.scriptSha256, manifest_json: JSON.stringify(s.manifest), source: s.source, created_at: s.createdAt, updated_at: s.updatedAt, script_content: s.content })) };
      }
      if (t.startsWith('SELECT * FROM package_policies')) {
        const name = params[0];
        if (name) {
          const p = policies.get(name);
          return { rows: p ? [{ name: p.name, interval_sec: p.intervalSec, timeout_ms: p.timeoutMs, enabled: p.enabled ? 1 : 0, params_json: p.params == null ? null : JSON.stringify(p.params), scope: p.scope, created_at: p.createdAt, updated_at: p.updatedAt }] : [] };
        }
        return { rows: [...policies.values()].map(p => ({ name: p.name, interval_sec: p.intervalSec, timeout_ms: p.timeoutMs, enabled: p.enabled ? 1 : 0, params_json: p.params == null ? null : JSON.stringify(p.params), scope: p.scope, created_at: p.createdAt, updated_at: p.updatedAt })) };
      }
      if (t.startsWith('INSERT INTO package_scripts')) {
        scripts.set(params[0], { name: params[0], version: params[1], content: params[2], scriptSha256: params[3], manifest: JSON.parse(params[4]), source: params[5], createdAt: params[6], updatedAt: params[7] });
      }
      if (t.startsWith('INSERT INTO package_policies')) {
        policies.set(params[0], { name: params[0], intervalSec: params[1], timeoutMs: params[2], enabled: !!params[3], params: params[4] == null ? null : JSON.parse(params[4]), scope: params[5], createdAt: params[6], updatedAt: params[7] });
      }
      if (t.startsWith('UPDATE package_scripts SET script_content')) {
        const s = scripts.get(params[3]);
        if (s) { s.content = params[0]; s.scriptSha256 = params[1]; s.updatedAt = params[2]; }
      }
      if (t.startsWith('UPDATE package_policies SET')) {
        const p = policies.get(params[params.length - 1]);
        if (p) p.updatedAt = params[params.length - 2];
      }
      if (t.startsWith('DELETE FROM package_scripts')) {
        scripts.delete(params[0]);
      }
      if (t.startsWith('DELETE FROM package_policies')) {
        policies.delete(params[0]);
      }
      return { rows: [] };
    }
  };
  const writeAudit = async (args) => auditCalls.push(args);
  const router = createPackagesRouter({ db, writeAudit, adminAuth: (req, res, next) => { req.user = { role: 'admin' }; next(); } });
  const app = express();
  app.use(express.json());
  app.use(router);
  return { app, scripts, policies, auditCalls };
}

// Shared upload helper
async function uploadPkg(app, name = 'pkg-a', body = {}) {
  return request(app).post('/api/admin/packages/upload-script').send({
    name, content: 'Write-Host hi', type: 'gauge', agentType: 'ad',
    description: 'test', intervalSec: 3600, timeoutMs: 30000, ...body
  });
}

test('GET /api/admin/packages returns empty initially', async () => {
  const { app } = buildApp();
  const r = await request(app).get('/api/admin/packages');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { items: [] });
});

test('POST /upload-script creates script + default policy', async () => {
  const { app, scripts, policies } = buildApp();
  const r = await uploadPkg(app, 'pkg-a');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.match(r.body.scriptSha, /^[0-9a-f]{64}$/);
  assert.equal(scripts.size, 1);
  assert.equal(policies.size, 1);
  assert.equal(policies.get('pkg-a').enabled, false);
});

test('POST /upload-script 400 on missing name', async () => {
  const { app } = buildApp();
  const r = await request(app).post('/api/admin/packages/upload-script').send({
    content: 'x', type: 'gauge', agentType: 'ad', description: 't', intervalSec: 60, timeoutMs: 1000
  });
  assert.equal(r.status, 400);
});

test('POST /upload-script 400 on oversized content (>1 MB)', async () => {
  const { app } = buildApp();
  const r = await uploadPkg(app, 'pkg-x', { content: 'x'.repeat(1024 * 1024 + 1) });
  assert.equal(r.status, 400);
});

test('PUT /:name/script updates content + sha', async () => {
  const { app, scripts } = buildApp();
  await uploadPkg(app, 'pkg-a');
  const r = await request(app).put('/api/admin/packages/pkg-a/script').send({ content: 'Write-Host new' });
  assert.equal(r.status, 200);
  assert.notEqual(r.body.newSha, r.body.oldSha);
  assert.match(scripts.get('pkg-a').scriptSha256, /^[0-9a-f]{64}$/);
});

test('PUT /:name/policy partial body only updates present fields', async () => {
  const { app, policies } = buildApp();
  await uploadPkg(app, 'pkg-a');
  const r = await request(app).put('/api/admin/packages/pkg-a/policy').send({ intervalSec: 60 });
  assert.equal(r.status, 200);
  assert.equal(policies.get('pkg-a').intervalSec, 60);
  assert.equal(policies.get('pkg-a').timeoutMs, 30000);
});

test('PUT /:name/policy 400 on invalid intervalSec', async () => {
  const { app } = buildApp();
  await uploadPkg(app, 'pkg-a');
  const r = await request(app).put('/api/admin/packages/pkg-a/policy').send({ intervalSec: 1 });
  assert.equal(r.status, 400);
});

test('PUT /:name/enable sets enabled=true', async () => {
  const { app, policies } = buildApp();
  await uploadPkg(app, 'pkg-a');
  const r = await request(app).put('/api/admin/packages/pkg-a/enable');
  assert.equal(r.status, 200);
  assert.equal(policies.get('pkg-a').enabled, true);
});

test('PUT /:name/disable sets enabled=false', async () => {
  const { app, policies } = buildApp();
  await uploadPkg(app, 'pkg-a');
  await request(app).put('/api/admin/packages/pkg-a/enable');
  const r = await request(app).put('/api/admin/packages/pkg-a/disable');
  assert.equal(policies.get('pkg-a').enabled, false);
});

test('DELETE /:name cascade deletes both rows', async () => {
  const { app, scripts, policies } = buildApp();
  await uploadPkg(app, 'pkg-a');
  const r = await request(app).delete('/api/admin/packages/pkg-a');
  assert.equal(r.status, 200);
  assert.equal(r.body.deleted.script, true);
  assert.equal(r.body.deleted.policy, true);
  assert.equal(scripts.size, 0);
  assert.equal(policies.size, 0);
});

test('Auth: each new endpoint requires admin (returns 401/403 without auth)', async () => {
  const db = {
    dialect: 'mysql',
    async execute() { return { rows: [] }; }
  };
  const router = createPackagesRouter({
    db, writeAudit: async () => {},
    adminAuth: (req, res) => res.status(403).json({ error: 'forbidden' })
  });
  const app = express();
  app.use(express.json());
  app.use(router);
  const r1 = await request(app).get('/api/admin/packages');
  const r2 = await request(app).post('/api/admin/packages/upload-script').send({});
  assert.equal(r1.status, 403);
  assert.equal(r2.status, 403);
});
```

### Step 2: Run test (expect import failure — current router doesn't export `createPackagesRouter`)

### Step 3: Implement the new router

`center/src/packages/router.js`:

```js
// Admin REST endpoints for package management. Replaces the
// package-ZIP installer flow with raw-PS1 upload + policy edit.
//
// All routes require admin:users. The script-service is the only
// authoritative DB-touching layer — this file just routes.

import express from 'express';
import Ajv from 'ajv';
import { packageScripts } from '../db/sql/package-scripts.js';
import { packagePolicies } from '../db/sql/package-policies.js';
import { installScript, editScript, setPolicy, deleteScript } from './script-service.js';
import { PkgError } from './errors.js';

const UPLOAD_SCHEMA = {
  type: 'object',
  required: ['name', 'content', 'type', 'agentType', 'description', 'intervalSec', 'timeoutMs'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 3, maxLength: 128, pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]*$' },
    content: { type: 'string', minLength: 1, maxLength: 1024 * 1024 },
    type: { enum: ['gauge', 'counter', 'status', 'timeseries'] },
    agentType: { enum: ['ad', 'non-ad'] },
    description: { type: 'string', maxLength: 1024 },
    intervalSec: { type: 'integer', minimum: 5, maximum: 86400 },
    timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000 }
  }
};

const SCRIPT_EDIT_SCHEMA = {
  type: 'object',
  required: ['content'],
  additionalProperties: false,
  properties: { content: { type: 'string', minLength: 1, maxLength: 1024 * 1024 } }
};

const POLICY_UPDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    intervalSec: { type: 'integer', minimum: 5, maximum: 86400 },
    timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000 },
    enabled: { type: 'boolean' },
    params: { type: ['object', 'null'] },
    scope: { enum: ['global', 'agent_type:ad', 'agent_type:non-ad'] }
  }
};

const ajv = new Ajv({ allErrors: true });

function badRequest(res, msg, errors) {
  return res.status(400).json({ error: msg, details: errors });
}

function notFound(res, msg) {
  return res.status(404).json({ error: msg });
}

function serverError(res, e, log) {
  if (log) log.error({ err: e }, 'packages route failed');
  return res.status(500).json({ error: 'internal' });
}

export function createPackagesRouter({ db, writeAudit, adminAuth, getLogger }) {
  const r = express.Router();
  const log = getLogger ? getLogger() : null;

  // Apply admin auth to every route in this router
  r.use('/api/admin/packages', adminAuth);

  // GET /api/admin/packages — JOIN both tables
  r.get('/api/admin/packages', async (req, res) => {
    try {
      const scripts = await packageScripts.list(db);
      const policies = await packagePolicies.list(db);
      const policyByName = new Map(policies.map(p => [p.name, p]));
      const items = scripts.map(s => {
        const p = policyByName.get(s.name) || {};
        return {
          name: s.name,
          version: s.version,
          type: s.manifest?.type || 'gauge',
          agentType: s.manifest?.agent?.type || 'ad',
          enabled: !!p.enabled,
          intervalSec: p.intervalSec ?? null,
          timeoutMs: p.timeoutMs ?? null,
          params: p.params ?? null,
          scope: p.scope ?? 'global',
          source: s.source,
          scriptSha256: s.scriptSha256,
          manifest: s.manifest,
          updatedAt: s.updatedAt
        };
      });
      res.json({ items });
    } catch (e) {
      serverError(res, e, log);
    }
  });

  // POST /api/admin/packages/upload-script
  r.post('/api/admin/packages/upload-script', async (req, res) => {
    try {
      const valid = ajv.validate(UPLOAD_SCHEMA, req.body || {});
      if (!valid) return badRequest(res, 'invalid body', ajv.errors);
      const result = await installScript({ db, writeAudit, ...req.body, source: 'admin-upload' });
      res.json({ ok: true, ...result });
    } catch (e) {
      if (e instanceof PkgError && e.code === 'PACKAGE_EXISTS') return badRequest(res, e.message);
      if (e instanceof PkgError) return badRequest(res, e.message);
      serverError(res, e, log);
    }
  });

  // PUT /api/admin/packages/:name/script
  r.put('/api/admin/packages/:name/script', async (req, res) => {
    try {
      const valid = ajv.validate(SCRIPT_EDIT_SCHEMA, req.body || {});
      if (!valid) return badRequest(res, 'invalid body', ajv.errors);
      const result = await editScript({ db, writeAudit, name: req.params.name, content: req.body.content });
      if (result.noOp) return res.json({ ok: true, ...result, noOp: true });
      res.json({ ok: true, ...result });
    } catch (e) {
      if (e instanceof PkgError && e.code === 'PACKAGE_NOT_FOUND') return notFound(res, e.message);
      if (e instanceof PkgError) return badRequest(res, e.message);
      serverError(res, e, log);
    }
  });

  // PUT /api/admin/packages/:name/policy
  r.put('/api/admin/packages/:name/policy', async (req, res) => {
    try {
      const valid = ajv.validate(POLICY_UPDATE_SCHEMA, req.body || {});
      if (!valid) return badRequest(res, 'invalid body', ajv.errors);
      const result = await setPolicy({ db, writeAudit, name: req.params.name, ...req.body });
      res.json({ ok: true, ...result });
    } catch (e) {
      if (e instanceof PkgError) return badRequest(res, e.message);
      serverError(res, e, log);
    }
  });

  // PUT /api/admin/packages/:name/enable
  r.put('/api/admin/packages/:name/enable', async (req, res) => {
    try {
      const result = await setPolicy({ db, writeAudit, name: req.params.name, enabled: true });
      res.json({ ok: true, name: req.params.name, enabled: true, ...result });
    } catch (e) {
      if (e instanceof PkgError) return badRequest(res, e.message);
      serverError(res, e, log);
    }
  });

  // PUT /api/admin/packages/:name/disable
  r.put('/api/admin/packages/:name/disable', async (req, res) => {
    try {
      const result = await setPolicy({ db, writeAudit, name: req.params.name, enabled: false });
      res.json({ ok: true, name: req.params.name, enabled: false, ...result });
    } catch (e) {
      if (e instanceof PkgError) return badRequest(res, e.message);
      serverError(res, e, log);
    }
  });

  // DELETE /api/admin/packages/:name
  r.delete('/api/admin/packages/:name', async (req, res) => {
    try {
      const result = await deleteScript({ db, writeAudit, name: req.params.name });
      res.json({ ok: true, ...result });
    } catch (e) {
      if (e instanceof PkgError && e.code === 'PACKAGE_NOT_FOUND') return notFound(res, e.message);
      serverError(res, e, log);
    }
  });

  return r;
}
```

### Step 4: Update mount in `center/server.js` (or wherever packagesRouter is wired)

Find:

```js
import { packagesRouter } from './packages/router.js';
// or similar
app.use(packagesRouter(...));
```

Replace with:

```js
import { createPackagesRouter } from './packages/router.js';
app.use(createPackagesRouter({ db, writeAudit, adminAuth, getLogger }));
```

The mount-order rule from memory feedback applies: this router must be mounted BEFORE the SPA fallback in `center/server.js` (or risk `/api/admin/packages/...` returning the index.html).

### Step 5: Update the legacy `packagesRouter` default-export if other callers depend on it

If anything else still imports the default `packagesRouter` function (e.g. `installPackage` ZIP upload endpoint), keep it as a thin wrapper that delegates to `createPackagesRouter` + adds the legacy ZIP route on top. Then Task 10 deletes the ZIP endpoint cleanly.

```js
// At the bottom of router.js — keep for backward compat:
export function packagesRouter(opts) {
  const base = createPackagesRouter(opts);
  // No legacy ZIP routes in V1 — V0 ZIP install is gone.
  return base;
}
```

### Step 6: Run tests

```bash
cd center && node --test tests/packages/router.test.js
# Expect: 11 pass
```

### Step 7: Mirror

```bash
cp center/src/packages/router.js publish/system/center/src/packages/
cp center/tests/packages/router.test.js publish/system/center/tests/packages/
cp center/server.js publish/system/center/server.js
pwsh -NoProfile -File installer/verify-mirror.ps1
```

### Step 8: Commit

```bash
git add center/src/packages/router.js \
        center/server.js \
        center/tests/packages/router.test.js \
        publish/system/center/src/packages/router.js \
        publish/system/center/server.js \
        publish/system/center/tests/packages/router.test.js
git commit -m "refactor(r66): admin router rewritten — 9 endpoints on script-service, no more ZIP upload"
```

**Done when:** 11 router tests pass; server.js wired; mirror clean.

**Complexity:** medium (most code is mechanical; risk is server.js mount-order).

---

## Task 8 — runner.js JOIN update (preserve agent protocol)

**Files:**
- Modify: `center/src/packages/runner.js` — JOIN two tables instead of reading disk
- Modify: `center/tests/packages/runner.test.js` — assert byte-identical response shape vs R6 baseline
- Mirror both

### Step 1: Write the failing test

`center/tests/packages/runner.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { packageRunner } from '../../src/packages/runner.js';

test('GET /api/agent/packages returns R6-shaped response with script b64 + manifest baked intervalSec/timeoutMs', async () => {
  const db = {
    dialect: 'mysql',
    async execute(sql, params) {
      const t = sql.trim();
      if (t.startsWith('SELECT') && t.includes('package_scripts') && t.includes('package_policies')) {
        // JOIN result — one row
        return { rows: [{
          name: 'pkg-a', version: '1.0.0',
          script_content: 'Write-Host hi',
          script_sha256: 'a'.repeat(64),
          manifest_json: '{"name":"pkg-a","version":"1.0.0","type":"gauge","agent":{"type":"ad","script":"collect.ps1"}}',
          source: 'builtin-seed',
          interval_sec: 3600, timeout_ms: 30000, enabled: 1,
          params_json: null, scope: 'global'
        }] };
      }
      if (t.startsWith('SELECT') && t.includes('package_scripts')) {
        return { rows: [{
          name: 'pkg-a', version: '1.0.0',
          script_content: 'Write-Host hi',
          script_sha256: 'a'.repeat(64),
          manifest_json: '{"name":"pkg-a","version":"1.0.0","type":"gauge","agent":{"type":"ad","script":"collect.ps1"}}'
        }] };
      }
      if (t.startsWith('SELECT') && t.includes('package_policies')) {
        return { rows: [{ name: 'pkg-a', enabled: 1, interval_sec: 3600, timeout_ms: 30000 }] };
      }
      return { rows: [] };
    }
  };
  const agentMw = (req, res, next) => { req.agentId = 'mock-agent'; next(); };
  const runner = packageRunner({ db, agentMw, getLogger: () => null });
  const app = express();
  app.use(runner);
  const r = await request(app).get('/api/agent/packages');
  assert.equal(r.status, 200);
  const pkg = r.body.packages[0];
  // R6 shape contract:
  assert.equal(pkg.name, 'pkg-a');
  assert.equal(pkg.version, '1.0.0');
  assert.deepEqual(pkg.manifest, { name: 'pkg-a', version: '1.0.0', type: 'gauge', agent: { type: 'ad', script: 'collect.ps1', intervalSec: 3600, timeoutMs: 30000 } });
  // intervalSec + timeoutMs MUST be baked into manifest.agent so the agent sees the same shape
  assert.equal(pkg.manifest.agent.intervalSec, 3600);
  assert.equal(pkg.manifest.agent.timeoutMs, 30000);
  // script is base64
  const decoded = Buffer.from(pkg.script, 'base64').toString('utf8');
  assert.equal(decoded, 'Write-Host hi');
  // params at top level
  assert.equal(pkg.params, null);
});
```

### Step 2: Run test (expect import failure — `packageRunner` signature)

The current `packageRunner` uses `agentToken({ db, logger })` internally; new signature takes `agentMw` directly (more flexible for tests).

### Step 3: Implement the new runner

`center/src/packages/runner.js`:

```js
// Agent-facing REST endpoints for package execution. The shape of every
// response is BYTE-IDENTICAL to the V0 (`installed_packages` on-disk)
// implementation — existing in-field agents do not need a code change.
// The implementation now joins package_scripts + package_policies at
// request time and bakes intervalSec + timeoutMs into
// manifest.agent.{intervalSec,timeoutMs} so the agent receives the
// same shape regardless of which table the values live in.

import express from 'express';
import { packageScripts } from '../db/sql/package-scripts.js';
import { packagePolicies } from '../db/sql/package-policies.js';
import { packageRuns } from '../db/sql/package-runs.js';
import { metricstore } from './metricstore.js';
import { PkgError } from './errors.js';

const STDOUT_PREVIEW_LIMIT = 2048;
const STDERR_PREVIEW_LIMIT = 2048;

const JOIN_SELECT_MYSQL = `SELECT s.name, s.version, s.script_content, s.script_sha256,
  s.manifest_json, s.source, s.created_at, s.updated_at,
  p.interval_sec, p.timeout_ms, p.enabled, p.params_json, p.scope
FROM package_policies p
INNER JOIN package_scripts s ON s.name = p.name
WHERE p.enabled = 1
ORDER BY s.name`;

const JOIN_SELECT_MSSQL = `SELECT s.name, s.version, s.script_content, s.script_sha256,
  s.manifest_json, s.source, s.created_at, s.updated_at,
  p.interval_sec, p.timeout_ms, p.enabled, p.params_json, p.scope
FROM package_policies p
INNER JOIN package_scripts s ON s.name = p.name
WHERE p.enabled = 1
ORDER BY s.name`;

function bakeManifest(row) {
  const manifest = typeof row.manifest_json === 'string' ? JSON.parse(row.manifest_json) : row.manifest_json;
  // Bake intervalSec + timeoutMs from the policy row into the manifest.agent block.
  // The agent reads manifest.agent.intervalSec + manifest.agent.timeoutMs unchanged from V0.
  const baked = JSON.parse(JSON.stringify(manifest));
  baked.agent = baked.agent || {};
  baked.agent.intervalSec = Number(row.interval_sec);
  baked.agent.timeoutMs = Number(row.timeout_ms);
  return baked;
}

function hydrateJoinRow(row) {
  const parseJson = (v) => v == null ? null : (typeof v === 'string' ? JSON.parse(v) : v);
  return {
    name: row.name,
    version: row.version,
    script: Buffer.from(row.script_content, 'utf8').toString('base64'),
    manifest: bakeManifest(row),
    params: parseJson(row.params_json)
  };
}

export function packageRunner({ db, agentMw, getLogger, config }) {
  const r = express.Router();

  // GET /api/agent/packages — JOIN both tables, only enabled policies
  r.get('/api/agent/packages', agentMw, async (req, res) => {
    try {
      const sql = db.dialect === 'mssql' ? JOIN_SELECT_MSSQL : JOIN_SELECT_MYSQL;
      const { rows } = await db.execute(sql, []);
      const packages = rows.map(hydrateJoinRow);
      res.json({ packages });
    } catch (e) {
      const log = getLogger ? getLogger() : null;
      if (log) log.error({ err: e }, 'agent packages list failed');
      res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: e.message } });
    }
  });

  // GET /api/agent/packages/:name/script — single fetch (script only)
  r.get('/api/agent/packages/:name/script', agentMw, async (req, res) => {
    try {
      const scriptRow = await packageScripts.get(db, req.params.name);
      const policyRow = await packagePolicies.getByName(db, req.params.name);
      if (!scriptRow || !policyRow || !policyRow.enabled) {
        return res.status(404).json({ error: 'not found' });
      }
      const scriptB64 = Buffer.from(scriptRow.scriptContent, 'utf8').toString('base64');
      res.json({ name: scriptRow.name, version: scriptRow.version, script: scriptB64 });
    } catch (e) {
      const log = getLogger ? getLogger() : null;
      if (log) log.error({ err: e }, 'agent package script fetch failed');
      res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: e.message } });
    }
  });

  // POST /api/agent/packages/report — unchanged
  r.post('/api/agent/packages/report', agentMw, async (req, res) => {
    const { runs } = req.body || {};
    if (!Array.isArray(runs)) {
      return res.status(400).json({ error: 'runs must be array' });
    }
    const agentId = req.headers['x-agent-id'] || null;
    const log = getLogger ? getLogger() : null;
    if (log) log.info({
      event: 'agent.packages.report',
      source: req.body?.source ?? 'unknown',
      agentId,
      runsCount: runs.length,
      packages: runs.map(r => `${r.packageName}:${r.exitCode ?? 'n/a'}`).slice(0, 20)
    }, 'agent packages report received');

    const result = { processed: 0, errors: [] };
    for (const run of runs) {
      try {
        const scriptRow = await packageScripts.get(db, run.packageName);
        if (!scriptRow) {
          result.errors.push({ packageName: run.packageName, error: 'package not installed' });
          continue;
        }
        await packageRuns.insert(db, {
          agentId,
          packageName: run.packageName,
          startedAt: new Date(run.startedAt),
          finishedAt: run.finishedAt ? new Date(run.finishedAt) : null,
          exitCode: run.exitCode ?? null,
          stdoutPreview: run.metrics ? JSON.stringify(run.metrics).slice(0, STDOUT_PREVIEW_LIMIT) : null,
          stderrPreview: run.stderr ? run.stderr.slice(0, STDERR_PREVIEW_LIMIT) : null,
          error: run.error ?? null
        });
        if (run.metrics && !run.error) {
          await metricstore.ingestRun(db, {
            agentId,
            packageName: run.packageName,
            manifest: scriptRow.manifest,
            runs: [run]
          });
        }
        result.processed++;
      } catch (e) {
        result.errors.push({ packageName: run.packageName, error: e.message });
      }
    }
    res.json(result);
  });

  return r;
}
```

### Step 4: Update the call site in `center/server.js`

The new signature takes `agentMw` (already-resolved middleware) instead of `agentToken({ db, logger })`:

```js
import { agentToken } from './auth/agent-token.js';
import { packageRunner } from './packages/runner.js';

// ...
const agentMw = agentToken({ db, logger });
app.use(packageRunner({ db, agentMw, getLogger: () => logger }));
```

### Step 5: Run tests

```bash
cd center && node --test tests/packages/runner.test.js
# Expect: pass — shape contract holds
```

### Step 6: Mirror

```bash
cp center/src/packages/runner.js publish/system/center/src/packages/
cp center/tests/packages/runner.test.js publish/system/center/tests/packages/
cp center/server.js publish/system/center/server.js
pwsh -NoProfile -File installer/verify-mirror.ps1
```

### Step 7: Commit

```bash
git add center/src/packages/runner.js \
        center/server.js \
        center/tests/packages/runner.test.js \
        publish/system/center/src/packages/runner.js \
        publish/system/center/server.js \
        publish/system/center/tests/packages/runner.test.js
git commit -m "feat(r66): runner.js JOIN — preserve byte-identical agent response shape"
```

**Done when:** Runner test passes; server.js wires `agentMw` correctly; mirror clean.

**Complexity:** small (the JOIN is mechanical; the bake logic is the only nuance).

---

## Task 9 — builtin-seeder switch + installer.js deletion

**Files:**
- Modify: `center/src/services/builtin-packages.js` — replace `installedPackages.upsert` with `script-service.installScript` + `script-service.setPolicy`
- Delete: `center/src/packages/installer.js`
- Modify: any remaining importer of `installer.js` (use `grep` to find)
- Mirror all

### Step 1: Grep for installer.js consumers

```bash
cd center
grep -r "from './installer'" src/ tests/ web/ 2>/dev/null
grep -r "from '../packages/installer'" src/ tests/ web/ 2>/dev/null
grep -r "installer.js" src/ tests/ web/ 2>/dev/null
```

Expected consumers (legacy):
- `center/src/packages/router.js` — Task 7's `packagesRouter` shim
- `center/src/services/builtin-packages.js` — pre-R66 path

Both should be migrated by now. If anything else remains, migrate or delete.

### Step 2: Update `center/src/services/builtin-packages.js`

Find the section that currently does:

```js
if (db && installedPackages) {
  await installedPackages.upsert(db, {
    name: pkg.name, version: pkg.version,
    type: manifest.type || 'gauge', manifest, enabled: true,
    params: null, source: 'builtin-seed'
  });
}
```

Replace with:

```js
if (db) {
  // Use script-service.installScript + setPolicy (V1 path).
  // Built-in packages are seeded as DISABLED (enabled=false) by default
  // — operator must explicitly enable them in the UI. The previous
  // behavior of always-enabling on startup made it impossible to keep a
  // built-in disabled across restarts; V1 keeps that opt-in.
  //
  // However, the operator-facing UX choice is "宽松": built-ins are
  // editable like any other row, so we still call installScript. The
  // `enabled: false` default means the operator has to flip the toggle
  // once after first deploy — and the audit row makes the choice
  // explicit.
  await installScript({
    db,
    writeAudit,
    name: pkg.name,
    content: fs.readFileSync(path.join(target, 'collect.ps1'), 'utf8'),
    type: manifest.type || 'gauge',
    agentType: manifest.agent?.type || 'ad',
    description: manifest.description || '',
    intervalSec: manifest.agent?.intervalSec ?? 3600,
    timeoutMs: manifest.agent?.timeoutMs ?? 30000,
    source: 'builtin-seed'
  });
  // Apply the original built-in enabled state (typically true) AFTER
  // install, so the audit log shows upload then enable as two
  // distinct actions.
  await setPolicy({
    db,
    writeAudit,
    name: pkg.name,
    enabled: true
  });
}
```

Add the import at the top:

```js
import { installScript, setPolicy } from '../packages/script-service.js';
```

And drop the lazy-load:

```js
// REMOVE:
let installedPackages = null;
if (db) {
  ({ installedPackages } = await import('../db/sql/installed-packages.js'));
}
```

### Step 3: Test seeder still produces the 5 built-in rows

`center/tests/services/builtin-packages.test.js` should already exist. Add an assertion that the seeder writes via `script-service`:

```js
// Add inside the existing test:
test('seedBuiltinPackages uses script-service (two-table path)', async () => {
  const writes = { scripts: [], policies: [] };
  const fakeDb = { dialect: 'mysql', execute: async (sql, params) => {
    const t = sql.trim();
    if (t.startsWith('INSERT INTO package_scripts')) writes.scripts.push(params[0]);
    if (t.startsWith('INSERT INTO package_policies')) writes.policies.push(params[0]);
    return { rows: [] };
  }};
  await seedBuiltinPackages({ dataDir: '/tmp/test-data', sourceDir: '/tmp/test-source', writeAudit: async () => {}, db: fakeDb });
  assert.deepEqual(writes.scripts.sort(), ['ad_domain_consistency', 'ad_local_port_check', 'ad_lockout_list', 'ad_lockout_summary', 'ad_os_baseline']);
  assert.deepEqual(writes.policies.sort(), writes.scripts.sort());
});
```

### Step 4: Delete `center/src/packages/installer.js`

```bash
git rm center/src/packages/installer.js
git rm publish/system/center/src/packages/installer.js
```

### Step 5: Run tests

```bash
cd center && node --test tests/services/builtin-packages.test.js tests/packages/script-service.test.js tests/packages/router.test.js
# All green
```

### Step 6: Mirror

```bash
cp center/src/services/builtin-packages.js publish/system/center/src/services/
cp center/tests/services/builtin-packages.test.js publish/system/center/tests/services/
pwsh -NoProfile -File installer/verify-mirror.ps1
```

### Step 7: Commit

```bash
git add center/src/services/builtin-packages.js \
        center/tests/services/builtin-packages.test.js \
        publish/system/center/src/services/builtin-packages.js \
        publish/system/center/tests/services/builtin-packages.test.js
git rm center/src/packages/installer.js publish/system/center/src/packages/installer.js
git commit -m "refactor(r66): builtin-seeder uses script-service; delete installer.js"
```

**Done when:** Seeder test passes; installer.js deleted; nothing else imports it.

**Complexity:** medium (migration risk in seeder; deletion is high-leverage).

---

## Task 10 — frontend: store + 3 modals + PackagesView rewrite

**Files:**
- Modify: `center/web/src/api/packages.js` — REPLACE existing functions with new 5 (`list`, `uploadScript`, `editScript`, `setPolicy`, `deleteScript`)
- Modify: `center/web/src/views/admin/PackagesView.vue` — REWRITE with table + 3 modals
- Modify: `center/web/src/stores/packages.js` — UPDATE actions to call new API
- Create: `center/web/src/components/admin/UploadScriptModal.vue`
- Create: `center/web/src/components/admin/EditScriptModal.vue`
- Create: `center/web/src/components/admin/EditPolicyModal.vue`
- Modify: `center/web/tests/packages-view.test.js` — REWRITE for new UI
- Modify: `center/web/tests/admin-layout.test.js` — bump path count if needed
- Mirror all to `publish/system/center/web/...`

### Step 1: Write the failing tests

`center/web/tests/packages-view.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import PackagesView from '../src/views/admin/PackagesView.vue';
import { packagesApi } from '../src/api/packages.js';

vi.mock('../src/api/packages.js', () => ({
  packagesApi: {
    list: vi.fn(),
    uploadScript: vi.fn(),
    editScript: vi.fn(),
    setPolicy: vi.fn(),
    deleteScript: vi.fn()
  }
}));

describe('PackagesView', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('renders empty state initially', async () => {
    packagesApi.list.mockResolvedValue({ data: { items: [] } });
    const w = mount(PackagesView);
    await flushPromises();
    expect(w.text()).toMatch(/暂无脚本/);
  });

  it('renders 5 builtin scripts', async () => {
    packagesApi.list.mockResolvedValue({ data: { items: [
      { name: 'a', version: '1.0.0', type: 'gauge', enabled: true, intervalSec: 3600, timeoutMs: 30000, source: 'builtin-seed', scriptSha256: 'a'.repeat(64), manifest: { type: 'gauge', agent: { type: 'ad' } } },
      // ... 4 more
    ]}});
    const w = mount(PackagesView);
    await flushPromises();
    expect(w.findAll('tr.script-row')).toHaveLength(5);
  });

  it('clicking + 上传脚本 opens UploadScriptModal', async () => {
    packagesApi.list.mockResolvedValue({ data: { items: [] } });
    const w = mount(PackagesView);
    await flushPromises();
    await w.find('[data-test="upload-btn"]').trigger('click');
    expect(w.find('[data-test="upload-modal"]').exists()).toBe(true);
  });

  it('submitting upload modal calls packagesApi.uploadScript', async () => {
    packagesApi.list.mockResolvedValue({ data: { items: [] } });
    packagesApi.uploadScript.mockResolvedValue({ data: { ok: true, name: 'pkg-a' } });
    const w = mount(PackagesView);
    await flushPromises();
    await w.find('[data-test="upload-btn"]').trigger('click');
    await w.find('[data-test="upload-name-input"]').setValue('pkg-a');
    await w.find('[data-test="upload-content-input"]').setValue('Write-Host hi');
    await w.find('[data-test="upload-submit"]').trigger('click');
    await flushPromises();
    expect(packagesApi.uploadScript).toHaveBeenCalledWith(expect.objectContaining({ name: 'pkg-a' }));
  });

  it('row 删除 button confirms then calls deleteScript', async () => {
    packagesApi.list.mockResolvedValue({ data: { items: [
      { name: 'pkg-a', version: '1.0.0', enabled: true, intervalSec: 3600, timeoutMs: 30000, source: 'admin-upload', scriptSha256: 'a'.repeat(64), manifest: { type: 'gauge', agent: { type: 'ad' } } }
    ]}});
    packagesApi.deleteScript.mockResolvedValue({ data: { ok: true } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const w = mount(PackagesView);
    await flushPromises();
    await w.find('[data-test="delete-pkg-a"]').trigger('click');
    expect(packagesApi.deleteScript).toHaveBeenCalledWith('pkg-a');
  });

  it('row 编辑策略 button opens EditPolicyModal with current values', async () => {
    packagesApi.list.mockResolvedValue({ data: { items: [
      { name: 'pkg-a', enabled: true, intervalSec: 3600, timeoutMs: 30000, source: 'admin-upload', scriptSha256: 'a'.repeat(64), manifest: { type: 'gauge', agent: { type: 'ad' } } }
    ]}});
    const w = mount(PackagesView);
    await flushPromises();
    await w.find('[data-test="edit-policy-pkg-a"]').trigger('click');
    const m = w.find('[data-test="edit-policy-modal"]');
    expect(m.exists()).toBe(true);
    expect(m.find('[data-test="policy-interval"]').element.value).toBe('3600');
  });
});
```

### Step 2: Run test (expect mount failure)

### Step 3: Write the new API module

`center/web/src/api/packages.js`:

```js
import api from './client.js';

export const packagesApi = {
  list: () => api.get('/api/admin/packages'),
  uploadScript: (body) => api.post('/api/admin/packages/upload-script', body),
  editScript: (name, body) => api.put(`/api/admin/packages/${encodeURIComponent(name)}/script`, body),
  setPolicy: (name, body) => api.put(`/api/admin/packages/${encodeURIComponent(name)}/policy`, body),
  enable: (name) => api.put(`/api/admin/packages/${encodeURIComponent(name)}/enable`),
  disable: (name) => api.put(`/api/admin/packages/${encodeURIComponent(name)}/disable`),
  deleteScript: (name) => api.delete(`/api/admin/packages/${encodeURIComponent(name)}`)
};
```

### Step 4: Write the 3 modals + rewrite the view

(All 4 files — concise templates below; full CSS uses the R49 ops-console visual language: dimmer L1 title, left rail, status pill 3-color, tnum for numbers.)

`center/web/src/components/admin/UploadScriptModal.vue`:

```vue
<template>
  <div class="modal-backdrop" data-test="upload-modal">
    <div class="modal">
      <h3>上传脚本</h3>
      <form @submit.prevent="submit">
        <label>名称 <input v-model="name" data-test="upload-name-input" required pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*"></label>
        <label>类型
          <select v-model="type">
            <option value="gauge">gauge</option><option value="counter">counter</option>
            <option value="status">status</option><option value="timeseries">timeseries</option>
          </select>
        </label>
        <label>Agent
          <select v-model="agentType">
            <option value="ad">AD</option><option value="non-ad">非AD</option>
          </select>
        </label>
        <label>描述 <input v-model="description" maxlength="1024"></label>
        <label>执行间隔 (秒) <input v-model.number="intervalSec" type="number" min="5" max="86400" required></label>
        <label>执行超时 (毫秒) <input v-model.number="timeoutMs" type="number" min="1000" max="600000" required></label>
        <label>脚本内容 (collect.ps1)
          <textarea v-model="content" rows="20" data-test="upload-content-input" required maxlength="1048576"></textarea>
        </label>
        <div v-if="error" class="error">{{ error }}</div>
        <div class="actions">
          <button type="button" @click="$emit('close')">取消</button>
          <button type="submit" data-test="upload-submit">提交</button>
        </div>
      </form>
    </div>
  </div>
</template>
<script setup>
import { ref } from 'vue';
import { packagesApi } from '../../api/packages.js';

const emit = defineEmits(['close', 'uploaded']);
const name = ref('');
const type = ref('gauge');
const agentType = ref('ad');
const description = ref('');
const intervalSec = ref(3600);
const timeoutMs = ref(30000);
const content = ref('');
const error = ref('');

async function submit() {
  error.value = '';
  try {
    await packagesApi.uploadScript({
      name: name.value, type: type.value, agentType: agentType.value,
      description: description.value, intervalSec: intervalSec.value,
      timeoutMs: timeoutMs.value, content: content.value
    });
    emit('uploaded');
    emit('close');
  } catch (e) {
    error.value = e?.response?.data?.error || '提交失败';
  }
}
</script>
```

`EditScriptModal.vue` and `EditPolicyModal.vue` follow the same pattern — form fields bound to refs, submit calls `packagesApi.editScript` / `setPolicy`, error displayed in modal.

`center/web/src/views/admin/PackagesView.vue` (rewrite — major):

```vue
<template>
  <AdminLayout>
    <header>
      <h2>包管理</h2>
      <div class="actions">
        <button @click="refresh" data-test="refresh-btn">↻ 刷新</button>
        <button @click="openUpload" data-test="upload-btn" class="primary">+ 上传脚本</button>
      </div>
    </header>
    <div v-if="error" class="error-banner">{{ error }}</div>
    <table v-if="items.length">
      <thead>
        <tr>
          <th>名称</th><th>版本</th><th>类型</th><th>启用</th>
          <th class="num">间隔(s)</th><th class="num">超时(ms)</th>
          <th>来源</th><th>最后修改</th><th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="it in items" :key="it.name" class="script-row" :data-test="`row-${it.name}`">
          <td>{{ it.name }}</td>
          <td>{{ it.version }}</td>
          <td>{{ it.type }}</td>
          <td>
            <span :class="['status-pill', it.enabled ? 'ok' : 'off']">{{ it.enabled ? '●' : '○' }}</span>
          </td>
          <td class="num">{{ it.intervalSec ?? '-' }}</td>
          <td class="num">{{ it.timeoutMs ?? '-' }}</td>
          <td>{{ it.source }}</td>
          <td>{{ fmt(it.updatedAt) }}</td>
          <td class="row-actions">
            <button @click="openEditScript(it)" :data-test="`edit-script-${it.name}`">脚本</button>
            <button @click="openEditPolicy(it)" :data-test="`edit-policy-${it.name}`">策略</button>
            <button @click="toggleEnabled(it)" :data-test="`toggle-${it.name}`">{{ it.enabled ? '禁用' : '启用' }}</button>
            <button @click="confirmDelete(it)" class="danger" :data-test="`delete-${it.name}`">删除</button>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-else class="empty">暂无脚本。点 + 上传脚本 添加。</div>

    <UploadScriptModal v-if="showUpload" @close="showUpload=false" @uploaded="refresh" />
    <EditScriptModal v-if="editingScript" :item="editingScript" @close="editingScript=null" @saved="refresh" />
    <EditPolicyModal v-if="editingPolicy" :item="editingPolicy" @close="editingPolicy=null" @saved="refresh" />
  </AdminLayout>
</template>
<script setup>
import { ref, onMounted } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import UploadScriptModal from '../../components/admin/UploadScriptModal.vue';
import EditScriptModal from '../../components/admin/EditScriptModal.vue';
import EditPolicyModal from '../../components/admin/EditPolicyModal.vue';
import { packagesApi } from '../../api/packages.js';

const items = ref([]);
const error = ref('');
const showUpload = ref(false);
const editingScript = ref(null);
const editingPolicy = ref(null);

async function refresh() {
  error.value = '';
  try {
    const r = await packagesApi.list();
    items.value = Array.isArray(r.data?.items) ? r.data.items : [];
  } catch (e) {
    error.value = e?.response?.data?.error || '加载失败';
  }
}

function openUpload() { showUpload.value = true; }
function openEditScript(it) { editingScript.value = it; }
function openEditPolicy(it) { editingPolicy.value = it; }

async function toggleEnabled(it) {
  try {
    if (it.enabled) await packagesApi.disable(it.name);
    else await packagesApi.enable(it.name);
    await refresh();
  } catch (e) { error.value = e?.response?.data?.error || '操作失败'; }
}

async function confirmDelete(it) {
  if (!window.confirm(`确认删除脚本 ${it.name}?`)) return;
  try {
    await packagesApi.deleteScript(it.name);
    await refresh();
  } catch (e) { error.value = e?.response?.data?.error || '删除失败'; }
}

function fmt(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-'; }

onMounted(refresh);
</script>
<style scoped>
/* R49 ops-console visual language — see other admin views for reference.
   status-pill 3-color (ok/warn/err), tnum on numeric cells, dimmer L1
   title, left rail 2px on row hover. Keep this minimal — the spec
   sketches the table layout; full styling follows R49. */
header { display: flex; align-items: center; justify-content: space-between; }
.actions button { margin-left: 8px; }
.actions .primary { background: var(--accent, #2563eb); color: white; }
table { width: 100%; border-collapse: collapse; margin-top: 16px; }
th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #e5e7eb; }
th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
.row-actions button { margin-right: 4px; }
.row-actions .danger { color: #dc2626; }
.status-pill.ok { color: #16a34a; }
.status-pill.off { color: #9ca3af; }
.empty { padding: 32px; text-align: center; color: #6b7280; }
.error-banner { padding: 12px; background: #fef2f2; color: #dc2626; margin: 8px 0; }
</style>
```

### Step 5: Run tests

```bash
cd center/web && npx vitest run tests/packages-view.test.js
# Expect: 6 pass
```

### Step 6: Build dist + verify

```bash
cd center && npm run build:web
ls -la web/dist/assets/ | head
# Confirm new bundles emitted
```

### Step 7: Mirror

```bash
cp -r center/web/src/api/packages.js publish/system/center/web/src/api/
cp -r center/web/src/views/admin/PackagesView.vue publish/system/center/web/src/views/admin/
cp -r center/web/src/stores/packages.js publish/system/center/web/src/stores/
cp -r center/web/src/components/admin/ publish/system/center/web/src/components/
cp -r center/web/tests/packages-view.test.js publish/system/center/web/tests/
pwsh -NoProfile -File installer/verify-mirror.ps1
```

### Step 8: Commit

```bash
git add center/web/src/api/packages.js \
        center/web/src/views/admin/PackagesView.vue \
        center/web/src/stores/packages.js \
        center/web/src/components/admin/ \
        center/web/tests/packages-view.test.js \
        center/web/tests/admin-layout.test.js \
        publish/system/center/web/src/api/packages.js \
        publish/system/center/web/src/views/admin/PackagesView.vue \
        publish/system/center/web/src/stores/packages.js \
        publish/system/center/web/src/components/admin/ \
        publish/system/center/web/tests/packages-view.test.js
git commit -m "feat(r66): PackagesView rewrite — 3 modals + 9 endpoint store actions"
```

**Done when:** View tests pass; dist builds; mirror clean.

**Complexity:** medium.

---

## Task 11 — mock helpers + daemons sync

**Files:**
- Modify: `center/mock-snapshot.mjs` — add `buildMockScriptEntry` + `buildMockPolicyEntry`
- Modify: `center/mock-heartbeat-daemon.mjs` — replace `installed_packages` upsert with two-table inserts
- Modify: `center/mock-multi-agent.mjs` — same
- Modify: `center/tests/mock-snapshot.test.js` — add new helper tests
- Modify: `center/tests/mock-heartbeat-daemon.test.js` — assert two-table inserts
- Modify: `center/tests/mock-multi-agent.test.js` — same
- Mirror all

### Step 1: Add mock helpers in `mock-snapshot.mjs`

```js
// Append to mock-snapshot.mjs:

import crypto from 'node:crypto';

export function buildMockScriptEntry({ name, version = '1.0.0', type = 'gauge', agentType = 'ad',
                                       description = '', content, source = 'builtin-seed' }) {
  if (!content) {
    content = `# Mock ${name} collect.ps1\nWrite-Host "mock-${name}"\n`;
  }
  const scriptSha = crypto.createHash('sha256').update(content).digest('hex');
  const manifest = {
    name, version, type,
    description,
    schemaVersion: 1,
    agent: { type: agentType, script: 'collect.ps1' }
  };
  return {
    name, version,
    scriptContent: content,
    scriptSha256: scriptSha,
    manifestJson: JSON.stringify(manifest),
    source,
    createdAt: new Date(),
    updatedAt: new Date()
  };
}

export function buildMockPolicyEntry({ name, intervalSec = 3600, timeoutMs = 30000,
                                       enabled = true, params = null, scope = 'global' }) {
  return {
    name,
    intervalSec,
    timeoutMs,
    enabled: enabled ? 1 : 0,
    paramsJson: params == null ? null : JSON.stringify(params),
    scope,
    createdAt: new Date(),
    updatedAt: new Date()
  };
}
```

### Step 2: Update the daemons

In `mock-heartbeat-daemon.mjs` and `mock-multi-agent.mjs`, find the section that builds `installedPackages.upsert(...)` and replace:

```js
// OLD — delete:
const upserted = await installedPackages.upsert({ name: pkg.name, version: pkg.version, ... });

// NEW:
const script = buildMockScriptEntry({ name: pkg.name, content: pkg.scriptContent });
await db.execute(`
  INSERT INTO package_scripts (name, version, script_content, script_sha256, manifest_json, source, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`, [script.name, script.version, script.scriptContent, script.scriptSha256, script.manifestJson, script.source, script.createdAt, script.updatedAt]);
const policy = buildMockPolicyEntry({ name: pkg.name, enabled: true });
await db.execute(`
  INSERT INTO package_policies (name, interval_sec, timeout_ms, enabled, params_json, scope, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`, [policy.name, policy.intervalSec, policy.timeoutMs, policy.enabled, policy.paramsJson, policy.scope, policy.createdAt, policy.updatedAt]);
```

Wrap in a loop over the 5 built-ins (`ad_os_baseline`, `ad_domain_consistency`, `ad_local_port_check`, `ad_lockout_summary`, `ad_lockout_list`).

### Step 3: Write the tests

`center/tests/mock-snapshot.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMockScriptEntry, buildMockPolicyEntry } from '../mock-snapshot.mjs';

test('buildMockScriptEntry computes sha256 + manifest', () => {
  const e = buildMockScriptEntry({ name: 'pkg-a', content: 'Write-Host hi' });
  assert.equal(e.name, 'pkg-a');
  assert.match(e.scriptSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(e.manifestJson).agent, { type: 'ad', script: 'collect.ps1' });
  // NOTE: intervalSec + timeoutMs MUST NOT be in agent block
  assert.equal(JSON.parse(e.manifestJson).agent.intervalSec, undefined);
  assert.equal(JSON.parse(e.manifestJson).agent.timeoutMs, undefined);
});

test('buildMockPolicyEntry defaults enabled=true', () => {
  const p = buildMockPolicyEntry({ name: 'pkg-a' });
  assert.equal(p.enabled, 1);
  assert.equal(p.intervalSec, 3600);
});
```

`center/tests/mock-heartbeat-daemon.test.js` and `center/tests/mock-multi-agent.test.js`: add an assertion that after one tick, the mock has 5 rows in `package_scripts` + 5 rows in `package_policies` (and 0 in `installed_packages`).

### Step 4: Run tests

```bash
cd center && node --test tests/mock-snapshot.test.js tests/mock-heartbeat-daemon.test.js tests/mock-multi-agent.test.js
# Expect: pass
```

### Step 5: Mirror

```bash
cp center/mock-snapshot.mjs publish/system/center/
cp center/mock-heartbeat-daemon.mjs publish/system/center/
cp center/mock-multi-agent.mjs publish/system/center/
cp center/tests/mock-snapshot.test.js publish/system/center/tests/
cp center/tests/mock-heartbeat-daemon.test.js publish/system/center/tests/
cp center/tests/mock-multi-agent.test.js publish/system/center/tests/
pwsh -NoProfile -File installer/verify-mirror.ps1
```

### Step 6: Commit

```bash
git add center/mock-snapshot.mjs center/mock-heartbeat-daemon.mjs center/mock-multi-agent.mjs \
        center/tests/mock-snapshot.test.js center/tests/mock-heartbeat-daemon.test.js center/tests/mock-multi-agent.test.js \
        publish/system/center/mock-snapshot.mjs publish/system/center/mock-heartbeat-daemon.mjs publish/system/center/mock-multi-agent.mjs \
        publish/system/center/tests/mock-snapshot.test.js publish/system/center/tests/mock-heartbeat-daemon.test.js publish/system/center/tests/mock-multi-agent.test.js
git commit -m "feat(r66): mock-sync — 5 built-in scripts migrated to two-table path"
```

**Done when:** Mock tests pass; daemons emit 5+5 rows; no `installed_packages` references remain in mock code.

**Complexity:** small.

---

## Task 12 — dashboard.test.js update for two-table JOIN

**Files:**
- Modify: `center/tests/dashboard.test.js` — replace any `installed_packages` mock-DB matchers with `package_scripts` + `package_policies`
- Modify: `center/tests/agent-observability.test.js` — same
- Mirror

### Step 1: Grep for `installed_packages` in tests

```bash
grep -rn "installed_packages" center/tests/ | grep -v migrations/
```

Each match becomes a Task 12 edit.

### Step 2: Replace mock-DB stubs

If a test mocks `installed_packages.upsert` or query results, replace with:

```js
// Add to mock db.execute:
if (sql.includes('FROM installed_packages')) {
  return { rows: [] };  // table is gone post-migration
}
if (sql.includes('package_scripts') && sql.includes('package_policies')) {
  // JOIN — return the 5 built-in shape
  return { rows: [/* {name, version, script_content, script_sha256, manifest_json, source, interval_sec, timeout_ms, enabled, params_json, scope} */] };
}
```

If a test directly inserts/queries `installed_packages`, redirect to the new tables.

### Step 3: Run tests

```bash
cd center && node --test tests/dashboard.test.js tests/agent-observability.test.js
# Expect: pass
```

### Step 4: Mirror + commit

```bash
cp center/tests/dashboard.test.js publish/system/center/tests/
cp center/tests/agent-observability.test.js publish/system/center/tests/
pwsh -NoProfile -File installer/verify-mirror.ps1
git add center/tests/dashboard.test.js center/tests/agent-observability.test.js \
        publish/system/center/tests/dashboard.test.js publish/system/center/tests/agent-observability.test.js
git commit -m "test(r66): dashboard + observability tests migrated to two-table JOIN"
```

**Done when:** Both test files green; no remaining `installed_packages` references.

**Complexity:** small.

---

## Task 13 — full verification, build, mirror sync, commit, memory

**Files:**
- All files modified by Tasks 1-12 should already be in commits; this task only orchestrates the final checks.

### Step 1: Run the full backend test suite

```bash
cd center
node --test tests/db/sql/package-scripts.test.js \
          tests/db/sql/package-policies.test.js \
          tests/packages/script-service.test.js \
          tests/packages/router.test.js \
          tests/packages/runner.test.js \
          tests/services/builtin-packages.test.js \
          tests/audit-classifier.test.js \
          tests/dashboard.test.js \
          tests/agent-observability.test.js \
          tests/mock-snapshot.test.js \
          tests/mock-heartbeat-daemon.test.js \
          tests/mock-multi-agent.test.js \
          tests/migrations/023-package-scripts-policies-split.test.js \
          tests/*.test.js
# Expect: 0 failures
```

If any fail, fix forward (do not skip).

### Step 2: Run the full frontend test suite

```bash
cd center/web && npx vitest run
# Expect: 0 failures
```

### Step 3: Build the frontend dist

```bash
cd center && npm run build:web
# Expect: exit 0; new bundles emitted
```

### Step 4: Mirror sync (full)

```bash
pwsh -NoProfile -File installer/verify-mirror.ps1
# If drift, fix. Mirror MUST be clean before commit.
```

### Step 5: Smoke verify the agent-protocol shape (no agent restart)

Manually run the mock agent's `GET /api/agent/packages` against the new backend, diff against a pre-R66 baseline. If the response shape matches exactly, no agent restart is needed.

```bash
# In a dev center:
TOKEN=$(curl -s http://127.0.0.1:9080/api/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"..."}' | jq -r .token)
curl -s -H "x-agent-token: $TOKEN" \
  "http://127.0.0.1:9080/api/agent/packages" \
  | jq '.packages[0] | keys'
# Expect: ["manifest", "name", "params", "script", "version"]
# AND: .manifest.agent.intervalSec and .manifest.agent.timeoutMs present
```

### Step 6: Commit any remaining changes + push

```bash
git status  # should be clean if Tasks 1-12 each committed
git log --oneline | head -20  # confirm commits present
git push origin main
```

### Step 7: Memory note

Write `C:\Users\徐鹏\.claude\projects\D--ToolDevelop-ADDashboard\memory\progress_2026_08_29_r66.md`:

```markdown
---
name: progress_2026_08_29_r66
description: 2026-08-29 R66 — package management replace (scripts + policies split). Operator directive "将包管理改成 上传脚本,然后执行策略...". 13 tasks / 2-table split.
metadata:
  type: progress
---

# R66 — Package Management Replace (2026-08-29)

**Operator directive (verbatim):** "将包管理改成 上传脚本,然后执行策略,修改脚本设置执行周期等等。agent 端将根据执行的策略拉取这些脚本,然后依据拉取的配置执行,或者禁用 或者删除 等等操作"

**Scope decision:** B 替换 (with 独立策略表) — drop `installed_packages`, replace with `package_scripts` + `package_policies`. 9 admin endpoints. Agent protocol preserved (byte-identical JSON shape).

**Decisions:**
- 不做 agent hash 校验 (agent 继续 silent overwrite)
- 启用后 admin 可 UI 编辑 (宽松) — built-ins editable like any other row
- mock + mock-snapshot 都改 (完整同步)
- docs/superpowers/specs/ (默认路径)
- script body size cap 1 MB
- 5 audit actions: upload_script / edit_script / set_policy / delete_script / bulk_migrate
- Built-in re-seed on every startup = intentional overwrite (宽松)

**Commits:**
- spec: bbd513a
- impl: <commit hashes from Tasks 1-12>

**Tests:** backend X/X pass, frontend X/X pass, mirror clean, agent protocol shape verified

**Status:** 待 user 手动 restart 8080 NSSM 加载新 dist

**Related:** [[project_ad_dashboard]] R19 (interval_override_sec absorbed), R50 (splitSqlStatements migration pattern)
```

Add to `MEMORY.md` index:

```markdown
- [2026-08-29 R66 — 包管理替换 (scripts + policies 拆表)](progress_2026_08_29_r66.md) — operator directive "将包管理改成 上传脚本,然后执行策略...";installed_packages → package_scripts + package_policies;9 admin 端点;agent 协议 shape 不变;commit <hash>;待 user 手动 restart 8080 NSSM
```

### Step 8: Final commit + tell operator

```bash
git add C:/Users/徐鹏/.claude/projects/D--ToolDevelop-ADDashboard/memory/progress_2026_08_29_r66.md \
        C:/Users/徐鹏/.claude/projects/D--ToolDevelop-ADDashboard/memory/MEMORY.md
git commit -m "memory(r66): progress note + MEMORY index entry"

# Report to operator (NO auto-restart per standing directive):
# "R66 implementation complete. <N> commits, <M> tests pass, mirror clean.
#  Agent protocol shape verified byte-identical against pre-R66 baseline.
#  待你手动 restart 8080 NSSM 加载新 dist.
#  验证步骤: open /admin/packages → should see 5 built-in scripts + upload modal works
#           → try edit policy intervalSec → audit log shows 'set_policy'
#           → try delete → confirm → audit log shows 'delete_script'"
```

**Done when:** All tests pass, mirror clean, commits pushed, memory note written, operator told to restart.

**Complexity:** orchestration only.

---

## Task Checklist

- [ ] T1 — DDL migration 023 (MySQL + MSSQL)
- [ ] T2 — JS data migration + applier wiring
- [ ] T3 — `package-scripts` SQL helper
- [ ] T4 — `package-policies` SQL helper
- [ ] T5 — `script-service` (installScript/editScript/setPolicy/deleteScript + audit)
- [ ] T6 — audit-classifier additions (5 entries)
- [ ] T7 — admin router rewrite (9 endpoints)
- [ ] T8 — runner.js JOIN update (preserve agent protocol)
- [ ] T9 — builtin-seeder switch + installer.js deletion
- [ ] T10 — frontend: store + 3 modals + PackagesView rewrite
- [ ] T11 — mock helpers + daemons sync
- [ ] T12 — dashboard.test.js + agent-observability.test.js updates
- [ ] T13 — full verification + build + mirror + commit + memory

---

## Risk Notes

1. **Migration 023 on existing data.** The 5 built-in packages have small `collect.ps1` bodies (1-3 KB each). The JS-level data migration reads each row + writes two rows + writes audit. Center startup time spikes by ~500ms during migration — acceptable. The migration MUST run BEFORE the `installed_packages` DROP; the applier must orchestrate that ordering.

2. **Script content size cap (1 MB).** Prevents runaway uploads. AJV schema + script-service both validate. Operator can bump if needed (just two-line change).

3. **Concurrent edits.** Two admins editing the same script simultaneously → last-write-wins on `script_content` (no optimistic locking V1). Audit log shows both writes; operator can diff via external tooling. V2 add `If-Match`.

4. **Built-in re-seed overwrites operator edits on every startup.** This is the "宽松" choice. The audit log shows the cycle (each startup emits an `upload_script` audit row per built-in). The V2 fix is a `builtin_locked` flag in the manifest that suppresses re-seed — out of scope for V1.

5. **`bulk_migrate` audit row.** The data migration writes one `bulk_migrate` audit row plus one `upload_script` row per script (5 rows for built-ins) — keeps the audit story complete across the migration boundary.

6. **Agent protocol regression.** The whole point of "agent protocol unchanged" is verified by the smoke check in T13 step 5. If `/api/agent/packages` shape drifts, real agents in the field break. The runner test (T8) includes explicit shape-regression assertions (manifest.agent.intervalSec + timeoutMs baked in).

7. **No rollback after DROP.** `installed_packages` is gone after migration. Rollback path is (a) MySQL dump restore + (b) re-deploy V65 code, which crashes because the table is gone. Mitigation: take a MySQL dump BEFORE applying migration 023 in production.

8. **Mount order in `server.js`.** Admin router (T7) and runner (T8) must be mounted BEFORE the SPA fallback, otherwise `/api/admin/packages` and `/api/agent/packages` get caught by the wildcard. The feedback from memory (`feedback_express_mount_vs_spa_fallback`) applies directly here.

9. **MSSQL `LIMIT` rewrites.** The new `JOIN_SELECT` SQL doesn't use `LIMIT`/`TOP` so this is moot — the JOIN returns all enabled rows (typically <20). The runner just serializes them.

10. **`installer.js` deletion is high-leverage.** A grep for remaining importers is mandatory before the `git rm`. Any test or service still importing the old installer crashes the boot. T9 step 1 catches this.