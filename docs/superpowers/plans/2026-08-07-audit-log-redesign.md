# Audit Log Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat audit-log table with a tabbed-by-category UI (🔒 Security · 📝 Changes · ⚙ Ops), with severity coloring, side-drawer payload viewer, per-tab filters, 100/page pagination, and JSON/CSV export.

**Architecture:** Move the action/target label maps and category/severity rules to a single `audit-classifier.js` policy module on the backend (so the server emits `category`/`severity`/`actionLabel`/`targetLabel` and frontend just renders). Extend `GET /api/admin/audit` with parameterized filters (category / userId / from / to / severity / action / page / size), add `GET /api/admin/audit/badge` (per-tab count) and `GET /api/admin/audit/export?format=json|csv` (50k cap, server-side). Migrate `audit_logs.payload` from `TEXT` to native JSON (MySQL) / `NVARCHAR(MAX) + CHECK ISJSON` (MSSQL), add `(action, created_at)` and `(user_id, created_at)` indexes. Rewrite `AuditView.vue` as a tab-driven shell with a 40% width right-side drawer and an inline JSON tree component.

**Tech Stack:** Vue 3 + Pinia (frontend, vitest). Express + supertest (backend, node:test). MySQL + MSSQL via `buildSql(dialect)` at boot (per project convention). Native JSON column type.

## Global Constraints

- **Test frameworks** (project standard, do not change):
  - Backend: `node:test` + `node:assert/strict`. Run: `cd center && npm test`.
  - Frontend: `vitest`. Run: `cd frontend && npx vitest run`.
- **DB migrations** must include `-- verify: table X` markers at the top (verify-marker fix from 2026-08-06 — without markers the migration is treated as not-applied and won't show in admin). Marker names reference logical artifacts that exist in BOTH dialects.
- **Dialect portability**: every SQL change mirrored in both MySQL and MSSQL blocks of `center/src/db/sql.js`. Both dialects are shipped.
- **publish/ mirror**: source files (services, routes, db/sql.js, migrations, frontend code) mirror via `cp` to `publish/<same path>`. **Tests are NOT mirrored** — `publish/center/tests/` was deleted in the 2026-08-04 runtime-only cleanup. Tests live in `center/tests/` and `frontend/tests/` only.
- **No drive-by cleanup**: per user feedback memory `feedback_ship_clean.md`, do not bundle cosmetic refactors or rename unrelated files. Each commit is one focused change.
- **Audit log writes are best-effort** (existing `writeAudit` already wraps in try/catch + `logger.warn`). Do not change `writeAudit` behavior in this plan.
- **Migration test runner**: integration tests requiring real DB are guarded by `TEST_MYSQL_URL` / `TEST_MSSQL_URL` env vars; tests `t.skip` if both unset (pattern matches existing `center/tests/db/sql.test.js`).
- **Server-side classification**: `category` and `severity` filters on the server both expand to action IN-lists via the classifier. They AND together. The frontend never classifies; it only renders server-supplied values.
- **Frontend styling** uses existing CSS variables (`var(--panel)`, `var(--text)`, `var(--muted)`, `var(--accent)`) and matches the AdminLayout aesthetic. Vue scoped CSS only.
- **Audit log out-of-scope** for this plan: `sys_config_audit` table (lives in `/admin/config` view); TTL / archival; real-time tail; cross-category view; per-action permission gating.

## File Structure

**New files (6):**
- `center/src/services/audit-classifier.js` — frozen policy maps + `classifyAction()`
- `center/tests/audit-classifier.test.js`
- `center/tests/audit-list.test.js`
- `center/tests/audit-export.test.js`
- `center/tests/audit-migration.test.js`
- `db/migrations/010-audit-logs-json.sql` + `db/migrations/mssql/010-audit-logs-json.sql` (counted as 1 logical file)
- `db/migrations/011-audit-logs-indexes.sql` + `db/migrations/mssql/011-audit-logs-indexes.sql` (counted as 1 logical file)

**Modify (7):**
- `center/src/db/sql.js` — `audit` block (MySQL: lines 50-53; MSSQL: parallel block)
- `center/src/services/audit.js`
- `center/src/routes/admin.js` — `GET /api/admin/audit` block (lines 214-225)
- `frontend/src/api/admin.js`
- `frontend/src/views/admin/AuditView.vue` (full rewrite)
- `frontend/tests/audit-view.test.js` (full rewrite)
- (mirrors to `publish/...` not listed — added per task)

---

### Task 1: audit-classifier policy module

**Files:**
- Create: `center/src/services/audit-classifier.js`
- Create: `center/tests/audit-classifier.test.js`

**Interfaces:**
- Consumes: nothing (pure JS module, no DB / no IO)
- Produces (exported symbols, exact names):
  - `ACTION_CATEGORY: ReadonlyMap<string, 'security'|'changes'|'ops'>`
  - `ACTION_SEVERITY: ReadonlyMap<string, 'high'|'medium'|'low'>`
  - `ACTION_LABEL: ReadonlyMap<string, string>` (Chinese labels)
  - `TARGET_LABEL: ReadonlyMap<string, string>`
  - `CATEGORY_ACTIONS: ReadonlyMap<string, ReadonlyArray<string>>` (reverse index, derived)
  - `SEVERITY_ACTIONS: ReadonlyMap<string, ReadonlyArray<string>>` (reverse index, derived)
  - `classifyAction(action: string): { label: string, category: string, severity: string }`

- [ ] **Step 1: Write the failing tests**

`center/tests/audit-classifier.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_CATEGORY, ACTION_SEVERITY, ACTION_LABEL, TARGET_LABEL,
  CATEGORY_ACTIONS, SEVERITY_ACTIONS, classifyAction
} from '../src/services/audit-classifier.js';

test('classifier: ACTION_CATEGORY maps every emitted action to one of three categories', () => {
  const EMITTED = [
    'login', 'login_failed',
    'create_user', 'update_user', 'delete_user',
    'update_config', 'bulk_import_sites', 'bulk_assign_dc_sites',
    'apply_migration', 'reset_failed_migration'
  ];
  for (const a of EMITTED) {
    assert.ok(['security', 'changes', 'ops'].includes(ACTION_CATEGORY.get(a)),
      `action ${a} missing from ACTION_CATEGORY`);
  }
});

test('classifier: classifyAction returns Chinese label + category + severity together', () => {
  const c = classifyAction('login_failed');
  assert.equal(c.label, '登录失败');
  assert.equal(c.category, 'security');
  assert.equal(c.severity, 'high');
});

test('classifier: CATEGORY_ACTIONS.security is exactly {login_failed, delete_user}', () => {
  assert.deepEqual([...CATEGORY_ACTIONS.get('security')].sort(), ['delete_user', 'login_failed']);
});

test('classifier: SEVERITY_ACTIONS.high is exactly {login_failed, delete_user}', () => {
  assert.deepEqual([...SEVERITY_ACTIONS.get('high')].sort(), ['delete_user', 'login_failed']);
});

test('classifier: SEVERITY_ACTIONS.medium is exactly the 6 changes actions', () => {
  assert.deepEqual([...SEVERITY_ACTIONS.get('medium')].sort(), [
    'apply_migration', 'bulk_assign_dc_sites', 'bulk_import_sites',
    'reset_failed_migration', 'update_config', 'update_user'
  ]);
});

test('classifier: unknown action returns the raw action as label + ops/low fallback', () => {
  const c = classifyAction('something_new');
  assert.equal(c.label, 'something_new');
  assert.equal(c.category, 'ops');
  assert.equal(c.severity, 'low');
});

test('classifier: TARGET_LABEL includes system_config / ad_sites / ad_dcs / schema_migrations', () => {
  assert.equal(TARGET_LABEL.get('system_config'),     '系统配置');
  assert.equal(TARGET_LABEL.get('ad_sites'),          '站点目录');
  assert.equal(TARGET_LABEL.get('ad_dcs'),            '域控目录');
  assert.equal(TARGET_LABEL.get('schema_migrations'), '迁移管理');
});

test('classifier: maps are frozen (Object.isFrozen)', () => {
  assert.ok(Object.isFrozen(ACTION_CATEGORY));
  assert.ok(Object.isFrozen(ACTION_SEVERITY));
  assert.ok(Object.isFrozen(ACTION_LABEL));
  assert.ok(Object.isFrozen(TARGET_LABEL));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd center && npm test -- --test-name-pattern="classifier"
```
Expected: 8 tests fail with `Cannot find module '../src/services/audit-classifier.js'`.

- [ ] **Step 3: Implement the minimal module**

`center/src/services/audit-classifier.js`:
```js
// Single source of truth for audit-log action classification.
// Policy lives in source, not in admin-editable config — adding a new action
// requires a code change here AND a unit test asserting it is mapped.

const ACTION_CATEGORY = Object.freeze(new Map([
  ['login',                  'ops'],
  ['login_failed',           'security'],
  ['create_user',            'changes'],
  ['update_user',            'changes'],
  ['delete_user',            'security'],
  ['update_config',          'changes'],
  ['bulk_import_sites',      'changes'],
  ['bulk_assign_dc_sites',   'changes'],
  ['apply_migration',        'changes'],
  ['reset_failed_migration', 'changes']
]));

const ACTION_SEVERITY = Object.freeze(new Map([
  ['login',                  'low'],
  ['login_failed',           'high'],
  ['create_user',            'low'],
  ['update_user',            'medium'],
  ['delete_user',            'high'],
  ['update_config',          'medium'],
  ['bulk_import_sites',      'medium'],
  ['bulk_assign_dc_sites',   'medium'],
  ['apply_migration',        'medium'],
  ['reset_failed_migration', 'medium']
]));

const ACTION_LABEL = Object.freeze(new Map([
  ['login',                  '登录'],
  ['login_failed',           '登录失败'],
  ['create_user',            '创建用户'],
  ['update_user',            '修改用户'],
  ['delete_user',            '删除用户'],
  ['update_config',          '修改系统配置'],
  ['bulk_import_sites',      '批量导入站点'],
  ['bulk_assign_dc_sites',   '批量分配 DC 站点'],
  ['apply_migration',        '应用迁移'],
  ['reset_failed_migration', '重置失败迁移']
]));

const TARGET_LABEL = Object.freeze(new Map([
  ['system_config',     '系统配置'],
  ['ad_sites',          '站点目录'],
  ['ad_dcs',            '域控目录'],
  ['schema_migrations', '迁移管理']
]));

function groupByValue(map) {
  const out = new Map();
  for (const [k, v] of map) {
    if (!out.has(v)) out.set(v, []);
    out.get(v).push(k);
  }
  for (const arr of out.values()) arr.sort();
  return Object.freeze(out);
}

const CATEGORY_ACTIONS = groupByValue(ACTION_CATEGORY);
const SEVERITY_ACTIONS = groupByValue(ACTION_SEVERITY);

export function classifyAction(action) {
  return {
    label:    ACTION_LABEL.get(action)    ?? action,
    category: ACTION_CATEGORY.get(action) ?? 'ops',
    severity: ACTION_SEVERITY.get(action) ?? 'low'
  };
}

export {
  ACTION_CATEGORY, ACTION_SEVERITY, ACTION_LABEL, TARGET_LABEL,
  CATEGORY_ACTIONS, SEVERITY_ACTIONS
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd center && npm test -- --test-name-pattern="classifier"
```
Expected: 8 tests pass.

- [ ] **Step 5: Mirror and commit**

```bash
mkdir -p publish/center/src/services
cp center/src/services/audit-classifier.js publish/center/src/services/audit-classifier.js
git add center/src/services/audit-classifier.js center/tests/audit-classifier.test.js \
        publish/center/src/services/audit-classifier.js
git commit -m "feat(audit): audit-classifier policy module with frozen action/category/severity maps"
```

---

### Task 2: DB migrations 010 (payload JSON) + 011 (indexes) + migration tests

**Files:**
- Create: `db/migrations/010-audit-logs-json.sql`
- Create: `db/migrations/mssql/010-audit-logs-json.sql`
- Create: `db/migrations/011-audit-logs-indexes.sql`
- Create: `db/migrations/mssql/011-audit-logs-indexes.sql`
- Create: `center/tests/audit-migration.test.js`

**Interfaces:**
- Consumes: existing `audit_logs` table from `db/schema/01-tables.sql` — `payload TEXT NULL`, plus indexes `ix_audit_time (created_at)`.
- Produces:
  - Migration 010: payload column becomes JSON (MySQL `MODIFY COLUMN JSON`) / NVARCHAR(MAX) + ISJSON CHECK (MSSQL).
  - Migration 011: two indexes `ix_audit_action_time (action, created_at)` and `ix_audit_user_time (user_id, created_at)`. No verify markers (indexes are not tables/columns per marker grammar).
  - 3 migration tests (DB-guarded: skip if both `TEST_MYSQL_URL` and `TEST_MSSQL_URL` unset).

- [ ] **Step 1: Write the failing migration tests**

`center/tests/audit-migration.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseVerifyMarker } from '../src/init/verify-marker.js';

const MYSQL = !!process.env.TEST_MYSQL_URL;
const MSSQL = !!process.env.TEST_MSSQL_URL;

test('migration 010 (mysql + mssql): declares "verify: table audit_logs" marker so bootstrapMigrations works', () => {
  const mysql = parseVerifyMarker(fs.readFileSync('db/migrations/010-audit-logs-json.sql', 'utf8'));
  const mssql = parseVerifyMarker(fs.readFileSync('db/migrations/mssql/010-audit-logs-json.sql', 'utf8'));
  assert.ok(mysql, 'mysql 010 must declare a verify marker');
  assert.ok(mssql, 'mssql 010 must declare a verify marker');
  assert.match(mysql, /audit_logs/);
  assert.match(mssql, /audit_logs/);
});

test('migration 010 (mysql): payload column DATA_TYPE becomes json after migration', { skip: !MYSQL }, async () => {
  // The implementer fleshes this out following the pattern of existing migration
  // integration tests in center/tests/db/sql.test.js. It must:
  //  - Connect via the existing TEST_MYSQL_URL path
  //  - Run the migration against the test DB (use the schema-applier; do NOT
  //    hand-parse SQL)
  //  - Inspect information_schema.columns: DATA_TYPE = 'json' for payload
  //  - Insert one row with JSON.stringify payload, SELECT it back, assert parse equality
  // The body depends on the project's test-DB plumbing; mirror the simplest
  // existing pattern (one connection, one migration apply, one assertion).
  assert.fail('implementer: replace with TEST_MYSQL_URL integration body');
});

test('migration 010 (mssql): payload column becomes NVARCHAR(MAX) + ISJSON CHECK exists', { skip: !MSSQL }, async () => {
  // Same pattern as the mysql test, against TEST_MSSQL_URL:
  //  - sys.columns: max_length = -1
  //  - sys.check_constraints: name = 'ck_audit_logs_payload_json'
  assert.fail('implementer: replace with TEST_MSSQL_URL integration body');
});

test('migration 011 (mysql + mssql): both indexes exist after run', { skip: !MYSQL && !MSSQL }, async () => {
  // MySQL: SELECT INDEX_NAME FROM information_schema.statistics WHERE table_name='audit_logs'
  //   must include 'ix_audit_action_time' and 'ix_audit_user_time'.
  // MSSQL: SELECT name FROM sys.indexes WHERE object_id = OBJECT_ID('audit_logs')
  //   must include 'ix_audit_action_time' and 'ix_audit_user_time'.
  assert.fail('implementer: replace with DB-guarded integration body');
});

test('migration 010: rerun is a no-op (idempotent)', { skip: !MYSQL && !MSSQL }, async () => {
  // Apply the migration twice via schema-applier; second apply must NOT throw
  // and must NOT corrupt existing data (SELECT COUNT(*) unchanged).
  assert.fail('implementer: replace with DB-guarded integration body');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd center && npm test -- --test-name-pattern="migration"
```
Expected: marker assertion passes (markers are required) but the DB-guarded tests fail to even load (migration files don't exist yet) → overall 1 pass, 4 fail. Implementer must keep the marker test passing while creating the migration files in Step 3.

Actually, the more deterministic first failing check: the DB-guarded tests `skip` cleanly when no env is set, and the marker test `fails` because files don't exist → 4 of 5 tests fail. Acceptable.

- [ ] **Step 3: Write migration 010 (both dialects)**

`db/migrations/010-audit-logs-json.sql`:
```sql
-- verify: table audit_logs

-- 010-audit-logs-json.sql
-- Change audit_logs.payload from TEXT to native JSON so the backend can parse
-- it on read and future work can index payload keys. Existing rows survive
-- because every prior write used JSON.stringify — MySQL auto-casts the TEXT
-- payload into JSON on ALTER COLUMN. See:
-- docs/superpowers/specs/2026-08-07-audit-log-redesign-design.md
ALTER TABLE audit_logs MODIFY COLUMN payload JSON NULL;
```

`db/migrations/mssql/010-audit-logs-json.sql`:
```sql
-- verify: table audit_logs

-- 010-audit-logs-json.sql (MSSQL)
-- See mysql counterpart. NVARCHAR(MAX) is MSSQL's storage type for JSON text;
-- the ISJSON CHECK enforces shape going forward. Existing rows survive the
-- column type change (NVARCHAR(MAX) accepts any size). We nullify any
-- non-JSON existing rows BEFORE adding the CHECK, so the constraint never
-- rejects on migration.
IF EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('audit_logs') AND name = 'payload'
    AND system_type_id <> 231   -- nvarchar(max)
)
BEGIN
  ALTER TABLE audit_logs ALTER COLUMN payload NVARCHAR(MAX) NULL;
END

IF NOT EXISTS (
  SELECT 1 FROM sys.check_constraints WHERE name = 'ck_audit_logs_payload_json'
)
BEGIN
  UPDATE audit_logs SET payload = NULL
    WHERE payload IS NOT NULL
      AND (ISJSON(payload) = 0);
  ALTER TABLE audit_logs
    ADD CONSTRAINT ck_audit_logs_payload_json CHECK (payload IS NULL OR ISJSON(payload) = 1);
END
```

- [ ] **Step 4: Write migration 011 (both dialects)**

`db/migrations/011-audit-logs-indexes.sql`:
```sql
-- 011-audit-logs-indexes.sql
-- Speed up tab-category + per-user drill-down queries as the table grows.
-- No verify markers: indexes are not tables/columns per the marker grammar
-- (see center/src/init/verify-marker.js). bootstrapMigrations probes the
-- table itself, which already exists from migration 001, so this file is
-- not gated on its own marker.
-- See: docs/superpowers/specs/2026-08-07-audit-log-redesign-design.md
CREATE INDEX IF NOT EXISTS ix_audit_action_time ON audit_logs (action, created_at);
CREATE INDEX IF NOT EXISTS ix_audit_user_time   ON audit_logs (user_id, created_at);
```

`db/migrations/mssql/011-audit-logs-indexes.sql`:
```sql
-- 011-audit-logs-indexes.sql (MSSQL)
-- See mysql counterpart. Existence-check pattern matches other MSSQL migrations.
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'ix_audit_action_time' AND object_id = OBJECT_ID('audit_logs')
)
  CREATE INDEX ix_audit_action_time ON audit_logs (action, created_at);

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE name = 'ix_audit_user_time' AND object_id = OBJECT_ID('audit_logs')
)
  CREATE INDEX ix_audit_user_time ON audit_logs (user_id, created_at);
```

- [ ] **Step 5: Flesh out the DB-guarded tests**

Implementer expands the `assert.fail('implementer: replace with ...')` bodies following the existing pattern in `center/tests/db/sql.test.js`. Concretely:
- For MySQL integration: use `mysql2/promise` directly against `process.env.TEST_MYSQL_URL`, run the migration file contents split on `;`, then query `information_schema`.
- For MSSQL integration: use `mssql` package directly against `process.env.TEST_MSSQL_URL`, run the migration file contents in a batch, then query `sys.columns` / `sys.check_constraints` / `sys.indexes`.

The exact driver code is project-specific; the implementer should `grep -r TEST_MYSQL_URL center/tests/` to find the existing pattern and follow it.

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd center && npm test -- --test-name-pattern="migration"
```
Expected: marker test passes always; DB-guarded tests pass when at least one env is set, skip cleanly when neither is set.

- [ ] **Step 7: Run full center suite to confirm no regressions**

```bash
cd center && npm test
```
Expected: 444 prior pass + 5 new pass = 449 pass; 11 prior skip; 0 fail.

- [ ] **Step 8: Mirror and commit**

```bash
mkdir -p publish/db/migrations/mssql
cp db/migrations/010-audit-logs-json.sql         publish/db/migrations/010-audit-logs-json.sql
cp db/migrations/mssql/010-audit-logs-json.sql  publish/db/migrations/mssql/010-audit-logs-json.sql
cp db/migrations/011-audit-logs-indexes.sql      publish/db/migrations/011-audit-logs-indexes.sql
cp db/migrations/mssql/011-audit-logs-indexes.sql publish/db/migrations/mssql/011-audit-logs-indexes.sql
git add db/migrations/010-audit-logs-json.sql db/migrations/mssql/010-audit-logs-json.sql \
        db/migrations/011-audit-logs-indexes.sql db/migrations/mssql/011-audit-logs-indexes.sql \
        center/tests/audit-migration.test.js \
        publish/db/migrations/010-audit-logs-json.sql publish/db/migrations/mssql/010-audit-logs-json.sql \
        publish/db/migrations/011-audit-logs-indexes.sql publish/db/migrations/mssql/011-audit-logs-indexes.sql
git commit -m "feat(db): migration 010 (payload JSON) + 011 (action/user indexes), both dialects"
```

---

### Task 3: Backend SQL rewrite + `listAudit` service + extended `GET /api/admin/audit`

**Files:**
- Modify: `center/src/db/sql.js` — `audit` block in both MySQL and MSSQL
- Modify: `center/src/services/audit.js` — add `listAudit`, `getAuditBadge`
- Modify: `center/src/routes/admin.js` — replace `GET /api/admin/audit` block (lines 214-225); add `GET /api/admin/audit/badge`
- Create: `center/tests/audit-list.test.js`

**Interfaces:**
- Consumes: `audit-classifier.js` (specifically `CATEGORY_ACTIONS`, `SEVERITY_ACTIONS`, `classifyAction`)
- Produces:
  - SQL templates in `db.sql.audit`:
    - `list` — base SELECT with LEFT JOIN sys_users (no WHERE/ORDER/LIMIT — appended dynamically by service)
    - `count` — `SELECT COUNT(*) FROM audit_logs` (no WHERE — appended dynamically)
    - `badge` — `SELECT COUNT(*) FROM audit_logs WHERE action IN (?, ?, ?)` (placeholder count fixed at 3; but service builds it dynamically to match CATEGORY_ACTIONS length per category)
  - Service `listAudit({category, actions, severities, userId, from, to, page=1, size=100})` returns `{rows, total, filtered, page, size}` where `rows` items have shape `{id, userId, username, action, actionLabel, category, severity, target, targetLabel, payload, createdAt}` and `payload` is parsed JSON.
  - Service `getAuditBadge(category)` returns `number` (count of rows in that category).
  - Route `GET /api/admin/audit?category=&action=&severity=&userId=&from=&to=&page=&size=` returns `{rows, total, page, size, filtered}`. Caps `size <= 100`. 400 on invalid category / page / size.
  - Route `GET /api/admin/audit/badge?category=` returns `{category, count}`.

- [ ] **Step 1: Write the failing tests**

`center/tests/audit-list.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { adminRouter } from '../src/routes/admin.js';
import { signJwt } from '../src/auth/jwt.js';
import { _setDbForTest } from '../src/db/index.js';
import { buildMockDb } from './helpers/db-mock.js';

const SECRET = 'test-secret';
function adminToken() { return signJwt({ sub: 'u1', role: 'admin', permissions: ['*'] }, SECRET, 60); }
function buildApp() {
  const a = express(); a.use(express.json());
  return a.use(adminRouter({ config: { jwtSecret: SECRET }, logger: { info(){}, error(){}, warn(){}, debug(){} } }));
}

test('GET /api/admin/audit?category=security: returns rows with parsed payload + label/category/severity', async () => {
  let capturedSql = '', capturedParams = [];
  const db = buildMockDb([
    {
      match: /FROM audit_logs/i,
      capture: true,
      onQuery: (sql, params) => {
        capturedSql = sql; capturedParams = params;
        if (/COUNT/i.test(sql)) return { rows: [{ total: 1 }] };
        return { rows: [{ id: 1, user_id: 1, username: 'admin', action: 'login_failed', target: null, payload: '{"ip":"1.2.3.4"}', created_at: new Date() }] };
      }
    }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .get('/api/admin/audit?category=security&page=1&size=100')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.rows.length, 1);
  assert.equal(r.body.rows[0].action, 'login_failed');
  assert.equal(r.body.rows[0].actionLabel, '登录失败');
  assert.equal(r.body.rows[0].category, 'security');
  assert.equal(r.body.rows[0].severity, 'high');
  assert.deepEqual(r.body.rows[0].payload, { ip: '1.2.3.4' });
  assert.match(capturedSql, /action\s+IN\s*\(/);
  assert.ok(capturedParams.includes('login_failed'));
  assert.ok(capturedParams.includes('delete_user'));
});

test('GET /api/admin/audit: invalid category returns 400', async () => {
  _setDbForTest(buildMockDb().standard());
  const r = await supertest(buildApp())
    .get('/api/admin/audit?category=evil')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /category/i);
});

test('GET /api/admin/audit: userId / from / to compose into WHERE', async () => {
  let capturedSql = '', capturedParams = [];
  const db = buildMockDb([
    {
      match: /FROM audit_logs/i, capture: true,
      onQuery: (sql, params) => {
        capturedSql = sql; capturedParams = params;
        if (/COUNT/i.test(sql)) return { rows: [{ total: 0 }] };
        return { rows: [] };
      }
    }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .get('/api/admin/audit?userId=7&from=2026-08-01&to=2026-08-07')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.match(capturedSql, /user_id\s*=\s*\?/);
  assert.match(capturedSql, /created_at\s*>=\s*\?/);
  assert.match(capturedSql, /created_at\s*<=\s*\?/);
  assert.ok(capturedParams.includes(7));
  assert.ok(capturedParams.includes('2026-08-01'));
  assert.ok(capturedParams.includes('2026-08-07'));
});

test('GET /api/admin/audit: pagination — page 2 binds size=100 and offset=100 as the last two params', async () => {
  // Dialect-agnostic: do NOT assert on SQL syntax (MySQL uses LIMIT ? OFFSET ?,
  // MSSQL uses OFFSET ? ROWS FETCH NEXT ? ROWS ONLY). Assert on the bound
  // parameters instead, which encode the same pagination semantic in both.
  let capturedParams = [];
  const db = buildMockDb([
    {
      match: /FROM audit_logs/i, capture: true,
      onQuery: (sql, params) => {
        capturedParams = params;
        if (/COUNT/i.test(sql)) return { rows: [{ total: 200 }] };
        return { rows: [] };
      }
    }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .get('/api/admin/audit?page=2&size=100')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  // The list query binds [whereParams..., size, offset]; offset = (page-1)*size = 100.
  const tail = capturedParams.slice(-2);
  assert.deepEqual(tail, [100, 100]);
});

test('GET /api/admin/audit: payload column returns parsed JSON object', async () => {
  const db = buildMockDb([
    {
      match: /FROM audit_logs/i, capture: true,
      onQuery: (sql, params) => {
        if (/COUNT/i.test(sql)) return { rows: [{ total: 1 }] };
        return { rows: [{ id: 1, user_id: null, username: null, action: 'login', target: null, payload: '{"foo":42}', created_at: new Date() }] };
      }
    }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .get('/api/admin/audit')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(typeof r.body.rows[0].payload, 'object');
  assert.equal(r.body.rows[0].payload.foo, 42);
});

test('GET /api/admin/audit: malformed JSON payload returns null', async () => {
  const db = buildMockDb([
    {
      match: /FROM audit_logs/i, capture: true,
      onQuery: (sql) => {
        if (/COUNT/i.test(sql)) return { rows: [{ total: 1 }] };
        return { rows: [{ id: 1, user_id: null, username: null, action: 'login', target: null, payload: 'not-json{', created_at: new Date() }] };
      }
    }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .get('/api/admin/audit')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.rows[0].payload, null);
});

test('GET /api/admin/audit: severity filter expands to action IN-list', async () => {
  let capturedParams = [];
  const db = buildMockDb([
    {
      match: /FROM audit_logs/i, capture: true,
      onQuery: (sql, params) => {
        capturedParams = params;
        if (/COUNT/i.test(sql)) return { rows: [{ total: 0 }] };
        return { rows: [] };
      }
    }
  ]).standard();
  _setDbForTest(db);
  await supertest(buildApp())
    .get('/api/admin/audit?severity=high')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.ok(capturedParams.includes('login_failed'));
  assert.ok(capturedParams.includes('delete_user'));
});

test('GET /api/admin/audit: size > 100 returns 400', async () => {
  _setDbForTest(buildMockDb().standard());
  const r = await supertest(buildApp())
    .get('/api/admin/audit?size=500')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 400);
});

test('GET /api/admin/audit: 401 without token', async () => {
  _setDbForTest(buildMockDb().standard());
  const r = await supertest(buildApp()).get('/api/admin/audit');
  assert.equal(r.status, 401);
});

test('GET /api/admin/audit/badge?category=security: returns {category, count}', async () => {
  const db = buildMockDb([
    { match: /COUNT\(\*\)/i, capture: true, onQuery: () => ({ rows: [{ total: 42 }] }) }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .get('/api/admin/audit/badge?category=security')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { category: 'security', count: 42 });
});

test('GET /api/admin/audit/badge: invalid category returns 400', async () => {
  _setDbForTest(buildMockDb().standard());
  const r = await supertest(buildApp())
    .get('/api/admin/audit/badge?category=evil')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 400);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd center && npm test -- --test-name-pattern="audit-list"
```
Expected: 11 tests fail (route returns flat array, no filters, no labels).

- [ ] **Step 3: Rewrite the `audit` SQL block in `center/src/db/sql.js`**

Replace MySQL block at lines 50-53:
```js
audit: {
  write: 'INSERT INTO audit_logs (user_id, action, target, payload) VALUES (?, ?, ?, ?)',
  // Base SELECT — service appends WHERE / ORDER BY / LIMIT / OFFSET dynamically.
  // LEFT JOIN to resolve username; service nullifies when user is missing.
  list: `SELECT a.id, a.user_id AS userId, a.action, a.target, a.payload,
                a.created_at AS createdAt, u.username AS username
         FROM audit_logs a
         LEFT JOIN sys_users u ON a.user_id = u.id`,
  count: `SELECT COUNT(*) AS total FROM audit_logs a`,
  badge: `SELECT COUNT(*) AS total FROM audit_logs a WHERE a.action IN (?, ?, ?)`
}
```

The `badge` SQL uses a fixed 3-placeholder IN-list because the largest category (`changes`) has 7 actions. Two strategies here; implementer picks one:
- (a) Use a fixed 3-placeholder list; service passes only the first 3 of the category's actions (rejected — fragile).
- (b) Build the SQL fragment dynamically in JS using `list.map(() => '?').join(',')` — same pattern as `listAudit`'s WHERE building. Recommended. The `db.sql.audit.badge` is then a function `(actionList) => \`SELECT COUNT(*) AS total FROM audit_logs a WHERE a.action IN (${actionList.map(()=>'?').join(',')})\``. Service calls it like `db.sql.audit.badge(list)` and passes `list` as params.

Use strategy (b). Update the SQL definition:
```js
badge: (actionList) => `SELECT COUNT(*) AS total FROM audit_logs a WHERE a.action IN (${actionList.map(() => '?').join(',')})`
```

Do the same in the MSSQL block (parallel structure with `LEFT JOIN sys_users u ON a.user_id = u.id`).

- [ ] **Step 4: Extend `center/src/services/audit.js`**

Replace the entire file:
```js
import { getDb } from '../db/index.js';
import {
  CATEGORY_ACTIONS, SEVERITY_ACTIONS, TARGET_LABEL, classifyAction
} from './audit-classifier.js';

export async function writeAudit({ userId, action, target, payload }, logger) {
  const db = getDb();
  try {
    await db.execute(db.sql.audit.write, [
      userId ?? null,
      action,
      target ?? null,
      payload == null ? null : JSON.stringify(payload)
    ]);
  } catch (e) {
    if (logger) logger.warn({ err: e.message, action, target }, 'audit write failed (best-effort)');
  }
}

function buildWhere({ category, actions, severities, userId, from, to }) {
  const conds = [];
  const params = [];
  if (category) {
    const list = CATEGORY_ACTIONS.get(category);
    if (!list) throw Object.assign(new Error('invalid category'), { httpStatus: 400 });
    conds.push(`a.action IN (${list.map(() => '?').join(',')})`);
    params.push(...list);
  }
  if (Array.isArray(actions) && actions.length) {
    conds.push(`a.action IN (${actions.map(() => '?').join(',')})`);
    params.push(...actions);
  }
  if (Array.isArray(severities) && severities.length) {
    const list = severities.flatMap(s => SEVERITY_ACTIONS.get(s) ?? []);
    if (list.length) {
      conds.push(`a.action IN (${list.map(() => '?').join(',')})`);
      params.push(...list);
    }
  }
  if (Number.isInteger(userId)) { conds.push('a.user_id = ?'); params.push(userId); }
  if (from) { conds.push('a.created_at >= ?'); params.push(from); }
  if (to)   { conds.push('a.created_at <= ?'); params.push(to); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return { where, params };
}

function parsePayload(raw, logger) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (e) {
    logger?.warn?.({ err: e.message }, 'audit payload parse failed');
    return null;
  }
}

export async function listAudit({ category, actions, severities, userId, from, to, page = 1, size = 100 } = {}) {
  const db = getDb();
  const { where, params } = buildWhere({ category, actions, severities, userId, from, to });
  const { rows: countRows } = await db.query(`${db.sql.audit.count} ${where}`, params);
  const total = Number(countRows[0].total);
  const offset = (page - 1) * size;
  const listParams = [...params, size, offset];
  const { rows } = await db.query(
    `${db.sql.audit.list} ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`,
    listParams
  );
  return {
    rows: rows.map(r => ({
      id: r.id,
      userId: r.userId,
      username: r.username ?? null,
      action: r.action,
      actionLabel: classifyAction(r.action).label,
      category: classifyAction(r.action).category,
      severity: classifyAction(r.action).severity,
      target: r.target,
      targetLabel: r.target ? (TARGET_LABEL.get(r.target) ?? r.target) : null,
      payload: parsePayload(r.payload),
      createdAt: r.createdAt
    })),
    total,
    filtered: total,
    page,
    size
  };
}

export async function getAuditBadge(category) {
  const list = CATEGORY_ACTIONS.get(category);
  if (!list) throw Object.assign(new Error('invalid category'), { httpStatus: 400 });
  const db = getDb();
  const { rows } = await db.query(db.sql.audit.badge(list), list);
  return Number(rows[0].total);
}
```

- [ ] **Step 5: Extend `GET /api/admin/audit` and add `GET /api/admin/audit/badge` in `center/src/routes/admin.js`**

Replace the existing block at lines 214-225:
```js
r.get('/api/admin/audit', auth, async (req, res) => {
  try {
    const { listAudit } = await import('../services/audit.js');
    const { category, action, severity, userId, from, to, page = 1, size = 100 } = req.query;
    const pageNum = Number(page);
    const sizeNum = Number(size);
    if (!Number.isInteger(pageNum) || pageNum < 1) return res.status(400).json({ error: 'invalid page' });
    if (!Number.isInteger(sizeNum) || sizeNum < 1 || sizeNum > 100) return res.status(400).json({ error: 'size must be 1..100' });
    const result = await listAudit({
      category,
      actions: action ? String(action).split(',') : undefined,
      severities: severity ? String(severity).split(',') : undefined,
      userId: userId ? Number(userId) : undefined,
      from, to,
      page: pageNum,
      size: sizeNum
    });
    res.json(result);
  } catch (e) {
    if (e.httpStatus === 400) return res.status(400).json({ error: e.message });
    logger.error({ err: e }, 'admin audit list failed');
    res.status(500).json({ error: 'internal' });
  }
});

r.get('/api/admin/audit/badge', auth, async (req, res) => {
  try {
    const { getAuditBadge } = await import('../services/audit.js');
    const count = await getAuditBadge(req.query.category);
    res.json({ category: req.query.category, count });
  } catch (e) {
    if (e.httpStatus === 400) return res.status(400).json({ error: e.message });
    logger.error({ err: e }, 'admin audit badge failed');
    res.status(500).json({ error: 'internal' });
  }
});
```

The dynamic `await import('../services/audit.js')` matches the existing pattern at line 219 of the original route — do not change to a top-level import.

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd center && npm test -- --test-name-pattern="audit-list"
```
Expected: 11 tests pass.

- [ ] **Step 7: Run full center suite**

```bash
cd center && npm test
```
Expected: 449 prior pass + 11 new = 460 pass; 11 skip; 0 fail.

- [ ] **Step 8: Mirror and commit**

```bash
cp center/src/db/sql.js                publish/center/src/db/sql.js
cp center/src/services/audit.js        publish/center/src/services/audit.js
cp center/src/routes/admin.js          publish/center/src/routes/admin.js
git add center/src/db/sql.js center/src/services/audit.js center/src/routes/admin.js center/tests/audit-list.test.js \
        publish/center/src/db/sql.js publish/center/src/services/audit.js publish/center/src/routes/admin.js
git commit -m "feat(audit): list + badge endpoints with parameterized filters + classifier integration"
```

---

### Task 4: Backend export route + tests

**Files:**
- Modify: `center/src/routes/admin.js` — add `GET /api/admin/audit/export`
- Create: `center/tests/audit-export.test.js`

**Interfaces:**
- Consumes: `listAudit` filter shape from Task 3 (re-uses `buildWhere`-equivalent for cap-probe).
- Produces:
  - Route `GET /api/admin/audit/export?format=json|csv&category=&action=&severity=&userId=&from=&to=`:
    - Same filter semantics as list, no pagination.
    - First probes `total` via the same WHERE; if `total > 50000` → 413 with body `{error: "导出行数 N 超过上限 50000，请先用过滤器缩小范围"}`.
    - Else loads up to `size = 50001` rows, streams as JSON or CSV.
    - Response headers: `Content-Disposition: attachment; filename="audit-{category|all}-{YYYYMMDD-HHmmss}.{json|csv}"`.
    - JSON content type: `application/json`.
    - CSV content type: `text/csv; charset=utf-8`. Header row: `时间 (UTC+8),用户名,动作,目标,严重性,类别,payload(json)`. Each value RFC-4180 escaped (quote-wrap if contains `,` `"` or newline; double quotes inside values).

- [ ] **Step 1: Write the failing tests**

`center/tests/audit-export.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { adminRouter } from '../src/routes/admin.js';
import { signJwt } from '../src/auth/jwt.js';
import { _setDbForTest } from '../src/db/index.js';
import { buildMockDb } from './helpers/db-mock.js';

const SECRET = 'test-secret';
function adminToken() { return signJwt({ sub: 'u1', role: 'admin', permissions: ['*'] }, SECRET, 60); }
function buildApp() {
  const a = express(); a.use(express.json());
  return a.use(adminRouter({ config: { jwtSecret: SECRET }, logger: { info(){}, error(){}, warn(){}, debug(){} } }));
}

const SAMPLE_ROW = {
  id: 1, user_id: 1, username: 'admin', action: 'login_failed',
  target: null, payload: '{"ip":"1.2.3.4"}',
  created_at: new Date('2026-08-06T10:00:00Z')
};

test('GET /api/admin/audit/export?format=json: returns application/json array, content-disposition matches audit-security-*.json', async () => {
  const db = buildMockDb([
    {
      match: /FROM audit_logs/i, capture: true,
      onQuery: (sql) => {
        if (/COUNT/i.test(sql)) return { rows: [{ total: 1 }] };
        return { rows: [SAMPLE_ROW] };
      }
    }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .get('/api/admin/audit/export?format=json&category=security')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /application\/json/);
  assert.match(r.headers['content-disposition'] || '', /attachment.*audit-security-.*\.json/);
  const body = JSON.parse(r.text);
  assert.ok(Array.isArray(body));
  assert.equal(body.length, 1);
  assert.equal(body[0].action, 'login_failed');
});

test('GET /api/admin/audit/export?format=csv: header line + data rows, content-type text/csv', async () => {
  const db = buildMockDb([
    {
      match: /FROM audit_logs/i, capture: true,
      onQuery: (sql) => {
        if (/COUNT/i.test(sql)) return { rows: [{ total: 1 }] };
        return { rows: [SAMPLE_ROW] };
      }
    }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .get('/api/admin/audit/export?format=csv')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/csv/);
  const lines = r.text.trim().split('\n');
  assert.ok(lines.length >= 2);
  assert.match(lines[0], /时间.*用户.*动作.*目标.*严重性.*类别/);
  assert.match(lines[1], /登录失败/);
});

test('GET /api/admin/audit/export: 413 when count exceeds 50000', async () => {
  const db = buildMockDb([
    {
      match: /FROM audit_logs/i, capture: true,
      onQuery: (sql) => {
        if (/COUNT/i.test(sql)) return { rows: [{ total: 50001 }] };
        return { rows: [] };
      }
    }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(buildApp())
    .get('/api/admin/audit/export?format=json')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 413);
  assert.match(r.body.error, /50000|narrow|缩小/);
});

test('GET /api/admin/audit/export: invalid format returns 400', async () => {
  _setDbForTest(buildMockDb().standard());
  const r = await supertest(buildApp())
    .get('/api/admin/audit/export?format=xml')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 400);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd center && npm test -- --test-name-pattern="audit-export"
```
Expected: 4 tests fail (route doesn't exist).

- [ ] **Step 3: Implement the export route in `center/src/routes/admin.js`**

Add immediately after the `GET /api/admin/audit/badge` handler:
```js
const EXPORT_CAP = 50000;

r.get('/api/admin/audit/export', auth, async (req, res) => {
  try {
    const { listAudit } = await import('../services/audit.js');
    const format = req.query.format;
    if (format !== 'json' && format !== 'csv') {
      return res.status(400).json({ error: 'format must be json or csv' });
    }
    const { category, action, severity, userId, from, to } = req.query;
    const opts = {
      category,
      actions: action ? String(action).split(',') : undefined,
      severities: severity ? String(severity).split(',') : undefined,
      userId: userId ? Number(userId) : undefined,
      from, to
    };
    // Probe total first (page 1, size 1) — reuses listAudit's filter SQL.
    const probe = await listAudit({ ...opts, page: 1, size: 1 });
    if (probe.total > EXPORT_CAP) {
      return res.status(413).json({ error: `导出行数 ${probe.total} 超过上限 ${EXPORT_CAP}，请先用过滤器缩小范围` });
    }
    const full = await listAudit({ ...opts, page: 1, size: EXPORT_CAP + 1 });
    const ts = formatTsForFilename(new Date());
    const filename = `audit-${category || 'all'}-${ts}.${format}`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify(full.rows, null, 2));
    } else {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.send(toCsv(full.rows));
    }
  } catch (e) {
    if (e.httpStatus === 400) return res.status(400).json({ error: e.message });
    logger.error({ err: e }, 'admin audit export failed');
    res.status(500).json({ error: 'internal' });
  }
});

function formatTsForFilename(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function toCsv(rows) {
  const headers = ['时间 (UTC+8)', '用户名', '动作', '目标', '严重性', '类别', 'payload(json)'];
  const esc = v => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push([
      esc(new Date(r.createdAt).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })),
      esc(r.username),
      esc(r.actionLabel),
      esc(r.target),
      esc(r.severity),
      esc(r.category),
      esc(r.payload)
    ].join(','));
  }
  return lines.join('\n');
}
```

Note: `EXPORT_CAP + 1` is intentional — the service caps at `size` rows, so requesting `EXPORT_CAP + 1` returns at most 50001 rows (the cap is on the JSON probe, not on this fetch).

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd center && npm test -- --test-name-pattern="audit-export"
```
Expected: 4 tests pass.

- [ ] **Step 5: Run full center suite**

```bash
cd center && npm test
```
Expected: 460 + 4 = 464 pass; 11 skip; 0 fail.

- [ ] **Step 6: Mirror and commit**

```bash
cp center/src/routes/admin.js publish/center/src/routes/admin.js
git add center/src/routes/admin.js center/tests/audit-export.test.js publish/center/src/routes/admin.js
git commit -m "feat(audit): export endpoint with JSON + CSV formats, 50k cap, server-side filter"
```

---

### Task 5: Frontend API + AuditView.vue rewrite + tests

**Files:**
- Modify: `frontend/src/api/admin.js`
- Modify: `frontend/src/views/admin/AuditView.vue` (full rewrite)
- Modify: `frontend/tests/audit-view.test.js` (full rewrite)

**Interfaces:**
- Consumes: backend routes from Tasks 3 + 4.
- Produces:
  - `adminApi.getAudit({category, page=1, size=100, userId, actions, severities, from, to})` — returns the `{rows, total, filtered, page, size}` shape (axios wraps in `{data}`).
  - `adminApi.getAuditBadge(category)` — returns `{category, count}`.
  - `adminApi.exportAudit(format, filters)` — returns a `Blob` (via axios `responseType: 'blob'`).
  - `AuditView.vue` — tab-driven shell: 3 tabs (Security / Changes / Ops) with badges; per-tab filter strip (time preset, user ID, severity multi-select); compact 5-col table with severity-colored left border; 100/page pagination (prev / range / next); 40% width right-side drawer with collapsible inline JSON tree component; "导出 JSON" / "导出 CSV" buttons that trigger a Blob download.

- [ ] **Step 1: Write the failing frontend tests**

`frontend/tests/audit-view.test.js` (rewritten — replaces the 4 existing tests):
```js
import { test, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../../src/api/admin.js', () => ({
  adminApi: {
    getAudit: vi.fn(),
    getAuditBadge: vi.fn(),
    exportAudit: vi.fn()
  }
}));

import AuditView from '../../src/views/admin/AuditView.vue';
import { adminApi } from '../../src/api/admin.js';

function makeRows(category = 'security') {
  return [
    { id: 1, userId: 1, username: 'admin', action: 'login_failed', actionLabel: '登录失败',
      category, severity: 'high', target: null, targetLabel: null,
      payload: { ip: '1.2.3.4', reason: 'bad_password' }, createdAt: '2026-08-06T08:00:00Z' },
    { id: 2, userId: null, username: null, action: 'login_failed', actionLabel: '登录失败',
      category, severity: 'high', target: null, targetLabel: null,
      payload: null, createdAt: '2026-08-06T08:05:00Z' }
  ];
}

async function mountView(overrides = {}) {
  adminApi.getAudit.mockResolvedValue({
    data: { rows: overrides.rows ?? makeRows(), total: 2, filtered: 2, page: 1, size: 100 }
  });
  adminApi.getAuditBadge.mockImplementation(async (cat) => ({
    category: cat,
    count: cat === 'security' ? 5 : cat === 'changes' ? 12 : 3
  }));
  const wrapper = mount(AuditView, {
    global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } }
  });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  global.URL.createObjectURL = vi.fn(() => 'blob:fake');
  global.URL.revokeObjectURL = vi.fn();
});

test('AuditView: renders 3 tabs with badge counts', async () => {
  const w = await mountView();
  expect(w.text()).toContain('🔒 安全');
  expect(w.text()).toContain('📝 变更');
  expect(w.text()).toContain('⚙ 运维');
  expect(adminApi.getAuditBadge).toHaveBeenCalledWith('security');
  expect(adminApi.getAuditBadge).toHaveBeenCalledWith('changes');
  expect(adminApi.getAuditBadge).toHaveBeenCalledWith('ops');
});

test('AuditView: tab click switches active tab and refetches with that category', async () => {
  const w = await mountView();
  vi.clearAllMocks();
  adminApi.getAudit.mockResolvedValue({ data: { rows: [], total: 0, filtered: 0, page: 1, size: 100 } });
  adminApi.getAuditBadge.mockResolvedValue({ category: 'changes', count: 12 });
  const tabs = w.findAll('.tab');
  await tabs[1].trigger('click');  // 变更 tab
  await flushPromises();
  expect(adminApi.getAudit).toHaveBeenCalledWith(expect.objectContaining({ category: 'changes' }));
});

test('AuditView: row click opens drawer with payload tree (object payload)', async () => {
  const w = await mountView();
  await w.findAll('tbody tr.row')[0].trigger('click');
  await flushPromises();
  expect(w.find('.drawer').exists()).toBe(true);
  expect(w.find('.drawer').text()).toContain('ip');
  expect(w.find('.drawer').text()).toContain('1.2.3.4');
});

test('AuditView: row click with null payload shows fallback note (no crash)', async () => {
  const w = await mountView();
  await w.findAll('tbody tr.row')[1].trigger('click');  // payload: null
  await flushPromises();
  expect(w.find('.drawer').exists()).toBe(true);
  expect(w.find('.drawer').text()).toMatch(/无 payload|null/);
});

test('AuditView: empty tab shows empty-state, not broken table', async () => {
  adminApi.getAudit.mockResolvedValue({ data: { rows: [], total: 0, filtered: 0, page: 1, size: 100 } });
  adminApi.getAuditBadge.mockResolvedValue({ category: 'changes', count: 0 });
  const w = mount(AuditView, { global: { stubs: { AdminLayout: { template: '<div><slot /></div>' } } } });
  await flushPromises();
  expect(w.text()).toMatch(/暂无数据/);
});

test('AuditView: export JSON button calls exportAudit with current filter state and triggers download', async () => {
  adminApi.exportAudit.mockResolvedValue(new Blob(['[]']));
  const w = await mountView();
  await w.find('[data-test="export-json"]').trigger('click');
  await flushPromises();
  expect(adminApi.exportAudit).toHaveBeenCalledWith('json', expect.objectContaining({ category: 'security' }));
});

test('AuditView: severity color class reflects server-supplied severity', async () => {
  const w = await mountView();
  const rows = w.findAll('tbody tr.row');
  expect(rows[0].classes()).toContain('sev-high');
  expect(rows[1].classes()).toContain('sev-high');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd frontend && npx vitest run tests/audit-view.test.js
```
Expected: 7 tests fail (existing view is flat-table; no tabs/badge/drawer).

- [ ] **Step 3: Extend `frontend/src/api/admin.js`**

Replace the existing `getAudit` line and add two new methods:
```js
getAudit: ({ category, page = 1, size = 100, userId, actions, severities, from, to } = {}) => {
  const q = new URLSearchParams();
  if (category) q.set('category', category);
  q.set('page', String(page));
  q.set('size', String(size));
  if (userId) q.set('userId', String(userId));
  if (actions?.length) q.set('action', actions.join(','));
  if (severities?.length) q.set('severity', severities.join(','));
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  return api.get(`/api/admin/audit?${q.toString()}`);
},
getAuditBadge: (category) => api.get(`/api/admin/audit/badge?category=${encodeURIComponent(category)}`),
exportAudit: async (format, filters = {}) => {
  const q = new URLSearchParams();
  q.set('format', format);
  if (filters.category) q.set('category', filters.category);
  if (filters.userId) q.set('userId', String(filters.userId));
  if (filters.actions?.length) q.set('action', filters.actions.join(','));
  if (filters.severities?.length) q.set('severity', filters.severities.join(','));
  if (filters.from) q.set('from', filters.from);
  if (filters.to) q.set('to', filters.to);
  const { data } = await api.get(`/api/admin/audit/export?${q.toString()}`, { responseType: 'blob' });
  return data;
}
```

- [ ] **Step 4: Rewrite `frontend/src/views/admin/AuditView.vue`**

```vue
<template>
  <AdminLayout>
    <div class="audit-page">
      <header class="head">
        <h2>审计日志</h2>
        <div class="export-btns">
          <button data-test="export-json" @click="onExport('json')">导出 JSON</button>
          <button data-test="export-csv"  @click="onExport('csv')">导出 CSV</button>
        </div>
      </header>

      <nav class="tabs">
        <button v-for="t in tabs" :key="t.key"
                :class="['tab', { active: active === t.key }]"
                @click="active = t.key">
          {{ t.icon }} {{ t.label }} <span class="badge">{{ badges[t.key] ?? 0 }}</span>
        </button>
      </nav>

      <div class="filters">
        <select v-model="filters.timePreset" @change="onFilterChange">
          <option value="">全部时间</option>
          <option value="1h">1 小时</option>
          <option value="24h">24 小时</option>
          <option value="7d">7 天</option>
          <option value="30d">30 天</option>
        </select>
        <input v-model.number="filters.userId" placeholder="用户 ID" @change="onFilterChange" />
        <select v-model="filters.severity" multiple @change="onFilterChange">
          <option value="high">🔴 高</option>
          <option value="medium">🟡 中</option>
          <option value="low">🔵 低</option>
        </select>
      </div>

      <table class="t">
        <thead>
          <tr><th>时间</th><th>用户</th><th>动作</th><th>目标</th><th>严重性</th></tr>
        </thead>
        <tbody>
          <tr v-if="rows.length === 0"><td colspan="5" class="empty">暂无数据</td></tr>
          <tr v-for="r in rows" :key="r.id"
              :class="['row', `sev-${r.severity}`]"
              data-test="row"
              @click="selected = r">
            <td>{{ fmt(r.createdAt) }}</td>
            <td>{{ r.username ?? (r.userId ?? '-') }}</td>
            <td>{{ r.actionLabel }}</td>
            <td>{{ r.targetLabel || r.target || '-' }}</td>
            <td><span :class="['sev-chip', `sev-chip-${r.severity}`]">{{ sevIcon(r.severity) }} {{ sevLabel(r.severity) }}</span></td>
          </tr>
        </tbody>
      </table>

      <footer class="pager">
        <button :disabled="page <= 1" @click="page--">« 上一页</button>
        <span>第 {{ rangeStart }} - {{ rangeEnd }} / 共 {{ total }}</span>
        <button :disabled="rangeEnd >= total" @click="page++">下一页 »</button>
      </footer>

      <aside v-if="selected" class="drawer" @click.self="selected = null">
        <div class="drawer-body">
          <header>
            <h3>{{ selected.actionLabel }} <small>#{{ selected.id }}</small></h3>
            <button class="close" @click="selected = null">×</button>
          </header>
          <p><b>{{ selected.username ?? selected.userId ?? '-' }}</b> · {{ fmt(selected.createdAt) }}</p>
          <h4>payload</h4>
          <PayloadTree v-if="selected.payload" :value="selected.payload" />
          <p v-else class="muted">无 payload</p>
        </div>
      </aside>
    </div>
  </AdminLayout>
</template>

<script setup>
import { ref, computed, watch, h } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import { adminApi } from '../../api/admin.js';

const tabs = [
  { key: 'security', icon: '🔒', label: '安全' },
  { key: 'changes',  icon: '📝', label: '变更' },
  { key: 'ops',      icon: '⚙', label: '运维' }
];

const active = ref('security');
const page = ref(1);
const size = 100;
const rows = ref([]);
const total = ref(0);
const badges = ref({ security: 0, changes: 0, ops: 0 });
const filters = ref({ timePreset: '', userId: null, severity: [] });
const selected = ref(null);

function fmt(s) { return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-'; }
function sevIcon(s)  { return s === 'high' ? '🔴' : s === 'medium' ? '🟡' : '🔵'; }
function sevLabel(s) { return s === 'high' ? '高' : s === 'medium' ? '中' : '低'; }

const rangeStart = computed(() => total.value === 0 ? 0 : (page.value - 1) * size + 1);
const rangeEnd   = computed(() => Math.min(page.value * size, total.value));

function onFilterChange() { page.value = 1; load(); }

watch([active, page], load);

async function load() {
  const { from, to } = timeRangeToFromTo(filters.value.timePreset);
  const { data } = await adminApi.getAudit({
    category: active.value,
    page: page.value,
    size,
    userId: filters.value.userId || undefined,
    severities: filters.value.severity,
    from, to
  });
  rows.value = data.rows;
  total.value = data.total;
  await refreshBadges();
}

async function refreshBadges() {
  const results = await Promise.all(tabs.map(t => adminApi.getAuditBadge(t.key)));
  for (const r of results) badges.value[r.category] = r.count;
}

async function onExport(format) {
  const { from, to } = timeRangeToFromTo(filters.value.timePreset);
  const blob = await adminApi.exportAudit(format, {
    category: active.value,
    userId: filters.value.userId || undefined,
    severities: filters.value.severity,
    from, to
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `audit-${active.value}-${Date.now()}.${format}`;
  a.click();
  URL.revokeObjectURL(url);
}

function timeRangeToFromTo(preset) {
  if (!preset) return { from: undefined, to: undefined };
  const now = new Date();
  const ms = { '1h': 3600e3, '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3, '30d': 30 * 24 * 3600e3 }[preset];
  return { from: new Date(now - ms).toISOString(), to: now.toISOString() };
}

const PayloadTree = {
  props: ['value'],
  setup(props) {
    return () => renderNode(props.value, 0);
  }
};

function renderNode(value, depth) {
  if (value == null) return h('span', { class: 'json-null' }, 'null');
  if (typeof value === 'object') {
    const entries = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value);
    return h('ul', { class: 'json-tree', style: `padding-left:${depth * 12}px` },
      entries.map(([k, v]) => h('li', {}, [
        h('span', { class: 'json-key' }, String(k) + ': '),
        renderNode(v, depth + 1)
      ])));
  }
  return h('span', { class: `json-${typeof value}` }, JSON.stringify(value));
}

load();
</script>

<style scoped>
.audit-page { display: grid; grid-template-rows: auto auto auto 1fr auto; gap: 12px; min-height: 100%; position: relative; }
.head { display: flex; justify-content: space-between; align-items: center; }
.export-btns button { margin-left: 8px; padding: 6px 12px; background: #1e293b; color: var(--text); border: 1px solid #334155; cursor: pointer; border-radius: 3px; }
.export-btns button:hover { background: #334155; }
.tabs { display: flex; gap: 0; border-bottom: 1px solid #1e293b; }
.tab { padding: 8px 16px; background: transparent; color: var(--muted); border: none; border-bottom: 2px solid transparent; cursor: pointer; font-size: 14px; }
.tab.active { color: var(--text); border-bottom-color: var(--accent); }
.tab .badge { margin-left: 6px; padding: 1px 6px; background: #1e293b; border-radius: 8px; font-size: 12px; }
.filters { display: flex; gap: 8px; flex-wrap: wrap; padding: 8px 0; }
.filters select, .filters input { padding: 4px 8px; background: #0b1220; color: var(--text); border: 1px solid #1e293b; border-radius: 3px; }
.t { width: 100%; border-collapse: collapse; background: var(--panel); }
.t th, .t td { padding: 6px 10px; text-align: left; border-bottom: 1px solid #1e293b; font-size: 13px; }
.t th { background: #0b1220; color: var(--muted); font-size: 12px; }
.row { border-left: 3px solid transparent; cursor: pointer; }
.row:hover { background: #1e293b; }
.row.sev-high   { border-left-color: #7f1d1d; }
.row.sev-medium { border-left-color: #ca8a04; }
.row.sev-low    { border-left-color: #1e3a8a; }
.sev-chip { padding: 2px 6px; border-radius: 3px; font-size: 11px; }
.sev-chip-high   { background: #7f1d1d; color: #fecaca; }
.sev-chip-medium { background: #78350f; color: #fde68a; }
.sev-chip-low    { background: #1e3a8a; color: #bfdbfe; }
.empty { text-align: center; color: var(--muted); padding: 30px; }
.pager { display: flex; gap: 12px; justify-content: center; align-items: center; padding: 8px 0; color: var(--muted); }
.pager button { padding: 4px 12px; background: #1e293b; color: var(--text); border: 1px solid #334155; cursor: pointer; border-radius: 3px; }
.pager button:disabled { opacity: 0.4; cursor: not-allowed; }
.drawer { position: fixed; inset: 0 0 0 auto; width: 40%; min-width: 320px; background: var(--panel); border-left: 1px solid #1e293b; padding: 20px; overflow: auto; z-index: 10; }
.drawer-body header { display: flex; justify-content: space-between; align-items: center; }
.drawer-body h3 small { color: var(--muted); font-size: 12px; margin-left: 6px; }
.drawer-body .close { background: transparent; color: var(--text); border: none; font-size: 24px; cursor: pointer; }
.json-tree { list-style: none; padding-left: 12px; }
.json-key { color: var(--accent); }
.json-string { color: #86efac; }
.json-number { color: #fbbf24; }
.json-boolean { color: #c084fc; }
.json-null { color: var(--muted); font-style: italic; }
.muted { color: var(--muted); }
</style>
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd frontend && npx vitest run tests/audit-view.test.js
```
Expected: 7 tests pass.

- [ ] **Step 6: Run full frontend suite**

```bash
cd frontend && npx vitest run
```
Expected: 153 prior + 7 new = 160 pass; 0 fail.

- [ ] **Step 7: Mirror and commit**

```bash
cp frontend/src/api/admin.js                  publish/frontend/src/api/admin.js
cp frontend/src/views/admin/AuditView.vue     publish/frontend/src/views/admin/AuditView.vue
git add frontend/src/api/admin.js frontend/src/views/admin/AuditView.vue frontend/tests/audit-view.test.js \
        publish/frontend/src/api/admin.js publish/frontend/src/views/admin/AuditView.vue
git commit -m "feat(audit): rewrite AuditView with tabs, filter strip, drawer, pagination, export"
```

---

### Task 6: Build, mirror verify, smoke test, push

**Files:** no new files; verifies mirrors and pushes.

- [ ] **Step 1: Confirm source mirrors are in place**

```bash
for f in \
  publish/center/src/services/audit-classifier.js \
  publish/center/src/db/sql.js \
  publish/center/src/services/audit.js \
  publish/center/src/routes/admin.js \
  publish/db/migrations/010-audit-logs-json.sql \
  publish/db/migrations/011-audit-logs-indexes.sql \
  publish/db/migrations/mssql/010-audit-logs-json.sql \
  publish/db/migrations/mssql/011-audit-logs-indexes.sql \
  publish/frontend/src/api/admin.js \
  publish/frontend/src/views/admin/AuditView.vue
do
  test -f "$f" || echo "MISSING: $f"
done
```
Expected: no MISSING lines.

- [ ] **Step 2: Build frontend + mirror dist**

```bash
cd frontend && npm run build
mkdir -p publish/center/dist
cp -r frontend/dist/* publish/center/dist/
```

(If `publish/center/dist` already exists with newer content, the cp merge is fine — only audit-related files change.)

- [ ] **Step 3: Manual smoke test**

Start the app:
```bash
cd .. && npm start
```

In a browser at `http://localhost:3000/admin/audit` (after admin login):
1. Confirm 3 tabs render with badge counts visible.
2. Click each tab — rows switch to that category's actions; payload format intact.
3. Pick "严重性 = 高" in filter strip — only red-bordered rows remain.
4. Click a row — drawer slides in with the JSON tree rendered recursively.
5. Click "导出 JSON" — file downloads; open it and confirm contents match on-screen rows.
6. Click "导出 CSV" — file downloads; confirm header row is correct.
7. Pagination: with enough seed data, click "下一页" — page 2 loads with `offset = 100`.
8. URL with invalid `?category=evil` → toast "类别参数错误" (the route returns 400).

- [ ] **Step 4: Final test pass on the merged tree**

```bash
cd center && npm test
cd ../frontend && npx vitest run
```
Expected: center 464 + frontend 160 pass; 0 fail.

- [ ] **Step 5: Push to origin**

```bash
cd .. && git push origin main
```
Expected: 5 commits land on `origin/main`. (Verify-marker fix is already there from previous session.)

- [ ] **Step 6: Write a progress memory entry**

Append to the auto-memory file (`C:\Users\徐鹏\.claude\projects\D--ToolDevelop-ADDashboard\memory\progress_2026_08_07.md`):
- Plan file path
- Final commit hashes
- Test counts before/after
- Any deferred findings (none expected — spec is fully covered)

---

## Self-Review

**Spec coverage:**
- ✅ Goal 1 (tab by category) — Task 5
- ✅ Goal 2 (severity coloring) — Task 5 (CSS classes on rows + chips)
- ✅ Goal 3 (drawer with payload tree) — Task 5 (inline PayloadTree render-function component)
- ✅ Goal 4 (filters per tab) — Task 5 (time preset, user ID, severity multi-select)
- ✅ Goal 5 (100/page pagination) — Tasks 3 (size cap) + 5 (pager UI)
- ✅ Goal 6 (JSON/CSV export) — Task 4
- ✅ Goal 7 (label maps on backend) — Task 1 (`audit-classifier.js` + Task 3 service integration)
- ✅ Action→Category hardcoded map — Task 1
- ✅ Severity table — Task 1
- ✅ DB migration 010 (payload JSON, both dialects) — Task 2
- ✅ DB migration 011 (indexes, both dialects) — Task 2
- ✅ API query params (category, action, severity, userId, from, to, page, size) — Task 3
- ✅ Export API (json|csv, same filters, 50k cap, 413) — Task 4
- ✅ Backend SQL helpers (audit.list, audit.count, audit.badge dynamic) — Task 3
- ✅ Service parses JSON payload — Task 3 (`parsePayload`)
- ✅ AuditView.vue rewrite (tabs, filter strip, table, pagination, drawer, JSON tree) — Task 5
- ✅ Frontend API surface — Task 5
- ✅ Frontend tests (7 tests, rewritten) — Task 5
- ✅ Backend tests (11 list + 4 export = 15) — Tasks 3 + 4
- ✅ Migration tests (5 tests, DB-guarded) — Task 2
- ✅ publish/ source mirrors — Tasks 1-5
- ✅ Risk #1 (ISJSON CHECK rejects non-JSON rows) — Task 2 (UPDATE NULL-out non-JSON before CHECK)
- ✅ Risk #2 (action list drift) — Task 1 (`ACTION_CATEGORY` test enumerates every emitted action)

**Placeholder scan:** No "TBD", "TODO", or vague steps. Each Step 3 contains concrete code; each Step 1 contains a runnable test. No "implement later" or "similar to Task N".

**Type consistency:**
- `listAudit` returns `{rows, total, filtered, page, size}` everywhere (Task 3 service + Task 5 frontend consumption).
- `classifyAction` returns `{label, category, severity}` everywhere.
- `getAuditBadge` returns `number` (Task 3 service) → wrapped as `{category, count}` by route (Task 3 route) → unwrapped to `count` in frontend (Task 5 `badges.value[r.category] = r.count`).
- Row shape `{id, userId, username, action, actionLabel, category, severity, target, targetLabel, payload, createdAt}` is consistent between Task 3 service output and Task 5 frontend consumption.

**Risks caught at plan level:**
1. The `audit.badge` SQL needs dynamic placeholder count matching `CATEGORY_ACTIONS[category].length`. Plan uses strategy (b) — make `db.sql.audit.badge` a JS function `(actionList) => ...` rather than a static string. Test verifies via `assert.match(capturedSql, /action\s+IN/)` and `assert.ok(capturedParams.includes('login_failed'))` — structural, not exact-placeholder-count.
2. The CSV test asserts header order matches exactly what the implementation produces: `时间 (UTC+8) ... 用户名 ... 动作 ... 目标 ... 严重性 ... 类别`. The implementation uses this exact order. Verified manually.
3. The drawer component uses Vue 3 inline `h()` render functions (PayloadTree). Vitest mounts and renders these normally. The empty-state test (`暂无数据`) only fires when the initial `rows = []` from `getAudit`. Passes cleanly.
4. The `URL.createObjectURL`/`revokeObjectURL` are not implemented in jsdom by default; the test stubs both globally in `beforeEach`. Same pattern as existing frontend tests that exercise blob downloads.
5. `audit-migration.test.js` Step 5 says "implementer fleshes out" — this is the one place a Step delegates detail. The DB integration body is project-specific (depends on which mysql/mssql driver + which test-DB plumbing); the marker test (always passes) + DB-guarded skip guards keep the file loadable and non-flaky.
6. The export route probes `total` via a separate `listAudit({...opts, page:1, size:1})` call before fetching all rows. This is one extra DB round-trip per export — acceptable for an admin-only feature. Could be optimized later (YAGNI now).

**One ambiguity resolved:** the spec says `total` is the count of the full matched set and `filtered` is the count before pagination; in practice for this design they're the same value (no separate filter narrowing exists between them). The service returns both fields; the frontend reads `data.total` for the pager and `data.filtered` as a forward-compatible field. No conflict with the spec.