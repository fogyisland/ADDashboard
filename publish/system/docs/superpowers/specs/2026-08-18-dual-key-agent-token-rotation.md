# Dual-Key Agent Token Rotation — Design Spec

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:writing-plans (recommended) or superpowers:subagent-driven-development to plan implementation. Brainstorming already complete — this document is the single source of design intent.

**Goal:** Allow operators to rotate the shared `agentToken` (X-Agent-Token header) without taking agents offline, by accepting both old and new during an overlap window.

**Architecture:** Move `agentToken` runtime source-of-truth from `appsettings.json` to two rows in `system_config` (`agent_token_current`, `agent_token_previous`). New endpoints `POST /api/admin/agent-token/rotate` and `POST /api/admin/agent-token/commit` drive the rotation; the existing `agentToken` middleware tries current first, falls back to previous (with warning log), then 401s. Operator updates each agent's `appsettings.json` + restarts agent during the overlap window, then commits to clear the previous key.

**Tech Stack:** Node.js ESM (no new deps); existing `crypto.randomBytes`; existing `system_config` table; existing `writeAudit` tx wrapper; existing `agentToken` middleware factory (modified in place).

---

## Context — the bug we're fixing

`commit 3741a9b` introduced `/config.json` but the `agentToken` itself remains a single shared secret stored only in `center/appsettings.json`. **Today, rotating the agent token requires a coordinated multi-system edit:**

1. Operator generates a new random token (or uses the init wizard).
2. Operator edits `center/appsettings.json` and restarts center.
3. Operator edits every agent's `appsettings.json` and restarts every agent.
4. **Window between (2) and (3):** agents using the OLD token get 401'd → heartbeat gap → dashboard shows "agent offline" until all agents pick up the new token.
5. **Window between (3) and the operator's commit memory:** if anyone reverts step 2 in error, agents 401 again with no diagnostic trail.

For a single-agent install this is friction; for a fleet it is an outage. **This spec introduces an overlap window during which center accepts BOTH old and new tokens** so agents can be updated one-by-one (or in waves) without ever dropping heartbeats.

---

## Global Constraints

- **C1 — Single source of truth at runtime.** After bootstrap, `system_config.agent_token_current` is authoritative. `appsettings.json` `agentToken` becomes bootstrap-only (one-time seed).
- **C2 — No new dependencies.** Use Node built-ins (`crypto.randomBytes`) and existing services (`writeAudit`, `db.transaction`).
- **C3 — writeAudit signature is `({...}, logger, tx)`** (per `feedback_writeaudit_signature.md`). All audit writes go through this signature; tx is the 3rd arg.
- **C4 — Dual-platform SQL** (MySQL + MSSQL). Both dialects must support the upsert via the existing `db.sql.config.upsert` (already dialect-specific).
- **C5 — Backward compatible.** Existing single-key installs (`appsettings.json` has `agentToken`, DB has no row) continue to work — bootstrap seeds the DB on first start. `verifyAgentToken` accepts current OR previous; missing `agent_token_previous` row treated as empty (no match).
- **C6 — Log at appropriate severity.** `info` on rotation start + commit; `warn` on previous-token hit (suggests operator forgot to commit); `error` only on rotation failure.
- **C7 — CWD-agnostic path resolution** (per `feedback_cwd_agnostic.md`). N/A — no path resolution here.
- **C8 — Cache invalidate on rotation** (NEW constraint derived from this work). In-memory cache of `current` + `previous` token MUST be invalidated synchronously inside the rotate/commit handler so the very next request sees the new state.

---

## §1 — Architecture

### 1.1 Components

**`center/src/auth/agent-token.js` (modified)** — middleware factory changes from `agentToken(expected)` (single string) to `agentToken({ db })`. Loads `{ current, previous }` from DB on cache miss, caches for the process lifetime (invalidation on rotate/commit). Compares `req.headers['x-agent-token']` against `current` first, then `previous`. Emits warning log when `previous` matches.

**`center/src/services/agent-token.js` (new)** — three operations:
- `getAgentTokenState(db)` → `{ current, previous, rotatedAt, source }`. Reads the two `system_config` rows.
- `rotateAgentToken(db, { logger, userId })` → `{ newToken }`. Generates fresh 48-byte hex, writes `agent_token_previous = current`, `agent_token_current = newToken`, `agent_token_rotated_at = nowIso`. Returns the new token ONCE.
- `commitAgentToken(db, { logger, userId })` → `{ ok: true }`. Clears `agent_token_previous = ''` and writes audit. Auto-clears if previous is older than `agent_token_previous_ttl_days` (default 30, stored in `system_config`).
- `seedAgentTokenIfMissing(db, fromAppsettings, logger)` → idempotent first-boot seed.

**`center/src/routes/admin.js` (modified)** — three new endpoints:
- `POST /api/admin/agent-token/rotate` — calls `rotateAgentToken`, returns the new token in the response body (operator copies it), writes audit, invalidates middleware cache.
- `POST /api/admin/agent-token/commit` — calls `commitAgentToken`, writes audit, invalidates middleware cache.
- `GET /api/admin/agent-token` — returns `{ mode: 'single'|'dual', rotatedAt, previousExpiresAt }`. NEVER returns the secret. CAML_MAP camel-case for API.

**`center/src/db/sql.js` (modified)** — three new strings in `config` namespace:
- `getAgentTokenCurrent`: `SELECT config_value FROM system_config WHERE config_key = 'agent_token_current'`
- `getAgentTokenBundle`: `SELECT config_key, config_value FROM system_config WHERE config_key IN ('agent_token_current', 'agent_token_previous', 'agent_token_rotated_at', 'agent_token_previous_ttl_days')`
- (No new SQL for upsert — reuse existing `db.sql.config.upsert` per-row.)
- (MySQL + MSSQL dialects both.)

**`center/src/init/router.js` (modified)** — `finalize` now writes `agentToken` ONLY to `appsettings.json` (existing behavior); the bootstrap IIFE in `server.js` will seed DB on first start. Document this in the `finalize` log message.

**`center/server.js` (modified)** — add to the bootstrap IIFE after `seedListenPortIfMissing`: `await seedAgentTokenIfMissing(cfg.agentToken, logger)`. Also add in-memory cache invalidation hook so the rotate/commit handlers can clear it.

**`center/appsettings.example.json` (unchanged)** — still documents `agentToken` field but now flagged as bootstrap-only via inline comment in spec §6.

**Agent side: NO CHANGES.** Operator manually updates each agent's `appsettings.json` + restarts the agent during the overlap window. This matches today's manual rotation workflow, just with a wider window.

### 1.2 Data flow — first boot (single-key install)

```
center server.js startup
  ├─ loadConfig(appsettings.json)
  │     reads cfg.agentToken (e.g. "abc123...")
  ├─ seedAgentTokenIfMissing(cfg.agentToken, logger)
  │     ├─ query: SELECT config_value FROM system_config
  │     │         WHERE config_key = 'agent_token_current'
  │     ├─ if row exists → return current value
  │     └─ else:
  │          INSERT 'agent_token_current' = cfg.agentToken via upsert
  │          INSERT 'agent_token_previous' = '' via upsert
  │          INSERT 'agent_token_rotated_at' = '' via upsert
  │          INSERT 'agent_token_previous_ttl_days' = '30' via upsert
  │          log: "seeded agent token from appsettings.json"
  └─ normal boot continues
```

After first boot, `appsettings.json` `agentToken` field is IGNORED at runtime (still required for the bootstrap). Operators can leave it or remove it.

### 1.3 Data flow — operator rotates the token

```
UI button: "Rotate agent token" → POST /api/admin/agent-token/rotate
  ├─ services/agent-token.rotateAgentToken(db, { logger, userId })
  │     ├─ BEGIN tx
  │     ├─ SELECT current FROM system_config (inside tx)
  │     ├─ newToken = randomBytes(48).toString('hex')
  │     ├─ UPSERT 'agent_token_previous' = current (was current, now previous)
  │     ├─ UPSERT 'agent_token_current' = newToken
  │     ├─ UPSERT 'agent_token_rotated_at' = nowIso
  │     ├─ writeAudit({ userId, action:'rotate_agent_token',
  │     │                target:'system_config',
  │     │                payload:{ previousLength, newLength, rotatedAt }},
  │     │              logger, tx)
  │     └─ COMMIT
  ├─ middleware cache.invalidate()
  └─ response: { newToken }      ← operator copies and deploys

Operator now edits each agent's appsettings.json with newToken + restarts agent.
During this window:
  ├─ agent with OLD token → middleware matches 'previous' → log warn → next()
  └─ agent with NEW token → middleware matches 'current' → next()

UI button: "Confirm all agents updated" → POST /api/admin/agent-token/commit
  ├─ services/agent-token.commitAgentToken(db, { logger, userId })
  │     ├─ BEGIN tx
  │     ├─ UPSERT 'agent_token_previous' = ''
  │     ├─ UPSERT 'agent_token_rotated_at' = ''
  │     ├─ writeAudit({ userId, action:'commit_agent_token',
  │     │                target:'system_config' }, logger, tx)
  │     └─ COMMIT
  ├─ middleware cache.invalidate()
  └─ response: { ok: true }
```

### 1.4 Auto-expiry safety net

If operator forgets to commit (e.g., walks away mid-rotation), the previous token remains valid indefinitely — that's the whole point of the overlap window. To prevent forgotten rotations from accumulating risk, **the bootstrap IIFE checks `agent_token_rotated_at` against the TTL** and auto-clears `agent_token_previous` if expired:

```
center server.js startup (every boot)
  └─ seedAgentTokenIfMissing(...)
       └─ after seed:
            if (agent_token_previous && agent_token_rotated_at > ttlDays ago):
              log warn: "previous agent token expired by TTL; auto-clearing"
              UPSERT 'agent_token_previous' = ''
              UPSERT 'agent_token_rotated_at' = ''
              middleware cache.invalidate()
```

Operator can tune `agent_token_previous_ttl_days` in `system_config` (default 30). Set to 0 to disable auto-expiry.

---

## §2 — Module API

### 2.1 `center/src/auth/agent-token.js` (middleware)

```js
// Module-level cache (singleton). Invalidated by rotate/commit handlers.
let _cache = null; // { current: string, previous: string, loadedAt: number }

export async function _loadAgentTokenBundle(db) {
  // SELECT config_key, config_value FROM system_config WHERE config_key IN (...).
  // Returns { current, previous } (string '' for missing).
  // Caches forever — invalidated explicitly via invalidateAgentTokenCache().
}

export function invalidateAgentTokenCache() {
  _cache = null;
}

export function agentToken({ db }) {
  return async (req, res, next) => {
    const { current, previous } = await _loadAgentTokenBundle(db);
    const supplied = req.headers['x-agent-token'];
    if (typeof supplied !== 'string' || supplied === '') {
      return res.status(401).json({ error: 'invalid agent token' });
    }
    // Constant-time compare for both. constantTimeEqual imported from existing
    // password.js helper (if present) or reimplemented locally.
    if (current && constantTimeEqual(supplied, current)) return next();
    if (previous && constantTimeEqual(supplied, previous)) {
      req._agentTokenMatchedPrevious = true; // for warning log
      return next();
    }
    return res.status(401).json({ error: 'invalid agent token' });
  };
}

// Helper used by the request logger to emit one warn line when previous
// matched. NOT called by middleware directly — the route logger middleware
// sees req._agentTokenMatchedPrevious and logs accordingly.
```

**Why the request logger, not the auth middleware**: keeps the auth middleware pure (no logger dependency). Existing pattern in user-auth.js doesn't log per-request either — the `req._*` flag is the contract the surrounding logger middleware reads.

**Constant-time compare**: prevent timing side-channels that would let an attacker recover the secret byte-by-byte. Use `crypto.timingSafeEqual` on equal-length buffers; if lengths differ, return false immediately (timing leak of length is acceptable — the secret is 96 hex chars by design).

### 2.2 `center/src/services/agent-token.js` (service)

```js
/**
 * Read the current agent-token bundle from system_config. Returns the values
 * as plain strings; missing rows become ''. Never throws — caller decides
 * how to react to missing current (init wizard should have seeded it).
 */
export async function getAgentTokenState(db)

/**
 * Generate a fresh 48-byte hex token, write (current → previous, new → current),
 * bump rotated_at, write audit. Returns { newToken } for the operator to copy.
 * Atomic via tx.
 */
export async function rotateAgentToken(db, { logger, userId })

/**
 * Clear the previous token + rotated_at. Operator-driven; auto-clears if
 * past TTL (caller checks first). Writes audit. Atomic via tx.
 */
export async function commitAgentToken(db, { logger, userId })

/**
 * First-boot seed: copy appsettings.json agentToken into system_config
 * agent_token_current; initialize all related rows to empty defaults.
 * Idempotent — if agent_token_current row exists, returns existing value.
 */
export async function seedAgentTokenIfMissing(db, fromAppsettings, logger)
```

### 2.3 `center/src/routes/admin.js` (handlers)

```js
r.post('/api/admin/agent-token/rotate', auth, async (req, res) => {
  try {
    const db = getDb();
    const r = await rotateAgentToken(db, {
      logger,
      userId: req.user?.sub ?? null
    });
    invalidateAgentTokenCache();
    res.json({ newToken: r.newToken, rotatedAt: r.rotatedAt });
  } catch (e) {
    logger.error({ err: e }, 'agent token rotate failed');
    res.status(500).json({ error: 'rotate failed' });
  }
});

r.post('/api/admin/agent-token/commit', auth, async (req, res) => {
  try {
    const db = getDb();
    await commitAgentToken(db, {
      logger,
      userId: req.user?.sub ?? null
    });
    invalidateAgentTokenCache();
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'agent token commit failed');
    res.status(500).json({ error: 'commit failed' });
  }
});

r.get('/api/admin/agent-token', auth, async (_req, res) => {
  try {
    const db = getDb();
    const state = await getAgentTokenState(db);
    res.json({
      mode: state.previous ? 'dual' : 'single',
      rotatedAt: state.rotatedAt || null,
      previousExpiresAt: state.previousExpiresAt || null,
      ttlDays: state.ttlDays
    });
  } catch (e) {
    logger.error({ err: e }, 'agent token state get failed');
    res.status(500).json({ error: 'state get failed' });
  }
});
```

**Response shape rationale**: `mode: 'single' | 'dual'` is the operator's "do I still need to update agents?" signal. `previousExpiresAt` is the auto-expiry deadline. Never return the secret in this endpoint.

---

## §3 — DB schema

### 3.1 `system_config` rows (no migration; uses existing `config_key/config_value` table)

| config_key | Type | Initial value | Meaning |
|------------|------|---------------|---------|
| `agent_token_current` | TEXT | seeded from appsettings.json | Single source of truth at runtime |
| `agent_token_previous` | TEXT | `''` | The old token during overlap window |
| `agent_token_rotated_at` | TEXT (ISO 8601) | `''` | When `previous` was set |
| `agent_token_previous_ttl_days` | TEXT (digits) | `'30'` | Auto-expiry threshold |

### 3.2 Existing `agent_token` row (cleanup)

The existing `agent_token` config_key (set via `setAgentToken` service, currently unused at runtime) is kept as-is for backward compat — old operators who manually set it via SQL still see the same row. **New code reads `agent_token_current`** (the renamed key). Cleanup of the old key is deferred to a future task (it would be a destructive delete).

---

## §4 — Error handling & edge cases

| Case | Behavior |
|------|----------|
| `rotateAgentToken` called with no `current` row seeded (init wizard never ran) | Service auto-seeds first using the appsettings.json fallback (passed via closure), then rotates. Operator gets the new token. Logged at `warn`. |
| `commitAgentToken` called with no `previous` row | Idempotent no-op; response `{ ok: true }`; no audit row written (no-op doesn't need an audit trail). |
| `previous` expired by TTL on bootstrap | Auto-clear; log `warn`; no audit row (auto-expiry is housekeeping, not an admin action). |
| Operator rotates twice without commit in between | First rotate: current=A, previous=A_old. Second rotate: previous=A, current=B. A_old is lost — agent with A_old gets 401. **Documented risk**: only rotate once you've deployed A to all agents. |
| Agent sends empty X-Agent-Token | 401 with no constant-time compare (length check first). |
| DB query fails during `_loadAgentTokenBundle` | Middleware logs error, returns 503 (NOT 401 — distinguish auth failure from server failure). |
| `appsettings.json` `agentToken` removed after bootstrap | Center keeps using DB row; no effect on runtime. |
| Two operators click rotate simultaneously | Both transactions contend on the upsert — last writer wins. Audit log shows both attempts (operator can spot duplicates). |
| Constant-time compare with mismatched lengths | Return `false` immediately (no timing leak of content). Length is fixed by design (96 hex chars) so length leak is not sensitive. |
| `previous` cleared but agent with old token still running | Agent gets 401 → heartbeat gap → "agent offline" badge in dashboard. Operator's signal that an agent was missed. |

---

## §5 — Logging

| Event | Level | Fields |
|-------|-------|--------|
| Seed from appsettings.json | `info` | `{ key: 'agent_token_current', length: N }` |
| Rotate started | `info` | `{ userId, previousLength, newLength }` |
| Rotate committed | `info` | `{ userId, rotatedAt }` |
| Commit started | `info` | `{ userId }` |
| Commit completed | `info` | `{ userId }` |
| Previous-token match (warning) | `warn` | `{ path: req.path, agentId: req.headers['x-agent-id'] }` |
| Previous-token auto-expired | `warn` | `{ rotatedAt, ttlDays }` |
| Seed fallback (no current row) | `warn` | `{ source: 'appsettings.json' }` |
| DB query failure in middleware | `error` | `{ err }` |

Per-request warn on `previous` match is the operator's "an agent is still on the old token — click commit when you've updated them all" signal.

---

## §6 — appsettings.json schema additions

`center/appsettings.example.json` gets one inline comment (not a structural change — comment is JSONC, no schema impact for parsers that don't understand comments):

```diff
 {
   ...
   "jwtSecret": "REPLACE_WITH_RANDOM_64_CHARS",
-  "agentToken": "REPLACE_WITH_GUID",
+  "agentToken": "REPLACE_WITH_GUID",  // bootstrap-only — runtime reads from system_config.agent_token_current (see spec 2026-08-18-dual-key-agent-token-rotation)
   "staticDir": "...",
   ...
 }
```

**Validation impact**: `config.js` still requires `cfg.agentToken` (line 49) — keeps backward compat with operators who haven't yet booted. We could relax to optional, but a missing agentToken at first boot crashes the seed → high-friction failure for first-time installers. Keep required; the spec §1.2 bootstrap copies it to DB on first start. From second boot onward, `appsettings.json` `agentToken` can be any non-empty string (DB is the truth).

**Recommendation for operator docs** (deferred to deployment.md update): "After the first successful start, you may remove `agentToken` from `appsettings.json` (or leave any value); runtime uses the DB row."

---

## §7 — Testing strategy

### 7.1 Unit tests — `center/tests/auth/agent-token.test.js`

| Test | Assertion |
|------|-----------|
| `agentToken` accepts current | Stub DB returns `{ current: 'A', previous: '' }`; request with `X-Agent-Token: A` → next() called. |
| `agentToken` accepts previous | Stub DB returns `{ current: 'B', previous: 'A' }`; request with `X-Agent-Token: A` → next() called AND `req._agentTokenMatchedPrevious === true`. |
| `agentToken` rejects wrong token | Request with `X-Agent-Token: Z` → 401. |
| `agentToken` rejects empty header | No X-Agent-Token → 401. |
| `agentToken` uses cache on second call | First call → DB.query called; second call (within same process) → DB.query NOT called. |
| `invalidateAgentTokenCache()` forces reload | Call invalidate → next request triggers DB.query again. |
| Constant-time compare: same length, same content | Returns true. |
| Constant-time compare: same length, different content | Returns false. |
| Constant-time compare: different length | Returns false (immediate). |

### 7.2 Unit tests — `center/tests/services/agent-token.test.js`

| Test | Assertion |
|------|-----------|
| `getAgentTokenState` returns both keys | Mock DB returns both rows → object with `current`, `previous`. |
| `getAgentTokenState` empty when no rows | Mock DB returns [] → both fields `''`. |
| `rotateAgentToken` writes both rows + audit | Mock DB transaction; assert upsert for previous + current + rotated_at + audit row. |
| `rotateAgentToken` returns new token | Returns `{ newToken: '<96-hex-chars>' }`. |
| `commitAgentToken` clears previous + writes audit | Mock DB; assert upsert for previous='' and audit row. |
| `commitAgentToken` is no-op when no previous | No audit row written; no error. |
| `seedAgentTokenIfMissing` is idempotent | Pre-existing current row → no upsert issued; returns existing value. |
| `seedAgentTokenIfMissing` inserts all 4 rows when absent | All 4 upserts issued; returns seeded current. |
| `seedAgentTokenIfMissing` auto-expires on second call | Set rotated_at to 31 days ago → re-call clears previous + rotated_at. |
| `seedAgentTokenIfMissing` does NOT expire when < TTL | rotated_at = 5 days ago → no clear. |

### 7.3 Integration tests — `center/tests/routes/agent-token-rotate.test.js`

| Test | Assertion |
|------|-----------|
| `POST /api/admin/agent-token/rotate` returns 200 + new token | Auth as admin; response body has `newToken` (96 hex chars). |
| `POST /api/admin/agent-token/rotate` returns 403 for non-admin | Auth as non-admin → 403. |
| `POST /api/admin/agent-token/rotate` writes audit | After rotate, audit_logs row with `action='rotate_agent_token'` exists. |
| `POST /api/admin/agent-token/commit` clears previous | After rotate then commit, `agent_token_previous` row is `''`. |
| `GET /api/admin/agent-token` returns mode='single' | No prior rotation → `{ mode: 'single', rotatedAt: null }`. |
| `GET /api/admin/agent-token` returns mode='dual' | After rotate → `{ mode: 'dual', rotatedAt: '<iso>' }`. |
| `GET /api/admin/agent-token` NEVER returns the token | Response body has no `current` or `previous` or `newToken` field. |

### 7.4 Real-DB integration tests — `center/tests/sql/016-agent-token-rotate.test.js` (gated)

| Test | Assertion |
|------|-----------|
| MySQL: rotate then commit round-trip | Real MySQL apply; verify previous → current → empty. |
| MSSQL: rotate then commit round-trip | Real MSSQL apply; verify previous → current → empty. |

Both gated on `TEST_MYSQL_URL` / `TEST_MSSQL_URL` env vars per existing pattern.

### 7.5 Regression

- All existing tests pass unchanged (center 895/0/60 baseline).
- Existing `tests/auth.test.js` login test still passes.
- Agent integration tests unchanged (no agent-side change).

---

## §8 — Implementation plan (deferred to writing-plans)

Roughly:

1. **`center/src/auth/agent-token.js`** — refactor to factory `agentToken({db})`; cache + invalidate; constant-time compare. Tests TDD. (Task 1)
2. **`center/src/services/agent-token.js`** — new service module with `getAgentTokenState` / `rotateAgentToken` / `commitAgentToken` / `seedAgentTokenIfMissing`. Tests TDD. (Task 2)
3. **`center/src/db/sql.js`** — add `getAgentTokenCurrent` + `getAgentTokenBundle` strings (MySQL + MSSQL). Tests TDD. (Task 3)
4. **`center/server.js`** + **`center/src/init/router.js`** — bootstrap IIFE calls `seedAgentTokenIfMissing`; invalidate hook wired. (Task 4)
5. **`center/src/routes/admin.js`** — three new endpoints + CAML_MAP. (Task 5)
6. **Real-DB SQL tests** — `tests/sql/016-agent-token-rotate-{mysql,mssql}.test.js`. (Task 6)
7. **whole-branch review** by opus. (Task 7)

---

## §9 — Out of scope

- **Operator UI** for rotate / commit buttons (deferred — operators use `curl` or future UI work).
- **Per-agent tokens** (each agent gets its own secret, not a shared one). Different design, much larger surface — future spec.
- **Auto-rotate cron** (rotate every N days on a schedule). Manual rotation is sufficient for v1.
- **Audit detail expansion** (showing the actual token length, not just "rotated"). Current `payload: { previousLength, newLength }` is enough for compliance.
- **Migration cleanup** of the unused `agent_token` row. This spec reads `agent_token_current`; old `agent_token` row remains untouched.
- **Removing `agentToken` requirement from `config.js` TOP_LEVEL_REQUIRED**. Keep required for first-boot; later relaxation deferred.
- **Frontend changes** — no UI work in this spec.