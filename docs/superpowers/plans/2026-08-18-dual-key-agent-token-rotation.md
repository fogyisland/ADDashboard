# Dual-Key Agent Token Rotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow operators to rotate the shared `agentToken` (X-Agent-Token header) without taking agents offline, by accepting both old and new during an overlap window stored in `system_config`.

**Architecture:** Move `agentToken` runtime source-of-truth from `appsettings.json` to two `system_config` rows (`agent_token_current`, `agent_token_previous`). `POST /api/admin/agent-token/rotate` and `commit` drive the overlap. `agentToken({ db })` middleware tries current then previous (warn on previous match). 30-day TTL auto-clears forgotten rotations on bootstrap.

**Tech Stack:** Node.js ESM (no new deps); `crypto.randomBytes` + `crypto.timingSafeEqual`; existing `system_config` table; existing `writeAudit` tx wrapper; existing `agentToken` middleware factory (modified in place); node:test (no vitest).

**Spec:** `docs/superpowers/specs/2026-08-18-dual-key-agent-token-rotation.md` — read in full before starting.

## Global Constraints

(Copied verbatim from spec.)

- **C1 — Single source of truth at runtime.** After bootstrap, `system_config.agent_token_current` is authoritative. `appsettings.json` `agentToken` becomes bootstrap-only.
- **C2 — No new dependencies.** Use Node built-ins and existing services.
- **C3 — writeAudit signature is `({...}, logger, tx)`.** All audit writes go through this signature; tx is the 3rd arg.
- **C4 — Dual-platform SQL** (MySQL + MSSQL). Reuse `db.sql.config.upsert` (already dialect-specific).
- **C5 — Backward compatible.** Existing single-key installs continue to work; bootstrap seeds the DB on first start. `verifyAgentToken` accepts current OR previous.
- **C6 — Log severity.** `info` on rotation start + commit; `warn` on previous-token hit; `error` only on rotation failure.
- **C7 — CWD-agnostic path resolution.** N/A.
- **C8 — Cache invalidate on rotation.** In-memory cache MUST be invalidated synchronously inside rotate/commit handlers.

## Mirror sync rule (per `feedback_publish_sync.md` SDD lesson 25)

After every commit that touches a runtime file under `center/src/`, the implementer MUST run `diff <src> <publish-mirror>` for each touched file. If non-empty: `cp <src> <publish-mirror>` + separate `chore(publish): mirror <path>` commit (one per file). Tests are NOT mirrored. Mirror locations for this plan:
- `center/src/` → `publish/system/center/src/`
- `center/server.js` → `publish/system/center/server.js`

---

## File Structure

| File | Responsibility | Lines (est.) |
|------|---------------|--------------|
| `center/src/auth/agent-token.js` (modify) | Factory `agentToken({ db })`; in-memory cache + invalidate; constant-time compare; exports `invalidateAgentTokenCache` and `_loadAgentTokenBundle` for tests. | +60 |
| `center/src/services/agent-token.js` (new) | `getAgentTokenState` / `rotateAgentToken` / `commitAgentToken` / `seedAgentTokenIfMissing`. Uses existing `db.transaction`. | ~140 |
| `center/src/db/sql.js` (modify) | Add `config.getAgentTokenBundle` (both dialects); `getAgentTokenCurrent` if needed. | +20 |
| `center/server.js` (modify) | Bootstrap IIFE: call `seedAgentTokenIfMissing(cfg.agentToken, logger)` after `seedListenPortIfMissing`. | +10 |
| `center/src/init/router.js` (modify) | Log message updated: "agentToken in appsettings.json is bootstrap-only". | +3 |
| `center/src/routes/admin.js` (modify) | 3 new endpoints: `POST /api/admin/agent-token/rotate`, `POST /api/admin/agent-token/commit`, `GET /api/admin/agent-token`. | +60 |
| `center/tests/auth/agent-token.test.js` (new) | 9 unit tests for middleware (current, previous, empty, cache, invalidate, constant-time). | ~120 |
| `center/tests/services/agent-token.test.js` (new) | 10 unit tests for service (get, rotate, commit, seed, TTL expiry). | ~180 |
| `center/tests/routes/agent-token-rotate.test.js` (new) | 7 integration tests for endpoints (200/403/audit/state shape/secret-not-returned). | ~140 |
| `center/tests/sql/016-agent-token-rotate-mysql.test.js` (new) | Real-MySQL apply + rotate + commit round-trip. Gated on `TEST_MYSQL_URL`. | ~60 |
| `center/tests/sql/016-agent-token-rotate-mssql.test.js` (new) | Real-MSSQL apply + rotate + commit round-trip. Gated on `TEST_MSSQL_URL`. | ~60 |

**Test count**: existing 895 + 9 + 10 + 7 + 2 (gated) ≈ 923 expected after this plan. 2 SQL tests skip when env vars unset (existing pattern).

---

## Task 1: `center/src/auth/agent-token.js` middleware refactor

**Files:**
- Modify: `center/src/auth/agent-token.js:1` (entire file)
- Create: `center/tests/auth/agent-token.test.js`

**Interfaces:**
- Consumes: `db` facade (`db.query(sql, params)` returning `{ rows: [{ config_key, config_value }] }`)
- Produces:
  - `agentToken({ db }) → async (req, res, next) => void` (replaces `agentToken(expected)`)
  - `invalidateAgentTokenCache() → void`
  - `_loadAgentTokenBundle(db) → Promise<{ current: string, previous: string }>` (exported with `_` prefix for tests)

- [ ] **Step 1: Write the failing tests**

Create `center/tests/auth/agent-token.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentToken, invalidateAgentTokenCache, _loadAgentTokenBundle } from '../../src/auth/agent-token.js';

// Minimal stub DB matching the interface agent-token.js reads.
function stubDb(bundle) {
  return {
    async query(_sql, _params) {
      const rows = [];
      if (bundle.current !== undefined)
        rows.push({ config_key: 'agent_token_current', config_value: bundle.current });
      if (bundle.previous !== undefined)
        rows.push({ config_key: 'agent_token_previous', config_value: bundle.previous });
      return { rows };
    }
  };
}

function buildReq(token) {
  return { headers: token ? { 'x-agent-token': token } : {} };
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

test('accepts the current token', async () => {
  invalidateAgentTokenCache();
  const mw = agentToken({ db: stubDb({ current: 'A', previous: '' }) });
  const req = buildReq('A');
  const res = buildRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(res.statusCode, 0);
});

test('accepts the previous token (rotation overlap)', async () => {
  invalidateAgentTokenCache();
  const mw = agentToken({ db: stubDb({ current: 'B', previous: 'A' }) });
  const req = buildReq('A');
  const res = buildRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(req._agentTokenMatchedPrevious, true);
});

test('rejects an unknown token', async () => {
  invalidateAgentTokenCache();
  const mw = agentToken({ db: stubDb({ current: 'B', previous: '' }) });
  const req = buildReq('Z');
  const res = buildRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
});

test('rejects when header is missing', async () => {
  invalidateAgentTokenCache();
  const mw = agentToken({ db: stubDb({ current: 'A', previous: '' }) });
  const req = buildReq(null);
  const res = buildRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
});

test('rejects empty-string header', async () => {
  invalidateAgentTokenCache();
  const mw = agentToken({ db: stubDb({ current: 'A', previous: '' }) });
  const req = buildReq('');
  const res = buildRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
});

test('caches the bundle across multiple requests', async () => {
  invalidateAgentTokenCache();
  let calls = 0;
  const db = {
    async query() { calls++; return { rows: [{ config_key: 'agent_token_current', config_value: 'A' }] }; }
  };
  const mw = agentToken({ db });
  await mw(buildReq('A'), buildRes(), () => {});
  await mw(buildReq('A'), buildRes(), () => {});
  await mw(buildReq('A'), buildRes(), () => {});
  assert.equal(calls, 1);
});

test('invalidateAgentTokenCache forces a reload', async () => {
  invalidateAgentTokenCache();
  let calls = 0;
  const db = {
    async query() { calls++; return { rows: [{ config_key: 'agent_token_current', config_value: 'A' }] }; }
  };
  const mw = agentToken({ db });
  await mw(buildReq('A'), buildRes(), () => {});
  assert.equal(calls, 1);
  invalidateAgentTokenCache();
  await mw(buildReq('A'), buildRes(), () => {});
  assert.equal(calls, 2);
});

test('_loadAgentTokenBundle returns both keys from rows', async () => {
  invalidateAgentTokenCache();
  const db = {
    async query() {
      return {
        rows: [
          { config_key: 'agent_token_current', config_value: 'A' },
          { config_key: 'agent_token_previous', config_value: 'B' }
        ]
      };
    }
  };
  const bundle = await _loadAgentTokenBundle(db);
  assert.equal(bundle.current, 'A');
  assert.equal(bundle.previous, 'B');
});

test('_loadAgentTokenBundle returns empty strings for missing rows', async () => {
  invalidateAgentTokenCache();
  const db = { async query() { return { rows: [] }; } };
  const bundle = await _loadAgentTokenBundle(db);
  assert.equal(bundle.current, '');
  assert.equal(bundle.previous, '');
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `cd center && node --test tests/auth/agent-token.test.js`
Expected: FAIL — `agentToken` is still a single-string factory; the new `_loadAgentTokenBundle` doesn't exist.

- [ ] **Step 3: Refactor `center/src/auth/agent-token.js`**

Replace the entire file with:

```js
// Shared-secret comparison middleware for the agent → center channel.
// At runtime the canonical secret lives in `system_config.agent_token_current`;
// `agent_token_previous` is set during a rotation overlap window so existing
// agents can keep using the old token while the operator rolls the new one
// out to each agent and restarts it.
//
// Comparison is constant-time via crypto.timingSafeEqual to prevent timing
// side-channels leaking the secret byte-by-byte. Mismatched-length compares
// short-circuit (length is fixed by design — 96 hex chars — so length leak
// is not sensitive).
//
// The bundle is cached for the process lifetime; invalidate via
// `invalidateAgentTokenCache()` from the rotate/commit handlers so the very
// next request sees the new state.
import crypto from 'node:crypto';

let _cache = null; // { current: string, previous: string }

export async function _loadAgentTokenBundle(db) {
  if (_cache) return _cache;
  const { rows } = await db.query(
    // SQL string injected by the caller's `db` facade; see Task 3.
    // We accept any db facade that returns { rows: [{ config_key, config_value }] }
    // for the bundle SELECT. The exact SQL lives in db.sql.config.getAgentTokenBundle.
    // (We intentionally keep this string here as a fallback for tests that
    //  construct a stub db without going through buildSql.)
    "SELECT config_key, config_value FROM system_config WHERE config_key IN ('agent_token_current', 'agent_token_previous')"
  );
  const map = Object.fromEntries(rows.map(r => [r.config_key, r.config_value]));
  _cache = {
    current: map.agent_token_current ?? '',
    previous: map.agent_token_previous ?? ''
  };
  return _cache;
}

export function invalidateAgentTokenCache() {
  _cache = null;
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function agentToken({ db }) {
  return async (req, res, next) => {
    const supplied = req.headers['x-agent-token'];
    if (typeof supplied !== 'string' || supplied === '') {
      return res.status(401).json({ error: 'invalid agent token' });
    }
    let bundle;
    try {
      bundle = await _loadAgentTokenBundle(db);
    } catch (e) {
      // Distinguish auth failure (401) from server failure (503) — an
      // operator looking at the dashboard needs to know whether the agent
      // sent a wrong token or the center can't reach its own DB.
      return res.status(503).json({ error: 'agent token lookup failed' });
    }
    if (bundle.current && constantTimeEqual(supplied, bundle.current)) return next();
    if (bundle.previous && constantTimeEqual(supplied, bundle.previous)) {
      req._agentTokenMatchedPrevious = true;
      return next();
    }
    return res.status(401).json({ error: 'invalid agent token' });
  };
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `cd center && node --test tests/auth/agent-token.test.js`
Expected: 9/9 PASS.

- [ ] **Step 5: Commit**

```bash
cd .worktrees/i3-dual-key-agent-token
git add center/src/auth/agent-token.js center/tests/auth/agent-token.test.js
git commit -m "feat(auth): agentToken({db}) middleware with dual-key overlap (I3)"
```

- [ ] **Step 6: Mirror to publish/system**

```bash
diff -q center/src/auth/agent-token.js publish/system/center/src/auth/agent-token.js
# expected: files differ
cp center/src/auth/agent-agent-token.js publish/system/center/src/auth/agent-token.js
# wait — typo above. The actual command is:
cp center/src/auth/agent-token.js publish/system/center/src/auth/agent-token.js
diff -q center/src/auth/agent-token.js publish/system/center/src/auth/agent-token.js
# expected: no output (identical)
git add publish/system/center/src/auth/agent-token.js
git commit -m "chore(publish): mirror auth/agent-token.js I3"
```

---

## Task 2: `center/src/services/agent-token.js` new service module

**Files:**
- Create: `center/src/services/agent-token.js`
- Create: `center/tests/services/agent-token.test.js`

**Interfaces:**
- Consumes: `db` facade (transaction, execute, query). `db.sql.config.upsert`, `db.sql.config.getAgentTokenBundle`, `db.sql.audit.write` (existing).
- Produces:
  - `getAgentTokenState(db) → Promise<{ current: string, previous: string, rotatedAt: string, ttlDays: number, previousExpiresAt: string|null }>`
  - `rotateAgentToken(db, { logger, userId }) → Promise<{ newToken: string, rotatedAt: string }>`
  - `commitAgentToken(db, { logger, userId }) → Promise<{ ok: true }>`
  - `seedAgentTokenIfMissing(db, fromAppsettings, logger) → Promise<{ seeded: boolean, current: string }>`

- [ ] **Step 1: Write the failing tests**

Create `center/tests/services/agent-token.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMockDb } from '../helpers/db-mock.js';
import {
  getAgentTokenState,
  rotateAgentToken,
  commitAgentToken,
  seedAgentTokenIfMissing
} from '../../src/services/agent-token.js';

const noopLogger = { info(){}, warn(){}, error(){}, debug(){} };

function bundleRows({ current = '', previous = '', rotatedAt = '', ttlDays = '30' } = {}) {
  const rows = [];
  if (current !== null) rows.push({ config_key: 'agent_token_current', config_value: current });
  if (previous !== null) rows.push({ config_key: 'agent_token_previous', config_value: previous });
  if (rotatedAt !== null) rows.push({ config_key: 'agent_token_rotated_at', config_value: rotatedAt });
  if (ttlDays !== null) rows.push({ config_key: 'agent_token_previous_ttl_days', config_value: ttlDays });
  return rows;
}

test('getAgentTokenState: returns both keys', async () => {
  const db = buildMockDb([{
    match: /agent_token/i,
    rows: bundleRows({ current: 'A', previous: 'OLD' })
  }]).standard();
  const s = await getAgentTokenState(db);
  assert.equal(s.current, 'A');
  assert.equal(s.previous, 'OLD');
});

test('getAgentTokenState: empty defaults when no rows', async () => {
  const db = buildMockDb([{ match: /agent_token/i, rows: [] }]).standard();
  const s = await getAgentTokenState(db);
  assert.equal(s.current, '');
  assert.equal(s.previous, '');
  assert.equal(s.ttlDays, 30);
});

test('rotateAgentToken: writes previous + current + rotated_at + audit in one tx', async () => {
  const records = [];
  const db = buildMockDb([
    { match: /agent_token/i, rows: bundleRows({ current: 'OLD' }) }
  ]).withRecording(records);
  const r = await rotateAgentToken(db, { logger: noopLogger, userId: 'u1' });
  assert.match(r.newToken, /^[a-f0-9]{96}$/);
  assert.match(r.rotatedAt, /^\d{4}-\d{2}-\d{2}T/);
  // Should have upserted previous (OLD), current (new), rotated_at
  const upserts = records.filter(x => /system_config/i.test(x.sql));
  const keys = upserts.map(u => u.params[0]);
  assert.ok(keys.includes('agent_token_previous'));
  assert.ok(keys.includes('agent_token_current'));
  assert.ok(keys.includes('agent_token_rotated_at'));
  // Should have written an audit row
  const audits = records.filter(x => /audit/i.test(x.sql));
  assert.ok(audits.length >= 1);
});

test('commitAgentToken: clears previous and rotated_at, writes audit', async () => {
  const records = [];
  const db = buildMockDb([
    { match: /agent_token/i, rows: bundleRows({ current: 'NEW', previous: 'OLD' }) }
  ]).withRecording(records);
  const r = await commitAgentToken(db, { logger: noopLogger, userId: 'u1' });
  assert.deepEqual(r, { ok: true });
  const upserts = records.filter(x => /system_config/i.test(x.sql));
  const prev = upserts.find(u => u.params[0] === 'agent_token_previous');
  const rot = upserts.find(u => u.params[0] === 'agent_token_rotated_at');
  assert.equal(prev.params[1], '');
  assert.equal(rot.params[1], '');
  const audits = records.filter(x => /audit/i.test(x.sql));
  assert.ok(audits.length >= 1);
});

test('commitAgentToken: no-op when no previous', async () => {
  const records = [];
  const db = buildMockDb([
    { match: /agent_token/i, rows: bundleRows({ current: 'NEW', previous: '' }) }
  ]).withRecording(records);
  const r = await commitAgentToken(db, { logger: noopLogger, userId: 'u1' });
  assert.deepEqual(r, { ok: true });
  // No audit row written — no-op
  const audits = records.filter(x => /audit/i.test(x.sql));
  assert.equal(audits.length, 0);
});

test('seedAgentTokenIfMissing: seeds all 4 rows when absent', async () => {
  const records = [];
  const db = buildMockDb([
    { match: /agent_token/i, rows: [] }
  ]).withRecording(records);
  const r = await seedAgentTokenIfMissing(db, 'from-appsettings', noopLogger);
  assert.equal(r.seeded, true);
  assert.equal(r.current, 'from-appsettings');
  const keys = records.map(x => x.params[0]).filter(k => k.startsWith('agent_token'));
  assert.ok(keys.includes('agent_token_current'));
  assert.ok(keys.includes('agent_token_previous'));
  assert.ok(keys.includes('agent_token_rotated_at'));
  assert.ok(keys.includes('agent_token_previous_ttl_days'));
});

test('seedAgentTokenIfMissing: idempotent when current row exists', async () => {
  const records = [];
  const db = buildMockDb([
    { match: /agent_token_current/i, rows: bundleRows({ current: 'EXISTING' }) }
  ]).withRecording(records);
  const r = await seedAgentTokenIfMissing(db, 'from-appsettings', noopLogger);
  assert.equal(r.seeded, false);
  assert.equal(r.current, 'EXISTING');
  const upserts = records.filter(x => /system_config/i.test(x.sql));
  assert.equal(upserts.length, 0);
});

test('seedAgentTokenIfMissing: auto-expires previous past TTL', async () => {
  const records = [];
  const oldDate = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString();
  const db = buildMockDb([
    { match: /agent_token/i, rows: bundleRows({ current: 'NEW', previous: 'OLD', rotatedAt: oldDate, ttlDays: '30' }) }
  ]).withRecording(records);
  const r = await seedAgentTokenIfMissing(db, 'from-appsettings', noopLogger);
  assert.equal(r.seeded, false);
  // Should have cleared previous + rotated_at
  const prev = records.find(x => x.params[0] === 'agent_token_previous');
  const rot = records.find(x => x.params[0] === 'agent_token_rotated_at');
  assert.equal(prev.params[1], '');
  assert.equal(rot.params[1], '');
});

test('seedAgentTokenIfMissing: does NOT expire within TTL', async () => {
  const records = [];
  const recent = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
  const db = buildMockDb([
    { match: /agent_token/i, rows: bundleRows({ current: 'NEW', previous: 'OLD', rotatedAt: recent, ttlDays: '30' }) }
  ]).withRecording(records);
  await seedAgentTokenIfMissing(db, 'from-appsettings', noopLogger);
  // No clears
  const upserts = records.filter(x => /system_config/i.test(x.sql));
  assert.equal(upserts.length, 0);
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `cd center && node --test tests/services/agent-token.test.js`
Expected: FAIL — `services/agent-token.js` does not exist.

- [ ] **Step 3: Implement `center/src/services/agent-token.js`**

Create the file with:

```js
// Service for the dual-key agent-token rotation mechanism. Reads/writes
// four rows in `system_config`:
//   agent_token_current           — runtime source of truth
//   agent_token_previous          — old token during overlap window
//   agent_token_rotated_at        — ISO 8601 when previous was set
//   agent_token_previous_ttl_days — auto-expiry threshold (default 30)
//
// Rotations and commits are atomic via `db.transaction` so the previous →
// current swap is never half-applied. Every mutation writes a `writeAudit`
// row so the operator's "who rotated when" question has a deterministic
// answer.
import { randomBytes } from 'node:crypto';
import { writeAudit } from './audit.js';

const ROTATE_AUDIT = 'rotate_agent_token';
const COMMIT_AUDIT = 'commit_agent_token';
const SEED_AUDIT = 'seed_agent_token';

function bundleKey() {
  return 'agent_token';
}

function readBundle(db, query) {
  const sql = db.sql.config.getAgentTokenBundle;
  return query(sql).then(({ rows }) => {
    const map = Object.fromEntries((rows || []).map(r => [r.config_key, r.config_value]));
    return {
      current: map.agent_token_current ?? '',
      previous: map.agent_token_previous ?? '',
      rotatedAt: map.agent_token_rotated_at ?? '',
      ttlDays: Number(map.agent_token_previous_ttl_days || 30)
    };
  });
}

function expiresAt(rotatedAt, ttlDays) {
  if (!rotatedAt) return null;
  const t = Date.parse(rotatedAt);
  if (!Number.isFinite(t)) return null;
  return new Date(t + ttlDays * 24 * 3600 * 1000).toISOString();
}

export async function getAgentTokenState(db) {
  const b = await readBundle(db, (sql) => db.query(sql));
  return { ...b, previousExpiresAt: expiresAt(b.rotatedAt, b.ttlDays) };
}

export async function rotateAgentToken(db, { logger, userId }) {
  let newToken;
  let rotatedAt;
  await db.transaction(async (tx) => {
    const before = await readBundle(db, (sql) => tx.query(sql));
    newToken = randomBytes(48).toString('hex');
    rotatedAt = new Date().toISOString();
    const upsert = db.sql.config.upsert;
    await tx.execute(upsert, ['agent_token_previous', before.current]);
    await tx.execute(upsert, ['agent_token_current', newToken]);
    await tx.execute(upsert, ['agent_token_rotated_at', rotatedAt]);
    await writeAudit({
      userId,
      action: ROTATE_AUDIT,
      target: 'system_config',
      payload: {
        previousLength: before.current.length,
        newLength: newToken.length,
        rotatedAt
      },
      logger
    }, logger, tx);
  });
  logger?.info?.({ userId, newLength: newToken.length, rotatedAt }, 'agent token rotated');
  return { newToken, rotatedAt };
}

export async function commitAgentToken(db, { logger, userId }) {
  await db.transaction(async (tx) => {
    const before = await readBundle(db, (sql) => tx.query(sql));
    if (!before.previous) {
      logger?.info?.({ userId }, 'commit_agent_token: no-op (no previous token)');
      return;
    }
    const upsert = db.sql.config.upsert;
    await tx.execute(upsert, ['agent_token_previous', '']);
    await tx.execute(upsert, ['agent_token_rotated_at', '']);
    await writeAudit({
      userId,
      action: COMMIT_AUDIT,
      target: 'system_config',
      payload: { committedAt: new Date().toISOString() },
      logger
    }, logger, tx);
  });
  logger?.info?.({ userId }, 'agent token committed');
  return { ok: true };
}

export async function seedAgentTokenIfMissing(db, fromAppsettings, logger) {
  const before = await readBundle(db, (sql) => db.query(sql));
  if (!before.current) {
    // Seed all 4 rows
    const upsert = db.sql.config.upsert;
    await db.execute(upsert, ['agent_token_current', fromAppsettings]);
    await db.execute(upsert, ['agent_token_previous', '']);
    await db.execute(upsert, ['agent_token_rotated_at', '']);
    await db.execute(upsert, ['agent_token_previous_ttl_days', '30']);
    await writeAudit({
      userId: null,
      action: SEED_AUDIT,
      target: 'system_config',
      payload: { source: 'appsettings.json', length: fromAppsettings.length },
      logger
    }, logger);
    logger?.info?.({ length: fromAppsettings.length }, 'seeded agent token from appsettings.json');
    return { seeded: true, current: fromAppsettings };
  }
  // Auto-expire check
  if (before.previous && before.rotatedAt && before.ttlDays > 0) {
    const ageMs = Date.now() - Date.parse(before.rotatedAt);
    if (Number.isFinite(ageMs) && ageMs > before.ttlDays * 24 * 3600 * 1000) {
      const upsert = db.sql.config.upsert;
      await db.execute(upsert, ['agent_token_previous', '']);
      await db.execute(upsert, ['agent_token_rotated_at', '']);
      logger?.warn?.({ rotatedAt: before.rotatedAt, ttlDays: before.ttlDays }, 'previous agent token expired by TTL; auto-cleared');
      return { seeded: false, current: before.current, autoExpired: true };
    }
  }
  return { seeded: false, current: before.current };
}

// Re-export the bundle key so other modules can introspect (e.g. audit
// filters). Currently unused but exported for symmetry with the four-row
// schema documented in the spec.
export const AGENT_TOKEN_BUNDLE_KEYS = [
  'agent_token_current',
  'agent_token_previous',
  'agent_token_rotated_at',
  'agent_token_previous_ttl_days'
];
// Suppress unused warning for bundleKey (kept for potential future use).
void bundleKey;
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `cd center && node --test tests/services/agent-token.test.js`
Expected: 10/10 PASS.

- [ ] **Step 5: Commit**

```bash
cd .worktrees/i3-dual-key-agent-token
git add center/src/services/agent-token.js center/tests/services/agent-token.test.js
git commit -m "feat(services): agent-token rotate/commit/seed service (I3)"
```

- [ ] **Step 6: Mirror to publish/system**

```bash
cp center/src/services/agent-token.js publish/system/center/src/services/agent-token.js
diff -q center/src/services/agent-token.js publish/system/center/src/services/agent-token.js
git add publish/system/center/src/services/agent-token.js
git commit -m "chore(publish): mirror services/agent-token.js I3"
```

---

## Task 3: `center/src/db/sql.js` add bundle SELECT strings (MySQL + MSSQL)

**Files:**
- Modify: `center/src/db/sql.js` (find the `config:` block in `mysql` and `mssql` namespaces; add `getAgentTokenBundle`)

- [ ] **Step 1: Add the bundle SELECT to the MySQL config namespace**

In `center/src/db/sql.js`, find the MySQL `config:` object and add:

```js
getAgentTokenBundle: `SELECT config_key, config_value FROM system_config WHERE config_key IN ('agent_token_current', 'agent_token_previous', 'agent_token_rotated_at', 'agent_token_previous_ttl_days')`,
```

- [ ] **Step 2: Add the bundle SELECT to the MSSQL config namespace**

In the same file, find the MSSQL `config:` object and add the same string (dialect-agnostic — both accept this query syntax).

- [ ] **Step 3: Verify the strings build without error**

Run: `cd center && node -e "import('./src/db/sql.js').then(m => { console.log('mysql:', m.buildSql('mysql').config.getAgentTokenBundle); console.log('mssql:', m.buildSql('mssql').config.getAgentTokenBundle); })"`
Expected: both strings printed, both containing `agent_token_current` and `agent_token_previous`.

- [ ] **Step 4: Run center tests, no regressions**

Run: `cd center && npm test 2>&1 | tail -20`
Expected: 895/0/60 still (the new SQL string is referenced by service module which already passes its tests with the buildMockDb mock; real-DB tests come in Task 6).

- [ ] **Step 5: Commit**

```bash
git add center/src/db/sql.js
git commit -m "feat(db): add getAgentTokenBundle SQL (MySQL + MSSQL) (I3)"
```

- [ ] **Step 6: Mirror to publish/system**

```bash
diff -q center/src/db/sql.js publish/system/center/src/db/sql.js
cp center/src/db/sql.js publish/system/center/src/db/sql.js
diff -q center/src/db/sql.js publish/system/center/src/db/sql.js
git add publish/system/center/src/db/sql.js
git commit -m "chore(publish): mirror db/sql.js I3"
```

---

## Task 4: Bootstrap wiring (`center/server.js` + `center/src/init/router.js`)

**Files:**
- Modify: `center/server.js` (find the bootstrap IIFE after `seedListenPortIfMissing`)
- Modify: `center/src/init/router.js` (update the log message in `finalize`)

- [ ] **Step 1: Add seedAgentTokenIfMissing call in server.js bootstrap**

Find the bootstrap IIFE (near `await seedListenPortIfMissing(logger)`). Add immediately after it:

```js
    // I3: seed agent-token bundle from appsettings.json on first boot.
    // After this point, runtime reads from system_config.agent_token_current;
    // appsettings.json is bootstrap-only. Idempotent.
    const { seedAgentTokenIfMissing } = await import('./src/services/agent-token.js');
    await seedAgentTokenIfMissing(cfg.agentToken, logger);
```

- [ ] **Step 2: Update init/router.js log message**

In `center/src/init/router.js` line ~131, find the `ensureSecret` warning. Update its message to mention bootstrap-only:

```js
        logger.warn({ label, length: generated.length }, 'init finalize: secret missing/empty — generated fresh secret (bootstrap-only; runtime reads from system_config)');
```

- [ ] **Step 3: Run center tests, no regressions**

Run: `cd center && npm test 2>&1 | tail -10`
Expected: 895/0/60 (no test counts change — bootstrap wiring is verified by integration tests in Task 6).

- [ ] **Step 4: Commit**

```bash
git add center/server.js center/src/init/router.js
git commit -m "feat(bootstrap): seedAgentTokenIfMissing in startup IIFE (I3)"
```

- [ ] **Step 5: Mirror to publish/system**

```bash
diff -q center/server.js publish/system/center/server.js
cp center/server.js publish/system/center/server.js
diff -q center/server.js publish/system/center/server.js
git add publish/system/center/server.js
git commit -m "chore(publish): mirror server.js I3"

diff -q center/src/init/router.js publish/system/center/src/init/router.js
cp center/src/init/router.js publish/system/center/src/init/router.js
diff -q center/src/init/router.js publish/system/center/src/init/router.js
git add publish/system/center/src/init/router.js
git commit -m "chore(publish): mirror init/router.js I3"
```

---

## Task 5: `center/src/routes/admin.js` three new endpoints

**Files:**
- Modify: `center/src/routes/admin.js` (add three handlers)
- Create: `center/tests/routes/agent-token-rotate.test.js`

**Interfaces:**
- `POST /api/admin/agent-token/rotate` (admin perm) → `{ newToken, rotatedAt }`
- `POST /api/admin/agent-token/commit` (admin perm) → `{ ok: true }`
- `GET /api/admin/agent-token` (admin perm) → `{ mode, rotatedAt, previousExpiresAt, ttlDays }` (NEVER secret)

- [ ] **Step 1: Write the failing integration tests**

Create `center/tests/routes/agent-token-rotate.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { adminRouter } from '../../src/routes/admin.js';
import { signJwt } from '../../src/auth/jwt.js';
import { buildMockDb } from '../helpers/db-mock.js';

const SECRET = 'test-secret-please-do-not-use-in-prod';

function buildApp(db) {
  const a = express();
  a.use(express.json());
  const config = { jwtSecret: SECRET };
  const logger = { info(){}, error(){}, warn(){}, debug(){} };
  a.use(adminRouter({ config, logger, db }));
  return a;
}

function adminToken() {
  return signJwt({ sub: 'u1', role: 'admin', permissions: ['admin:config'] }, SECRET, 60);
}

function operatorToken() {
  return signJwt({ sub: 'u2', role: 'operator', permissions: ['dashboard:view'] }, SECRET, 60);
}

// Operator/perm gate uses existing requirePerm('admin:config') — match what
// the existing /api/admin/config PUT uses. We grant admin:config to admins.

test('POST /rotate returns 200 with new token for admin', async () => {
  const db = buildMockDb([{
    match: /agent_token/i,
    rows: [{ config_key: 'agent_token_current', config_value: 'OLD' }]
  }]).standard();
  const app = buildApp(db);
  const r = await supertest(app)
    .post('/api/admin/agent-token/rotate')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.match(r.body.newToken, /^[a-f0-9]{96}$/);
  assert.match(r.body.rotatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('POST /rotate returns 403 for non-admin', async () => {
  const db = buildMockDb([]).standard();
  const app = buildApp(db);
  const r = await supertest(app)
    .post('/api/admin/agent-token/rotate')
    .set('Authorization', `Bearer ${operatorToken()}`);
  assert.equal(r.status, 403);
});

test('POST /rotate writes audit row', async () => {
  const records = [];
  const db = buildMockDb([{
    match: /agent_token/i,
    rows: [{ config_key: 'agent_token_current', config_value: 'OLD' }]
  }]).withRecording(records);
  const app = buildApp(db);
  await supertest(app)
    .post('/api/admin/agent-token/rotate')
    .set('Authorization', `Bearer ${adminToken()}`);
  const audits = records.filter(x => /audit/i.test(x.sql));
  assert.ok(audits.length >= 1, 'expected at least one audit row');
});

test('POST /commit returns 200 and clears previous', async () => {
  const records = [];
  const db = buildMockDb([{
    match: /agent_token/i,
    rows: [
      { config_key: 'agent_token_current', config_value: 'NEW' },
      { config_key: 'agent_token_previous', config_value: 'OLD' }
    ]
  }]).withRecording(records);
  const app = buildApp(db);
  const r = await supertest(app)
    .post('/api/admin/agent-token/commit')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  // Should have upserted previous=''
  const prev = records.find(x => x.params[0] === 'agent_token_previous');
  assert.equal(prev.params[1], '');
});

test('GET /agent-token returns mode=single when no previous', async () => {
  const db = buildMockDb([{
    match: /agent_token/i,
    rows: [{ config_key: 'agent_token_current', config_value: 'A' }]
  }]).standard();
  const app = buildApp(db);
  const r = await supertest(app)
    .get('/api/admin/agent-token')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'single');
  assert.equal(r.body.rotatedAt, null);
  // MUST NOT include the secret
  assert.equal(r.body.current, undefined);
  assert.equal(r.body.previous, undefined);
  assert.equal(r.body.newToken, undefined);
});

test('GET /agent-token returns mode=dual when previous is set', async () => {
  const db = buildMockDb([{
    match: /agent_token/i,
    rows: [
      { config_key: 'agent_token_current', config_value: 'NEW' },
      { config_key: 'agent_token_previous', config_value: 'OLD' },
      { config_key: 'agent_token_rotated_at', config_value: '2026-08-18T00:00:00.000Z' },
      { config_key: 'agent_token_previous_ttl_days', config_value: '30' }
    ]
  }]).standard();
  const app = buildApp(db);
  const r = await supertest(app)
    .get('/api/admin/agent-token')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'dual');
  assert.equal(r.body.rotatedAt, '2026-08-18T00:00:00.000Z');
  assert.match(r.body.previousExpiresAt, /^\d{4}-\d{2}-\d{2}T/);
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `cd center && node --test tests/routes/agent-token-rotate.test.js`
Expected: FAIL — endpoints don't exist (404).

- [ ] **Step 3: Add the three endpoints in `center/src/routes/admin.js`**

Find the imports at the top of the file. Add:

```js
import { rotateAgentToken, commitAgentToken, getAgentTokenState } from '../services/agent-token.js';
import { invalidateAgentTokenCache } from '../auth/agent-token.js';
```

Then find a good location for the three endpoints (after the existing `/api/admin/agent-token` block, or just before the audit endpoints). Add:

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
      const s = await getAgentTokenState(db);
      res.json({
        mode: s.previous ? 'dual' : 'single',
        rotatedAt: s.rotatedAt || null,
        previousExpiresAt: s.previousExpiresAt || null,
        ttlDays: s.ttlDays
      });
    } catch (e) {
      logger.error({ err: e }, 'agent token state get failed');
      res.status(500).json({ error: 'state get failed' });
    }
  });
```

- [ ] **Step 4: Run the integration tests, verify they pass**

Run: `cd center && node --test tests/routes/agent-token-rotate.test.js`
Expected: 7/7 PASS.

- [ ] **Step 5: Run full center suite, no regressions**

Run: `cd center && npm test 2>&1 | tail -10`
Expected: 922/0/60 (was 895, +27 new tests: 9 middleware + 10 service + 7 routes + 1 already-existing audit-related…verify count matches).

- [ ] **Step 6: Commit**

```bash
git add center/src/routes/admin.js center/tests/routes/agent-token-rotate.test.js
git commit -m "feat(admin): agent-token rotate/commit/state endpoints (I3)"
```

- [ ] **Step 7: Mirror to publish/system**

```bash
diff -q center/src/routes/admin.js publish/system/center/src/routes/admin.js
cp center/src/routes/admin.js publish/system/center/src/routes/admin.js
diff -q center/src/routes/admin.js publish/system/center/src/routes/admin.js
git add publish/system/center/src/routes/admin.js
git commit -m "chore(publish): mirror routes/admin.js I3"
```

---

## Task 6: Real-DB SQL tests (MySQL + MSSQL)

**Files:**
- Create: `center/tests/sql/016-agent-token-rotate-mysql.test.js`
- Create: `center/tests/sql/016-agent-token-rotate-mssql.test.js`

Both gated on `TEST_MYSQL_URL` / `TEST_MSSQL_URL` env vars. Skip when unset (existing pattern).

- [ ] **Step 1: Write the MySQL test**

Create `center/tests/sql/016-agent-token-rotate-mysql.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

const URL = process.env.TEST_MYSQL_URL;
const skip = !URL;
if (skip) console.log('[skip] TEST_MYSQL_URL unset');

test('mysql: rotate + commit round-trip on system_config', { skip }, async () => {
  const mysql = await import('mysql2/promise');
  const conn = await mysql.createConnection(URL);
  try {
    // Setup: write current=OLD, previous=''
    await conn.execute(
      `INSERT INTO system_config (config_key, config_value) VALUES
        ('agent_token_current', ?),
        ('agent_token_previous', ''),
        ('agent_token_rotated_at', ''),
        ('agent_token_previous_ttl_days', '30')
       ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
      ['OLD']
    );
    // Verify rotate semantics (simulating the service call manually)
    await conn.execute(
      `UPDATE system_config SET config_value = (SELECT config_value FROM (SELECT config_value FROM system_config WHERE config_key = 'agent_token_current') AS x) WHERE config_key = 'agent_token_previous'`
    );
    await conn.execute(
      `UPDATE system_config SET config_value = ? WHERE config_key = 'agent_token_current'`,
      ['NEW']
    );
    const [rows1] = await conn.execute(
      `SELECT config_key, config_value FROM system_config WHERE config_key IN ('agent_token_current', 'agent_token_previous')`
    );
    const map1 = Object.fromEntries(rows1.map(r => [r.config_key, r.config_value]));
    assert.equal(map1.agent_token_current, 'NEW');
    assert.equal(map1.agent_token_previous, 'OLD');
    // Commit
    await conn.execute(`UPDATE system_config SET config_value = '' WHERE config_key IN ('agent_token_previous', 'agent_token_rotated_at')`);
    const [rows2] = await conn.execute(
      `SELECT config_key, config_value FROM system_config WHERE config_key IN ('agent_token_current', 'agent_token_previous')`
    );
    const map2 = Object.fromEntries(rows2.map(r => [r.config_key, r.config_value]));
    assert.equal(map2.agent_token_current, 'NEW');
    assert.equal(map2.agent_token_previous, '');
  } finally {
    await conn.end();
  }
});
```

- [ ] **Step 2: Write the MSSQL test**

Create `center/tests/sql/016-agent-token-rotate-mssql.test.js` (similar shape, using `mssql` driver and `MERGE` syntax for the initial upsert). Follow the same `if (!URL) skip` pattern.

- [ ] **Step 3: Run the SQL tests**

Run: `cd center && node --test tests/sql/016-agent-token-rotate-mysql.test.js tests/sql/016-agent-token-rotate-mssql.test.js`
Expected: skip (when env vars unset) OR pass (when set). Verify the skip output appears.

- [ ] **Step 4: Commit**

```bash
git add center/tests/sql/016-agent-token-rotate-mysql.test.js center/tests/sql/016-agent-token-rotate-mssql.test.js
git commit -m "test(sql): real-MySQL/MSSQL rotate round-trip for I3"
```

(No publish mirror — tests are NOT mirrored, per `feedback_publish_sync.md`.)

---

## Task 7: Whole-branch opus review

**Files:** none — read-only review.

- [ ] **Step 1: Generate the review package**

Run from the plan file: `node scripts/review-package plans/2026-08-18-dual-key-agent-token-rotation.md <BASE> <HEAD>` — the printed path is the review package the reviewer reads.

(BASE = the commit before Task 1, HEAD = current.)

- [ ] **Step 2: Dispatch opus reviewer**

Use a fresh `general-purpose` subagent with `model: opus`. Hand it the review package + spec + plan + brief. Ask it to verdict each finding against spec + plan + diff.

- [ ] **Step 3: Address findings**

If findings exist, dispatch fix rounds (same pattern as I1). Each fix round = implementer + scoped re-review. Max 5 rounds (per subagent-driven-development skill).

- [ ] **Step 4: Final merge + push**

Once review is clean, merge to main (Option 1 from finishing-a-development-branch). Push via proxy:

```bash
git -c http.proxy=http://127.0.0.1:10808 -c https.proxy=http://127.0.0.1:10808 push origin feat/i3-dual-key-agent-token:main
```

(Or merge to main locally first if single-branch workflow is preferred.)

---

## Out of scope for this plan

- Frontend UI for rotate/commit (operators use `curl` or future UI work)
- Per-agent tokens (each agent gets its own secret)
- Auto-rotate cron
- Removing `agentToken` requirement from `config.js` TOP_LEVEL_REQUIRED
- Migration cleanup of the unused `agent_token` config_key row