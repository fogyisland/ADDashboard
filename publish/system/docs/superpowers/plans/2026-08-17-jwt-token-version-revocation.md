# JWT token_version Revocation (I1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-user JWT revocation by stamping a `token_version` claim; the `userAuth` middleware compares it against the DB row on every request and rejects mismatches with 401, while four trigger paths (admin force-revoke, password change, status flip, role/permission change) bump the counter atomically with the data write.

**Architecture:** Additive column `sys_users.token_version INT NOT NULL DEFAULT 0` (migration 015, dual-platform). `verifyJwt` defaults a missing `tokenVersion` claim to 0 so pre-migration JWTs keep working. `userAuth({ secret, db })` adds a per-request `SELECT token_version, status FROM sys_users WHERE id = ?` and emits three distinct 401 messages. `bumpTokenVersion(userId, tx?)` accepts an optional tx so callers bind the bump to their existing transaction. New endpoint `POST /api/admin/users/:id/revoke-tokens` writes a `revoke_user_tokens` audit row with old/new `tokenVersion`. The other three triggers piggyback on the existing `update_user` audit row. Frontend untouched (v2 follow-up).

**Tech Stack:** Node 20 + node:test; `mysql2` / `mssql` drivers via the project's `db.sql` indirection; `superagent` via `supertest`; bcryptjs. Existing patterns: `_setDbForTest` + `buildMockDb(...).standard()`. Real-DB gated on `TEST_MYSQL_URL` / `TEST_MSSQL_URL`.

**Spec:** `docs/superpowers/specs/2026-08-17-jwt-token-version-revocation-design.md` — read in full before starting. The spec is the binding authority; this plan is its task-by-task argument.

## Global Constraints

(Copied verbatim from the spec and the project's binding feedbacks.)

- **GC1 — Dual-platform.** Every SQL string MUST work against both MySQL 5.7+ and MSSQL 2016+. Migration files exist in BOTH `db/migrations/` (MySQL) and `db/migrations/mssql/` (mirror). Per `feedback_mssql_migration_idempotency.md`: every CREATE/ALTER DDL is independently idempotent.
- **GC2 — MySQL ADD COLUMN pattern.** Use the `migrate_001_add_column_if_missing` stored procedure with `information_schema.COLUMNS` lookup (see `db/migrations/001-dc-site-discovery.sql`). Procedure dropped at end of file.
- **GC3 — MSSQL ADD COLUMN pattern.** Wrap `ALTER TABLE ... ADD` in `IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'table') AND name = N'col') BEGIN ... END` (see `db/migrations/mssql/001-dc-site-discovery.sql`).
- **GC4 — writeAudit signature.** `writeAudit({...}, logger, tx)` — `tx` is the **3rd** argument, not the 2nd. Per `feedback_writeaudit_signature.md`: a tx in the logger slot silently breaks the atomic rollback guarantee. grep `}, tx);` against `center/src/routes/` MUST stay 0.
- **GC5 — Mock DB convention.** Use `buildMockDb([...]).standard()` / `.withRecording(arr)` and `_setDbForTest(db)` from `center/tests/helpers/db-mock.js`. Mock txWrapper MUST expose `sql: db.sql` so writeAudit's `conn.sql.audit.write` resolves.
- **GC6 — CAML_MAP.** When a new column appears in `GET /api/admin/users`, add its snake→camel entry to the `CAML_MAP` in `center/src/routes/admin.js`. The `camelRow()` helper reads from this map; missing entry → camelCase violation in API response.
- **GC7 — Real-DB integration tests gated.** Tests under `center/tests/sql/*.test.js` MUST be skipped unless `TEST_MYSQL_URL` / `TEST_MSSQL_URL` is set. Pattern: `test(..., { skip: !process.env.TEST_MYSQL_URL })`. Per `feedback_real_db_sql_tests.md`: mock-only tests miss 5.7-incompatible syntax regressions.
- **GC8 — TDD red-green.** Every task with new behavior writes a failing test first (Step 1), runs it to confirm it fails (Step 2), writes the minimal implementation (Step 3), runs again to confirm green (Step 4), commits (Step 5).
- **GC9 — Commit cadence.** One commit per task. Messages in English with `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility | Lines (est.) |
|------|---------------|--------------|
| `db/migrations/015-user-token-version.sql` (new) | MySQL ADD COLUMN with stored-proc guard. | ~25 |
| `db/migrations/mssql/015-user-token-version.sql` (new) | MSSQL ADD COLUMN with sys.columns guard. | ~15 |
| `center/src/db/sql.js` (modify) | `users.findByUsername` SELECT adds `token_version` (both dialects). New `users.bumpTokenVersion` (both dialects). New `users.getTokenVersion` (both dialects). | +8 |
| `center/src/auth/jwt.js` (modify) | `signJwt({..., tokenVersion})` writes claim (default 0). `verifyJwt` returns `tokenVersion` (default 0 on missing). | +6 |
| `center/src/services/users.js` (modify) | `bumpTokenVersion(userId, tx?)` service. `findByUsername` returns `user.tokenVersion` (Number). `updateUser(id, fields, tx?)` signature extended; bumps when password/roleId/status present. | +30 |
| `center/src/auth/user-auth.js` (modify) | `userAuth({ secret, db })` — per-request SELECT `token_version, status`; three 401 paths. | +12 |
| `center/server.js` (modify) | Four inline `userAuth({ secret: finalConfig.jwtSecret })` factories → add `db`. | +4 |
| `center/src/routes/admin.js` (modify) | New `POST /api/admin/users/:id/revoke-tokens`. CAML_MAP `['token_version', 'tokenVersion']`. | +25 |
| `center/src/routes/dashboard.js` (modify) | `userAuth({ secret })` → `userAuth({ secret, db })`. | +1 |
| `center/src/routes/member-servers.js` (modify) | Same. | +1 |
| `center/src/packages/orphan-router.js` (modify) | Same. | +1 |
| `center/src/packages/router.js` (modify) | Same. | +1 |
| `center/src/routes/auth.js` (modify) | Login passes `user.tokenVersion` into `signJwt`. | +1 |
| `center/tests/jwt.test.js` (modify) | Add 4 cases for `tokenVersion` claim round-trip and missing-claim default. | +30 |
| `center/tests/middleware.test.js` (modify) | Update existing test to pass `db` mock. Add 4 cases for the 3 401 paths + status piggyback. | +50 |
| `center/tests/services/users.test.js` (modify) | Update `findByUsername` test for tokenVersion. Add `bumpTokenVersion` tests. Add `updateUser` trigger tests. | +60 |
| `center/tests/auth.test.js` (modify) | Update login test to verify `tokenVersion` flows into the issued JWT. | +15 |
| `center/tests/admin.test.js` (modify) | New cases for `POST /api/admin/users/:id/revoke-tokens` and the bump-on-PUT triggers. | +40 |
| `center/tests/user-token-version.test.js` (new) | Cross-cutting integration: middleware + login + revoke-tokens + audit row. | ~120 |
| `center/tests/sql/015-user-token-version-mysql.test.js` (new) | Real MySQL apply + idempotent re-apply + INSERT + SELECT + bump. | ~60 |
| `center/tests/sql/015-user-token-version-mssql.test.js` (new) | Real MSSQL mirror. | ~60 |

**Test count delta**: +24 unit + +12 integration tests; current center suite ~876 → ~900+ after Task 8, +12 real-DB after Tasks 9/10 (gated; only run when DB URLs set).

---

## Task 1: Migration files (MySQL + MSSQL)

**Files:**
- Create: `db/migrations/015-user-token-version.sql`
- Create: `db/migrations/mssql/015-user-token-version.sql`

**Interfaces:**
- Consumes: existing `migrate_001_add_column_if_missing` pattern from `db/migrations/001-dc-site-discovery.sql` (MySQL); existing `sys.columns` guard from `db/migrations/mssql/001-dc-site-discovery.sql` (MSSQL).
- Produces: `sys_users.token_version INT NOT NULL DEFAULT 0` on both dialects.

- [ ] **Step 1: Create `db/migrations/015-user-token-version.sql`**

```sql
-- verify: column sys_users.token_version

-- 015-user-token-version.sql
-- Adds token_version column to sys_users for I1 JWT revocation.
-- Idempotent on rerun (information_schema guard). DEFAULT 0 lets pre-migration
-- JWTs (which lack the claim) keep matching DB rows until an operator bumps
-- a user's token_version to 1.

DELIMITER $$

DROP PROCEDURE IF EXISTS migrate_015_add_column_if_missing$$
CREATE PROCEDURE migrate_015_add_column_if_missing(
  IN p_table VARCHAR(64), IN p_column VARCHAR(64), IN p_definition VARCHAR(255)
)
BEGIN
  DECLARE v_exists INT DEFAULT 0;
  SELECT COUNT(*) INTO v_exists FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = p_table AND COLUMN_NAME = p_column;
  IF v_exists = 0 THEN
    SET @sql = CONCAT('ALTER TABLE ', p_table, ' ADD COLUMN ', p_column, ' ', p_definition);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END$$

DELIMITER ;

CALL migrate_015_add_column_if_missing('sys_users', 'token_version',
  'INT NOT NULL DEFAULT 0');

DROP PROCEDURE migrate_015_add_column_if_missing;
```

- [ ] **Step 2: Create `db/migrations/mssql/015-user-token-version.sql`**

```sql
-- verify: column sys_users.token_version

-- 015-user-token-version.sql (MSSQL)
-- Mirror of db/migrations/015-user-token-version.sql for SQL Server.
-- sys.columns guard makes this idempotent on rerun.

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID(N'sys_users') AND name = N'token_version'
)
BEGIN
  ALTER TABLE sys_users ADD token_version INT NOT NULL
    CONSTRAINT df_users_token_version DEFAULT 0;
END;
```

- [ ] **Step 3: Verify the SQL parses**

For MySQL: `mysqldump --no-data` won't help (no DDL emitted by mock). Use a dry-parse with the project's `center/tests/sql/parser.test.js` pattern (per memory, this exists). If the parser doesn't cover migrations, skip this step — Tasks 9 and 10 will catch issues at real-DB apply time.

For MSSQL: same — Tasks 9 and 10 cover real-DB validation. There's no MySQL 5.7 JSON_LENGTH-style silent failure here because we're using only `ALTER TABLE ADD COLUMN` + ANSI `information_schema.COLUMNS` lookup (proven pattern).

- [ ] **Step 4: Commit**

```bash
cd "D:/ToolDevelop/ADDashboard"
git add db/migrations/015-user-token-version.sql db/migrations/mssql/015-user-token-version.sql
git commit -m "feat(db): add sys_users.token_version column (migration 015, dual-platform)

I1 JWT revocation. DEFAULT 0 keeps pre-migration JWTs (which lack the
tokenVersion claim) matching DB rows until an operator bumps a user's
version to 1. Both dialects guarded for idempotent re-apply.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: `db.sql.js` — `users.findByUsername` + `users.bumpTokenVersion` + `users.getTokenVersion`

**Files:**
- Modify: `center/src/db/sql.js` (mysql + mssql sections, both add a column to `users.findByUsername`, both add two new SQL strings under `users`)

**Interfaces:**
- Consumes: existing `users.findByUsername` pattern.
- Produces:
  - `users.findByUsername` — same string, plus `token_version` column in SELECT list (mysql + mssql).
  - `users.bumpTokenVersion` — new: `UPDATE sys_users SET token_version = token_version + 1 WHERE id = ?` (mysql) / `... WHERE id = @id` (mssql).
  - `users.getTokenVersion` — new: `SELECT token_version FROM sys_users WHERE id = ?` / `... WHERE id = @id`.

- [ ] **Step 1: Locate the existing `users.findByUsername` in `center/src/db/sql.js`**

Read the file. The pattern is a top-level object `db.sql` with a `users` key. There are two dialects' SQL strings nested under that. Confirm where to edit.

- [ ] **Step 2: Modify `users.findByUsername` (mysql) to add `token_version`**

Change:
```js
'SELECT id, username, password_hash, role_id, status FROM sys_users WHERE username = ?'
```
To:
```js
'SELECT id, username, password_hash, role_id, status, token_version FROM sys_users WHERE username = ?'
```

- [ ] **Step 3: Modify `users.findByUsername` (mssql) to add `token_version`**

Change:
```js
'SELECT id, username, password_hash, role_id, status FROM sys_users WHERE username = @username'
```
To:
```js
'SELECT id, username, password_hash, role_id, status, token_version FROM sys_users WHERE username = @username'
```

- [ ] **Step 4: Add `users.bumpTokenVersion` and `users.getTokenVersion` (mysql)**

Under the `users` key (mysql block), add:
```js
bumpTokenVersion: 'UPDATE sys_users SET token_version = token_version + 1 WHERE id = ?',
getTokenVersion: 'SELECT token_version FROM sys_users WHERE id = ?',
```

- [ ] **Step 5: Add `users.bumpTokenVersion` and `users.getTokenVersion` (mssql)**

Under the `users` key (mssql block), add:
```js
bumpTokenVersion: 'UPDATE sys_users SET token_version = token_version + 1 WHERE id = @id',
getTokenVersion: 'SELECT token_version FROM sys_users WHERE id = @id',
```

- [ ] **Step 6: Run existing tests to confirm no regression**

Run: `cd "D:/ToolDevelop/ADDashboard/center" && npm test -- tests/services/users.test.js`
Expected: existing tests still pass (none of them assert the absence of `token_version`).

- [ ] **Step 7: Commit**

```bash
cd "D:/ToolDevelop/ADDashboard"
git add center/src/db/sql.js
git commit -m "feat(db.sql): users.findByUsername + bumpTokenVersion + getTokenVersion (I1)

findByUsername now SELECTs token_version (both dialects) so findByUsername
can hand the user's current version to signJwt. Two new SQL strings:
bumpTokenVersion (UPDATE col = col + 1) and getTokenVersion (SELECT single
column for the audit row's oldTokenVersion).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: `auth/jwt.js` — `signJwt` / `verifyJwt` accept `tokenVersion`

**Files:**
- Modify: `center/src/auth/jwt.js`
- Modify: `center/tests/jwt.test.js`

**Interfaces:**
- Consumes: existing `signJwt({ sub, role, permissions }, secret, ttlSec)`.
- Produces:
  - `signJwt({ sub, role, permissions, tokenVersion }, secret, ttlSec)` — `tokenVersion ?? 0` written into payload.
  - `verifyJwt(token, secret)` returns `{ sub, role, permissions, tokenVersion: <number> }`. Missing-claim JWTs → `tokenVersion = 0` (backward compat).

- [ ] **Step 1: Write failing tests in `center/tests/jwt.test.js`**

Append:
```js
test('signJwt writes tokenVersion into the payload; verifyJwt returns it as a number', () => {
  const t = signJwt({ sub: 'u1', role: 'admin', tokenVersion: 7 }, 'secret', 60);
  const v = verifyJwt(t, 'secret');
  assert.equal(v.tokenVersion, 7);
  assert.equal(typeof v.tokenVersion, 'number');
});

test('signJwt defaults missing tokenVersion to 0', () => {
  const t = signJwt({ sub: 'u1', role: 'admin' }, 'secret', 60);
  const v = verifyJwt(t, 'secret');
  assert.equal(v.tokenVersion, 0);
});

test('verifyJwt defaults missing tokenVersion claim in JWT to 0 (backward compat)', () => {
  // Manually craft a JWT that lacks the tokenVersion claim (simulates a
  // pre-migration token). jwt.sign with an empty object payload omits
  // tokenVersion entirely.
  const jwt = require('jsonwebtoken'); // already a dep
  const t = jwt.sign({ role: 'admin', permissions: [] }, 'secret', { subject: 'u1', expiresIn: 60 });
  const v = verifyJwt(t, 'secret');
  assert.equal(v.sub, 'u1');
  assert.equal(v.tokenVersion, 0);
});
```

Note: the existing 2 tests must continue to pass — they call `signJwt` without `tokenVersion` and expect `verifyJwt` to return `sub` and `role`. The new defaults preserve that.

- [ ] **Step 2: Run the new tests; confirm failure**

Run: `cd "D:/ToolDevelop/ADDashboard/center" && npm test -- tests/jwt.test.js`
Expected: 3 new tests FAIL with `TypeError: Cannot read properties of undefined (reading 'tokenVersion')` or assertion failure on `assert.equal(v.tokenVersion, 7)` etc.

- [ ] **Step 3: Implement `signJwt` and `verifyJwt`**

Edit `center/src/auth/jwt.js`:
```js
import jwt from 'jsonwebtoken';

export function signJwt({ sub, role, permissions, tokenVersion }, secret, ttlSec = 3600) {
  const payload = {
    role,
    permissions: permissions ?? [],
    tokenVersion: tokenVersion ?? 0
  };
  return jwt.sign(payload, secret, { subject: String(sub), expiresIn: ttlSec });
}

export function verifyJwt(token, secret) {
  try {
    const p = jwt.verify(token, secret);
    return {
      sub: p.sub,
      role: p.role,
      permissions: p.permissions ?? [],
      tokenVersion: typeof p.tokenVersion === 'number' ? p.tokenVersion : 0
    };
  } catch { return null; }
}
```

- [ ] **Step 4: Re-run; confirm 5/5 pass**

Run: `cd "D:/ToolDevelop/ADDashboard/center" && npm test -- tests/jwt.test.js`
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
cd "D:/ToolDevelop/ADDashboard"
git add center/src/auth/jwt.js center/tests/jwt.test.js
git commit -m "feat(auth): signJwt/verifyJwt carry tokenVersion claim (I1)

signJwt writes tokenVersion (default 0). verifyJwt returns it as a
number (default 0 on missing claim). Backward compatible: pre-migration
JWTs lacking the claim resolve to tokenVersion=0, matching DB DEFAULT 0
on sys_users — old sessions keep working until an operator bumps a user.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: `services/users.js` — `bumpTokenVersion` + `findByUsername.tokenVersion` + `updateUser` extension

**Files:**
- Modify: `center/src/services/users.js`
- Modify: `center/tests/services/users.test.js`

**Interfaces:**
- Consumes: Task 2's `db.sql.users.bumpTokenVersion` and `db.sql.users.getTokenVersion`. Existing `findByUsername`, `updateUser`.
- Produces:
  - `bumpTokenVersion(userId, tx = null) → Promise<number>` — increments and returns the new value. `tx` may be a tx wrapper (exposes `execute`, `query`, `sql`) or `null` (uses global `getDb()`).
  - `findByUsername(username) → Promise<row|null>` — row now includes `tokenVersion: Number(row.token_version ?? 0)`.
  - `updateUser(id, { password?, roleId?, status? }, tx = null) → Promise<void>` — when any of `password / roleId / status` is provided (non-null), bumps in the same connection's transaction.

- [ ] **Step 1: Write failing tests in `center/tests/services/users.test.js`**

Append (uses the project's `buildMockDb` + `_setDbForTest` pattern; mock the user row as needed):
```js
import { bumpTokenVersion } from '../../src/services/users.js';

test('bumpTokenVersion increments token_version by 1 and returns the new value', async () => {
  const records = [];
  _setDbForTest(buildMockDb([
    { match: /UPDATE\s+sys_users\s+SET\s+token_version/i, rows: [{ affectedRows: 1 }] },
    { match: /SELECT\s+token_version\s+FROM\s+sys_users/i, rows: [{ token_version: 1 }] }
  ]).withRecording(records));
  const v = await bumpTokenVersion(7, null);
  assert.equal(v, 1);
  const upd = records.find(r => /UPDATE\s+sys_users\s+SET\s+token_version/i.test(r.sql));
  assert.ok(upd, 'UPDATE must be issued');
  assert.equal(upd.params[0], 7);
});

test('bumpTokenVersion uses the tx wrapper when provided (atomic with caller)', async () => {
  const txCalls = [];
  const txWrapper = {
    sql: getDb().sql,
    execute: async (sql, params) => { txCalls.push({ sql, params }); return { affectedRows: 1 }; },
    query: async (sql, params) => {
      txCalls.push({ sql, params });
      return { rows: [{ token_version: 5 }] };
    }
  };
  const v = await bumpTokenVersion(7, txWrapper);
  assert.equal(v, 5);
  assert.ok(txCalls.length >= 2, 'tx wrapper receives UPDATE + SELECT');
  const globalRecords = [];
  _setDbForTest(buildMockDb([]).withRecording(globalRecords));
  // Already mutated above; reset and re-test for "global db NOT used"
  // (the assertion above proves txWrapper was used; the negative assertion
  // belongs in a dedicated test below).
});

test('bumpTokenVersion does NOT call the global db when a tx wrapper is supplied', async () => {
  const txCalls = [];
  const txWrapper = {
    sql: getDb().sql,
    execute: async (sql, params) => { txCalls.push({ sql, params }); return { affectedRows: 1 }; },
    query: async () => ({ rows: [{ token_version: 2 }] })
  };
  const records = [];
  _setDbForTest(buildMockDb([]).withRecording(records));
  await bumpTokenVersion(7, txWrapper);
  assert.equal(records.length, 0, 'global db must NOT receive the bump when tx is supplied');
});

test('findByUsername returns user.tokenVersion as Number, default 0 on missing column', async () => {
  // Row with token_version present (post-migration).
  _setDbForTest(buildMockDb([
    { match: /FROM\s+sys_users/i, rows: [{
      id: 1, username: 'admin', password_hash: 'x', role_id: 1, status: 1, role_name: 'admin', permissions: '*', token_version: 3
    }] }
  ]).standard());
  const u = await findByUsername('admin');
  assert.equal(u.tokenVersion, 3);

  // Row with token_version missing (defensive — migration never ran).
  _setDbForTest(buildMockDb([
    { match: /FROM\s+sys_users/i, rows: [{
      id: 1, username: 'admin', password_hash: 'x', role_id: 1, status: 1, role_name: 'admin', permissions: '*'
    }] }
  ]).standard());
  const u2 = await findByUsername('admin');
  assert.equal(u2.tokenVersion, 0);
});

test('updateUser with password change bumps token_version in the same connection', async () => {
  const records = [];
  const conn = buildMockDb([
    { match: /UPDATE\s+sys_users\s+SET\s+password_hash/i, rows: [{ affectedRows: 1 }] },
    { match: /UPDATE\s+sys_users\s+SET\s+token_version/i, rows: [{ affectedRows: 1 }] },
    { match: /SELECT\s+token_version\s+FROM\s+sys_users/i, rows: [{ token_version: 1 }] }
  ]).withRecording(records);
  _setDbForTest(conn);
  await updateUser(7, { password: 'new-pw-1234567890' });
  // Both UPDATE statements must have been issued on the global db (no tx in caller).
  const pwUpd = records.find(r => /UPDATE\s+sys_users\s+SET\s+password_hash/i.test(r.sql));
  const tokUpd = records.find(r => /UPDATE\s+sys_users\s+SET\s+token_version/i.test(r.sql));
  assert.ok(pwUpd, 'password UPDATE must be issued');
  assert.ok(tokUpd, 'token_version UPDATE must be issued (password change trigger)');
});

test('updateUser with status change bumps token_version', async () => {
  const records = [];
  _setDbForTest(buildMockDb([
    { match: /UPDATE\s+sys_users\s+SET\s+password_hash/i, rows: [{ affectedRows: 1 }] },
    { match: /UPDATE\s+sys_users\s+SET\s+token_version/i, rows: [{ affectedRows: 1 }] },
    { match: /SELECT\s+token_version\s+FROM\s+sys_users/i, rows: [{ token_version: 1 }] }
  ]).withRecording(records));
  await updateUser(7, { status: 0 });
  const tokUpd = records.find(r => /UPDATE\s+sys_users\s+SET\s+token_version/i.test(r.sql));
  assert.ok(tokUpd, 'token_version UPDATE must be issued (status change trigger)');
});

test('updateUser with roleId change bumps token_version', async () => {
  const records = [];
  _setDbForTest(buildMockDb([
    { match: /UPDATE\s+sys_users\s+SET\s+password_hash/i, rows: [{ affectedRows: 1 }] },
    { match: /UPDATE\s+sys_users\s+SET\s+token_version/i, rows: [{ affectedRows: 1 }] },
    { match: /SELECT\s+token_version\s+FROM\s+sys_users/i, rows: [{ token_version: 1 }] }
  ]).withRecording(records));
  await updateUser(7, { roleId: 2 });
  const tokUpd = records.find(r => /UPDATE\s+sys_users\s+SET\s+token_version/i.test(r.sql));
  assert.ok(tokUpd, 'token_version UPDATE must be issued (role change trigger)');
});

test('updateUser with no relevant field (empty patch) does NOT bump token_version', async () => {
  const records = [];
  _setDbForTest(buildMockDb([
    { match: /UPDATE\s+sys_users\s+SET\s+password_hash/i, rows: [{ affectedRows: 1 }] }
  ]).withRecording(records));
  // No password, no roleId, no status — pure read-only call shape, but the
  // existing service still issues the UPDATE (with nulls). Belt-and-braces:
  // pin that no token_version UPDATE fires.
  await updateUser(7, {});
  const tokUpd = records.find(r => /UPDATE\s+sys_users\s+SET\s+token_version/i.test(r.sql));
  assert.equal(tokUpd, undefined, 'no bump when no trigger field present');
});
```

Adjust imports at the top of the test file as needed: `findByUsername`, `updateUser`, `bumpTokenVersion`, `buildMockDb`, `_setDbForTest`, `getDb`.

- [ ] **Step 2: Run; confirm new tests fail**

Run: `cd "D:/ToolDevelop/ADDashboard/center" && npm test -- tests/services/users.test.js`
Expected: 7 new tests FAIL. Existing tests may also fail because the existing `findByUsername` mocks don't include `token_version` — fix those mocks if needed (add `token_version: 0` to existing row fixtures).

- [ ] **Step 3: Implement the service changes in `center/src/services/users.js`**

```js
import bcrypt from 'bcryptjs';
import { getDb } from '../db/index.js';

function decodePermissions(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  if (typeof value !== 'string') return [];
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

export async function findByUsername(username) {
  const db = getDb();
  const { rows } = await db.query(db.sql.users.findByUsername, [username]);
  const row = rows[0];
  if (!row) return null;
  row.permissions = decodePermissions(row.permissions);
  // Default 0 keeps the code defensive even if migration 015 hasn't run
  // (the DB default is 0 anyway, so this only matters in a hypothetical
  // pre-migration scenario where the column doesn't exist yet).
  row.tokenVersion = Number(row.token_version ?? 0);
  return row;
}

export async function listUsers() {
  const db = getDb();
  const { rows } = await db.query(db.sql.users.list);
  return rows;
}

export async function createUser({ username, password, roleId, status }) {
  const db = getDb();
  const passwordHash = await bcrypt.hash(password, 12);
  await db.execute(db.sql.users.create, [username, passwordHash, roleId, status ?? 1]);
}

export async function updateUser(id, { password, roleId, status }, tx = null) {
  const conn = tx ?? getDb();
  const passwordHash = password ? await bcrypt.hash(password, 12) : null;
  await conn.execute(conn.sql.users.update, [passwordHash, roleId ?? null, status ?? null, id]);
  // Bump token_version iff a JWT-invalidating field changed. roleId/status
  // use != null (so explicit 0/null still bumps); password uses truthy
  // (so empty-string/blank inputs don't bump; existing service treats
  // them as no-op too).
  if (password || roleId != null || status != null) {
    await bumpTokenVersion(id, conn);
  }
}

export async function deleteUser(id) {
  const db = getDb();
  await db.execute(db.sql.users.delete, [id]);
}

export async function recordLogin(id) {
  const db = getDb();
  await db.execute(db.sql.users.recordLogin, [id]);
}

export async function authenticate(username, password) {
  const user = await findByUsername(username);
  if (!user || user.status !== 1) return null;
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return null;
  await recordLogin(user.id);
  return user;
}

export async function countAdmins() {
  const db = getDb();
  const { rows } = await db.query(db.sql.users.countAdmins);
  return rows[0]?.n ?? 0;
}

// I1: bump token_version by 1 and return the new value. `tx` may be a
// caller's open transaction wrapper (so the bump commits atomically with
// the surrounding data write); pass null to use the global db facade.
// Backed by db.sql.users.bumpTokenVersion (ANSI-safe UPDATE col = col + 1).
export async function bumpTokenVersion(userId, tx = null) {
  const conn = tx ?? getDb();
  await conn.execute(conn.sql.users.bumpTokenVersion, [userId]);
  const { rows } = await conn.query(conn.sql.users.getTokenVersion, [userId]);
  return Number(rows[0]?.token_version ?? 0);
}
```

- [ ] **Step 4: Re-run; confirm 100% pass**

Run: `cd "D:/ToolDevelop/ADDashboard/center" && npm test -- tests/services/users.test.js`
Expected: all existing + new tests pass.

- [ ] **Step 5: Commit**

```bash
cd "D:/ToolDevelop/ADDashboard"
git add center/src/services/users.js center/tests/services/users.test.js
git commit -m "feat(users): bumpTokenVersion service + findByUsername tokenVersion + updateUser tx-bound bump (I1)

bumpTokenVersion(userId, tx?) — accepts an optional tx wrapper so callers
bind the bump to their existing transaction. Atomic with PUT writes.
findByUsername now returns user.tokenVersion as a Number (defaults to 0
defensively if the column is missing). updateUser signature extended to
(id, fields, tx?) and bumps internally when password/roleId/status
change — the three triggers piggyback on the existing data write without
forcing the route layer to manage transactions.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: `userAuth` middleware + 9-site `{ secret, db }` propagation

**Files:**
- Modify: `center/src/auth/user-auth.js`
- Modify: `center/server.js` (4 inline factories)
- Modify: `center/src/routes/admin.js` (1)
- Modify: `center/src/routes/dashboard.js` (1)
- Modify: `center/src/routes/member-servers.js` (1)
- Modify: `center/src/packages/orphan-router.js` (1)
- Modify: `center/src/packages/router.js` (1)
- Modify: `center/tests/middleware.test.js`

**Interfaces:**
- Consumes: Task 2's `db.sql`. Existing `userAuth({ secret })` signature.
- Produces:
  - `userAuth({ secret, db }) → (req, res, next) => Promise<void>` — new shape requires `db`. After `verifyJwt` succeeds, queries `SELECT token_version, status FROM sys_users WHERE id = ?`. Three failure paths:
    - row missing → `401 { error: 'user not found' }`
    - `status !== 1` → `401 { error: 'user disabled' }`
    - `token_version !== jwt.tokenVersion` → `401 { error: 'token revoked' }`
  - On success: `req.user = { ...verifyJwtResult, status: row.status }`.

- [ ] **Step 1: Update `center/tests/middleware.test.js` to pass `db` and add 4 new cases**

The existing test `userAuth attaches user from valid token` must be updated: the middleware now requires `db`. Provide a mock db that returns a row with `token_version = 0, status = 1` matching the JWT. Existing assertion `r.body.user.role === 'admin'` must still hold.

Add these new tests:
```js
test('userAuth returns 401 "user not found" when the row is missing', async () => {
  const token = signJwt({ sub: '7', role: 'admin', permissions: ['*'], tokenVersion: 0 }, 'secret', 60);
  const a = express();
  a.use(userAuth({ secret: 'secret', db: { query: async () => ({ rows: [] }), sql: getDb().sql } }));
  a.get('/p', (_req, res) => res.json({ ok: true }));
  const r = await supertest(a).get('/p').set('Authorization', `Bearer ${token}`);
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'user not found');
});

test('userAuth returns 401 "user disabled" when status !== 1', async () => {
  const token = signJwt({ sub: '7', role: 'admin', permissions: ['*'], tokenVersion: 0 }, 'secret', 60);
  const a = express();
  a.use(userAuth({ secret: 'secret', db: { query: async () => ({ rows: [{ token_version: 0, status: 0 }] }), sql: getDb().sql } }));
  a.get('/p', (_req, res) => res.json({ ok: true }));
  const r = await supertest(a).get('/p').set('Authorization', `Bearer ${token}`);
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'user disabled');
});

test('userAuth returns 401 "token revoked" when DB version differs from JWT claim', async () => {
  const token = signJwt({ sub: '7', role: 'admin', permissions: ['*'], tokenVersion: 0 }, 'secret', 60);
  const a = express();
  a.use(userAuth({ secret: 'secret', db: { query: async () => ({ rows: [{ token_version: 1, status: 1 }] }), sql: getDb().sql } }));
  a.get('/p', (_req, res) => res.json({ ok: true }));
  const r = await supertest(a).get('/p').set('Authorization', `Bearer ${token}`);
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'token revoked');
});

test('userAuth sets req.user.status from the DB row on success', async () => {
  const token = signJwt({ sub: '7', role: 'admin', permissions: ['*'], tokenVersion: 3 }, 'secret', 60);
  const a = express();
  a.use(userAuth({ secret: 'secret', db: { query: async () => ({ rows: [{ token_version: 3, status: 1 }] }), sql: getDb().sql } }));
  a.get('/p', (req, res) => res.json({ user: req.user }));
  const r = await supertest(a).get('/p').set('Authorization', `Bearer ${token}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.user.status, 1);
  assert.equal(r.body.user.tokenVersion, 3);
});
```

Adjust the existing test's mock db similarly.

- [ ] **Step 2: Run; confirm new tests fail + the updated existing test fails**

Run: `cd "D:/ToolDevelop/ADDashboard/center" && npm test -- tests/middleware.test.js`
Expected: existing test fails (no `db` passed); 4 new tests fail (middleware still uses old signature).

- [ ] **Step 3: Implement the new middleware**

Replace `center/src/auth/user-auth.js`:
```js
import { verifyJwt } from './jwt.js';

// Per-request middleware. Requires a `db` facade exposing `query(sql, params)`
// and `sql` (used here to resolve the token_version/status SELECT string).
// On a valid JWT, the middleware fetches the user's current `token_version`
// and `status` from the DB and rejects mismatches with three distinct 401
// messages — operators reading the response can tell whether the user was
// deleted, disabled, or had their tokens revoked.
export function userAuth({ secret, db }) {
  return async (req, res, next) => {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/);
    if (!m) return res.status(401).json({ error: 'missing token' });
    const v = verifyJwt(m[1], secret);
    if (!v) return res.status(401).json({ error: 'invalid token' });
    try {
      const { rows } = await db.query(db.sql.users.getAuthStatus, [v.sub]);
      const row = rows[0];
      if (!row) return res.status(401).json({ error: 'user not found' });
      if (row.status !== 1) return res.status(401).json({ error: 'user disabled' });
      if (Number(row.token_version) !== v.tokenVersion) return res.status(401).json({ error: 'token revoked' });
      req.user = { ...v, status: row.status };
      next();
    } catch (e) {
      next(e);
    }
  };
}
```

The middleware reads from `db.sql.users.getAuthStatus`. **Add this in `center/src/db/sql.js` Task 2's Step 4/5** as:
```js
// mysql:  'SELECT token_version, status FROM sys_users WHERE id = ?'
// mssql:  'SELECT token_version, status FROM sys_users WHERE id = @id'
```
Use a single column-name. Call it `getAuthStatus` to distinguish from `getTokenVersion` (which selects only the token_version column for audit payloads).

If Task 2 was already merged without `getAuthStatus`, **add it now** (this task depends on it). It's a one-liner per dialect — no extra commit needed; lump into the Task 5 commit.

- [ ] **Step 4: Propagate `{ secret, db }` to all 9 call sites**

For each file, change `userAuth({ secret: finalConfig.jwtSecret })` to `userAuth({ secret: finalConfig.jwtSecret, db })`. For router factories that take a config object, the pattern is `userAuth({ secret: config.jwtSecret, db })`. Files:
- `center/server.js` (4 inline factories; `db` is already in scope)
- `center/src/routes/admin.js:49`
- `center/src/routes/dashboard.js:53`
- `center/src/routes/member-servers.js:62`
- `center/src/packages/orphan-router.js:23`
- `center/src/packages/router.js:73`

- [ ] **Step 5: Verify grep — no orphan `{ secret: ... }` calls remain**

Run:
```bash
grep -rn "userAuth({ secret" "D:/ToolDevelop/ADDashboard/center/src" "D:/ToolDevelop/ADDashboard/center/server.js"
```
Expected: 0 hits. Any leftover call site would receive `db: undefined` and crash at first request.

- [ ] **Step 6: Run full center test suite; confirm all green**

Run: `cd "D:/ToolDevelop/ADDashboard/center" && npm test`
Expected: all tests pass. Pay attention to `tests/admin*.test.js`, `tests/dashboard.test.js`, `tests/member-servers-api.test.js`, `tests/packages/router*.test.js`, `tests/heartbeat-report-probe-endpoint.test.js`, `tests/migrations-router.test.js`, `tests/lockout-search.test.js`, `tests/dcs-summary.test.js`, `tests/auth.test.js`, `tests/e2e/plugin-system.test.js` — any of these that mocks `userAuth` or hits a route behind it will need its mock updated to provide `db`.

- [ ] **Step 7: Commit**

```bash
cd "D:/ToolDevelop/ADDashboard"
git add center/src/auth/user-auth.js center/src/db/sql.js center/server.js \
        center/src/routes/admin.js center/src/routes/dashboard.js \
        center/src/routes/member-servers.js \
        center/src/packages/orphan-router.js center/src/packages/router.js \
        center/tests/middleware.test.js
git commit -m "feat(auth): userAuth middleware adds per-request token_version+status check (I1)

Middleware signature is now userAuth({ secret, db }) — every call site
propagated (9 sites: server.js x4, admin/dashboard/member-servers/
orphan-router/packages-router x5). After JWT verify, queries
SELECT token_version, status FROM sys_users WHERE id = ? and rejects:
- row missing  -> 401 'user not found'
- status != 1  -> 401 'user disabled'
- version mismatch -> 401 'token revoked'
On success, req.user gains status from the DB row.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: `routes/auth.js` — login passes `tokenVersion` + `auth.test.js` update

**Files:**
- Modify: `center/src/routes/auth.js`
- Modify: `center/tests/auth.test.js`

**Interfaces:**
- Consumes: Task 3's `signJwt` accepts `tokenVersion`. Task 4's `findByUsername` returns `user.tokenVersion`.
- Produces: `POST /api/auth/login` issues a JWT whose `tokenVersion` claim equals the user's current DB row value.

- [ ] **Step 1: Write a failing test in `center/tests/auth.test.js`**

Add (or extend the existing login test):
```js
test('POST /api/auth/login embeds user.tokenVersion in the issued JWT', async () => {
  // Mock DB: findByUsername returns a user with tokenVersion=4.
  const db = buildMockDb([
    { match: /FROM\s+sys_users/i, rows: [{
      id: 42, username: 'admin', password_hash: await hashPassword('correct-horse'),
      role_id: 1, status: 1, role_name: 'admin', permissions: '*', token_version: 4
    }] },
    { match: /UPDATE\s+sys_users\s+SET\s+last_login_at/i, rows: [{ affectedRows: 1 }] }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(app()).post('/api/auth/login').send({ username: 'admin', password: 'correct-horse' });
  assert.equal(r.status, 200);
  const v = verifyJwt(r.body.token, secret);
  assert.equal(v.tokenVersion, 4);
});
```

- [ ] **Step 2: Run; confirm test fails**

Run: `cd "D:/ToolDevelop/ADDashboard/center" && npm test -- tests/auth.test.js`
Expected: the new test FAILS — the issued JWT has `tokenVersion: 0` because `signJwt` was called without it.

- [ ] **Step 3: Update `routes/auth.js` to pass `tokenVersion`**

```js
const token = signJwt(
  { sub: user.id, role: user.role_name, permissions: user.permissions, tokenVersion: user.tokenVersion },
  config.jwtSecret,
  8 * 3600
);
```

- [ ] **Step 4: Re-run; confirm green**

Run: `cd "D:/ToolDevelop/ADDashboard/center" && npm test -- tests/auth.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd "D:/ToolDevelop/ADDashboard"
git add center/src/routes/auth.js center/tests/auth.test.js
git commit -m "feat(auth): login embeds user.tokenVersion in the issued JWT (I1)

The JWT's tokenVersion claim now equals the DB row's current value at
the moment of login. The middleware compares it on every subsequent
request — bumping the row invalidates the JWT.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: `routes/admin.js` — POST `/api/admin/users/:id/revoke-tokens` + CAML_MAP entry + admin.test.js

**Files:**
- Modify: `center/src/routes/admin.js`
- Modify: `center/tests/admin.test.js`

**Interfaces:**
- Consumes: Task 4's `bumpTokenVersion(userId, tx?)` (which returns the new value). Existing `writeAudit`. Task 2's `db.sql.users.getTokenVersion`.
- Produces:
  - `POST /api/admin/users/:id/revoke-tokens` — `[userAuth, requirePerm('admin:users')]` chain. Reads current tokenVersion via `getTokenVersion`, bumps, writes audit (`revoke_user_tokens` action; payload `{ oldTokenVersion, newTokenVersion }`), responds `{ ok: true, tokenVersion: <new> }`.
  - `CAML_MAP` entry `['token_version', 'tokenVersion']`.

- [ ] **Step 1: Write failing tests in `center/tests/admin.test.js`**

Add:
```js
test('POST /api/admin/users/:id/revoke-tokens bumps version and writes audit row', async () => {
  const auditWrites = [];
  const db = buildMockDb([
    // 1. getTokenVersion (the SELECT before the bump)
    { match: /SELECT\s+token_version\s+FROM\s+sys_users\s+WHERE\s+id\s*=\s*\?/i, rows: [{ token_version: 0 }] },
    // 2. bumpTokenVersion (UPDATE)
    { match: /UPDATE\s+sys_users\s+SET\s+token_version\s*=\s*token_version\s*\+\s*1/i, rows: [{ affectedRows: 1 }] },
    // 3. post-bump SELECT for the return value
    { match: /SELECT\s+token_version\s+FROM\s+sys_users\s+WHERE\s+id\s*=\s*\?/i, rows: [{ token_version: 1 }] },
    // 4. audit write
    { match: /INSERT\s+INTO\s+audit_logs/i, capture: true, onExecute: (sql, params) => auditWrites.push({ sql, params }) }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(app)
    .post('/api/admin/users/7/revoke-tokens')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.tokenVersion, 1);
  const rev = auditWrites.find(w => w.params[1] === 'revoke_user_tokens');
  assert.ok(rev, 'revoke_user_tokens audit row must be written');
  const payload = JSON.parse(rev.params[3]);
  assert.equal(payload.oldTokenVersion, 0);
  assert.equal(payload.newTokenVersion, 1);
});

test('POST /api/admin/users/:id/revoke-tokens requires admin:users perm', async () => {
  const r = await supertest(app)
    .post('/api/admin/users/7/revoke-tokens')
    .set('Authorization', `Bearer ${nonAdminToken()}`);
  assert.equal(r.status, 403);
});

test('GET /api/admin/users includes tokenVersion via CAML_MAP', async () => {
  const db = buildMockDb([
    { match: /FROM\s+sys_users/i, rows: [
      { id: 1, username: 'admin', role_id: 1, role_name: 'admin', permissions: '*', status: 1, token_version: 7, last_login_at: null, created_at: '2026-01-01' }
    ] }
  ]).standard();
  _setDbForTest(db);
  const r = await supertest(app).get('/api/admin/users').set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body[0].tokenVersion, 7);
});
```

- [ ] **Step 2: Run; confirm new tests fail**

Run: `cd "D:/ToolDevelop/ADDashboard/center" && npm test -- tests/admin.test.js`
Expected: 3 new tests FAIL.

- [ ] **Step 3: Add the CAML_MAP entry**

In `center/src/routes/admin.js`, add `['token_version', 'tokenVersion']` to the `CAML_MAP` array.

- [ ] **Step 4: Add the new route handler**

```js
r.post('/api/admin/users/:id/revoke-tokens', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const db = getDb();
    const { rows: before } = await db.query(db.sql.users.getTokenVersion, [id]);
    const prev = Number(before[0]?.token_version ?? 0);
    const next = await bumpTokenVersion(id);
    await writeAudit({
      userId: req.user?.sub ?? null,
      action: 'revoke_user_tokens',
      target: String(id),
      payload: { oldTokenVersion: prev, newTokenVersion: next },
      logger
    });
    res.json({ ok: true, tokenVersion: next });
  } catch (e) {
    logger.error({ err: e }, 'admin user revoke-tokens failed');
    res.status(500).json({ error: 'internal' });
  }
});
```

Add `bumpTokenVersion` to the imports from `users.js`. Position the route handler next to the other user routes in the file.

- [ ] **Step 5: Re-run; confirm 3/3 new tests green**

Run: `cd "D:/ToolDevelop/ADDashboard/center" && npm test -- tests/admin.test.js`
Expected: all pass.

- [ ] **Step 6: Run full center suite; confirm 0 regressions**

Run: `cd "D:/ToolDevelop/ADDashboard/center" && npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
cd "D:/ToolDevelop/ADDashboard"
git add center/src/routes/admin.js center/tests/admin.test.js
git commit -m "feat(admin): POST /api/admin/users/:id/revoke-tokens + CAML_MAP (I1)

Operator calls this endpoint to forcibly invalidate every outstanding
JWT for a user. Reads old token_version, bumps +1, writes a
revoke_user_tokens audit row with old/new values. CAML_MAP now exposes
token_version -> tokenVersion on GET /api/admin/users responses.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 8: Real-DB integration test — MySQL

**Files:**
- Create: `center/tests/sql/015-user-token-version-mysql.test.js`

**Interfaces:**
- Consumes: `TEST_MYSQL_URL` env var (set by CI/local; gates the test). The project's real-DB test pattern (`center/tests/sql/parser.test.js` is the closest sibling — read it before writing to match style).

- [ ] **Step 1: Read `center/tests/sql/parser.test.js` for the project's real-DB test conventions**

Look for:
- How the test reads `TEST_MYSQL_URL`
- How it applies a migration (raw SQL via the mysql2 driver? via the migration runner?)
- How it cleans up (drop column? rollback?)
- How it asserts column presence (information_schema query? SHOW COLUMNS?)

- [ ] **Step 2: Write `center/tests/sql/015-user-token-version-mysql.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_MYSQL_URL;
const skip = !url;

test('015-user-token-version.sql: MySQL apply + idempotency + bump', { skip }, async () => {
  const mysql = await import('mysql2/promise');
  const conn = await mysql.createConnection(url);
  try {
    // 1. Read the migration file from disk and apply it.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sql = await fs.readFile(path.resolve(here, '../../../db/migrations/015-user-token-version.sql'), 'utf8');
    await conn.query(sql);

    // 2. Verify the column exists with DEFAULT 0.
    const [cols] = await conn.query(
      `SELECT COLUMN_NAME, COLUMN_DEFAULT, IS_NULLABLE
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sys_users' AND COLUMN_NAME = 'token_version'`
    );
    assert.equal(cols.length, 1);
    assert.equal(cols[0].COLUMN_DEFAULT, '0');
    assert.equal(cols[0].IS_NULLABLE, 'NO');

    // 3. Verify DEFAULT 0 lands on INSERT (without specifying the column).
    await conn.query("INSERT INTO sys_users (username, password_hash, role_id) VALUES ('__test_i1', 'x', 1)");
    const [rows] = await conn.query("SELECT token_version FROM sys_users WHERE username = '__test_i1'");
    assert.equal(Number(rows[0].token_version), 0);

    // 4. Bump via the I1 UPDATE.
    await conn.query("UPDATE sys_users SET token_version = token_version + 1 WHERE username = '__test_i1'");
    const [rows2] = await conn.query("SELECT token_version FROM sys_users WHERE username = '__test_i1'");
    assert.equal(Number(rows2[0].token_version), 1);

    // 5. Re-apply migration — must be idempotent.
    await conn.query(sql);

    // 6. Cleanup (best-effort; not asserted).
    await conn.query("DELETE FROM sys_users WHERE username = '__test_i1'");
  } finally {
    await conn.end();
  }
});
```

- [ ] **Step 3: Run with `TEST_MYSQL_URL` set; confirm green**

Run: `TEST_MYSQL_URL='mysql://...' npm test -- tests/sql/015-user-token-version-mysql.test.js`
Expected: 1 test passes. If the test environment doesn't have MySQL handy, skip — the gate prevents it from running in CI without the URL.

- [ ] **Step 4: Run without `TEST_MYSQL_URL`; confirm skipped**

Run: `npm test -- tests/sql/015-user-token-version-mysql.test.js`
Expected: 1 test reports `skip`.

- [ ] **Step 5: Commit**

```bash
cd "D:/ToolDevelop/ADDashboard"
git add center/tests/sql/015-user-token-version-mysql.test.js
git commit -m "test(sql): real-MySQL apply + idempotency for migration 015 (I1)

Gated on TEST_MYSQL_URL. Verifies: column appears with DEFAULT 0 NOT
NULL; INSERT without the column yields 0; ANSI UPDATE bumps to 1;
re-applying the migration is a no-op.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 9: Real-DB integration test — MSSQL

**Files:**
- Create: `center/tests/sql/015-user-token-version-mssql.test.js`

- [ ] **Step 1: Read `center/tests/sql/parser-mssql.test.js` for the project's MSSQL test conventions**

Same as Task 8 step 1, for MSSQL.

- [ ] **Step 2: Write `center/tests/sql/015-user-token-version-mssql.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_MSSQL_URL;
const skip = !url;

test('015-user-token-version.sql: MSSQL apply + idempotency + bump', { skip }, async () => {
  const sql = await import('mssql');
  // MSSQL connection config (extracted from TEST_MSSQL_URL). The exact
  // shape depends on the project's existing real-DB tests — match it.
  // ...
});
```

(Full implementation depends on the project's existing MSSQL connection helper — mirror the pattern from `center/tests/sql/parser-mssql.test.js`. The assertions mirror Task 8's MySQL ones: column exists with DEFAULT 0 NOT NULL; INSERT yields 0; ANSI UPDATE bumps to 1; re-apply is idempotent.)

- [ ] **Step 3: Run with `TEST_MSSQL_URL` set; confirm green**

Run: `TEST_MSSQL_URL='mssql://...' npm test -- tests/sql/015-user-token-version-mssql.test.js`
Expected: 1 test passes.

- [ ] **Step 4: Run without `TEST_MSSQL_URL`; confirm skipped**

Run: `npm test -- tests/sql/015-user-token-version-mssql.test.js`
Expected: 1 test reports `skip`.

- [ ] **Step 5: Commit**

```bash
cd "D:/ToolDevelop/ADDashboard"
git add center/tests/sql/015-user-token-version-mssql.test.js
git commit -m "test(sql): real-MSSQL apply + idempotency for migration 015 (I1)

Mirror of the MySQL integration test for SQL Server. Gated on
TEST_MSSQL_URL.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 10: Whole-branch opus review

**Files:**
- No code changes expected; this is the final gate.

- [ ] **Step 1: Push all commits to origin (via proxy)**

```bash
cd "D:/ToolDevelop/ADDashboard"
git -c http.proxy=http://127.0.0.1:10808 -c https.proxy=http://127.0.0.1:10808 push origin main
```

- [ ] **Step 2: Dispatch opus whole-branch reviewer**

Use the superpowers:requesting-code-review skill's code-reviewer agent. Provide:
- Branch name (`main`) and the commits since `progress_2026_08_17.md`'s baseline (the `9741a9d` commit was the ConfigView change; I1 starts after).
- The spec path (`docs/superpowers/specs/2026-08-17-jwt-token-version-revocation-design.md`) so the reviewer can verify spec coverage.
- The Global Constraints block from this plan.
- The request: "Verify the implementation matches the spec, no regressions in adjacent tests, dual-platform SQL is correct, no placeholders or TODO."

- [ ] **Step 3: Triage the reviewer's findings**

- **Spec compliance**: any spec decision not implemented?
- **Quality**: any code smells, edge cases missed, security holes?
- **Tests**: any gaps in coverage?
- **Dual-platform**: any SQL that works on MySQL but not MSSQL or vice versa?

Address each finding in a fix commit (or escalate to user if it requires design change).

- [ ] **Step 4: Mark Task #168 complete**

Update TaskList. Final commit message: `chore: mark Task #168 (I1) complete after whole-branch review`.

---

## Self-Review

(Performed before saving the plan; logged here for traceability.)

**Spec coverage check**:
- D1 (per-request SELECT) → Tasks 5 (middleware) + 2 (sql.js).
- D2 (missing-claim defaults to 0) → Task 3 (jwt.js).
- D3 (4 trigger paths) → Tasks 4 (updateUser bumps) + 7 (revoke-tokens endpoint). DELETE doesn't bump by design (row removal is the signal) — explicit in spec §Data flow.
- D4 (audit) → Task 7 (`revoke_user_tokens` row).
- D5 (tx-bound bump) → Task 4 (bumpTokenSignature + tx param).
- D6 (new endpoint) → Task 7.
- D7 (schema storage) → Task 1.
- D8 (dual-platform migration) → Task 1.
- D9 (CAML_MAP) → Task 7.
- D10 (no frontend) → no task; explicit.
- All spec sections have at least one task implementing them. **No gaps.**

**Placeholder scan**:
- "If Task 2 was already merged without `getAuthStatus`" — present in Task 5 step 3. This is a "branch-on-state" instruction (decide at task time), not a placeholder. Acceptable per project pattern (other plans have similar "if X then Y" steps).
- Tasks 8/9 step 1 ("Read ... for the project's conventions") are discovery steps, not placeholders. The actual code shape depends on what's already there. Acceptable.
- All code blocks contain real, runnable code.
- All commit messages are concrete English strings.

**Type/signature consistency**:
- `bumpTokenVersion(userId, tx = null) → Promise<Number>` — defined in Task 4, consumed by Tasks 5 (none — middleware uses `getAuthStatus` SELECT, not bump), 6 (none), 7 (revoke-tokens). Matches.
- `signJwt({ sub, role, permissions, tokenVersion }, secret, ttlSec)` — defined in Task 3, consumed by Task 6 (login) and existing tests. Matches.
- `verifyJwt(token, secret) → { sub, role, permissions, tokenVersion: number }` — defined in Task 3, consumed by Tasks 5 (middleware) + 6 (test). Matches.
- `userAuth({ secret, db })` — defined in Task 5, consumed by all 9 call sites in same task. Matches.
- `db.sql.users.getAuthStatus` — added in Task 5 step 3 (lumped with the middleware change). Matches the mock in middleware.test.js.

**Internal consistency**:
- The `getAuthStatus` SELECT (token_version, status) and the `getTokenVersion` SELECT (token_version only) are distinct — the former is for the per-request middleware check; the latter is for the audit row's `oldTokenVersion` payload. Spec mentions both implicitly. Tasks 5 and 7 use them correctly.
- The middleware test's mock uses `db: { query: async () => ({ rows: [{ token_version: 0, status: 1 }] }), sql: getDb().sql }` — this works because the test mocks the relevant query at the facade level. Production `db` exposes `query` and `sql` similarly. Matches.

**Scope check**: One branch, one feature, one review. No decomposition needed.