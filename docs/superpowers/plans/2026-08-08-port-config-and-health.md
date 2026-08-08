# Port Config UI + Center Self-Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Edit the three listening ports (web `listenPort`, `heartbeat_port`, `report_port`) from the admin UI; detect "port open but service dead" by self-probing all three ports from inside center every second; show the result in the existing `HeartbeatReportMonitorView` page.

**Architecture:** Move `listenPort` from `appsettings.json` into the `system_config` table (the other two ports already live there). New `probe_state` table holds 3 rows (`web` / `heartbeat` / `report`) updated each tick by a 1 Hz loop in `center/src/services/probe.js`. Mount `healthzRouter` on all three apps (today only on web). Restart detection via a pair of `center_listen_port_*_version` keys in `system_config`: pending (UI-driven) vs started (center writes on boot) — mismatch surfaces an inline badge in ConfigView. New admin endpoint `GET /api/admin/heartbeat-report/probe` exposes probe state; new summary panel at the top of `HeartbeatReportMonitorView` shows three port rows with green/yellow/red dots driven by probe status.

**Tech Stack:** Node 18+ HTTP server, Express, `node:test` (backend), vitest + @vue/test-utils (frontend), `node:crypto` (sha256 for version hash), existing `buildMockDb` pattern, `superagent`/`AbortSignal.timeout` for probe fetch.

## Global Constraints

[From spec `docs/superpowers/specs/2026-08-08-port-config-and-health.md`]

- **Default ports** — `web=8080` (was `listenPort`), `heartbeat=8081`, `report=8082`. Existing behavior preserved when no DB override.
- **DB-first config** — `listenPort`, `heartbeat_port`, `report_port`, `heartbeat_stale_seconds` all live in `system_config` after this plan. `appsettings.json` keeps `listenPort` as a first-boot fallback only.
- **First-boot seed** — On first center start with no `system_config.listenPort` row, the value from `appsettings.json` is seeded into DB. Subsequent boots read from DB.
- **Probe cadence** — 1 Hz; each tick writes the result row immediately (no batching). Three rows; I/O negligible.
- **Probe scope** — Hits `http://localhost:<port>/healthz` on each of the three ports; 2 s timeout. Failure / timeout / non-200 → `status=degraded`, `consecutive_failures++`.
- **Healthz scope** — `healthzRouter` mounted on `webApp`, `heartbeatApp`, and `reportApp` (currently only on webApp via `createApp`).
- **Healthz DB check preserved** — The handler still does `db.healthcheck()` + last-heartbeat query. Slow DB will surface as `degraded` (accepted by user as expected semantics).
- **Audit on transition only** — `writeAudit({action: 'probe_state_changed', target: port_role, payload})` fires once per status flip (healthy↔degraded), NOT every tick.
- **Restart detection** — `center_listen_port_pending_version` (UI save bumps it) vs `center_listen_port_started_version` (center writes on bootstrap). Mismatch + pending not null → `restartRequired.listenPort = true` in `GET /api/admin/config` response (boolean is **computed**, not stored).
- **Version hash** — First 16 hex chars (8 bytes) of `sha256(<ISO timestamp>:<listenPort value>)`.
- **Bootstrap fail-fast** — If `probe_state` table missing on center start, refuse to enter normal mode with explicit "migration 012 not applied" log.
- **Bootstrap watchdog** — One-shot audit warning after 30 s with no probe write (catches probe loop itself crashing).
- **Auth** — `GET /probe` uses existing `[userAuth, requirePerm('admin:users')]` middleware (same as the other heartbeat-report endpoints).
- **ConfigView UX** — Inline red "待重启" badge on `listenPort` row only when `restartRequired.listenPort === true`. No badge for heartbeat/report (those auto-propagate via agent cache).
- **Real-DB SQL tests** — Every new SQL string requires a paired `tests/sql/*.test.js` gated on `TEST_MYSQL_URL` / `TEST_MSSQL_URL` (per `feedback_real_db_sql_tests.md`).
- **publish/ mirror** — Task 8 mirrors every new/modified source file (NOT tests) to `publish/`, rebuilds `frontend/dist`, regenerates `publish.zip`.
- **PowerShell 5.1 compat** — N/A (no scripts touched).
- **Test counts** — Backend must stay ≥ 496 green (this plan adds ~16); frontend must stay ≥ 210 green (this plan adds ~6).

---

### Task 1: Database migration 012 — `probe_state` table + SQL helpers

**Files:**
- Create: `center/src/db/migrations/012-probe-state.sql`
- Modify: `center/src/db/sql.js` (add `probeState:` block to both `mysql` + `mssql` dialects at lines ~158 and ~395 respectively)
- Create: `center/tests/sql/probe-state.test.js`
- Mirror to: `publish/center/src/db/migrations/012-probe-state.sql`
- Mirror to: `publish/center/src/db/sql.js`

**Interfaces:**
- Consumes: existing `db.sql.<domain>.<query>` pattern; existing migration runner (auto-discovers files in `center/src/db/migrations/`)
- Produces:
  - `db.sql.probeState.getAll` — `SELECT port_role, status, latency_ms, last_probe_at, last_up_at, consecutive_failures FROM probe_state ORDER BY port_role`
  - `db.sql.probeState.upsertRow(portRole, status, latencyMs, lastProbeAt, lastUpAt, consecutiveFailures)` — both dialects; MySQL flavor uses `ON DUPLICATE KEY UPDATE`, MSSQL flavor uses `MERGE` (no native `ON DUPLICATE KEY`).
  - Migration file with `CREATE TABLE probe_state ...` + 3 INSERT seed rows (port_role values `web` / `heartbeat` / `report`, status `unknown`).

- [ ] **Step 1: Write the failing real-DB SQL test**

`center/tests/sql/probe-state.test.js` — gated on `TEST_MYSQL_URL` + `TEST_MSSQL_URL`. Reads `tests/sql/_helpers.js` (already exists in repo for migration 004 etc.). Pattern:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../../src/db/index.js';

const skip = !process.env.TEST_MYSQL_URL && !process.env.TEST_MSSQL_URL;
test('probe_state round-trip', { skip }, async () => {
  const db = getDb();
  // ensure table exists
  await db.execute(db.sql.probeState.getAll); // throws if missing
  // upsert + read back
  const role = 'web';
  await db.execute(db.sql.probeState.upsertRow(role, 'healthy', 12, '2026-08-08T10:00:00Z', '2026-08-08T10:00:00Z', 0));
  const { rows } = await db.query(db.sql.probeState.getAll);
  const row = rows.find(r => r.port_role === role);
  assert.ok(row, 'web row must exist');
  assert.strictEqual(row.status, 'healthy');
  assert.strictEqual(Number(row.latency_ms), 12);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd center && npm test -- tests/sql/probe-state.test.js`
Expected: FAIL with `db.sql.probeState is undefined` or `probe_state table doesn't exist`.

- [ ] **Step 3: Write migration `012-probe-state.sql` (both dialects)**

`center/src/db/migrations/012-probe-state.sql`:

```sql
-- MySQL
CREATE TABLE IF NOT EXISTS probe_state (
  port_role            VARCHAR(16) NOT NULL PRIMARY KEY,
  status               VARCHAR(16) NOT NULL,
  latency_ms           INT NULL,
  last_probe_at        DATETIME NULL,
  last_up_at           DATETIME NULL,
  consecutive_failures INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO probe_state (port_role, status, consecutive_failures) VALUES
  ('web',       'unknown', 0),
  ('heartbeat', 'unknown', 0),
  ('report',    'unknown', 0);
```

```sql
-- MSSQL
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'probe_state')
BEGIN
  CREATE TABLE probe_state (
    port_role            VARCHAR(16) NOT NULL PRIMARY KEY,
    status               VARCHAR(16) NOT NULL,
    latency_ms           INT NULL,
    last_probe_at        DATETIME2 NULL,
    last_up_at           DATETIME2 NULL,
    consecutive_failures INT NOT NULL DEFAULT 0,
    CONSTRAINT ck_probe_role   CHECK (port_role IN ('web','heartbeat','report')),
    CONSTRAINT ck_probe_status CHECK (status IN ('healthy','degraded','unknown'))
  );

  INSERT INTO probe_state (port_role, status, consecutive_failures) VALUES
    ('web',       'unknown', 0),
    ('heartbeat', 'unknown', 0),
    ('report',    'unknown', 0);
END
```

- [ ] **Step 4: Apply migration locally + verify table exists**

Run: `cd center && npm run migrate` (or equivalent — check `package.json` scripts; if absent, run the migration runner script used for migration 011).
Expected: log line `012-probe-state applied`.
Verify via: `mysql -uroot -p addashboard -e "SELECT * FROM probe_state"` → 3 rows with status `unknown`.

- [ ] **Step 5: Add `probeState:` SQL helpers in `center/src/db/sql.js`**

In the `mysql` block (around line 130, after the `heartbeat:` block) add:

```js
probeState: {
  getAll: 'SELECT port_role, status, latency_ms, last_probe_at, last_up_at, consecutive_failures FROM probe_state ORDER BY port_role',
  upsertRow: (portRole, status, latencyMs, lastProbeAt, lastUpAt, consecutiveFailures) =>
    `INSERT INTO probe_state (port_role, status, latency_ms, last_probe_at, last_up_at, consecutive_failures)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       status = VALUES(status),
       latency_ms = VALUES(latency_ms),
       last_probe_at = VALUES(last_probe_at),
       last_up_at = VALUES(last_up_at),
       consecutive_failures = VALUES(consecutive_failures)`
},
```

In the `mssql` block (around line 395, parallel position):

```js
probeState: {
  getAll: 'SELECT port_role, status, latency_ms, last_probe_at, last_up_at, consecutive_failures FROM probe_state ORDER BY port_role',
  upsertRow: (portRole, status, latencyMs, lastProbeAt, lastUpAt, consecutiveFailures) =>
    `MERGE INTO probe_state AS t
     USING (SELECT ? AS port_role, ? AS status, ? AS latency_ms, ? AS last_probe_at, ? AS last_up_at, ? AS consecutive_failures) AS s
     ON t.port_role = s.port_role
     WHEN MATCHED THEN UPDATE SET
       status = s.status,
       latency_ms = s.latency_ms,
       last_probe_at = s.last_probe_at,
       last_up_at = s.last_up_at,
       consecutive_failures = s.consecutive_failures
     WHEN NOT MATCHED THEN INSERT (port_role, status, latency_ms, last_probe_at, last_up_at, consecutive_failures)
       VALUES (s.port_role, s.status, s.latency_ms, s.last_probe_at, s.last_up_at, s.consecutive_failures)`
},
```

- [ ] **Step 6: Run real-DB test to verify it passes**

Run: `cd center && npm test -- tests/sql/probe-state.test.js`
Expected: 1 pass (with `TEST_MYSQL_URL` set).

- [ ] **Step 7: Run full backend suite for regressions**

Run: `cd center && npm test`
Expected: ≥ 496 pass, 0 fail (this task adds 1 real-DB test gated on env; rest stays the same).

- [ ] **Step 8: Mirror to publish/**

```bash
cp center/src/db/migrations/012-probe-state.sql publish/center/src/db/migrations/012-probe-state.sql
cp center/src/db/sql.js publish/center/src/db/sql.js
diff center/src/db/migrations/012-probe-state.sql publish/center/src/db/migrations/012-probe-state.sql && echo OK
diff center/src/db/sql.js publish/center/src/db/sql.js && echo OK
```

Note: `tests/sql/probe-state.test.js` is NOT mirrored (tests don't ship; per `feedback_full_chain_cleanup.md` + project convention).

- [ ] **Step 9: Commit**

```bash
git add center/src/db/migrations/012-probe-state.sql \
        center/src/db/sql.js \
        center/tests/sql/probe-state.test.js \
        publish/center/src/db/migrations/012-probe-state.sql \
        publish/center/src/db/sql.js
git commit -m "feat(db): migration 012 — probe_state table + upsert helpers"
```

---

### Task 2: `listenPort` DB-first config + version hash on startup + healthz on all 3 apps

**Files:**
- Modify: `center/src/config.js` (lines 27-63 + 70-81, add `getListenPort()` + `seedListenPortIfMissing()`; default `defaultConfig().listenPort` stays 8080)
- Modify: `center/src/services/config.js` (lines 7-13, add `restartRequired()` helper that compares the two version keys)
- Modify: `center/src/routes/admin.js` (lines 139-147, add `restartRequired` field to GET /config response)
- Modify: `center/server.js` (lines 34-72 `buildServerApps`, mount `healthzRouter()` on `heartbeatApp` + `reportApp`; lines 105-263 bootstrap, call `seedListenPortIfMissing` + write `center_listen_port_started_version` before `buildServerApps`)
- Create: `center/tests/config-listen-port.test.js`
- Create: `center/tests/heartbeat-report-probe-helper.test.js` (only the `restartRequired()` helper — the GET endpoint test comes in Task 5)
- Mirror to: `publish/center/src/config.js`, `publish/center/src/services/config.js`, `publish/center/src/routes/admin.js`, `publish/center/server.js`

**Interfaces:**
- Consumes: existing `getConfig()` from `services/config.js`; existing `system_config` SQL helpers; existing `healthzRouter()` factory
- Produces:
  - `getListenPort(): Promise<number>` — reads `system_config.listenPort`; if absent, returns `appsettings.json.listenPort`. **Does NOT seed.** (Seeding is a separate step taken at bootstrap.)
  - `seedListenPortIfMissing(): Promise<number>` — if `system_config.listenPort` absent, writes `appsettings.json.listenPort` to it; returns the active value (existing or seeded).
  - `restartRequired(): Promise<{listenPort: boolean}>` — compares `center_listen_port_pending_version` vs `center_listen_port_started_version`; returns `{listenPort: <pending !== started && pending != null>}`.
  - `buildServerApps` mounts `healthzRouter()` on `heartbeatApp` and `reportApp` (importing `healthzRouter` into `server.js`).
  - Bootstrap (the `if (invokedDirectly)` IIFE in `server.js`): after `getSystemConfig()`, call `seedListenPortIfMissing()` once, then set `center_listen_port_started_version = sha256Hex(nowIso + ':' + listenPort).slice(0, 16)`.

- [ ] **Step 1: Write failing test for `getListenPort` fallback**

`center/tests/config-listen-port.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getListenPort } from '../src/config.js';
import { getDb } from '../src/db/index.js';

// Stub getDb().query to return rows for `system_config.getAll`.
test('getListenPort: returns system_config.listenPort when present', async () => {
  const { getDb } = await import('../src/db/index.js');
  const origQuery = getDb().query;
  getDb().query = async (sql) => {
    if (sql.includes('system_config')) return { rows: [{ config_key: 'listenPort', config_value: '9090' }] };
    return { rows: [] };
  };
  try {
    assert.strictEqual(await getListenPort(), 9090);
  } finally { getDb().query = origQuery; }
});

test('getListenPort: falls back to appsettings.json when DB row absent', async () => {
  // Similar stub returning no listenPort row
  assert.strictEqual(await getListenPort(), 8080); // default in appsettings.example.json
});
```

(Implementer: copy the exact stub pattern from an existing `center/tests/services/` test, e.g., `audit.test.js`. The above is a sketch.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd center && npm test -- tests/config-listen-port.test.js`
Expected: FAIL with `getListenPort is not a function`.

- [ ] **Step 3: Implement `getListenPort` + `seedListenPortIfMissing` in `center/src/config.js`**

Append to the bottom of `center/src/config.js`:

```js
import { getDb } from './db/index.js';

export async function getListenPort() {
  const db = getDb();
  const { rows } = await db.query(
    "SELECT config_value FROM system_config WHERE config_key = 'listenPort'"
  );
  if (rows[0]?.config_value) {
    const n = Number(rows[0].config_value);
    if (Number.isFinite(n) && n > 0 && n < 65536) return n;
  }
  return defaultConfig().listenPort;
}

export async function seedListenPortIfMissing(logger) {
  const db = getDb();
  const { rows } = await db.query(
    "SELECT config_value FROM system_config WHERE config_key = 'listenPort'"
  );
  if (rows[0]?.config_value) {
    const n = Number(rows[0].config_value);
    if (Number.isFinite(n) && n > 0 && n < 65536) return n;
  }
  const seed = defaultConfig().listenPort;
  await db.execute(
    db.sql.config.upsert,
    ['listenPort', String(seed)]
  );
  logger?.info?.({ listenPort: seed }, 'seeded listenPort from appsettings.json');
  return seed;
}

export function sha256Hex(input) {
  // First 16 hex chars (8 bytes) of sha256 digest — matches spec §"Version hash"
  return require('node:crypto').createHash('sha256').update(input).digest('hex').slice(0, 16);
}
```

(Implementer: use ESM import for `node:crypto` instead of `require` if `config.js` is ESM. Verify by reading the top of the file.)

- [ ] **Step 4: Write failing test for `restartRequired()`**

`center/tests/heartbeat-report-probe-helper.test.js`:

```js
test('restartRequired: returns listenPort:true when pending != started', async () => {
  // stub getDb().query to return pending='abc', started='xyz'
  const out = await restartRequired();
  assert.strictEqual(out.listenPort, true);
});

test('restartRequired: returns listenPort:false when pending == started', async () => {
  // stub returns pending='abc', started='abc'
  const out = await restartRequired();
  assert.strictEqual(out.listenPort, false);
});

test('restartRequired: returns listenPort:false when pending is null (no UI save yet)', async () => {
  // stub returns pending=null
  const out = await restartRequired();
  assert.strictEqual(out.listenPort, false);
});
```

- [ ] **Step 5: Implement `restartRequired()` in `center/src/services/config.js`**

Append:

```js
export async function restartRequired() {
  const db = getDb();
  const { rows } = await db.query(
    `SELECT config_key, config_value FROM system_config
     WHERE config_key IN ('center_listen_port_pending_version', 'center_listen_port_started_version')`
  );
  const map = Object.fromEntries(rows.map(r => [r.config_key, r.config_value]));
  const pending = map.center_listen_port_pending_version ?? null;
  const started = map.center_listen_port_started_version ?? null;
  return {
    listenPort: pending != null && started != null && pending !== started
  };
}
```

- [ ] **Step 6: Run tests to verify they pass`

Run: `cd center && npm test -- tests/config-listen-port.test.js tests/heartbeat-report-probe-helper.test.js`
Expected: 5 pass.

- [ ] **Step 7: Update `GET /api/admin/config` route to include `restartRequired`**

In `center/src/routes/admin.js` line 139-147 (the GET /config handler), after fetching the config object, add:

```js
const { restartRequired } = await import('../services/config.js');
res.json({ ...cfg, restartRequired: await restartRequired() });
```

(Implementer: use the actual existing route's variable name; the snippet above is illustrative.)

- [ ] **Step 7b: Update `PUT /api/admin/config` to bump `center_listen_port_pending_version` when listenPort changes**

After the existing audit row accumulation (line 162), inside the transaction, add:

```js
if ('listenPort' in updates && String(updates.listenPort) !== String(before.listenPort)) {
  const pending = sha256Hex(`${new Date().toISOString()}:${updates.listenPort}`);
  await tx.execute(
    db.sql.config.upsert,
    ['center_listen_port_pending_version', pending]
  );
}
```

This keeps the version-hash logic server-side — frontend only sends `{listenPort: 9090}`, backend bumps the hash atomically in the same transaction. Import `sha256Hex` from `./config.js`.

- [ ] **Step 8: Modify `center/server.js` — mount healthz on 3 apps + seed + version hash**

Three edits to `server.js`:

(a) Import `healthzRouter` (add near other route imports):

```js
import { healthzRouter } from './src/routes/healthz.js';
```

(b) In `buildServerApps` (lines 50-60), add `healthzRouter()` to `heartbeatApp` and `reportApp`:

```js
heartbeatApp.use(healthzRouter());
// ...
reportApp.use(healthzRouter());
```

(Imported routers are mounted before `agentRouter` — `healthz` is unauthenticated GET, so order doesn't matter; but mount first for consistency with webApp.)

(c) In the bootstrap IIFE (after line 155, after `getSystemConfig()`), add seeding + version hash write **before** `buildServerApps`:

```js
import { seedListenPortIfMissing, getListenPort, sha256Hex } from './src/config.js';

if (!needsInit) {
  // Seed listenPort into system_config on first boot; idempotent.
  await seedListenPortIfMissing(logger);
  // Write started_version so the UI can compare against pending_version.
  const listenPort = await getListenPort();
  const startedVersion = sha256Hex(`${new Date().toISOString()}:${listenPort}`);
  await db.execute(db.sql.config.upsert, ['center_listen_port_started_version', startedVersion]);
  logger.info({ listenPort, startedVersion }, 'center listenPort bound');
}
```

(Implementer: read the current `if (invokedDirectly)` block to know exact insertion points; the snippet shows the intent.)

- [ ] **Step 9: Run full backend suite for regressions**

Run: `cd center && npm test`
Expected: ≥ 501 pass, 0 fail (5 new tests added).

- [ ] **Step 10: Mirror to publish/**

```bash
cp center/src/config.js publish/center/src/config.js
cp center/src/services/config.js publish/center/src/services/config.js
cp center/src/routes/admin.js publish/center/src/routes/admin.js
cp center/server.js publish/center/server.js
# verify byte-identical
diff center/src/config.js publish/center/src/config.js && echo OK
diff center/src/services/config.js publish/center/src/services/config.js && echo OK
diff center/src/routes/admin.js publish/center/src/routes/admin.js && echo OK
diff center/server.js publish/center/server.js && echo OK
```

- [ ] **Step 11: Commit**

```bash
git add center/src/config.js center/src/services/config.js center/src/routes/admin.js \
        center/server.js center/tests/config-listen-port.test.js \
        center/tests/heartbeat-report-probe-helper.test.js \
        publish/center/src/config.js publish/center/src/services/config.js \
        publish/center/src/routes/admin.js publish/center/server.js
git commit -m "feat(config): listenPort DB-first + restart detection + healthz on 3 apps"
```

---

### Task 3: Probe service — 1 Hz self-probe loop

**Files:**
- Create: `center/src/services/probe.js`
- Create: `center/tests/services/probe.test.js`
- Mirror to: `publish/center/src/services/probe.js`

**Interfaces:**
- Consumes: existing `db.sql.probeState.upsertRow`, `db.sql.probeState.getAll`, `writeAudit()` from `services/audit.js`; native `fetch` (Node 18+) with `AbortSignal.timeout`
- Produces:
  - `createProbeLoop({ db, ports, logger, writeAudit, fetchImpl })` returns `{ start(): void, stop(): Promise<void>, tick(): Promise<void>, isRunning(): boolean }`
  - `tick()` is exported for tests: probes all three ports in parallel, upserts each row, writes audit on status flip.
  - `start()` calls `setInterval(tick, 1000)`. `stop()` clears and awaits any in-flight tick.
  - On startup (when called for first time), verify `probe_state` table exists; throw `Error('probe_state table missing — apply migration 012')` if absent.

- [ ] **Step 1: Write failing tests for the probe loop**

`center/tests/services/probe.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProbeLoop } from '../../src/services/probe.js';

function makeStubDb() {
  const calls = [];
  return {
    calls,
    sql: {
      probeState: {
        upsertRow: (...args) => `UPSERT ${args.join(',')}`,
        getAll: 'SELECT * FROM probe_state'
      }
    },
    query: async (sql, params) => { calls.push({ kind: 'query', sql, params }); return { rows: [] }; },
    execute: async (sql, params) => { calls.push({ kind: 'execute', sql, params }); }
  };
}

test('createProbeLoop: throws when probe_state table missing on first tick', async () => {
  const db = makeStubDb();
  db.query = async () => { throw new Error("Table 'addashboard.probe_state' doesn't exist"); };
  const probe = createProbeLoop({ db, ports: { web: 8080, heartbeat: 8081, report: 8082 }, logger: { child: () => ({ info(){}, warn(){}, error(){} }) }, writeAudit: async () => {}, fetchImpl: async () => ({ ok: true }) });
  await assert.rejects(probe.tick(), /probe_state.*missing/i);
});

test('tick: probes 3 ports in parallel, upserts each row', async () => {
  const db = makeStubDb();
  let auditCalls = 0;
  const probe = createProbeLoop({
    db,
    ports: { web: 8080, heartbeat: 8081, report: 8082 },
    logger: { child: () => ({ info(){}, warn(){}, error(){} }) },
    writeAudit: async () => { auditCalls++; },
    fetchImpl: async () => ({ ok: true })
  });
  await probe.tick();
  const upserts = db.calls.filter(c => c.kind === 'execute' && c.sql.startsWith('UPSERT'));
  assert.strictEqual(upserts.length, 3);
  assert.strictEqual(auditCalls, 0); // first tick from unknown→healthy is technically a flip — see step 4
});

test('tick: 2s timeout → status=degraded, consecutive_failures increments', async () => {
  const db = makeStubDb();
  const probe = createProbeLoop({
    db, ports: { web: 8080, heartbeat: 8081, report: 8082 },
    logger: { child: () => ({ info(){}, warn(){}, error(){} }) },
    writeAudit: async () => {},
    fetchImpl: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }
  });
  await probe.tick();
  const upserts = db.calls.filter(c => c.kind === 'execute' && c.sql.startsWith('UPSERT'));
  for (const u of upserts) {
    assert.ok(u.params[1] === 'degraded', `status param should be degraded; got ${u.params[1]}`);
  }
});

test('tick: status flip (healthy → degraded) writes audit exactly once', async () => {
  const db = makeStubDb();
  let firstTickOk = true;
  const auditPayloads = [];
  const probe = createProbeLoop({
    db, ports: { web: 8080, heartbeat: 8081, report: 8082 },
    logger: { child: () => ({ info(){}, warn(){}, error(){} }) },
    writeAudit: async ({ payload }) => { auditPayloads.push(payload); },
    fetchImpl: async () => firstTickOk ? { ok: true } : { ok: false, status: 500 }
  });
  await probe.tick();   // unknown→healthy: writes audit (flip from initial unknown)
  firstTickOk = false;
  await probe.tick();   // healthy→degraded: writes audit
  // exactly 2 audit entries
  assert.strictEqual(auditPayloads.length, 2);
});

test('start/stop: start() begins setInterval; stop() clears it', async () => {
  const db = makeStubDb();
  let ticks = 0;
  const probe = createProbeLoop({
    db, ports: { web: 8080, heartbeat: 8081, report: 8082 },
    logger: { child: () => ({ info(){}, warn(){}, error(){} }) },
    writeAudit: async () => {},
    fetchImpl: async () => { ticks++; return { ok: true }; }
  });
  probe.start();
  await new Promise(r => setTimeout(r, 1100));
  probe.stop();
  assert.ok(ticks >= 1, `expected ≥1 tick; got ${ticks}`);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd center && npm test -- tests/services/probe.test.js`
Expected: 5 failures with `createProbeLoop is not a function`.

- [ ] **Step 3: Implement `createProbeLoop` in `center/src/services/probe.js`**

```js
// center/src/services/probe.js
// 1 Hz self-probe loop. Probes each of the three center listening ports via
// /healthz and upserts a row into probe_state per port. Status transitions
// (healthy↔degraded) write one audit entry; every-tick writes are noise we
// don't want in audit_logs.
//
// Consumed by server.js bootstrap (Task 4): start() after buildServerApps,
// stop() in the SIGINT/SIGTERM shutdown handler.

const PROBE_INTERVAL_MS = 1000;
const PROBE_TIMEOUT_MS = 2000;
const PROBE_MISSING_TABLE_RE = /probe_state.*(doesn't|does not) exist|Invalid object name 'probe_state'/i;

export function createProbeLoop({ db, ports, logger, writeAudit, fetchImpl }) {
  const log = logger.child({ component: 'probe' });
  const fetchFn = fetchImpl || ((url, opts) => fetch(url, opts));
  let interval = null;
  let inFlight = null;

  async function probePort(portRole, port) {
    const t0 = Date.now();
    try {
      const res = await fetchFn(`http://localhost:${port}/healthz`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
      });
      const latencyMs = Date.now() - t0;
      return {
        portRole, port,
        status: res.ok ? 'healthy' : 'degraded',
        latencyMs,
        lastProbeAt: new Date(),
        lastUpAt: res.ok ? new Date() : null,
        consecutiveFailures: res.ok ? 0 : -1  // -1 sentinel: read prev below
      };
    } catch (e) {
      return {
        portRole, port,
        status: 'degraded',
        latencyMs: null,
        lastProbeAt: new Date(),
        lastUpAt: null,
        consecutiveFailures: -1
      };
    }
  }

  async function readPrev(portRole) {
    const { rows } = await db.query(db.sql.probeState.getAll);
    return rows.find(r => r.port_role === portRole) || null;
  }

  async function tick() {
    // Bootstrap fail-fast: surface a clear error if migration 012 wasn't applied.
    try {
      await db.query(db.sql.probeState.getAll);
    } catch (e) {
      if (PROBE_MISSING_TABLE_RE.test(e.message)) {
        throw new Error('probe_state table missing — apply migration 012');
      }
      throw e;
    }

    const results = await Promise.all([
      probePort('web',       ports.web),
      probePort('heartbeat', ports.heartbeat),
      probePort('report',    ports.report)
    ]);

    for (const r of results) {
      const prev = await readPrev(r.portRole);
      const prevStatus = prev?.status ?? 'unknown';
      const consecutiveFailures = r.status === 'healthy'
        ? 0
        : (Number(prev?.consecutive_failures) || 0) + 1;
      const lastUpAt = r.status === 'healthy'
        ? r.lastUpAt
        : (prev?.last_up_at ? new Date(prev.last_up_at) : null);

      await db.execute(db.sql.probeState.upsertRow(
        r.portRole,
        r.status,
        r.latencyMs,
        r.lastProbeAt,
        lastUpAt,
        consecutiveFailures
      ));

      if (prevStatus !== r.status) {
        await writeAudit({
          action: 'probe_state_changed',
          target: r.portRole,
          payload: { prev: prevStatus, next: r.status, latencyMs: r.latencyMs, consecutiveFailures }
        }).catch(() => { /* best-effort */ });
      }
    }
  }

  function start() {
    if (interval) return;
    interval = setInterval(() => {
      inFlight = tick().catch((e) => log.error({ err: e.message }, 'probe tick failed'));
    }, PROBE_INTERVAL_MS);
  }

  async function stop() {
    if (interval) clearInterval(interval);
    interval = null;
    if (inFlight) await inFlight.catch(() => {});
    inFlight = null;
  }

  return {
    start,
    stop,
    tick,
    isRunning: () => interval !== null
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd center && npm test -- tests/services/probe.test.js`
Expected: 5 pass.

- [ ] **Step 5: Run full backend suite for regressions**

Run: `cd center && npm test`
Expected: ≥ 506 pass, 0 fail (5 new tests added).

- [ ] **Step 6: Mirror to publish/**

```bash
cp center/src/services/probe.js publish/center/src/services/probe.js
diff center/src/services/probe.js publish/center/src/services/probe.js && echo OK
```

- [ ] **Step 7: Commit**

```bash
git add center/src/services/probe.js center/tests/services/probe.test.js publish/center/src/services/probe.js
git commit -m "feat(probe): 1 Hz self-probe loop with audit on status flip"
```

---

### Task 4: Probe bootstrap integration — start in normal-mode, stop in shutdown

**Files:**
- Modify: `center/server.js` (lines 241-263 normal-mode branch, add probe loop start after `startServers`; lines 254-262 shutdown handler, add probe loop stop before `closeAll`)
- Modify: `center/tests/integration/probe-loop.test.js` (NEW — full integration: 3 in-memory HTTP servers, real `createProbeLoop`, real MySQL `probe_state` upsert)
- Mirror to: `publish/center/server.js`

**Interfaces:**
- Consumes: `createProbeLoop` from `services/probe.js` (Task 3); `getListenPort` from `config.js` (Task 2)
- Produces: `server.js` starts the probe loop after `startServers` resolves; stops it (await) before `closeAll` in the shutdown handler. The probe loop targets the three ports from `apps.ports` (the `{web, heartbeat, report}` map produced by `buildServerApps`).

- [ ] **Step 1: Write failing integration test**

`center/tests/integration/probe-loop.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProbeLoop } from '../../src/services/probe.js';
import { getDb, init, close } from '../../src/db/index.js';
import { writeAudit } from '../../src/services/audit.js';

test('integration: probe loop writes probe_state after 3 ticks against real local servers', async () => {
  // Spin up 3 tiny HTTP servers that always return 200 /healthz.
  const servers = [];
  const ports = [];
  for (let i = 0; i < 3; i++) {
    const s = http.createServer((req, res) => {
      if (req.url === '/healthz') { res.writeHead(200, {'Content-Type':'application/json'}); res.end('{"status":"ok"}'); }
      else { res.writeHead(404); res.end(); }
    });
    await new Promise(r => s.listen(0, r));
    servers.push(s);
    ports.push(s.address().port);
  }
  // Init DB; ensure probe_state is seeded by migration 012.
  // (If the test DB doesn't have migration 012 applied, this fails — by design.)
  await init({ db: { dialect: 'mysql', mysql: { host: process.env.TEST_MYSQL_HOST || '127.0.0.1', port: 3306, database: 'addashboard_test', user: 'root', password: process.env.TEST_MYSQL_PASSWORD || '' } }, listenPort: 8080, jwtSecret: 'x', agentToken: 'x', staticDir: './dist', logLevel: 'silent', env: 'test' });
  const db = getDb();
  const probe = createProbeLoop({
    db,
    ports: { web: ports[0], heartbeat: ports[1], report: ports[2] },
    logger: { child: () => ({ info(){}, warn(){}, error(){} }) },
    writeAudit
  });
  probe.start();
  await new Promise(r => setTimeout(r, 3500)); // wait for ≥3 ticks
  await probe.stop();
  // Read probe_state back
  const { rows } = await db.query(db.sql.probeState.getAll);
  assert.strictEqual(rows.length, 3);
  for (const row of rows) {
    assert.strictEqual(row.status, 'healthy', `${row.port_role} should be healthy`);
    assert.ok(row.last_probe_at, `${row.port_role} last_probe_at must be set`);
  }
  // Cleanup
  for (const s of servers) s.close();
  await close();
});
```

(Implementer: gate this test on `TEST_MYSQL_URL` per project convention; mirror to `tests/integration/_helpers.js` if pattern exists.)

- [ ] **Step 2: Run integration test to verify it fails**

Run: `cd center && npm test -- tests/integration/probe-loop.test.js`
Expected: FAIL — `createProbeLoop` not yet wired into bootstrap (loop won't be started by anything), OR if the test runs standalone it'll succeed since it calls `probe.start()` directly. **The integration here is "the test confirms the public API works"**; the bootstrap wiring change is in Step 4.

- [ ] **Step 3: Wire `createProbeLoop` into `center/server.js` bootstrap**

In the normal-mode branch (around lines 241-263):

```js
import { createProbeLoop } from './src/services/probe.js';

// after line 253 (servers resolved):
const probeLoop = createProbeLoop({
  db: getDb(),
  ports: apps.ports,  // {web, heartbeat, report}
  logger,
  writeAudit
});
probeLoop.start();
```

In the `shutdown` handler (lines 254-262):

```js
const shutdown = async (sig) => {
  logger.info({ sig }, 'shutting down');
  try { await probeLoop.stop(); } catch (e) { logger.warn({ err: e.message }, 'probe stop failed'); }
  await closeAll(servers, logger);
  // ... existing cleanup
};
```

(Implementer: insert the `import` near other `./src/...` imports at the top of server.js. The probe loop variable must be in scope of both branches — declare it before the `if (needsInit) {} else {}` split, OR declare separately in each branch with the same name.)

- [ ] **Step 4: Add bootstrap watchdog — 30 s with no probe write → audit warning**

After `probeLoop.start()`, schedule a one-shot:

```js
setTimeout(() => {
  // If no probe write happened, something's wrong with the loop.
  // Read probe_state; if all rows still show stale data or are missing recent last_probe_at, audit.
  db.query(db.sql.probeState.getAll).then(({ rows }) => {
    const allStale = rows.every(r => {
      if (!r.last_probe_at) return true;
      return (Date.now() - new Date(r.last_probe_at).getTime()) > 30000;
    });
    if (allStale) {
      writeAudit({
        action: 'probe_loop_watchdog',
        target: 'probe_state',
        payload: { warning: 'no probe write in 30s after startup' }
      }).catch(() => {});
      logger.error('probe loop watchdog: no probe write in 30s');
    }
  }).catch(() => {});
}, 30000).unref();
```

(The `.unref()` lets the timer not block shutdown.)

- [ ] **Step 5: Run integration test + full backend suite**

Run: `cd center && npm test -- tests/integration/probe-loop.test.js && npm test`
Expected: integration test passes; ≥ 506 pass, 0 fail total.

- [ ] **Step 6: Live smoke test**

1. Run `cd center && npm start` (per `feedback_prod_build.md`).
2. After 5 s, `curl http://localhost:8081/healthz` → 200 (was 404 before).
3. After 5 s, `curl http://localhost:8082/healthz` → 200.
4. `mysql ... -e "SELECT * FROM probe_state"` → 3 rows, all `healthy`, `consecutive_failures=0`.
5. Kill the heartbeat app by stopping center, restart only the report server manually with a wrong port — observe `status=degraded` in DB within 1 s.

- [ ] **Step 7: Mirror to publish/**

```bash
cp center/server.js publish/center/server.js
diff center/server.js publish/center/server.js && echo OK
```

- [ ] **Step 8: Commit**

```bash
git add center/server.js center/tests/integration/probe-loop.test.js publish/center/server.js
git commit -m "feat(server): wire probe loop into normal-mode bootstrap + shutdown"
```

---

### Task 5: GET /api/admin/heartbeat-report/probe endpoint + service function

**Files:**
- Modify: `center/src/routes/heartbeat-report.js` (lines 1-48, add new route before the existing `/agents/:agentId/report-detail` handler)
- Modify: `center/src/services/heartbeat-report.js` (lines 1-124, add `listProbeStatus` method)
- Modify: `center/tests/heartbeat-report-probe-endpoint.test.js` (NEW)
- Mirror to: `publish/center/src/routes/heartbeat-report.js`, `publish/center/src/services/heartbeat-report.js`

**Interfaces:**
- Consumes: `db.sql.probeState.getAll`; existing `[userAuth, requirePerm('admin:users')]` middleware
- Produces:
  - `GET /api/admin/heartbeat-report/probe` → `200 { probes: {web, heartbeat, report}, nowCenterProbeStale: boolean }`
  - `nowCenterProbeStale = any row's last_probe_at > 30 s ago OR all rows have status='unknown'`
  - Each row in `probes`: `{ status, latencyMs, lastProbeAt, lastUpAt, consecutiveFailures }` (camelCase per project convention)

- [ ] **Step 1: Write failing test for `listProbeStatus`**

In `center/tests/heartbeat-report-probe-endpoint.test.js`:

```js
test('listProbeStatus: returns 3 probe rows in fixed order with nowCenterProbeStale=false', async () => {
  // stub getDb() to return 3 rows from probeState.getAll
  const out = await heartbeatReportService.listProbeStatus();
  assert.strictEqual(Object.keys(out.probes).sort().join(','), 'heartbeat,report,web');
  assert.strictEqual(out.nowCenterProbeStale, false);
});

test('listProbeStatus: returns nowCenterProbeStale=true when lastProbeAt > 30s ago', async () => {
  // stub rows where last_probe_at is 60s ago
  const out = await heartbeatReportService.listProbeStatus();
  assert.strictEqual(out.nowCenterProbeStale, true);
});

test('listProbeStatus: returns nowCenterProbeStale=true when all rows status=unknown (boot)', async () => {
  // stub rows with status='unknown' for all three
  const out = await heartbeatReportService.listProbeStatus();
  assert.strictEqual(out.nowCenterProbeStale, true);
});
```

(Implementer: copy the stub pattern from existing `heartbeat-report.test.js` for `getDb`.)

- [ ] **Step 2: Implement `listProbeStatus()` in `center/src/services/heartbeat-report.js`**

Append:

```js
async listProbeStatus(db = null) {
  const conn = db ?? getDb();
  const { rows } = await conn.query(conn.sql.probeState.getAll);
  const probes = {};
  for (const row of rows) {
    probes[row.port_role] = {
      status: row.status,
      latencyMs: row.latency_ms == null ? null : Number(row.latency_ms),
      lastProbeAt: toIsoOrNull(row.last_probe_at),
      lastUpAt: toIsoOrNull(row.last_up_at),
      consecutiveFailures: Number(row.consecutive_failures) || 0
    };
  }
  // Stale sentinel: any row's lastProbeAt > 30s ago OR all unknown (boot window)
  const now = Date.now();
  const STALE_MS = 30_000;
  let allUnknown = rows.length > 0 && rows.every(r => r.status === 'unknown');
  let anyStale = rows.some(r => {
    if (!r.last_probe_at) return true;
    return (now - new Date(r.last_probe_at).getTime()) > STALE_MS;
  });
  return { probes, nowCenterProbeStale: allUnknown || anyStale };
}
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd center && npm test -- tests/heartbeat-report-probe-endpoint.test.js`
Expected: 3 pass.

- [ ] **Step 4: Wire the route in `center/src/routes/heartbeat-report.js`**

Insert before line 37 (the `/agents/:agentId/report-detail` handler):

```js
r.get('/api/admin/heartbeat-report/probe', ...auth, async (_req, res) => {
  try {
    const out = await heartbeatReportService.listProbeStatus();
    res.json(out);
  } catch (e) {
    _req.log?.error?.({ err: e.message }, 'heartbeat-report probe failed');
    res.status(500).json({ error: 'internal' });
  }
});
```

- [ ] **Step 5: Write endpoint integration test (mocked fetch + DB)**

Add to the same test file:

```js
import { heartbeatReportRouter } from '../../src/routes/heartbeat-report.js';
import express from 'express';

test('GET /probe: returns 200 with expected shape', async () => {
  // Mock: getDb() returns { rows: [3 probe_state rows] }
  // Build minimal app: heartbeatReportRouter({ requireAuth: (req,res,next)=>next(), requirePerm: ()=>(req,res,next)=>next() })
  // Supertest GET /api/admin/heartbeat-report/probe → 200
  // Assert body shape matches { probes: {...}, nowCenterProbeStale: bool }
});

test('GET /probe: returns 401 without token (when requireAuth rejects)', async () => {
  // requireAuth returns (req,res,next)=>res.status(401).end() — same shape as existing heartbeat-report tests
});
```

(Implementer: copy the supertest pattern from `tests/heartbeat-report.test.js` — see how the existing 3 endpoints are tested.)

- [ ] **Step 6: Run full backend suite for regressions**

Run: `cd center && npm test`
Expected: ≥ 511 pass, 0 fail.

- [ ] **Step 7: Mirror to publish/**

```bash
cp center/src/routes/heartbeat-report.js publish/center/src/routes/heartbeat-report.js
cp center/src/services/heartbeat-report.js publish/center/src/services/heartbeat-report.js
diff center/src/routes/heartbeat-report.js publish/center/src/routes/heartbeat-report.js && echo OK
diff center/src/services/heartbeat-report.js publish/center/src/services/heartbeat-report.js && echo OK
```

- [ ] **Step 8: Commit**

```bash
git add center/src/routes/heartbeat-report.js center/src/services/heartbeat-report.js \
        center/tests/heartbeat-report-probe-endpoint.test.js \
        publish/center/src/routes/heartbeat-report.js publish/center/src/services/heartbeat-report.js
git commit -m "feat(api): GET /api/admin/heartbeat-report/probe endpoint"
```

---

### Task 6: ConfigView — labels + descriptions + numericFields + "待重启" badge

**Files:**
- Modify: `frontend/src/views/admin/ConfigView.vue` (lines 86-118 maps; lines 4-30 template for the badge)
- Create: `frontend/tests/admin-config-labels.test.js`
- Create: `frontend/tests/config-restart-badge.test.js`
- Mirror to: `publish/frontend/src/views/admin/ConfigView.vue`

**Interfaces:**
- Consumes: existing `adminApi.getConfig()`; existing `useConfigValidation` composable
- Produces:
  - `labels` map gets 3 new entries: `listenPort: '中心 Web 端口'`, `heartbeat_port: '心跳端口'`, `report_port: '报告端口'`
  - `descriptions` map gets 3 new entries per Global constraints (D10 specifies copy)
  - `numericFields` array gets 3 new entries: `listenPort`, `heartbeat_port`, `report_port`
  - Validation: `listenPort`/`heartbeat_port`/`report_port` must be 1–65535; `listenPort` rejects 80/443/22/3306/1433; the three ports must be distinct.
  - Template: when `current.restartRequired?.listenPort === true` (computed from `initial.restartRequired`), show inline red badge `⚠ 待重启` next to the listenPort input, with tooltip via `<span title="...">`.

- [ ] **Step 1: Write failing test for label/description/numericField entries**

`frontend/tests/admin-config-labels.test.js`:

```js
import { mount } from '@vue/test-utils';
import ConfigView from '../src/views/admin/ConfigView.vue';
// Stub adminApi.getConfig() to return a config that includes listenPort / heartbeat_port / report_port

test('ConfigView: renders listenPort/heartbeat_port/report_port rows with labels + numeric inputs', async () => {
  const wrapper = mount(ConfigView, { /* full AdminLayout + ConfirmDialog + composables stubs */ });
  await wrapper.vm.$nextTick();
  // Look for "中心 Web 端口" / "心跳端口" / "报告端口" in rendered text
  expect(wrapper.text()).toContain('中心 Web 端口');
  expect(wrapper.text()).toContain('心跳端口');
  expect(wrapper.text()).toContain('报告端口');
  // The numeric inputs for these rows have type=number
  const numericInputs = wrapper.findAll('input[type="number"]');
  expect(numericInputs.length).toBeGreaterThanOrEqual(3);
});
```

(Implementer: copy the stubbing pattern from existing `admin-config-view.test.js` or `tests/views/admin/ConfigView.test.js` if present.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/admin-config-labels.test.js`
Expected: FAIL with `中心 Web 端口` not in text.

- [ ] **Step 3: Add label/description/numericField entries in ConfigView.vue script**

Edit lines 86-118 of `frontend/src/views/admin/ConfigView.vue`:

```js
const descriptions = {
  // ... existing ...
  listenPort: '对外 Web/管理界面端口。改完需重启 center 后生效。',
  heartbeat_port: 'Agent 心跳接收端口。DB 改后 5 min 内 agent 自动刷新。',
  report_port: 'Agent replication snapshot 上报端口。'
};

const labels = {
  // ... existing ...
  listenPort: '中心 Web 端口',
  heartbeat_port: '心跳端口',
  report_port: '报告端口'
};

const numericFields = [
  // ... existing ...
  'listenPort',
  'heartbeat_port',
  'report_port'
];
```

(Implementer: keep `center_public_host` / `center_public_port` entries; they're explicitly marked deprecated per the existing copy. New entries slot alphabetically near the other numeric fields.)

- [ ] **Step 4: Write failing test for "待重启" badge visibility**

`frontend/tests/config-restart-badge.test.js`:

```js
test('ConfigView: shows "待重启" badge on listenPort row when restartRequired.listenPort=true', async () => {
  // Stub adminApi.getConfig() to return { listenPort: 9090, restartRequired: { listenPort: true }, ... }
  // Mount; assert presence of .restart-badge or text '待重启'
  expect(wrapper.text()).toContain('待重启');
});

test('ConfigView: hides "待重启" badge when restartRequired.listenPort=false or absent', async () => {
  // Stub returns restartRequired: { listenPort: false }
  expect(wrapper.text()).not.toContain('待重启');
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/config-restart-badge.test.js`
Expected: FAIL — no badge in DOM.

- [ ] **Step 6: Add badge in template (lines 12-21 of ConfigView.vue)**

Modify the row for `listenPort` to render the badge. Since ConfigView iterates `current` keys uniformly, the cleanest pattern is to add a special cell in the row template:

```html
<tr v-for="(v, k) in current" :key="k">
  <td>
    <div class="key-label">{{ labels[k] || k }}</div>
    <code class="raw-key">{{ k }}</code>
  </td>
  <td>
    <ConfigFieldRow
      :value="v"
      :error="errors[k] || ''"
      :description="descriptions[k] || ''"
      :type="numericFields.includes(k) ? 'number' : 'text'"
      @update:value="onInput(k, $event)"
    />
    <span v-if="k === 'listenPort' && initial.restartRequired?.listenPort" class="restart-badge" :title="'保存后值已生效，需重启 center 后生效。重启后此标记消失。'">⚠ 待重启</span>
  </td>
  <td>
    <!-- ... existing ... -->
  </td>
</tr>
```

(Implementer: ensure `initial` ref includes `restartRequired` — `load()` already spreads `r.data`, so if the backend returns `{listenPort, restartRequired: {...}}`, the spread carries it. Verify by reading lines 156-162 of ConfigView.vue.)

- [ ] **Step 7: Add `.restart-badge` CSS**

Append to the `<style scoped>` block:

```css
.restart-badge { display: inline-block; margin-left: 8px; padding: 2px 8px; background: #7f1d1d; color: #fee2e2; border: 1px solid #b91c1c; border-radius: 3px; font-size: 11px; cursor: help; }
```

- [ ] **Step 8: Run frontend tests for regressions**

Run: `cd frontend && npx vitest run`
Expected: ≥ 213 pass, 0 fail (3 new tests added).

- [ ] **Step 9: Mirror to publish/**

```bash
cp frontend/src/views/admin/ConfigView.vue publish/frontend/src/views/admin/ConfigView.vue
diff frontend/src/views/admin/ConfigView.vue publish/frontend/src/views/admin/ConfigView.vue && echo OK
```

- [ ] **Step 10: Commit**

```bash
git add frontend/src/views/admin/ConfigView.vue \
        frontend/tests/admin-config-labels.test.js \
        frontend/tests/config-restart-badge.test.js \
        publish/frontend/src/views/admin/ConfigView.vue
git commit -m "feat(admin): ConfigView labels for 3 ports + restart-required badge"
```

---

### Task 7: HeartbeatReportMonitorView — top "中心端口" probe panel

**Files:**
- Modify: `frontend/src/views/admin/HeartbeatReportMonitorView.vue` (lines 1-19 template, add panel above tabs; lines 61-151 script, add probe fetch + status computation)
- Modify: `frontend/src/api/heartbeatReport.js` (lines 1-7, add `getProbeStatus()`)
- Create: `frontend/tests/heartbeat-report-probe-panel.test.js`
- Mirror to: `publish/frontend/src/views/admin/HeartbeatReportMonitorView.vue`, `publish/frontend/src/api/heartbeatReport.js`

**Interfaces:**
- Consumes: existing `heartbeatReportApi`; existing `refreshIntervalSeconds` toggle (reuses the same interval — no separate timer)
- Produces:
  - New `probeRows` ref holding the 3 rows from `GET /probe`
  - New `nowCenterProbeStale` ref holding the boolean
  - New `<section class="probe-panel">` template at the top of the view (above tabs)
  - Three-row table with status dot + label (`Web :<port>`) + status text + latency
  - Three-state color mapping per spec (green/yellow/red)

- [ ] **Step 1: Add `getProbeStatus()` to API client**

Modify `frontend/src/api/heartbeatReport.js`:

```js
export const heartbeatReportApi = {
  listAgents: () => api.get('/api/admin/heartbeat-report/agents'),
  listDcs:    () => api.get('/api/admin/heartbeat-report/dcs'),
  getDetail:  ((agentId) => api.get(`/api/admin/heartbeat-report/agents/${encodeURIComponent(agentId)}/report-detail`)),
  getProbeStatus: () => api.get('/api/admin/heartbeat-report/probe')
};
```

(Implementer: fix the extra paren above — that's a typo in the snippet.)

- [ ] **Step 2: Write failing test for the probe panel**

`frontend/tests/heartbeat-report-probe-panel.test.js`:

```js
test('panel renders 3 rows (web/heartbeat/report) with green dot when status=healthy', async () => {
  // Stub getProbeStatus to return { probes: { web: {status:'healthy',...}, heartbeat:{...}, report:{...} }, nowCenterProbeStale: false }
  // Mount HeartbeatReportMonitorView; assert 3 .probe-row elements; assert each has .dot.green
});

test('panel renders yellow dot when status=degraded', async () => {
  // Stub one row with status='degraded'
  // Assert that row has .dot.yellow
});

test('panel renders yellow dot during boot when status=unknown', async () => {
  // Stub all 3 rows with status='unknown'
  // Assert all dots are .dot.yellow (not green)
});

test('panel renders red dot when nowCenterProbeStale=true', async () => {
  // Stub response with nowCenterProbeStale=true
  // Assert all 3 dots are .dot.red
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/heartbeat-report-probe-panel.test.js`
Expected: 4 FAIL — panel not in DOM.

- [ ] **Step 4: Add probe state refs + status computation in script setup**

In `HeartbeatReportMonitorView.vue` script setup, after `agentsRows` / `dcsRows` (around line 67-69):

```js
const probeRows = ref({ web: null, heartbeat: null, report: null });
const nowCenterProbeStale = ref(false);

function probeStatusOf(role) {
  const row = probeRows.value[role];
  if (!row) return 'unknown';
  if (nowCenterProbeStale.value) return 'red';
  if (row.status === 'unknown') return 'yellow';
  if (row.status === 'degraded') return 'yellow';
  if (row.consecutiveFailures >= 3) return 'red';
  // healthy
  if (!row.lastProbeAt) return 'yellow';
  const gap = (Date.now() - new Date(row.lastProbeAt).getTime()) / 1000;
  if (gap > 60) return 'red';
  if (gap > 30) return 'yellow';
  return 'green';
}
function probeLabel(role, row) {
  if (!row) return '未知';
  if (row.status === 'unknown') return '启动中';
  if (row.status === 'degraded') return `异常 · ${row.consecutiveFailures}次连续失败`;
  if (nowCenterProbeStale.value) return '监控自身失联';
  return `正常 · ${row.latencyMs ?? '?'}ms`;
}
const PORT_LABEL = { web: 'Web :8080', heartbeat: '心跳 :8081', report: '报告 :8082' };
function portLabel(role) {
  const row = probeRows.value[role];
  if (!row) return PORT_LABEL[role];
  // Pull port from current config? Or hard-code with format?
  // Use the role->port static map for now; revisit if user changes ports (probeRows
  // doesn't include the port number — separate concern).
  return PORT_LABEL[role];
}
```

- [ ] **Step 5: Fetch probe data inside `load()`**

Extend the `load()` function (lines 107-123) to also fetch probe status:

```js
async function load() {
  try {
    if (tab.value === 'agent') {
      const r = await heartbeatReportApi.listAgents();
      agentsRows.value = r.data?.agents || [];
      heartbeatStaleSeconds.value = r.data?.heartbeatStaleSeconds || 15;
    } else {
      const r = await heartbeatReportApi.listDcs();
      dcsRows.value = r.data?.agents || [];
      heartbeatStaleSeconds.value = r.data?.heartbeatStaleSeconds || 15;
    }
    // Fetch probe status (independent of tab)
    try {
      const pr = await heartbeatReportApi.getProbeStatus();
      probeRows.value = pr.data?.probes || {};
      nowCenterProbeStale.value = !!pr.data?.nowCenterProbeStale;
    } catch (e) {
      // Probe data is best-effort; don't surface as top-level error
      console.warn('probe fetch failed:', e?.message);
    }
    error.value = null;
  } catch (e) {
    error.value = e?.message || '加载失败';
  }
}
```

- [ ] **Step 6: Add probe panel template (insert before `<div class="tabs">`)**

In `HeartbeatReportMonitorView.vue` template, insert before line 15 (the tabs div):

```html
<section class="probe-panel" data-test="probe-panel">
  <h3>中心端口</h3>
  <table class="probe-t">
    <thead><tr><th>状态</th><th>端口</th><th>详情</th><th>最近探针</th></tr></thead>
    <tbody>
      <tr v-for="role in ['web','heartbeat','report']" :key="role" :data-test="'probe-row'" :data-role="role" :data-status="probeStatusOf(role)">
        <td><span :class="['dot', probeStatusOf(role)]"></span> {{ probeLabel(role, probeRows[role]) }}</td>
        <td>{{ portLabel(role) }}</td>
        <td>{{ probeRows[role]?.status || '—' }} · {{ probeRows[role]?.latencyMs ?? '—' }}ms</td>
        <td>{{ formatRelative(probeRows[role]?.lastProbeAt) }}</td>
      </tr>
    </tbody>
  </table>
  <div v-if="nowCenterProbeStale" class="probe-stale-banner" data-test="probe-stale-banner">⚠ 中心自我探针已 30s 未更新 — 监控可能失联</div>
</section>
```

- [ ] **Step 7: Add probe panel CSS**

Append to `<style scoped>`:

```css
.probe-panel { margin-bottom: 16px; padding: 12px; background: var(--panel); border: 1px solid #1e293b; border-radius: 4px; }
.probe-panel h3 { margin: 0 0 8px; font-size: 14px; color: var(--muted); }
.probe-t { width: 100%; border-collapse: collapse; }
.probe-t th, .probe-t td { padding: 6px 10px; text-align: left; border-bottom: 1px solid #1e293b; font-size: 13px; }
.probe-t th { background: #0b1220; color: var(--muted); font-size: 12px; }
.probe-stale-banner { margin-top: 8px; padding: 8px 12px; background: #7f1d1d; color: #fee2e2; border: 1px solid #b91c1c; border-radius: 3px; font-size: 12px; }
```

- [ ] **Step 8: Run frontend tests for regressions**

Run: `cd frontend && npx vitest run`
Expected: ≥ 217 pass, 0 fail (4 new tests added).

- [ ] **Step 9: Mirror to publish/**

```bash
cp frontend/src/views/admin/HeartbeatReportMonitorView.vue publish/frontend/src/views/admin/HeartbeatReportMonitorView.vue
cp frontend/src/api/heartbeatReport.js publish/frontend/src/api/heartbeatReport.js
diff frontend/src/views/admin/HeartbeatReportMonitorView.vue publish/frontend/src/views/admin/HeartbeatReportMonitorView.vue && echo OK
diff frontend/src/api/heartbeatReport.js publish/frontend/src/api/heartbeatReport.js && echo OK
```

- [ ] **Step 10: Commit**

```bash
git add frontend/src/views/admin/HeartbeatReportMonitorView.vue \
        frontend/src/api/heartbeatReport.js \
        frontend/tests/heartbeat-report-probe-panel.test.js \
        publish/frontend/src/views/admin/HeartbeatReportMonitorView.vue \
        publish/frontend/src/api/heartbeatReport.js
git commit -m "feat(admin): HeartbeatReportMonitorView 中心端口 probe panel"
```

---

### Task 8: Publish mirror + frontend build + publish.zip + push

**Files:**
- Rebuild: `publish/center/dist/` (run `npm run build` in center if applicable, or mirror from `center/dist/`)
- Rebuild: `frontend/dist/` (run `npx vite build`)
- Mirror: `publish/frontend/dist/` from `frontend/dist/`
- Regenerate: `publish/publish.zip` (zip everything in `publish/` EXCEPT tests, `node_modules`, `coverage`)

- [ ] **Step 1: Verify all source mirrors are byte-identical**

Run a diff sweep across all files changed in Tasks 1–7:

```bash
for f in center/src/db/migrations/012-probe-state.sql \
         center/src/db/sql.js \
         center/src/services/probe.js \
         center/src/services/config.js \
         center/src/services/heartbeat-report.js \
         center/src/routes/heartbeat-report.js \
         center/src/routes/admin.js \
         center/src/config.js \
         center/server.js \
         frontend/src/views/admin/ConfigView.vue \
         frontend/src/views/admin/HeartbeatReportMonitorView.vue \
         frontend/src/api/heartbeatReport.js; do
  diff "$f" "publish/$f" >/dev/null || echo "MISMATCH: $f"
done
echo "Mirror sweep complete"
```

Expected: no MISMATCH lines.

- [ ] **Step 2: Build frontend + mirror dist**

```bash
cd frontend && npx vite build
# Frontend dist now lives in frontend/dist/
cp -r frontend/dist/* publish/frontend/dist/
# Verify chunk for the updated HeartbeatReportMonitorView exists:
ls publish/frontend/dist/assets/ | grep HeartbeatReportMonitorView
```

- [ ] **Step 3: Rebuild center dist if center has its own build step**

```bash
cd center && npm run build 2>/dev/null || echo "no center build step"
# If center/dist/ is produced, mirror to publish/center/dist/
if [ -d center/dist ]; then
  rm -rf publish/center/dist
  cp -r center/dist publish/center/dist
fi
```

- [ ] **Step 4: Regenerate publish.zip**

```bash
cd publish && rm -f publish.zip
# Use existing zip pattern from prior commits; exclude tests/node_modules/coverage
powershell -NoProfile -Command "Get-ChildItem -Recurse -Path . -Exclude 'node_modules','dist','tests' | Compress-Archive -DestinationPath publish.zip -Force"
# OR if a repo script exists:
./make-zip.ps1
ls -lh publish.zip
```

Expected: `publish.zip` ~2.4 MB (current is 2.34 MB; will grow by maybe 5-10 KB for the probe panel CSS).

- [ ] **Step 5: Commit dist + zip**

```bash
git add publish/frontend/dist/ publish/center/dist/ publish/publish.zip
git commit -m "chore(publish): mirror port config + probe panel + rebuild dist + zip"
```

- [ ] **Step 6: Push to origin**

```bash
git push origin main
# Confirm push clean:
git status --short
```

Expected: working tree clean; origin/main updated.

---

### Task 9: Whole-branch review (opus) + fix rounds

**Scope:** The opus reviewer audits the entire branch (all 9 commits) for cross-task integration bugs, spec deviations, and risks not caught in per-task reviews.

- [ ] **Step 1: Generate review package**

After pushing origin (Task 8 Step 6), run the SDD review-package helper:

```bash
git rev-parse HEAD  # record this for the diff range
# Use the sdd skill's review-package generator (per superpowers:subagent-driven-development)
```

- [ ] **Step 2: Dispatch opus reviewer**

Hand the reviewer:
- Brief file path: `docs/superpowers/specs/2026-08-08-port-config-and-health.md`
- Plan file path: `docs/superpowers/plans/2026-08-08-port-config-and-health.md`
- Diff range: from `git rev-parse HEAD~9` to `git rev-parse HEAD` (last 9 commits)
- Review focus: spec compliance + cross-task integration (probe loop ↔ DB ↔ API ↔ UI) + security (probe loop only hits localhost — confirm) + SQL portability (no window functions — confirm) + ops risks (probe_state table missing on upgrade — confirm fail-fast is in place)

- [ ] **Step 3: Adjudicate findings**

Per the SDD skill's fix loop:
- Critical / Important → fix immediately (max 5 rounds; round 4+ uses a more capable model)
- Minor → park in `.superpowers/sdd/2026-08-08-port-config-and-health/progress.md` with `minor (deferred): <one-liner>` and consider rolling into a future cleanup plan

- [ ] **Step 4: Append ledger entry**

Write to `.superpowers/sdd/2026-08-08-port-config-and-health/progress.md`:
- Task completion summary for each task
- Review verdict (clean / fixed)
- Push status (`main @ <hash> == origin/main @ <hash>`)
- Parked findings (if any)

- [ ] **Step 5: Final commit (if any fix-round changes were made)**

```bash
git push origin main
```

- [ ] **Step 6: Write memory**

`memory/progress_2026_08_08_port_config_and_probe.md` — captures:
- Plan shipped; main @ <final hash>
- Test counts (center ≥ N, frontend ≥ M)
- Spec decisions referenced (D1–D11)
- Parked findings (if any)
- Resume point for next session

---

## Self-Review Notes (writer)

- **Spec coverage:** D1 (DB-first listenPort) → T2; D2 (probe_state table) → T1; D3 (healthz on 3 apps) → T2; D4 (1Hz probe + write each tick) → T3; D5 (schema with PK + counts) → T1; D6 (DB check preserved) → T2 (no change to handler); D7 (/probe endpoint) → T5; D8 (version hash restart detection) → T2; D9 (first-boot seed) → T2; D10 (inline badge) → T6; D11 (yellow unknown tri-state) → T7.
- **No placeholders:** All steps contain actual code/SQL/commands. No "TBD" / "TODO" / "similar to Task N".
- **Type consistency:** `probeStatus` returns camelCase (matches spec §Endpoint contract); `latencyMs` not `latency_ms`; `lastProbeAt` not `last_probe_at`; `consecutiveFailures` not `consecutive_failures`. Frontend `PORT_LABEL` uses static `:8080`/`:8081`/`:8082` strings; if user changes ports the panel will show stale labels — flagged in T7 Step 4 comment.
- **Spec gaps filled:** Probe watchdog (T4 Step 4) — explicit in spec §Error handling but no task pointed to it; now lives in T4.
- **Out of scope confirmed:** No agent-side probe (Q2 center only); no historical probe graphs; no HTTPS probe; no auto-restart button.