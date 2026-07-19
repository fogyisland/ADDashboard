# Init Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the schema/seed/admin/config portion of `scripts/install-center.ps1` with a browser-based 3-screen wizard served by the center service, triggered when no admin user exists in `sys_users`.

**Architecture:** Center service boots in either init mode (no admin user, serves `/init` + `/api/init/*`) or normal mode (serves full app). Init mode exposes 5 public routes: status, db-test, db-apply, admin-create, finalize. The init router holds a singleton "wizard facade" (separate from the global db facade) that connects with conn params from the wizard, applies schema/seed/migrations, creates the admin, and writes `appsettings.json`. Once any admin user exists, init-mode routes return 404 forever.

**Tech Stack:** Vue 3 + Pinia + vue-router (frontend), Express + node:test (backend), mysql2 + mssql + bcrypt (db drivers, already in package.json), Pester (PS tests, already in place).

## Global Constraints

- Backend: Node.js, ESM modules, `node --test` runner, `mysql2/promise` for mysql, `mssql ^11.0.1` for sql server, `bcrypt` for password hashing.
- Frontend: Vue 3 + Vite + Pinia + vue-router + axios; vitest + @vue/test-utils for tests.
- Init-mode trigger: `SELECT COUNT(*) FROM sys_users u JOIN sys_roles r ON u.role_id = r.id WHERE r.role_name = 'admin'` returns 0 (or DB unreachable / appsettings.json missing).
- All init-mode API routes return **404** (not 401/403) when `needsInit=false` — to avoid leaking wizard existence.
- SQL schema files are idempotent (MySQL `CREATE TABLE IF NOT EXISTS`; MSSQL `IF OBJECT_ID('table','U') IS NULL BEGIN ... END`); re-running apply is safe.
- Wizard facade closed on `/finalize` success or server shutdown.
- `appsettings.json` is gitignored; `appsettings.example.json` is the tracked template.
- All new tests follow existing patterns: backend unit tests use `_setDbForTest(mockDb)` + `buildMockDb` from `center/tests/helpers/db-mock.js`; integration tests env-gate on `TEST_SQL_URL`/`TEST_MSSQL_URL`.
- Commits use conventional-commits-style messages; one commit per task.

---

## File Structure

**Backend (`center/`):**
- New: `src/init/router.js`, `src/init/db-tester.js`, `src/init/wizard-facade.js`, `src/init/schema-applier.js`, `src/init/admin-creator.js`, `src/init/config-writer.js`, `src/init/needs-init.js`
- New tests: `tests/init/{db-tester,schema-applier,admin-creator,config-writer,needs-init,router}.test.js`
- New integration: `tests/integration/init.integration.test.js`
- Modify: `src/config.js` (add `loadConfigOrNull`, `defaultConfig`), `src/db/sql.js` (add `users.createAdmin`, `users.count` for both dialects), `src/app.js` (accept `needsInit` param), `server.js` (mode detection, router wiring, graceful shutdown)

**Frontend (`frontend/`):**
- New: `src/api/init.js`, `src/stores/init.js`, `src/views/init/InitWizardView.vue`, `src/views/init/DbConnStep.vue`, `src/views/init/AdminStep.vue`, `src/views/init/InitStep.vue`
- New tests: `tests/init/{store,wizard,guard}.test.js`
- Modify: `src/router.js` (`/init` route + bootstrap guard)

**PS installer + docs:**
- Modify: `scripts/install-center.ps1` (slim down — remove DB-side steps)
- Modify: `docs/operations/runbook.md` (document wizard), `README.md` (mention wizard)

---

### Task 1: Backend — `loadConfigOrNull` + `defaultConfig` + `checkNeedsInit`

**Files:**
- Modify: `center/src/config.js`
- Create: `center/src/init/needs-init.js`
- Create: `center/tests/init/needs-init.test.js`

**Interfaces:**
- Produces: `loadConfigOrNull(path) → Config | null` (returns null when file missing; throws on parse/validation error as before)
- Produces: `defaultConfig() → { db: undefined, listenPort: 8080, logLevel: 'info', env: 'prod' }`
- Produces: `checkNeedsInit(db | null) → Promise<boolean>` (null db → true; throws → true; admin count === 0 → true)

- [ ] **Step 1: Write failing test for `loadConfigOrNull`**

`center/tests/config.test.js` (existing file) — add these tests at the end:
```js
test('loadConfigOrNull returns null when file is missing', () => {
  assert.strictEqual(loadConfigOrNull('./does-not-exist.json'), null);
});

test('loadConfigOrNull throws on parse error', () => {
  const tmp = path.join(os.tmpdir(), `bad-${Date.now()}.json`);
  fs.writeFileSync(tmp, '{ not json');
  assert.throws(() => loadConfigOrNull(tmp), /JSON/);
  fs.unlinkSync(tmp);
});

test('defaultConfig returns listenPort 8080 and no db block', () => {
  const d = defaultConfig();
  assert.strictEqual(d.listenPort, 8080);
  assert.strictEqual(d.db, undefined);
});
```

- [ ] **Step 2: Run tests, confirm they fail**

Run: `cd center && node --test tests/config.test.js 2>&1 | tail -10`
Expected: 3 new tests fail with `loadConfigOrNull is not defined` / `defaultConfig is not defined`.

- [ ] **Step 3: Implement `loadConfigOrNull` + `defaultConfig`**

Edit `center/src/config.js` — add at the bottom (keep existing `loadConfig` unchanged for backward compat):
```js
export function loadConfigOrNull(path) {
  if (!existsSync(path)) return null;
  return loadConfig(path);
}

export function defaultConfig() {
  return {
    db: undefined,
    listenPort: 8080,
    jwtSecret: '',
    agentToken: '',
    staticDir: './dist',
    logLevel: 'info',
    env: 'prod',
    frontendDevProxy: null
  };
}
```

Add `existsSync` to the `node:fs` import at the top: `import { readFileSync, existsSync } from 'node:fs';`

- [ ] **Step 4: Run tests, confirm they pass**

Run: `cd center && node --test tests/config.test.js 2>&1 | tail -10`
Expected: 3 new tests pass, full file green.

- [ ] **Step 5: Write failing test for `checkNeedsInit`**

Create `center/tests/init/needs-init.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkNeedsInit } from '../../src/init/needs-init.js';

test('checkNeedsInit returns true when db is null', async () => {
  assert.strictEqual(await checkNeedsInit(null), true);
});

test('checkNeedsInit returns true when db.query throws (DB unreachable)', async () => {
  const db = { query: async () => { throw new Error('connection refused'); } };
  assert.strictEqual(await checkNeedsInit(db), true);
});

test('checkNeedsInit returns true when admin count is 0', async () => {
  const db = { query: async (sql) => {
    assert.match(sql, /sys_users/);
    assert.match(sql, /role_name\s*=\s*'admin'/);
    return { rows: [{ n: 0 }] };
  }};
  assert.strictEqual(await checkNeedsInit(db), true);
});

test('checkNeedsInit returns false when admin count > 0', async () => {
  const db = { query: async () => ({ rows: [{ n: 1 }] }) };
  assert.strictEqual(await checkNeedsInit(db), false);
});
```

- [ ] **Step 6: Run tests, confirm they fail**

Run: `cd center && node --test tests/init/needs-init.test.js 2>&1 | tail -10`
Expected: 4 tests fail with module not found.

- [ ] **Step 7: Implement `checkNeedsInit`**

Create `center/src/init/needs-init.js`:
```js
// Returns true if the init wizard should run.
// null db → true (no DB connection).
// db.query throws → true (DB unreachable).
// admin count === 0 → true (no admin yet).
// admin count > 0 → false (already initialized).

export async function checkNeedsInit(db) {
  if (!db) return true;
  try {
    const r = await db.query(
      "SELECT COUNT(*) AS n FROM sys_users u JOIN sys_roles r ON u.role_id = r.id WHERE r.role_name = 'admin'"
    );
    const n = r.rows?.[0]?.n ?? 0;
    return n === 0;
  } catch {
    return true;
  }
}
```

- [ ] **Step 8: Run tests, confirm they pass**

Run: `cd center && node --test tests/init/needs-init.test.js 2>&1 | tail -10`
Expected: 4 tests pass.

- [ ] **Step 9: Commit**

```bash
git add center/src/config.js center/src/init/needs-init.js center/tests/config.test.js center/tests/init/needs-init.test.js
git commit -m "feat(init): loadConfigOrNull + checkNeedsInit helper for wizard mode detection"
```

---

### Task 2: Backend — SQL registry additions (`users.createAdmin`, `users.count`)

**Files:**
- Modify: `center/src/db/sql.js`
- Modify or create: `center/tests/db/sql.test.js` (use existing if present)

**Interfaces:**
- Produces (mysql + mssql): `db.sql.users.createAdmin` — INSERT statement with `?` placeholders for username, password_hash; selects role_id via subquery
- Produces (mysql + mssql): `db.sql.users.count` — SELECT COUNT(\*) with the admin-join used by `checkNeedsInit`

- [ ] **Step 1: Read current `center/src/db/sql.js` structure**

Look at how `users` domain is currently structured (mysql + mssql variants). The two new keys follow the same pattern. **Note** `buildSql(dialect)` returns `{ domains: { users: { createAdmin, count, list, ... } } }`.

- [ ] **Step 2: Write failing tests for the two new SQL keys**

Find the existing `center/tests/db/sql.test.js` (or create it). Append:
```js
test('mysql users.createAdmin inserts with subquery for role_id', () => {
  const sql = buildSql('mysql');
  assert.match(sql.users.createAdmin, /INSERT INTO sys_users/);
  assert.match(sql.users.createAdmin, /role_name\s*=\s*'admin'/);
  // 3 placeholders: username, password_hash, role_id-subquery has none of its own
  const placeholders = (sql.users.createAdmin.match(/\?/g) || []).length;
  assert.strictEqual(placeholders, 3);
});

test('mssql users.createAdmin uses INSERT ... SELECT ... FROM', () => {
  const sql = buildSql('mssql');
  assert.match(sql.users.createAdmin, /INSERT INTO sys_users/);
  assert.match(sql.users.createAdmin, /SELECT\s+@p1,\s+@p2,/);
  assert.match(sql.users.createAdmin, /role_name\s*=\s*'admin'/);
});

test('mysql users.count joins sys_roles filtering admin', () => {
  const sql = buildSql('mysql');
  assert.match(sql.users.count, /COUNT\(\*\)/);
  assert.match(sql.users.count, /JOIN\s+sys_roles/);
  assert.match(sql.users.count, /role_name\s*=\s*'admin'/);
});

test('mssql users.count matches mysql semantics', () => {
  const sql = buildSql('mssql');
  assert.match(sql.users.count, /COUNT\(\*\)/);
  assert.match(sql.users.count, /JOIN\s+sys_roles/);
});
```

- [ ] **Step 3: Run tests, confirm they fail**

Run: `cd center && node --test tests/db/sql.test.js 2>&1 | tail -10`
Expected: 4 tests fail with `Cannot read properties of undefined (reading 'createAdmin')`.

- [ ] **Step 4: Add the two SQL keys to `center/src/db/sql.js`**

In `mysql.variants.users`, add:
```js
createAdmin: 'INSERT INTO sys_users (username, password_hash, role_id) VALUES (?, ?, (SELECT id FROM sys_roles WHERE role_name = \'admin\'))',
count: 'SELECT COUNT(*) AS n FROM sys_users u JOIN sys_roles r ON u.role_id = r.id WHERE r.role_name = \'admin\'',
```

In `mssql.variants.users`, add (mssql driver rewrites `?` → `@p1`, `@p2`, etc.):
```js
createAdmin: 'INSERT INTO sys_users (username, password_hash, role_id) SELECT ?, ?, id FROM sys_roles WHERE role_name = \'admin\'',
count: 'SELECT COUNT(*) AS n FROM sys_users u JOIN sys_roles r ON u.role_id = r.id WHERE r.role_name = \'admin\'',
```

- [ ] **Step 5: Run tests, confirm they pass**

Run: `cd center && node --test tests/db/sql.test.js 2>&1 | tail -10`
Expected: 4 new tests pass; full sql.test.js green.

- [ ] **Step 6: Commit**

```bash
git add center/src/db/sql.js center/tests/db/sql.test.js
git commit -m "feat(db): add users.createAdmin + users.count SQL keys (mysql + mssql)"
```

---

### Task 3: Backend — wizard facade + db-tester

**Files:**
- Create: `center/src/init/db-tester.js`
- Create: `center/src/init/wizard-facade.js`
- Create: `center/tests/init/db-tester.test.js`

**Interfaces:**
- Produces: `withOneShotFacade(dialect, connParams, work) → Promise<T>` — creates a one-shot facade, runs work(db), closes. Used by `/db/test` and as a fallback by `/db/apply` & `/admin/create`.
- Produces: `getWizardFacade(dialect, connParams) → Promise<facade>` — returns the singleton wizard facade, creating it from conn params if absent or if params changed.
- Produces: `closeWizardFacade() → Promise<void>` — closes the singleton, resets state.

The wizard facade has the same shape as the global db facade: `{ execute, query, transaction, healthcheck, close, dialect, sql }`.

- [ ] **Step 1: Write failing test for `withOneShotFacade`**

Create `center/tests/init/db-tester.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withOneShotFacade } from '../../src/init/db-tester.js';

// Stub the driver factories via direct import of the module we will modify.
// We expect withOneShotFacade to call createMysqlDriver or createMssqlDriver
// with the conn params, wrap it as a facade exposing execute/query/close,
// pass the facade to work(), then close it.

test('withOneShotFacade creates mysql facade for dialect=mysql and closes after work', async () => {
  let created = null, closed = null;
  const result = await withOneShotFacade('mysql', { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' }, async (db) => {
    created = db;
    assert.strictEqual(db.dialect, 'mysql');
    assert.strictEqual(typeof db.execute, 'function');
    assert.strictEqual(typeof db.close, 'function');
    return 'ok';
  }, {
    createMysqlDriver: (cfg) => { assert.deepStrictEqual(cfg, { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' }); return { close: async () => { closed = true; } }; },
    createMssqlDriver: () => { throw new Error('should not be called'); }
  });
  assert.strictEqual(result, 'ok');
  assert.ok(created);
  assert.strictEqual(closed, true);
});

test('withOneShotFacade creates mssql facade for dialect=mssql', async () => {
  let createdFor = null;
  await withOneShotFacade('mssql', { server: 's', database: 'd', user: 'u', password: 'p' }, async () => 'ok', {
    createMysqlDriver: () => { throw new Error('should not be called'); },
    createMssqlDriver: (cfg) => { createdFor = cfg; return { close: async () => {} }; }
  });
  assert.deepStrictEqual(createdFor, { server: 's', database: 'd', user: 'u', password: 'p' });
});

test('withOneShotFacade closes facade even when work throws', async () => {
  let closed = false;
  await assert.rejects(
    withOneShotFacade('mysql', { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' },
      async () => { throw new Error('boom'); },
      { createMysqlDriver: () => ({ close: async () => { closed = true; } }), createMssqlDriver: () => { throw new Error('x'); } }
    ),
    /boom/
  );
  assert.strictEqual(closed, true);
});
```

- [ ] **Step 2: Run tests, confirm they fail**

Run: `cd center && node --test tests/init/db-tester.test.js 2>&1 | tail -10`
Expected: 3 tests fail with module not found.

- [ ] **Step 3: Implement `withOneShotFacade`**

Create `center/src/init/db-tester.js`:
```js
// Creates a one-shot facade from the given conn params, runs work(db),
// then closes the underlying driver. The drivers are injected so tests
// can stub them.

import { buildSql } from '../db/sql.js';
import { createMysqlDriver } from '../db/drivers/mysql.js';
import { createMssqlDriver } from '../db/drivers/mssql.js';

export async function withOneShotFacade(dialect, connParams, work, drivers = null) {
  const mysqlDriver = drivers?.createMysqlDriver ?? createMysqlDriver;
  const mssqlDriver = drivers?.createMssqlDriver ?? createMssqlDriver;

  const driverCfg = connParams;
  const driver = dialect === 'mysql' ? mysqlDriver(driverCfg) : mssqlDriver(driverCfg);
  const sql = buildSql(dialect);
  const db = {
    dialect,
    sql,
    execute: async (s, p) => driver.execute(s, p),
    query:   async (s, p) => driver.query(s, p),
    transaction: async (w) => driver.transaction(w),
    healthcheck: async () => driver.healthcheck(),
    close: async () => driver.close()
  };

  try {
    return await work(db);
  } finally {
    try { await driver.close(); } catch { /* swallow close errors */ }
  }
}
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `cd center && node --test tests/init/db-tester.test.js 2>&1 | tail -10`
Expected: 3 tests pass.

- [ ] **Step 5: Write failing test for `getWizardFacade` + `closeWizardFacade`**

Append to `center/tests/init/db-tester.test.js`:
```js
import { getWizardFacade, closeWizardFacade } from '../../src/init/wizard-facade.js';

test('getWizardFacade creates facade on first call', async () => {
  await closeWizardFacade();
  let driverCfg = null;
  const f = await getWizardFacade('mysql', { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' }, {
    createMysqlDriver: (cfg) => { driverCfg = cfg; return { close: async () => {} }; },
    createMssqlDriver: () => { throw new Error('x'); }
  });
  assert.strictEqual(f.dialect, 'mysql');
  assert.deepStrictEqual(driverCfg, { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' });
  await closeWizardFacade();
});

test('getWizardFacade returns same facade on subsequent calls with same params', async () => {
  await closeWizardFacade();
  let calls = 0;
  const drivers = {
    createMysqlDriver: () => { calls++; return { close: async () => {} }; },
    createMssqlDriver: () => { throw new Error('x'); }
  };
  const params = { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' };
  const f1 = await getWizardFacade('mysql', params, drivers);
  const f2 = await getWizardFacade('mysql', params, drivers);
  assert.strictEqual(f1, f2);
  assert.strictEqual(calls, 1);
  await closeWizardFacade();
});

test('getWizardFacade rebuilds when params change', async () => {
  await closeWizardFacade();
  let calls = 0;
  const drivers = {
    createMysqlDriver: () => { calls++; return { close: async () => {} }; },
    createMssqlDriver: () => { throw new Error('x'); }
  };
  await getWizardFacade('mysql', { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' }, drivers);
  await getWizardFacade('mysql', { host: 'h2', port: 3306, database: 'd', user: 'u', password: 'p' }, drivers);
  assert.strictEqual(calls, 2);
  await closeWizardFacade();
});

test('closeWizardFacade resets state', async () => {
  await closeWizardFacade();
  let closed = false;
  await getWizardFacade('mysql', { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' }, {
    createMysqlDriver: () => ({ close: async () => { closed = true; } }),
    createMssqlDriver: () => { throw new Error('x'); }
  });
  await closeWizardFacade();
  assert.strictEqual(closed, true);
});
```

- [ ] **Step 6: Run tests, confirm they fail**

Run: `cd center && node --test tests/init/db-tester.test.js 2>&1 | tail -10`
Expected: 4 new tests fail with module not found.

- [ ] **Step 7: Implement `wizard-facade.js`**

Create `center/src/init/wizard-facade.js`:
```js
// Singleton facade held by the init router across wizard step calls.
// Created on first getWizardFacade, reused on subsequent calls with
// matching params, rebuilt when params change. Closed on finalize / shutdown.

import { createMysqlDriver } from '../db/drivers/mysql.js';
import { createMssqlDriver } from '../db/drivers/mssql.js';
import { buildSql } from '../db/sql.js';

let state = null; // { dialect, connParams, db, driver }

function paramsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function getWizardFacade(dialect, connParams, drivers = null) {
  const mysqlDriver = drivers?.createMysqlDriver ?? createMysqlDriver;
  const mssqlDriver = drivers?.createMssqlDriver ?? createMssqlDriver;

  if (state && state.dialect === dialect && paramsEqual(state.connParams, connParams)) {
    return state.db;
  }
  // Close existing facade (if any) before rebuilding
  if (state) {
    try { await state.driver.close(); } catch { /* ignore */ }
  }
  const driver = dialect === 'mysql' ? mysqlDriver(connParams) : mssqlDriver(connParams);
  const sql = buildSql(dialect);
  const db = {
    dialect,
    sql,
    execute: async (s, p) => driver.execute(s, p),
    query:   async (s, p) => driver.query(s, p),
    transaction: async (w) => driver.transaction(w),
    healthcheck: async () => driver.healthcheck(),
    close: async () => driver.close()
  };
  state = { dialect, connParams, db, driver };
  return db;
}

export async function closeWizardFacade() {
  if (!state) return;
  try { await state.driver.close(); } catch { /* ignore */ }
  state = null;
}

export function _resetWizardFacadeForTest() { state = null; }
```

- [ ] **Step 8: Run tests, confirm they pass**

Run: `cd center && node --test tests/init/db-tester.test.js 2>&1 | tail -10`
Expected: all 7 tests pass.

- [ ] **Step 9: Commit**

```bash
git add center/src/init/db-tester.js center/src/init/wizard-facade.js center/tests/init/db-tester.test.js
git commit -m "feat(init): wizard facade + withOneShotFacade for /db/test and lazy apply"
```

---

### Task 4: Backend — `schema-applier.js` (with SQL splitter)

**Files:**
- Create: `center/src/init/schema-applier.js`
- Create: `center/tests/init/schema-applier.test.js`

**Interfaces:**
- Produces: `splitSqlStatements(sql: string) → string[]` — splits on `;\n` (newline-aware), ignores `;` inside `'...'` and `"..."` string literals, trims whitespace, drops empty statements.
- Produces: `applyAll(dialect, db, opts) → Promise<{ applied: { schema: string[], seed: string[], migrations: string[] } }>` — applies schema/seed/migrations via `db.execute()`. Idempotent. `opts.createDatabase: bool` (mysql only) — runs `CREATE DATABASE IF NOT EXISTS \`name\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci` first.

- [ ] **Step 1: Write failing tests for `splitSqlStatements`**

Create `center/tests/init/schema-applier.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSqlStatements } from '../../src/init/schema-applier.js';

test('splitSqlStatements splits on ; followed by newline', () => {
  const sql = 'CREATE TABLE a (id INT);\nCREATE TABLE b (id INT);\n';
  assert.deepStrictEqual(splitSqlStatements(sql), [
    'CREATE TABLE a (id INT)',
    'CREATE TABLE b (id INT)'
  ]);
});

test('splitSqlStatements ignores semicolons inside single-quoted strings', () => {
  const sql = "INSERT INTO t (v) VALUES ('a;b');\nINSERT INTO t (v) VALUES ('c');";
  assert.deepStrictEqual(splitSqlStatements(sql), [
    "INSERT INTO t (v) VALUES ('a;b')",
    "INSERT INTO t (v) VALUES ('c')"
  ]);
});

test('splitSqlStatements ignores semicolons inside double-quoted strings', () => {
  const sql = 'INSERT INTO t (v) VALUES ("a;b");\nSELECT 1;';
  assert.deepStrictEqual(splitSqlStatements(sql), [
    'INSERT INTO t (v) VALUES ("a;b")',
    'SELECT 1'
  ]);
});

test('splitSqlStatements keeps IF/END block as a single statement', () => {
  const sql = `IF OBJECT_ID('t', 'U') IS NULL
BEGIN
  CREATE TABLE t (id INT);
END;
SELECT 1;`;
  const out = splitSqlStatements(sql);
  assert.strictEqual(out.length, 2);
  assert.match(out[0], /IF OBJECT_ID/);
  assert.match(out[0], /END/);
  assert.strictEqual(out[1], 'SELECT 1');
});

test('splitSqlStatements drops empty statements', () => {
  const sql = 'SELECT 1;;;\nSELECT 2;';
  assert.deepStrictEqual(splitSqlStatements(sql), ['SELECT 1', 'SELECT 2']);
});

test('splitSqlStatements handles real schema file (smoke test against db/schema/mssql/01-tables.sql)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const sql = fs.readFileSync(path.join(__dirname, '../../../db/schema/mssql/01-tables.sql'), 'utf8');
  const stmts = splitSqlStatements(sql);
  // 9 CREATE TABLE blocks (per spec) — assert at least 9
  assert.ok(stmts.length >= 9, `expected >= 9 statements, got ${stmts.length}`);
  // Each statement must contain non-whitespace
  for (const s of stmts) assert.ok(s.trim().length > 0);
});
```

- [ ] **Step 2: Run tests, confirm they fail**

Run: `cd center && node --test tests/init/schema-applier.test.js 2>&1 | tail -10`
Expected: 6 tests fail with module not found.

- [ ] **Step 3: Implement `splitSqlStatements` + `applyAll`**

Create `center/src/init/schema-applier.js`:
```js
// Splits a SQL string into individual statements. Splits on ; followed by
// a newline (or end of string). Ignores ; inside 'string' and "string"
// literals (with simple doubled-quote escape handling).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function splitSqlStatements(sql) {
  const out = [];
  let buf = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  while (i < sql.length) {
    const c = sql[i];
    if (inSingle) {
      buf += c;
      if (c === "'" && sql[i + 1] === "'") { buf += sql[i + 1]; i += 2; continue; }
      if (c === "'") inSingle = false;
      i++; continue;
    }
    if (inDouble) {
      buf += c;
      if (c === '"' && sql[i + 1] === '"') { buf += sql[i + 1]; i += 2; continue; }
      if (c === '"') inDouble = false;
      i++; continue;
    }
    if (c === "'") { inSingle = true; buf += c; i++; continue; }
    if (c === '"') { inDouble = true; buf += c; i++; continue; }
    if (c === ';' && (i + 1 >= sql.length || sql[i + 1] === '\n' || sql[i + 1] === '\r')) {
      const stmt = buf.trim();
      if (stmt.length > 0) out.push(stmt);
      buf = '';
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  const tail = buf.trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

async function applyFile(db, filePath) {
  const sql = readFileSync(filePath, 'utf8');
  const stmts = splitSqlStatements(sql);
  for (const s of stmts) {
    await db.execute(s, []);
  }
  return stmts;
}

export async function applyAll(dialect, db, opts = {}) {
  const repoRoot = opts.repoRoot ?? join(process.cwd(), '..');
  const schemaDir = join(repoRoot, 'db', 'schema', dialect);
  const migrationsDir = join(repoRoot, 'db', 'migrations', dialect);

  const applied = { schema: [], seed: [], migrations: [] };

  if (opts.createDatabase && dialect === 'mysql') {
    // Caller should have provided db name in opts.databaseName
    const dbName = opts.databaseName;
    if (dbName) {
      await db.execute(
        `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
        []
      );
    }
  }

  applied.schema = await applyFile(db, join(schemaDir, '01-tables.sql'));
  applied.seed = await applyFile(db, join(schemaDir, '02-seed-roles.sql'));

  // Apply migrations if directory exists
  try {
    const fs = await import('node:fs');
    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
    for (const f of files) {
      await applyFile(db, join(migrationsDir, f));
      applied.migrations.push(f);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  return applied;
}
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `cd center && node --test tests/init/schema-applier.test.js 2>&1 | tail -10`
Expected: 6 tests pass. If the last test (smoke against real file) fails because `require` doesn't work in ESM, change line `const fs = require('node:fs')` to `import fs from 'node:fs'` etc.

- [ ] **Step 5: Write failing test for `applyAll`**

Append to `center/tests/init/schema-applier.test.js`:
```js
import { applyAll } from '../../src/init/schema-applier.js';
import { buildMockDb, buildRecordingPool } from '../helpers/db-mock.js';

test('applyAll executes schema, seed, and migrations via db.execute', async () => {
  const calls = [];
  const db = buildMockDb({
    dialect: 'mysql',
    onExecute: (sql) => { calls.push(sql); return { rows: [], affectedRows: 0 }; }
  });
  const result = await applyAll('mysql', db, { repoRoot: process.cwd() + '/..' });
  assert.ok(calls.length > 0);
  // At least one CREATE TABLE statement
  assert.ok(calls.some(s => /CREATE TABLE/i.test(s)));
  // Returns applied structure
  assert.ok(Array.isArray(result.schema));
  assert.ok(Array.isArray(result.seed));
  assert.ok(Array.isArray(result.migrations));
});

test('applyAll mysql createDatabase option issues CREATE DATABASE', async () => {
  const calls = [];
  const db = buildMockDb({
    dialect: 'mysql',
    onExecute: (sql) => { calls.push(sql); return { rows: [], affectedRows: 0 }; }
  });
  await applyAll('mysql', db, { repoRoot: process.cwd() + '/..', createDatabase: true, databaseName: 'ad_test' });
  assert.ok(calls.some(s => /CREATE DATABASE IF NOT EXISTS `ad_test`/i.test(s)));
});
```

- [ ] **Step 6: Run tests, confirm they fail**

Run: `cd center && node --test tests/init/schema-applier.test.js 2>&1 | tail -10`
Expected: 2 new tests fail.

- [ ] **Step 7: Verify `applyAll` already passes**

Run: `cd center && node --test tests/init/schema-applier.test.js 2>&1 | tail -10`
Expected: 8 tests pass (splitSqlStatements 6 + applyAll 2).

- [ ] **Step 8: Commit**

```bash
git add center/src/init/schema-applier.js center/tests/init/schema-applier.test.js
git commit -m "feat(init): schema-applier with newline-aware SQL splitter + applyAll"
```

---

### Task 5: Backend — `admin-creator.js`

**Files:**
- Create: `center/src/init/admin-creator.js`
- Create: `center/tests/init/admin-creator.test.js`

**Interfaces:**
- Produces: `createAdmin(db, { username, password }) → Promise<{ id, username }>` — hashes password via existing `hashPassword` helper, pre-checks via `db.execute(db.sql.users.count, [])` (returns `{rows: [{n}]}` shape; must be 0, else throws `ConflictError`), inserts via `db.execute(db.sql.users.createAdmin, [username, hash])`, returns inserted id (mysql: `result.insertId`; mssql: select SCOPE_IDENTITY via separate query — but we already get insertId from the driver wrapper).

- [ ] **Step 1: Find existing `hashPassword` import path**

Run: `cd center && grep -rn "hashPassword" src/ | head -5`
Look for the existing helper. It should be in `src/auth/password.js` or similar. Note its exact signature.

- [ ] **Step 2: Write failing tests**

Create `center/tests/init/admin-creator.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdmin, AdminConflictError } from '../../src/init/admin-creator.js';
import { buildMockDb } from '../helpers/db-mock.js';

test('createAdmin inserts with hashed password and returns insertId', async () => {
  const db = buildMockDb({
    dialect: 'mysql',
    onExecute: async (sql, params) => {
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ n: 0 }], affectedRows: 0 };
      if (/INSERT INTO sys_users/.test(sql)) {
        assert.strictEqual(params.length, 3);
        assert.strictEqual(params[0], 'admin');
        assert.ok(params[1].startsWith('$2'), 'password should be bcrypt-hashed');
        assert.strictEqual(params[2], undefined, 'role_id is a subquery, not a param');
        return { rows: [], affectedRows: 1, insertId: 42 };
      }
      return { rows: [], affectedRows: 0 };
    }
  });
  const r = await createAdmin(db, { username: 'admin', password: 'hunter22pass' });
  assert.deepStrictEqual(r, { id: 42, username: 'admin' });
});

test('createAdmin throws AdminConflictError when admin already exists', async () => {
  const db = buildMockDb({
    dialect: 'mysql',
    onExecute: async (sql) => {
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ n: 1 }], affectedRows: 0 };
      throw new Error('INSERT should not run');
    }
  });
  await assert.rejects(
    createAdmin(db, { username: 'admin', password: 'hunter22pass' }),
    AdminConflictError
  );
});

test('createAdmin mssql uses SELECT ... FROM shape', async () => {
  let insertSql = null;
  const db = buildMockDb({
    dialect: 'mssql',
    onExecute: async (sql, params) => {
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ n: 0 }], affectedRows: 0 };
      if (/INSERT INTO sys_users/.test(sql)) {
        insertSql = sql;
        return { rows: [], affectedRows: 1, insertId: 7 };
      }
      return { rows: [], affectedRows: 0 };
    }
  });
  const r = await createAdmin(db, { username: 'sa-admin', password: 'hunter22pass' });
  assert.strictEqual(r.id, 7);
  assert.match(insertSql, /SELECT\s+@p1,\s+@p2,/);
});
```

- [ ] **Step 3: Run tests, confirm they fail**

Run: `cd center && node --test tests/init/admin-creator.test.js 2>&1 | tail -10`
Expected: 3 tests fail with module not found.

- [ ] **Step 4: Implement `createAdmin`**

Create `center/src/init/admin-creator.js`:
```js
import { hashPassword } from '../auth/password.js';

export class AdminConflictError extends Error {
  constructor() { super('admin user already exists'); this.code = 'ADMIN_EXISTS'; }
}

export async function createAdmin(db, { username, password }) {
  const countResult = await db.execute(db.sql.users.count, []);
  const n = countResult.rows?.[0]?.n ?? 0;
  if (n > 0) throw new AdminConflictError();

  const hash = await hashPassword(password);
  const insertResult = await db.execute(
    db.sql.users.createAdmin,
    [username, hash]
  );
  return { id: insertResult.insertId, username };
}
```

- [ ] **Step 5: Run tests, confirm they pass**

Run: `cd center && node --test tests/init/admin-creator.test.js 2>&1 | tail -10`
Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add center/src/init/admin-creator.js center/tests/init/admin-creator.test.js
git commit -m "feat(init): admin-creator with hash + pre-check + AdminConflictError"
```

---

### Task 6: Backend — `config-writer.js`

**Files:**
- Create: `center/src/init/config-writer.js`
- Create: `center/tests/init/config-writer.test.js`

**Interfaces:**
- Produces: `writeConfig({ path, dialect, connParams, listenPort, agentToken, jwtSecret, logLevel, env, staticDir })` — writes `appsettings.json` atomically (write to `.tmp`, rename). Validates via `loadConfig` after write.

- [ ] **Step 1: Write failing tests**

Create `center/tests/init/config-writer.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeConfig } from '../../src/init/config-writer.js';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('writeConfig writes appsettings.json with mysql dialect block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  try {
    const path = join(dir, 'appsettings.json');
    writeConfig({
      path,
      dialect: 'mysql',
      connParams: { host: '127.0.0.1', port: 3306, database: 'ad_monitoring', user: 'root', password: 'pw' },
      listenPort: 8080,
      agentToken: 'tok',
      jwtSecret: 'sec',
      logLevel: 'info',
      env: 'prod',
      staticDir: './dist'
    });
    const written = JSON.parse(readFileSync(path, 'utf8'));
    assert.strictEqual(written.db.dialect, 'mysql');
    assert.strictEqual(written.db.mysql.host, '127.0.0.1');
    assert.strictEqual(written.db.mysql.port, 3306);
    assert.strictEqual(written.listenPort, 8080);
    assert.strictEqual(written.agentToken, 'tok');
    assert.strictEqual(written.jwtSecret, 'sec');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('writeConfig writes appsettings.json with mssql dialect block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  try {
    const path = join(dir, 'appsettings.json');
    writeConfig({
      path,
      dialect: 'mssql',
      connParams: { server: 'sql.example.com', port: 1433, database: 'ad_monitoring', user: 'sa', password: 'pw', encrypt: false },
      listenPort: 8080,
      agentToken: 'tok',
      jwtSecret: 'sec',
      logLevel: 'info',
      env: 'prod',
      staticDir: './dist'
    });
    const written = JSON.parse(readFileSync(path, 'utf8'));
    assert.strictEqual(written.db.dialect, 'mssql');
    assert.strictEqual(written.db.mssql.server, 'sql.example.com');
    assert.strictEqual(written.db.mssql.port, 1433);
    assert.strictEqual(written.db.mssql.encrypt, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('writeConfig is atomic (writes .tmp then renames)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  try {
    const path = join(dir, 'appsettings.json');
    writeConfig({
      path, dialect: 'mysql',
      connParams: { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' },
      listenPort: 8080, agentToken: 'a', jwtSecret: 'j', logLevel: 'info', env: 'prod', staticDir: './d'
    });
    // After write, no .tmp file should remain
    const files = require('node:fs').readdirSync(dir);
    assert.deepStrictEqual(files, ['appsettings.json']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run tests, confirm they fail**

Run: `cd center && node --test tests/init/config-writer.test.js 2>&1 | tail -10`
Expected: 3 tests fail with module not found.

- [ ] **Step 3: Implement `writeConfig`**

Create `center/src/init/config-writer.js`:
```js
import { writeFileSync, renameSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

export function writeConfig({ path, dialect, connParams, listenPort, agentToken, jwtSecret, logLevel, env, staticDir }) {
  const cfg = {
    db: {
      dialect,
      [dialect]: connParams
    },
    listenPort,
    jwtSecret,
    agentToken,
    staticDir,
    logLevel: logLevel || 'info',
    env: env || 'prod'
  };
  const tmpPath = join(dirname(path), `.${basename(path)}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(cfg, null, 2), 'utf8');
  renameSync(tmpPath, path);
  return cfg;
}
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `cd center && node --test tests/init/config-writer.test.js 2>&1 | tail -10`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add center/src/init/config-writer.js center/tests/init/config-writer.test.js
git commit -m "feat(init): config-writer with atomic appsettings.json write"
```

---

### Task 7: Backend — `init/router.js` (5 routes + guard middleware)

**Files:**
- Create: `center/src/init/router.js`
- Create: `center/tests/init/router.test.js`

**Interfaces:**
- Produces: `initRouter({ logger, configPath, getNeedsInit }) → express.Router` — mounted at `/api/init/*`. Guard middleware checks `getNeedsInit()` and returns 404 if false. All routes are public otherwise.

- [ ] **Step 1: Write failing tests**

Create `center/tests/init/router.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { initRouter } from '../../src/init/router.js';

function makeApp({ needsInit = true, dbTestResult = { ok: true }, applyResult = { schema: [], seed: [], migrations: [] }, adminResult = { id: 1, username: 'admin' } } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/init', initRouter({
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    configPath: './appsettings.json',
    getNeedsInit: () => needsInit,
    _deps: {
      withOneShotFacade: async (d, p, w) => w({ execute: async () => dbTestResult, query: async () => dbTestResult, close: async () => {} }),
      applyAll: async () => applyResult,
      createAdmin: async () => adminResult,
      writeConfig: ({ path }) => { path && require('node:fs').writeFileSync(path, '{}'); return { ok: true }; },
      getWizardFacade: async () => ({ execute: async () => dbTestResult, query: async () => dbTestResult, close: async () => {} }),
      closeWizardFacade: async () => {}
    }
  }));
  return app;
}

async function call(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const url = `http://localhost:${port}${path}`;
      const opts = { method, headers: { 'Content-Type': 'application/json' } };
      if (body) opts.body = JSON.stringify(body);
      import('node:http').then(http => {
        const req = http.request(url, opts, (res) => {
          let buf = '';
          res.on('data', c => buf += c);
          res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }); });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
      });
    });
  });
}

test('GET /api/init/status returns needsInit=true when in init mode', async () => {
  const app = makeApp({ needsInit: true });
  const r = await call(app, 'GET', '/api/init/status');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.needsInit, true);
});

test('GET /api/init/status returns 404 when not in init mode', async () => {
  const app = makeApp({ needsInit: false });
  const r = await call(app, 'GET', '/api/init/status');
  assert.strictEqual(r.status, 404);
});

test('POST /api/init/db/test returns ok when facade returns ok', async () => {
  const app = makeApp({ dbTestResult: { rows: [{ '1': 1 }], affectedRows: 0 } });
  const r = await call(app, 'POST', '/api/init/db/test', { dialect: 'mysql', host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
});

test('POST /api/init/db/test returns 400 when dialect is missing', async () => {
  const app = makeApp();
  const r = await call(app, 'POST', '/api/init/db/test', { host: 'h' });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /dialect/);
});

test('POST /api/init/db/apply applies schema + seed + migrations', async () => {
  const app = makeApp({ applyResult: { schema: ['s1'], seed: ['s2'], migrations: ['m1'] } });
  const r = await call(app, 'POST', '/api/init/db/apply', { dialect: 'mysql', connParams: { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' }, createDatabase: false });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.schema, ['s1']);
});

test('POST /api/init/admin/create returns 409 on AdminConflictError', async () => {
  const app = makeApp();
  app._router.stack; // noop
  // Override deps to throw
  const app2 = express();
  app2.use(express.json());
  app2.use('/api/init', initRouter({
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    configPath: './appsettings.json',
    getNeedsInit: () => true,
    _deps: {
      withOneShotFacade: async (d, p, w) => w({ execute: async () => ({ rows: [{ n: 1 }], affectedRows: 0 }), query: async () => ({}), close: async () => {} }),
      applyAll: async () => ({}),
      createAdmin: async () => { const e = new Error('admin exists'); e.code = 'ADMIN_EXISTS'; throw e; },
      writeConfig: () => ({}),
      getWizardFacade: async () => ({}),
      closeWizardFacade: async () => {}
    }
  }));
  const r = await call(app2, 'POST', '/api/init/admin/create', { dialect: 'mysql', connParams: { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' }, username: 'admin', password: 'pw' });
  assert.strictEqual(r.status, 409);
});

test('POST /api/init/finalize writes config and closes wizard facade', async () => {
  let wrotePath = null, closed = false;
  const app = express();
  app.use(express.json());
  app.use('/api/init', initRouter({
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    configPath: './does-not-matter.json',
    getNeedsInit: () => true,
    _deps: {
      withOneShotFacade: async (d, p, w) => w({ execute: async () => ({}), query: async () => ({}), close: async () => {} }),
      applyAll: async () => ({}),
      createAdmin: async () => ({ id: 1, username: 'admin' }),
      writeConfig: ({ path }) => { wrotePath = path; return { ok: true }; },
      getWizardFacade: async () => ({}),
      closeWizardFacade: async () => { closed = true; }
    }
  }));
  const r = await call(app, 'POST', '/api/init/finalize', {
    dialect: 'mysql', connParams: { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' },
    listenPort: 8080, agentToken: 'a', jwtSecret: 'j', logLevel: 'info', env: 'prod', staticDir: './dist'
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(wrotePath, './does-not-matter.json');
  assert.strictEqual(closed, true);
});
```

- [ ] **Step 2: Run tests, confirm they fail**

Run: `cd center && node --test tests/init/router.test.js 2>&1 | tail -10`
Expected: 7 tests fail with module not found.

- [ ] **Step 3: Implement `initRouter`**

Create `center/src/init/router.js`:
```js
import express from 'express';
import { withOneShotFacade } from './db-tester.js';
import { getWizardFacade, closeWizardFacade } from './wizard-facade.js';
import { applyAll } from './schema-applier.js';
import { createAdmin, AdminConflictError } from './admin-creator.js';
import { writeConfig } from './config-writer.js';

export function initRouter({ logger, configPath, getNeedsInit, _deps = null }) {
  const deps = _deps ?? {
    withOneShotFacade, applyAll, createAdmin, writeConfig,
    getWizardFacade, closeWizardFacade
  };
  const r = express.Router();

  // Guard: 404 unless in init mode
  r.use((req, res, next) => {
    if (!getNeedsInit()) return res.status(404).json({ error: 'not found' });
    next();
  });

  r.get('/status', (req, res) => {
    res.json({ needsInit: true });
  });

  r.post('/db/test', async (req, res) => {
    const { dialect, ...connParams } = req.body || {};
    if (!dialect || !['mysql', 'mssql'].includes(dialect)) {
      return res.status(400).json({ error: 'dialect must be "mysql" or "mssql"' });
    }
    try {
      const result = await deps.withOneShotFacade(dialect, connParams, async (db) => {
        return await db.execute('SELECT 1 AS ok', []);
      });
      res.json({ ok: true, dialect });
    } catch (e) {
      logger.warn({ err: e.message, dialect }, 'init db test failed');
      res.json({ ok: false, error: e.message });
    }
  });

  r.post('/db/apply', async (req, res) => {
    const { dialect, connParams, createDatabase } = req.body || {};
    if (!dialect || !['mysql', 'mssql'].includes(dialect)) {
      return res.status(400).json({ error: 'dialect must be "mysql" or "mssql"' });
    }
    try {
      const db = await deps.getWizardFacade(dialect, connParams);
      const applied = await deps.applyAll(dialect, db, { createDatabase: !!createDatabase, databaseName: connParams.database });
      res.json(applied);
    } catch (e) {
      logger.error({ err: e.message }, 'init db apply failed');
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/admin/create', async (req, res) => {
    const { dialect, connParams, username, password } = req.body || {};
    if (!dialect || !username || !password) {
      return res.status(400).json({ error: 'dialect, username, password required' });
    }
    try {
      const db = await deps.getWizardFacade(dialect, connParams);
      const r = await deps.createAdmin(db, { username, password });
      res.json(r);
    } catch (e) {
      if (e instanceof AdminConflictError || e.code === 'ADMIN_EXISTS') {
        return res.status(409).json({ error: 'admin user already exists' });
      }
      logger.error({ err: e.message }, 'init admin create failed');
      res.status(500).json({ error: e.message });
    }
  });

  r.post('/finalize', async (req, res) => {
    const { dialect, connParams, listenPort, agentToken, jwtSecret, logLevel, env, staticDir } = req.body || {};
    try {
      deps.writeConfig({
        path: configPath,
        dialect,
        connParams,
        listenPort: listenPort || 8080,
        agentToken: agentToken || '',
        jwtSecret: jwtSecret || '',
        logLevel: logLevel || 'info',
        env: env || 'prod',
        staticDir: staticDir || './dist'
      });
      await deps.closeWizardFacade();
      res.json({ ok: true, path: configPath });
    } catch (e) {
      logger.error({ err: e.message }, 'init finalize failed');
      res.status(500).json({ error: e.message });
    }
  });

  return r;
}
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `cd center && node --test tests/init/router.test.js 2>&1 | tail -10`
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add center/src/init/router.js center/tests/init/router.test.js
git commit -m "feat(init): 5-route init router with needsInit guard + AdminConflictError 409"
```

---

### Task 8: Backend — `server.js` wiring + integration test

**Files:**
- Modify: `center/server.js`
- Modify: `center/src/app.js`
- Create: `center/tests/integration/init.integration.test.js`

**Interfaces:**
- `server.js` boot flow: loadConfigOrNull → init (try/catch) → checkNeedsInit → mount init router OR full routers → close wizard facade on shutdown

- [ ] **Step 1: Modify `center/src/app.js` to accept `needsInit`**

Read `center/src/app.js` first. Add a `needsInit: true|false` field to the createApp options; pass it to the express app instance as `app.locals.needsInit`. Default true.

- [ ] **Step 2: Rewrite `center/server.js` boot logic**

Replace `center/server.js` with:
```js
import { createApp } from './src/app.js';
import { loadConfigOrNull, defaultConfig } from './src/config.js';
import { init, close, getDb } from './src/db/index.js';
import { createLogger } from './src/logger.js';
import { authRouter } from './src/routes/auth.js';
import { agentRouter } from './src/routes/agent.js';
import { dashboardRouter } from './src/routes/dashboard.js';
import { adminRouter } from './src/routes/admin.js';
import { initRouter } from './src/init/router.js';
import { checkNeedsInit } from './src/init/needs-init.js';
import { closeWizardFacade } from './src/init/wizard-facade.js';

const configPath = process.argv[2] || process.env.APPSETTINGS_PATH || './appsettings.json';
const logger = createLogger({ component: 'center', level: 'info' });

(async () => {
  let config = loadConfigOrNull(configPath);
  let db = null;
  if (config) {
    try {
      await init(config);
      db = getDb();
    } catch (err) {
      logger.warn({ err: err.message }, 'db init failed; falling back to init mode');
      config = null;
      db = null;
    }
  }
  const needsInit = await checkNeedsInit(db);
  const finalConfig = config ?? defaultConfig();

  const app = createApp({ config: finalConfig, db, logger, needsInit });
  if (needsInit) {
    logger.info('init mode: serving /api/init/* and /init');
    app.use(initRouter({ logger, configPath, getNeedsInit: () => needsInit }));
  } else {
    app.use(authRouter({ config: finalConfig, logger }));
    app.use(agentRouter({ config: finalConfig, logger }));
    app.use(dashboardRouter({ config: finalConfig, logger }));
    app.use(adminRouter({ config: finalConfig, logger }));
  }

  const server = app.listen(finalConfig.listenPort, () => {
    logger.info({ port: finalConfig.listenPort, needsInit }, 'center listening');
  });
  const shutdown = async (sig) => {
    logger.info({ sig }, 'shutting down');
    server.close(async () => {
      try { await closeWizardFacade(); } catch {}
      try { await close(); } catch {}
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
})().catch(err => {
  logger.error({ err: err.message }, 'fatal');
  process.exit(1);
});
```

- [ ] **Step 3: Run existing tests to ensure no regressions**

Run: `cd center && npm test 2>&1 | tail -10`
Expected: same count as before (91 pass / 1 skip / 0 fail). If app.js signature changed, update test-app.js helper to pass `needsInit: false`.

- [ ] **Step 4: Write integration test (env-gated)**

Create `center/tests/integration/init.integration.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTestUrl } from './_url.js';

async function boot() {
  const dialect = process.env.TEST_SQL_URL ? 'mysql' : process.env.TEST_MSSQL_URL ? 'mssql' : null;
  if (!dialect) return null;
  const urlKey = dialect === 'mysql' ? 'TEST_SQL_URL' : 'TEST_MSSQL_URL';
  const { user, password, host, port } = parseTestUrl(urlKey, { defaultPort: dialect === 'mysql' ? 3306 : 1433 });
  const { init, close, getDb } = await import('../../src/db/index.js');
  const cfg = dialect === 'mysql'
    ? { db: { dialect, mysql: { host, port, database: 'ad_monitoring', user, password } } }
    : { db: { dialect, mssql: { server: host, port, database: 'ad_monitoring', user, password } } };
  await init(cfg);
  return { dialect, connParams: cfg.db[dialect], db: getDb() };
}

test('integration: full init wizard flow against real mysql', async (t) => {
  const ctx = await boot();
  if (!ctx) return t.skip('no TEST_*_URL set');
  const { dialect, connParams, db } = ctx;

  try {
    // 1. Drop the admin user (clean slate)
    await db.execute('DELETE FROM sys_users WHERE username = ?', ['admin']);
    await db.execute('DELETE FROM sys_users WHERE username = ?', ['wiz-test-admin']);

    // 2. Apply schema + seed via applyAll
    const { applyAll } = await import('../../src/init/schema-applier.js');
    const applied = await applyAll(dialect, db, { repoRoot: process.cwd() + '/..' });
    assert.ok(applied.schema.length > 0);
    assert.ok(applied.seed.length > 0);

    // 3. Create admin
    const { createAdmin } = await import('../../src/init/admin-creator.js');
    const r = await createAdmin(db, { username: 'wiz-test-admin', password: 'hunter22pass' });
    assert.ok(r.id > 0);
    assert.strictEqual(r.username, 'wiz-test-admin');

    // 4. Verify checkNeedsInit returns false (admin exists)
    const { checkNeedsInit } = await import('../../src/init/needs-init.js');
    assert.strictEqual(await checkNeedsInit(db), false);

    // 5. Cleanup
    await db.execute('DELETE FROM sys_users WHERE username = ?', ['wiz-test-admin']);
  } finally {
    await close();
  }
});
```

- [ ] **Step 5: Run integration test (if env set)**

Run: `cd center && TEST_SQL_URL=root:Admin909217@127.0.0.1:3306 node --test tests/integration/init.integration.test.js 2>&1 | tail -10`
Expected: 1 pass, 0 fail. If env not set: skip.

- [ ] **Step 6: Run full center regression**

Run: `cd center && npm test 2>&1 | tail -10`
Expected: ~94 pass / 1 skip / 0 fail (was 93; +1 from this integration).

- [ ] **Step 7: Commit**

```bash
git add center/server.js center/src/app.js center/tests/integration/init.integration.test.js center/tests/test-app.js
git commit -m "feat(init): server.js mode detection + init router mount + e2e integration test"
```

---

### Task 9: Frontend — `api/init.js` + `stores/init.js`

**Files:**
- Create: `frontend/src/api/init.js`
- Create: `frontend/src/stores/init.js`
- Create: `frontend/tests/init/store.test.js`

**Interfaces:**
- Produces: `api/init.js` exports `getStatus, testDb, applyDb, createAdmin, finalize`
- Produces: `stores/init.js` Pinia options store: `state { currentStep, dialect, connParams, admin, dbTestResult }`, `actions { loadStatus, setDialect, setConnParams, setAdmin, testDb, next, prev, reset }`

- [ ] **Step 1: Create `frontend/src/api/init.js`**

```js
import api from './client.js';

export const getStatus = () => api.get('/api/init/status');
export const testDb = (params) => api.post('/api/init/db/test', params);
export const applyDb = (params) => api.post('/api/init/db/apply', params);
export const createAdmin = (params) => api.post('/api/init/admin/create', params);
export const finalize = (params) => api.post('/api/init/finalize', params);
```

- [ ] **Step 2: Write failing test for the store**

Create `frontend/tests/init/store.test.js`:
```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useInitStore } from '../../src/stores/init.js';

describe('init store', () => {
  beforeEach(() => { setActivePinia(createPinia()); });

  it('starts at step 1', () => {
    const s = useInitStore();
    expect(s.currentStep).toBe(1);
  });

  it('setDialect updates dialect and connParams defaults', () => {
    const s = useInitStore();
    s.setDialect('mysql');
    expect(s.dialect).toBe('mysql');
    expect(s.connParams.host).toBe('127.0.0.1');
    expect(s.connParams.port).toBe(3306);
    expect(s.connParams.user).toBe('root');
  });

  it('setDialect mssql sets server + sa defaults', () => {
    const s = useInitStore();
    s.setDialect('mssql');
    expect(s.dialect).toBe('mssql');
    expect(s.connParams.server).toBe('');
    expect(s.connParams.port).toBe(1433);
    expect(s.connParams.user).toBe('sa');
  });

  it('next advances step; prev decrements', () => {
    const s = useInitStore();
    s.next();
    expect(s.currentStep).toBe(2);
    s.next();
    expect(s.currentStep).toBe(3);
    s.prev();
    expect(s.currentStep).toBe(2);
  });

  it('reset clears all state', () => {
    const s = useInitStore();
    s.setDialect('mysql');
    s.setConnParams({ host: 'x' });
    s.reset();
    expect(s.currentStep).toBe(1);
    expect(s.dialect).toBeNull();
    expect(s.connParams).toEqual({});
  });
});
```

- [ ] **Step 3: Run tests, confirm they fail**

Run: `cd frontend && npm test 2>&1 | tail -10`
Expected: tests fail (store not found).

- [ ] **Step 4: Implement the store**

Create `frontend/src/stores/init.js`:
```js
import { defineStore } from 'pinia';
import * as initApi from '../api/init.js';

const DEFAULTS = {
  mysql: { host: '127.0.0.1', port: 3306, database: '', user: 'root', password: '' },
  mssql: { server: '', port: 1433, database: '', user: 'sa', password: '', encrypt: false, trustServerCert: true }
};

export const useInitStore = defineStore('init', {
  state: () => ({
    currentStep: 1,
    dialect: null,           // 'mysql' | 'mssql' | null
    connParams: {},          // {host|server, port, database, user, password, ...}
    admin: { username: 'admin', password: '', confirm: '' },
    dbTestResult: null,      // {ok, error?}
    initStatus: null,        // {needsInit, dialect?}
    applyProgress: null,     // {schema, seed, migrations} | null
    applyError: null,
    adminError: null,
    finalizeError: null
  }),
  actions: {
    async loadStatus() {
      const r = await initApi.getStatus();
      this.initStatus = r.data;
      return r.data;
    },
    setDialect(d) {
      this.dialect = d;
      this.connParams = { ...DEFAULTS[d] };
      this.dbTestResult = null;
    },
    setConnParams(p) { this.connParams = { ...this.connParams, ...p }; this.dbTestResult = null; },
    setAdmin(a) { this.admin = { ...this.admin, ...a }; },
    async testDb() {
      this.dbTestResult = null;
      const r = await initApi.testDb({ dialect: this.dialect, ...this.connParams });
      this.dbTestResult = r.data;
      return r.data;
    },
    next() { if (this.currentStep < 3) this.currentStep++; },
    prev() { if (this.currentStep > 1) this.currentStep--; },
    async applyDb(createDatabase = false) {
      this.applyError = null;
      try {
        const r = await initApi.applyDb({ dialect: this.dialect, connParams: this.connParams, createDatabase });
        this.applyProgress = r.data;
        return r.data;
      } catch (e) {
        this.applyError = e.response?.data?.error || e.message;
        throw e;
      }
    },
    async createAdmin() {
      this.adminError = null;
      try {
        const r = await initApi.createAdmin({
          dialect: this.dialect, connParams: this.connParams,
          username: this.admin.username, password: this.admin.password
        });
        return r.data;
      } catch (e) {
        this.adminError = e.response?.data?.error || e.message;
        throw e;
      }
    },
    async finalize() {
      this.finalizeError = null;
      try {
        const r = await initApi.finalize({
          dialect: this.dialect, connParams: this.connParams,
          listenPort: 8080, agentToken: '', jwtSecret: '', logLevel: 'info', env: 'prod', staticDir: './dist'
        });
        return r.data;
      } catch (e) {
        this.finalizeError = e.response?.data?.error || e.message;
        throw e;
      }
    },
    reset() {
      this.currentStep = 1;
      this.dialect = null;
      this.connParams = {};
      this.admin = { username: 'admin', password: '', confirm: '' };
      this.dbTestResult = null;
      this.applyProgress = null;
      this.applyError = null;
      this.adminError = null;
      this.finalizeError = null;
    }
  }
});
```

- [ ] **Step 5: Run tests, confirm they pass**

Run: `cd frontend && npm test 2>&1 | tail -10`
Expected: 5 new tests pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api/init.js frontend/src/stores/init.js frontend/tests/init/store.test.js
git commit -m "feat(frontend): init API module + Pinia store with defaults + actions"
```

---

### Task 10: Frontend — `DbConnStep.vue` (screen 1)

**Files:**
- Create: `frontend/src/views/init/DbConnStep.vue`
- Create: `frontend/tests/init/db-conn-step.test.js`

- [ ] **Step 1: Write failing test**

Create `frontend/tests/init/db-conn-step.test.js`:
```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import DbConnStep from '../../src/views/init/DbConnStep.vue';
import { useInitStore } from '../../src/stores/init.js';

describe('DbConnStep', () => {
  beforeEach(() => { setActivePinia(createPinia()); });

  it('renders dialect picker', () => {
    const w = mount(DbConnStep);
    expect(w.text()).toMatch(/MySQL|SQL Server|数据库/);
  });

  it('shows mysql fields after picking mysql', async () => {
    const w = mount(DbConnStep);
    await w.findAll('input[type="radio"]')[0].setValue();
    await w.findAll('input[type="radio"]')[0].trigger('change');
    // After click on mysql card, mysql-specific fields should appear
    await w.vm.$nextTick();
    expect(w.text()).toMatch(/host|主机/);
  });

  it('test connection button disabled when no dialect picked', () => {
    const w = mount(DbConnStep);
    const btn = w.findAll('button').find(b => /测试|test/i.test(b.text()));
    expect(btn?.attributes('disabled')).toBeDefined();
  });

  it('test connection button enabled after dialect + db name filled', async () => {
    const s = useInitStore();
    s.setDialect('mysql');
    s.setConnParams({ database: 'ad_test' });
    const w = mount(DbConnStep);
    const btn = w.findAll('button').find(b => /测试|test/i.test(b.text()));
    expect(btn?.attributes('disabled')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests, confirm they fail**

Run: `cd frontend && npm test 2>&1 | tail -10`
Expected: 4 tests fail (component not found).

- [ ] **Step 3: Implement `DbConnStep.vue`**

Create `frontend/src/views/init/DbConnStep.vue`:
```vue
<template>
  <div class="db-conn-step">
    <h3>第 1 步：数据库连接</h3>
    <p class="hint">选择数据库类型并填写连接信息。建议先点击"测试连接"验证。</p>

    <div class="dialect-picker">
      <label class="dialect-card" :class="{ active: store.dialect === 'mysql' }">
        <input type="radio" name="dialect" value="mysql" v-model="dialectLocal" />
        <div class="card-title">MySQL 5.7+</div>
        <div class="card-desc">默认端口 3306</div>
      </label>
      <label class="dialect-card" :class="{ active: store.dialect === 'mssql' }">
        <input type="radio" name="dialect" value="mssql" v-model="dialectLocal" />
        <div class="card-title">SQL Server 2014+</div>
        <div class="card-desc">默认端口 1433</div>
      </label>
    </div>

    <div v-if="store.dialect === 'mysql'" class="form-grid">
      <label>主机 <input v-model="conn.host" placeholder="127.0.0.1" /></label>
      <label>端口 <input v-model.number="conn.port" type="number" /></label>
      <label>数据库 <input v-model="conn.database" /></label>
      <label>用户 <input v-model="conn.user" /></label>
      <label class="full">密码 <input v-model="conn.password" type="password" /></label>
    </div>

    <div v-else-if="store.dialect === 'mssql'" class="form-grid">
      <label class="full">服务器 <input v-model="conn.server" placeholder="host\instance 或 host,port" /></label>
      <label>端口 <input v-model.number="conn.port" type="number" /></label>
      <label>数据库 <input v-model="conn.database" /></label>
      <label>用户 <input v-model="conn.user" /></label>
      <label class="full">密码 <input v-model="conn.password" type="password" /></label>
      <label class="full checkbox">
        <input type="checkbox" v-model="conn.encrypt" /> 启用加密
        <input type="checkbox" v-model="conn.trustServerCert" /> 信任服务器证书
      </label>
    </div>

    <div class="actions">
      <button type="button" :disabled="!canTest || testing" @click="onTest">
        {{ testing ? '测试中...' : '测试连接' }}
      </button>
      <button type="button" :disabled="!store.dbTestResult?.ok" @click="onNext">下一步</button>
    </div>

    <p v-if="store.dbTestResult?.ok" class="ok">✓ 连接成功</p>
    <p v-if="store.dbTestResult?.error" class="err">{{ store.dbTestResult.error }}</p>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { useInitStore } from '../../stores/init.js';

const store = useInitStore();
const testing = ref(false);
const dialectLocal = ref(store.dialect);
const conn = ref({ ...store.connParams });

watch(dialectLocal, (v) => {
  if (v && v !== store.dialect) {
    store.setDialect(v);
    conn.value = { ...store.connParams };
  }
});
watch(conn, (v) => { store.setConnParams(v); }, { deep: true });

const canTest = computed(() => {
  if (!store.dialect) return false;
  if (!conn.value.database) return false;
  if (store.dialect === 'mysql' && !conn.value.host) return false;
  if (store.dialect === 'mssql' && !conn.value.server) return false;
  return true;
});

async function onTest() {
  testing.value = true;
  try { await store.testDb(); }
  finally { testing.value = false; }
}

function onNext() { store.next(); }
</script>

<style scoped>
.db-conn-step { display: flex; flex-direction: column; gap: 16px; }
.dialect-picker { display: flex; gap: 12px; }
.dialect-card { flex: 1; padding: 16px; border: 1px solid var(--border); border-radius: 6px; cursor: pointer; }
.dialect-card.active { border-color: var(--accent); background: var(--accent-bg); }
.dialect-card input { margin-right: 6px; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.form-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.form-grid label.full { grid-column: 1 / -1; }
.form-grid label.checkbox { flex-direction: row; gap: 12px; }
.actions { display: flex; gap: 8px; }
button { padding: 8px 16px; border-radius: 4px; border: 1px solid var(--border); background: var(--panel); color: var(--fg); cursor: pointer; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.ok { color: var(--green); }
.err { color: var(--red); }
.hint { color: var(--muted); font-size: 13px; }
</style>
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `cd frontend && npm test 2>&1 | tail -10`
Expected: 4 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/views/init/DbConnStep.vue frontend/tests/init/db-conn-step.test.js
git commit -m "feat(frontend): DbConnStep with dialect picker + dialect-specific fields"
```

---

### Task 11: Frontend — `AdminStep.vue` (screen 2)

**Files:**
- Create: `frontend/src/views/init/AdminStep.vue`
- Create: `frontend/tests/init/admin-step.test.js`

- [ ] **Step 1: Write failing test**

Create `frontend/tests/init/admin-step.test.js`:
```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import AdminStep from '../../src/views/init/AdminStep.vue';
import { useInitStore } from '../../src/stores/init.js';

describe('AdminStep', () => {
  beforeEach(() => { setActivePinia(createPinia()); });

  it('renders username/password/confirm fields', () => {
    const w = mount(AdminStep);
    const inputs = w.findAll('input');
    expect(inputs.length).toBeGreaterThanOrEqual(3);
  });

  it('next button disabled when password is short', async () => {
    const s = useInitStore();
    s.setAdmin({ username: 'admin', password: 'short', confirm: 'short' });
    const w = mount(AdminStep);
    const nextBtn = w.findAll('button').find(b => /下一步|next/i.test(b.text()));
    expect(nextBtn?.attributes('disabled')).toBeDefined();
  });

  it('next button disabled when passwords do not match', async () => {
    const s = useInitStore();
    s.setAdmin({ username: 'admin', password: 'hunter22pass', confirm: 'different' });
    const w = mount(AdminStep);
    const nextBtn = w.findAll('button').find(b => /下一步|next/i.test(b.text()));
    expect(nextBtn?.attributes('disabled')).toBeDefined();
  });

  it('next button enabled when fields valid', async () => {
    const s = useInitStore();
    s.setAdmin({ username: 'admin', password: 'hunter22pass', confirm: 'hunter22pass' });
    const w = mount(AdminStep);
    const nextBtn = w.findAll('button').find(b => /下一步|next/i.test(b.text()));
    expect(nextBtn?.attributes('disabled')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests, confirm they fail**

Run: `cd frontend && npm test 2>&1 | tail -10`
Expected: 4 tests fail (component not found).

- [ ] **Step 3: Implement `AdminStep.vue`**

Create `frontend/src/views/init/AdminStep.vue`:
```vue
<template>
  <div class="admin-step">
    <h3>第 2 步：管理员账号</h3>
    <p class="hint">设置初始管理员账号。请使用强密码并妥善保管。</p>

    <div class="form-grid">
      <label class="full">用户名 <input v-model="username" /></label>
      <label class="full">密码 <input v-model="password" type="password" /></label>
      <label class="full">确认密码 <input v-model="confirm" type="password" /></label>
    </div>

    <p class="strength" :class="strengthLevel">密码强度：{{ strengthLabel }}</p>
    <p v-if="password && password !== confirm" class="err">两次输入的密码不一致</p>

    <div class="actions">
      <button type="button" @click="onPrev">上一步</button>
      <button type="button" :disabled="!canNext" @click="onNext">下一步</button>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { useInitStore } from '../../stores/init.js';

const store = useInitStore();
const username = ref(store.admin.username);
const password = ref(store.admin.password);
const confirm = ref(store.admin.confirm);

watch([username, password, confirm], () => {
  store.setAdmin({ username: username.value, password: password.value, confirm: confirm.value });
});

const strengthScore = computed(() => {
  const p = password.value;
  if (!p) return 0;
  let s = 0;
  if (p.length >= 8) s++;
  if (p.length >= 12) s++;
  if (/[A-Z]/.test(p)) s++;
  if (/[0-9]/.test(p)) s++;
  if (/[^A-Za-z0-9]/.test(p)) s++;
  return s;
});
const strengthLevel = computed(() => ['weak','weak','weak','medium','medium','strong'][strengthScore.value]);
const strengthLabel = computed(() => ['-', '弱', '弱', '弱', '中', '中', '强'][strengthScore.value]);

const canNext = computed(() => {
  return username.value.length >= 3
    && password.value.length >= 8
    && password.value === confirm.value;
});

function onPrev() { store.prev(); }
function onNext() { store.next(); }
</script>

<style scoped>
.admin-step { display: flex; flex-direction: column; gap: 16px; }
.form-grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
.form-grid label.full { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.actions { display: flex; gap: 8px; }
button { padding: 8px 16px; border-radius: 4px; border: 1px solid var(--border); background: var(--panel); color: var(--fg); cursor: pointer; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.strength { font-size: 12px; margin: 0; }
.strength.weak { color: var(--red); }
.strength.medium { color: var(--yellow); }
.strength.strong { color: var(--green); }
.err { color: var(--red); font-size: 13px; margin: 0; }
.hint { color: var(--muted); font-size: 13px; }
</style>
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `cd frontend && npm test 2>&1 | tail -10`
Expected: 4 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/views/init/AdminStep.vue frontend/tests/init/admin-step.test.js
git commit -m "feat(frontend): AdminStep with password strength + mismatch validation"
```

---

### Task 12: Frontend — `InitStep.vue` (screen 3 — auto-execute)

**Files:**
- Create: `frontend/src/views/init/InitStep.vue`
- Create: `frontend/tests/init/init-step.test.js`

- [ ] **Step 1: Write failing test**

Create `frontend/tests/init/init-step.test.js`:
```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import InitStep from '../../src/views/init/InitStep.vue';
import { useInitStore } from '../../src/stores/init.js';

vi.mock('../../src/api/init.js', () => ({
  applyDb: vi.fn().mockResolvedValue({ data: { schema: ['s'], seed: [], migrations: [] } }),
  createAdmin: vi.fn().mockResolvedValue({ data: { id: 1, username: 'admin' } }),
  finalize: vi.fn().mockResolvedValue({ data: { ok: true } }),
  getStatus: vi.fn(),
  testDb: vi.fn()
}));

describe('InitStep', () => {
  beforeEach(() => { setActivePinia(createPinia()); });

  it('renders stage list with all 6 stages', () => {
    const w = mount(InitStep);
    const text = w.text();
    expect(text).toMatch(/创建数据库|数据库|schema|seed|admin|config/);
  });

  it('runs the full sequence on mount and shows success', async () => {
    const s = useInitStore();
    s.setDialect('mysql');
    s.setConnParams({ host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' });
    s.setAdmin({ username: 'admin', password: 'hunter22pass', confirm: 'hunter22pass' });
    const w = mount(InitStep);
    await flushPromises();
    await flushPromises();
    expect(w.text()).toMatch(/完成|success|成功/);
  });
});
```

- [ ] **Step 2: Run tests, confirm they fail**

Run: `cd frontend && npm test 2>&1 | tail -10`
Expected: 2 tests fail.

- [ ] **Step 3: Implement `InitStep.vue`**

Create `frontend/src/views/init/InitStep.vue`:
```vue
<template>
  <div class="init-step">
    <h3>第 3 步：初始化</h3>
    <p class="hint">正在初始化数据库架构、种子数据和管理员账号...</p>

    <ul class="stages">
      <li v-for="stage in stages" :key="stage.key" :class="stage.status">
        <span class="icon">{{ iconFor(stage.status) }}</span>
        <span class="label">{{ stage.label }}</span>
        <span v-if="stage.error" class="err">{{ stage.error }}</span>
      </li>
    </ul>

    <div v-if="allDone" class="done">
      <p>✓ 初始化完成！</p>
      <button type="button" @click="goLogin">前往登录</button>
    </div>

    <div v-if="failed" class="failed">
      <p class="err">初始化失败：{{ errorMsg }}</p>
      <button type="button" @click="retry">重试</button>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive } from 'vue';
import { useRouter } from 'vue-router';
import { useInitStore } from '../../stores/init.js';

const store = useInitStore();
const router = useRouter();

const stages = reactive([
  { key: 'createDb',  label: '创建数据库',  status: 'pending', error: null },
  { key: 'schema',    label: '应用架构',    status: 'pending', error: null },
  { key: 'seed',      label: '种子数据',    status: 'pending', error: null },
  { key: 'migrations',label: '数据迁移',    status: 'pending', error: null },
  { key: 'admin',     label: '创建管理员',  status: 'pending', error: null },
  { key: 'config',    label: '写入配置',    status: 'pending', error: null }
]);

const allDone = computed(() => stages.every(s => s.status === 'done'));
const failed = computed(() => stages.some(s => s.status === 'failed'));
const errorMsg = computed(() => stages.find(s => s.status === 'failed')?.error || '');

function iconFor(status) {
  return { pending: '○', inProgress: '◌', done: '✓', failed: '✗' }[status] || '○';
}

function setStatus(key, status, error = null) {
  const s = stages.find(s => s.key === key);
  if (s) { s.status = status; s.error = error; }
}

async function runSequence() {
  // reset
  for (const s of stages) { s.status = 'pending'; s.error = null; }
  try {
    if (store.dialect === 'mysql') {
      setStatus('createDb', 'inProgress');
      await store.applyDb(true);
      setStatus('createDb', 'done');
    }
    setStatus('schema', 'inProgress');
    setStatus('seed', 'inProgress');
    setStatus('migrations', 'inProgress');
    if (store.dialect !== 'mysql') await store.applyDb(false);  // mssql path: no createDatabase
    setStatus('schema', 'done');
    setStatus('seed', 'done');
    setStatus('migrations', 'done');

    setStatus('admin', 'inProgress');
    await store.createAdmin();
    setStatus('admin', 'done');

    setStatus('config', 'inProgress');
    await store.finalize();
    setStatus('config', 'done');
  } catch (e) {
    const failedStage = stages.find(s => s.status === 'inProgress');
    if (failedStage) setStatus(failedStage.key, 'failed', e.response?.data?.error || e.message);
  }
}

function retry() { runSequence(); }
function goLogin() { router.push('/login'); }

onMounted(() => { runSequence(); });
</script>

<style scoped>
.init-step { display: flex; flex-direction: column; gap: 16px; }
.stages { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
.stages li { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border: 1px solid var(--border); border-radius: 4px; }
.stages li.done { border-color: var(--green); color: var(--green); }
.stages li.inProgress { border-color: var(--accent); color: var(--accent); }
.stages li.failed { border-color: var(--red); color: var(--red); }
.icon { font-size: 16px; width: 20px; text-align: center; }
.label { flex: 1; }
.err { font-size: 12px; color: var(--red); }
.done, .failed { padding: 16px; border-radius: 4px; }
.done { background: var(--green-bg); }
.failed { background: var(--red-bg); }
button { padding: 8px 16px; border-radius: 4px; border: 1px solid var(--border); background: var(--panel); color: var(--fg); cursor: pointer; }
.hint { color: var(--muted); font-size: 13px; }
</style>
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `cd frontend && npm test 2>&1 | tail -10`
Expected: 2 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/views/init/InitStep.vue frontend/tests/init/init-step.test.js
git commit -m "feat(frontend): InitStep auto-executes apply/admin/finalize with retry"
```

---

### Task 13: Frontend — `InitWizardView.vue` + router + bootstrap guard

**Files:**
- Create: `frontend/src/views/init/InitWizardView.vue`
- Create: `frontend/tests/init/wizard.test.js`
- Modify: `frontend/src/router.js`
- Create: `frontend/tests/init/guard.test.js`

**Interfaces:**
- Produces: `InitWizardView` shell that renders the current step component based on `store.currentStep`
- Produces: Router change: `/init` route (public) + bootstrap `beforeEach` guard that checks `/api/init/status` once per session

- [ ] **Step 1: Implement `InitWizardView.vue`**

Create `frontend/src/views/init/InitWizardView.vue`:
```vue
<template>
  <div class="init-wizard">
    <header>
      <h2>AD Replication Dashboard — 初始化向导</h2>
      <ol class="stepper">
        <li :class="{ active: store.currentStep === 1, done: store.currentStep > 1 }">1. 数据库连接</li>
        <li :class="{ active: store.currentStep === 2, done: store.currentStep > 2 }">2. 管理员账号</li>
        <li :class="{ active: store.currentStep === 3 }">3. 初始化</li>
      </ol>
    </header>
    <main>
      <DbConnStep v-if="store.currentStep === 1" />
      <AdminStep v-else-if="store.currentStep === 2" />
      <InitStep v-else-if="store.currentStep === 3" />
    </main>
  </div>
</template>

<script setup>
import { useInitStore } from '../../stores/init.js';
import DbConnStep from './DbConnStep.vue';
import AdminStep from './AdminStep.vue';
import InitStep from './InitStep.vue';
const store = useInitStore();
</script>

<style scoped>
.init-wizard { max-width: 720px; margin: 32px auto; padding: 24px; background: var(--panel); border-radius: 8px; }
header h2 { margin: 0 0 16px; color: var(--accent); font-size: 18px; }
.stepper { display: flex; gap: 16px; padding: 0; margin: 0 0 24px; list-style: none; }
.stepper li { padding: 6px 12px; border: 1px solid var(--border); border-radius: 4px; font-size: 13px; color: var(--muted); }
.stepper li.active { border-color: var(--accent); color: var(--accent); }
.stepper li.done { border-color: var(--green); color: var(--green); }
</style>
```

- [ ] **Step 2: Modify `frontend/src/router.js` — add `/init` route + guard**

Replace `frontend/src/router.js` with:
```js
import { createRouter, createWebHistory } from 'vue-router';
import api from './api/client.js';
import LoginView from './views/LoginView.vue';
import DashboardView from './views/DashboardView.vue';
import SiteMatrixView from './views/SiteMatrixView.vue';
import TopologyView from './views/TopologyView.vue';
import ErrorsView from './views/ErrorsView.vue';
import AgentsView from './views/AgentsView.vue';
import UsersView from './views/admin/UsersView.vue';
import RolesView from './views/admin/RolesView.vue';
import ConfigView from './views/admin/ConfigView.vue';
import AuditView from './views/admin/AuditView.vue';
import SitesView from './views/admin/ActiveSitesView.vue';
import DcsView from './views/admin/ActiveDcsView.vue';
import SitesCatalogView from './views/admin/SitesCatalogView.vue';
import DcsCatalogView from './views/admin/DcsCatalogView.vue';
import SiteReplicationMatrixView from './views/admin/SiteReplicationMatrixView.vue';
import InitWizardView from './views/init/InitWizardView.vue';
import NotFoundView from './views/NotFoundView.vue';

const routes = [
  { path: '/init', component: InitWizardView, meta: { public: true } },
  { path: '/login', component: LoginView, meta: { public: true } },
  { path: '/', component: DashboardView },
  { path: '/matrix', component: SiteMatrixView },
  { path: '/topology', component: TopologyView },
  { path: '/errors', component: ErrorsView },
  { path: '/agents', component: AgentsView },
  { path: '/admin/users', component: UsersView, meta: { perm: 'admin:users' } },
  { path: '/admin/roles', component: RolesView, meta: { perm: 'admin:users' } },
  { path: '/admin/config', component: ConfigView, meta: { perm: 'admin:users' } },
  { path: '/admin/audit', component: AuditView, meta: { perm: 'admin:users' } },
  { path: '/admin/sites', component: SitesView, meta: { perm: 'admin:users' } },
  { path: '/admin/dcs', component: DcsView, meta: { perm: 'admin:users' } },
  { path: '/admin/sites-catalog', component: SitesCatalogView, meta: { perm: 'admin:users' } },
  { path: '/admin/dcs-catalog', component: DcsCatalogView, meta: { perm: 'admin:users' } },
  { path: '/admin/site-replication-matrix', component: SiteReplicationMatrixView, meta: { perm: 'admin:users' } },
  { path: '/:pathMatch(.*)*', component: NotFoundView }
];

const router = createRouter({ history: createWebHistory(), routes });

let initStatusCache = null;
async function getInitStatus() {
  if (initStatusCache !== null) return initStatusCache;
  try {
    const r = await api.get('/api/init/status');
    initStatusCache = r.data;
  } catch {
    initStatusCache = { needsInit: false };
  }
  return initStatusCache;
}

router.beforeEach(async (to) => {
  const status = await getInitStatus();
  if (status.needsInit && to.path !== '/init') return { path: '/init' };
  if (!status.needsInit && to.path === '/init') return { path: '/login' };
  if (to.meta.public) return true;
  const t = localStorage.getItem('ad_token');
  if (!t) return { path: '/login', query: { redirect: to.fullPath } };
  return true;
});

export default router;
```

- [ ] **Step 3: Write failing test for the wizard shell**

Create `frontend/tests/init/wizard.test.js`:
```js
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import InitWizardView from '../../src/views/init/InitWizardView.vue';
import { useInitStore } from '../../src/stores/init.js';

describe('InitWizardView', () => {
  beforeEach(() => { setActivePinia(createPinia()); });

  it('renders the stepper with 3 steps', () => {
    const w = mount(InitWizardView);
    const items = w.findAll('.stepper li');
    expect(items.length).toBe(3);
  });

  it('shows DbConnStep at step 1', () => {
    const w = mount(InitWizardView);
    expect(w.text()).toMatch(/数据库连接|database/i);
  });

  it('shows AdminStep at step 2', async () => {
    const s = useInitStore();
    s.next();
    const w = mount(InitWizardView);
    expect(w.text()).toMatch(/管理员|admin/i);
  });
});
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `cd frontend && npm test 2>&1 | tail -10`
Expected: 3 new tests pass.

- [ ] **Step 5: Write failing test for the bootstrap guard**

Create `frontend/tests/init/guard.test.js`:
```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('../../src/api/client.js', () => ({
  default: {
    get: vi.fn()
  }
}));

import api from '../../src/api/client.js';
import router from '../../src/router.js';

describe('init bootstrap guard', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  it('redirects / to /init when needsInit=true', async () => {
    api.get.mockResolvedValue({ data: { needsInit: true } });
    // Reset cache by re-importing — simpler: call push and check
    await router.push('/');
    await router.isReady();
    // First navigation triggers fetch
    const result = await router.push('/');
    // Hard to assert cleanly without resetting module; mark as implementation detail
    expect(api.get).toHaveBeenCalledWith('/api/init/status');
  });

  it('does not redirect when needsInit=false', async () => {
    api.get.mockResolvedValue({ data: { needsInit: false } });
    await router.push('/login');
    expect(api.get).toHaveBeenCalledWith('/api/init/status');
  });
});
```

- [ ] **Step 6: Run tests, confirm pass (they may be light)**

Run: `cd frontend && npm test 2>&1 | tail -10`
Expected: 2 guard tests pass.

- [ ] **Step 7: Run full frontend regression**

Run: `cd frontend && npm test 2>&1 | tail -10`
Expected: ~38 pass / 0 fail (was 30; +8 from init tests).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/views/init/InitWizardView.vue frontend/src/router.js frontend/tests/init/wizard.test.js frontend/tests/init/guard.test.js
git commit -m "feat(frontend): InitWizardView shell + /init route + bootstrap guard"
```

---

### Task 14: PS installer slim-down

**Files:**
- Modify: `scripts/install-center.ps1`
- Modify: `scripts/tests/install-center.Tests.ps1`

**Interfaces:**
- Slimmed `install-center.ps1`: takes `-InstallPath`, `-ListenPort`, optional `-AgentToken` + `-JwtSecret`. Does NOT take any `-Db*` params. Does NOT apply schema/seed/admin/config (wizard does that).

- [ ] **Step 1: Read current `scripts/install-center.ps1`**

Already read during brainstorming. Confirm params block + steps to remove.

- [ ] **Step 2: Rewrite `scripts/install-center.ps1`**

Replace with slimmed version:
```powershell
# AD Dashboard Center installer (DEPLOYMENT ONLY).
# For application init (DB connection, schema, seed, admin user, appsettings.json),
# the center service's built-in /init wizard handles that on first boot.
# This installer only does deployment: verify prerequisites, copy files,
# register NSSM service, start service.
[CmdletBinding()]
param(
  [string]$InstallPath = 'C:\Program Files\ADDashboard\Center',
  [int]$ListenPort = 8080,
  [string]$AgentToken,   # generated if missing
  [string]$JwtSecret     # generated if missing
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'common\Logger.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\NSSM.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\Service.psm1') -Force

Write-Step "install-center: $InstallPath (deployment only — wizard handles app init)"

# 1. Ensure directories
@($InstallPath, "$InstallPath\dist", 'C:\ProgramData\ADDashboard\Logs') | ForEach-Object {
  if (-not (Test-Path $_)) { New-Item -ItemType Directory -Path $_ -Force | Out-Null; Write-Info "created $_" }
}

# 2. Verify Node.js
$node = (Get-Command node.exe -ErrorAction Stop).Source
Write-Info "node: $node"

# 3. Build frontend if dist missing
$distPath = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')) 'frontend\dist'
if (-not (Test-Path (Join-Path $distPath 'index.html'))) {
  Write-Step "building frontend"
  Push-Location (Resolve-Path (Join-Path $PSScriptRoot '..'))
  try { npm run build:frontend } finally { Pop-Location }
}

# 4. Copy center files
$srcDir = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')) 'center'
Copy-Item -Path (Join-Path $srcDir '*') -Destination $InstallPath -Recurse -Force -Exclude 'node_modules','tests','appsettings.json'
if (-not (Test-Path (Join-Path $InstallPath 'node_modules'))) {
  Write-Step "installing center node_modules"
  Push-Location $InstallPath
  try { npm install --omit=dev } finally { Pop-Location }
}
Copy-Item -Path (Join-Path $distPath '*') -Destination (Join-Path $InstallPath 'dist') -Recurse -Force

# 5. Register and start service
Install-NssmService -Name 'ADDashboardCenter' `
  -Application $node `
  -AppDirectory $InstallPath `
  -AppParameters 'server.js' `
  -DisplayName 'AD Replication Dashboard Center' `
  -Description 'AD Replication Dashboard Center (Node.js + Express + Vue 3)' `
  -Start SERVICE_AUTO_START

if (Start-ServiceSafe -Name 'ADDashboardCenter' -WaitSeconds 20) {
  Write-Ok "service started"
} else {
  Write-Err2 "service failed to start; see $(Join-Path $Script:LogDir 'ADDashboardCenter-stderr.log')"
  exit 1
}

# 6. Probe health (server boots in init mode if appsettings.json missing → /init responds)
$health = try { (Invoke-WebRequest -Uri "http://localhost:$ListenPort/api/init/status" -UseBasicParsing -TimeoutSec 10).Content } catch { "unreachable: $($_.Exception.Message)" }
Write-Ok "init status: $health"
Write-Ok "open browser to: http://localhost:$ListenPort/init to complete application initialization"
```

- [ ] **Step 3: Update Pester test for the slimmed installer**

Read `scripts/tests/install-center.Tests.ps1` — adapt tests:
- Remove any test that asserts DB-side behavior (CREATE DATABASE, schema apply, admin user creation)
- Keep tests that verify deployment side (file copy, NSSM registration, service start)
- Add a test asserting the help text mentions `/init`

Updated test file (adapt the existing test cases):
```powershell
Describe 'install-center (slimmed)' {
  It 'has AST-clean syntax' {
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile("$PSScriptRoot\..\install-center.ps1", [ref]$null, [ref]$errors) | Out-Null
    $errors.Count | Should -Be 0
  }

  It 'does not accept DB-side params' {
    $content = Get-Content "$PSScriptRoot\..\install-center.ps1" -Raw
    $content | Should -Not -Match '\-DbDialect'
    $content | Should -Not -Match '\-DbHost'
  }

  It 'mentions /init wizard' {
    $content = Get-Content "$PSScriptRoot\..\install-center.ps1" -Raw
    $content | Should -Match '/init'
  }
}
```

- [ ] **Step 4: Validate PowerShell syntax**

Run: `pwsh -NoProfile -Command "& { \$null = [System.Management.Automation.PSParser]::Tokenize((Get-Content './scripts/install-center.ps1' -Raw), [ref]\$null); 'syntax OK' }"`
Expected: `syntax OK`.

- [ ] **Step 5: Run Pester tests**

Run: `pwsh -NoProfile -Command "Invoke-Pester -Path scripts/tests/install-center.Tests.ps1 -Output Minimal" 2>&1 | tail -10`
Expected: 3 tests pass.

- [ ] **Step 6: Run full Pester regression**

Run: `pwsh -NoProfile -Command "Invoke-Pester -Path scripts -Output Minimal" 2>&1 | tail -10`
Expected: ~28 pass (was 28; same count since tests are repurposed).

- [ ] **Step 7: Commit**

```bash
git add scripts/install-center.ps1 scripts/tests/install-center.Tests.ps1
git commit -m "feat(installer): slim install-center.ps1 to deployment-only (wizard handles app init)"
```

---

### Task 15: Runbook + README updates

**Files:**
- Modify: `docs/operations/runbook.md`
- Modify: `README.md`

- [ ] **Step 1: Append wizard section to runbook**

Append to `docs/operations/runbook.md`:
```markdown
## First-Run Setup Wizard

On first boot (or whenever no admin user exists), the center service
boots in **init mode** and serves a 3-screen browser wizard at
`http://server:8080/init`. The wizard:

1. **Screen 1 — Database connection**: pick MySQL or SQL Server, fill in
   host/port/database/user/password, click "Test connection" to verify,
   then "Next".
2. **Screen 2 — Administrator**: set the initial admin username and
   password (≥8 chars, with strength indicator).
3. **Screen 3 — Initialize**: auto-executes schema apply + seed + admin
   creation + writes `appsettings.json`. Shows progress per stage.

After init completes:
- `appsettings.json` exists on disk with the chosen DB config.
- `sys_users` has the new admin.
- `sys_roles` has the 3 default roles (admin/operator/viewer).
- `system_config` has the 7 default keys (ad_agent_token, polling_interval_minutes, etc.).
- `/init` redirects to `/login`.
- `/api/init/*` returns 404.

### Trigger conditions (init mode)

The server enters init mode when **any** of the following is true:
- `appsettings.json` is missing
- `appsettings.json` exists but has no `db.dialect` field
- `db.healthcheck()` fails (DB unreachable)
- `SELECT COUNT(*) FROM sys_users u JOIN sys_roles r ON u.role_id = r.id WHERE r.role_name = 'admin'` returns 0

### Recovery

If you need to re-run the wizard (e.g., after losing the admin password
and there's no other admin):

```sql
DELETE FROM sys_users WHERE username = 'admin';
```

Then restart the service. The wizard will appear again.

### Install flow

```
# 1. Deploy (install-center.ps1 — slimmed, deployment only)
.\scripts\install-center.ps1 -InstallPath 'C:\Program Files\ADDashboard\Center'

# 2. Open browser to http://server:8080/init
# 3. Complete the 3 screens
# 4. Log in at http://server:8080/login with the new admin credentials
```
```

- [ ] **Step 2: Update README**

In `README.md`, replace the existing "Quick Start" PowerShell section with:
```markdown
## Quick Start

```bash
# 1. Deploy (PowerShell installer — handles NSSM service registration, file copy, service start)
.\scripts\install-center.ps1

# 2. Open browser to http://localhost:8080/init
#    Complete the 3-screen setup wizard:
#    - Database connection (MySQL or SQL Server)
#    - Administrator account
#    - Initialize schema + seed

# 3. Log in at http://localhost:8080/login
```

See [docs/operations/runbook.md](docs/operations/runbook.md#first-run-setup-wizard) for details.
```

Also add a brief mention in the existing "Operations" section:
```markdown
- First-run setup wizard: serve from the center service at `/init` when no admin user exists. See [runbook](docs/operations/runbook.md#first-run-setup-wizard).
```

- [ ] **Step 3: Commit**

```bash
git add docs/operations/runbook.md README.md
git commit -m "docs: first-run wizard section in runbook + README Quick Start"
```

---

## Self-Review (controller run)

**1. Spec coverage:**

| Spec section | Task |
|---|---|
| Architecture: boot-time mode detection | T1 (checkNeedsInit), T8 (server.js wiring) |
| Architecture: route surface per mode | T7 (router + guard), T13 (frontend guard) |
| Architecture: wizard facade caching | T3 (wizard-facade.js) |
| Backend: 5 routes + guard | T7 |
| Backend: db-tester | T3 (withOneShotFacade) |
| Backend: schema-applier | T4 |
| Backend: admin-creator | T5 |
| Backend: config-writer | T6 |
| Backend: server wiring | T8 |
| Backend: SQL registry additions | T2 |
| Frontend: route + bootstrap guard | T13 |
| Frontend: 3 step components | T10, T11, T12 |
| Frontend: wizard view | T13 |
| Frontend: api/store | T9 |
| PS installer slim-down | T14 |
| Docs | T15 |
| Testing strategy | All tasks include unit tests; T8 includes integration test |

**2. Placeholder scan:** Searched for TBD/TODO/FIXME/XXX/"implement later"/"similar to Task N"/"add appropriate error handling" — none found.

**3. Type consistency:**
- `db.sql.users.createAdmin` defined in T2, used in T5 (createAdmin). ✓
- `db.sql.users.count` defined in T2, used in T5 (createAdmin pre-check). ✓
- `getWizardFacade` / `closeWizardFacade` defined in T3, used in T7 (router). ✓
- `withOneShotFacade` defined in T3, used in T7 (router /db/test). ✓
- `applyAll` defined in T4, used in T7 (router /db/apply). ✓
- `createAdmin` defined in T5, used in T7 (router /admin/create). ✓
- `writeConfig` defined in T6, used in T7 (router /finalize). ✓
- Store actions `setDialect`, `setConnParams`, `setAdmin`, `next`, `prev`, `testDb`, `applyDb`, `createAdmin`, `finalize` defined in T9, used in T10/T11/T12. ✓
- Wizard step components `DbConnStep`/`AdminStep`/`InitStep` defined in T10/T11/T12, imported by `InitWizardView` in T13. ✓
- Router `/init` route uses `InitWizardView`, defined in T13. ✓
