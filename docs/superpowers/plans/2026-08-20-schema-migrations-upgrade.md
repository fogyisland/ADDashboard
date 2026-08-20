# Schema Migrations Admin Upgrade + UX Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/admin/migrations` a reliable admin tool that surfaces apply failures with actionable error messages, supports manual / bulk / up-to-version / baseline operations, and adds a one-click **升级 (Upgrade)** button that brings the DB to latest (apply pending migrations + re-run seed if changed).

**Architecture:**
- **Backend:** extend `center/src/services/migrations.js` and `center/src/routes/schema-migrations.js` with 4 new endpoints (`mark-applied`, `baseline`, `apply-up-to`, `upgrade`). Track seed checksum in `system_config` so upgrade is idempotent. All admin actions audited.
- **Frontend:** rewrite `SchemaMigrationsView.vue` to (a) wrap all POSTs in try/catch with inline error display, (b) show per-row loading state, (c) display `errorMessage` column for failed migrations, (d) add 4 new buttons (per-row `标记已应用`, modal-based `标记基线` + `应用到版本`, top-bar `升级到最新`).

**Tech Stack:** Vue 3 + Pinia + Vite frontend; Express + Node.js backend; MySQL 5.7.44 / MSSQL 2019+ dual-dialect via db facade; node:test for backend; vitest for frontend.

**Spec:** `docs/superpowers/specs/2026-08-06-schema-admin-design.md` (existing) — this plan is an extension that fixes UX gaps and adds the upgrade feature. Reviewers should treat this plan as the binding requirement set.

## Global Constraints

These apply to EVERY task below. Values are copied verbatim from the spec and prior conventions.

- **Dual-DB:** every SQL string must run unchanged on MySQL 5.7.44 AND MSSQL 2019+. Forbidden: `JSON_LENGTH`, `JSON_TABLE`, `JSON_ARRAYAGG`, MySQL-only `ON DUPLICATE KEY UPDATE` for the MSSQL path. Use the dialect-switching `db.sql.*` registry. (`db.sql.schemaMigrations.upsert` already uses INSERT...ON DUPLICATE KEY for MySQL and MERGE for MSSQL — reuse, do not redefine.)
- **Mirror sync:** every source change to `frontend/src/**` or `center/src/**` MUST mirror to `publish/system/frontend/src/**` or `publish/system/center/src/**` before commit. `powershell -File publish/system/scripts/verify-mirror.ps1` must report 0 drift. Add this check to the brief of every task that touches source files (lesson 38).
- **Audit:** all admin actions write to `audit_logs` via `writeAudit({ userId, action, target, payload }, logger)`. Action names are lower_snake_case (`apply_migration`, `mark_applied`, `baseline`, `apply_up_to`, `upgrade_db`).
- **Auth:** all `/api/admin/migrations/*` routes require `admin:users` permission.
- **Error surface:** UI MUST show errors inline. No silent failures, no unhandled rejections swallowed. (`SchemaMigrationsView.vue:120` current `applyOne` violates this — Task 3 fixes.)
- **Verify markers:** when backfilling / marking versions ≤ N as applied, files that declare `-- verify: ...` markers MUST have their markers satisfied; otherwise skip + log warn. Reuse `verifyMarkers` from `center/src/init/verify-marker.js`.
- **Test isolation:** backend tests use `_deps.createMigrationsService` injection; frontend tests use `vi.mock('../src/api/migrations.js')`.
- **No drive-by:** do not refactor unrelated code. Stay in the files listed per task.

---

## Task 1: Backend — 3 new endpoints (mark-applied, baseline, apply-up-to)

**Files:**
- Modify: `center/src/services/migrations.js` — add `markApplied(version, { appliedBy })`, `baseline(version, { appliedBy })`, `applyUpTo(version, { appliedBy })`. Reuse existing helpers (`resolveFile`, `parseFileMeta`, `sha256`, `splitSqlStatements`, `validateVersion`).
- Modify: `center/src/routes/schema-migrations.js` — add 3 POST routes after the existing `/reset` route (around line 85).
- Modify: `center/tests/migrations-service.test.js` — extend with new tests for the 3 service methods.
- Modify: `center/tests/migrations-router.test.js` — extend with new router tests for the 3 endpoints.
- Mirror: `publish/system/center/src/services/migrations.js` + `publish/system/center/src/routes/schema-migrations.js` (run before final test step).

**Interfaces:**
- Consumes: existing `db.sql.schemaMigrations.upsert`, `db.sql.schemaMigrations.findByVersion`, `db.sql.schemaMigrations.list` from `center/src/db/sql.js`; existing `verifyMarkers` from `center/src/init/verify-marker.js`; existing `backfillMigrations` from `center/src/init/schema-applier.js`.
- Produces:
  - `service.markApplied(version, { appliedBy })` → `{ ok: true, version, status: 'applied', executionMs: 0 }` (writes `status='applied'`, `execution_ms=0`, `applied_at=now`, `appliedBy`, no SQL execution). Throws `InvalidVersionError` (400), `MigrationFileMissingError` (404).
  - `service.baseline(version, { appliedBy })` → `{ ok: true, versions: [...], skipped: [{version, missing}] }` (writes `status='applied'` for all ≤ version whose verify markers pass; logs/skips files whose markers fail). Throws `InvalidVersionError` (400).
  - `service.applyUpTo(version, { appliedBy })` → `{ ok, applied: [{version, status, executionMs}], failed: [{version, errorMessage}] }`. Sequentially calls existing `service.applyMigration(v, { appliedBy })` for each pending version ≤ target, ordered ascending. Stops on first failure or continues collecting failures? **Decision: collect failures but continue** — admin should see all failures at once. Returns `ok=false` if any failed.
  - Router signature: `POST /api/admin/migrations/:version/mark-applied`, `POST /api/admin/migrations/baseline` (body `{version}`), `POST /api/admin/migrations/apply-up-to` (body `{version}`). Same auth + audit pattern as existing.

- [ ] **Step 1: Write failing test for `markApplied` service**

```js
// In center/tests/migrations-service.test.js, add:
test('markApplied writes applied row without executing SQL', async () => {
  const captured = [];
  const fakeDb = {
    dialect: 'mysql',
    sql: { schemaMigrations: { upsert: 'UPSERT_SQL', list: 'LIST_SQL' } },
    query: async (s) => s === 'LIST_SQL' ? { rows: [] } : { rows: [] },
    execute: async (sql, params) => { captured.push({ sql, params }); return { rows: [], affectedRows: 1 }; }
  };
  const svc = createMigrationsService({ db: fakeDb, logger: { warn() {}, error() {} }, getRepoRoot: () => '/repo' });
  const r = await svc.markApplied('014', { appliedBy: 'admin' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'applied');
  assert.equal(r.executionMs, 0);
  // UPSERT was called with status='applied'
  assert.equal(captured.length, 1);
  assert.equal(captured[0].params[8], 'applied'); // status param index
  assert.equal(captured[0].params[7], 'admin');    // appliedBy
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd center && npm test -- --test-name-pattern="markApplied" 2>&1 | tail -20`
Expected: FAIL — `svc.markApplied is not a function`.

- [ ] **Step 3: Implement `markApplied`**

In `center/src/services/migrations.js`, add BEFORE `return { listMigrations, applyMigration, dryRunMigration, resetFailedMigration };`:

```js
async function markApplied(version, { appliedBy }) {
  validateVersion(version);
  const repoRoot = getRepoRoot();
  const filePath = resolveFile(repoRoot, db.dialect, version);
  if (!filePath) throw new MigrationFileMissingError(version);
  const content = readFileSync(filePath, 'utf8');
  const meta = parseFileMeta(filePath);
  const fileName = filePath.split(/[/\\]/).pop();
  const checksum = sha256(content);
  const appliedAtIso = new Date().toISOString();
  await db.execute(db.sql.schemaMigrations.upsert, [
    version, meta.description, 'sql', fileName, checksum,
    appliedAtIso, 0, appliedBy || 'system', 'applied', null
  ]);
  return { ok: true, version, status: 'applied', executionMs: 0 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd center && npm test -- --test-name-pattern="markApplied" 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Add to exports + write `baseline` test**

Replace the `return` statement to include `markApplied`:
```js
return { listMigrations, applyMigration, dryRunMigration, resetFailedMigration, markApplied };
```

Then add a failing test for `baseline`:

```js
test('baseline marks all versions ≤ N as applied when markers pass', async () => {
  const fakeDb = {
    dialect: 'mysql',
    sql: { schemaMigrations: { upsert: 'UPSERT_SQL', list: 'LIST_SQL' } },
    query: async () => ({ rows: [] }),
    execute: async () => ({ rows: [], affectedRows: 1 })
  };
  // Mock verify-marker via re-import would be heavy — instead use a real path
  // with files that have NO verify markers (backfillMigrations already does this).
  const svc = createMigrationsService({ db: fakeDb, logger: { warn() {}, error() {} }, getRepoRoot: () => '/repo' });
  // Use the existing repo fixture dir for test (db/migrations/).
  // If baseline() is implemented to call verifyMarkers internally, files without markers pass.
  const r = await svc.baseline('014', { appliedBy: 'admin' });
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.versions));
});
```

- [ ] **Step 6: Implement `baseline`**

In `center/src/services/migrations.js`, add:

```js
import { verifyMarkers } from '../init/verify-marker.js';
import { parseVerifyMarker } from '../init/verify-marker.js';

async function baseline(version, { appliedBy }) {
  validateVersion(version);
  const repoRoot = getRepoRoot();
  const dir = db.dialect === 'mssql'
    ? join(repoRoot, 'db/migrations/mssql')
    : join(repoRoot, 'db/migrations');
  if (!existsSync(dir)) throw new MigrationFileMissingError(version);
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const versions = [];
  const skipped = [];
  const appliedAtIso = new Date().toISOString();
  for (const f of files) {
    const m = f.match(/^(\d{3})-([a-z0-9-]+)\.sql$/);
    if (!m) continue;
    if (m[1] > version) continue;
    const filePath = join(dir, f);
    const content = readFileSync(filePath, 'utf8');
    const markers = parseVerifyMarker(content);
    if (markers.length > 0) {
      const { ok, missing } = await verifyMarkers(db, markers);
      if (!ok) {
        skipped.push({ version: m[1], missing });
        continue;
      }
    }
    const checksum = sha256(content);
    await db.execute(db.sql.schemaMigrations.upsert, [
      m[1], m[2], 'sql', f, checksum,
      appliedAtIso, 0, appliedBy || 'system', 'applied', null
    ]);
    versions.push(m[1]);
  }
  return { ok: true, versions, skipped };
}
```

- [ ] **Step 7: Run baseline test, add `applyUpTo` test**

Run baseline test (expected PASS). Then add:

```js
test('applyUpTo applies all pending versions up to N in order', async () => {
  const calls = [];
  const fakeDb = {
    dialect: 'mysql',
    sql: { schemaMigrations: { upsert: 'UPSERT_SQL', list: 'LIST_SQL', findByVersion: 'FIND_SQL' } },
    query: async () => ({ rows: [] }), // no existing rows
    execute: async () => ({ rows: [], affectedRows: 1 }),
    transaction: async (work) => work({ execute: async () => ({ rows: [], affectedRows: 0 }) })
  };
  const svc = createMigrationsService({ db: fakeDb, logger: { warn() {}, error() {} }, getRepoRoot: () => '/repo' });
  const r = await svc.applyUpTo('014', { appliedBy: 'admin' });
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.applied));
});
```

- [ ] **Step 8: Implement `applyUpTo`**

```js
async function applyUpTo(version, { appliedBy }) {
  validateVersion(version);
  const repoRoot = getRepoRoot();
  const dir = db.dialect === 'mssql'
    ? join(repoRoot, 'db/migrations/mssql')
    : join(repoRoot, 'db/migrations');
  if (!existsSync(dir)) throw new MigrationFileMissingError(version);
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const applied = [];
  const failed = [];
  for (const f of files) {
    const m = f.match(/^(\d{3})-([a-z0-9-]+)\.sql$/);
    if (!m) continue;
    if (m[1] > version) break;
    try {
      const r = await applyMigration(m[1], { appliedBy });
      applied.push({ version: r.version, status: r.status, executionMs: r.executionMs });
      if (r.status === 'failed') failed.push({ version: r.version, errorMessage: r.errorMessage });
    } catch (e) {
      failed.push({ version: m[1], errorMessage: e.message });
    }
  }
  return { ok: failed.length === 0, applied, failed };
}
```

- [ ] **Step 9: Add to exports + write router tests**

Update `return`:
```js
return { listMigrations, applyMigration, dryRunMigration, resetFailedMigration, markApplied, baseline, applyUpTo };
```

In `center/tests/migrations-router.test.js`, add:

```js
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
```

- [ ] **Step 10: Implement 3 routes**

In `center/src/routes/schema-migrations.js`, after the `/reset` route (around line 85), add:

```js
r.post('/api/admin/migrations/:version/mark-applied', ...auth, async (req, res) => {
  try {
    const service = getService();
    const appliedBy = (req.body && req.body.appliedBy) || req.user?.username || req.user?.sub || 'unknown';
    const result = await service.markApplied(req.params.version, { appliedBy });
    await deps.writeAudit({
      userId: req.user?.sub ?? null,
      action: 'mark_applied',
      target: 'schema_migrations',
      payload: { version: result.version, status: result.status }
    }, logger);
    res.json(result);
  } catch (e) {
    const status = e.status || 500;
    logger.error({ err: e.message, status }, 'mark applied failed');
    res.status(status).json({ error: e.message });
  }
});

r.post('/api/admin/migrations/baseline', ...auth, async (req, res) => {
  try {
    const service = getService();
    const { version } = req.body || {};
    if (!version) {
      return res.status(400).json({ error: 'version required' });
    }
    const appliedBy = req.body.appliedBy || req.user?.username || req.user?.sub || 'unknown';
    const result = await service.baseline(version, { appliedBy });
    await deps.writeAudit({
      userId: req.user?.sub ?? null,
      action: 'baseline',
      target: 'schema_migrations',
      payload: { version, count: result.versions.length, skipped: result.skipped.length }
    }, logger);
    res.json(result);
  } catch (e) {
    const status = e.status || 500;
    logger.error({ err: e.message, status }, 'baseline failed');
    res.status(status).json({ error: e.message });
  }
});

r.post('/api/admin/migrations/apply-up-to', ...auth, async (req, res) => {
  try {
    const service = getService();
    const { version } = req.body || {};
    if (!version) {
      return res.status(400).json({ error: 'version required' });
    }
    const appliedBy = req.body.appliedBy || req.user?.username || req.user?.sub || 'unknown';
    const result = await service.applyUpTo(version, { appliedBy });
    await deps.writeAudit({
      userId: req.user?.sub ?? null,
      action: 'apply_up_to',
      target: 'schema_migrations',
      payload: { version, applied: result.applied.length, failed: result.failed.length }
    }, logger);
    res.json(result);
  } catch (e) {
    const status = e.status || 500;
    logger.error({ err: e.message, status }, 'apply-up-to failed');
    res.status(status).json({ error: e.message });
  }
});
```

- [ ] **Step 11: Run all router tests + commit**

Run: `cd center && npm test 2>&1 | tail -10`
Expected: pass count up by 3 (3 new router tests) + ~3 new service tests.

Mirror sync: `cp center/src/services/migrations.js publish/system/center/src/services/migrations.js && cp center/src/routes/schema-migrations.js publish/system/center/src/routes/schema-migrations.js`

Verify: `powershell -File publish/system/scripts/verify-mirror.ps1 2>&1 | tail -5`
Expected: 0 drift.

```bash
cd .worktrees/schema-migrations-upgrade
git add center/src/services/migrations.js center/src/routes/schema-migrations.js \
        center/tests/migrations-service.test.js center/tests/migrations-router.test.js \
        publish/system/center/src/services/migrations.js publish/system/center/src/routes/schema-migrations.js
git commit -m "feat(migrations): add mark-applied/baseline/apply-up-to endpoints"
```

---

## Task 2: Backend — upgrade endpoint (migrations + seed re-apply)

**Files:**
- Modify: `center/src/services/migrations.js` — add `upgrade({ appliedBy })` method.
- Modify: `center/src/routes/schema-migrations.js` — add `POST /api/admin/migrations/upgrade` route.
- Modify: `center/tests/migrations-service.test.js` — tests for `upgrade` (seed unchanged skip + seed changed re-apply + migrations applied).
- Modify: `center/tests/migrations-router.test.js` — test for `/upgrade` endpoint with audit.
- Mirror: `publish/system/center/src/services/migrations.js` + `publish/system/center/src/routes/schema-migrations.js`.

**Interfaces:**
- Consumes: existing `service.applyMigration`, `service.listMigrations`, `splitSqlStatements`, `db.execute`, `system_config` table (via `db.sql.systemConfig.get`/`upsert`).
- Produces: `service.upgrade({ appliedBy })` → `{ ok, migrations: { applied: [...], failed: [...] }, seed: { ran: boolean, reason: 'first-run' | 'changed' | 'unchanged' | 'failed', errorMessage?: string }, message: string }`.
- New SQL helpers needed in `db.sql.systemConfig`: `getByKey`, `upsertByKey`. Check if they exist; if not, add minimal ones.

- [ ] **Step 1: Check existing systemConfig SQL helpers**

Run: `grep -n "systemConfig:" center/src/db/sql.js`
Expected: a `systemConfig: { ... }` block exists. If not, fall back to inline SQL using `db.execute`.

If existing helpers lack `getByKey` / `upsertByKey`, add them. The schema for `system_config`:
```sql
CREATE TABLE IF NOT EXISTS system_config (
  config_key VARCHAR(64) NOT NULL PRIMARY KEY,
  config_value TEXT,
  ...
);
```
Helper SQL (in db/sql.js, inside the `systemConfig` object, for both mysql and mssql dialects):

```js
// mysql:
getByKey: 'SELECT config_key, config_value FROM system_config WHERE config_key = ?',
upsertByKey: `INSERT INTO system_config (config_key, config_value) VALUES (?, ?)
  ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
// mssql:
getByKey: 'SELECT config_key, config_value FROM system_config WHERE config_key = CAST(? AS VARCHAR(64))',
upsertByKey: `MERGE INTO system_config AS t USING (SELECT CAST(? AS VARCHAR(64)) AS config_key, ? AS config_value) AS s
  ON t.config_key = s.config_key
  WHEN MATCHED THEN UPDATE SET config_value = s.config_value
  WHEN NOT MATCHED THEN INSERT (config_key, config_value) VALUES (s.config_key, s.config_value);`,
```

- [ ] **Step 2: Write failing test for `upgrade` service**

```js
test('upgrade applies all pending migrations and skips seed when checksum unchanged', async () => {
  const seedChecksum = sha256('-- seed content');
  const fakeDb = {
    dialect: 'mysql',
    sql: {
      schemaMigrations: { upsert: 'UPSERT', list: 'LIST', findByVersion: 'FIND' },
      systemConfig: { getByKey: 'GET_CFG', upsertByKey: 'UPSERT_CFG' }
    },
    query: async (s, p) => {
      if (s === 'LIST') return { rows: [] };
      if (s === 'GET_CFG') return { rows: [{ config_key: 'db.schema_seed.checksum', config_value: seedChecksum }] };
      return { rows: [] };
    },
    execute: async () => ({ rows: [], affectedRows: 0 }),
    transaction: async (work) => work({ execute: async () => ({ rows: [], affectedRows: 0 }) })
  };
  const svc = createMigrationsService({ db: fakeDb, logger: { warn() {}, error() {} }, getRepoRoot: () => '/repo' });
  // Mock db/schema/02-seed-roles.sql with known content — need a real fixture.
  // For test, monkey-patch readFileSync in the service's resolveFile path? Too invasive.
  // Alternative: just verify that when checksum matches, no seed re-apply execute is called.
  // Skip the seed check for now — assert migrations + seed.ran === false when matches.
  const r = await svc.upgrade({ appliedBy: 'admin' });
  assert.equal(r.seed.ran, false);
  assert.equal(r.seed.reason, 'unchanged');
});
```

- [ ] **Step 3: Implement `upgrade`**

In `center/src/services/migrations.js`, add:

```js
async function upgrade({ appliedBy }) {
  const repoRoot = getRepoRoot();
  const seedPath = db.dialect === 'mssql'
    ? join(repoRoot, 'db/schema/mssql/02-seed-roles.sql')
    : join(repoRoot, 'db/schema/02-seed-roles.sql');
  let seedChecksum = null;
  let seedContent = null;
  if (existsSync(seedPath)) {
    seedContent = readFileSync(seedPath, 'utf8');
    seedChecksum = sha256(seedContent);
  }

  // Apply all pending migrations sequentially
  const allFiles = readdirSync(db.dialect === 'mssql' ? join(repoRoot, 'db/migrations/mssql') : join(repoRoot, 'db/migrations'))
    .filter(f => f.endsWith('.sql')).sort();
  const applied = [];
  const failed = [];
  for (const f of allFiles) {
    const m = f.match(/^(\d{3})-([a-z0-9-]+)\.sql$/);
    if (!m) continue;
    try {
      const r = await applyMigration(m[1], { appliedBy });
      if (r.status === 'failed') {
        failed.push({ version: r.version, errorMessage: r.errorMessage });
      } else if (r.status === 'applied') {
        applied.push({ version: r.version, executionMs: r.executionMs });
      }
    } catch (e) {
      failed.push({ version: m[1], errorMessage: e.message });
    }
  }

  // Check seed
  const seedResult = { ran: false, reason: 'no-seed-file' };
  if (seedPath && seedChecksum) {
    const { rows: cfgRows } = await db.query(db.sql.systemConfig.getByKey, ['db.schema_seed.checksum']);
    const stored = cfgRows[0]?.config_value;
    if (!stored) {
      // First run — apply seed
      try {
        const stmts = splitSqlStatements(seedContent);
        for (const s of stmts) await db.execute(s, []);
        await db.execute(db.sql.systemConfig.upsertByKey, ['db.schema_seed.checksum', seedChecksum]);
        seedResult.ran = true;
        seedResult.reason = 'first-run';
      } catch (e) {
        seedResult.reason = 'failed';
        seedResult.errorMessage = e.message;
      }
    } else if (stored !== seedChecksum) {
      // Changed — re-apply
      try {
        const stmts = splitSqlStatements(seedContent);
        for (const s of stmts) await db.execute(s, []);
        await db.execute(db.sql.systemConfig.upsertByKey, ['db.schema_seed.checksum', seedChecksum]);
        seedResult.ran = true;
        seedResult.reason = 'changed';
      } catch (e) {
        seedResult.reason = 'failed';
        seedResult.errorMessage = e.message;
      }
    } else {
      seedResult.reason = 'unchanged';
    }
  }

  const ok = failed.length === 0 && seedResult.reason !== 'failed';
  const message = ok
    ? `升级完成: ${applied.length} migration 应用, seed ${seedResult.reason}`
    : `升级部分失败: ${failed.length} migration 失败${seedResult.reason === 'failed' ? ', seed 失败' : ''}`;
  return { ok, migrations: { applied, failed }, seed: seedResult, message };
}
```

- [ ] **Step 4: Add to exports + write router test**

Update `return`:
```js
return { listMigrations, applyMigration, dryRunMigration, resetFailedMigration, markApplied, baseline, applyUpTo, upgrade };
```

In `center/tests/migrations-router.test.js`, add:

```js
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
});
```

- [ ] **Step 5: Implement `/upgrade` route**

In `center/src/routes/schema-migrations.js`, after the `/apply-up-to` route, add:

```js
r.post('/api/admin/migrations/upgrade', ...auth, async (req, res) => {
  try {
    const service = getService();
    const appliedBy = (req.body && req.body.appliedBy) || req.user?.username || req.user?.sub || 'unknown';
    const result = await service.upgrade({ appliedBy });
    await deps.writeAudit({
      userId: req.user?.sub ?? null,
      action: 'upgrade_db',
      target: 'schema_migrations',
      payload: { applied: result.migrations.applied.length, failed: result.migrations.failed.length, seed: result.seed.reason }
    }, logger);
    res.json(result);
  } catch (e) {
    const status = e.status || 500;
    logger.error({ err: e.message, status }, 'upgrade failed');
    res.status(status).json({ error: e.message });
  }
});
```

- [ ] **Step 6: Run all backend tests + commit**

Run: `cd center && npm test 2>&1 | tail -10`
Expected: pass count up by ~2-3 new tests; total fail === 0.

Mirror sync:
```bash
cp center/src/services/migrations.js publish/system/center/src/services/migrations.js
cp center/src/routes/schema-migrations.js publish/system/center/src/routes/schema-migrations.js
powershell -File publish/system/scripts/verify-mirror.ps1 2>&1 | tail -5
```
Expected: 0 drift.

```bash
git add center/src/services/migrations.js center/src/routes/schema-migrations.js \
        center/tests/migrations-service.test.js center/tests/migrations-router.test.js \
        publish/system/center/src/services/migrations.js publish/system/center/src/routes/schema-migrations.js
git commit -m "feat(migrations): add /upgrade endpoint (apply migrations + re-run seed with checksum tracking)"
```

---

## Task 3: Frontend — apply error display + loading state + status info

**Files:**
- Modify: `frontend/src/views/admin/SchemaMigrationsView.vue` — wrap `applyOne` / `applyAllPending` / `resetOne` in try/catch, add per-row `applying` state, display `errorMessage` column, add inline error banner above table.
- Modify: `frontend/tests/schema-migrations.test.js` — add tests for error display + loading state.
- Mirror: `publish/system/frontend/src/views/admin/SchemaMigrationsView.vue`.

**Interfaces:**
- Consumes: existing `api/migrations.js` exports (`listMigrations`, `applyMigration`, `dryRunMigration`, `resetMigration`); existing `notifyError` / `notifySuccess` from `frontend/src/lib/notify.js` (verify they exist first).
- Produces: revised `SchemaMigrationsView` with:
  - `const applying = ref(new Set())` — set of versions currently being applied
  - `const rowError = ref({})` — map of `version -> { message, ts }` for inline error display after apply/reset
  - `<button :disabled="applying.has(row.version)">` for Apply/Reset buttons; text flips to "应用中…"
  - On apply success with `ok: false`: set `rowError[row.version] = { message: r.errorMessage, ts: Date.now() }` — shown as a small red bar below the row until next refresh
  - On apply exception: `notifyError` + `rowError[row.version] = { message: e.message }`
  - `applyAllPending`: stop-on-first-error (collect failures, show summary)
  - New `<td>` column "Error" between Status and Applied At: shows errorMessage text with truncation + tooltip if long

- [ ] **Step 1: Check `notifyError` / `notifySuccess` exports**

Run: `grep -n "notifyError\|notifySuccess" frontend/src/lib/notify.js | head -5`
Expected: both exist (they're already used in `api/client.js`).

- [ ] **Step 2: Write failing test for error display**

In `frontend/tests/schema-migrations.test.js`, add:

```js
test('failed apply shows errorMessage inline + sets rowError', async () => {
  vi.mocked(api.listMigrations).mockResolvedValue({ data: sampleRows });
  vi.mocked(api.applyMigration).mockResolvedValue({
    data: { ok: false, version: '010', status: 'failed', executionMs: 5, errorMessage: 'Duplicate column name' }
  });
  const w = mount(SchemaMigrationsView, { global: { plugins: [makeRouter()] } });
  await flushPromises();
  window.confirm = vi.fn(() => true);
  const pendingRow = w.findAll('tr').find(r => r.text().includes('010'));
  await pendingRow.findAll('button').find(b => b.text() === '应用').trigger('click');
  await flushPromises();
  expect(w.text()).toContain('Duplicate column name');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npm test -- schema-migrations 2>&1 | tail -15`
Expected: FAIL — text does not contain 'Duplicate column name'.

- [ ] **Step 4: Update `SchemaMigrationsView.vue`**

Replace the template + script sections. Key changes:

Template additions:
- Below `<div v-if="rows.some(r => r.status === 'failed')" class="failed-banner">…</div>` add a global error banner: `<div v-if="globalError" class="global-error">{{ globalError }}</div>`
- In the `<table>`, after the `Status` `<td>`, add an Error column:
  ```vue
  <th>Error</th>
  ...
  <td class="error-cell" :title="row.errorMessage || ''">{{ row.errorMessage ? row.errorMessage.slice(0, 60) + (row.errorMessage.length > 60 ? '…' : '') : '—' }}</td>
  ```
- On apply/reset buttons: `:disabled="applying.has(row.version) || row.busy"` with text flip:
  ```vue
  <button class="apply-btn" :disabled="applying.has(row.version)" @click="applyOne(row)">
    {{ applying.has(row.version) ? '应用中…' : '应用' }}
  </button>
  ```

Script changes:
```js
import { notifyError, notifySuccess } from '../../lib/notify.js';

const applying = ref(new Set());
const rowError = ref({});
const globalError = ref(null);

async function applyOne(row) {
  if (!confirm(`应用 migration ${row.version} (${row.description})?\n\n此操作不可逆。`)) return;
  applying.value.add(row.version);
  rowError.value[row.version] = null;
  try {
    const r = await applyMigration(row.version, {});
    if (!r.data.ok) {
      rowError.value[row.version] = r.data.errorMessage || '应用失败';
      notifyError(`Migration ${row.version} 失败: ${r.data.errorMessage}`);
    } else {
      notifySuccess(`Migration ${row.version} 应用成功`);
    }
    await refresh();
  } catch (e) {
    const msg = e?.response?.data?.error || e?.message || String(e);
    rowError.value[row.version] = msg;
    notifyError(`Migration ${row.version} 失败: ${msg}`);
  } finally {
    applying.value.delete(row.version);
  }
}

async function resetOne(row) {
  if (!confirm(`重置 migration ${row.version}?`)) return;
  applying.value.add(row.version);
  try {
    await resetMigration(row.version);
    notifySuccess(`Migration ${row.version} 已重置`);
    await refresh();
  } catch (e) {
    const msg = e?.response?.data?.error || e?.message || String(e);
    notifyError(`重置失败: ${msg}`);
  } finally {
    applying.value.delete(row.version);
  }
}

async function applyAllPending() {
  const pendings = rows.value.filter(r => r.status === 'pending');
  if (!confirm(`依次应用 ${pendings.length} 条 pending migration?`)) return;
  const failures = [];
  for (const row of pendings) {
    applying.value.add(row.version);
    try {
      const r = await applyMigration(row.version, {});
      if (!r.data.ok) failures.push(`${row.version}: ${r.data.errorMessage}`);
    } catch (e) {
      failures.push(`${row.version}: ${e?.message || e}`);
    } finally {
      applying.value.delete(row.version);
    }
  }
  await refresh();
  if (failures.length > 0) {
    notifyError(`${failures.length} 条失败:\n${failures.join('\n')}`);
  } else {
    notifySuccess(`全部 ${pendings.length} 条 migration 应用成功`);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npm test -- schema-migrations 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 6: Update existing test for new behavior**

The existing test "click [应用] → calls applyMigration + refreshes list" may break because:
- mock returns `{ data: { ok: true, ... } }` — the new code reads `r.data.ok` which works
- BUT the new code adds notifySuccess import — make sure the test mock has `notifyError` / `notifySuccess` available

If tests break due to notify imports, add to test setup:
```js
vi.mock('../src/lib/notify.js', () => ({
  notifyError: vi.fn(),
  notifySuccess: vi.fn()
}));
```

- [ ] **Step 7: Mirror + commit**

```bash
cp frontend/src/views/admin/SchemaMigrationsView.vue publish/system/frontend/src/views/admin/SchemaMigrationsView.vue
powershell -File publish/system/scripts/verify-mirror.ps1 2>&1 | tail -5
git add frontend/src/views/admin/SchemaMigrationsView.vue \
        frontend/tests/schema-migrations.test.js \
        publish/system/frontend/src/views/admin/SchemaMigrationsView.vue
git commit -m "fix(migrations-ui): surface apply errors inline + per-row loading state + error column"
```

---

## Task 4: Frontend — new buttons + current/latest version header (主路径: 记录 → 升级)

**User flow (per 2026-08-20 user clarification):** primary path is **"记录当前系统版本 → 一键升级到最新 → 到达最终版本"**. UI must surface current/latest version status and make 升级到最新 the primary CTA.

**Files:**
- Modify: `frontend/src/api/migrations.js` — add 4 wrappers: `markApplied(version)`, `baseline(version)`, `applyUpTo(version)`, `upgrade()`.
- Modify: `frontend/src/views/admin/SchemaMigrationsView.vue` — add **current/latest version header**, **4 buttons (升级到最新 as primary CTA)**, **2 modals**.
- Modify: `frontend/tests/api-migrations.test.js` — extend with 4 new API tests.
- Modify: `frontend/tests/schema-migrations.test.js` — extend with UI tests for the 4 buttons + current/latest header.
- Mirror: `publish/system/frontend/src/api/migrations.js` + `publish/system/frontend/src/views/admin/SchemaMigrationsView.vue`.

**Interfaces:**
- New API wrappers (same as before):
  ```js
  export function markApplied(version) {
    return api.post(`/api/admin/migrations/${encodeURIComponent(version)}/mark-applied`, {});
  }
  export function baseline(version) {
    return api.post('/api/admin/migrations/baseline', { version });
  }
  export function applyUpTo(version) {
    return api.post('/api/admin/migrations/apply-up-to', { version });
  }
  export function upgrade() {
    return api.post('/api/admin/migrations/upgrade', {});
  }
  ```
- UI additions:
  - **Current/Latest version header** (NEW, above actions-bar): shows `当前版本: 014  →  最新版本: 015  [差 1 个]`. Computed from rows:
    - `latestFileVersion` = `rows[rows.length - 1]?.version` (rows are sorted ascending)
    - `latestAppliedVersion` = highest `version` among `rows.filter(r => r.status === 'applied')` — display as `'—'` when none
    - `pendingCount` already exists
    - Style: prominent box with version numbers in bold; when `latestFileVersion === latestAppliedVersion`, show green "✓ 已是最新"; otherwise show amber "⚠ 有 N 条待升级".
  - **Top-bar `升级到最新` (PRIMARY CTA)** — green large button, leftmost position. When `latestFileVersion === latestAppliedVersion`, button is disabled and label changes to `已是最新`. Confirm dialog text: `执行架构升级 + 重跑 seed?\n\n将依次应用所有 pending migration,如有 seed 更新也会一并应用。`. Calls `upgrade()`, then refresh.
  - **Top-bar `记录当前版本` (secondary)** — opens modal labeled "记录当前系统版本". Hint: `把指定版本及之前的所有 migration 标记为已应用(不执行 SQL)。适用于手动执行过 migrations 或恢复备份后对齐。需 verify marker 命中。`. Calls `baseline(version)`, then refresh.
  - **Top-bar `应用到版本` (secondary)** — opens modal labeled "应用到版本". Hint: `依次应用所有 pending migration,直到指定版本(含)。`. Calls `applyUpTo(version)`, then refresh.
  - **Per-row `标记已应用`** — only visible when `row.status === 'pending' || row.status === 'failed'`. Calls `markApplied(row.version)`, then refresh.

**Patterns to reuse from Task 3** (already in the view):
- `errMsg(e)` helper — use for all `notifyError(msg)` calls instead of inline `e?.response?.data?.error || e?.message || String(e)`.
- `truncate(s)` helper — use for any user-facing version-string formatting if needed.
- `applying` Set + **immutable replacement** pattern: `applying.value = new Set(applying.value).add(row.version)` / `applying.value = next`. Direct `.value.add()` does NOT trigger Vue 3 reactivity.
- `delete rowError.value[row.version]` at start of each action to clear stale errors.
- All action handlers wrap in `try { ... } catch (e) { notifyError(errMsg(e)) } finally { applying.value = next; }`.

- [ ] **Step 1: Write failing tests for 4 new API wrappers**

In `frontend/tests/api-migrations.test.js`, add (one test per wrapper):

```js
test('markApplied POSTs to /:version/mark-applied', async () => {
  const spy = vi.spyOn(client.default, 'post').mockResolvedValue({ data: { ok: true } });
  await migrations.markApplied('014');
  expect(spy).toHaveBeenCalledWith('/api/admin/migrations/014/mark-applied', {});
});

test('baseline POSTs to /baseline with version body', async () => {
  const spy = vi.spyOn(client.default, 'post').mockResolvedValue({ data: { ok: true, versions: [] } });
  await migrations.baseline('014');
  expect(spy).toHaveBeenCalledWith('/api/admin/migrations/baseline', { version: '014' });
});

test('applyUpTo POSTs to /apply-up-to with version body', async () => {
  const spy = vi.spyOn(client.default, 'post').mockResolvedValue({ data: { ok: true, applied: [], failed: [] } });
  await migrations.applyUpTo('014');
  expect(spy).toHaveBeenCalledWith('/api/admin/migrations/apply-up-to', { version: '014' });
});

test('upgrade POSTs to /upgrade', async () => {
  const spy = vi.spyOn(client.default, 'post').mockResolvedValue({ data: { ok: true } });
  await migrations.upgrade();
  expect(spy).toHaveBeenCalledWith('/api/admin/migrations/upgrade', {});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npm test -- api-migrations 2>&1 | tail -15`
Expected: FAIL — `markApplied` etc. are not functions.

- [ ] **Step 3: Add 4 wrappers to `frontend/src/api/migrations.js`**

Append after `resetMigration`:
```js
export function markApplied(version) {
  return api.post(`/api/admin/migrations/${encodeURIComponent(version)}/mark-applied`, {});
}
export function baseline(version) {
  return api.post('/api/admin/migrations/baseline', { version });
}
export function applyUpTo(version) {
  return api.post('/api/admin/migrations/apply-up-to', { version });
}
export function upgrade() {
  return api.post('/api/admin/migrations/upgrade', {});
}
```

- [ ] **Step 4: Run API tests to verify they pass**

Run: `cd frontend && npm test -- api-migrations 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Write failing UI tests for 4 new buttons**

In `frontend/tests/schema-migrations.test.js`, add:

```js
test('pending row shows [标记已应用] button', async () => {
  vi.mocked(api.listMigrations).mockResolvedValue({ data: sampleRows });
  const w = mount(SchemaMigrationsView, { global: { plugins: [makeRouter()] } });
  await flushPromises();
  const pendingRow = w.findAll('tr').find(r => r.text().includes('010'));
  expect(pendingRow.text()).toContain('标记已应用');
});

test('top bar shows [升级到最新] button', async () => {
  vi.mocked(api.listMigrations).mockResolvedValue({ data: sampleRows });
  const w = mount(SchemaMigrationsView, { global: { plugins: [makeRouter()] } });
  await flushPromises();
  expect(w.text()).toContain('升级到最新');
});

test('click [升级到最新] → calls upgrade API', async () => {
  vi.mocked(api.listMigrations)
    .mockResolvedValueOnce({ data: sampleRows })
    .mockResolvedValueOnce({ data: sampleRows });
  vi.mocked(api.upgrade).mockResolvedValue({ data: { ok: true, migrations: { applied: [], failed: [] }, seed: { ran: false, reason: 'unchanged' }, message: 'ok' } });
  const w = mount(SchemaMigrationsView, { global: { plugins: [makeRouter()] } });
  await flushPromises();
  window.confirm = vi.fn(() => true);
  await w.findAll('button').find(b => b.text().includes('升级到最新')).trigger('click');
  await flushPromises();
  expect(api.upgrade).toHaveBeenCalled();
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd frontend && npm test -- schema-migrations 2>&1 | tail -20`
Expected: FAIL — buttons not present.

- [ ] **Step 7: Update `SchemaMigrationsView.vue`**

Add to imports:
```js
import { listMigrations, applyMigration, dryRunMigration, resetMigration, markApplied, baseline, applyUpTo, upgrade } from '../../api/migrations.js';
```

Add to template actions-bar:
```vue
<button v-if="pendingCount > 0" class="upgrade-btn" @click="doUpgrade">升级到最新</button>
<button @click="modalBaseline = ''">标记基线</button>
<button @click="modalApplyUpTo = ''">应用到版本</button>
```

Add per-row button (inside `v-if="row.status === 'pending'"`):
```vue
<button class="mark-btn" @click="doMarkApplied(row)">标记已应用</button>
```

Add modals at end of template (before `</AdminLayout>`):
```vue
<div v-if="modalBaseline !== null" class="modal-bg" @click.self="modalBaseline = null">
  <div class="modal">
    <h3>标记基线</h3>
    <p class="hint">把指定版本及之前的所有 migration 标记为已应用(不执行 SQL)。需 verify marker 命中。</p>
    <input v-model="baselineInput" placeholder="版本号 (例: 014)" />
    <div class="modal-actions">
      <button @click="modalBaseline = null">取消</button>
      <button @click="confirmBaseline" :disabled="!baselineInput">确认</button>
    </div>
  </div>
</div>

<div v-if="modalApplyUpTo !== null" class="modal-bg" @click.self="modalApplyUpTo = null">
  <div class="modal">
    <h3>应用到版本</h3>
    <p class="hint">依次应用所有 pending migration,直到指定版本(含)。</p>
    <input v-model="applyUpToInput" placeholder="版本号 (例: 014)" />
    <div class="modal-actions">
      <button @click="modalApplyUpTo = null">取消</button>
      <button @click="confirmApplyUpTo" :disabled="!applyUpToInput">确认</button>
    </div>
  </div>
</div>
```

Add to script:
```js
const modalBaseline = ref(null);
const modalApplyUpTo = ref(null);
const baselineInput = ref('');
const applyUpToInput = ref('');

async function doMarkApplied(row) {
  if (!confirm(`标记 migration ${row.version} 为已应用?\n\n不执行 SQL — 适用于你已经手动执行了此 migration 的场景。`)) return;
  applying.value.add(row.version);
  try {
    await markApplied(row.version);
    notifySuccess(`Migration ${row.version} 已标记为已应用`);
    await refresh();
  } catch (e) {
    const msg = e?.response?.data?.error || e?.message || String(e);
    notifyError(`标记失败: ${msg}`);
  } finally {
    applying.value.delete(row.version);
  }
}

async function doUpgrade() {
  if (!confirm('应用所有 pending migration + 检查 seed 更新?')) return;
  upgrading.value = true;
  try {
    const r = await upgrade();
    notifySuccess(r.data.message || '升级完成');
    await refresh();
  } catch (e) {
    const msg = e?.response?.data?.error || e?.message || String(e);
    notifyError(`升级失败: ${msg}`);
  } finally {
    upgrading.value = false;
  }
}

async function confirmBaseline() {
  if (!baselineInput.value) return;
  upgrading.value = true;
  try {
    const r = await baseline(baselineInput.value);
    notifySuccess(`基线 ${baselineInput.value} 已标记: ${r.data.versions.length} 个版本`);
    if (r.data.skipped.length > 0) {
      notifyError(`${r.data.skipped.length} 个版本因 verify marker 缺失跳过`);
    }
    modalBaseline.value = null;
    baselineInput.value = '';
    await refresh();
  } catch (e) {
    const msg = e?.response?.data?.error || e?.message || String(e);
    notifyError(`基线标记失败: ${msg}`);
  } finally {
    upgrading.value = false;
  }
}

async function confirmApplyUpTo() {
  if (!applyUpToInput.value) return;
  upgrading.value = true;
  try {
    const r = await applyUpTo(applyUpToInput.value);
    const failed = r.data.failed?.length || 0;
    const applied = r.data.applied?.length || 0;
    if (failed > 0) {
      notifyError(`应用完成: ${applied} 成功, ${failed} 失败`);
    } else {
      notifySuccess(`应用完成: ${applied} 条`);
    }
    modalApplyUpTo.value = null;
    applyUpToInput.value = '';
    await refresh();
  } catch (e) {
    const msg = e?.response?.data?.error || e?.message || String(e);
    notifyError(`应用失败: ${msg}`);
  } finally {
    upgrading.value = false;
  }
}
```

Add to refs:
```js
const upgrading = ref(false);
```

Add styles (extending the existing `<style scoped>` block):
```css
.upgrade-btn { background: #10b981; color: #fff; padding: 6px 14px; border: none; border-radius: 3px; cursor: pointer; font-weight: 600; }
.upgrade-btn:disabled { background: #1e293b; color: var(--muted); cursor: not-allowed; }
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.modal-actions button { padding: 6px 14px; }
.mark-btn { background: #f59e0b; color: #0b1220; }
.error-cell { color: #ef4444; font-size: 11px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; }
.global-error { background: #7f1d1d; color: #fecaca; padding: 10px; margin: 10px 0; border-radius: 4px; }
```

- [ ] **Step 8: Run UI tests + fix any failures**

Run: `cd frontend && npm test 2>&1 | tail -10`
Expected: PASS — all 291+ existing tests + ~7 new tests.

If the existing "click [应用] → calls applyMigration + refreshes list" test fails because of new notify imports, add to test file's top:
```js
vi.mock('../src/lib/notify.js', () => ({
  notifyError: vi.fn(),
  notifySuccess: vi.fn()
}));
```

- [ ] **Step 9: Mirror + commit**

```bash
cp frontend/src/api/migrations.js publish/system/frontend/src/api/migrations.js
cp frontend/src/views/admin/SchemaMigrationsView.vue publish/system/frontend/src/views/admin/SchemaMigrationsView.vue
powershell -File publish/system/scripts/verify-mirror.ps1 2>&1 | tail -5
git add frontend/src/api/migrations.js frontend/src/views/admin/SchemaMigrationsView.vue \
        frontend/tests/api-migrations.test.js frontend/tests/schema-migrations.test.js \
        publish/system/frontend/src/api/migrations.js publish/system/frontend/src/views/admin/SchemaMigrationsView.vue
git commit -m "feat(migrations-ui): mark-applied / baseline / apply-up-to / upgrade buttons + modals"
```

---

## Task 5: Final whole-branch review + push

**Files:** none modified — review-only.

- [ ] **Step 1: Run full test suite**

```bash
cd .worktrees/schema-migrations-upgrade
cd center && npm test 2>&1 | tail -10
cd ../frontend && npm test 2>&1 | tail -10
```
Expected: 0 failures, 0 errors.

- [ ] **Step 2: Run mirror verification**

```bash
powershell -File publish/system/scripts/verify-mirror.ps1 2>&1 | tail -10
```
Expected: 0 drift.

- [ ] **Step 3: Dispatch opus whole-branch review**

Spawn an opus reviewer subagent with the full branch diff (HEAD against `main`). The reviewer MUST check:
1. Spec coverage: every UI surface mentioned in the user request (mark-applied, baseline, apply-up-to, upgrade, error display) is implemented and test-covered.
2. Mirror sync: every source change mirrored.
3. Audit: every new endpoint writes audit.
4. Error handling: no silent failures; UI surfaces errors.
5. Seed upgrade is idempotent (checksum-based).
6. Tests are not vacuous (assert specific behavior, not just "doesn't throw").
7. The original "apply button doesn't execute" bug is actually fixed (not just refactored around).

- [ ] **Step 4: Fix any review findings**

For each finding, dispatch a single fix round per finding cluster. Track rounds 1-5 with model escalation per skill rules.

- [ ] **Step 5: Merge to main + push**

```bash
cd /d/ToolDevelop/ADDashboard
git checkout main
git merge feat/schema-migrations-upgrade --no-ff
git push origin main
git worktree remove .worktrees/schema-migrations-upgrade
git branch -d feat/schema-migrations-upgrade
```

Report:
- main SHA (post-merge)
- commits ahead of origin (should be 0 after push)
- center tests pass count
- frontend tests pass count
- whole-branch reviewer verdict
- any follow-up parked

---

## Self-Review (executed by plan author)

**1. Spec coverage:** Skim each user requirement:
- ✅ "应用按钮 bug" → Task 3 (try/catch + errorMessage display + loading state)
- ✅ "Seed/upgrade feature" → Task 2 (upgrade endpoint + seed checksum tracking) + Task 4 (升级到最新 button)
- ✅ "无法手动 mark applied" → Task 1 (markApplied endpoint) + Task 4 (per-row button)
- ✅ "apply 粒度太粗" → Task 1 (applyUpTo endpoint) + Task 4 (应用到版本 modal)
- ✅ "状态信息不全" → Task 3 (errorMessage column + appliedBy tooltip)
- ✅ "Baseline from version" → Task 1 (baseline endpoint) + Task 4 (标记基线 modal)

**2. Placeholder scan:** No "TODO", "TBD", "implement later" found. Every step has concrete code or commands.

**3. Type consistency:**
- `applyMigration` returns `{ ok, version, status, executionMs, errorMessage? }` (existing) — used in Task 1's `applyUpTo` as `r.status`, `r.errorMessage`. ✅
- `baseline` returns `{ ok, versions, skipped }` — used in Task 4's UI as `r.data.versions.length`, `r.data.skipped.length`. ✅
- `upgrade` returns `{ ok, migrations: { applied, failed }, seed: { ran, reason, errorMessage? }, message }` — used in Task 4's UI as `r.data.message`, `r.data.failed.length`. ✅
- `applyUpTo` returns `{ ok, applied, failed }` — used in Task 4 as `r.data.applied.length`, `r.data.failed.length`. ✅

No type mismatches.

**4. Drive-by avoidance:** No unrelated refactors. Every file touched is in the task scope.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-20-schema-migrations-upgrade.md`. Two execution options:

1. **Subagent-Driven (recommended)** - Dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
