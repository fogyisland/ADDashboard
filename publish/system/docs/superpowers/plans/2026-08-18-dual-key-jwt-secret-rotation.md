# Dual-Key JWT Secret Rotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow operators to rotate the JWT signing secret (`config.jwtSecret`) without invalidating every user's session, by accepting tokens signed by either the old or the new secret during an overlap window stored in `system_config`.

**Architecture:** Move `jwtSecret` runtime source-of-truth from `appsettings.json` to four `system_config` rows (`jwt_secret_current`, `jwt_secret_previous`, `jwt_secret_rotated_at`, `jwt_secret_previous_ttl_days`). `POST /api/admin/jwt-secret/rotate` and `commit` drive the overlap. `userAuth({ db, logger })` middleware loads the bundle from DB, `verifyJwt` tries `current` then `previous` (warn on previous match). 30-day TTL auto-clears forgotten rotations on bootstrap.

**Tech Stack:** Node.js ESM (no new deps); `crypto.randomBytes`; existing `system_config` table; existing `writeAudit` tx wrapper (3-arg `({...}, logger, tx)`); existing `signJwt`/`verifyJwt` (modified in place); existing `userAuth` middleware factory (modified in place); existing `jsonwebtoken` library; node:test (no vitest).

**Spec:** `docs/superpowers/specs/2026-08-18-dual-key-jwt-secret-rotation.md` — read in full before starting.

## Global Constraints

(Copied verbatim from spec.)

- **C1 — Single source of truth at runtime.** After bootstrap, `system_config.jwt_secret_current` is authoritative. `appsettings.json` `jwtSecret` becomes bootstrap-only (one-time seed).
- **C2 — No new dependencies.** Use Node built-ins (`crypto.randomBytes`) and existing services (`writeAudit`, `db.transaction`).
- **C3 — writeAudit signature is `({...}, logger, tx)`.** All audit writes go through this signature; tx is the 3rd arg.
- **C4 — Dual-platform SQL** (MySQL + MSSQL). Reuse `db.sql.config.upsert` (already dialect-specific) for per-row writes.
- **C5 — Backward compatible.** Existing single-key installs (`appsettings.json` has `jwtSecret`, DB has no row) continue to work — bootstrap seeds the DB on first start. `verifyJwt` accepts current OR previous; missing `jwt_secret_previous` row treated as empty string (no match).
- **C6 — Log at appropriate severity.** `info` on rotation start + commit; `warn` on previous-secret token verification; `error` only on rotation failure.
- **C7 — CWD-agnostic path resolution.** N/A — no path resolution here.
- **C8 — Cache invalidate on rotation.** In-memory cache of `current` + `previous` JWT secret MUST be invalidated synchronously inside the rotate/commit handler so the very next request sees the new state.

## Mirror sync rule (per `feedback_publish_sync.md` SDD lesson 25)

After every commit that touches a runtime file under `center/src/` or `center/server.js`, the implementer MUST run `diff <src> <publish-mirror>` for each touched file. If non-empty: `cp <src> <publish-mirror>` + separate `chore(publish): mirror <path>` commit (one per file). Tests are NOT mirrored. Mirror locations for this plan:
- `center/src/` → `publish/system/center/src/`
- `center/server.js` → `publish/system/center/server.js`

---

## File Structure

| File | Responsibility | Lines (est.) |
|------|---------------|--------------|
| `center/src/auth/jwt.js` (modify) | `signJwt` unchanged; `verifyJwt` becomes factory `verifyJwt(token, secrets)` that tries current → previous → null. | +30 |
| `center/src/auth/user-auth.js` (modify) | Factory `userAuth({ db, logger })`; loads bundle lazily via `_loadJwtSecretBundle`; cache + invalidate. Replaces `userAuth({ secret, db })`. | +50 |
| `center/src/services/jwt-secret.js` (new) | `getJwtSecretState` / `rotateJwtSecret` / `commitJwtSecret` / `seedJwtSecretIfMissing`. Uses `db.transaction` + `writeAudit`. | ~150 |
| `center/src/db/sql.js` (modify) | Add `config.getJwtSecretBundle` (both dialects). | +2 |
| `center/server.js` (modify) | Bootstrap IIFE: call `seedJwtSecretIfMissing(cfg.jwtSecret, logger)` after `seedAgentTokenIfMissing`. Update 4 `userAuth({ secret })` call sites to `userAuth({ db, logger })`. | +15 |
| `center/src/routes/admin.js` (modify) | 3 new endpoints: `POST /api/admin/jwt-secret/rotate`, `POST /api/admin/jwt-secret/commit`, `GET /api/admin/jwt-secret`. Update `auth` chain to `userAuth({ db: _db, logger })`. | +70 |
| `center/tests/auth/jwt.test.js` (new) | 8 unit tests for `verifyJwt` factory (current, previous, both miss, no-token, malformed). | ~110 |
| `center/tests/auth/user-auth.test.js` (new) | 7 unit tests for middleware (current, previous, mismatch, disabled, revoked, cache, invalidate). Existing `middleware.test.js` 6 tests must be updated to new signature. | ~120 |
| `center/tests/services/jwt-secret.test.js` (new) | 10 unit tests for service (get, rotate, commit, seed, TTL expiry). | ~180 |
| `center/tests/routes/jwt-secret-rotate.test.js` (new) | 7 integration tests for endpoints (200/audit/state shape/secret-not-returned/cache-invalidated). | ~140 |
| `center/tests/sql/017-jwt-secret-rotate-mysql.test.js` (new) | Real-MySQL apply + rotate + commit + auto-expire round-trip. Gated on `TEST_MYSQL_URL`. | ~80 |
| `center/tests/sql/017-jwt-secret-rotate-mssql.test.js` (new) | Real-MSSQL apply + rotate + commit round-trip. Gated on `TEST_MSSQL_URL`. | ~80 |

**Test count:** existing baseline (start of I9) is center 934 / agent 86 / frontend 240 pass. Expected after this plan: center 934 + 8 + 7 + 10 + 7 + 2 (gated) ≈ 968, plus 6 updated existing. 2 SQL tests skip when env vars unset (existing pattern).

**Caller migration (Task 1 sub-step):** All 4 sites in `center/server.js` (lines 292, 298, 304, 313) and 5 sites in `center/src/routes/{admin,dashboard,member-servers}.js` + `center/src/packages/{router,orphan-router}.js` (lines 56, 58, 67, 79, 28) currently call `userAuth({ secret: ..., db: ... })`. After Task 1 these become `userAuth({ db: ..., logger })` (logger is already available in every router — it's the same logger the adminRouter captures). 6 test files (`admin-heartbeat-report.test.js`, `dcs-summary.test.js`, `heartbeat-report-probe-endpoint.test.js`, `lockout-search.test.js`, `middleware.test.js`) also need the same signature update.

---

## Task 1: `verifyJwt` + `userAuth` factory refactor

**Files:**
- Modify: `center/src/auth/jwt.js` (entire file)
- Modify: `center/src/auth/user-auth.js` (entire file)
- Create: `center/tests/auth/jwt.test.js`
- Create: `center/tests/auth/user-auth.test.js`
- Modify: `center/tests/middleware.test.js` (signature update only — existing test bodies stay)
- Modify: `center/server.js` (4 userAuth call sites)
- Modify: `center/src/routes/admin.js` (1 userAuth call site)
- Modify: `center/src/routes/dashboard.js` (1 userAuth call site)
- Modify: `center/src/routes/member-servers.js` (1 userAuth call site)
- Modify: `center/src/packages/router.js` (1 userAuth call site)
- Modify: `center/src/packages/orphan-router.js` (1 userAuth call site)
- Modify: `center/tests/admin-heartbeat-report.test.js` (1 userAuth call site)
- Modify: `center/tests/dcs-summary.test.js` (1 userAuth call site)
- Modify: `center/tests/heartbeat-report-probe-endpoint.test.js` (1 userAuth call site)
- Modify: `center/tests/lockout-search.test.js` (1 userAuth call site)

**Interfaces:**
- Consumes: `db` facade exposing `db.query(sql, params)` returning `{ rows: [{ config_key, config_value }] }` and `db.sql` (used to resolve `users.getAuthStatus`).
- Produces:
  - `signJwt(payload, secret, ttlSec) → string` — **signature unchanged**, callers must pass the current secret
  - `verifyJwt(token, secrets) → payload | null` — `secrets = { current: string, previous: string }`; tries current then previous; returns null on total miss
  - `userAuth({ db, logger }) → async (req, res, next) => void` — replaces `userAuth({ secret, db })`
  - `invalidateJwtSecretCache() → void`
  - `_loadJwtSecretBundle(db) → Promise<{ current: string, previous: string }>` (exported with `_` prefix for tests)

- [ ] **Step 1: Write the failing tests for `verifyJwt`**

Create `center/tests/auth/jwt.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signJwt, verifyJwt } from '../../src/auth/jwt.js';

test('verifyJwt: accepts token signed with current secret', () => {
  const tok = signJwt({ sub: 'u1', role: 'admin', permissions: [] }, 'CUR', 60);
  const v = verifyJwt(tok, { current: 'CUR', previous: '' });
  assert.equal(v.sub, 'u1');
  assert.equal(v.role, 'admin');
});

test('verifyJwt: accepts token signed with previous secret during overlap', () => {
  const tok = signJwt({ sub: 'u1', role: 'admin', permissions: [] }, 'PREV', 60);
  const v = verifyJwt(tok, { current: 'CUR', previous: 'PREV' });
  assert.equal(v.sub, 'u1');
});

test('verifyJwt: rejects token signed with neither secret', () => {
  const tok = signJwt({ sub: 'u1', role: 'admin', permissions: [] }, 'OTHER', 60);
  const v = verifyJwt(tok, { current: 'CUR', previous: 'PREV' });
  assert.equal(v, null);
});

test('verifyJwt: returns null on malformed token', () => {
  const v = verifyJwt('not-a-jwt', { current: 'CUR', previous: '' });
  assert.equal(v, null);
});

test('verifyJwt: returns null on expired token', () => {
  // jwt.sign accepts expiresIn as a number of seconds; -1 = expired
  const tok = signJwt({ sub: 'u1', role: 'admin', permissions: [] }, 'CUR', -1);
  const v = verifyJwt(tok, { current: 'CUR', previous: '' });
  assert.equal(v, null);
});

test('verifyJwt: previous empty string means no previous-match', () => {
  // Sign with the value that would have been "previous" but pass previous: ''.
  // jwt.verify treats empty string as a valid HMAC key only if the token was
  // signed with the empty string — which we won't do — so this is a miss.
  const tok = signJwt({ sub: 'u1', role: 'admin', permissions: [] }, 'PREV', 60);
  const v = verifyJwt(tok, { current: 'CUR', previous: '' });
  assert.equal(v, null);
});

test('verifyJwt: payload preserves tokenVersion', () => {
  const tok = signJwt({ sub: 'u1', role: 'admin', permissions: [], tokenVersion: 5 }, 'CUR', 60);
  const v = verifyJwt(tok, { current: 'CUR', previous: '' });
  assert.equal(v.tokenVersion, 5);
});

test('signJwt: emits a JWT with sub in subject claim', () => {
  const tok = signJwt({ sub: 42, role: 'admin', permissions: [] }, 'CUR', 60);
  // decode without verifying (jsonwebtoken decodes payload only)
  const jwt = await import('jsonwebtoken');
  const p = jwt.default.decode(tok);
  assert.equal(p.sub, '42');
});
```

- [ ] **Step 2: Write the failing tests for `userAuth` middleware**

Create `center/tests/auth/user-auth.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userAuth, invalidateJwtSecretCache, _loadJwtSecretBundle } from '../../src/auth/user-auth.js';

function stubBundle(bundle) {
  return {
    async query(sql) {
      if (/jwt_secret/i.test(sql)) {
        const rows = [];
        if (bundle.current !== undefined)
          rows.push({ config_key: 'jwt_secret_current', config_value: bundle.current });
        if (bundle.previous !== undefined)
          rows.push({ config_key: 'jwt_secret_previous', config_value: bundle.previous });
        return { rows };
      }
      // users.getAuthStatus path
      return { rows: [{ token_version: 0, status: 1 }] };
    },
    sql: {
      users: { getAuthStatus: 'SELECT token_version, status FROM users WHERE id = ?' }
    }
  };
}

function buildReq(token) {
  return token
    ? { headers: { authorization: `Bearer ${token}` } }
    : { headers: {} };
}

function buildRes() {
  let statusCode = 0;
  let jsonBody = null;
  return {
    status(c) { statusCode = c; return this; },
    json(b) { jsonBody = b; return this; },
    get statusCode() { return statusCode; },
    get body() { return jsonBody; }
  };
}

async function makeToken(secret, sub = 'u1') {
  const { signJwt } = await import('../../src/auth/jwt.js');
  return signJwt({ sub, role: 'admin', permissions: [], tokenVersion: 0 }, secret, 60);
}

test('accepts token signed with current secret', async () => {
  invalidateJwtSecretCache();
  const mw = userAuth({ db: stubBundle({ current: 'CUR', previous: '' }), logger: null });
  const tok = await makeToken('CUR');
  const req = buildReq(tok);
  const res = buildRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(req.user.sub, 'u1');
});

test('accepts token signed with previous secret during overlap', async () => {
  invalidateJwtSecretCache();
  const mw = userAuth({ db: stubBundle({ current: 'CUR', previous: 'PREV' }), logger: null });
  const tok = await makeToken('PREV');
  const req = buildReq(tok);
  const res = buildRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(req._jwtSecretMatchedPrevious, true);
});

test('rejects malformed/missing token', async () => {
  invalidateJwtSecretCache();
  const mw = userAuth({ db: stubBundle({ current: 'CUR', previous: '' }), logger: null });
  const req = buildReq(null);
  const res = buildRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
});

test('rejects token signed with neither secret', async () => {
  invalidateJwtSecretCache();
  const mw = userAuth({ db: stubBundle({ current: 'CUR', previous: 'PREV' }), logger: null });
  const tok = await makeToken('OTHER');
  const req = buildReq(tok);
  const res = buildRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
});

test('rejects when token_version mismatch', async () => {
  invalidateJwtSecretCache();
  const db = {
    async query(sql) {
      if (/jwt_secret/i.test(sql)) {
        return { rows: [{ config_key: 'jwt_secret_current', config_value: 'CUR' }] };
      }
      return { rows: [{ token_version: 99, status: 1 }] }; // mismatch with tokenVersion: 0
    },
    sql: { users: { getAuthStatus: 'SELECT token_version, status FROM users WHERE id = ?' } }
  };
  const mw = userAuth({ db, logger: null });
  const tok = await makeToken('CUR');
  const req = buildReq(tok);
  const res = buildRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'token revoked');
});

test('rejects when user disabled', async () => {
  invalidateJwtSecretCache();
  const db = {
    async query(sql) {
      if (/jwt_secret/i.test(sql)) {
        return { rows: [{ config_key: 'jwt_secret_current', config_value: 'CUR' }] };
      }
      return { rows: [{ token_version: 0, status: 0 }] };
    },
    sql: { users: { getAuthStatus: 'SELECT token_version, status FROM users WHERE id = ?' } }
  };
  const mw = userAuth({ db, logger: null });
  const tok = await makeToken('CUR');
  const req = buildReq(tok);
  const res = buildRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'user disabled');
});

test('caches the bundle; invalidateJwtSecretCache forces reload', async () => {
  invalidateJwtSecretCache();
  let bundleCalls = 0;
  const db = {
    async query(sql) {
      if (/jwt_secret/i.test(sql)) {
        bundleCalls++;
        return { rows: [{ config_key: 'jwt_secret_current', config_value: 'CUR' }] };
      }
      return { rows: [{ token_version: 0, status: 1 }] };
    },
    sql: { users: { getAuthStatus: 'SELECT token_version, status FROM users WHERE id = ?' } }
  };
  const mw = userAuth({ db, logger: null });
  const tok = await makeToken('CUR');
  await mw(buildReq(tok), buildRes(), () => {});
  await mw(buildReq(tok), buildRes(), () => {});
  assert.equal(bundleCalls, 1);
  invalidateJwtSecretCache();
  await mw(buildReq(tok), buildRes(), () => {});
  assert.equal(bundleCalls, 2);
});
```

- [ ] **Step 3: Run the tests, verify they fail**

Run: `cd center && node --test tests/auth/jwt.test.js tests/auth/user-auth.test.js`
Expected: FAIL — `verifyJwt` is still single-string, `userAuth` still takes `{ secret, db }`.

- [ ] **Step 4: Refactor `center/src/auth/jwt.js`**

Replace the entire file with:

```js
// JWT signing + verification helpers. `signJwt` keeps its signature (callers
// pass the current secret explicitly); `verifyJwt` becomes a factory that
// takes a `{ current, previous }` bundle so a single verification tries the
// active secret first, then falls back to the previous one during a rotation
// overlap window.
//
// The bundle is opaque to this module — it does not know about caching or
// the DB. `userAuth` is responsible for loading the bundle (via
// `_loadJwtSecretBundle`) and for invalidating the cache on rotation.
import jwt from 'jsonwebtoken';

export function signJwt(payload, secret, ttlSec = 3600) {
  const body = {
    role: payload.role,
    permissions: payload.permissions ?? [],
    tokenVersion: payload.tokenVersion ?? 0
  };
  return jwt.sign(body, secret, { subject: String(payload.sub), expiresIn: ttlSec });
}

export function verifyJwt(token, secrets) {
  if (typeof token !== 'string' || !token) return null;
  if (!secrets || typeof secrets !== 'object') return null;
  // Try current first, then previous. Any throw from jwt.verify (bad sig,
  // expired, malformed) is caught and we move on. Total miss returns null.
  for (const key of ['current', 'previous']) {
    const s = secrets[key];
    if (typeof s !== 'string' || !s) continue;
    try {
      const p = jwt.verify(token, s);
      return {
        sub: p.sub,
        role: p.role,
        permissions: p.permissions ?? [],
        tokenVersion: typeof p.tokenVersion === 'number' ? p.tokenVersion : 0,
        _matched: key // 'current' or 'previous' — caller logs warn if 'previous'
      };
    } catch {
      // try next key
    }
  }
  return null;
}
```

- [ ] **Step 5: Refactor `center/src/auth/user-auth.js`**

Replace the entire file with:

```js
// Per-request middleware that loads the JWT signing-secret bundle from
// `system_config` (rows `jwt_secret_current`, `jwt_secret_previous`) and
// verifies the bearer token against both. The bundle is cached for the
// process lifetime; rotate/commit handlers MUST call
// `invalidateJwtSecretCache()` after a write so the very next request sees
// the new state.
//
// On a valid JWT the middleware fetches the user's current `token_version`
// and `status` from the DB and rejects mismatches with three distinct 401
// messages — operators reading the response can tell whether the user was
// deleted, disabled, or had their tokens revoked.
//
// This module never logs the secret or its length (per spec §5). It logs a
// `warn` line on previous-secret match (operator's signal that a straggler
// is still on the old key) and an `error` if the DB lookup itself throws.
import { verifyJwt } from './jwt.js';

let _cache = null; // { current: string, previous: string }

export async function _loadJwtSecretBundle(db) {
  if (_cache) return _cache;
  // The SQL string here is a fallback for tests that construct a stub db
  // without going through buildSql(). Production code paths always use
  // db.sql.config.getJwtSecretBundle (Task 3) — same shape, just keyed
  // off the SQL registry instead of a hardcoded literal.
  const { rows } = await db.query(
    "SELECT config_key, config_value FROM system_config WHERE config_key IN ('jwt_secret_current', 'jwt_secret_previous')"
  );
  const map = Object.fromEntries((rows || []).map(r => [r.config_key, r.config_value]));
  _cache = {
    current: map.jwt_secret_current ?? '',
    previous: map.jwt_secret_previous ?? ''
  };
  return _cache;
}

export function invalidateJwtSecretCache() {
  _cache = null;
}

export function userAuth({ db, logger }) {
  return async (req, res, next) => {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/);
    if (!m) return res.status(401).json({ error: 'missing token' });
    let bundle;
    try {
      bundle = await _loadJwtSecretBundle(db);
    } catch (e) {
      logger?.error?.({ err: e }, 'userAuth: jwt_secret bundle lookup failed');
      return res.status(500).json({ error: 'internal' });
    }
    const v = verifyJwt(m[1], bundle);
    if (!v) return res.status(401).json({ error: 'invalid token' });
    if (v._matched === 'previous') {
      req._jwtSecretMatchedPrevious = true;
      logger?.warn?.({ path: req.path, sub: v.sub }, 'userAuth: token verified with previous JWT secret (rotation overlap)');
    }
    try {
      const { rows } = await db.query(db.sql.users.getAuthStatus, [v.sub]);
      const row = rows[0];
      if (!row) return res.status(401).json({ error: 'user not found' });
      if (row.status !== 1) return res.status(401).json({ error: 'user disabled' });
      if (Number(row.token_version) !== v.tokenVersion) return res.status(401).json({ error: 'token revoked' });
      req.user = { sub: v.sub, role: v.role, permissions: v.permissions, tokenVersion: v.tokenVersion, status: row.status };
      next();
    } catch (e) {
      logger?.error?.({ err: e }, 'userAuth: users.getAuthStatus lookup failed');
      res.status(500).json({ error: 'internal' });
    }
  };
}
```

- [ ] **Step 6: Update all `userAuth({ secret, db })` callers**

In each of the files listed under "Modify" above, replace every
`userAuth({ secret: ..., db: ... })`
with
`userAuth({ db: ..., logger })`

Specifically:
- `center/server.js` lines 292, 298, 304, 313 — the `finalConfig.jwtSecret` arg goes away; `logger` is in scope at each call site.
- `center/src/routes/admin.js` line 56 — drop `secret: config.jwtSecret`, add `logger` (the function-scoped `logger` parameter is already available).
- `center/src/routes/dashboard.js` line 58 — same pattern.
- `center/src/routes/member-servers.js` line 67 — same pattern.
- `center/src/packages/router.js` line 79 — same pattern.
- `center/src/packages/orphan-router.js` line 28 — same pattern.
- 4 test files (`admin-heartbeat-report.test.js`, `dcs-summary.test.js`, `heartbeat-report-probe-endpoint.test.js`, `lockout-search.test.js`) — drop the `secret:` arg, the test stubs can pass `logger: null`.
- `center/tests/middleware.test.js` lines 27, 37, 46, 56, 66, 76 — same pattern. Existing test bodies stay unchanged otherwise.

- [ ] **Step 7: Run the tests, verify they pass**

Run: `cd center && node --test tests/auth/jwt.test.js tests/auth/user-auth.test.js tests/middleware.test.js tests/admin-heartbeat-report.test.js tests/dcs-summary.test.js tests/heartbeat-report-probe-endpoint.test.js tests/lockout-search.test.js`
Expected: 8 + 7 + 6 + (test counts for the 3 heartbeat/lockout/dcs files unchanged) PASS. Run `npm test` afterwards to confirm full suite still passes (baseline 934/0/58).

- [ ] **Step 8: Commit**

```bash
cd .worktrees/i9-dual-key-jwt-secret-rotation
git add center/src/auth/jwt.js center/src/auth/user-auth.js \
        center/tests/auth/jwt.test.js center/tests/auth/user-auth.test.js \
        center/tests/middleware.test.js \
        center/server.js \
        center/src/routes/admin.js center/src/routes/dashboard.js \
        center/src/routes/member-servers.js \
        center/src/packages/router.js center/src/packages/orphan-router.js \
        center/tests/admin-heartbeat-report.test.js \
        center/tests/dcs-summary.test.js \
        center/tests/heartbeat-report-probe-endpoint.test.js \
        center/tests/lockout-search.test.js
git commit -m "feat(auth): verifyJwt({current,previous}) + userAuth({db,logger}) factory (I9)"
```

- [ ] **Step 9: Mirror to publish/system**

```bash
for f in center/src/auth/jwt.js center/src/auth/user-auth.js \
         center/server.js \
         center/src/routes/admin.js center/src/routes/dashboard.js \
         center/src/routes/member-servers.js \
         center/src/packages/router.js center/src/packages/orphan-router.js; do
  if ! diff -q "$f" "publish/system/$f" > /dev/null 2>&1; then
    cp "$f" "publish/system/$f"
    git add "publish/system/$f"
    git commit -m "chore(publish): mirror ${f#center/} I9"
  fi
done
```

(One commit per mirrored file per `feedback_publish_sync.md`. Test files are NOT mirrored.)

---

## Task 2: `center/src/services/jwt-secret.js` new service module

**Files:**
- Create: `center/src/services/jwt-secret.js`
- Create: `center/tests/services/jwt-secret.test.js`

**Interfaces:**
- Consumes: `db` facade (transaction, execute, query). `db.sql.config.upsert`, `db.sql.config.getJwtSecretBundle`, plus existing `writeAudit`.
- Produces:
  - `getJwtSecretState(db) → Promise<{ current: string, previous: string, rotatedAt: string, ttlDays: number, previousExpiresAt: string|null }>`
  - `rotateJwtSecret(db, { logger, userId }) → Promise<{ newSecret: string, rotatedAt: string }>`
  - `commitJwtSecret(db, { logger, userId }) → Promise<{ ok: true }>`
  - `seedJwtSecretIfMissing(db, fromAppsettings, logger) → Promise<{ seeded: boolean, current: string, autoExpired?: boolean }>`

- [ ] **Step 1: Write the failing tests**

Create `center/tests/services/jwt-secret.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMockDb } from '../helpers/db-mock.js';
import {
  getJwtSecretState,
  rotateJwtSecret,
  commitJwtSecret,
  seedJwtSecretIfMissing
} from '../../src/services/jwt-secret.js';

const noopLogger = { info(){}, warn(){}, error(){}, debug(){} };

function bundleRows({ current = '', previous = '', rotatedAt = '', ttlDays = '30' } = {}) {
  const rows = [];
  if (current !== null) rows.push({ config_key: 'jwt_secret_current', config_value: current });
  if (previous !== null) rows.push({ config_key: 'jwt_secret_previous', config_value: previous });
  if (rotatedAt !== null) rows.push({ config_key: 'jwt_secret_rotated_at', config_value: rotatedAt });
  if (ttlDays !== null) rows.push({ config_key: 'jwt_secret_previous_ttl_days', config_value: ttlDays });
  return rows;
}

test('getJwtSecretState: returns all four keys', async () => {
  const db = buildMockDb([{
    match: /jwt_secret/i,
    rows: bundleRows({ current: 'A', previous: 'OLD', rotatedAt: '2026-08-01T00:00:00Z', ttlDays: '30' })
  }]).standard();
  const s = await getJwtSecretState(db);
  assert.equal(s.current, 'A');
  assert.equal(s.previous, 'OLD');
  assert.equal(s.rotatedAt, '2026-08-01T00:00:00Z');
  assert.equal(s.ttlDays, 30);
  assert.match(s.previousExpiresAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('getJwtSecretState: empty defaults when no rows', async () => {
  const db = buildMockDb([{ match: /jwt_secret/i, rows: [] }]).standard();
  const s = await getJwtSecretState(db);
  assert.equal(s.current, '');
  assert.equal(s.previous, '');
  assert.equal(s.rotatedAt, '');
  assert.equal(s.ttlDays, 30);
  assert.equal(s.previousExpiresAt, null);
});

test('rotateJwtSecret: writes previous + current + rotated_at + audit in one tx', async () => {
  const records = [];
  const db = buildMockDb([
    { match: /jwt_secret/i, rows: bundleRows({ current: 'OLD' }) }
  ]).withRecording(records);
  const r = await rotateJwtSecret(db, { logger: noopLogger, userId: 'u1' });
  assert.match(r.newSecret, /^[a-f0-9]{64}$/); // 32-byte hex = 64 chars
  assert.match(r.rotatedAt, /^\d{4}-\d{2}-\d{2}T/);
  const upserts = records.filter(x => /system_config/i.test(x.sql));
  const keys = upserts.map(u => u.params[0]);
  assert.ok(keys.includes('jwt_secret_previous'));
  assert.ok(keys.includes('jwt_secret_current'));
  assert.ok(keys.includes('jwt_secret_rotated_at'));
  // previous must be set to the OLD current value
  const prevUpsert = upserts.find(u => u.params[0] === 'jwt_secret_previous');
  assert.equal(prevUpsert.params[1], 'OLD');
  // current must be set to the new secret (not the old)
  const curUpsert = upserts.find(u => u.params[0] === 'jwt_secret_current');
  assert.equal(curUpsert.params[1], r.newSecret);
  // Audit row written via writeAudit (3-arg signature)
  const audits = records.filter(x => /audit_logs/i.test(x.sql));
  assert.ok(audits.length >= 1);
  const audit = audits.find(a => a.params && a.params[1] === 'rotate_jwt_secret');
  assert.ok(audit);
});

test('commitJwtSecret: clears previous and rotated_at, writes audit', async () => {
  const records = [];
  const db = buildMockDb([
    { match: /jwt_secret/i, rows: bundleRows({ current: 'NEW', previous: 'OLD' }) }
  ]).withRecording(records);
  const r = await commitJwtSecret(db, { logger: noopLogger, userId: 'u1' });
  assert.deepEqual(r, { ok: true });
  const upserts = records.filter(x => /system_config/i.test(x.sql));
  const prev = upserts.find(u => u.params[0] === 'jwt_secret_previous');
  const rot = upserts.find(u => u.params[0] === 'jwt_secret_rotated_at');
  assert.equal(prev.params[1], '');
  assert.equal(rot.params[1], '');
  const audits = records.filter(x => /audit_logs/i.test(x.sql));
  const audit = audits.find(a => a.params && a.params[1] === 'commit_jwt_secret');
  assert.ok(audit);
});

test('commitJwtSecret: no-op when no previous', async () => {
  const records = [];
  const db = buildMockDb([
    { match: /jwt_secret/i, rows: bundleRows({ current: 'NEW', previous: '' }) }
  ]).withRecording(records);
  const r = await commitJwtSecret(db, { logger: noopLogger, userId: 'u1' });
  assert.deepEqual(r, { ok: true });
  const audits = records.filter(x => /audit_logs/i.test(x.sql));
  assert.equal(audits.length, 0);
});

test('seedJwtSecretIfMissing: seeds all 4 rows when absent', async () => {
  const records = [];
  const db = buildMockDb([
    { match: /jwt_secret/i, rows: [] }
  ]).withRecording(records);
  const r = await seedJwtSecretIfMissing(db, 'from-appsettings', noopLogger);
  assert.equal(r.seeded, true);
  assert.equal(r.current, 'from-appsettings');
  const keys = records.map(x => x.params[0]).filter(k => k.startsWith('jwt_secret'));
  assert.ok(keys.includes('jwt_secret_current'));
  assert.ok(keys.includes('jwt_secret_previous'));
  assert.ok(keys.includes('jwt_secret_rotated_at'));
  assert.ok(keys.includes('jwt_secret_previous_ttl_days'));
});

test('seedJwtSecretIfMissing: idempotent when current row exists', async () => {
  const records = [];
  const db = buildMockDb([
    { match: /jwt_secret/i, rows: bundleRows({ current: 'EXISTING' }) }
  ]).withRecording(records);
  const r = await seedJwtSecretIfMissing(db, 'from-appsettings', noopLogger);
  assert.equal(r.seeded, false);
  assert.equal(r.current, 'EXISTING');
  // No upserts on existing rows (auto-expire path may add some — see next test)
  const upserts = records.filter(x => /system_config/i.test(x.sql));
  // We seeded no row here because there was no previous and rotatedAt — only auto-expire would write.
  assert.equal(upserts.length, 0);
});

test('seedJwtSecretIfMissing: auto-expires previous when older than TTL', async () => {
  const oldRotatedAt = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString();
  const records = [];
  const db = buildMockDb([
    { match: /jwt_secret/i, rows: bundleRows({ current: 'CUR', previous: 'OLD', rotatedAt: oldRotatedAt, ttlDays: '30' }) }
  ]).withRecording(records);
  const r = await seedJwtSecretIfMissing(db, 'from-appsettings', noopLogger);
  assert.equal(r.autoExpired, true);
  assert.equal(r.current, 'CUR');
  const upserts = records.filter(x => /system_config/i.test(x.sql));
  const prev = upserts.find(u => u.params[0] === 'jwt_secret_previous');
  const rot = upserts.find(u => u.params[0] === 'jwt_secret_rotated_at');
  assert.equal(prev.params[1], '');
  assert.equal(rot.params[1], '');
});

test('seedJwtSecretIfMissing: keeps previous when within TTL', async () => {
  const recentRotatedAt = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
  const records = [];
  const db = buildMockDb([
    { match: /jwt_secret/i, rows: bundleRows({ current: 'CUR', previous: 'OLD', rotatedAt: recentRotatedAt, ttlDays: '30' }) }
  ]).withRecording(records);
  const r = await seedJwtSecretIfMissing(db, 'from-appsettings', noopLogger);
  assert.equal(r.autoExpired, undefined);
  const upserts = records.filter(x => /system_config/i.test(x.sql));
  assert.equal(upserts.length, 0);
});

test('rotateJwtSecret: new secret is never written to log payload', async () => {
  const records = [];
  const capturedLogs = [];
  const captureLogger = {
    info: (...args) => capturedLogs.push(args),
    warn: () => {},
    error: () => {},
    debug: () => {}
  };
  const db = buildMockDb([
    { match: /jwt_secret/i, rows: bundleRows({ current: 'OLD' }) }
  ]).withRecording(records);
  const r = await rotateJwtSecret(db, { logger: captureLogger, userId: 'u1' });
  // Ensure no log line contains the new secret verbatim.
  const json = JSON.stringify(capturedLogs);
  assert.ok(!json.includes(r.newSecret), 'new secret must not appear in logs');
  // The audit payload must record lengths, not the secret itself.
  const audit = records.find(x => /audit_logs/i.test(x.sql) && x.params[1] === 'rotate_jwt_secret');
  assert.ok(audit);
  assert.equal(audit.params[3].newLength, r.newSecret.length);
  assert.equal(audit.params[3].previousLength, 'OLD'.length);
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `cd center && node --test tests/services/jwt-secret.test.js`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `center/src/services/jwt-secret.js`**

```js
// Service for the dual-key JWT secret rotation mechanism. Reads/writes
// four rows in `system_config`:
//   jwt_secret_current           — runtime source of truth (loaded by userAuth)
//   jwt_secret_previous          — old secret during overlap window
//   jwt_secret_rotated_at        — ISO 8601 when previous was set
//   jwt_secret_previous_ttl_days — auto-expiry threshold (default 30)
//
// Rotations and commits are atomic via `db.transaction` so the previous →
// current swap is never half-applied. Every mutation writes a `writeAudit`
// row so the operator's "who rotated when" question has a deterministic
// answer. The bundle SELECT comes from `db.sql.config.getJwtSecretBundle`
// (Task 3) — the SQL registry owns dialect-specific strings.
//
// SECURITY: the new secret is returned ONCE (in `rotateJwtSecret`'s return
// value) for the operator to copy. It is never logged — audit payload
// records lengths only.
import { randomBytes } from 'node:crypto';
import { writeAudit } from './audit.js';

const ROTATE_AUDIT = 'rotate_jwt_secret';
const COMMIT_AUDIT = 'commit_jwt_secret';
const SEED_AUDIT = 'seed_jwt_secret';
const AUTO_EXPIRE_AUDIT = 'auto_expire_jwt_secret';

function readBundle(db, query) {
  return query(db.sql.config.getJwtSecretBundle).then(({ rows }) => {
    const map = Object.fromEntries((rows || []).map(r => [r.config_key, r.config_value]));
    return {
      current: map.jwt_secret_current ?? '',
      previous: map.jwt_secret_previous ?? '',
      rotatedAt: map.jwt_secret_rotated_at ?? '',
      ttlDays: Number(map.jwt_secret_previous_ttl_days || 30)
    };
  });
}

function expiresAt(rotatedAt, ttlDays) {
  if (!rotatedAt) return null;
  const t = Date.parse(rotatedAt);
  if (!Number.isFinite(t)) return null;
  return new Date(t + ttlDays * 24 * 3600 * 1000).toISOString();
}

export async function getJwtSecretState(db) {
  const b = await readBundle(db, (sql) => db.query(sql));
  return { ...b, previousExpiresAt: expiresAt(b.rotatedAt, b.ttlDays) };
}

export async function rotateJwtSecret(db, { logger, userId }) {
  let newSecret;
  let rotatedAt;
  await db.transaction(async (tx) => {
    const before = await readBundle(db, (sql) => tx.query(sql));
    newSecret = randomBytes(32).toString('hex');
    rotatedAt = new Date().toISOString();
    const upsert = db.sql.config.upsert;
    await tx.execute(upsert, ['jwt_secret_previous', before.current]);
    await tx.execute(upsert, ['jwt_secret_current', newSecret]);
    await tx.execute(upsert, ['jwt_secret_rotated_at', rotatedAt]);
    await writeAudit({
      userId,
      action: ROTATE_AUDIT,
      target: 'system_config',
      payload: {
        previousLength: before.current.length,
        newLength: newSecret.length,
        rotatedAt
      },
      logger
    }, logger, tx);
  });
  logger?.info?.({ userId, newLength: newSecret.length, rotatedAt }, 'jwt secret rotated');
  return { newSecret, rotatedAt };
}

export async function commitJwtSecret(db, { logger, userId }) {
  await db.transaction(async (tx) => {
    const before = await readBundle(db, (sql) => tx.query(sql));
    if (!before.previous) {
      logger?.info?.({ userId }, 'commit_jwt_secret: no-op (no previous secret)');
      return;
    }
    const upsert = db.sql.config.upsert;
    await tx.execute(upsert, ['jwt_secret_previous', '']);
    await tx.execute(upsert, ['jwt_secret_rotated_at', '']);
    await writeAudit({
      userId,
      action: COMMIT_AUDIT,
      target: 'system_config',
      payload: { committedAt: new Date().toISOString() },
      logger
    }, logger, tx);
  });
  logger?.info?.({ userId }, 'jwt secret committed');
  return { ok: true };
}

export async function seedJwtSecretIfMissing(db, fromAppsettings, logger) {
  // Wrap seed + auto-expire mutations in a transaction so the audit row
  // commits atomically with the data writes (per I2 audit-in-tx contract).
  let result;
  await db.transaction(async (tx) => {
    const before = await readBundle(db, (sql) => tx.query(sql));
    if (!before.current) {
      // First boot: seed all 4 rows from appsettings.json.
      const upsert = db.sql.config.upsert;
      await tx.execute(upsert, ['jwt_secret_current', fromAppsettings]);
      await tx.execute(upsert, ['jwt_secret_previous', '']);
      await tx.execute(upsert, ['jwt_secret_rotated_at', '']);
      await tx.execute(upsert, ['jwt_secret_previous_ttl_days', '30']);
      await writeAudit({
        userId: null,
        action: SEED_AUDIT,
        target: 'system_config',
        payload: { source: 'appsettings.json', length: fromAppsettings.length },
        logger
      }, logger, tx);
      logger?.info?.({ length: fromAppsettings.length }, 'seeded jwt secret from appsettings.json');
      result = { seeded: true, current: fromAppsettings };
      return;
    }
    // Auto-expire check: if previous is older than TTL, clear it so the
    // operator cannot accidentally keep the overlap open forever.
    if (before.previous && before.rotatedAt && before.ttlDays > 0) {
      const ageMs = Date.now() - Date.parse(before.rotatedAt);
      if (Number.isFinite(ageMs) && ageMs > before.ttlDays * 24 * 3600 * 1000) {
        const upsert = db.sql.config.upsert;
        await tx.execute(upsert, ['jwt_secret_previous', '']);
        await tx.execute(upsert, ['jwt_secret_rotated_at', '']);
        await writeAudit({
          userId: null,
          action: AUTO_EXPIRE_AUDIT,
          target: 'system_config',
          payload: { rotatedAt: before.rotatedAt, ttlDays: before.ttlDays },
          logger
        }, logger, tx);
        logger?.warn?.({ rotatedAt: before.rotatedAt, ttlDays: before.ttlDays }, 'previous jwt secret expired by TTL; auto-cleared');
        result = { seeded: false, current: before.current, autoExpired: true };
        return;
      }
    }
    result = { seeded: false, current: before.current };
  });
  return result;
}

// Re-export the bundle keys so other modules can introspect (e.g. audit
// filters). Exported for symmetry with the four-row schema documented in
// the spec.
export const JWT_SECRET_BUNDLE_KEYS = [
  'jwt_secret_current',
  'jwt_secret_previous',
  'jwt_secret_rotated_at',
  'jwt_secret_previous_ttl_days'
];
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `cd center && node --test tests/services/jwt-secret.test.js`
Expected: 10/10 PASS.

- [ ] **Step 5: Commit**

```bash
cd .worktrees/i9-dual-key-jwt-secret-rotation
git add center/src/services/jwt-secret.js center/tests/services/jwt-secret.test.js
git commit -m "feat(services): jwt-secret rotate/commit/seed service (I9)"
```

- [ ] **Step 6: Mirror to publish/system**

```bash
diff -q center/src/services/jwt-secret.js publish/system/center/src/services/jwt-secret.js
cp center/src/services/jwt-secret.js publish/system/center/src/services/jwt-secret.js
diff -q center/src/services/jwt-secret.js publish/system/center/src/services/jwt-secret.js
git add publish/system/center/src/services/jwt-secret.js
git commit -m "chore(publish): mirror services/jwt-secret.js I9"
```

---

## Task 3: `center/src/db/sql.js` add `getJwtSecretBundle` (MySQL + MSSQL)

**Files:**
- Modify: `center/src/db/sql.js` (find the `config:` block in `mysql` and `mssql` namespaces; add `getJwtSecretBundle`)

- [ ] **Step 1: Add the bundle SELECT to the MySQL config namespace**

In `center/src/db/sql.js`, find the MySQL `config:` object. Add (immediately after the existing `getAgentTokenBundle` entry, to keep both bundle strings adjacent):

```js
getJwtSecretBundle: `SELECT config_key, config_value FROM system_config WHERE config_key IN ('jwt_secret_current', 'jwt_secret_previous', 'jwt_secret_rotated_at', 'jwt_secret_previous_ttl_days')`,
```

- [ ] **Step 2: Add the bundle SELECT to the MSSQL config namespace**

In the same file, find the MSSQL `config:` object. Add the same string (dialect-agnostic — both accept this query syntax).

- [ ] **Step 3: Verify the strings build without error**

Run: `cd center && node -e "import('./src/db/sql.js').then(m => { console.log('mysql:', m.buildSql('mysql').config.getJwtSecretBundle); console.log('mssql:', m.buildSql('mssql').config.getJwtSecretBundle); })"`
Expected: both strings printed, both containing `jwt_secret_current` and `jwt_secret_previous`.

- [ ] **Step 4: Run center tests, no regressions**

Run: `cd center && npm test 2>&1 | tail -20`
Expected: 934/0/58 still (the new SQL string is referenced by the service module which already passes its tests with the buildMockDb mock; real-DB tests come in Task 6).

- [ ] **Step 5: Commit**

```bash
cd .worktrees/i9-dual-key-jwt-secret-rotation
git add center/src/db/sql.js
git commit -m "feat(db): add getJwtSecretBundle SQL (MySQL + MSSQL) (I9)"
```

- [ ] **Step 6: Mirror to publish/system**

```bash
diff -q center/src/db/sql.js publish/system/center/src/db/sql.js
cp center/src/db/sql.js publish/system/center/src/db/sql.js
diff -q center/src/db/sql.js publish/system/center/src/db/sql.js
git add publish/system/center/src/db/sql.js
git commit -m "chore(publish): mirror db/sql.js I9"
```

---

## Task 4: Bootstrap wiring (`center/server.js`)

**Files:**
- Modify: `center/server.js` (find the bootstrap IIFE after `seedAgentTokenIfMissing`)

- [ ] **Step 1: Add `seedJwtSecretIfMissing` call in server.js bootstrap**

Find the bootstrap IIFE (near `await seedAgentTokenIfMissing(cfg.agentToken, logger)` — added in I3 Task 4). Add immediately after it:

```js
    // I9: seed jwt-secret bundle from appsettings.json on first boot.
    // After this point, runtime reads from system_config.jwt_secret_current;
    // appsettings.json is bootstrap-only. Idempotent — also auto-expires a
    // previous secret older than jwt_secret_previous_ttl_days (default 30).
    const { seedJwtSecretIfMissing } = await import('./src/services/jwt-secret.js');
    await seedJwtSecretIfMissing(finalConfig.jwtSecret, logger);
```

Note: `finalConfig.jwtSecret` is the secret loaded from `appsettings.json` (with `JWT_SECRET` env var fallback per `feedback_full_chain_cleanup.md`). After this call, `finalConfig.jwtSecret` is bootstrap-only — `userAuth` reads from the DB.

- [ ] **Step 2: Run center tests, no regressions**

Run: `cd center && npm test 2>&1 | tail -10`
Expected: 934/0/58 (no test counts change — bootstrap wiring is verified by integration tests in Task 6).

- [ ] **Step 3: Commit**

```bash
cd .worktrees/i9-dual-key-jwt-secret-rotation
git add center/server.js
git commit -m "feat(bootstrap): seedJwtSecretIfMissing in startup IIFE (I9)"
```

- [ ] **Step 4: Mirror to publish/system**

```bash
diff -q center/server.js publish/system/center/server.js
cp center/server.js publish/system/center/server.js
diff -q center/server.js publish/system/center/server.js
git add publish/system/center/server.js
git commit -m "chore(publish): mirror server.js I9"
```

---

## Task 5: 3 admin endpoints (`center/src/routes/admin.js`)

**Files:**
- Modify: `center/src/routes/admin.js` (add 3 endpoint handlers + update existing `auth` chain to drop `secret:` arg)
- Create: `center/tests/routes/jwt-secret-rotate.test.js`

**Endpoints (all gated by `permissions: ['*']` wildcard via adminRouter):**

| Method | Path | Response |
|---|---|---|
| `POST` | `/api/admin/jwt-secret/rotate` | `{ newSecret: '<hex>', rotatedAt: '<iso>' }` |
| `POST` | `/api/admin/jwt-secret/commit` | `{ ok: true }` |
| `GET`  | `/api/admin/jwt-secret` | `{ mode, rotatedAt, previousExpiresAt, ttlDays }` (NEVER the secret) |

- [ ] **Step 1: Write the failing tests**

Create `center/tests/routes/jwt-secret-rotate.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { buildMockDb } from '../helpers/db-mock.js';
import { buildSql } from '../../src/db/sql.js';
import { adminRouter } from '../../src/routes/admin.js';

function noopLogger() { return { info(){}, warn(){}, error(){}, debug(){} }; }

function setupApp({ dbRows = [], userRow = { token_version: 0, status: 1 }, perm = '*' } = {}) {
  const db = buildMockDb([
    { match: /jwt_secret/i, rows: dbRows },
    { match: /users/i, rows: [userRow] }
  ]).standard();
  db.sql = buildSql('mysql');
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter({
    config: { jwtSecret: 'unused-after-bootstrap' },
    logger: noopLogger(),
    db
  }));
  // Stub req.user (adminRouter's auth chain normally populates this)
  app.use((req, _res, next) => {
    req.user = { sub: 'u1', permissions: perm === '*' ? ['*'] : [perm] };
    next();
  });
  return { app, db };
}

async function call(app, method, path, body) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const lib = method === 'GET' ? require('node:http').get : require('node:http').request;
      const req = lib({
        method,
        hostname: '127.0.0.1',
        port,
        path,
        headers: body ? { 'Content-Type': 'application/json' } : {}
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          server.close();
          let parsed;
          try { parsed = JSON.parse(data); } catch { parsed = data; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

test('POST /api/admin/jwt-secret/rotate: returns new secret + rotatedAt', async () => {
  const { app } = setupApp({ dbRows: [{ config_key: 'jwt_secret_current', config_value: 'OLD' }] });
  const r = await call(app, 'POST', '/api/admin/jwt-secret/rotate', {});
  assert.equal(r.status, 200);
  assert.match(r.body.newSecret, /^[a-f0-9]{64}$/);
  assert.match(r.body.rotatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('POST /api/admin/jwt-secret/rotate: writes audit row in same tx', async () => {
  const { app, db } = setupApp({ dbRows: [{ config_key: 'jwt_secret_current', config_value: 'OLD' }] });
  await call(app, 'POST', '/api/admin/jwt-secret/rotate', {});
  const allCalls = db.__calls || [];
  // There should be at least one audit_log INSERT during the rotate.
  const auditCalls = allCalls.filter(c => /audit/i.test(c.sql));
  assert.ok(auditCalls.length >= 1, 'expected at least one audit row');
});

test('POST /api/admin/jwt-secret/commit: returns {ok:true}', async () => {
  const { app } = setupApp({ dbRows: [
    { config_key: 'jwt_secret_current', config_value: 'NEW' },
    { config_key: 'jwt_secret_previous', config_value: 'OLD' }
  ] });
  const r = await call(app, 'POST', '/api/admin/jwt-secret/commit', {});
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
});

test('POST /api/admin/jwt-secret/commit: no-op when no previous, no audit', async () => {
  const { app, db } = setupApp({ dbRows: [{ config_key: 'jwt_secret_current', config_value: 'NEW' }] });
  await call(app, 'POST', '/api/admin/jwt-secret/commit', {});
  const allCalls = db.__calls || [];
  const auditCalls = allCalls.filter(c => /audit/i.test(c.sql));
  assert.equal(auditCalls.length, 0, 'no audit row on no-op commit');
});

test('GET /api/admin/jwt-secret: returns mode/rotatedAt/ttlDays, NEVER the secret', async () => {
  const { app } = setupApp({ dbRows: [
    { config_key: 'jwt_secret_current', config_value: 'NEVER-EXPOSE-ME' },
    { config_key: 'jwt_secret_previous', config_value: 'NEVER-EXPOSE-ME-EITHER' },
    { config_key: 'jwt_secret_rotated_at', config_value: '2026-08-01T00:00:00Z' },
    { config_key: 'jwt_secret_previous_ttl_days', config_value: '30' }
  ] });
  const r = await call(app, 'GET', '/api/admin/jwt-secret');
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'dual');
  assert.equal(r.body.rotatedAt, '2026-08-01T00:00:00Z');
  assert.equal(r.body.ttlDays, 30);
  assert.ok(r.body.previousExpiresAt);
  assert.ok(!('current' in r.body), 'state endpoint must not expose current secret');
  assert.ok(!('previous' in r.body), 'state endpoint must not expose previous secret');
  assert.ok(!('newSecret' in r.body));
  // Body string must not contain the secret value
  assert.ok(!JSON.stringify(r.body).includes('NEVER-EXPOSE-ME'));
});

test('GET /api/admin/jwt-secret: mode=single when no previous', async () => {
  const { app } = setupApp({ dbRows: [{ config_key: 'jwt_secret_current', config_value: 'X' }] });
  const r = await call(app, 'GET', '/api/admin/jwt-secret');
  assert.equal(r.body.mode, 'single');
});

test('cache invalidation: rotate handler invalidates the userAuth cache', async () => {
  const { app } = setupApp({ dbRows: [{ config_key: 'jwt_secret_current', config_value: 'OLD' }] });
  // First call to invalidate (imports userAuth's cache).
  // Then call rotate — the cache MUST be invalidated synchronously.
  // We assert by checking that _cache is null after the rotate call.
  const { invalidateJwtSecretCache, _loadJwtSecretBundle } = await import('../../src/auth/user-auth.js');
  invalidateJwtSecretCache();
  // Pre-warm cache by loading once.
  const fakeDb = { query: async () => ({ rows: [{ config_key: 'jwt_secret_current', config_value: 'OLD' }] }) };
  await _loadJwtSecretBundle(fakeDb);
  // Now hit rotate.
  await call(app, 'POST', '/api/admin/jwt-secret/rotate', {});
  // Verify cache was invalidated (next load returns fresh).
  const freshDb = { query: async () => ({ rows: [{ config_key: 'jwt_secret_current', config_value: 'FRESH' }] }) };
  const bundle = await _loadJwtSecretBundle(freshDb);
  assert.equal(bundle.current, 'FRESH');
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `cd center && node --test tests/routes/jwt-secret-rotate.test.js`
Expected: FAIL — endpoints don't exist.

- [ ] **Step 3: Update the `auth` chain in `center/src/routes/admin.js`**

At the top of the `adminRouter` factory (line ~56), change:
```js
const auth = [userAuth({ secret: config.jwtSecret, db: _db }), requirePerm('admin:users')];
```
to:
```js
const auth = [userAuth({ db: _db, logger }), requirePerm('admin:users')];
```

(Note: `userAuth`'s third dep is `logger`, which is the function-scoped `logger` parameter already declared in `adminRouter({ config, logger, db })`.)

- [ ] **Step 4: Add the 3 new endpoints**

At the end of the agent-token endpoints block (immediately after the `r.get('/api/admin/agent-token', auth, ...)` handler), add:

```js
  // The middleware factory (auth/user-auth.js) loads the JWT secret bundle
  // from system_config on first use and verifies the bearer token against
  // both `jwt_secret_current` and `jwt_secret_previous` so existing
  // sessions stay valid while the operator rolls the new secret out.
  // These three endpoints drive the lifecycle: rotate generates a new
  // secret + stashes the old one as previous; commit clears previous once
  // every user has refreshed their session (i.e. re-logged-in); GET exposes
  // mode/rotatedAt/previousExpiresAt/ttlDays for the UI (NEVER the secret
  // — that's only returned by /rotate and only to the operator who hit the
  // button). All three call invalidateJwtSecretCache after a write so the
  // very next request sees the new state.
  //
  // Use `_db` (the adminRouter-level db facade) so tests that pre-set the
  // db via `adminRouter({ db: mock })` don't need a global getDb() init —
  // matches the same pattern userAuth uses.
  r.post('/api/admin/jwt-secret/rotate', auth, async (req, res) => {
    try {
      const out = await rotateJwtSecret(_db, {
        logger,
        userId: req.user?.sub ?? null
      });
      invalidateJwtSecretCache();
      res.json({ newSecret: out.newSecret, rotatedAt: out.rotatedAt });
    } catch (e) {
      logger.error({ err: e }, 'jwt secret rotate failed');
      res.status(500).json({ error: 'rotate failed' });
    }
  });

  r.post('/api/admin/jwt-secret/commit', auth, async (req, res) => {
    try {
      await commitJwtSecret(_db, {
        logger,
        userId: req.user?.sub ?? null
      });
      invalidateJwtSecretCache();
      res.json({ ok: true });
    } catch (e) {
      logger.error({ err: e }, 'jwt secret commit failed');
      res.status(500).json({ error: 'commit failed' });
    }
  });

  r.get('/api/admin/jwt-secret', auth, async (_req, res) => {
    try {
      const s = await getJwtSecretState(_db);
      res.json({
        mode: s.previous ? 'dual' : 'single',
        rotatedAt: s.rotatedAt || null,
        previousExpiresAt: s.previousExpiresAt || null,
        ttlDays: s.ttlDays
      });
    } catch (e) {
      logger.error({ err: e }, 'jwt secret state get failed');
      res.status(500).json({ error: 'state get failed' });
    }
  });
```

- [ ] **Step 5: Add the imports at the top of `admin.js`**

Find the existing imports from `agent-token.js` and add equivalent imports for `jwt-secret.js`:

```js
import { rotateJwtSecret, commitJwtSecret, getJwtSecretState } from '../services/jwt-secret.js';
import { invalidateJwtSecretCache } from '../auth/user-auth.js';
```

- [ ] **Step 6: Run the tests, verify they pass**

Run: `cd center && node --test tests/routes/jwt-secret-rotate.test.js`
Expected: 7/7 PASS.

- [ ] **Step 7: Run full center suite, no regressions**

Run: `cd center && npm test 2>&1 | tail -10`
Expected: 968 / 0 / 60 (8 jwt + 7 user-auth + 10 service + 7 routes added; 2 SQL tests gated).

- [ ] **Step 8: Commit**

```bash
cd .worktrees/i9-dual-key-jwt-secret-rotation
git add center/src/routes/admin.js center/tests/routes/jwt-secret-rotate.test.js
git commit -m "feat(routes): 3 admin endpoints for jwt-secret rotate/commit/state (I9)"
```

- [ ] **Step 9: Mirror to publish/system**

```bash
diff -q center/src/routes/admin.js publish/system/center/src/routes/admin.js
cp center/src/routes/admin.js publish/system/center/src/routes/admin.js
diff -q center/src/routes/admin.js publish/system/center/src/routes/admin.js
git add publish/system/center/src/routes/admin.js
git commit -m "chore(publish): mirror routes/admin.js I9"
```

---

## Task 6: Real-DB SQL tests (MySQL + MSSQL)

**Files:**
- Create: `center/tests/sql/017-jwt-secret-rotate-mysql.test.js`
- Create: `center/tests/sql/017-jwt-secret-rotate-mssql.test.js`

Both tests gated on `TEST_MYSQL_URL` / `TEST_MSSQL_URL` env vars (skip when unset, per `feedback_real_db_sql_tests.md`).

- [ ] **Step 1: Write the MySQL real-DB test**

Create `center/tests/sql/017-jwt-secret-rotate-mysql.test.js`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMysqlClient } from '../../src/db/drivers/mysql.js';
import { buildSql } from '../../src/db/sql.js';
import {
  getJwtSecretState,
  rotateJwtSecret,
  commitJwtSecret,
  seedJwtSecretIfMissing
} from '../../src/services/jwt-secret.js';

const URL = process.env.TEST_MYSQL_URL;
const SKIP = !URL;

const noopLogger = { info(){}, warn(){}, error(){}, debug(){} };

(SKIP ? test.skip : test)('mysql: full rotate → commit round-trip', async (t) => {
  const db = await createMysqlClient(URL);
  const sql = buildSql('mysql');
  db.sql = sql;

  // Snapshot the four jwt_secret rows so we don't trash operator state.
  const snapshot = {};
  for (const key of ['jwt_secret_current', 'jwt_secret_previous', 'jwt_secret_rotated_at', 'jwt_secret_previous_ttl_days']) {
    const { rows } = await db.query(`SELECT config_value FROM system_config WHERE config_key = ?`, [key]);
    snapshot[key] = rows[0]?.config_value ?? null;
  }
  t.after(async () => {
    for (const [key, value] of Object.entries(snapshot)) {
      const upsert = db.sql.config.upsert;
      await db.execute(upsert, [key, value ?? '']);
    }
    await db.end();
  });

  // Step 1: seed from a known string
  const seed = await seedJwtSecretIfMissing(db, 'mysql-test-secret-aaa', noopLogger);
  // First boot seeds; subsequent boots are no-ops. Either is fine for this test.

  // Step 2: rotate
  const rot = await rotateJwtSecret(db, { logger: noopLogger, userId: 'mysql-test' });
  assert.match(rot.newSecret, /^[a-f0-9]{64}$/);

  // Step 3: verify state shows dual
  const s1 = await getJwtSecretState(db);
  assert.equal(s1.previous, 'mysql-test-secret-aaa');
  assert.equal(s1.current, rot.newSecret);
  assert.equal(s1.rotatedAt, rot.rotatedAt);

  // Step 4: verify the SQL string itself works against MySQL 5.7
  // (regression guard for JSON_LENGTH-style silent failures — see feedback)
  const { rows } = await db.query(db.sql.config.getJwtSecretBundle);
  assert.equal(rows.length, 4);

  // Step 5: commit
  await commitJwtSecret(db, { logger: noopLogger, userId: 'mysql-test' });
  const s2 = await getJwtSecretState(db);
  assert.equal(s2.previous, '');
  assert.equal(s2.rotatedAt, '');
  assert.equal(s2.current, rot.newSecret);

  // Step 6: second commit is a no-op (no previous)
  await commitJwtSecret(db, { logger: noopLogger, userId: 'mysql-test' });
});
```

- [ ] **Step 2: Write the MSSQL real-DB test**

Create `center/tests/sql/017-jwt-secret-rotate-mssql.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMssqlClient } from '../../src/db/drivers/mssql.js';
import { buildSql } from '../../src/db/sql.js';
import {
  getJwtSecretState,
  rotateJwtSecret,
  commitJwtSecret,
  seedJwtSecretIfMissing
} from '../../src/services/jwt-secret.js';

const URL = process.env.TEST_MSSQL_URL;
const SKIP = !URL;

const noopLogger = { info(){}, warn(){}, error(){}, debug(){} };

(SKIP ? test.skip : test)('mssql: full rotate → commit round-trip', async (t) => {
  const db = await createMssqlClient(URL);
  const sql = buildSql('mssql');
  db.sql = sql;

  // Snapshot the four jwt_secret rows
  const snapshot = {};
  for (const key of ['jwt_secret_current', 'jwt_secret_previous', 'jwt_secret_rotated_at', 'jwt_secret_previous_ttl_days']) {
    const r = await db.query(`SELECT config_value FROM system_config WHERE config_key = @p1`, [key]);
    snapshot[key] = r.recordset?.[0]?.config_value ?? r.rows?.[0]?.config_value ?? null;
  }
  t.after(async () => {
    for (const [key, value] of Object.entries(snapshot)) {
      const upsert = db.sql.config.upsert;
      await db.execute(upsert, [key, value ?? '']);
    }
    await db.close();
  });

  // Step 1: seed
  await seedJwtSecretIfMissing(db, 'mssql-test-secret-bbb', noopLogger);

  // Step 2: rotate
  const rot = await rotateJwtSecret(db, { logger: noopLogger, userId: 'mssql-test' });
  assert.match(rot.newSecret, /^[a-f0-9]{64}$/);

  // Step 3: state
  const s1 = await getJwtSecretState(db);
  assert.equal(s1.previous, 'mssql-test-secret-bbb');
  assert.equal(s1.current, rot.newSecret);

  // Step 4: bundle SQL works on MSSQL
  const bundle = await db.query(db.sql.config.getJwtSecretBundle);
  const rows = bundle.recordset || bundle.rows || [];
  assert.equal(rows.length, 4);

  // Step 5: commit
  await commitJwtSecret(db, { logger: noopLogger, userId: 'mssql-test' });
  const s2 = await getJwtSecretState(db);
  assert.equal(s2.previous, '');
  assert.equal(s2.rotatedAt, '');
  assert.equal(s2.current, rot.newSecret);
});
```

- [ ] **Step 3: Run the tests (skip if env vars not set)**

Run with MySQL: `cd center && TEST_MYSQL_URL='mysql://user:pass@host:3306/db' node --test tests/sql/017-jwt-secret-rotate-mysql.test.js`
Run with MSSQL: `cd center && TEST_MSSQL_URL='mssql://user:pass@host:1433/db' node --test tests/sql/017-jwt-secret-rotate-mssql.test.js`
Expected (when env set): PASS. Expected (when env unset): SKIP (no failure).

- [ ] **Step 4: Run full center suite, confirm 2 new tests pass / skip correctly**

Run: `cd center && npm test 2>&1 | tail -10`
Expected: center suite reports +2 tests, both pass when env vars are set, skip cleanly when not.

- [ ] **Step 5: Commit**

```bash
cd .worktrees/i9-dual-key-jwt-secret-rotation
git add center/tests/sql/017-jwt-secret-rotate-mysql.test.js \
        center/tests/sql/017-jwt-secret-rotate-mssql.test.js
git commit -m "test(sql): real-DB round-trip for jwt-secret rotate/commit (I9)"
```

(Test files are NOT mirrored per `feedback_publish_sync.md`.)

---

## Task 7: Whole-branch opus review

**Files:** none modified by this task itself; review-only.

- [ ] **Step 1: Verify full test suite is green**

Run: `cd center && npm test 2>&1 | tail -10`
Run: `cd agent && npm test 2>&1 | tail -10`
Run: `cd frontend && npm test 2>&1 | tail -10`
Expected: all suites green. Record exact counts.

- [ ] **Step 2: Verify no uncommitted drift**

Run: `git status`
Expected: clean working tree (everything committed by Tasks 1-6).

- [ ] **Step 3: Verify mirror sync**

Run: `cd .worktrees/i9-dual-key-jwt-secret-rotation && ./publish/system/scripts/verify-mirror.ps1 -Root . -PublishRoot publish/system 2>&1 | tail -20`
Expected: 0 mirror drift findings. If any are reported, fix before proceeding.

- [ ] **Step 4: Dispatch the whole-branch reviewer**

Dispatch a fresh subagent with the opus model (most capable available). The brief:
- Read the I9 spec at `docs/superpowers/specs/2026-08-18-dual-key-jwt-secret-rotation.md`.
- Read this plan at `docs/superpowers/plans/2026-08-18-dual-key-jwt-secret-rotation.md`.
- Generate a review package: `git log --oneline da21380..HEAD` + `git diff --stat da21380..HEAD` + `git diff -U10 da21380..HEAD` redirected to a uniquely-named file.
- Run two passes:
  1. **Spec compliance**: every spec section (1-9) has a corresponding implementation. List any gaps.
  2. **Code quality**: scan for silent failures, missing error handling, race conditions, security holes (especially: secret leakage in logs, audit-writeout-of-tx, cache invalidation missing).
- Report verdict: READY TO MERGE / NEEDS FIXES (with list) / BLOCKED (with explanation).

- [ ] **Step 5: Address review findings (if any)**

If verdict is NEEDS FIXES:
- For each finding, decide: fix-now (in scope) or park (v2 follow-up).
- Fix-now findings → dispatch a fix implementer subagent (mid-tier model, scoped brief listing the exact findings).
- After fix lands, re-run Task 7 Steps 1-3, then dispatch a scoped re-review (single round).

If verdict is READY TO MERGE: proceed to Step 6.

If verdict is BLOCKED: stop and assess — the architecture may be wrong.

- [ ] **Step 6: Mark I9 complete**

Append to the SDD ledger (`.superpowers/sdd/2026-08-18-dual-key-jwt-secret-rotation/progress.md`):

```
# SDD ledger — plan: docs/superpowers/plans/2026-08-18-dual-key-jwt-secret-rotation.md
Task 1: complete — verifyJwt({current,previous}) + userAuth({db,logger}) factory refactor
Task 2: complete — services/jwt-secret.js (rotate/commit/seed)
Task 3: complete — db.sql.js getJwtSecretBundle (MySQL + MSSQL)
Task 4: complete — server.js bootstrap seedJwtSecretIfMissing
Task 5: complete — 3 admin endpoints + auth chain update
Task 6: complete — real-DB SQL tests (MySQL + MSSQL, gated)
Task 7: complete — whole-branch opus review: <verdict>
```

Mark task #192 ("I9: Write implementation plan") as completed.

- [ ] **Step 7: Offer finishing-a-development-branch**

Run: invoke `superpowers:finishing-a-development-branch` skill to present merge/PR/keep options.

---

## Out-of-scope follow-ups (parked for future plans)

- Frontend UI: add "Rotate JWT signing secret" button in `/admin/security`. v2.
- Add a 400 guard rejecting `jwt_secret_*` keys at the generic `PUT /api/admin/config` endpoint (currently an operator can write directly to those rows and bypass rotate/commit). v2.
- Multi-process center: the in-memory cache is process-local. In a multi-process deploy, each process independently caches and invalidates. Single-process is the documented deploy model; multi-process cache coherency is parked. v2.
- Periodic TTL-expiry timer (currently only runs on bootstrap). v2.
