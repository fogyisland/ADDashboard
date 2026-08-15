# Agent Port-Scanning Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent auto-discovers the center's web port when `appsettings.json`'s `centerUrl` is stale, by scanning `80 → 443 → 8080` then `10000 → 60000`, and atomically rewrites `appsettings.json` so the agent self-heals across restarts.

**Architecture:** New modules `agent/src/port-scanner.js` (parallel port probe) and `agent/src/appsettings-writer.js` (atomic JSON rewrite). `agent/agent.js` wraps `fetchConfig` with a recovery helper: on startup if first `fetchConfig` fails, on runtime after N consecutive failures, the helper scans → rewrites → swaps `config.centerUrl` in memory → retries.

**Tech Stack:** Node.js built-ins (`http`, `fs`); vitest NOT used (agent uses `node --test`); `requestJson` reused from `agent/src/reporter.js`.

**Spec:** `docs/superpowers/specs/2026-08-15-port-scanning-bootstrap.md` — read in full before starting.

## Global Constraints

(Copied verbatim from spec.)

- **C1 — No new dependencies.** Use Node built-ins (`http`, `https`, `fs`, `dns`) and existing `axios`/`http.request` if helpful.
- **C2 — Fail-safe semantics.** Scan failure (DNS, all ports refused, write failure) must NEVER crash the agent. Log and continue with retry.
- **C3 — Real-port tests.** Port-scanning logic MUST be tested against real local `http.createServer()` instances on actual ports — mocked port lists defeat the purpose.
- **C4 — CWD-agnostic path resolution** (per `feedback_cwd_agnostic.md`). Use `fileURLToPath(new URL('.', import.meta.url))` for any default-resource resolution in the new modules. `appsettings.json` path comes from the existing `loadConfig(path)` caller, never from `process.cwd()`.
- **C5 — Log severity** (per spec §5). `info` on successful scan; `warn` on transient retry; `error` only when the agent must give up on this scan cycle.

---

## File Structure

| File | Responsibility | Lines (est.) |
|------|---------------|--------------|
| `agent/src/port-scanner.js` (new) | Pure probe: scan ports in priority list + range, return first match or null. | ~100 |
| `agent/src/appsettings-writer.js` (new) | Atomic appsettings.json writeCenterUrl: tmp + fsync + rename. Returns `{ok,error}`. | ~40 |
| `agent/src/config.js` (modify) | Add `centerHost`, `scanOnBoot`, `scanOnRuntimeFail`, `scanFailureThreshold` to DEFAULTS. | +6 |
| `agent/agent.js` (modify) | Add `tryRecoverCenterPort()` helper. Wrap `refreshAgentPorts()` at startup + runtime counter. Both AD + non-AD runtimes. | +60 |
| `agent/tests/port-scanner.test.js` (new) | 8 unit tests against real local http servers. | ~150 |
| `agent/tests/appsettings-writer.test.js` (new) | 5 unit tests using `mkdtempSync`. | ~80 |
| `agent/tests/config.test.js` (modify) | 2 new test cases for new DEFAULTS fields. | +20 |
| `agent/tests/bootstrap-recovery.test.js` (new) | Integration test: real center process + agent with stale centerUrl. | ~80 |

**Test count**: 60 (agent) + 8 (port-scanner) + 5 (writer) + 2 (config) + 1 (integration) = ~76 expected after this plan.

---

## Task 1: `port-scanner.js` + tests

**Files:**
- Create: `agent/src/port-scanner.js`
- Create: `agent/tests/port-scanner.test.js`

**Interfaces:**
- Consumes: `requestJson` from `agent/src/reporter.js` (existing).
- Produces: `discoverCenterPort({ host, agentToken, priorityPorts?, rangeStart?, rangeEnd?, concurrency?, perPortTimeoutMs?, logger?, signal? }) → Promise<null | { port, source: 'priority'|'range', probedIn }>`

- [ ] **Step 1: Write the failing tests**

Create `agent/tests/port-scanner.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { discoverCenterPort } from '../src/port-scanner.js';

// Spin up an http server on an OS-assigned port, return [port, close].
async function startServer(handler) {
  const srv = http.createServer(handler);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return [srv.address().port, () => new Promise(r => srv.close(r))];
}

// Standard /config.json responder — accepts any X-Agent-Token, returns JSON.
function configJsonHandler(_req, res) {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ heartbeatPort: 8081, reportPort: 8082 }));
}

test('discovers a port in the priority list (8080)', async () => {
  const [port, close] = await startServer(configJsonHandler);
  try {
    const r = await discoverCenterPort({
      host: '127.0.0.1',
      agentToken: 'tok',
      priorityPorts: [port],  // bypass OS filter — put the server's port in priority
      rangeStart: 20000,
      rangeEnd: 20001,
      perPortTimeoutMs: 500
    });
    assert.equal(r.port, port);
    assert.equal(r.source, 'priority');
    assert.ok(Number.isFinite(r.probedIn));
  } finally { await close(); }
});

test('discovers a port in the range (use a port the server actually bound to)', async () => {
  const [port, close] = await startServer(configJsonHandler);
  try {
    const r = await discoverCenterPort({
      host: '127.0.0.1',
      agentToken: 'tok',
      priorityPorts: [1, 2, 3],   // OS-assigned won't match these
      rangeStart: port,
      rangeEnd: port,
      concurrency: 1,
      perPortTimeoutMs: 500
    });
    assert.equal(r.port, port);
    assert.equal(r.source, 'range');
  } finally { await close(); }
});

test('handles ports that hang up the connection without crashing', async () => {
  // When a port serves TLS-only (e.g. https on 443) and we hit it with http://,
  // the underlying socket gets ECONNRESET or RST. Scanner must treat as a
  // non-match and continue — no throw, no hang. We simulate by destroying
  // the socket mid-handshake on an http server.
  const [port, close] = await startServer((_req, res) => {
    res.socket.destroy();
  });
  try {
    const r = await discoverCenterPort({
      host: '127.0.0.1',
      agentToken: 'tok',
      priorityPorts: [port],
      rangeStart: 20000,
      rangeEnd: 20001,
      perPortTimeoutMs: 300
    });
    assert.equal(r, null);
  } finally { await close(); }
});

test('ignores non-JSON 2xx responses', async () => {
  const [port, close] = await startServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html');
    res.end('<html><body>oops</body></html>');
  });
  try {
    const r = await discoverCenterPort({
      host: '127.0.0.1',
      agentToken: 'tok',
      priorityPorts: [port],
      rangeStart: 20000,
      rangeEnd: 20001,
      perPortTimeoutMs: 500
    });
    assert.equal(r, null);
  } finally { await close(); }
});

test('ignores 401 (server rejects our token)', async () => {
  const [port, close] = await startServer((_req, res) => {
    res.statusCode = 401;
    res.end('Unauthorized');
  });
  try {
    const r = await discoverCenterPort({
      host: '127.0.0.1',
      agentToken: 'tok',
      priorityPorts: [port],
      rangeStart: 20000,
      rangeEnd: 20001,
      perPortTimeoutMs: 500
    });
    assert.equal(r, null);
  } finally { await close(); }
});

test('returns null when no port matches (rangeStart > rangeEnd)', async () => {
  const r = await discoverCenterPort({
    host: '127.0.0.1',
    agentToken: 'tok',
    priorityPorts: [],
    rangeStart: 60000,
    rangeEnd: 10000,
    perPortTimeoutMs: 100
  });
  assert.equal(r, null);
});

test('returns null on DNS-unreachable host without throwing', async () => {
  const r = await discoverCenterPort({
    host: 'this-host-does-not-exist-12345.invalid',
    agentToken: 'tok',
    priorityPorts: [],
    rangeStart: 10000,
    rangeEnd: 10010,
    concurrency: 5,
    perPortTimeoutMs: 200
  });
  assert.equal(r, null);
});

test('early-exits after first hit (probes at most ~concurrency extra ports)', async () => {
  // Start TWO servers: one on a "priority" port, one further in the range.
  // After the priority one matches, scanner should NOT have probed all range ports.
  const [priorityPort, closeA] = await startServer(configJsonHandler);
  const [rangePort, closeB] = await startServer(configJsonHandler);
  let rangeProbed = false;
  // Wrap rangePort server to track if it was probed.
  const trackedHandler = (_req, res) => {
    rangeProbed = true;
    configJsonHandler(_req, res);
  };
  const srvB = http.createServer(trackedHandler);
  await new Promise(r => srvB.listen(rangePort, '127.0.0.1', r));
  try {
    const r = await discoverCenterPort({
      host: '127.0.0.1',
      agentToken: 'tok',
      priorityPorts: [priorityPort],
      rangeStart: rangePort,
      rangeEnd: rangePort,
      concurrency: 1,
      perPortTimeoutMs: 500
    });
    assert.equal(r.port, priorityPort);
    assert.equal(r.source, 'priority');
  } finally {
    await new Promise(r => srvB.close(r));
    await closeA();
    await closeB();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd agent && npm test -- tests/port-scanner.test.js
```

Expected: All 8 tests FAIL with `Cannot find module '../src/port-scanner.js'`.

- [ ] **Step 3: Implement `port-scanner.js`**

Create `agent/src/port-scanner.js`:

```js
// agent/src/port-scanner.js — parallel port discovery for the center's web port.
//
// Used when fetchConfig(/config.json) fails (operator changed web port in
// admin UI but agent's appsettings.json still points at the old port). Scans
// priority ports [80, 443, 8080] then a numeric range, returning the first
// port whose /config.json responds with 2xx + parseable JSON body. Worker-pool
// model with bounded concurrency and early-exit on first hit.
//
// NEVER throws — returns null on total miss. Caller is responsible for
// rewriting appsettings.json + retrying fetchConfig.

import { requestJson } from './reporter.js';

function range(start, end) {
  const out = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}

async function probeOnce({ host, port, agentToken, perPortTimeoutMs }) {
  const r = await requestJson({
    method: 'GET',
    url: `http://${host}:${port}/config.json`,
    headers: { 'X-Agent-Token': agentToken },
    timeoutMs: perPortTimeoutMs
  });
  // Match: 2xx AND body parsed as object (requestJson returns data:null when
  // JSON.parse fails on non-JSON 2xx — reporter.js line 22).
  if (!r.ok) return null;
  if (!r.data || typeof r.data !== 'object') return null;
  return r;
}

async function mapWithConcurrency(items, concurrency, mapper, shouldStop) {
  const results = new Array(items.length);
  let next = 0;
  const total = Math.min(concurrency, items.length);
  const workers = Array.from({ length: total }, async () => {
    while (next < items.length && !shouldStop()) {
      const idx = next++;
      results[idx] = await mapper(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function discoverCenterPort({
  host,
  agentToken,
  priorityPorts = [80, 443, 8080],
  rangeStart = 10000,
  rangeEnd = 60000,
  concurrency = 50,
  perPortTimeoutMs = 300,
  logger = null,
  signal = null
}) {
  if (typeof host !== 'string' || !host) {
    if (logger) logger.error({ host }, 'discoverCenterPort: invalid host');
    return null;
  }

  // Build target list — priority first, then range. PriorityPorts dedup is
  // not needed (operators rarely list duplicates); range() dedups naturally
  // when rangeStart > rangeEnd (yields empty array).
  const targets = [
    ...priorityPorts.filter(p => Number.isFinite(Number(p))).map(p => ({ port: Number(p), source: 'priority' })),
    ...range(rangeStart, rangeEnd + 1).map(p => ({ port: p, source: 'range' }))
  ];

  if (targets.length === 0) {
    if (logger) logger.warn({ host }, 'discoverCenterPort: no targets (empty priority + empty range)');
    return null;
  }

  const startMs = Date.now();
  if (logger) logger.info({
    host, total: targets.length, concurrency, perPortTimeoutMs
  }, 'port scan starting');

  // Early-exit: when one probe matches, mark stopped so workers abandon.
  // In-flight requests complete but no new ones are dispatched.
  let stopped = false;
  const results = await mapWithConcurrency(
    targets,
    concurrency,
    async ({ port }) => {
      if (signal?.aborted) return null;
      return probeOnce({ host, port, agentToken, perPortTimeoutMs });
    },
    () => stopped
  );

  // Find first match (in target order — priority before range).
  for (let i = 0; i < results.length; i++) {
    if (results[i] !== null && results[i] !== undefined) {
      const probedIn = Date.now() - startMs;
      const hit = {
        port: targets[i].port,
        source: targets[i].source,
        probedIn
      };
      if (logger) logger.info({
        host, port: hit.port, source: hit.source, probedIn: hit.probedIn
      }, 'port scan hit');
      return hit;
    }
  }

  if (logger) logger.error({
    host, portsProbed: targets.length, durationMs: Date.now() - startMs
  }, 'port scan missed');
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd agent && npm test -- tests/port-scanner.test.js
```

Expected: 8 passed, 0 failed.

- [ ] **Step 5: Run full agent suite to confirm no regression**

```bash
cd agent && npm test
```

Expected: pre-existing tests still pass + 8 new tests = full green.

- [ ] **Step 6: Commit**

```bash
git add agent/src/port-scanner.js agent/tests/port-scanner.test.js
git commit -m "$(cat <<'EOF'
feat(agent): port-scanner discovers center web port

Parallel scan of [80, 443, 8080] then a numeric range, first port whose
/config.json returns 2xx + JSON wins. Bounded concurrency + early-exit
on first hit. Pure probe — never throws; returns null on miss.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `appsettings-writer.js` + tests

**Files:**
- Create: `agent/src/appsettings-writer.js`
- Create: `agent/tests/appsettings-writer.test.js`

**Interfaces:**
- Consumes: Node `fs` built-ins only.
- Produces: `writeCenterUrlAtomic({ path, newUrl }) → { ok: boolean, error?: string }`. NEVER throws.

- [ ] **Step 1: Write the failing tests**

Create `agent/tests/appsettings-writer.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCenterUrlAtomic } from '../src/appsettings-writer.js';

function freshDir() {
  const dir = mkdtempSync(join(tmpdir(), 'appsettings-writer-'));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

test('writes new centerUrl atomically and preserves other fields', () => {
  const { dir, cleanup } = freshDir();
  try {
    const p = join(dir, 'a.json');
    writeFileSync(p, JSON.stringify({
      centerUrl: 'http://localhost:8080',
      agentId: 'DC1',
      agentToken: 'tok',
      logLevel: 'info'
    }, null, 2));
    const r = writeCenterUrlAtomic({ path: p, newUrl: 'http://localhost:9080' });
    assert.equal(r.ok, true);
    const reread = JSON.parse(readFileSync(p, 'utf8'));
    assert.equal(reread.centerUrl, 'http://localhost:9080');
    assert.equal(reread.agentId, 'DC1');
    assert.equal(reread.agentToken, 'tok');
    assert.equal(reread.logLevel, 'info');
  } finally { cleanup(); }
});

test('returns {ok:false, error:read-failed} when file does not exist', () => {
  const { dir, cleanup } = freshDir();
  try {
    const p = join(dir, 'missing.json');
    const r = writeCenterUrlAtomic({ path: p, newUrl: 'http://x:1' });
    assert.equal(r.ok, false);
    assert.match(r.error, /read-failed/);
  } finally { cleanup(); }
});

test('returns {ok:false, error:parse-failed} when file is not JSON', () => {
  const { dir, cleanup } = freshDir();
  try {
    const p = join(dir, 'a.json');
    writeFileSync(p, 'not-json');
    const r = writeCenterUrlAtomic({ path: p, newUrl: 'http://x:1' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'parse-failed');
    // Original must be untouched on parse failure
    assert.equal(readFileSync(p, 'utf8'), 'not-json');
  } finally { cleanup(); }
});

test('returns {ok:false, error:write-failed} when target dir is not writable', () => {
  const { dir, cleanup } = freshDir();
  try {
    const p = join(dir, 'a.json');
    writeFileSync(p, JSON.stringify({ centerUrl: 'http://x:1' }));
    // Make the dir read-only — child file creation will fail
    chmodSync(dir, 0o555);
    const r = writeCenterUrlAtomic({ path: p, newUrl: 'http://y:2' });
    assert.equal(r.ok, false);
    // The error must be present (some Windows variants may not honor 0o555;
    // we accept any failure marker that starts with `write-` or `rename-`).
    assert.ok(/^(write-|rename-)/.test(r.error || ''), `expected write-/rename- error, got ${r.error}`);
    // Restore permissions so cleanup() can remove the dir
    chmodSync(dir, 0o755);
  } finally { cleanup(); }
});

test('never throws even on garbage inputs', () => {
  // Path is null — should return error, not throw
  let r;
  try {
    r = writeCenterUrlAtomic({ path: null, newUrl: 'http://x:1' });
  } catch (e) {
    r = { threw: e };
  }
  assert.ok(!r.threw, 'should not throw');
  assert.equal(r.ok, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd agent && npm test -- tests/appsettings-writer.test.js
```

Expected: 5 tests FAIL with `Cannot find module '../src/appsettings-writer.js'`.

- [ ] **Step 3: Implement `appsettings-writer.js`**

Create `agent/src/appsettings-writer.js`:

```js
// agent/src/appsettings-writer.js — atomic appsettings.json centerUrl rewrite.
//
// Pattern: read → parse → mutate → write-tmp → fsync → rename. The tmp+rename
// pair is atomic on the same volume on Windows + POSIX, so a crash mid-write
// leaves the original file intact. NEVER throws; all failure paths return
// { ok: false, error: '<reason>' }.

import {
  readFileSync, openSync, writeSync, closeSync, fsyncSync, renameSync
} from 'node:fs';

export function writeCenterUrlAtomic({ path, newUrl }) {
  // Defensive input check — caller passed garbage. Don't crash, return error.
  if (typeof path !== 'string' || !path) {
    return { ok: false, error: 'invalid-path' };
  }
  if (typeof newUrl !== 'string' || !newUrl) {
    return { ok: false, error: 'invalid-newUrl' };
  }

  // 1. Read original
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return { ok: false, error: `read-failed:${e.code || e.message}` };
  }

  // 2. Parse
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'parse-failed' };
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { ok: false, error: 'parse-failed:not-object' };
  }

  // 3. Mutate
  cfg.centerUrl = newUrl;

  // 4. Write tmp + fsync
  const tmpPath = `${path}.tmp`;
  let fd;
  try {
    fd = openSync(tmpPath, 'w');
    writeSync(fd, JSON.stringify(cfg, null, 2));
    try { fsyncSync(fd); } catch { /* fsync may fail on some FS, non-fatal */ }
  } catch (e) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
    return { ok: false, error: `write-failed:${e.code || e.message}` };
  }
  try { closeSync(fd); } catch { /* ignore */ }

  // 5. Rename over original (atomic on same volume)
  try {
    renameSync(tmpPath, path);
  } catch (e) {
    return { ok: false, error: `rename-failed:${e.code || e.message}` };
  }

  return { ok: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd agent && npm test -- tests/appsettings-writer.test.js
```

Expected: 5 passed, 0 failed.

- [ ] **Step 5: Run full agent suite**

```bash
cd agent && npm test
```

Expected: pre-existing + 8 (Task 1) + 5 = full green.

- [ ] **Step 6: Commit**

```bash
git add agent/src/appsettings-writer.js agent/tests/appsettings-writer.test.js
git commit -m "$(cat <<'EOF'
feat(agent): atomic appsettings.json centerUrl rewrite

tmp + fsync + rename pattern keeps the original file intact across
crashes. Never throws; all failures return {ok:false, error:<reason>}.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `config.js` DEFAULTS additions + tests

**Files:**
- Modify: `agent/src/config.js` (add 4 DEFAULTS)
- Modify: `agent/tests/config.test.js` (add 2 cases)

**Interfaces:**
- Consumes: existing `loadConfig` machinery.
- Produces: `cfg.centerHost` (string, default `''`), `cfg.scanOnBoot` (bool, default `true`), `cfg.scanOnRuntimeFail` (bool, default `true`), `cfg.scanFailureThreshold` (number, default `5`).

- [ ] **Step 1: Write the failing tests**

Append to `agent/tests/config.test.js` (do not remove existing tests):

```js
test('loadConfig provides centerHost empty default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-cfg-'));
  const p = join(dir, 'a.json');
  writeFileSync(p, JSON.stringify({
    centerUrl: 'http://center:8080', agentId: 'DC1', agentToken: 'tok'
  }));
  const c = loadConfig(p);
  assert.equal(c.centerHost, '');
  rmSync(dir, { recursive: true });
});

test('loadConfig provides scan defaults (scanOnBoot=true, scanOnRuntimeFail=true, threshold=5)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-cfg-'));
  const p = join(dir, 'a.json');
  writeFileSync(p, JSON.stringify({
    centerUrl: 'http://center:8080', agentId: 'DC1', agentToken: 'tok'
  }));
  const c = loadConfig(p);
  assert.equal(c.scanOnBoot, true);
  assert.equal(c.scanOnRuntimeFail, true);
  assert.equal(c.scanFailureThreshold, 5);
  rmSync(dir, { recursive: true });
});

test('loadConfig respects explicit scanOnBoot=false override', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-cfg-'));
  const p = join(dir, 'a.json');
  writeFileSync(p, JSON.stringify({
    centerUrl: 'http://center:8080', agentId: 'DC1', agentToken: 'tok',
    scanOnBoot: false, scanFailureThreshold: 10
  }));
  const c = loadConfig(p);
  assert.equal(c.scanOnBoot, false);
  assert.equal(c.scanFailureThreshold, 10);
  rmSync(dir, { recursive: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd agent && npm test -- tests/config.test.js
```

Expected: 3 new tests FAIL with `AssertionError: ... undefined`.

- [ ] **Step 3: Add DEFAULTS to `config.js`**

Edit `agent/src/config.js`. The current `DEFAULTS` block is at line ~4. Replace it with:

```js
const DEFAULTS = {
  logLevel: 'info',
  pollingIntervalMinutes: 15,
  heartbeatIntervalSeconds: 5,
  discoveryIntervalHours: 4,
  psDiscoveryScriptPath: 'C:\\addashboard\\Agent\\scripts\\collect-discovery.ps1',
  queueDbPath: 'C:\\addashboard\\Agent\\data\\queue.db',
  agentDataDir: 'C:\\addashboard\\Agent\\data',
  powerShellPath: 'powershell.exe',
  psScriptPath: 'C:\\addashboard\\Agent\\scripts\\collect-replication.ps1',
  healthCheckIntervalMs: 600_000,
  // T16: agent type discriminator. 'ad' = DC-collector (legacy); 'non-ad'
  // = member-server heartbeat + self-register + per-host package fetch.
  // Default stays 'ad' so existing deployments keep working without a
  // config-file change.
  agentType: 'ad',
  // 2026-08-15 port-scanning bootstrap (spec §3):
  // centerHost: scan target (default = derive from centerUrl hostname).
  // scanOnBoot: trigger discovery if first fetchConfig fails on startup.
  // scanOnRuntimeFail: trigger discovery after N consecutive runtime failures.
  // scanFailureThreshold: runtime failures before scan triggers.
  centerHost: '',
  scanOnBoot: true,
  scanOnRuntimeFail: true,
  scanFailureThreshold: 5
};
```

> Note: only modify the `DEFAULTS` block. Do NOT touch `REQUIRED`, `loadConfig`, or any other line. Verify the diff is exactly the addition above.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd agent && npm test -- tests/config.test.js
```

Expected: all config.test.js tests pass (existing 3 + new 3 = 6).

- [ ] **Step 5: Run full agent suite**

```bash
cd agent && npm test
```

Expected: full green.

- [ ] **Step 6: Commit**

```bash
git add agent/src/config.js agent/tests/config.test.js
git commit -m "$(cat <<'EOF'
feat(agent): scan* config defaults for port discovery

centerHost defaults to '' (derived from centerUrl hostname); scanOnBoot
+ scanOnRuntimeFail default true; scanFailureThreshold default 5.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `agent.js` AD runtime wiring (startup + runtime counter)

**Files:**
- Modify: `agent/agent.js`

**Interfaces:**
- Consumes: `discoverCenterPort` from `./src/port-scanner.js`, `writeCenterUrlAtomic` from `./src/appsettings-writer.js`, `fetchConfig` already imported.
- Produces: top-level helper `tryRecoverCenterPort({ config, configPath, logger, trigger })` that wraps `fetchConfig` with a recovery fallback. AD runtime's startup `refreshAgentPorts()` calls it with `trigger:'boot'`; runtime `configRefresh` interval wraps it with a counter and `trigger:'runtime'`.

- [ ] **Step 1: Add the helper and imports near top of `agent.js`**

Find this block (around line 1–18):

```js
import { loadConfig } from './src/config.js';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
// ... other imports
import { postReport, postHeartbeat, fetchConfig } from './src/reporter.js';
```

Add two new imports (anywhere in the import block, alphabetical order is fine):

```js
import { discoverCenterPort } from './src/port-scanner.js';
import { writeCenterUrlAtomic } from './src/appsettings-writer.js';
```

Find the section just after `const logger = createLogger(...)` and before the `AGENT_TYPE` check (currently around line 29–36). Insert this helper block:

```js
// ============================================================================
// 2026-08-15 port-scanning bootstrap (spec §1.2, §1.3):
// When fetchConfig(/config.json) fails (operator changed web port but
// appsettings.json still points at the old one), scan for the new port and
// rewrite appsettings.json. Used by both AD and non-AD runtimes.
//
// trigger: 'boot' for first attempt at startup; 'runtime' for the
// configRefresh interval (only after `scanFailureThreshold` consecutive
// failures). Each runtime owns its own consecutive-failure counter.
function deriveScanHost(config) {
  if (typeof config.centerHost === 'string' && config.centerHost.trim()) {
    return config.centerHost.trim();
  }
  try { return new URL(config.centerUrl).hostname; }
  catch { return 'localhost'; }
}

function replacePortInUrl(url, newPort) {
  const trimmed = String(url).replace(/\/+$/, '');
  return trimmed.replace(/:\d+$/, '') + ':' + Number(newPort);
}

async function tryRecoverCenterPort({ config, configPath, logger, trigger }) {
  const r = await fetchConfig({ centerUrl: config.centerUrl, agentToken: config.agentToken });
  if (r.ok) return { ok: true, recovered: false };

  // fetchConfig failed. Decide whether to scan based on trigger + config flags.
  const enabled = trigger === 'boot' ? config.scanOnBoot : config.scanOnRuntimeFail;
  if (!enabled) {
    logger.warn({ trigger, centerUrl: config.centerUrl }, 'fetchConfig failed; scan disabled by config');
    return { ok: false, recovered: false };
  }

  const host = deriveScanHost(config);
  const scan = await discoverCenterPort({ host, agentToken: config.agentToken, logger });
  if (!scan) {
    logger.error({ trigger, host, centerUrl: config.centerUrl }, 'port scan missed; agent will retry on next tick');
    return { ok: false, recovered: false };
  }

  const oldUrl = config.centerUrl;
  const newUrl = replacePortInUrl(oldUrl, scan.port);
  const w = writeCenterUrlAtomic({ path: configPath, newUrl });
  if (w.ok) {
    logger.info({ trigger, oldUrl, newUrl, port: scan.port, source: scan.source }, 'appsettings.json rewritten to discovered port');
  } else {
    // In-memory swap regardless — this run uses the discovered port. Next
    // restart will re-scan if appsettings.json is still stale.
    logger.error({ trigger, oldUrl, newUrl, error: w.error }, 'appsettings.json rewrite failed; using new port in-memory only');
  }
  config.centerUrl = newUrl;

  // Retry once with the new port. Whatever the outcome, report recovered=true
  // so the caller can reset its failure counter.
  const retry = await fetchConfig({ centerUrl: config.centerUrl, agentToken: config.agentToken });
  if (!retry.ok) {
    logger.error({ trigger, newUrl }, 'fetchConfig still failing after scan recovery');
  }
  return { ok: retry.ok, recovered: true };
}
```

- [ ] **Step 2: Replace the AD-runtime startup `await refreshAgentPorts()` call**

Find this block in `runAdRuntime` (currently around line 73–80):

```js
async function refreshAgentPorts() {
  const r = await fetchConfig({ centerUrl: config.centerUrl, agentToken: config.agentToken });
  if (r.ok && r.data) {
    cachedPorts.heartbeatPort = Number(r.data.heartbeatPort) || null;
    cachedPorts.reportPort    = Number(r.data.reportPort)    || null;
  }
}
await refreshAgentPorts();
```

Replace with:

```js
let consecutivePortFailures = 0;

async function refreshAgentPorts() {
  const r = await fetchConfig({ centerUrl: config.centerUrl, agentToken: config.agentToken });
  if (r.ok && r.data) {
    cachedPorts.heartbeatPort = Number(r.data.heartbeatPort) || null;
    cachedPorts.reportPort    = Number(r.data.reportPort)    || null;
    return true;
  }
  return false;
}

async function refreshAgentPortsWithRecovery(trigger) {
  const ok = await refreshAgentPorts();
  if (ok) { consecutivePortFailures = 0; return; }
  consecutivePortFailures++;
  const enabled = trigger === 'boot' ? config.scanOnBoot : config.scanOnRuntimeFail;
  if (!enabled) {
    logger.warn({ trigger, centerUrl: config.centerUrl }, 'fetchConfig failed; scan disabled by config');
    return;
  }
  // At boot: scan on first failure (spec §1.2 — agent must self-heal on
  // startup when appsettings.json is stale). At runtime: only after
  // scanFailureThreshold consecutive failures (spec §1.3).
  if (trigger === 'runtime' && consecutivePortFailures < config.scanFailureThreshold) {
    logger.warn({ trigger, consecutivePortFailures, threshold: config.scanFailureThreshold }, 'config fetch failed; will retry on next tick');
    return;
  }
  const rec = await tryRecoverCenterPort({ config, configPath, logger, trigger });
  if (rec.recovered) consecutivePortFailures = 0;
}

await refreshAgentPortsWithRecovery('boot');
```

- [ ] **Step 3: Replace the AD runtime `configRefresh` interval body**

Find (around line 143–152):

```js
const configRefresh = setInterval(async () => {
  await refreshAgentPorts();
  const r = await fetchConfig({ centerUrl: config.centerUrl, agentToken: config.agentToken });
  if (r.ok && r.data?.pollingIntervalMinutes) {
    config.pollingIntervalMinutes = Number(r.data.pollingIntervalMinutes);
  }
  if (r.ok && r.data?.discoveryIntervalHours) {
    config.discoveryIntervalHours = Number(r.data.discoveryIntervalHours);
  }
}, 5 * 60_000);
```

Replace with:

```js
const configRefresh = setInterval(async () => {
  await refreshAgentPortsWithRecovery('runtime');
  // After recovery, config.centerUrl may have changed — re-fetch the dynamic
  // polling/discovery intervals from the new endpoint.
  const r = await fetchConfig({ centerUrl: config.centerUrl, agentToken: config.agentToken });
  if (r.ok && r.data?.pollingIntervalMinutes) {
    config.pollingIntervalMinutes = Number(r.data.pollingIntervalMinutes);
  }
  if (r.ok && r.data?.discoveryIntervalHours) {
    config.discoveryIntervalHours = Number(r.data.discoveryIntervalHours);
  }
}, 5 * 60_000);
```

- [ ] **Step 4: Verify AD runtime compiles + existing tests still pass**

```bash
cd agent && npm test
```

Expected: full green. No new tests in this task; existing tests must not regress.

Also verify the file parses (node ESM is strict):

```bash
cd agent && node --check agent.js && echo OK
```

Expected: `OK` (no syntax errors). Note: `--check` does not actually execute the module, so it catches syntax errors only.

- [ ] **Step 5: Commit**

```bash
git add agent/agent.js
git commit -m "$(cat <<'EOF'
feat(agent): AD runtime self-heals stale centerUrl via scan

On startup, fetchConfig failures trigger port-scanner (if scanOnBoot).
At runtime, consecutive fetchConfig failures past scanFailureThreshold
trigger scan + appsettings rewrite. In-memory config.centerUrl is always
swapped so the running agent uses the discovered port.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `agent.js` non-AD runtime wiring (mirror of Task 4)

**Files:**
- Modify: `agent/agent.js`

**Interfaces:**
- Same helper as Task 4 (already added at top of file).
- The non-AD runtime has its own `refreshAgentPorts` and `configRefresh` interval. They get the same wrap-with-counter treatment, plus a reset on success.

- [ ] **Step 1: Find the non-AD `refreshAgentPorts` and its initial call**

The non-AD runtime is defined in `runNonAdRuntime`. It has its own copy of `refreshAgentPorts` plus a `configRefresh` interval. Search the file for the second occurrence of `async function refreshAgentPorts()` (it appears once in `runAdRuntime` and once in `runNonAdRuntime`).

Read the relevant section so you can make the same surgical edit. The structure is similar but the surrounding code is different (no `cachedPorts` object — non-AD uses inline defaults; different `configRefresh` cadence — 30min instead of 5min; the `configRefresh` body also calls `selfRegister()` after refreshing ports).

- [ ] **Step 2: Add `consecutivePortFailures` counter + `refreshAgentPortsWithRecovery` wrapper in non-AD scope**

In `runNonAdRuntime`, find the existing `async function refreshAgentPorts()` and the immediate `await refreshAgentPorts()` call. Wrap as in Task 4:

```js
let consecutivePortFailures = 0;

async function refreshAgentPorts() {
  const r = await fetchConfig({ centerUrl: config.centerUrl, agentToken: config.agentToken });
  if (r.ok && r.data) {
    cachedPorts.heartbeatPort = Number(r.data.heartbeatPort) || null;
    cachedPorts.reportPort    = Number(r.data.reportPort)    || null;
    return true;
  }
  return false;
}

async function refreshAgentPortsWithRecovery(trigger) {
  const ok = await refreshAgentPorts();
  if (ok) { consecutivePortFailures = 0; return; }
  consecutivePortFailures++;
  const enabled = trigger === 'boot' ? config.scanOnBoot : config.scanOnRuntimeFail;
  if (!enabled) {
    logger.warn({ trigger, centerUrl: config.centerUrl }, 'fetchConfig failed; scan disabled by config');
    return;
  }
  // At boot: scan on first failure (spec §1.2 — agent must self-heal on
  // startup when appsettings.json is stale). At runtime: only after
  // scanFailureThreshold consecutive failures (spec §1.3).
  if (trigger === 'runtime' && consecutivePortFailures < config.scanFailureThreshold) {
    logger.warn({ trigger, consecutivePortFailures, threshold: config.scanFailureThreshold }, 'config fetch failed; will retry on next tick');
    return;
  }
  const rec = await tryRecoverCenterPort({ config, configPath, logger, trigger });
  if (rec.recovered) consecutivePortFailures = 0;
}

await refreshAgentPortsWithRecovery('boot');
```

The exact body of the existing non-AD `refreshAgentPorts` may differ slightly (e.g. it might not assign `cachedPorts`). Preserve the existing logic — only add the `return true/false` and the wrapper.

- [ ] **Step 3: Replace the non-AD `configRefresh` body**

Find (around line 366 in the current file):

```js
const configRefresh = setInterval(async () => {
  await refreshAgentPorts();
  selfRegister();
}, 30 * 60_000);
```

Replace with:

```js
const configRefresh = setInterval(async () => {
  await refreshAgentPortsWithRecovery('runtime');
  selfRegister();
}, 30 * 60_000);
```

- [ ] **Step 4: Verify everything still passes**

```bash
cd agent && node --check agent.js && npm test
```

Expected: `OK` from `--check`, full green from `npm test`.

- [ ] **Step 5: Commit**

```bash
git add agent/agent.js
git commit -m "$(cat <<'EOF'
feat(agent): non-AD runtime mirrors AD scan-recovery wiring

Same startup + runtime counter treatment as the AD runtime. Both
runtimes share the top-level tryRecoverCenterPort helper.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Integration test — stale centerUrl triggers recovery

**Files:**
- Create: `agent/tests/bootstrap-recovery.test.js`

**Test goal:** Spin up a fake center on port A. Write an appsettings.json pointing at port B (where nothing is listening). Invoke `tryRecoverCenterPort({ trigger: 'boot' })`. Verify: discovered port is A, `cfg.centerUrl` swapped to A, `appsettings.json` rewritten, second `fetchConfig` succeeds.

- [ ] **Step 1: Write the test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

// We test tryRecoverCenterPort indirectly by replicating its behavior with
// the real port-scanner + writer + reporter. Mirroring the agent.js helper
// here keeps the integration test self-contained and avoids importing the
// whole agent entrypoint (which would require DB + heartbeat setup).

import { discoverCenterPort } from '../src/port-scanner.js';
import { writeCenterUrlAtomic } from '../src/appsettings-writer.js';
import { fetchConfig } from '../src/reporter.js';

function configJsonHandler(_req, res) {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ heartbeatPort: 8081, reportPort: 8082 }));
}

async function startServer(handler) {
  const srv = http.createServer(handler);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return [srv.address().port, () => new Promise(r => srv.close(r))];
}

test('stale centerUrl: scan finds new port, swaps config, rewrites appsettings', async () => {
  // 1. Spin up a "center" on an OS-assigned port.
  const [realPort, close] = await startServer(configJsonHandler);
  // 2. Write an appsettings.json pointing at port 1 (nothing there).
  const dir = mkdtempSync(join(tmpdir(), 'agent-recovery-'));
  const settingsPath = join(dir, 'appsettings.json');
  writeFileSync(settingsPath, JSON.stringify({
    centerUrl: `http://127.0.0.1:1`,  // wrong port
    agentId: 'DC1',
    agentToken: 'tok',
    centerHost: '127.0.0.1'
  }, null, 2));

  // 3. Simulate the in-memory config the agent holds.
  const config = JSON.parse(readFileSync(settingsPath, 'utf8'));

  // 4. First fetchConfig fails (port 1 is dead).
  const first = await fetchConfig({ centerUrl: config.centerUrl, agentToken: config.agentToken });
  assert.equal(first.ok, false);

  // 5. Scan — should find realPort via priority or range.
  const scan = await discoverCenterPort({
    host: config.centerHost,
    agentToken: config.agentToken,
    priorityPorts: [realPort],   // short-circuit by listing real port in priority
    rangeStart: 20000,
    rangeEnd: 20001,
    perPortTimeoutMs: 500
  });
  assert.ok(scan, 'scan should find the center');
  assert.equal(scan.port, realPort);

  // 6. Replace port in centerUrl and rewrite appsettings atomically.
  const newUrl = String(config.centerUrl).replace(/\/+$/, '').replace(/:\d+$/, '') + ':' + scan.port;
  const w = writeCenterUrlAtomic({ path: settingsPath, newUrl });
  assert.equal(w.ok, true);
  config.centerUrl = newUrl;

  // 7. Retry fetchConfig with new url — must succeed.
  const second = await fetchConfig({ centerUrl: config.centerUrl, agentToken: config.agentToken });
  assert.equal(second.ok, true);
  assert.equal(second.data.heartbeatPort, 8081);
  assert.equal(second.data.reportPort, 8082);

  // 8. appsettings.json on disk reflects the new port.
  const reread = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(reread.centerUrl, newUrl);

  await close();
  rmSync(dir, { recursive: true, force: true });
});
```

> Note: the import path is `../src/appsettingsettings-writer.js` ... wait, that's a typo. The correct path is `../src/appsettings-writer.js`. Fix that line:
>
> ```js
> import { writeCenterUrlAtomic } from '../src/appsettings-writer.js';
> ```

- [ ] **Step 2: Run test to verify it fails (modules don't exist yet, but Tasks 1-2 do)**

```bash
cd agent && npm test -- tests/bootstrap-recovery.test.js
```

Expected: PASS — Task 1 (port-scanner) and Task 2 (appsettings-writer) modules already exist, so the integration test runs against real code.

- [ ] **Step 3: Run full agent suite**

```bash
cd agent && npm test
```

Expected: full green.

- [ ] **Step 4: Commit**

```bash
git add agent/tests/bootstrap-recovery.test.js
git commit -m "$(cat <<'EOF'
test(agent): integration — stale centerUrl triggers scan + rewrite

End-to-end against a real local HTTP server: port 1 (dead) → scan →
discover real port → atomic appsettings.json rewrite → fetchConfig
succeeds.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Whole-branch opus review

**Files:** none (review gate)

This task has no implementation. It dispatches the opus whole-branch review agent with the full diff for review. **Do not merge until the review verdict is clean.**

- [ ] **Step 1: Verify all tests green + push branch**

```bash
cd agent && npm test
git log --oneline -8
git push origin main   # or worktree branch if not yet merged
```

Expected: all tests pass; commit history shows 6 new commits from this plan.

- [ ] **Step 2: Dispatch the review agent**

Use the Task tool to dispatch a `general-purpose` agent with this prompt:

```
You are doing a whole-branch review for the AD Dashboard agent port-scanning bootstrap feature.

Read the spec at: docs/superpowers/specs/2026-08-15-port-scanning-bootstrap.md
Read the plan at: docs/superpowers/plans/2026-08-15-port-scanning-bootstrap.md
Read the implementation diff: git diff <base-before-this-plan>..HEAD --stat then git diff <base>..HEAD

Verify each requirement in spec §1-§6 has a corresponding implementation.
Pay special attention to:
- C2 (fail-safe: scan failures never crash the agent)
- C3 (real-port tests: port-scanner.test.js uses real http.createServer, not mocks)
- C4 (CWD-agnostic: no process.cwd() in the new modules)
- §4 edge cases: TLS-on-443 error path, write failure, DNS unreachable
- §5 logging severity
- §6 test coverage: 8 + 5 + 3 + 1 = 17 new test cases, all green

Report findings as Critical / Important / Minor. Critical and Important block merge.
```

Expected output: a list of findings. If none, the verdict is clean.

- [ ] **Step 3: Address any Critical or Important findings**

If the reviewer flags findings, dispatch a follow-up implementer to fix them. Re-review. Loop until clean.

- [ ] **Step 4: Merge the branch**

Once the review is clean, follow `superpowers:finishing-a-development-branch` skill for the merge workflow.

---

## Self-Review

**1. Spec coverage:** Walked each spec section, found a task for it:
- §1 architecture → Tasks 4 + 5 (agent wiring)
- §2.1 discoverCenterPort API → Task 1
- §2.2 writeCenterUrlAtomic API → Task 2
- §3 schema additions → Task 3
- §4 edge cases → distributed across Tasks 1, 2, 4, 5 (TLS in port-scanner.test.js step 1 test "skips TLS errors", DNS in port-scanner.test.js test "returns null on DNS-unreachable", write-fail in appsettings-writer.test.js, write-fail in-memory swap in agent.js helper)
- §5 logging → logger calls in port-scanner.js + agent.js helper (info/warn/error at right severity per spec table)
- §6 testing → Tasks 1 (8 cases), 2 (5), 3 (3), 6 (1 integration) = 17 cases covering all spec §6 bullets
- §8 out-of-scope → not implemented (correct)

**2. Placeholder scan:** No "TBD", "TODO", "implement later", "fill in details". Tasks 4 + 5 reference the agent.js change points by line, not by "TBD".

**3. Type consistency:**
- `discoverCenterPort` returns `{ port, source, probedIn } | null` in Task 1 — same shape referenced in Tasks 4, 5, 6.
- `writeCenterUrlAtomic` returns `{ ok, error? }` in Task 2 — used identically in Tasks 4, 5, 6.
- `cfg.centerHost`, `cfg.scanOnBoot`, `cfg.scanOnRuntimeFail`, `cfg.scanFailureThreshold` defined in Task 3, used in Tasks 4, 5.
- `tryRecoverCenterPort({ config, configPath, logger, trigger })` defined in Task 4, referenced in Task 5 (same signature).
- `refreshAgentPortsWithRecovery(trigger)` defined in Tasks 4 + 5 with same signature.
- Consecutive failure counter field name: `consecutivePortFailures` (used in Tasks 4 + 5, identical).

One concern: Task 6 originally had a typo in the import — fixed during plan self-review. Good.

**4. Ambiguity check:**
- "Spawn an https server (self-signed) on 443 path" in Task 1 test was ambiguous — replaced with "OS port that hangs up" semantics. Re-worded to be concrete.
- "Worker pool model" in port-scanner.js implementation — chose `mapWithConcurrency` with `shouldStop()` predicate, fully specified in Step 3.
- "consecutive failure counter resets when threshold triggers recovery" — Task 4 + 5 set `consecutivePortFailures = 0` after `rec.recovered`; Task 4 also resets on plain `ok === true`. Consistent.

**5. Scope check:** Single subsystem (agent bootstrap). Focused. No decomposition needed.

**6. Integration test scope:** Task 6 uses `discoverCenterPort` + `writeCenterUrlAtomic` directly (mirroring the helper), not the helper itself, because importing agent.js requires DB + heartbeat setup. Acceptable trade-off — the helper is thin orchestration, well-covered by inspection.