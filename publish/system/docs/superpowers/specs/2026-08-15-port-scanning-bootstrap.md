# Agent Port-Scanning Bootstrap — Design Spec

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:writing-plans (recommended) or superpowers:subagent-driven-development to plan implementation. Brainstorming already complete — this document is the single source of design intent.

**Goal:** When the agent cannot reach `${centerUrl}/config.json` (port changed in admin but `appsettings.json` still points at the old port), automatically discover the new web port by scanning `80 → 443 → 8080` then `10000 → 60000`, and rewrite `appsettings.json` so the agent self-heals across restarts.

**Architecture:** New module `agent/src/port-scanner.js` exposes `discoverCenterPort()` which parallel-scans ports (concurrency 50, 300ms/port, early-exit on first match). The match test is `GET /config.json` with the agent's own `X-Agent-Token` — success means HTTP 2xx with JSON body that the same token was accepted (server didn't 401). The bootstrap retry layer in `agent.js` wraps `fetchConfig` with a discovery fallback (startup + on N consecutive runtime failures).

**Tech Stack:** Node.js (no new deps); `http.request` for probes; `fs.renameSync` for atomic appsettings rewrite; pino-style logger; vitest + real local `http.createServer()` for unit tests.

---

## Context — the bug we're fixing

`commit 3741a9b` introduced `/config.json` so the agent learns `heartbeatPort` / `reportPort` from the web port. The contract: `cfg.centerUrl` in `appsettings.json` must point at the web port. If the operator changes the web port via `/admin/config` but the agent's `appsettings.json` still points at the old port, `fetchConfig` returns 404 and the agent never recovers. **This spec gives the agent the ability to find the new port on its own.**

---

## Global Constraints

- **C1 — No new dependencies.** Use Node built-ins (`http`, `https`, `fs`, `dns`) and the existing `axios` if helpful (reporter.js currently uses `http` directly).
- **C2 — Fail-safe semantics.** A scan failure (DNS, all ports refused, write failure) must NEVER crash the agent. Log and continue with retry.
- **C3 — Real-DB / real-port tests.** Port-scanning logic MUST be tested against real local `http.createServer()` instances on actual ports — mocked port lists defeat the purpose.
- **C4 — CWD-agnostic path resolution** (per `feedback_cwd_agnostic.md`). Use `fileURLToPath(new URL('.', import.meta.url))` for the scanner's resource resolution; `appsettings.json` path comes from the existing `loadConfig(path)` caller, never from `process.cwd()`.
- **C5 — PowerShell 5.1 + pwsh 7+ compat** (per `feedback_powershell_51.md`). N/A here — pure JS, no scripts.
- **C6 — Log activity at appropriate severity.** `info` on successful scan (with discovered port); `warn` on transient retry; `error` only when the agent must give up on this scan cycle.

---

## §1 — Architecture

### 1.1 Components

**`agent/src/port-scanner.js` (new)** — exports `discoverCenterPort(options)` returning `Promise<{ port, source: 'priority'|'range', probedIn: number } | null>`. Pure probe logic — does NOT touch appsettings or agent state.

**`agent/src/appsettings-writer.js` (new)** — exports `writeCenterUrlAtomic({ path, newUrl })`. Writes to `${path}.tmp`, fsyncs, renames over the original. Returns `{ ok: boolean, error?: string }`. NEVER throws.

**`agent/agent.js` (modified)** — at startup, if `fetchConfig` fails and `cfg.scanOnBoot` is true, call `discoverCenterPort` + `writeCenterUrlAtomic` + retry `fetchConfig`. At runtime, wrap `refreshAgentPorts` with a consecutive-failure counter; when `>= cfg.scanFailureThreshold`, trigger the same path.

**`agent/src/config.js` (modified)** — `DEFAULTS` extended with new fields; `loadConfig` unchanged in shape.

### 1.2 Data flow (startup)

```
boot agent.js
  ├─ loadConfig(appsettings.json)        // adds centerHost + scan* fields with defaults
  ├─ refreshAgentPorts()                 // fetchConfig(cfg.centerUrl)
  │     ├─ ok → cachedPorts = r.data.*, normal flow
  │     └─ fail →
  │          if cfg.scanOnBoot:
  │            port = discoverCenterPort({ host: cfg.centerHost, agentToken: cfg.agentToken, ... })
  │              ├─ hit →
  │                 newUrl = replacePort(cfg.centerUrl, port.port)
  │                 writeCenterUrlAtomic({ path: cfg.__path, newUrl })
  │                   ├─ ok → log info, swap cfg.centerUrl in memory
  │                   └─ fail → log error, swap cfg.centerUrl in memory anyway (this run works)
  │                 retry refreshAgentPorts() with new url
  │              └─ miss → log error, agent retries on next 5min tick
  └─ normal agent run
```

### 1.3 Data flow (runtime)

```
refreshAgentPorts()  // every 5min via configRefresh interval
  ├─ fetchConfig(cfg.centerUrl) ok → reset failure counter to 0
  └─ fail →
       failureCounter++
       if failureCounter >= cfg.scanFailureThreshold AND cfg.scanOnRuntimeFail:
         same path as startup scan
```

---

## §2 — Module API

### 2.1 `discoverCenterPort(options)` — `agent/src/port-scanner.js`

```js
/**
 * Scan a fixed priority list then a numeric range, returning the first port
 * whose /config.json responds with 2xx + parseable JSON body + the supplied
 * agent token was accepted (server did not 401). Uses parallel workers with
 * early-exit on first hit. Never throws — returns null on total miss.
 *
 * @param {object} options
 * @param {string} options.host            Target host (from cfg.centerHost)
 * @param {string} options.agentToken      Agent's X-Agent-Token value
 * @param {number[]} [options.priorityPorts=[80, 443, 8080]]   Fixed first
 * @param {number}    [options.rangeStart=10000]
 * @param {number}    [options.rangeEnd=60000]
 * @param {number}    [options.concurrency=50]                 Parallel workers
 * @param {number}    [options.perPortTimeoutMs=300]            Per-port cap
 * @param {object}    [options.logger]                          pino-style
 * @param {AbortSignal}[options.signal]                         Optional early-cancel
 * @returns {Promise<null | { port: number, source: 'priority'|'range', probedIn: number }>}
 */
```

**Match algorithm**:
1. Build `targets = [...priorityPorts, ...range(rangeStart, rangeEnd+1)]` — the priority list comes first so it's hit in 1-3 probes when the operator put the center on a standard port.
2. Spin up a small worker pool: pull next port from a shared queue, fire `probe(host, port)`, on success push to a result channel and signal other workers to abandon.
3. `probe(host, port)` does:
   ```js
   const r = await requestJson({
     method: 'GET',
     url: `http://${host}:${port}/config.json`,
     headers: { 'X-Agent-Token': agentToken },
     timeoutMs: perPortTimeoutMs
   });
   // match: 2xx AND body parses as object AND r.data is not null
   return r.ok && r.data && typeof r.data === 'object' ? r : null;
   ```
   - **TLS on 443**: use `http://`. If the server speaks TLS only, `requestJson` resolves with `{ ok: false, error: 'wrong-protocol' }` (existing reporter.js logic returns `ok: false` on `req.on('error')`); the scanner treats that as "port not responding" and moves on.
   - **Server speaks HTTPS on a non-443 port**: not in the priority list, falls through to range. Operators with this deploy write `priorityPorts: [443, 9443, ...]` (out of scope — only [80,443,8080] is in the priority list per user choice).
4. Worker returns null for non-matches; first non-null wins.

**Why this algorithm**:
- Priority first → typical case (80/443/8080) hits in ≤3 probes.
- Range sweep with bounded concurrency + early-exit → worst case ~50001/50 × 300ms = 5min, but typical scan exits on first match long before.
- TLS skip → matches `feedback_port_scanning_future.md` constraint, no cert verification complexity.
- `req.on('error')` already returns `{ok:false}` in reporter.js (line 28), no new error handling.

### 2.2 `writeCenterUrlAtomic(options)` — `agent/src/appsettings-writer.js`

```js
/**
 * Replace the port in centerUrl inside appsettings.json atomically.
 * Writes to a sibling .tmp, fsyncs, renames. Never throws.
 *
 * @param {object} options
 * @param {string} options.path    appsettings.json absolute path
 * @param {string} options.newUrl  Full URL with new port (e.g. http://localhost:9080)
 * @returns {{ ok: boolean, error?: string }}
 */
```

**Algorithm**:
1. `readFileSync(path)` — return `{ok:false, error:'read-failed'}` on failure.
2. `JSON.parse` — return `{ok:false, error:'parse-failed'}` on failure.
3. `cfg.centerUrl = newUrl`.
4. `writeFileSync(path + '.tmp', JSON.stringify(cfg, null, 2))` — `{ok:false, error:'write-tmp-failed'}` on failure.
5. `fsyncSync(fd)` before close — flush to disk.
6. `renameSync(path + '.tmp', path)` — `{ok:false, error:'rename-failed'}` on failure.
7. Return `{ok:true}`.

**Why atomic**: prevents partial-write corruption if the process dies mid-rewrite. Windows `renameSync` on the same volume is atomic.

**Why not just `writeFileSync(path, ...) + rename`**: process could die between write and rename → original file empty. tmp + rename is the standard pattern.

---

## §3 — appsettings.json schema additions

```diff
 {
 "centerUrl": "http://localhost:8080",
+  "centerHost": "localhost",
+  "scanOnBoot": true,
+  "scanOnRuntimeFail": true,
+  "scanFailureThreshold": 5,
   "agentId": "REPLACE_WITH_HOSTNAME",
   "agentToken": "REPLACE_WITH_TOKEN_FROM_CENTER",
   "logLevel": "info",
   ...
 }
```

### 3.1 `DEFAULTS` (in `agent/src/config.js`)

```js
const DEFAULTS = {
  // ...existing...
  // Center-port auto-discovery (see spec 2026-08-15-port-scanning-bootstrap)
  centerHost: '',                  //  empty → derive from centerUrl hostname at first use
  scanOnBoot: true,
  scanOnRuntimeFail: true,
  scanFailureThreshold: 5,
};
```

### 3.2 `centerHost` derivation

When `cfg.centerHost === ''`, the bootstrap layer derives it once: `new URL(cfg.centerUrl).hostname`. Persisted into memory only — appsettings.json is **not** rewritten just to set this default. Operator can write it explicitly to scan a different host than `centerUrl` points at (e.g., agent on `host-A`, center on `host-B`).

### 3.3 `centerUrl` has no explicit port

If `cfg.centerUrl` is e.g. `http://center` with no `:port`, prepend `:8080` to make it a valid URL. The discovered port replaces whatever the operator wrote (or the default 8080).

---

## §4 — Error handling & edge cases

| Case | Behavior |
|------|----------|
| `host` DNS lookup fails | Scan returns `null` after `concurrency × perPortTimeoutMs`; log `error`. Agent continues retry on next tick. |
| All ports refused (no center) | Same — `null` returned, agent retries. No crash. |
| Found port, but `appsettings.json` write fails (NSSM permission) | Log `error` with write error. **In-memory** `cfg.centerUrl` is swapped anyway — this run uses the discovered port. Next restart will re-scan if appsettings.json still has the wrong port. |
| Found port, response is 2xx + JSON, but token was wrong (server returned 401) | Server returns 401 → `r.ok=false` → not a match → continue scanning. |
| Found port, response is 2xx + HTML (some other service) | `r.data` is `null` after JSON.parse fails (existing reporter.js line 22) → not a match → continue. |
| `centerUrl` has trailing `/` | Trim trailing slashes before port substitution. |
| Scan finds port during startup, but retry `fetchConfig` still fails (transient blip) | Agent continues with the in-memory new port; will retry on the 5min refresh tick. |
| Scan completes during runtime, but appsettings.json rewrite is concurrent with another writer | Last writer wins. Acceptable — operator shouldn't be hand-editing while agent runs. |
| Concurrent scans (two simultaneous triggers) | Single in-flight `scanPromise` flag in agent.js. Second trigger awaits the first. |

---

## §5 — Logging

| Event | Level | Fields |
|-------|-------|--------|
| Scan started (startup) | `info` | `{ host, priorityCount, rangeStart, rangeEnd, concurrency, perPortTimeoutMs }` |
| Scan started (runtime) | `warn` | `{ host, consecutiveFailures }` — signals port drift |
| Port probed, no match | `debug` | `{ host, port, error: 'timeout' | 'connection-refused' | 'wrong-protocol' | 'non-json' | '401' }` |
| Port matched | `info` | `{ host, port, source: 'priority'\|'range', probedIn }` |
| Scan completed, no match | `error` | `{ host, portsProbed, durationMs }` |
| appsettings.json rewrite ok | `info` | `{ oldUrl, newUrl }` |
| appsettings.json rewrite fail | `error` | `{ oldUrl, newUrl, error }` |

Default scan at `info` produces ~3-5 log lines — not noisy. Debug-level port probes can be enabled by setting `logLevel: 'debug'`.

---

## §6 — Testing strategy

### 6.1 Unit tests — `agent/tests/port-scanner.test.js`

For each, spin up a real `http.createServer` on a random free port in `10000-60000` (or in the priority list via OS-assigned port):

| Test | Setup | Assertion |
|------|-------|-----------|
| Discovers a priority port | Start mock on 8080 | Returns `{port:8080, source:'priority'}`. No range ports probed. |
| Discovers a range port | Start mock on 54321 | Returns `{port:54321, source:'range'}`. Probed ≤ ~50 ports. |
| Skips TLS errors on 443 | Start an `https.createServer` (self-signed) on 443 | Returns null for 443; moves on. |
| Ignores non-JSON 2xx | Mock returns 200 + HTML | Not matched. |
| Ignores 401 (token mismatch) | Mock rejects all X-Agent-Token values | Not matched. |
| Ignores 5xx | Mock returns 500 | Not matched. |
| Early-exit on first hit | Two mocks running | Second mock's port is never probed after first hit. |
| Concurrency respected | 100 mocks running across the range | Probe count ≤ `concurrency + 1` at any time (rough smoke; full timing assertion is flaky). |
| DNS-unreachable host | Pass `host: 'this-domain-does-not-exist-12345.invalid'` | Returns `null` within bounded duration, no throw. |
| Empty range (rangeStart > rangeEnd) | rangeStart=60000, rangeEnd=10000 | Returns null from priority only; no infinite loop. |
| `AbortSignal` honored | Abort mid-scan | Returns `null`; no hang. |

### 6.2 Unit tests — `agent/tests/appsettings-writer.test.js`

| Test | Assertion |
|------|-----------|
| Round-trip write | Write new centerUrl → re-read file → centerUrl field updated. |
| Atomic on Windows | Write succeeds even if original file is read-only after init (re-set perm first). |
| Read failure surfaces | Pass non-existent path → `{ok:false, error:'read-failed'}`. |
| Parse failure surfaces | Pre-corrupt the file with `not-json` → `{ok:false, error:'parse-failed'}`. |
| Original untouched on tmp-write failure | Use a path that fails to write tmp (e.g., dir doesn't exist) → original file unchanged. |
| Other fields preserved | Write centerUrl change → agentId/agentToken/logLevel untouched. |

### 6.3 Integration test — `agent/tests/bootstrap-recovery.test.js`

End-to-end against a real center process (spun up via test fixture, similar to existing center integration tests):
1. Start center at 9080.
3. Start agent with `centerUrl: http://localhost:9080` → agent connects normally.
4. Restart center at 10001 (kill old, start new on different port).
5. Restart agent (or simulate config-refresh triggering scan) → agent's first `fetchConfig` fails (9080 is dead), agent scans, finds 10001, rewrites appsettings.json, retry succeeds.
6. Verify `appsettings.json` now has `centerUrl: http://localhost:10001`.

### 6.4 Regression

All existing agent tests (`tests/agent-*.test.js`) must pass unchanged.

---

## §7 — Implementation plan (deferred to writing-plans)

Roughly:

1. **`agent/src/port-scanner.js`** + unit tests (`tests/port-scanner.test.js`) — Task 1, TDD.
2. **`agent/src/appsettings-writer.js`** + unit tests (`tests/appsettings-writer.test.js`) — Task 2, TDD.
3. **`agent/src/config.js`** add new DEFAULTS — Task 3.
4. **`agent/agent.js`** startup bootstrap with discovery fallback — Task 4.
5. **`agent/agent.js`** runtime failure counter + trigger scan — Task 5.
6. **Integration test** — Task 6.
7. **whole-branch review** by opus — Task 7.

---

## §8 — Out of scope

- **Custom priority port list** (e.g., `knownPorts: [9080]`) — not in user requirements; add later if A proves too noisy.
- **Auto-rewrite on operator-driven port change** (operator changes web port via `/admin/config` → all agents scan + self-heal on their next refresh) — this works *implicitly* via the runtime failure trigger; no agent-side work needed.
- **Cross-host scanning** — `centerHost` enables it, but the spec only requires same-host (default derive from `centerUrl`).
- **TLS-cert verification on 443** — operator must terminate TLS at a fronting proxy that speaks HTTP behind it (matches existing reverse-proxy design).
- **UI for scan activity** — out of scope; operator can read logs.
- **Cluster-wide simultaneous scan coordination** — each agent scans independently; first scan hits, others get their own success on the new port.