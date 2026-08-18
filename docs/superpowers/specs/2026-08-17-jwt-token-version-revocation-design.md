# JWT token_version Revocation (I1)

**Date:** 2026-08-17
**Status:** Design (post-brainstorming, awaiting user review)
**Origin:** `progress_2026_08_07.md` (audit log redesign) + `progress_2026_08_17.md` (I2+I4+I7 shipped). Follow-up I1 from the same Week 1-3 audit/security roadmap. User explicitly reminded: backend must remain dual-platform (MySQL + MSSQL).

---

## Goal

Give AD Dashboard Center operators the ability to **forcibly invalidate every outstanding JWT for a specific user** by bumping a per-user `token_version` counter. The auth middleware compares the JWT's `token_version` claim against the DB row on every request; a mismatch returns 401.

Four trigger paths cover the realistic scenarios:

1. **Admin force-revoke** — operator clicks "吊销令牌" on a user; that user's existing JWTs become immediately invalid.
2. **Password change** — when the password is reset (admin PUT or self-service, if added later), the JWT is invalidated alongside.
3. **Disable / delete account** — when `status` flips to 0 or the row is removed, the JWT is invalidated alongside.
4. **Role / permission change** — when `roleId` is changed, the JWT is invalidated alongside (the new permissions need a fresh login to take effect).

The `status` check piggybacks on the same per-request lookup that compares `token_version`, so a disabled account is rejected without an additional round-trip.

---

## Decisions (frozen, from brainstorming 2026-08-17)

| # | Decision | Choice |
|---|---|---|
| D1 | Per-request check | **Always `SELECT token_version, status FROM sys_users WHERE id = ?`** (PK lookup, <1 ms). Three failure paths map to distinct 401 messages. |
| D2 | Pre-migration JWT handling | **Missing `token_version` claim in JWT → treat as 0**. Combined with DB `DEFAULT 0` for fresh rows, old JWTs naturally match (0==0) until an operator bumps a user's `token_version` to 1. |
| D3 | Bump triggers | **All four** — admin force-revoke, password change, status change, role/permission change. Each is its own code path; they share the `bumpTokenVersion(userId, tx?)` helper. |
| D4 | Bump audit | **Admin force-revoke writes a separate `revoke_user_tokens` audit row** with old/new `token_version`. Other three paths piggyback on the existing `update_user` audit row (one row per PUT, not two). |
| D5 | Transactionality | **`bumpTokenVersion(userId, tx?)` accepts optional `tx`.** Callers that already use a transaction (e.g. `PUT /api/admin/users/:id` via the planned `updateUser(id, fields, tx?)` signature) bind the bump to that same tx. Atomicity guaranteed. |
| D6 | New admin endpoint | **`POST /api/admin/users/:id/revoke-tokens`** — single-purpose, returns `{ ok: true, tokenVersion: <new> }`. Same auth contract as the rest of `/api/admin/users` (`[userAuth, requirePerm('admin:users')]`). |
| D7 | Schema storage | **`sys_users.token_version INT NOT NULL DEFAULT 0`** — single additive column. |
| D8 | Dual-platform migration | **MySQL stored-procedure guard + MSSQL `sys.columns` guard**, both wrapping `ALTER TABLE ... ADD COLUMN`. Same idempotent pattern as `001-dc-site-discovery.sql`. |
| D9 | CAML_MAP | **`['token_version', 'tokenVersion']`** added to the snake→camel map in `center/src/routes/admin.js`, so `GET /api/admin/users` surfaces the new column. |
| D10 | Frontend | **No frontend change in this scope.** v2 follow-up: surface a "吊销" button on the user list and show `tokenVersion` per row. |

---

## Non-Goals (explicitly out of scope)

- **No agent-side token revocation.** Agents use a shared `appsettings.json` token, not JWTs. That's #170 I3 (`dual-key agent token rotation`), a separate task.
- **No JWT secret rotation.** I1 invalidates **per-user** tokens; rotating the signing key itself is #165 I9 (`dual-key JWT secret rotation`), orthogonal.
- **No frontend UI for force-revoke.** The endpoint exists; the operator calls it via API or waits for v2.
- **No automatic `token_version` increment on login.** Login shouldn't invalidate other concurrent sessions.
- **No caching layer for `token_version`.** Single-process assumption. The PK lookup is <1 ms; caching adds invalidation complexity for no measurable win.
- **No HTTPS / TLS detection.** Center is plain HTTP; nginx handles TLS externally (per `progress_2026_08_05_evening.md`).

---

## Architecture

### Components (new files)

```
db/migrations/015-user-token-version.sql                  ← MySQL: stored-procedure-guarded ADD COLUMN
db/migrations/mssql/015-user-token-version.sql            ← MSSQL: sys.columns-guarded ADD COLUMN
center/tests/user-token-version.test.js                   ← mock-DB unit tests (sign/verify/middleware/bump/4 paths)
center/tests/sql/015-user-token-version-mysql.test.js     ← Real-DB integration test (gated on TEST_MYSQL_URL)
center/tests/sql/015-user-token-version-mssql.test.js     ← Real-DB integration test (gated on TEST_MSSQL_URL)
```

### Components (modified)

```
center/src/auth/jwt.js                          ← signJwt({..., tokenVersion}) writes claim;
                                                   verifyJwt returns tokenVersion (default 0 on missing claim)
center/src/auth/user-auth.js                    ← post-JWT-verify middleware:
                                                   SELECT token_version, status FROM sys_users WHERE id = ?
                                                   3 distinct 401 paths (not found / disabled / version mismatch)
center/src/services/users.js                    ← + bumpTokenVersion(userId, tx?)
                                                   updateUser(id, fields, tx?) — when fields contains
                                                   password/status/roleId, bump in same tx
                                                   findByUsername returns user.tokenVersion (Number, default 0)
center/src/routes/auth.js                       ← POST /api/auth/login reads user.tokenVersion from
                                                   authenticate() and passes it to signJwt
center/src/routes/admin.js                      ← + POST /api/admin/users/:id/revoke-tokens
                                                   → bumpTokenVersion(userId) + writeAudit('revoke_user_tokens')
                                                   CAML_MAP: add ['token_version', 'tokenVersion']
                                                   PUT /api/admin/users/:id routes bump via updateUser
center/src/db/sql.js                            ← users.findByUsername (mysql + mssql) SELECTs token_version
                                                   users.bumpTokenVersion (new, mysql + mssql) UPDATE col = col + 1
                                                   users.revokeTokensAudit (new, mysql + mssql) optional helper
```

### Data flow

**Login (no change to existing endpoint)**
```
POST /api/auth/login
  → authenticate(username, password)            [users.js — unchanged signature, returns user with tokenVersion]
  → signJwt({ sub, role, permissions, tokenVersion: user.tokenVersion }, secret, 8h)
  → 200 { token, user }
```

**Steady-state auth (per request)**
```
GET /api/anything (Authorization: Bearer <jwt>)
  → userAuth({ secret })
    → verifyJwt(token) → { sub, role, permissions, tokenVersion }
    → db.query('SELECT token_version, status FROM sys_users WHERE id = ?', [sub])
       ├── no row         → 401 "user not found"
       ├── status !== 1   → 401 "user disabled"
       ├── token_version !== jwt.tokenVersion → 401 "token revoked"
       └── match          → req.user = { ...jwtClaims, tokenVersion, status }; next()
```

**Admin force-revoke (new endpoint)**
```
POST /api/admin/users/:id/revoke-tokens         [admin:users perm]
  → bumpTokenVersion(userId)                    [updates token_version = token_version + 1, returns new value]
  → writeAudit('revoke_user_tokens', target=String(userId),
                payload={ oldTokenVersion: prev, newTokenVersion: next })
  → 200 { ok: true, tokenVersion: <new> }
```

**PUT /api/admin/users/:id (extended)**
```
PUT /api/admin/users/:id  body: { password?, roleId?, status? }
  → updateUser(id, fields, tx?)                 [opens tx if not provided]
    if fields contains password/status/roleId:
      → bumpTokenVersion(userId, tx)
    → writeAudit('update_user', payload=req.body) [unchanged]
  → 200 { ok: true }
```

**DELETE /api/admin/users/:id (unchanged)**
```
DELETE /api/admin/users/:id
  → deleteUser(id)                              [row gone → SELECT returns no row → 401 next request]
  → writeAudit('delete_user')
  → 200 { ok: true }
```
The DELETE path doesn't call `bumpTokenVersion`. The per-request middleware catches the deleted row by `SELECT ... WHERE id = ?` returning empty, which already 401s. Saves a redundant UPDATE.

---

## Schema

### MySQL — `db/migrations/015-user-token-version.sql`

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

### MSSQL — `db/migrations/mssql/015-user-token-version.sql`

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

### Backend SQL strings (`center/src/db/sql.js`)

```js
// users.findByUsername — both dialects add token_version
mysql:  'SELECT id, username, password_hash, role_id, status, token_version FROM sys_users WHERE username = ?'
mssql:  'SELECT id, username, password_hash, role_id, status, token_version FROM sys_users WHERE username = @username'

// users.bumpTokenVersion — new, both dialects (ANSI UPDATE col = col + 1)
mysql:  'UPDATE sys_users SET token_version = token_version + 1 WHERE id = ?'
mssql:  'UPDATE sys_users SET token_version = token_version + 1 WHERE id = @id'

// userAuth middleware inline — both dialects
mysql:  'SELECT token_version, status FROM sys_users WHERE id = ?'
mssql:  'SELECT token_version, status FROM sys_users WHERE id = @id'
```

---

## Backend changes in detail

### `center/src/auth/jwt.js`

```js
export function signJwt({ sub, role, permissions, tokenVersion }, secret, ttlSec = 3600) {
  const payload = { role, permissions: permissions ?? [], tokenVersion: tokenVersion ?? 0 };
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

### `center/src/auth/user-auth.js`

```js
export function userAuth({ secret, db }) {
  return async (req, res, next) => {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/);
    if (!m) return res.status(401).json({ error: 'missing token' });
    const v = verifyJwt(m[1], secret);
    if (!v) return res.status(401).json({ error: 'invalid token' });
    const { rows } = await db.query('SELECT token_version, status FROM sys_users WHERE id = ?', [v.sub]);
    const row = rows[0];
    if (!row) return res.status(401).json({ error: 'user not found' });
    if (row.status !== 1) return res.status(401).json({ error: 'user disabled' });
    if (row.token_version !== v.tokenVersion) return res.status(401).json({ error: 'token revoked' });
    req.user = { ...v, status: row.status };
    next();
  };
}
```

`db` injection: every existing call site already passes `finalConfig` through a factory that has access to `db`. The current signature `userAuth({ secret })` becomes `userAuth({ secret, db })`; the change ripples to every call site that currently calls `userAuth({ secret: finalConfig.jwtSecret })`. From the 2026-08-17 grep these are: `center/server.js` (4 inline factories passed to `dcsRouter`, `lockoutRouter`, `schemaMigrationsRouter`, `heartbeatReportRouter`), `center/src/routes/admin.js:49`, `center/src/routes/dashboard.js:53`, `center/src/packages/orphan-router.js:23`, `center/src/routes/member-servers.js:62`, `center/src/packages/router.js:73` — 9 sites total, all mechanical `{ secret, db }` additions.

### `center/src/services/users.js`

```js
// New: bumpTokenVersion(userId, tx?)
export async function bumpTokenVersion(userId, tx = null) {
  const conn = tx ?? getDb();
  await conn.execute(conn.sql.users.bumpTokenVersion, [userId]);
  return conn.query('SELECT token_version FROM sys_users WHERE id = ?', [userId])
    .then(({ rows }) => Number(rows[0]?.token_version ?? 0));
}

// Extended: updateUser now takes optional tx and bumps when relevant fields change
export async function updateUser(id, { password, roleId, status }, tx = null) {
  const conn = tx ?? getDb();
  const passwordHash = password ? await bcrypt.hash(password, 12) : null;
  await conn.execute(conn.sql.users.update, [passwordHash, roleId ?? null, status ?? null, id]);
  if (password || roleId != null || status != null) {
    await bumpTokenVersion(id, conn);  // bind to the same conn/tx
  }
}
```

For routes that don't already have a tx (e.g. POST `/api/admin/users` create), they pass `null` and `bumpTokenVersion` uses the global db — but **creation doesn't bump** (no existing JWT to invalidate; the user just got created). The trigger conditions are explicitly: existing user + password/roleId/status change.

### `center/src/routes/admin.js`

```js
// Existing POST /api/admin/users (unchanged — create doesn't bump)
r.post('/api/admin/users', auth, async (req, res) => { /* ... unchanged ... */ });

// PUT /api/admin/users/:id — bump happens inside updateUser via tx-bound path
r.put('/api/admin/users/:id', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { password, roleId, status } = req.body || {};
    await updateUser(id, { password, roleId, status });   // bumps internally
    await writeAudit({ userId: req.user?.sub, action: 'update_user',
                       target: String(id), payload: req.body, logger });
    res.json({ ok: true });
  } catch (e) { /* ... unchanged error handler ... */ }
});

// New: POST /api/admin/users/:id/revoke-tokens
r.post('/api/admin/users/:id/revoke-tokens', auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const prev = await getTokenVersion(id);                  // SELECT before
    const next = await bumpTokenVersion(id);                 // UPDATE; commits
    await writeAudit({ userId: req.user?.sub, action: 'revoke_user_tokens',
                       target: String(id),
                       payload: { oldTokenVersion: prev, newTokenVersion: next },
                       logger });
    res.json({ ok: true, tokenVersion: next });
  } catch (e) {
    logger.error({ err: e }, 'admin user revoke-tokens failed');
    res.status(500).json({ error: 'internal' });
  }
});

// DELETE /api/admin/users/:id — unchanged (no bump; row removal is the signal)
```

`getTokenVersion(id)` is a small helper: `SELECT token_version FROM sys_users WHERE id = ?` returning a Number. Used only by the revoke-tokens endpoint to populate `oldTokenVersion` in the audit row.

CAML_MAP extended: add `['token_version', 'tokenVersion']` so `GET /api/admin/users` includes it.

### `center/src/routes/auth.js`

```js
r.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'missing credentials' });
  const user = await authenticate(username, password);   // now includes user.tokenVersion
  if (!user) { /* unchanged 401 + audit */ }
  await recordLogin(user.id);
  const token = signJwt({ sub: user.id, role: user.role_name, permissions: user.permissions,
                          tokenVersion: user.tokenVersion },
                        config.jwtSecret, 8 * 3600);
  await writeAudit({ userId: user.id, action: 'login', target: username, payload: null }, logger);
  res.json({ token, user: { id: user.id, username: user.username, role: user.role_name } });
});
```

`findByUsername` returns `user.tokenVersion` (Number, defaults to 0 if column missing for any reason — the migration makes this impossible, but the default keeps the code defensive).

---

## Testing strategy

### Unit tests — `center/tests/user-token-version.test.js` (mock DB)

- `signJwt` / `verifyJwt` round-trip with and without `tokenVersion` claim
- `verifyJwt` defaults missing claim to 0 (backward compat with old JWTs)
- `userAuth` returns 401 with `user not found` / `user disabled` / `token revoked` for each branch
- `userAuth` sets `req.user.tokenVersion` and `req.user.status` on success
- `bumpTokenVersion(userId)` increments by 1 and returns the new value
- `bumpTokenVersion(userId, txWrapper)` uses the wrapper, not the global db
- `updateUser(id, { password: 'x' })` calls `bumpTokenVersion` internally
- `updateUser(id, { status: 0 })` calls `bumpTokenVersion` internally
- `updateUser(id, { roleId: 2 })` calls `bumpTokenVersion` internally
- `updateUser(id, { status: undefined, roleId: undefined, password: undefined })` does NOT call `bumpTokenVersion`
- `POST /api/admin/users/:id/revoke-tokens` writes a `revoke_user_tokens` audit row with `oldTokenVersion` and `newTokenVersion`
- `PUT /api/admin/users/:id` with status=0 → middleware sees status=0 → 401 `user disabled` on next request (uses existing PUT test pattern, augmented)

### Real-DB integration tests

- `center/tests/sql/015-user-token-version-mysql.test.js` — gated on `TEST_MYSQL_URL`
  - Apply migration; verify column exists with DEFAULT 0
  - INSERT a user; SELECT token_version → 0
  - bumpTokenVersion via raw SQL; SELECT → 1
  - Apply migration twice → no-op
- `center/tests/sql/015-user-token-version-mssql.test.js` — gated on `TEST_MSSQL_URL`
  - Mirror of above for SQL Server

### No frontend test changes (frontend not touched)

---

## Migration rollout

1. Apply `015-user-token-version.sql` on both MySQL and MSSQL deployments. Existing user rows get `token_version = 0` automatically (DEFAULT).
2. Deploy new center binary. `verifyJwt` accepts JWTs with or without `tokenVersion` claim (defaults to 0).
3. No operator action required to keep existing sessions working.
4. To force-revoke a user: `POST /api/admin/users/:id/revoke-tokens` (or via UI later).

---

## Cross-references

- `progress_2026_08_07.md` — audit log redesign (I1 motivation: revoke admin sessions after suspected credential leak)
- `progress_2026_08_17.md` — Week 2 Task 1 (I2+I4+I7) shipped; I1 is the next item on the same roadmap
- `feedback_writeaudit_signature.md` — tx is the 3rd param; bumpTokenVersion inherits the same shape
- `feedback_mssql_migration_idempotency.md` — every ALTER guarded; this migration is no exception
- `feedback_mssql_error_precedingerrors.md` — relevant if migration apply fails
- `feedback_mssql_control_flow.md` — the migration uses no `IF/ELSE`, only `IF NOT EXISTS` BEGIN/END; safe for plain `request.query()`
- Task #168 in `TaskList` tracks execution after spec approval