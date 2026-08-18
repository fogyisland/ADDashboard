# Dual-Key JWT Secret Rotation — Design Spec

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:writing-plans (recommended) or superpowers:subagent-driven-development to plan implementation. Brainstorming already complete — this document is the single source of design intent.

**Goal:** Allow operators to rotate the JWT signing secret (`config.jwtSecret`) without invalidating every user's session, by accepting tokens signed by either the old or the new secret during an overlap window.

**Architecture:** Move `jwtSecret` runtime source-of-truth from `appsettings.json` to two rows in `system_config` (`jwt_secret_current`, `jwt_secret_previous`). New endpoints `POST /api/admin/jwt-secret/rotate` and `POST /api/admin/jwt-secret/commit` drive the rotation; `verifyJwt` tries `current` first, falls back to `previous` (with warning log), then rejects. Operator invalidates any straggler tokens by clicking commit once every authenticated user has refreshed their JWT.

**Tech Stack:** Node.js ESM (no new deps); existing `crypto.randomBytes`; existing `system_config` table; existing `writeAudit` tx wrapper; existing `signJwt`/`verifyJwt`/`userAuth` (modified in place); existing `jsonwebtoken` library.

---

## Context — the bug we're fixing

The JWT signing secret currently lives in two places: `center/appsettings.json` (`jwtSecret`) and the `JWT_SECRET` env var (used only at boot). Rotating it today is a coordinated restart dance with no overlap:

1. Operator generates a new secret (manual `openssl rand -hex 32` or similar).
2. Operator edits `center/appsettings.json` and restarts center.
3. **Every existing JWT signed with the OLD secret is now invalid.** Every authenticated browser is logged out instantly.
4. If anyone reverts step 2 in error, the same happens again with no diagnostic trail.

For a single-user install this is friction; for a multi-user dashboard with operator mid-action (reviewing audit log, editing a config) it is a forced re-login across the entire operator fleet, often mid-task. **This spec introduces an overlap window during which center accepts tokens signed by EITHER old or new secret** so the cutover can happen without logging anyone out, then `commit` re-tightens to single-key once the operator is confident every client has refreshed.

This mirrors I3 (dual-key agent token rotation) — same shape, different secret. All design invariants from I3 apply here too: C1 single source of truth, C3 `writeAudit` signature, C4 dual-platform SQL, C5 backward compatible, C6 logging severity, C8 cache invalidation.

---

## Global Constraints

- **C1 — Single source of truth at runtime.** After bootstrap, `system_config.jwt_secret_current` is authoritative. `appsettings.json` `jwtSecret` becomes bootstrap-only (one-time seed).
- **C2 — No new dependencies.** Use Node built-ins (`crypto.randomBytes`) and existing services (`writeAudit`, `db.transaction`).
- **C3 — writeAudit signature is `({...}, logger, tx)`** (per `feedback_writeaudit_signature.md`). All audit writes go through this signature; tx is the 3rd arg.
- **C4 — Dual-platform SQL** (MySQL + MSSQL). Both dialects must support the upsert via the existing `db.sql.config.upsert` (already dialect-specific).
- **C5 — Backward compatible.** Existing single-key installs (`appsettings.json` has `jwtSecret`, DB has no row) continue to work — bootstrap seeds the DB on first start. `verifyJwt` accepts current OR previous; missing `jwt_secret_previous` row treated as empty string (no match).
- **C6 — Log at appropriate severity.** `info` on rotation start + commit; `warn` on previous-secret token verification (suggests operator forgot to commit, or a user is still on a pre-rotation session); `error` only on rotation failure.
- **C7 — CWD-agnostic path resolution** (per `feedback_cwd_agnostic.md`). N/A — no path resolution here.
- **C8 — Cache invalidate on rotation** (per I3, also applies here). In-memory cache of `current` + `previous` JWT secret MUST be invalidated synchronously inside the rotate/commit handler so the very next request sees the new state.

---

## §1 — Architecture

### 1.1 Components

**`center/src/auth/jwt.js` (modified)** — `verifyJwt` factory changes from `verifyJwt(token, secret)` to `verifyJwt(token, secrets)` where `secrets = { current, previous }`. Tries `current` first via `jwt.verify`, falls back to `previous`, returns null on total miss. `signJwt(payload, secret, ttlSec)` keeps the same signature; the caller is responsible for passing the current secret. Also exports `invalidateJwtSecretCache()` and `_loadJwtSecretBundle(db, sql)`.

**`center/src/auth/user-auth.js` (modified)** — middleware reads the secret bundle from DB via the `userAuth({ db })` factory (analogous to I3's `agentToken({ db })`). Cached for process lifetime; invalidated by rotate/commit. Per-request token verification goes through `verifyJwt(token, { current, previous })`.

**`center/src/services/jwt-secret.js` (new)** — four operations:
- `getJwtSecretState(db)` → `{ mode: 'single'|'dual', rotatedAt, previousExpiresAt, ttlDays }`. Reads the four `system_config` rows.
- `rotateJwtSecret(db, { logger, userId })` → `{ newSecret }`. Generates fresh 32-byte hex, writes `jwt_secret_previous = current`, `jwt_secret_current = newSecret`, `jwt_secret_rotated_at = nowIso`. Returns the new secret ONCE.
- `commitJwtSecret(db, { logger, userId })` → `{ ok: true }`. Clears `jwt_secret_previous = ''` and writes audit. Auto-clears if previous is older than `jwt_secret_previous_ttl_days` (default 30, stored in `system_config`).
- `seedJwtSecretIfMissing(db, fromAppsettings, logger)` → idempotent first-boot seed.

**`center/src/routes/admin.js` (modified)** — three new endpoints:
- `POST /api/admin/jwt-secret/rotate` — calls `rotateJwtSecret`, returns the new secret in the response body (operator copies it), writes audit, invalidates `userAuth` cache.
- `POST /api/admin/jwt-secret/commit` — calls `commitJwtSecret`, writes audit, invalidates `userAuth` cache.
- `GET /api/admin/jwt-secret` — returns `{ mode, rotatedAt, previousExpiresAt, ttlDays }`. NEVER returns the secret.

**`center/src/db/sql.js` (modified)** — one new string in `config` namespace (both dialects):
- `getJwtSecretBundle`: `SELECT config_key, config_value FROM system_config WHERE config_key IN ('jwt_secret_current', 'jwt_secret_previous', 'jwt_secret_rotated_at', 'jwt_secret_previous_ttl_days')`
- (No new SQL for upsert — reuse existing `db.sql.config.upsert` per-row.)

**`center/server.js` (modified)** — add to the bootstrap IIFE after `seedAgentTokenIfMissing`: `await seedJwtSecretIfMissing(finalConfig.jwtSecret, logger)`.

**`center/appsettings.example.json` (unchanged in spec)** — still documents `jwtSecret` field; spec §6 flags it as bootstrap-only via inline comment.

**Frontend: NO CHANGES** required. The existing `401 → re-login` flow already handles the rare case where a user's JWT was signed by a now-revoked secret; the overlap window means this happens only after `commit`.

### 1.2 Data flow — first boot (single-key install)

```
center server.js startup
  ├─ loadConfig(appsettings.json)
  │     reads cfg.jwtSecret (e.g. "abc123...")
  ├─ seedAgentTokenIfMissing(...)            (existing I3 work)
  ├─ seedJwtSecretIfMissing(cfg.jwtSecret, logger)
  │     ├─ query: SELECT config_value FROM system_config
  │     │         WHERE config_key = 'jwt_secret_current'
  │     ├─ if row exists → return current value (no-op)
  │     └─ else:
  │          INSERT 'jwt_secret_current' = cfg.jwtSecret via upsert
  │          INSERT 'jwt_secret_previous' = '' via upsert
  │          INSERT 'jwt_secret_rotated_at' = '' via upsert
  │          INSERT 'jwt_secret_previous_ttl_days' = '30' via upsert
  │          log: "seeded jwt secret from appsettings.json"
  └─ normal boot continues
```

After first boot, `appsettings.json` `jwtSecret` field is IGNORED at runtime (still required for the bootstrap). Operators can leave it or remove it.

### 1.3 Data flow — operator rotates the secret

```
UI button: "Rotate JWT signing secret" → POST /api/admin/jwt-secret/rotate
  ├─ services/jwt-secret.rotateJwtSecret(db, { logger, userId })
  │     ├─ BEGIN tx
  │     ├─ SELECT current FROM system_config (inside tx)
  │     ├─ newSecret = randomBytes(32).toString('hex')
  │     ├─ UPSERT 'jwt_secret_previous' = current
  │     ├─ UPSERT 'jwt_secret_current' = newSecret
  │     ├─ UPSERT 'jwt_secret_rotated_at' = nowIso
  │     ├─ writeAudit({ userId, action:'rotate_jwt_secret',
  │     │                target:'system_config',
  │     │                payload:{ previousLength, newLength, rotatedAt }},
  │     │              logger, tx)
  │     └─ COMMIT
  ├─ userAuth cache.invalidate()
  └─ response: { newSecret }      ← operator copies and stores securely

During this window:
  ├─ request with JWT signed by OLD secret → verifyJwt matches 'previous'
  │     → req._jwtSecretMatchedPrevious = true → log warn → next()
  └─ request with JWT signed by NEW secret → verifyJwt matches 'current' → next()

UI button: "Confirm all sessions refreshed" → POST /api/admin/jwt-secret/commit
  ├─ services/jwt-secret.commitJwtSecret(db, { logger, userId })
  │     ├─ BEGIN tx
  │     ├─ UPSERT 'jwt_secret_previous' = ''
  │     ├─ UPSERT 'jwt_secret_rotated_at' = ''
  │     ├─ writeAudit({ userId, action:'commit_jwt_secret',
  │     │                target:'system_config',
  │     │                payload:{ rotatedAt }},
  │     │              logger, tx)
  │     └─ COMMIT
  ├─ userAuth cache.invalidate()
  └─ response: { ok: true }
```

After commit, only tokens signed by the NEW secret are accepted. Any straggler user with a pre-rotation JWT will get a 401 on their next request and be forced to re-authenticate.

### 1.4 Data flow — auto-expire (forgotten commit)

Same pattern as I3 §1.4. If the operator rotates and never commits, `seedJwtSecretIfMissing` (called on every boot) checks whether `jwt_secret_rotated_at` is older than `jwt_secret_previous_ttl_days` (default 30). If so, it auto-clears `jwt_secret_previous = ''` and `jwt_secret_rotated_at = ''` so the operator cannot accidentally lock themselves out forever. The auto-expire is also audited.

---

## §2 — Interfaces

### 2.1 `verifyJwt` factory contract (modified)

```js
// Before: verifyJwt(token, secret: string) → payload|null
// After:  verifyJwt(token, secrets: { current: string, previous: string }) → payload|null
//
// Tries `secrets.current` first, then `secrets.previous`. Returns null on
// total miss. Emits a warn log line on previous-match via the injected
// logger (mirrors I3 §2.1 agent-token warn-on-previous semantics).
```

### 2.2 `signJwt` (unchanged signature)

```js
signJwt(payload, secret, ttlSec) → string
// Caller is responsible for passing the current secret from the DB bundle.
```

### 2.3 Service exports

| Export | Returns |
|---|---|
| `getJwtSecretState(db)` | `{ mode: 'single'\|'dual', rotatedAt: string, previousExpiresAt: string\|null, ttlDays: number }` |
| `rotateJwtSecret(db, { logger, userId })` | `{ newSecret: string }` — operator copies this |
| `commitJwtSecret(db, { logger, userId })` | `{ ok: true }` |
| `seedJwtSecretIfMissing(db, fromAppsettings, logger)` | `{ seeded: boolean }` |

### 2.4 Admin endpoints (mounted in `routes/admin.js`)

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/api/admin/jwt-secret/rotate` | `{}` | `{ newSecret: '<hex>', rotatedAt: '<iso>' }` |
| `POST` | `/api/admin/jwt-secret/commit` | `{}` | `{ ok: true, committedAt: '<iso>' }` |
| `GET`  | `/api/admin/jwt-secret` | — | `{ mode, rotatedAt, previousExpiresAt, ttlDays }` |

Same `permissions: ['*']` gate as the agent-token endpoints (adminRouter uses wildcard). Auth follows the existing `userAuth` middleware.

### 2.5 `userAuth` factory (modified)

```js
// Before: userAuth({ config: { jwtSecret } })
// After:  userAuth({ db, logger })   — secret bundle loaded lazily from DB
```

`_loadJwtSecretBundle(db, sql)` is exported (with `_` prefix) for tests.

---

## §3 — Out of scope / explicitly NOT changing

- **Frontend UI** — no frontend change in this scope. The existing `401 → re-login` flow handles the rare post-commit straggler case. v2 follow-up: surface a "Rotate JWT signing secret" button in `/admin/security`.
- **JWT `token_version` revocation** — already shipped as I1. I9 is orthogonal: token_version kills per-user sessions, I9 kills all sessions signed by a particular key. The two compose (I9 rotation does NOT bump token_version, so all existing sessions remain valid; only an explicit `commit` after the rotation window closes any straggler whose JWT was signed with the old secret).
- **The `tokenVersion` claim on JWTs** — I9 does not change the JWT payload shape. Existing JWTs continue to work through the rotation window.
- **Token TTL changes** — I9 does not alter `8 * 3600` (8-hour TTL). Sessions naturally rotate as users re-login within the overlap window.
- **`JWT_SECRET` env var** — remains the boot-time fallback. After I9, the env var is only used if `appsettings.json` has no `jwtSecret` AND the DB has no row (cold start with no config). This is a defense-in-depth fallback, not a primary source.

---

## §4 — Risks and how this design responds

1. **Operator rotates, loses `newSecret` from the response, never deploys to anyone.** Result: every JWT signed with the OLD secret still verifies. The new secret is dormant. No operator-visible harm — they can rotate again or simply ignore. Auto-expire cleans it up in 30 days.

2. **Operator rotates, deploys new secret to a downstream issuer (e.g., a future microservice), then commits too eagerly.** Result: any operator still logged in with a pre-rotation JWT 401s. Mitigation: the 8-hour TTL means the worst-case straggler window is 8 hours; overlap window by default is operator-controlled (rotate → commit takes as long as the operator needs).

3. **`PUT /api/admin/config` lets an operator write `jwt_secret_current` directly without going through the rotate endpoint.** Mitigation (matches I3 Minor 3): this is a known hazard, parked for a follow-up spec. v2 follow-up: add a 400 guard rejecting `jwt_secret_*` keys at the generic config endpoint, or invalidate the userAuth cache in that route's commit hook.

4. **Multi-process center.** The cache is module-level and process-local. In a multi-process deploy, each process independently caches and invalidates. A rotate invalidates only the process that handled the rotate request; other processes serve stale (previous = empty) for up to one request after they next read the bundle. Mitigation (matches I3 Minor 4): single-process is the documented deploy model for this project; multi-process is parked as v2.

5. **TTL auto-expiry only runs at startup.** Same as I3 Minor 4. If the center runs continuously past the TTL, the previous secret lingers until the next boot. v2 follow-up: periodic timer.

---

## §5 — Logging & audit

| Event | Severity | Fields |
|---|---|---|
| JWT secret seeded from appsettings | `info` | `{ key: 'jwt_secret_current', length }` |
| JWT secret rotated | `info` | `{ userId, previousLength, newLength }` |
| JWT secret committed | `info` | `{ userId, rotatedAt }` |
| JWT secret auto-expired (TTL) | `warn` | `{ rotatedAt, ttlDays }` |
| Token verified with PREVIOUS JWT secret (warn — operator's signal that a straggler is still on the old key) | `warn` | `{ path, sub }` |
| Rotation failure | `error` | `{ err }` |

Each `info`/`error` event also writes an `audit_log` row via `writeAudit`. Action labels: `seed_jwt_secret`, `rotate_jwt_secret`, `commit_jwt_secret`, `auto_expire_jwt_secret`.

---

## §6 — Inline documentation

`center/appsettings.example.json` — add inline comment to the `jwtSecret` field:
```json
"jwtSecret": "REPLACE_WITH_GUID",  // bootstrap-only — runtime reads from system_config.jwt_secret_current (see spec 2026-08-18-dual-key-jwt-secret-rotation)
```

---

## §7 — Real-DB SQL tests

Two new tests under `center/tests/sql/`:
- `017-jwt-secret-rotate-mysql.test.js` — real MySQL apply + commit + auto-expire round-trip. Snapshot/restore all four `jwt_secret_*` rows.
- `017-jwt-secret-rotate-mssql.test.js` — same, real MSSQL.

Both gated on `TEST_MYSQL_URL` / `TEST_MSSQL_URL` env vars (skip when unset). Tests drive the actual service functions against the live driver so `db.sql.config.upsert` / `getJwtSecretBundle` are what hit the DB (per `feedback_real_db_sql_tests.md`).

---

## §8 — Mirror sync

Every modified production source file under `center/src/` has a mirror at `publish/system/center/src/...`. Each commit that touches production source must be paired with a separate `chore(publish): mirror <path> (I9)` commit. Test files are NOT mirrored.

---

## §9 — Test plan

Per-task TDD, mirroring I3's plan structure. Baseline suite is **932 pass / 0 fail / 62 skip** (center) + **86 pass / 0 fail / 1 skip** (agent). Final state should be ~+22 new tests across 7 tasks (similar to I3's +31). Whole-branch opus review at the end.