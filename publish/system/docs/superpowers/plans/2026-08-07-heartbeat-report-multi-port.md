# Heartbeat/Report Multi-Port + Admin Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow Center to listen on separate ports for web / heartbeat / report traffic, and add an admin UI showing live agent/DC status with color-coded heartbeat dot + report summary.

**Architecture:** 3 new `system_config` keys (`heartbeat_port`/`report_port`/`heartbeat_stale_seconds`) drive Center's listener config. A new `multi-port.js` module creates N independent `http.Server` instances (deduped by port). `agentRouter` gains a `mount` parameter to register only heartbeat / report / full routes per server. Agent's `reporter.js` accepts a `port` override and `agent.js` caches it from `/api/agent/config` (5min refresh, no restart). New admin endpoint `GET /api/admin/heartbeat-report/{agents,dcs,agents/:id/report-detail}` aggregates `ad_agent_heartbeat` + `ad_replication_status`. New Vue view `HeartbeatReportMonitorView.vue` shows dual-tab table (Agent / DC) with auto-refresh and detail drawer.

**Tech Stack:** Node 18+ HTTP server, Express, `node:test` (backend), vitest + @vue/test-utils (frontend), Pinia (frontend state), existing buildMockDb pattern, existing `splitSqlStatements` parser.

## Global Constraints

[From spec `docs/superpowers/specs/2026-08-07-heartbeat-report-multi-port.md`]

- **Default ports** — `webPort=8080` (existing `listenPort`), `heartbeatPort=8081`, `reportPort=8082`.
- **Port dedupe** — if `heartbeatPort == webPort` (or `reportPort == webPort`, or `heartbeatPort == reportPort`), no separate server is started; routes mount on the surviving server.
- **Backward compat** — no DB migration, no `appsettings.json` change required, no agent restart required. Existing agents with no port override continue to use `centerUrl:8080` verbatim.
- **Static heartbeat thresholds** — green ≤ `heartbeat_stale_seconds` (default 15s), yellow ≤ 60s, red > 60s, grey = never reported.
- **Body size limits** — heartbeatApp: `express.json({ limit: '256kb' })`, reportApp: `express.json({ limit: '10mb' })`.
- **Auth chain** — admin endpoints use per-route `[userAuth, requirePerm('admin:users')]` (same as `dcsRouter`, `lockoutRouter`, `schemaMigrationsRouter`).
- **Audit** — admin "heartbeat-report" reads are NOT audited (snapshot reads; same as dcsRouter list).
- **Init mode** — heartbeat/report servers NOT started in init mode (`needsInit=true`); webApp owns all traffic until finalized.
- **Agent URL override** — `baseUrl({ centerUrl, port })` strips trailing `:digits` only when `port` is non-null; null/0/undefined = use `centerUrl` verbatim.
- **publish/ mirror** — Task 8 (final) mirrors every new/modified source file (not tests) to `publish/`, rebuilds `frontend/dist`, regenerates `publish.zip`.
- **PowerShell 5.1 compat** — N/A (no scripts touched).
- **Test counts** — backend must stay ≥ 471 green (this plan adds ~15); frontend must stay ≥ 199 green (this plan adds ~5).

---

### Task 1: Backend config keys + `getAgentConfig` expansion

**Files:**
- Modify: `center/src/services/config.js` (lines 37-46, expand `getAgentConfig`)
- Modify: `center/appsettings.example.json` (add 3 new fields to defaults)
- Modify: `publish/center/appsettings.example.json` (mirror)
- Modify: `center/tests/services/config.test.js` (append 3 tests) — file may need to be created if not exists; check first

**Interfaces:**
- Consumes: existing `getConfig()` (returns `system_config` map)
- Produces:
  - `getAgentConfig()` returns object with NEW fields `heartbeatPort: number` (default 8081), `reportPort: number` (default 8082), `heartbeatStaleSeconds: number` (default 15). Existing fields preserved.

- [ ] **Step 1: Find or create `center/tests/services/config.test.js`**

If file does not exist, create it:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAgentConfig } from '../../src/services/config.js';
import { getDb } from '../../src/db/index.js';

// Each test stubs getDb().query to return a mock rows array of {config_key, config_value}.
// Pattern: buildMockDb is too heavy for this; use a plain stub.

// Use the existing pattern from `center/tests/services/audit.test.js` or similar to stub getDb.
// (Read one existing service test first to copy the stub pattern.)
```

Read `center/tests/services/` directory to find an existing test that stubs `getDb()` and copy its setup pattern. Then write 3 tests:

- [ ] **Step 2: Write failing test — defaults when keys missing**

```js
test('getAgentConfig: defaults ports + stale-seconds when keys missing', async () => {
  // stub getDb to return rows with only legacy keys
  const rows = [
    { config_key: 'polling_interval_minutes', config_value: '15' },
    { config_key: 'agent_token', config_value: 'tok' }
  ];
  // ... stub pattern from existing test ...
  const cfg = await getAgentConfig();
  assert.strictEqual(cfg.heartbeatPort, 8081);
  assert.strictEqual(cfg.reportPort, 8082);
  assert.strictEqual(cfg.heartbeatStaleSeconds, 15);
});
```

- [ ] **Step 3: Write failing test — values from system_config when present**

```js
test('getAgentConfig: reads heartbeat_port/report_port/heartbeat_stale_seconds from config', async () => {
  // stub to return heartbeat_port=9001, report_port=9002, heartbeat_stale_seconds=30
  const cfg = await getAgentConfig();
  assert.strictEqual(cfg.heartbeatPort, 9001);
  assert.strictEqual(cfg.reportPort, 9002);
  assert.strictEqual(cfg.heartbeatStaleSeconds, 30);
});
```

- [ ] **Step 4: Write failing test — non-numeric values coerce to default**

```js
test('getAgentConfig: non-numeric heartbeat_port coerces to 8081', async () => {
  // stub to return heartbeat_port='abc'
  const cfg = await getAgentConfig();
  assert.strictEqual(cfg.heartbeatPort, 8081);
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `cd center && npm test -- tests/services/config.test.js`
Expected: 3 failures — `cfg.heartbeatPort` is `undefined`.

- [ ] **Step 6: Implement `getAgentConfig` expansion**

In `center/src/services/config.js` modify the `getAgentConfig()` return object:

```js
export async function getAgentConfig() {
  const all = await getConfig();
  return {
    pollingIntervalMinutes: Number(all.polling_interval_minutes || 15),
    latencyThresholdMinutes: Number(all.latency_threshold_minutes || 180),
    heartbeatIntervalSeconds: Number(all.heartbeat_interval_seconds || 5),
    discoveryIntervalHours: Number(all.discovery_interval_hours || 4),
    agentToken: all.agent_token ?? null,
    heartbeatPort: Number(all.heartbeat_port) || 8081,
    reportPort: Number(all.report_port) || 8082,
    heartbeatStaleSeconds: Number(all.heartbeat_stale_seconds) || 15
  };
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd center && npm test -- tests/services/config.test.js`
Expected: 3 pass.

- [ ] **Step 8: Update `center/appsettings.example.json`**

Add the 3 new fields at the end of the top-level object (before the closing brace). Do NOT change existing keys. After change, file should have new keys: `heartbeat_port: 8081`, `report_port: 8082`, `heartbeat_stale_seconds: 15`. Add inline comments:

```json
  "heartbeat_port": 8081,
  "report_port": 8082,
  "heartbeat_stale_seconds": 15
```

- [ ] **Step 9: Mirror to `publish/center/appsettings.example.json`**

Run: `cp center/appsettings.example.json publish/center/appsettings.example.json && diff center/appsettings.example.json publish/center/appsettings.example.json && echo OK`
Expected: identical.

- [ ] **Step 10: Commit**

```bash
git add center/src/services/config.js center/appsettings.example.json publish/center/appsettings.example.json center/tests/services/config.test.js
git commit -m "feat(config): expose heartbeat/report ports + stale threshold to agents"
```

---

### Task 2: `multi-port.js` module — `startServers` + `closeAll` + dedupe

**Files:**
- Create: `center/src/multi-port.js`
- Create: `center/tests/multi-port.test.js`

**Interfaces:**
- Consumes: `node:http.createServer`, Express `app` instances
- Produces:
  - `startServers({ logger, roleAppPortList })` → returns `Promise<Array<{ srv, role, port }>>`. `roleAppPortList` is `[{ role, app, port }]`. Dedupes by `port` (later entries with same port are dropped). On listen error, rejects and closes any already-listening servers.
  - `closeAll(servers, logger)` → returns `Promise<void>`. Calls `srv.close()` on every entry; logs but does not throw on individual close errors. Idempotent (safe to call twice).

- [ ] **Step 1: Write failing test — three distinct ports create three servers**

In `center/tests/multi-port.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { startServers, closeAll } from '../src/multi-port.js';

test('startServers: 3 distinct ports → 3 server instances', async () => {
  const apps = [express(), express(), express()];
  apps.forEach((a, i) => { a.get(`/r${i}`, (_req, res) => res.send(`${i}`)); });
  const servers = await startServers({
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    roleAppPortList: [
      { role: 'web', app: apps[0], port: 0 },  // 0 = ephemeral
      { role: 'heartbeat', app: apps[1], port: 0 },
      { role: 'report', app: apps[2], port: 0 }
    ]
  });
  assert.strictEqual(servers.length, 3);
  // Each server has a distinct ephemeral port
  const ports = servers.map((s) => s.port);
  assert.strictEqual(new Set(ports).size, 3);
  await closeAll(servers, { info: () => {}, warn: () => {}, error: () => {} });
});
```

- [ ] **Step 2: Write failing test — dedupe same port**

```js
test('startServers: same port shared across roles → only 1 server', async () => {
  const apps = [express(), express()];
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  const servers = await startServers({
    logger,
    roleAppPortList: [
      { role: 'web', app: apps[0], port: 0 },
      { role: 'heartbeat', app: apps[1], port: 0 }  // intentionally same port
    ]
  });
  // Dedupes: only the first entry wins
  assert.strictEqual(servers.length, 1);
  assert.strictEqual(servers[0].role, 'web');
  await closeAll(servers, logger);
});
```

- [ ] **Step 3: Write failing test — listen error rejects and closes peer servers**

```js
test('startServers: listen error on one port → rejects, no leaked server', async () => {
  const apps = [express(), express()];
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  // First app uses port 1 (privileged, almost always fails); second uses 0 (ephemeral).
  await assert.rejects(
    startServers({
      logger,
      roleAppPortList: [
        { role: 'web', app: apps[0], port: 1 },
        { role: 'report', app: apps[1], port: 0 }
      ]
    }),
    /EACCES|EPERM|EADDRINUSE/  // platform-specific failure mode
  );
  // The peer server must be cleaned up; verify port 0 socket is not listening anymore.
  // Practical: just ensure no throw in a follow-up closeAll on the partial result.
  // (Promise.all may race; this is best-effort. The real test is that the rejected promise fires.)
});
```

- [ ] **Step 4: Write failing test — `closeAll` is idempotent**

```js
test('closeAll: safe to call twice', async () => {
  const app = express();
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  const servers = await startServers({
    logger,
    roleAppPortList: [{ role: 'web', app, port: 0 }]
  });
  await closeAll(servers, logger);
  await closeAll(servers, logger); // must not throw
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `cd center && npm test -- tests/multi-port.test.js`
Expected: 4 failures — module `multi-port.js` not found.

- [ ] **Step 6: Implement `multi-port.js`**

Write to `center/src/multi-port.js`:

```js
// multi-port.js — start N http.Server instances, one per role. Dedupes by port
// (overlapping ports collapse to one server; the first entry wins). On any
// listen failure, closes already-open peer servers before rejecting.

import { createServer } from 'node:http';

export async function startServers({ logger, roleAppPortList }) {
  // Dedupe by port. First entry wins; later entries with the same port are
  // silently dropped — their routes are NOT mounted on the surviving server
  // (the caller is responsible for combining apps before passing them in if
  // they want shared-port behavior).
  const seen = new Set();
  const deduped = roleAppPortList.filter((entry) => {
    if (seen.has(entry.port)) return false;
    seen.add(entry.port);
    return true;
  });

  const results = [];
  const tried = [];

  try {
    for (const { role, app, port } of deduped) {
      const srv = createServer(app);
      tried.push(srv);
      const bound = await new Promise((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(port, () => {
          const actualPort = srv.address().port;
          logger.info({ port: actualPort, role }, `${role} server listening`);
          resolve(actualPort);
        });
      });
      results.push({ srv, role, port: bound });
    }
    return results;
  } catch (err) {
    // Close any servers we managed to open before the failing one.
    await Promise.all(tried.map((srv) => new Promise((res) => srv.close(() => res()))));
    throw err;
  }
}

export async function closeAll(servers, logger) {
  await Promise.all(servers.map(({ srv, role }) =>
    new Promise((resolve) => {
      srv.close((err) => {
        if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') {
          logger.warn({ err: err.message, role }, 'server close error');
        }
        resolve();
      });
    })
  ));
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd center && npm test -- tests/multi-port.test.js`
Expected: 4 pass.

- [ ] **Step 8: Commit**

```bash
git add center/src/multi-port.js center/tests/multi-port.test.js
git commit -m "feat(center): multi-port server bootstrap (startServers + closeAll with port dedupe)"
```

---

### Task 3: `agentRouter` mount parameter refactor

**Files:**
- Modify: `center/src/routes/agent.js` (refactor to register routes based on `mount`)
- Create: `center/tests/routes/agent-multi-mount.test.js`

**Interfaces:**
- Consumes: `config.agentToken`, `logger`
- Produces:
  - `agentRouter({ config, logger, mount })` — `mount` is `'heartbeat' | 'report' | 'full'`.
    - `'heartbeat'` registers only: `POST /api/agent/heartbeat`, `GET /api/agent/ports`
    - `'report'` registers only: `POST /api/agent/report`, `POST /api/agent/discover`, `GET /api/agent/config`
    - `'full'` (default) registers ALL of the above

- [ ] **Step 1: Write failing test — `mount: 'heartbeat'` exposes only heartbeat routes**

In `center/tests/routes/agent-multi-mount.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { agentRouter } from '../../src/routes/agent.js';

function makeApp(mount) {
  const app = express();
  app.use(express.json());
  app.use(agentRouter({
    config: { agentToken: 'test-token' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    mount
  }));
  return app;
}

async function req(app, method, path, body, headers = {}) {
  // Use http.request against ephemeral port (same pattern as init/router.test.js call()).
  // ...
}

test('mount=heartbeat: POST /heartbeat registered, POST /report 404', async () => {
  const app = makeApp('heartbeat');
  const r1 = await req(app, 'POST', '/api/agent/heartbeat', { agentId: 'a' });
  assert.notStrictEqual(r1.status, 404, 'heartbeat should be mounted');
  const r2 = await req(app, 'POST', '/api/agent/report', { agentId: 'a' });
  assert.strictEqual(r2.status, 404, 'report should NOT be mounted');
});
```

- [ ] **Step 2: Write failing test — `mount: 'report'` mirrors above**

```js
test('mount=report: POST /report registered, POST /heartbeat 404', async () => {
  const app = makeApp('report');
  const r1 = await req(app, 'POST', '/api/agent/report', { agentId: 'a', collectedAt: '2026-01-01T00:00:00Z', data: [] });
  assert.notStrictEqual(r1.status, 404);
  const r2 = await req(app, 'POST', '/api/agent/heartbeat', { agentId: 'a' });
  assert.strictEqual(r2.status, 404);
});
```

- [ ] **Step 3: Write failing test — `mount: 'full'` registers everything**

```js
test('mount=full: all routes registered', async () => {
  const app = makeApp('full');
  const r1 = await req(app, 'POST', '/api/agent/heartbeat', { agentId: 'a' });
  assert.notStrictEqual(r1.status, 404);
  const r2 = await req(app, 'POST', '/api/agent/report', { agentId: 'a', collectedAt: '2026-01-01T00:00:00Z', data: [] });
  assert.notStrictEqual(r2.status, 404);
  const r3 = await req(app, 'GET', '/api/agent/ports');
  assert.notStrictEqual(r3.status, 404);
  const r4 = await req(app, 'GET', '/api/agent/config');
  assert.notStrictEqual(r4.status, 404);
  const r6 = await req(app, 'POST', '/api/agent/discover', { agentId: 'a', collectedAt: '2026-01-01T00:00:00Z', dc: { name: 'd' } });
  assert.notStrictEqual(r6.status, 404);
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd center && npm test -- tests/routes/agent-multi-mount.test.js`
Expected: 3 failures — current `agentRouter` ignores `mount` and registers everything; the heartbeat-only test would currently get `/report` as 200 not 404.

Actually first verify current behavior: existing `agentRouter` accepts no `mount` arg and registers everything. After the refactor, default should remain `full`. So tests for `mount: 'heartbeat'` and `mount: 'report'` would fail (since currently everything is mounted). The `mount: 'full'` test should pass even before refactor.

- [ ] **Step 5: Refactor `center/src/routes/agent.js`**

Replace the entire route registration section. The structure becomes:

```js
import { Router } from 'express';
import { agentToken } from '../auth/agent-token.js';
import { upsertStatus } from '../services/replication.js';
import { getConfig, getAgentConfig } from '../services/config.js';
import { upsertDiscoveredDc } from '../services/discovery.js';
import { listPorts } from '../services/ports.js';
import { upsertPortStatuses } from '../services/port-status.js';
import { getDb } from '../db/index.js';
import { toMysqlDatetime } from '../utils/datetime.js';

export function agentRouter({ config, logger, mount = 'full' }) {
  const r = Router();
  const agentMw = agentToken(config.agentToken);

  if (mount === 'heartbeat' || mount === 'full') {
    r.post('/api/agent/heartbeat', agentMw, async (req, res) => {
      // ... existing handler unchanged ...
    });

    r.get('/api/agent/ports', agentMw, async (req, res) => {
      // ... existing handler unchanged ...
    });
  }

  if (mount === 'report' || mount === 'full') {
    r.post('/api/agent/report', agentMw, async (req, res) => {
      // ... existing handler unchanged ...
    });

    r.post('/api/agent/discover', agentMw, async (req, res) => {
      // ... existing handler unchanged ...
    });

    r.get('/api/agent/config', async (_req, res) => {
      // ... existing handler unchanged ...
    });
  }

  return r;
}
```

Copy the existing handler bodies VERBATIM from the current file. Only the wrapping `if (mount === ...)` gates are new.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd center && npm test -- tests/routes/agent-multi-mount.test.js`
Expected: 3 pass.

- [ ] **Step 7: Run full backend test suite to confirm no regression**

Run: `cd center && npm test`
Expected: 471 + 3 (Task 1) + 4 (Task 2) + 3 (Task 3) = 481 pass.

- [ ] **Step 8: Commit**

```bash
git add center/src/routes/agent.js center/tests/routes/agent-multi-mount.test.js
git commit -m "refactor(agent-router): add mount parameter for heartbeat/report/full route subsets"
```

---

### Task 4: `server.js` restructure — 3 apps + 3 listeners

**Files:**
- Modify: `center/server.js` (split routes into 3 Express apps, replace single `app.listen` with `startServers`)
- Modify: `center/tests/server-multimount.test.js` (new — smoke test that 3 servers start)

**Interfaces:**
- Consumes: `startServers` from Task 2; `agentRouter` with `mount` from Task 3; `getAgentConfig` from Task 1 (returns `heartbeatPort`/`reportPort`)
- Produces: `server.js` boot creates 3 apps and calls `startServers` with the configured ports. In **init mode** (`needsInit === true`), only the webApp boots (heartbeat/report servers skipped).

- [ ] **Step 1: Write failing test — 3 servers boot in normal mode**

In `center/tests/server-multimount.test.js`, write an integration-style test that requires the server bootstrap without running the long-lived process:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

// We don't boot server.js directly (it does process.exit). Instead, test
// the helper export: extract `buildServerApps(config)` from server.js.
// For this test, just verify the apps are constructed and routes mounted.

// Refactor server.js to export `buildServerApps({ config, db, logger, needsInit })`
// returning { webApp, heartbeatApp, reportApp, ports: { web, heartbeat, report } }.

import { buildServerApps } from '../server.js';

test('buildServerApps: normal mode → 3 apps with distinct ports', () => {
  const result = buildServerApps({
    config: {
      listenPort: 9100, jwtSecret: 'x'.repeat(64), agentToken: 'tok',
      logLevel: 'info', env: 'prod', staticDir: './dist'
    },
    db: null,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    needsInit: false
  });
  assert.ok(result.webApp);
  assert.ok(result.heartbeatApp);
  assert.ok(result.reportApp);
  assert.strictEqual(result.ports.web, 9100);
  // heartbeat/report ports come from system_config; with no db, defaults apply
  assert.strictEqual(result.ports.heartbeat, 8081);
  assert.strictEqual(result.ports.report, 8082);
});
```

**Note**: this requires extracting a `buildServerApps` helper. If you'd rather not refactor server.js into a helper, write a lighter integration test that uses `supertest` against `createApp()` with different routes mounted directly. Pick whichever the implementer finds easier; the contract here is "3 apps exist with the right shape".

- [ ] **Step 2: Run test to verify it fails**

Expected: failure — `buildServerApps` not exported (or `webApp`/`heartbeatApp` not constructed separately).

- [ ] **Step 3: Refactor `center/server.js`**

Split the single `app.use(...)` chain. Extract a `buildServerApps` helper:

```js
import { createApp } from './src/app.js';
import { authRouter } from './src/routes/auth.js';
import { agentRouter } from './src/routes/agent.js';
// ... existing imports ...

export function buildServerApps({ config, db, logger, needsInit, systemConfig = {} }) {
  // systemConfig: { heartbeat_port, report_port, heartbeat_stale_seconds } from system_config
  const heartbeatPort = Number(systemConfig.heartbeat_port) || 8081;
  const reportPort    = Number(systemConfig.report_port)    || 8082;

  const webApp = createApp({ config, db, logger, needsInit });

  const heartbeatApp = express();
  heartbeatApp.use(express.json({ limit: '256kb' }));
  heartbeatApp.use(agentRouter({ config, logger, mount: 'heartbeat' }));

  const reportApp = express();
  reportApp.use(express.json({ limit: '10mb' }));
  reportApp.use(agentRouter({ config, logger, mount: 'report' }));

  return {
    webApp,
    heartbeatApp,
    reportApp,
    ports: { web: config.listenPort, heartbeat: heartbeatPort, report: reportPort }
  };
}
```

Then replace the existing route-mounting block in the IIFE with:

```js
const apps = buildServerApps({ config: finalConfig, db, logger, needsInit, systemConfig: await getConfig() });

if (needsInit) {
  // Init mode: only webApp runs (init owns the port)
  const server = apps.webApp.listen(finalConfig.listenPort, () => {
    logger.info({ port: finalConfig.listenPort, needsInit }, 'center listening');
  });
  // ... existing shutdown handler ...
} else {
  // Normal mode: 3 servers
  const servers = await startServers({
    logger,
    roleAppPortList: [
      { role: 'web',       app: apps.webApp,       port: apps.ports.web },
      { role: 'heartbeat', app: apps.heartbeatApp, port: apps.ports.heartbeat },
      { role: 'report',    app: apps.reportApp,    port: apps.ports.report }
    ]
  });
  const shutdown = async (sig) => {
    await closeAll(servers, logger);
    try { await closeWizardFacade(); } catch {}
    try { await close(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
```

- [ ] **Step 4: Run server-multimount test to verify it passes**

Run: `cd center && npm test -- tests/server-multimount.test.js`
Expected: 1 pass.

- [ ] **Step 5: Run full backend test suite**

Run: `cd center && npm test`
Expected: 481 + 1 = 482 pass.

- [ ] **Step 6: Smoke test — start the actual server, hit each port**

Run: `cd center && timeout 10 node server.js ./appsettings.json & sleep 3 && curl -s http://localhost:8080/api/init/status && echo "" && curl -s -X POST http://localhost:8081/api/agent/heartbeat -H 'X-Agent-Token: <token>' -d '{"agentId":"test"}' && echo "" && curl -s -X POST http://localhost:8082/api/agent/report -H 'X-Agent-Token: <token>' -d '{"agentId":"test","collectedAt":"2026-01-01T00:00:00Z","data":[]}' && kill %1 2>/dev/null`

Expected:
- `GET :8080/api/init/status` → 200 `{"needsInit":false}`
- `POST :8081/api/agent/heartbeat` → 200 (heartbeat server live)
- `POST :8082/api/agent/report` → 200 (report server live)
- `POST :8080/api/agent/heartbeat` → 404 (heartbeat NOT on web port)
- `POST :8081/api/agent/report` → 404 (report NOT on heartbeat port)

If port collisions happen (e.g., 8081 in use), the test should fail with EADDRINUSE — fix by changing appsettings values.

- [ ] **Step 7: Commit**

```bash
git add center/server.js center/tests/server-multimount.test.js
git commit -m "feat(center): split server into web/heartbeat/report apps + multi-port bootstrap"
```

---

### Task 5: Agent — `reporter.js` port override + `agent.js` port cache

**Files:**
- Modify: `agent/src/reporter.js` (add `port` param to `postHeartbeat` and `postReport`)
- Modify: `agent/agent.js` (add `cachedPorts` + `refreshAgentPorts`)
- Modify: `agent/tests/reporter.test.js` (append 2 tests)
- Create: `agent/tests/reporter-multi-port.test.js` (3 tests)
- Modify: `publish/agent/src/reporter.js` (mirror)
- Modify: `publish/agent/agent.js` (mirror)

**Interfaces:**
- Consumes: `node:http.requestJson`, `fetchConfig` (returns `{ heartbeatPort, reportPort, ... }`)
- Produces:
  - `postHeartbeat({ centerUrl, agentToken, port, payload })` — when `port` is truthy, URL = `${stripPort(centerUrl)}:${port}/api/agent/heartbeat`. When falsy, URL = `${centerUrl}/api/agent/heartbeat` (current behavior).
  - `postReport({ centerUrl, agentToken, port, snapshot })` — same port-overriding behavior.
  - `agent.js` keeps a module-level `cachedPorts = { heartbeatPort: null, reportPort: null }`. `refreshAgentPorts()` fetches and updates. Called at startup AND every 5 min. All `postHeartbeat`/`postReport` calls pass `port: cachedPorts.heartbeatPort` / `reportPort`.

- [ ] **Step 1: Write failing test — port override produces correct URL**

In `agent/tests/reporter-multi-port.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { postHeartbeat, postReport } from '../src/reporter.js';

// Helper: start a local server on ephemeral port that records the request URL,
// return its base URL like 'http://127.0.0.1:12345' AND close function.
function startRecorder(onReq) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, _res) => { onReq(req.url); });
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => srv.close(r))
      });
    });
  });
}

test('postHeartbeat: explicit port → URL strips centerUrl port and appends override', async () => {
  let recordedUrl = null;
  const rec = await startRecorder((u) => { recordedUrl = u; });
  try {
    const r = await postHeartbeat({
      centerUrl: 'http://example.test:9999',
      agentToken: 'tok',
      port: 8081,
      payload: { agentId: 'a' }
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(recordedUrl, '/api/agent/heartbeat');
  } finally { await rec.close(); }
});

test('postHeartbeat: no port → falls back to centerUrl verbatim', async () => {
  let recordedUrl = null;
  const rec = await startRecorder((u) => { recordedUrl = u; });
  try {
    await postHeartbeat({
      centerUrl: rec.base,  // ephemeral port is the only one in play
      agentToken: 'tok',
      port: null,
      payload: { agentId: 'a' }
    });
    assert.strictEqual(recordedUrl, '/api/agent/heartbeat');
  } finally { await rec.close(); }
});

test('postReport: port override applied symmetrically', async () => {
  let recordedUrl = null;
  const rec = await startRecorder((u) => { recordedUrl = u; });
  try {
    await postReport({
      centerUrl: 'http://example.test:9999',
      agentToken: 'tok',
      port: 8082,
      snapshot: { AgentId: 'a', CollectedAt: '2026-01-01T00:00:00Z', Entries: [] }
    });
    assert.strictEqual(recordedUrl, '/api/agent/report');
  } finally { await rec.close(); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agent && npm test -- tests/reporter-multi-port.test.js`
Expected: 3 failures — `postHeartbeat`/`postReport` currently ignore `port`.

- [ ] **Step 3: Implement `reporter.js` changes**

In `agent/src/reporter.js`, add a `baseUrl` helper at the top and modify `postHeartbeat`/`postReport`:

```js
// Build base URL: if `port` is truthy, strip trailing :digits from centerUrl
// and append the override port. Otherwise return centerUrl as-is.
function baseUrl({ centerUrl, port }) {
  const trimmed = String(centerUrl).replace(/\/+$/, '');
  if (!port) return trimmed;
  return trimmed.replace(/:\d+$/, '') + ':' + Number(port);
}

export function postHeartbeat({ centerUrl, agentToken, port, payload }) {
  return requestJson({
    method: 'POST',
    url: `${baseUrl({ centerUrl, port })}/api/agent/heartbeat`,
    headers: { 'X-Agent-Token': agentToken },
    body: payload,
  });
}

export function postReport({ centerUrl, agentToken, port, snapshot }) {
  return requestJson({
    method: 'POST',
    url: `${baseUrl({ centerUrl, port })}/api/agent/report`,
    headers: { 'X-Agent-Token': agentToken },
    body: {
      agentId: snapshot.AgentId ?? snapshot.agentId,
      collectedAt: snapshot.CollectedAt ?? snapshot.collectedAt,
      data: Array.isArray(snapshot.Entries) ? snapshot.Entries.map(toCamelEntry) : []
    },
  });
}
```

- [ ] **Step 4: Update `agent/agent.js` to cache ports + pass them in**

Add after the existing `cachedPortList` block (around line 30):

```js
// Center-configured heartbeat / report ports. Refreshed every 5min alongside
// the existing config refresh; null = no override (use centerUrl verbatim).
let cachedPorts = { heartbeatPort: null, reportPort: null };

async function refreshAgentPorts() {
  const r = await fetchConfig({ centerUrl: config.centerUrl, agentToken: config.agentToken });
  if (r.ok && r.data) {
    cachedPorts.heartbeatPort = Number(r.data.heartbeatPort) || null;
    cachedPorts.reportPort    = Number(r.data.reportPort)    || null;
  }
}
await refreshAgentPorts();
```

Modify the existing 5-min `configRefresh` interval to also call `refreshAgentPorts()`:

```js
const configRefresh = setInterval(async () => {
  await refreshAgentPorts();  // ← new line
  const r = await fetchConfig({ centerUrl: config.centerUrl, agentToken: config.agentToken });
  if (r.ok && r.data?.pollingIntervalMinutes) {
    config.pollingIntervalMinutes = Number(r.data.pollingIntervalMinutes);
  }
  if (r.ok && r.data?.discoveryIntervalHours) {
    config.discoveryIntervalHours = Number(r.data.discoveryIntervalHours);
  }
}, 5 * 60_000);
```

Update the heartbeat `send` and scheduler `send` to pass `port`:

```js
// Standalone heartbeat send
send: async (p) => {
  await postHeartbeat({
    centerUrl: config.centerUrl,
    agentToken: config.agentToken,
    port: cachedPorts.heartbeatPort,
    payload: p
  });
}

// Scheduler send (post-collect cycle)
send: (snap) => postReport({
  centerUrl: config.centerUrl,
  agentToken: config.agentToken,
  port: cachedPorts.reportPort,
  snapshot: snap
})

// Scheduler sendHeartbeat (post-collect cycle, post-cycle liveness)
sendHeartbeat: (extra) => postHeartbeat({
  centerUrl: config.centerUrl,
  agentToken: config.agentToken,
  port: cachedPorts.heartbeatPort,
  payload: { agentId: config.agentId, agentVersion: '0.1.0', ...extra }
})
```

- [ ] **Step 5: Mirror to `publish/agent/`**

```bash
cp agent/src/reporter.js publish/agent/src/reporter.js
cp agent/agent.js publish/agent/agent.js
diff agent/src/reporter.js publish/agent/src/reporter.js && echo OK
diff agent/agent.js publish/agent/agent.js && echo OK
```

- [ ] **Step 6: Run agent test suite**

Run: `cd agent && npm test`
Expected: existing 48 + 3 new = 51 pass.

- [ ] **Step 7: Commit**

```bash
git add agent/src/reporter.js agent/agent.js agent/tests/reporter-multi-port.test.js publish/agent/src/reporter.js publish/agent/agent.js
git commit -m "feat(agent): use center-configured heartbeat/report ports with 5min refresh"
```

---

### Task 6: Admin endpoints — `GET /api/admin/heartbeat-report/{agents,dcs,agents/:id/report-detail}`

**Files:**
- Create: `center/src/routes/heartbeat-report.js`
- Create: `center/src/services/heartbeat-report.js`
- Modify: `center/src/db/sql.js` (add 4 SQL helpers in both dialect blocks)
- Modify: `center/server.js` (mount the new router in normal mode)
- Create: `center/tests/admin-heartbeat-report.test.js`
- Modify: `publish/center/src/routes/heartbeat-report.js` (mirror)
- Modify: `publish/center/src/services/heartbeat-report.js` (mirror)
- Modify: `publish/center/src/db/sql.js` (mirror)
- Modify: `publish/center/server.js` (mirror)

**Interfaces:**
- Consumes: `db.query`, `db.execute`, `userAuth({ secret })`, `requirePerm('admin:users')`
- Produces:
  - `GET /api/admin/heartbeat-report/agents` → `{ agents: [...], heartbeatStaleSeconds: N }`
  - `GET /api/admin/heartbeat-report/dcs` → `{ agents: [...], heartbeatStaleSeconds: N }` (joined with ad_dcs + ad_sites)
  - `GET /api/admin/heartbeat-report/agents/:agentId/report-detail` → `{ agentId, collectedAt, entries: [...] }`

  Each agent in the list:
  ```ts
  {
    agentId: string,
    agentVersion: string | null,
    lastHeartbeatAt: ISO string | null,
    lastReportAt: ISO string | null,
    lastReportStatus: string | null,
    pendingQueueSize: number,
    reportSummary: {
      totalLinks: number, successCount: number, failCount: number,
      latestErrorMessage: string | null, latestFailedLink: string | null
    } | null
  }
  ```
  DC view adds: `siteName`, `regionCode`, `ipAddress`, `osVersion`, `isPdc`.

- [ ] **Step 1: Add SQL helpers to `center/src/db/sql.js`**

Add 4 helpers in both `VARIANTS.mysql` and `VARIANTS.mssql` blocks:

**mysql** block (find the `heartbeat:` group; add new key `agentsList`):
```js
agentsList: `SELECT h.agent_id, h.agent_version, h.last_heartbeat_at, h.last_report_at,
                    h.last_report_status, h.pending_queue_size
             FROM ad_agent_heartbeat h
             ORDER BY h.agent_id`,
dcsList: `SELECT h.agent_id, h.agent_version, h.last_heartbeat_at, h.last_report_at,
                 h.last_report_status, h.pending_queue_size,
                 d.dc_name, d.ip_address, d.os_version, d.is_pdc,
                 s.site_name, s.region_code
          FROM ad_agent_heartbeat h
          LEFT JOIN ad_dcs d ON d.dc_name = h.agent_id
          LEFT JOIN ad_sites s ON s.site_id = d.site_id
          ORDER BY h.agent_id`,
reportSummaryFor: (agentId, sinceIso) =>
  `SELECT s.source_dc, s.dest_dc, s.status_code, s.error_message, s.collected_at
   FROM ad_replication_status s
   INNER JOIN (
     SELECT MAX(collected_at) AS max_collected
     FROM ad_replication_status
     WHERE agent_id = ? AND collected_at >= ?
   ) m ON s.collected_at = m.max_collected AND s.agent_id = ?
   ORDER BY s.source_dc, s.dest_dc`,
latestReportEntries: (agentId, sinceIso, limit) =>
  `SELECT source_dc, dest_dc, source_site, dest_site, naming_context,
          status_code, error_message, last_success_time, last_attempt_time
   FROM ad_replication_status
   WHERE agent_id = ? AND collected_at >= ?
   ORDER BY collected_at DESC
   LIMIT ${Number(limit)}`
```

**mssql** block (mirror with `TOP (?)` instead of `LIMIT`, `?` placeholders for offset/since):
```js
agentsList: `SELECT h.agent_id, h.agent_version, h.last_heartbeat_at, h.last_report_at,
                    h.last_report_status, h.pending_queue_size
             FROM ad_agent_heartbeat h
             ORDER BY h.agent_id`,
dcsList: `SELECT h.agent_id, h.agent_version, h.last_heartbeat_at, h.last_report_at,
                 h.last_report_status, h.pending_queue_size,
                 d.dc_name, d.ip_address, d.os_version, d.is_pdc,
                 s.site_name, s.region_code
          FROM ad_agent_heartbeat h
          LEFT JOIN ad_dcs d ON d.dc_name = h.agent_id
          LEFT JOIN ad_sites s ON s.site_id = d.site_id
          ORDER BY h.agent_id`,
reportSummaryFor: (agentId, sinceIso) =>
  `SELECT s.source_dc, s.dest_dc, s.status_code, s.error_message, s.collected_at
   FROM ad_replication_status s
   INNER JOIN (
     SELECT TOP 1 collected_at AS max_collected
     FROM ad_replication_status
     WHERE agent_id = ? AND collected_at >= ?
     ORDER BY collected_at DESC
   ) m ON s.collected_at = m.max_collected AND s.agent_id = ?
   ORDER BY s.source_dc, s.dest_dc`,
latestReportEntries: (agentId, sinceIso, limit) =>
  `SELECT TOP (?) source_dc, dest_dc, source_site, dest_site, naming_context,
                 status_code, error_message, last_success_time, last_attempt_time
   FROM ad_replication_status
   WHERE agent_id = ? AND collected_at >= ?
   ORDER BY collected_at DESC`
```

- [ ] **Step 2: Mirror SQL changes to `publish/center/src/db/sql.js`**

```bash
cp center/src/db/sql.js publish/center/src/db/sql.js
```

- [ ] **Step 3: Write failing test — agents endpoint shape**

In `center/tests/admin-heartbeat-report.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heartbeatReportService } from '../../src/services/heartbeat-report.js';
import { buildMockDb } from '../helpers/db-mock.js';

// Mock pattern from existing tests; copy the exact shape.

test('agents list: returns rows from ad_agent_heartbeat with reportSummary aggregation', async () => {
  const mockDb = buildMockDb({
    rows: [
      { agent_id: 'dc01', agent_version: '0.1.0', last_heartbeat_at: new Date('2026-08-07T15:30:00Z'),
        last_report_at: new Date('2026-08-07T15:00:00Z'), last_report_status: 'ok', pending_queue_size: 0 }
    ],
    onExecute: (sql, params) => {
      // reportSummaryFor returns summary rows
      if (/ad_replication_status/.test(sql)) {
        return { rows: [
          { source_dc: 'dc01', dest_dc: 'dc02', status_code: 0, error_message: null, collected_at: new Date() },
          { source_dc: 'dc01', dest_dc: 'dc03', status_code: 1, error_message: '延迟高', collected_at: new Date() }
        ]};
      }
      return { rows: [] };
    }
  });
  // ... wire mockDb into service ...
  const result = await heartbeatReportService.listAgents(mockDb);
  assert.strictEqual(result.agents.length, 1);
  assert.strictEqual(result.agents[0].agentId, 'dc01');
  assert.strictEqual(result.agents[0].reportSummary.totalLinks, 2);
  assert.strictEqual(result.agents[0].reportSummary.successCount, 1);
  assert.strictEqual(result.agents[0].reportSummary.failCount, 1);
  assert.strictEqual(result.agents[0].reportSummary.latestErrorMessage, '延迟高');
  assert.strictEqual(result.agents[0].reportSummary.latestFailedLink, 'dc01→dc03');
});
```

(Read `center/tests/helpers/db-mock.js` first to use the exact `buildMockDb` API. The shape and `onExecute` callback signature may differ — adjust accordingly.)

- [ ] **Step 4: Write failing test — agent with no reports → null summary**

```js
test('agents list: agent with no reports → lastReportAt null, reportSummary null', async () => {
  // Mock ad_agent_heartbeat row with last_report_at=null
  // Mock ad_replication_status query returning empty rows
  const result = await heartbeatReportService.listAgents(mockDb);
  const a = result.agents.find((x) => x.agentId === 'dc-never');
  assert.strictEqual(a.lastReportAt, null);
  assert.strictEqual(a.reportSummary, null);
});
```

- [ ] **Step 5: Write failing test — `report-detail` endpoint shape**

```js
test('report-detail: returns entries for the most recent collected_at', async () => {
  // Mock ad_replication_status with two collected_at values; expect only the most recent 3 entries
  const result = await heartbeatReportService.getLatestReportDetail(mockDb, 'dc01');
  assert.ok(result.collectedAt);
  assert.ok(Array.isArray(result.entries));
  assert.ok(result.entries.length <= 100);
});
```

- [ ] **Step 6: Write failing test — 401 without token (router-level)**

```js
test('GET /api/admin/heartbeat-report/agents: 401 without token', async () => {
  // Use the existing auth chain pattern from center/tests/admin-dcs.test.js or similar.
  // Wire the router without an Authorization header; expect 401.
});
```

- [ ] **Step 7: Run tests to verify they fail**

Run: `cd center && npm test -- tests/admin-heartbeat-report.test.js`
Expected: failures — `heartbeatReportService` not exported.

- [ ] **Step 8: Implement `center/src/services/heartbeat-report.js`**

```js
import { getDb } from '../db/index.js';
import { getConfig } from './config.js';

const REPORT_SUMMARY_LOOKBACK_HOURS = 24;

export const heartbeatReportService = {
  async listAgents() {
    const db = getDb();
    const { rows: agents } = await db.query(db.sql.heartbeat.agentsList);
    const since = new Date(Date.now() - REPORT_SUMMARY_LOOKBACK_HOURS * 3600 * 1000).toISOString();
    return {
      agents: await Promise.all(agents.map(async (row) => ({
        agentId: row.agent_id,
        agentVersion: row.agent_version,
        lastHeartbeatAt: row.last_heartbeat_at ? new Date(row.last_heartbeat_at).toISOString() : null,
        lastReportAt: row.last_report_at ? new Date(row.last_report_at).toISOString() : null,
        lastReportStatus: row.last_report_status,
        pendingQueueSize: Number(row.pending_queue_size) || 0,
        reportSummary: await this._summaryFor(db, row.agent_id, row.last_report_at, since)
      }))),
      heartbeatStaleSeconds: (await this._staleSeconds())
    };
  },

  async listDcs() {
    const db = getDb();
    const { rows: dcs } = await db.query(db.sql.heartbeat.dcsList);
    const since = new Date(Date.now() - REPORT_SUMMARY_LOOKBACK_HOURS * 3600 * 1000).toISOString();
    return {
      agents: await Promise.all(dcs.map(async (row) => ({
        agentId: row.agent_id,
        agentVersion: row.agent_version,
        lastHeartbeatAt: row.last_heartbeat_at ? new Date(row.last_heartbeat_at).toISOString() : null,
        lastReportAt: row.last_report_at ? new Date(row.last_report_at).toISOString() : null,
        lastReportStatus: row.last_report_status,
        pendingQueueSize: Number(row.pending_queue_size) || 0,
        siteName: row.site_name,
        regionCode: row.region_code,
        ipAddress: row.ip_address,
        osVersion: row.os_version,
        isPdc: !!row.is_pdc,
        reportSummary: await this._summaryFor(db, row.agent_id, row.last_report_at, since)
      }))),
      heartbeatStaleSeconds: (await this._staleSeconds())
    };
  },

  async getLatestReportDetail(_db, agentId) {
    const db = _db ?? getDb();
    const since = new Date(Date.now() - REPORT_SUMMARY_LOOKBACK_HOURS * 3600 * 1000).toISOString();
    const { rows } = await db.query(db.sql.heartbeat.latestReportEntries(agentId, since, 100));
    if (!rows.length) return { agentId, collectedAt: null, entries: [] };
    const collectedAt = new Date(rows[0].collected_at).toISOString();
    return {
      agentId,
      collectedAt,
      entries: rows.map((r) => ({
        sourceDc: r.source_dc,
        destDc: r.dest_dc,
        sourceSite: r.source_site,
        destSite: r.dest_site,
        namingContext: r.naming_context,
        statusCode: r.status_code,
        errorMessage: r.error_message,
        lastSuccessTime: r.last_success_time,
        lastAttemptTime: r.last_attempt_time
      }))
    };
  },

  async _summaryFor(db, agentId, lastReportAt, since) {
    if (!lastReportAt) return null;
    const lastReportIso = new Date(lastReportAt).toISOString();
    const { rows } = await db.query(db.sql.heartbeat.reportSummaryFor(agentId, since));
    if (!rows.length) return null;
    let successCount = 0;
    let failCount = 0;
    let latestErrorMessage = null;
    let latestFailedLink = null;
    for (const row of rows) {
      if (Number(row.status_code) === 0) successCount++;
      else {
        failCount++;
        if (!latestErrorMessage && row.error_message) {
          latestErrorMessage = row.error_message;
          latestFailedLink = `${row.source_dc}→${row.dest_dc}`;
        }
      }
    }
    return {
      totalLinks: rows.length,
      successCount,
      failCount,
      latestErrorMessage,
      latestFailedLink
    };
  },

  async _staleSeconds() {
    const cfg = await getConfig();
    return Number(cfg.heartbeat_stale_seconds) || 15;
  }
};
```

**Note**: The mysql `reportSummaryFor` returns rows from a JOIN that finds the MAX(collected_at) within the lookback window. The function is documented in the SQL block above. Read it carefully before implementing — verify the query matches the service code expectations.

- [ ] **Step 9: Implement `center/src/routes/heartbeat-report.js`**

```js
import { Router } from 'express';
import { heartbeatReportService } from '../services/heartbeat-report.js';

export function heartbeatReportRouter({ requireAuth, requirePerm }) {
  const r = Router();
  const mw = [requireAuth, requirePerm('admin:users')];

  r.get('/api/admin/heartbeat-report/agents', ...mw, async (_req, res) => {
    try {
      const out = await heartbeatReportService.listAgents();
      res.json(out);
    } catch (e) {
      // ... logger.error + 500
    }
  });

  r.get('/api/admin/heartbeat-report/dcs', ...mw, async (_req, res) => {
    try {
      const out = await heartbeatReportService.listDcs();
      res.json(out);
    } catch (e) { /* ... 500 */ }
  });

  r.get('/api/admin/heartbeat-report/agents/:agentId/report-detail', ...mw, async (req, res) => {
    try {
      const out = await heartbeatReportService.getLatestReportDetail(undefined, req.params.agentId);
      res.json(out);
    } catch (e) { /* ... 500 */ }
  });

  return r;
}
```

(Follow the existing admin routers' pattern for try/catch + logger.error — copy from `center/src/routes/dcs.js`.)

- [ ] **Step 10: Mount the router in `center/server.js`**

In the normal-mode block (alongside `dcsRouter`/`lockoutRouter`/`schemaMigrationsRouter`):

```js
const heartbeatReportRouter = (await import('./src/routes/heartbeat-report.js')).heartbeatReportRouter;
app.use(heartbeatReportRouter({
  requireAuth: userAuth({ secret: finalConfig.jwtSecret }),
  requirePerm: (perm) => requirePerm(perm)
}));
```

Or add to the top-level imports. Adjust based on existing style.

- [ ] **Step 11: Mirror to `publish/center/`**

```bash
cp center/src/routes/heartbeat-report.js publish/center/src/routes/heartbeat-report.js
cp center/src/services/heartbeat-report.js publish/center/src/services/heartbeat-report.js
cp center/src/db/sql.js publish/center/src/db/sql.js
cp center/server.js publish/center/server.js
```

- [ ] **Step 12: Run tests to verify they pass**

Run: `cd center && npm test -- tests/admin-heartbeat-report.test.js`
Expected: 4 pass.

- [ ] **Step 13: Run full backend test suite**

Run: `cd center && npm test`
Expected: 482 + 4 = 486 pass.

- [ ] **Step 14: Commit**

```bash
git add center/src/routes/heartbeat-report.js center/src/services/heartbeat-report.js center/src/db/sql.js center/server.js center/tests/admin-heartbeat-report.test.js publish/center/src/routes/heartbeat-report.js publish/center/src/services/heartbeat-report.js publish/center/src/db/sql.js publish/center/server.js
git commit -m "feat(admin): heartbeat-report endpoints (agents/dcs/report-detail)"
```

---

### Task 7: Admin view — `HeartbeatReportMonitorView.vue`

**Files:**
- Create: `frontend/src/views/admin/HeartbeatReportMonitorView.vue`
- Create: `frontend/src/api/heartbeatReport.js` (adminApi-like wrapper)
- Modify: `frontend/src/router.js` (register `/admin/heartbeat-report` route)
- Modify: `frontend/src/components/AdminLayout.vue` (add nav link in 监控运维 group)
- Create: `frontend/tests/heartbeat-report-monitor-view.test.js`
- Modify: `frontend/src/views/admin/PackagesView.vue` (NOT — that's a different view)

**Interfaces:**
- Consumes: `adminApi` pattern from existing files (read `frontend/src/api/admin.js` for shape)
- Produces:
  - View with two tabs: `agent` / `dc`. Default `agent`.
  - Two tables (心跳 / 报告) below tabs.
  - Auto-refresh toggle (5s / 10s / 30s / off).
  - Click row → right-side drawer with report payload.
  - Heartbeat color computed from `now - lastHeartbeatAt` and `heartbeatStaleSeconds`.

- [ ] **Step 1: Write failing test — view renders default tab + table headers**

In `frontend/tests/heartbeat-report-monitor-view.test.js`:

```js
import { test, expect, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import HeartbeatReportMonitorView from '../src/views/admin/HeartbeatReportMonitorView.vue';
import { adminApi } from '../src/api/admin.js';

vi.mock('../src/api/admin.js', () => ({
  adminApi: {
    listHeartbeatReportAgents: vi.fn(),
    listHeartbeatReportDcs: vi.fn(),
    getHeartbeatReportDetail: vi.fn()
  }
}));

test('default tab is "agent" and shows heartbeat table headers', async () => {
  adminApi.listHeartbeatReportAgents.mockResolvedValue({
    data: { agents: [], heartbeatStaleSeconds: 15 }
  });
  const wrapper = mount(HeartbeatReportMonitorView);
  await flushPromises();
  expect(wrapper.text()).toContain('心跳表');
  expect(wrapper.find('[data-test="tab-agent"]').classes()).toContain('active');
});
```

- [ ] **Step 2: Write failing test — heartbeat color mapping (4 cases)**

```js
test('heartbeat status: 4 cases (green/yellow/red/never)', async () => {
  const now = new Date('2026-08-07T15:30:00Z').getTime();
  vi.setSystemTime(now);
  adminApi.listHeartbeatReportAgents.mockResolvedValue({
    data: { heartbeatStaleSeconds: 15, agents: [
      { agentId: 'green',  lastHeartbeatAt: new Date(now - 5_000).toISOString() },          // 5s ago
      { agentId: 'yellow', lastHeartbeatAt: new Date(now - 30_000).toISOString() },         // 30s ago
      { agentId: 'red',    lastHeartbeatAt: new Date(now - 120_000).toISOString() },        // 2min ago
      { agentId: 'never',  lastHeartbeatAt: null }
    ] }
  });
  const wrapper = mount(HeartbeatReportMonitorView);
  await flushPromises();
  const rows = wrapper.findAll('[data-test="heartbeat-row"]');
  expect(rows[0].attributes('data-status')).toBe('green');
  expect(rows[1].attributes('data-status')).toBe('yellow');
  expect(rows[2].attributes('data-status')).toBe('red');
  expect(rows[3].attributes('data-status')).toBe('never');
});
```

- [ ] **Step 3: Write failing test — clicking row opens drawer**

```js
test('clicking a heartbeat row opens drawer with payload', async () => {
  adminApi.listHeartbeatReportAgents.mockResolvedValue({
    data: { heartbeatStaleSeconds: 15, agents: [
      { agentId: 'dc01', lastHeartbeatAt: new Date().toISOString(), reportSummary: { totalLinks: 12, successCount: 12, failCount: 0, latestErrorMessage: null, latestFailedLink: null } }
    ] }
  });
  adminApi.getHeartbeatReportDetail.mockResolvedValue({
    data: { agentId: 'dc01', collectedAt: '2026-08-07T15:00:00Z', entries: [] }
  });
  const wrapper = mount(HeartbeatReportMonitorView);
  await flushPromises();
  await wrapper.find('[data-test="heartbeat-row"]').trigger('click');
  await flushPromises();
  expect(wrapper.find('[data-test="drawer"]').exists()).toBe(true);
});
```

- [ ] **Step 4: Write failing test — auto-refresh tick**

```js
test('auto-refresh: setInterval fires every 5s and calls listHeartbeatReportAgents again', async () => {
  vi.useFakeTimers();
  adminApi.listHeartbeatReportAgents.mockResolvedValue({ data: { agents: [], heartbeatStaleSeconds: 15 } });
  const wrapper = mount(HeartbeatReportMonitorView, { props: { refreshIntervalSeconds: 5 } });
  await flushPromises();
  const callsBefore = adminApi.listHeartbeatReportAgents.mock.calls.length;
  vi.advanceTimersByTime(5_000);
  await flushPromises();
  const callsAfter = adminApi.listHeartbeatReportAgents.mock.calls.length;
  expect(callsAfter).toBeGreaterThan(callsBefore);
  vi.useRealTimers();
});
```

- [ ] **Step 5: Write failing test — DC tab fetch uses `dcs` endpoint**

```js
test('DC tab switches fetch to listHeartbeatReportDcs', async () => {
  adminApi.listHeartbeatReportAgents.mockResolvedValue({ data: { agents: [], heartbeatStaleSeconds: 15 } });
  adminApi.listHeartbeatReportDcs.mockResolvedValue({ data: { agents: [], heartbeatStaleSeconds: 15 } });
  const wrapper = mount(HeartbeatReportMonitorView);
  await flushPromises();
  await wrapper.find('[data-test="tab-dc"]').trigger('click');
  await flushPromises();
  expect(adminApi.listHeartbeatReportDcs).toHaveBeenCalled();
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd frontend && npx vitest run tests/heartbeat-report-monitor-view.test.js`
Expected: 5 failures — view file not found.

- [ ] **Step 7: Implement `frontend/src/api/heartbeatReport.js`**

```js
import api from './client.js';

export const heartbeatReportApi = {
  listAgents: () => api.get('/api/admin/heartbeat-report/agents'),
  listDcs:    () => api.get('/api/admin/heartbeat-report/dcs'),
  getDetail:  (agentId) => api.get(`/api/admin/heartbeat-report/agents/${encodeURIComponent(agentId)}/report-detail`)
};
```

- [ ] **Step 8: Implement `HeartbeatReportMonitorView.vue`**

Structure (follow `PortsView.vue` + `SitesCatalogView.vue` style):

```vue
<template>
  <AdminLayout>
    <div class="header">
      <h2>心跳与报告监控</h2>
      <div class="refresh-toggle">
        自动刷新:
        <select v-model.number="refreshIntervalSeconds">
          <option :value="5">5 秒</option>
          <option :value="10">10 秒</option>
          <option :value="30">30 秒</option>
          <option :value="0">关闭</option>
        </select>
      </div>
    </div>
    <div class="tabs">
      <button data-test="tab-agent" :class="{active: tab==='agent'}" @click="tab='agent'">按 Agent</button>
      <button data-test="tab-dc"    :class="{active: tab==='dc'}"    @click="tab='dc'">按 DC</button>
    </div>
    <h3>心跳表</h3>
    <table class="t">
      <thead><tr><th>状态</th><th>{{ tab==='agent' ? 'Agent' : 'DC' }} 名称</th><th v-if="tab==='dc'">站点</th><th>最新心跳时间</th><th>延迟</th></tr></thead>
      <tbody>
        <tr v-for="row in rows" :key="row.agentId" :data-test="'heartbeat-row'" :data-status="statusOf(row)" @click="openDrawer(row)">
          <td><span :class="['dot', statusOf(row)]"></span> {{ statusLabel(row) }}</td>
          <td>{{ row.agentId }}</td>
          <td v-if="tab==='dc'">{{ row.siteName || '—' }}</td>
          <td>{{ formatRelative(row.lastHeartbeatAt) }}</td>
          <td>{{ formatLatency(row.lastHeartbeatAt) }}</td>
        </tr>
        <tr v-if="!rows.length"><td colspan="5" class="empty">暂无 Agent — 等待心跳上报</td></tr>
      </tbody>
    </table>

    <h3>报告表</h3>
    <table class="t">
      <thead><tr><th>状态</th><th>{{ tab==='agent' ? 'Agent' : 'DC' }} 名称</th><th>最近报告</th><th>错误摘要</th><th>成功率</th></tr></thead>
      <tbody>
        <tr v-for="row in rows" :key="row.agentId" :data-test="'report-row'" @click="openDrawer(row)">
          <td>{{ reportStatusLabel(row) }}</td>
          <td>{{ row.agentId }}</td>
          <td>{{ formatRelative(row.lastReportAt) }}</td>
          <td>{{ row.reportSummary?.latestErrorMessage || '—' }}</td>
          <td v-if="row.reportSummary">{{ row.reportSummary.successCount }} / {{ row.reportSummary.totalLinks }}</td>
          <td v-else>—</td>
        </tr>
      </tbody>
    </table>

    <div v-if="drawerAgentId" data-test="drawer" class="drawer-bg" @click.self="drawerAgentId=null">
      <div class="drawer">
        <h3>{{ drawerAgentId }} 最近报告</h3>
        <pre>{{ JSON.stringify(drawerPayload, null, 2) }}</pre>
        <button @click="drawerAgentId=null">关闭</button>
      </div>
    </div>
  </AdminLayout>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import AdminLayout from '../../components/AdminLayout.vue';
import { heartbeatReportApi } from '../../api/heartbeatReport.js';

const tab = ref('agent');
const agentsRows = ref([]);
const dcsRows = ref([]);
const heartbeatStaleSeconds = ref(15);
const refreshIntervalSeconds = ref(5);
const drawerAgentId = ref(null);
const drawerPayload = ref(null);
let timer = null;

const rows = computed(() => tab.value === 'agent' ? agentsRows.value : dcsRows.value);

function statusOf(row) {
  if (!row.lastHeartbeatAt) return 'never';
  const gap = (Date.now() - new Date(row.lastHeartbeatAt).getTime()) / 1000;
  if (gap <= heartbeatStaleSeconds.value) return 'green';
  if (gap <= 60) return 'yellow';
  return 'red';
}
function statusLabel(row) {
  return { green: '在线', yellow: '延迟', red: '掉线', never: '未上报' }[statusOf(row)];
}
function reportStatusLabel(row) {
  if (!row.lastReportAt) return '⏸ 未上传';
  if (!row.reportSummary) return '?';
  if (row.reportSummary.failCount === 0) return '✅ OK';
  return '⚠️ 部分失败';
}
function formatRelative(s) {
  if (!s) return '—';
  const gap = Math.round((Date.now() - new Date(s).getTime()) / 1000);
  if (gap < 60) return `${gap} 秒前`;
  if (gap < 3600) return `${Math.round(gap / 60)} 分钟前`;
  return `${Math.round(gap / 3600)} 小时前`;
}
function formatLatency(s) {
  if (!s) return '—';
  return `${Math.round((Date.now() - new Date(s).getTime()) / 1000)}s`;
}

async function load() {
  if (tab.value === 'agent') {
    const r = await heartbeatReportApi.listAgents();
    agentsRows.value = r.data?.agents || [];
    heartbeatStaleSeconds.value = r.data?.heartbeatStaleSeconds || 15;
  } else {
    const r = await heartbeatReportApi.listDcs();
    dcsRows.value = r.data?.agents || [];
    heartbeatStaleSeconds.value = r.data?.heartbeatStaleSeconds || 15;
  }
}
function startTimer() {
  stopTimer();
  if (refreshIntervalSeconds.value > 0) {
    timer = setInterval(load, refreshIntervalSeconds.value * 1000);
  }
}
function stopTimer() {
  if (timer) { clearInterval(timer); timer = null; }
}
async function openDrawer(row) {
  drawerAgentId.value = row.agentId;
  drawerPayload.value = null;
  const r = await heartbeatReportApi.getDetail(row.agentId);
  drawerPayload.value = r.data;
}

onMounted(() => { load().then(startTimer); });
onBeforeUnmount(stopTimer);
watch(tab, () => load());
watch(refreshIntervalSeconds, startTimer);
</script>

<style scoped>
.t { width: 100%; border-collapse: collapse; background: var(--panel); margin-bottom: 24px; }
.t th, .t td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #1e293b; }
.t th { background: #0b1220; color: var(--muted); font-size: 12px; }
.tabs { display: flex; gap: 8px; margin: 12px 0; }
.tabs button { padding: 6px 14px; border: 1px solid #1e293b; background: var(--panel); color: var(--text); border-radius: 3px; cursor: pointer; }
.tabs button.active { background: var(--accent); color: #0b1220; }
.dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }
.dot.green  { background: #10b981; }
.dot.yellow { background: #f59e0b; }
.dot.red    { background: #ef4444; }
.dot.never  { background: #6b7280; }
.empty { text-align: center; color: var(--muted); padding: 24px; }
.header { display: flex; justify-content: space-between; align-items: center; }
.refresh-toggle { color: var(--muted); font-size: 13px; }
.refresh-toggle select { background: #0b1220; color: var(--text); border: 1px solid #1e293b; padding: 4px 8px; }
.drawer-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; justify-content: flex-end; z-index: 100; }
.drawer { background: var(--panel); padding: 20px; width: 600px; max-width: 100%; height: 100vh; overflow: auto; }
.drawer pre { background: #0b1220; padding: 12px; border-radius: 3px; font-size: 11px; max-height: 70vh; overflow: auto; }
</style>
```

- [ ] **Step 9: Register route in `frontend/src/router.js`**

Add inside the `/admin/` route children (find where existing admin routes are listed):

```js
{ path: 'heartbeat-report', component: () => import('../views/admin/HeartbeatReportMonitorView.vue') }
```

- [ ] **Step 10: Add nav link in `frontend/src/components/AdminLayout.vue`**

In the `groups` array, find the `监控运维` group and add:

```js
{ label: '心跳与报告', path: '/admin/heartbeat-report' }
```

Place AFTER `端口健康检查` (so it appears second in that group).

- [ ] **Step 11: Run tests to verify they pass**

Run: `cd frontend && npx vitest run tests/heartbeat-report-monitor-view.test.js`
Expected: 5 pass.

- [ ] **Step 12: Run full frontend test suite**

Run: `cd frontend && npx vitest run`
Expected: 199 + 5 = 204 pass.

- [ ] **Step 13: Commit**

```bash
git add frontend/src/views/admin/HeartbeatReportMonitorView.vue frontend/src/api/heartbeatReport.js frontend/src/router.js frontend/src/components/AdminLayout.vue frontend/tests/heartbeat-report-monitor-view.test.js
git commit -m "feat(admin): heartbeat-report monitor view with auto-refresh + detail drawer"
```

---

### Task 8: Mirror to publish/, rebuild dist, regenerate publish.zip, push

**Files:**
- Mirror every Task 1-7 source file (NOT tests) to `publish/center/` and `publish/frontend/`
- Rebuild `frontend/dist` and copy to both `center/dist` and `publish/center/dist`
- Regenerate `publish.zip`
- Push to origin

- [ ] **Step 1: Run the mirror script**

(Look in the project for a mirror script — possibly `scripts/mirror-to-publish.sh` or similar. If it doesn't exist, do it manually:)

```bash
# Backend source files
cp center/src/services/config.js             publish/center/src/services/config.js
cp center/src/multi-port.js                   publish/center/src/multi-port.js
cp center/src/routes/agent.js                 publish/center/src/routes/agent.js
cp center/server.js                           publish/center/server.js
cp center/src/routes/heartbeat-report.js      publish/center/src/routes/heartbeat-report.js
cp center/src/services/heartbeat-report.js    publish/center/src/services/heartbeat-report.js
cp center/src/db/sql.js                       publish/center/src/db/sql.js
cp center/appsettings.example.json            publish/center/appsettings.example.json

# Agent source files
cp agent/src/reporter.js                      publish/agent/src/reporter.js
cp agent/agent.js                             publish/agent/agent.js

# Frontend source files
cp frontend/src/views/admin/HeartbeatReportMonitorView.vue   publish/frontend/src/views/admin/HeartbeatReportMonitorView.vue
cp frontend/src/api/heartbeatReport.js                       publish/frontend/src/api/heartbeatReport.js
cp frontend/src/router.js                                    publish/frontend/src/router.js
cp frontend/src/components/AdminLayout.vue                   publish/frontend/src/components/AdminLayout.vue

# Verify byte-identical
diff -r center/src publish/center/src --brief | grep -v test || echo "backend mirror OK"
diff agent/src publish/agent/src --brief || echo "agent mirror OK"
diff frontend/src publish/frontend/src --brief || echo "frontend mirror OK"
```

- [ ] **Step 2: Rebuild frontend dist**

```bash
cd frontend && npm run build
```

Expected: build succeeds, `frontend/dist/` populated.

- [ ] **Step 3: Copy dist to both center/dist and publish/center/dist**

```bash
# Use the npm start bootstrap pattern (center/dist is gitignored, runtime-only)
rm -rf center/dist publish/center/dist
mkdir -p center/dist publish/center/dist
cp -r frontend/dist/* center/dist/
cp -r frontend/dist/* publish/center/dist/
```

- [ ] **Step 4: Regenerate `publish.zip`**

(Look for the existing zip script — likely `scripts/publish-zip.ps1` or `make-publish-zip.sh`. Run it. If it doesn't exist, create from `publish/` contents:)

```bash
# PowerShell 5.1 compatible
cd publish && powershell -Command "Compress-Archive -Path * -DestinationPath ../publish.zip -Force"
```

- [ ] **Step 5: Verify package sizes**

```bash
ls -lh publish.zip
# Should be ~1.3MB if similar to before
```

- [ ] **Step 6: Smoke test the running app**

1. Restart the running center (kill any `node server.js` then `npm start`).
2. Open browser → admin → 心跳与报告 page.
3. Verify: tab switch works, heartbeat dots colored correctly, drawer opens on row click.
4. Edit ConfigView → set `heartbeat_port` to a different value (e.g., 8881) → save.
5. Verify: agent's next heartbeat lands on 8881 (check server log: `8881 server listening` + agent's POST hits that port).
6. Restore `heartbeat_port` to 8081.

- [ ] **Step 7: Push to origin**

```bash
git add -A
git status  # confirm only intended files
git commit -m "chore(publish): mirror heartbeat-report multi-port + admin monitor"
git push origin main
```

---

**Order:** Task dependencies flow correctly:
- Task 1 (config keys) — independent, foundation
- Task 2 (multi-port.js) — independent, foundation
- Task 3 (mount parameter) — independent of 1+2, refactor
- Task 4 (server.js restructure) — depends on Tasks 1, 2, 3
- Task 5 (agent reporter) — depends on Task 1 (new fields in /api/agent/config)
- Task 6 (admin endpoints) — depends on Task 1 (config keys) + Task 4 (server.js structure)
- Task 7 (admin view) — depends on Task 6 (endpoints)
- Task 8 (mirror/publish) — depends on Tasks 1-7

**End state:** backend `471 + 3 + 4 + 3 + 1 + 4 = 486` tests pass, frontend `199 + 5 = 204` tests pass. All source files mirrored to `publish/`. `publish.zip` regenerated. Pushed to origin.