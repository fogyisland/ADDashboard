import { loadConfig } from './src/config.js';
import { createLogger } from './src/logger.js';
import { runCollector } from './src/collector.js';
import { postReport, postHeartbeat, fetchConfig, signedRequestJson, _refreshLogLevel } from './src/reporter.js';
import { startHeartbeat } from './src/heartbeat.js';
import { runDiscovery, postDiscovery, startDiscoveryScheduler } from './src/discovery.js';
import { runHealthChecks } from './src/healthcheck.js';
import { fetchPortList } from './src/port-config-fetcher.js';
import { openQueue } from './src/local-queue.js';
import { createScheduler } from './src/scheduler.js';
import { PackageManager } from './src/package-manager.js';
import { getOsInfo } from './src/os-info.js';
// R158.0.1.9 (2026-10-20) — port-scanner 删除. import { discoverCenterPort }
// from './src/port-scanner.js'; + writeCenterUrlAtomic 删. 操作员 directive
// '不需要扫描端口'. 0 必保留 import 占位, _tryRecoverCenterPortImpl /
// tryRecoverCenterPort / inFlightRecovery / replacePortInUrl / deriveScanHost
// 5 个辅助函数全部删 (见 agent.js 下方 block).
// import { discoverCenterPort } from './src/port-scanner.js';
// import { writeCenterUrlAtomic } from './src/appsettings-writer.js';
import { applyAgentTokenDelivery } from './src/agent-token-delivery.js';
// 2026-10-01 R158.13 — parallel to applyAgentTokenDelivery above. Used
// at all three heartbeat call sites (AD scheduler inline + AD makeSend
// Callback wiring + non-AD inline send) to consume the centre's
// settingsPatch / clientSettingsVersion envelope.
import { applySettingsDelivery } from './src/settings-delivery.js';
// R158.48 (2026-10-06) — agent auto-update consumer. Mirror of
// applySettingsDelivery above: reads the centre's heartbeat envelope
// {upgradeAvailable, upgradeVersion}, fetches GET /api/agent/upgrade,
// stages / sha256-verifies / atomic-renames every file, persists
// installedAgentVersion via writeAppsettingsPatchAtomic, then SIGTERMs
// itself so NSSM relaunches with the new bundle. See
// agent/src/upgrade-delivery.js for the full flow.
import { applyUpgradeDelivery } from './src/upgrade-delivery.js';
import { fetchUpgrade as _fetchUpgrade, postUpgradeResult as _postUpgradeResult } from './src/reporter.js';
import { makeSendCallback, makePayload } from './src/heartbeat-callbacks.js';
// 2026-09-24 R91.4 — agentHttpGetBinary (raw-bytes endpoint) needs the
// same X-Agent-Signature header as the JSON drainers. reporter.js wraps
// the X-Agent-Signature stamp in signedRequestJson, but the file-push
// endpoint returns application/octet-stream (not JSON), so we hand-roll
// the signature via the lower-level signRequest helper. hostname +
// agentId are closed over the same way the JSON wrappers do above.
import { signRequest } from './src/lib/agent-identity.js';
// 2026-09-04 R78: wire the AD-commands + file-push drainers into the
// heartbeat loop. Both are pure-function modules; we inject the HTTP
// helpers (requestJson for JSON wire; a binary-fetch helper for the
// file bytes) and the local PS1 dispatcher.
import { drainAdCommands } from './src/ad-commands-drainer.js';
import { drainFilePush } from './src/file-push-drainer.js';
// 2026-09-05 R81 — member-server PowerShell drainer joins the heartbeat pool.
import { drainMemberCommands } from './src/member-commands-drainer.js';
import { dispatchMemberCommand } from './src/dispatchers/member-commands.js';
import { dispatchAdCommand } from './src/dispatchers/ad-admin.js';
// R158.90 (2026-10-13) — `applyPackageList, clearAllTimers` from
//   ./src/non-ad-scheduler.js deleted. runNonAdRuntime now uses R155
//   PackageManager (line 547 mirror) for the canonical /api/agent/packages
//   ?agentType=non-ad path + base64 script materialization. The legacy
//   non-ad-scheduler.js "v1 has no materialization path" stub
//   (runNonAdRuntime.runPackage at line 1127-1135 commented-out future
//   task) is no longer reached from agent.js. The non-ad-scheduler.js
//   file itself is left in the source tree for D:\dashboard\noadagent\
//   fork compatibility (R158.75 + R158.86.6 — orphan source never
//   deployed, but kept for diff parity).
// R158.50.7f (2026-10-07) — in-process dashboard. dashboard/server.js
// exports startDashboard({ config, installRoot, agentDir, logger,
// bindAddress }) and only binds an HTTP listener when that function is
// called — importing the module is side-effect free, so this import does
// not change agent boot behaviour. The actual startDashboard() call lives
// further down, in the boot block right before the AGENT_TYPE branch.
//
// CLI self-start path (`node dashboard/server.js`) still works for
// operators who don't run the agent as a service — startDashboard() is
// only invoked by the in-process call from agent.js, never by the module
// load itself.
//
// IMPORTANT path: agent.js lives at <installRoot>/agent/agent.js and
// dashboard/server.js lives at <installRoot>/dashboard/server.js (the
// two are siblings under the install root — see D:\agentInstall\README-
// green-install.md "File structure" diagram and dashboard/README.md
// design §5). The import is therefore `../dashboard/server.js`, NOT
// `./dashboard/server.js` — the first attempt at this round went with
// `./` and ERR_MODULE_NOT_FOUND at boot (no agent/dashboard/ subdir
// exists in the green-install layout).
import { startDashboard } from '../dashboard/server.js';
import http from 'node:http';
import https from 'node:https';
import { URL as NodeURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join as joinPath } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

// Default appsettings.json lives next to this script so the agent works
// regardless of cwd. argv[2] and APPSETTINGS_PATH still win when provided.
const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = joinPath(__dirname, 'appsettings.json');

// R158.50.7e (2026-10-07) — read VERSION from version.inf (operator
// directive: agent.js must NOT hardcode the version; it must read the
// single source of truth at <agentInstallDir>/version.inf). The
// prior literal `'0.1.1'` at agent.js:58 meant every heartbeat payload
// reported agentVersion='0.1.1' even when build-manifest.json shipped
// 0.1.2. Centre computeUpgradeEnvelope (center/src/routes/agent-upgrade.js:70)
// compares the literal to its installedAgentVersion, so 0.1.1
// heartbeats always saw upgradeAvailable=true but the call site in
// R158.48 below never reached applyUpgradeDelivery because the
// agentInstallDir parameter was dropped. version.inf layout (see
// D:\agentInstall\version.inf, header line 5):
//   [components]
//     version       = 0.1.2   <- the version we want
//     agent         = 0.1.2
//     dashboard     = 0.1.2
// We read the [components].version key. Falls back to build-manifest.json
// (R119 convention) when version.inf is missing (legacy dev-tree layout
// where agent.js sits at <repo>/agent/agent.js with no install root).
// Final fallback: 'unknown' — operator must investigate.
//
// IMPORTANT: this block MUST come AFTER `const __dirname = ...` above.
// The original draft placed it before __dirname (line 58), causing
// `ReferenceError: Cannot access '__dirname' before initialization`
// (ESM TDZ) at boot — agent crashed before loadConfig ever ran.
//
// Agent install root is the parent of the agent/ subdir that contains
// this script. E.g. for C:\agentInstall\agent\agent.js, install root
// = C:\agentInstall. We try to read version.inf from there first.
const agentInstallRoot = joinPath(__dirname, '..');

function readVersionFromInf(infPath) {
  try {
    const raw = readFileSync(infPath, 'utf8');
    // .inf files are ASCII-only (per version.inf header comment); a
    // simple line scan is enough — no need for a full ini parser.
    // Pattern: `version       = 0.1.2` (variable whitespace around `=`).
    // We match `[components]` first then the `version =` line; that
    // distinguishes the package version from `[components] agent = ...`
    // or `[components] dashboard = ...` keys (which would also match
    // a naive scan).
    let inComponents = false;
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (/^\[\s*\w+\s*\]$/.test(trimmed)) {
        inComponents = /^\[\s*components\s*\]$/i.test(trimmed);
        continue;
      }
      if (!inComponents) continue;
      const m = /^version\s*=\s*(\S+)/i.exec(trimmed);
      if (m) return m[1];
    }
    return null;
  } catch {
    return null;
  }
}

const _versionInfPath = joinPath(agentInstallRoot, 'version.inf');
const _manifestPath = joinPath(__dirname, 'build-manifest.json');
const VERSION =
  readVersionFromInf(_versionInfPath) ||
  (existsSync(_manifestPath)
    ? (() => { try { return JSON.parse(readFileSync(_manifestPath, 'utf8')).version; } catch { return null; } })()
    : null) ||
  'unknown';

const configPath = process.argv[2] || process.env.APPSETTINGS_PATH || defaultConfigPath;
const config = loadConfig(configPath);
const logger = createLogger({ component: 'agent', level: config.logLevel });
// R93 — reporter.js boots with a default `info` level (it imports pino
// before loadConfig runs). Hand it the operator's appsettings.json
// logLevel so flipping to `debug` actually surfaces HTTP breadcrumbs.
_refreshLogLevel(config.logLevel);

// 2026-09-24 R91.2 — hoist osInfo to module top level so the early
// boot paths (port scanner, refreshPortList inside runAdRuntime,
// PackageManager init) can read osInfo.hostname without hitting a
// temporal-dead-zone ReferenceError. Previously osInfo was declared
// `const` inside runNonAdRuntime at line 555; the AD runtime and the
// recovery paths at agent.js:102 / 236 / 285 reached for it earlier
// and crashed. Real install on KDLFLOFADSRV2 (2026-09-24) surfaced
// the bug via "ReferenceError: osInfo is not defined" at refreshPortList.
const osInfo = getOsInfo();

// R158.87.6.5 (2026-10-12) — hoist `heartbeat` to module-scope (R158.13
//   precedent: line 755 AD-runtime + line 1189 non-AD-runtime both
//   `heartbeat = startHeartbeat(...)` assign into a module-scope slot so
//   the heartbeatRef.current getter resolves when a settingsPatch
//   envelope arrives). D 盘 source 之前漏了这个 declaration, 真 install
//   C:\MemberServer\agent\agent.js 0.1.4 (72292) 现场有它, source (62470)
//   没有 — 9822 bytes 差就是 R158.13 adaptation. 本 ship 把 orphan 收回
//   source tree, 0.1.4→0.1.5 部署 C 盘不会 ReferenceError: heartbeat is
//   not defined.
//   跟 R91.2 osInfo hoist 同 precedent (R91.2 memory line 159-167).
//   跟 R158.86.6 enumerate lesson 1:1 修正: "C 盘 = 当前真 install /
//   D 盘 = 远程 ship staging / 不 mirror" → 本 ship 修了 D 盘 → C 盘
//   1:1 关系 (orphan 收回 source).
let heartbeat = null;

// ============================================================================
// R158.0.1.9 (2026-10-20) — port-scanner 删除. 5 个辅助函数块 (deriveScanHost /
// replacePortInUrl / inFlightRecovery / tryRecoverCenterPort /
// _tryRecoverCenterPortImpl) 整体删除. 操作员 directive '不需要扫描端口'.
// 失败恢复现在只剩 'log + 等下个 tick' 一条路: refreshAgentPortsWithRecovery
// 改 logger.warn + return, 不再有 scan 路径.
//
// 历史:
//   - 2026-08-15 port-scanning bootstrap (spec §1.2, §1.3): 当 fetchConfig
//     (/config.json) 失败时扫端口并 rewrite appsettings.json. AD + non-AD
//     双 runtime 用. trigger: 'boot' = 启动首次; 'runtime' = 5min tick (阈值
//     `scanFailureThreshold` 次连续失败). 每 runtime 各自管 consecutive 计数.
//   - 2026-09-22 S82 — probe 签名带 hostname+agentId, 让 centre 60s restart-
//     grace window 后仍接收. 同段 hostname 走 signedRequestJson 范式.
//   - 2026-09-24 R91.2 — osInfo hoist 到 module top level 给 refreshPortList
//     + PackageManager init 早路径用.
// 删除整个 block 后, agent 行为变化: 如果 fetchConfig 持续 fail (web port
// 错了 / DNS 错了 / token 错了), agent 仅 log warn, 不再自愈. 操作员必须
// 手动 edit appsettings.json 改 centerUrl + agentToken. 0.1.9 决定接受这个
// trade-off — 操作员明确不要 port-scan.
//
// 2026-08-21 UX redesign (auto-delivery): the centre replies to every
// heartbeat with { agentToken, agentTokenVersion } when its own current
// version is newer than what the agent reported. The helper that handles
// version-compare + atomic write + in-memory swap lives in
// src/agent-token-delivery.js so unit tests can exercise it directly.

// T16: agent type discriminator. 'ad' = legacy DC collector flow (default).
// 'non-ad' = member-server runtime: self-register on boot, fetch packages
// from /api/admin/agent/packages-for-host (host-scoped, filtered), heartbeat
// with agentType='non-ad' so the center can route to the member-servers
// touchLastSeen path. See brief §Step 2.
const AGENT_TYPE = config.agentType || 'ad';

// R158.50.7f (2026-10-07) — fire-and-forget in-process dashboard.
//
// startDashboard() must NOT block agent boot:
//   - The agent's primary duty is collect + heartbeat; a failing dashboard
//     (port conflict, EADDRINUSE, file-read permission, etc.) must not stall
//     the boot — the operator's monitoring chain depends on heartbeat
//     arriving within seconds.
//   - Both runAdRuntime() and runNonAdRuntime() are long-lived (they never
//     resolve; their work lives on setInterval / scheduler handles). So
//     dashboard startup has to happen BEFORE the runtime branch, not after.
//   - dashboardEnabled=false skips the call entirely — operators who only
//     want the collector can leave the page off without losing heartbeat.
//
// Password flow: appsettings.json stores the base64 form (Register-ADDashboardAgent.ps1:163
// writes 'YWRtaW4=' for the default admin/admin pair). dashboard/server.js
// compares the form-typed password against plainPassword (utf8), not the
// base64 string, so we resolve here before handing off.
if (config.dashboardEnabled) {
  startDashboard({
    config: {
      username: config.username,
      plainPassword: Buffer.from(String(config.password || ''), 'base64').toString('utf8'),
      port: config.port,
      centerUrl: config.centerUrl,
      agentId: config.agentId
    },
    installRoot: agentInstallRoot,   // = __dirname/.., line 92 above
    agentDir: __dirname,              // = line 61 above
    logger,
    bindAddress: '127.0.0.1'          // loopback only — dashboard/README.md design §5
  }).then((handle) => {
    logger.info(
      { component: 'agent', port: handle.port, url: `http://127.0.0.1:${handle.port}/` },
      `dashboard listening on http://127.0.0.1:${handle.port}/ (user=${config.username}, install=${agentInstallRoot})`
    );
  }).catch((e) => {
    logger.warn(
      { component: 'agent', err: e.message, port: config.port },
      `dashboard failed to start (port=${config.port}): ${e.message}`
    );
  });
}

// Shared boot infrastructure — both runtimes need an event loop + a logger,
// and both need to be able to shut down on SIGINT/SIGTERM. We wrap each
// runtime in an async fn that returns an opaque "handle" with .stop() so
// the top-level driver can stay tiny.
if (AGENT_TYPE === 'non-ad') {
  await runNonAdRuntime({ config, logger });
} else {
  await runAdRuntime({ config, logger });
}

// ============================================================================
// AD runtime — DC collector (legacy). UNCHANGED behavior; everything below
// this comment is a refactor into a callable function so the top-level
// driver can branch on agentType.
// ============================================================================
async function runAdRuntime({ config, logger }) {
  const queue = openQueue(config.queueDbPath);

  // 2026-09-04 R78: HTTP helpers used by the ad-commands + file-push
  // drainers. These wrap the existing reporter.requestJson with the
  // X-Agent-Token header baked in, and add a binary-fetch helper for
  // the file-push download endpoint (requestJson only handles JSON
  // bodies; the file bytes come back as application/octet-stream).
  //
  // Defined inside runAdRuntime so they close over config without
  // threading it through every call. The drainer modules don't see
  // the auth header directly — they just call httpGetJson/httpPostJson
  // and the wrapper stamps it.
  //
  // 2026-09-24 R91.4 — these wrappers MUST stamp X-Agent-Signature via
  // signedRequestJson, not just X-Agent-Token. R78 wired them up before
  // S82 identity binding shipped (S82 = 2026-09-09, R78 = 2026-09-04);
  // R87.1 fixed the three GET paths R78 didn't touch (port-config-fetcher,
  // port-scanner, package-manager) but skipped the drainer wrappers here,
  // so every drainer request after the 60s restart-grace window 401'd
  // with 'missing agent signature' on KDLFLOFADSRV2. Switching to
  // signedRequestJson threads the (hostname, agentId) triple through and
  // produces the same X-Agent-Signature header as the other signed paths.
  // host = config.hostname || osInfo.hostname — NOT config.agentId,
  // because the agent-identity HMAC binds to OS hostname + agentId, and
  // the previous 'hostname: config.agentId' leak would have produced a
  // signature the centre couldn't verify even if we had stamped one.
  const agentHost = config.hostname || osInfo.hostname;
  function agentHttpGetJson(args) {
    return signedRequestJson({
      method: 'GET',
      ...args,
      agentToken: config.agentToken,
      hostname: agentHost,
      agentId: config.agentId,
    });
  }
  function agentHttpPostJson(args) {
    return signedRequestJson({
      method: 'POST',
      ...args,
      agentToken: config.agentToken,
      hostname: agentHost,
      agentId: config.agentId,
    });
  }
  // Binary GET — returns { ok, status, buffer, headerSha256 }. Used by
  // the file-push drainer to pull raw file bytes off /api/agent/file-push/:id/file.
  // Mirrors the reporter.js requestJson response shape (ok:true on 2xx)
  // so the drainer can treat it identically to a JSON endpoint.
  //
  // 2026-09-24 R91.4 — also stamp X-Agent-Signature here. The raw-bytes
  // endpoint goes through the same agentMw middleware as /api/agent/file-push,
  // so without a signature it's 401'd once grace expires. HMAC body is null
  // (raw GET, no JSON body) — matches what signedRequestJson sends for the
  // other GET paths.
  async function agentHttpGetBinary({ url, headers = {}, timeoutMs = 60_000 }) {
    // 2026-09-24 R91.4 — build the same headers signedRequestJson would
    // produce for a GET: X-Agent-Token + X-Agent-Id + X-Agent-Signature
    // (over hostname:agentId:<empty body>). The file-push drainer passes
    // a plain `headers: {}` object, so we own the entire header dict here
    // and inject the auth trio before the http.request call.
    const authHeaders = {
      'X-Agent-Token': config.agentToken,
      'X-Agent-Id': config.agentId,
      // R93.1 — also stamp X-Agent-Hostname. Centre's middleware reads
      // hostname from `req.body?.hostname || req.headers['x-agent-hostname']
      // || ''`; raw GETs have no body so without this header it hashes
      // over hostname='' and our HMAC over the real hostname mismatches.
      'X-Agent-Hostname': agentHost,
      'X-Agent-Signature': signRequest({
        hostname: agentHost,
        agentId: config.agentId,
        body: null,
        token: config.agentToken
      }),
      ...headers
    };
    return new Promise((resolve) => {
      let parsed;
      try { parsed = new NodeURL(url); } catch (e) {
        return resolve({ ok: false, status: 0, error: `bad url: ${e.message}` });
      }
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.request({
        method: 'GET',
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers: authHeaders,
        timeout: timeoutMs,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const headerSha256 = (res.headers && typeof res.headers['x-file-sha256'] === 'string')
            ? res.headers['x-file-sha256']
            : null;
          if (res.statusCode >= 200 && res.statusCode < 300) {
            return resolve({ ok: true, status: res.statusCode, buffer, headerSha256 });
          }
          return resolve({ ok: false, status: res.statusCode, buffer, error: `HTTP ${res.statusCode}` });
        });
      });
      req.on('error', (err) => resolve({ ok: false, status: 0, error: err.message }));
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end();
    });
  }

  // Custom-port health probe state. `cachedPortList` is the latest copy of the
  // admin-defined /api/agent/ports list (refreshed on the healthcheck cadence);
  // `latestPortResults` is the most recent probe output, attached to the
  // heartbeat payload when non-empty. Both are mutable cache slots updated by
  // `refreshPortList()` and `runHealth` respectively.
  let cachedPortList = [];
  let latestPortResults = [];

  // Center-configured heartbeat / report ports. Refreshed every 5min alongside
  // the existing config refresh; null = no override (use centerUrl verbatim).
  //
  // 2026-09-25 R93.3 — hoisted ABOVE `refreshPortList()` so the initial
  // `await refreshPortList()` on first boot reads `cachedPorts.heartbeatPort`
  // without tripping a `let` TDZ ReferenceError. (The previous location at
  // the bottom of this block put the declaration *after* the first call —
  // fine when refreshPortList didn't reference the variable, but R93.3 adds
  // `port: cachedPorts.heartbeatPort` so the declaration order matters.)
  let cachedPorts = { heartbeatPort: null, reportPort: null };

  async function refreshPortList() {
    // 2026-09-22 S82 — stamp (hostname, agentId) so the centre accepts
    // GET /api/agent/ports after the 60s restart-grace window.
    // 2026-09-25 R93.3 — pass `cachedPorts.heartbeatPort` so the request lands
    // on the heartbeat app (8081) where /api/agent/ports is mounted. The web
    // app (8080) returns 404 HTML for this path. `cachedPorts.heartbeatPort`
    // is set by `refreshAgentPorts()` below from /config.json; on first boot
    // R93.7 ensures `refreshAgentPortsWithRecovery('boot')` runs before the
    // initial `refreshPortList()` so `cachedPorts.heartbeatPort` is already
    // populated. At RUNTIME, a tick can still race ahead of the next config
    // refresh (5min cadence) and fall through to `null` → centerUrl → web 404;
    // fetchPortList swallows the 404 HTML and returns [], so the failure mode
    // is "scan finds nothing for one tick" rather than "operator sees a 404".
    cachedPortList = await fetchPortList(
      config.centerUrl, config.agentToken,
      { hostname: config.hostname || osInfo.hostname, agentId: config.agentId, port: cachedPorts.heartbeatPort }
    );
  }
  // 2026-09-25 R93.7 — initial `await refreshPortList()` no longer runs
  // here. It now runs AFTER `await refreshAgentPortsWithRecovery('boot')`
  // (see the call site ~10 lines below) so `cachedPorts.heartbeatPort` is
  // populated before the first tick. See the breadcrumb on that call site
  // and tests/boot-order.test.js for the regression guard.

  // Center-configured heartbeat / report ports. Refreshed every 5min alongside
  // the existing config refresh; null = no override (use centerUrl verbatim).
  // R93.3 — declaration hoisted above refreshPortList() (see comment on the
  // earlier `let cachedPorts = …`). The remaining `refreshAgentPorts()` /
  // `refreshAgentPortsWithRecovery()` setters below mutate the SAME object
  // because `let` hoists the binding (not the value) and the early
  // declaration already initialized `{ heartbeatPort: null, reportPort: null }`.

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
    if (ok) return;
    // R158.0.1.9 (2026-10-20) — port-scanner 删除. 老分支 (boot: scanOnBoot
    // / runtime: scanOnRuntimeFail + scanFailureThreshold 阈值 + tryRecover
    // CenterPort) 全部删. 现在失败路径只剩 log warn 等下个 tick. 操作员必须
    // 手动 edit appsettings.json (centerUrl / agentToken) 才能恢复. 0 自愈.
    // R158.X.99 (2026-10-21) — 删掉 consecutivePortFailures 死计数 (随
    // scanFailureThreshold 阈值分支一起没了, 没人读它).
    logger.warn(
      { trigger, centerUrl: config.centerUrl },
      'fetchConfig failed; port scan removed in 0.1.9, will retry on next tick'
    );
  }

  await refreshAgentPortsWithRecovery('boot');

  // 2026-09-25 R93.7 — moved here from line 328 (above refreshPortList).
  // See the breadcrumb on the `let cachedPorts` declaration for the full
  // rationale. The summary: `cachedPorts.heartbeatPort` is now populated
  // BEFORE the first fetchPortList, so the first boot tick lands on
  // heartbeat (8081) instead of web (8080).
  await refreshPortList();

  // R93.5 — pass a live getter for the report port so a runtime
  // config refresh (refreshAgentPorts mutating cachedPorts.reportPort
  // every 5min) is observed by PackageManager without a service
  // restart. cachedPorts is already populated by the await on line
  // 374; the getter is the source of truth going forward.
  const packageManager = new PackageManager({
    agentId: config.agentId,
    agentVersion: VERSION,
    centerBaseUrl: config.centerUrl,
    agentToken: config.agentToken,
    hostname: config.hostname || osInfo.hostname,
    // R158.94 (2026-10-13) — derive dataDir from __dirname when
    //   appsettings.json 0 设 agentDataDir. Operator 显式
    //   "agentDataDir": "C:\\MemberServer\\agent\\data" (R158.91 KDLFLPBISrv
    //   ship) 仍 win; 0 显式 override → fallback joinPath(__dirname, 'data')
    //   = 任何 install 路径自动正确. ROOT 闭合 R158.86.6 enumerate lesson #8.
    //   1:1 平行 AD (line 555) + non-AD (line 1164) 两处 PackageManager ctor.
    dataDir: config.agentDataDir || joinPath(__dirname, 'data'),
    logger,
    powerShellPath: config.powerShellPath,
    getReportPort: () => cachedPorts.reportPort,
    // R158.87.6.5 (2026-10-12) — 显式传 config 让 PackageManager 拿到
    //   agentType (D:\dashboard\agent\src\config.js:31 = 'ad'). syncFromCenter
    //   用 this.config.agentType 拼 ?agentType=ad query, 防 AD agent 错拉
    //   member 包. 跟 noad agent D:\dashboard\noadagent\src\non-ad-scheduler.js
    //   1:1 对称, 但 agentType 不同 (R158.75 fork + R158.86.6 修正).
    config
  });

  // 2026-08-24 round-12 (T7): state for the heartbeat-callbacks module.
  // The callbacks own NO state themselves; this `let` is the one and only
  // backing store, accessed via the getters below. Same pattern for the
  // scheduler reference: it's created LATER in this function, so we hand
  // the callback a getter that resolves at call time. By the time any
  // heartbeat actually fires (>= heartbeatIntervalSeconds), both will be
  // populated — the first heartbeat fires immediately, but the scheduler
  // will exist synchronously after the assignment below.
  //
  // 2026-08-25 round-12 fan-out: added discoveryRef for the same reason.
  // startDiscoveryScheduler is created further down but the heartbeat
  // callback wiring (above) needs to be in place BEFORE startHeartbeat
  // constructs its first tick. Lazy getter resolves at the moment a
  // heartbeat actually fires, by which time the discovery object exists.
  let pendingReportRequestClear = false;
  const getPendingClear = () => pendingReportRequestClear;
  const setPendingClear = (v) => { pendingReportRequestClear = v; };
  let schedulerRef = null;
  const getScheduler = () => schedulerRef;
  let discoveryRef = null;
  // 2026-10-01 R158.13 — lazy getter for the heartbeat handle so the
  // settings-delivery callback can call heartbeat.restart() at the moment
  // a settingsPatch arrives (after startHeartbeat constructs it below).
  // Mirror of schedulerRef/discoveryRef.
  let heartbeat = null;
  const heartbeatRef = { get current() { return heartbeat; } };
  const getDiscovery = () => discoveryRef;

  // R158.48 (2026-10-06) — one-shot last-upgrade-event state. Mirror of
  // pendingReportRequestClear / getPendingClear / setPendingClear above.
  // applyUpgradeDelivery sets lastUpgradeEvent on success; the next
  // heartbeat's makePayload reads it and forwards {last_upgrade_event}
  // to the centre, then clears lastReportedUpgradeVersion so we don't
  // re-send the same event on subsequent heartbeats. This is the same
  // one-shot pattern used by report_requested_at (see
  // heartbeat-callbacks.js makePayload).
  let lastUpgradeEvent = null;
  let lastReportedUpgradeVersion = null;
  const getLastUpgradeEvent = () => lastUpgradeEvent;
  const setLastUpgradeEvent = (e) => { lastUpgradeEvent = e; lastReportedUpgradeVersion = null; };
  // config.__setLastUpgradeEvent is called from inside applyUpgradeDelivery
  // — that's how the delivery module (which only receives `config`) bumps
  // the closure-captured state without us having to pass another arg.
  config.__setLastUpgradeEvent = setLastUpgradeEvent;
  // Bound params for fetchUpgrade. We build it once and capture
  // (config.agentToken, config.hostname/osInfo.hostname, config.agentId)
  // here so the closure inside the heartbeat callback doesn't need to
  // reach back into agent.js every tick.
  const boundFetchUpgrade = () => _fetchUpgrade({
    centerUrl: config.centerUrl,
    agentToken: config.agentToken,
    hostname: config.hostname || osInfo.hostname,
    agentId: config.agentId
  });
  // R158.87.6.5 (2026-10-12) — boundFetchUpgradeResult. 跟 boundFetchUpgrade
  //   1:1 平行, postUpgradeResult 报 fleet 端 silent fail / applied 给中心.
  const boundFetchUpgradeResult = (body) => _postUpgradeResult({
    centerUrl: config.centerUrl,
    agentToken: config.agentToken,
    hostname: config.hostname || osInfo.hostname,
    agentId: config.agentId,
    body
  });

  const send = makeSendCallback({
    postHeartbeat: (payload) => postHeartbeat({
      centerUrl: config.centerUrl,
      agentToken: config.agentToken,
      port: cachedPorts.heartbeatPort,
      // R93.2 — explicit hostname + agentId so signedRequestJson can
      // stamp the full header quartet. Payload already carries hostname
      // (see sendHeartbeat at line 587-600) so the helper's
      // `payload?.hostname` fallback would also catch it; passing
      // explicitly here means the wiring is robust to a future payload
      // shape change that drops the hostname field.
      hostname: config.hostname || osInfo.hostname,
      agentId: config.agentId,
      payload
    }),
    applyAgentTokenDelivery: ({ result }) => applyAgentTokenDelivery({
      result, config, configPath, logger
    }),
    // 2026-10-01 R158.13 — parallel to applyAgentTokenDelivery above.
    // Consumes the centre's settingsPatch / clientSettingsVersion
    // envelope, persists the patch atomically via writeAppsettingsPatch
    // Atomic, mutates the in-memory config (and config.clientSettings
    // Version), and calls heartbeat.restart() when heartbeatInterval
    // Seconds changed. The heartbeatRef.current getter resolves to the
    // live handle declared above (assigned by startHeartbeat further
    // down) — see the comment near the `let heartbeat` declaration.
    // 2026-10-01 R158.13 — applySettingsDelivery is invoked inline at the
    // heartbeat.send call sites (line 768 AD scheduler + line 1046 non-AD
    // inline) rather than going through makeSendCallback. The factory
    // doesn't declare an applySettingsDelivery parameter, so an injected
    // shape here would be silently ignored. Kept the inline pattern below
    // for consistency; applyUpgradeDelivery (R158.48) follows the same
    // inline path for the same reason — see line 770/1048 below.
    // R158.48 — getLastUpgradeEvent + setLastUpgradeEventCleared are
    // consumed by makePayload (heartbeat-callbacks.js:makePayload) for the
    // one-shot {last_upgrade_event} heartbeat field.
    getLastUpgradeEvent,
    setLastUpgradeEventCleared: (v) => { lastReportedUpgradeVersion = v; },
    scheduler: { get _tick() { return getScheduler()._tick; } },
    logger,
    getPendingClear,
    setPendingClear,
    // 2026-08-25 round-12 report-now fan-out: hand the heartbeat callback
    // both extra collectors. discovery is captured lazily via getDiscovery()
    // because startDiscoveryScheduler() runs AFTER makeSendCallback() is
    // constructed (and runs first on boot — see the startDiscoveryScheduler
    // tick-immediately behavior). packageManager is stable from agent.js
    // scope (created above), so it can be passed directly. See scheduler.js
    // for why replication already uses the lazy getter.
    runDiscovery: () => getDiscovery().run(),
    runPackages: () => packageManager.runAllNow({ triggeredBy: 'report-now' }),
    // R158 (2026-09-30) — heartbeat piggyback for centre-issued triggers
    // (cron / manual). Lists are bounded (≤ 5 entries per heartbeat, see
    // services/trigger-queue.js DEFAULT_LIMIT) so this fan-out stays
    // cheap even if cron-scheduler piles up. runTriggersNow only runs
    // the named packages — never the full installed set — so a
    // coincident operator click doesn't double-fire every package.
    runTriggeredPackages: (triggers) => packageManager.runTriggersNow(triggers, { triggeredBy: 'heartbeat-trigger' }),
    // 2026-09-04 R78: drain ad-commands + file-push on every heartbeat.
    // Both are agent-pull flows (R75 / R65 followup); the operator queues
    // work in the center and expects the next heartbeat to pick it up
    // without needing a manual 回报 click. The http* helpers inject the
    // X-Agent-Token auth header into every request; the drainer modules
    // themselves are auth-agnostic (testable with stub functions).
    //
    // 2026-09-24 R91.4 — drainer callers used to pass `hostname: config.agentId`
    // (a copy/paste bug from R78); the drainers then forwarded that value as
    // `hostname` to the wrapper helpers, which stamped it into the HMAC
    // signature. The centre recomputes the signature with the OS hostname
    // from req.body.hostname, so the two sides never matched and the centre
    // rejected every request with 'identity mismatch'. The HTTP wrappers
    // themselves now close over `agentHost` (line ~204) and stamp the right
    // hostname automatically; we still pass the correct hostname through to
    // the drainers because file-push + member-commands read it for their
    // own audit fields, not just for the signature.
    drainAdCommands: () => drainAdCommands({
      hostname: config.hostname || osInfo.hostname,
      token: config.agentToken,
      centerUrl: config.centerUrl,
      httpGetJson: agentHttpGetJson,
      httpPostJson: agentHttpPostJson,
      dispatchAdCommand: (args) => dispatchAdCommand({
        ...args,
        powerShellPath: config.powerShellPath,
        // R158.40 (2026-10-03) — 把 dispatcher 的 scriptsDir 改成 package-manager
        // 的 cacheDir (`<dataDir>/packages`). 包驱动命令 (ou_create / object_move /
        // object_delete) 走这里解析 `<cacheDir>/<pkgName>/<version>/collect.ps1`.
        //
        // R158.56c (2026-10-08) — R158.40 注释说"老 user_/group_ 命令继续走默认
        // scriptsDir 不受影响"是错的: dispatcher 内部用 caller 注入的 scriptsDir
        // 拼所有 commandType 路径, 老 user_/group_ 命令会被拼成
        // `<cacheDir>/ad-admin-users.ps1` = `<dataDir>/packages/ad-admin-users.ps1`,
        // 而老 PS1 实际在 `agent/scripts/ad-admin-users.ps1`, 永远 ENOENT.
        // (KDLFLOFADSRV1 user_create 23:31 失败 + exit_code=4294770688 即此因).
        // 修复: dispatcher ad-admin.js R158.56c 让老 user_/group_ 命令路径
        // 强制走 dispatcher 内部 DEFAULT_SCRIPTS_DIR (= `agent/scripts/`, 不依赖
        // caller 注入), caller 这里仍然传 cacheDir 仅给包驱动命令用.
        // packageManager 是上面定义的常量, 这里闭包引用. caller (heartbeat) 在
        // 包未初始化时调 dispatchAdCommand, 此时 cacheDir 不存在 — 我们不在
        // 这里做 existsSync 检查, 让 dispatcher.executeScript 的 spawn 失败返
        // 干净的错误 (跟老 17 个 user_/group_ 一样 fail-soft).
        scriptsDir: packageManager?.cacheDir ?? config.agentDataDir,
      }),
      logger,
    }),
    drainFilePush: () => drainFilePush({
      hostname: config.hostname || osInfo.hostname,
      agentId: config.agentId,
      token: config.agentToken,
      centerUrl: config.centerUrl,
      httpGetJson: agentHttpGetJson,
      httpGetBinary: agentHttpGetBinary,
      // 2026-09-22 R78.1 — agent-side ack endpoint. After the drainer
      // writes the file (or hits a hard failure) it POSTs the outcome
      // to /api/agent/file-push/:id/ack so the center flips the
      // per-target status + emits the audit row. httpPostJson stamps
      // the X-Agent-Token header the same way httpGetJson does.
      httpPostJson: agentHttpPostJson,
      logger,
    }),
    // 2026-09-05 R81 — drain member-server PowerShell on every
    // heartbeat. Same shape as ad-commands: pull queued work from
    // center, dispatch locally via run-member-script.ps1, ack the
    // result. dispatcher gets the powerShellPath injected so the
    // agent's config can point at a non-default PowerShell location.
    drainMemberCommands: () => drainMemberCommands({
      // 2026-09-24 R91.4 — same hostname bug as drainAdCommands /
      // drainFilePush above. Replaced `config.agentId` with the actual
      // OS hostname so drainer audit fields and HMAC triple agree.
      hostname: config.hostname || osInfo.hostname,
      token: config.agentToken,
      centerUrl: config.centerUrl,
      httpGetJson: agentHttpGetJson,
      httpPostJson: agentHttpPostJson,
      dispatchMemberCommand: (args) => dispatchMemberCommand({
        ...args,
        powerShellPath: config.powerShellPath,
      }),
      logger,
    }),
  });

  const buildPayload = makePayload({
    getPendingClear, setPendingClear,
    // R158.48 — one-shot last-upgrade-event payload field. See
    // heartbeat-callbacks.js:makePayload + upgrade-delivery.js.
    getLastUpgradeEvent, setLastUpgradeEventCleared: (v) => { lastReportedUpgradeVersion = v; }
  });

  // 2026-10-01 R158.13 — assign into the `let heartbeat` slot declared
  // above (line 429) so the heartbeatRef.current getter resolves to the
  // live handle. The original line used `const heartbeat = ...` which
  // raises SyntaxError: Identifier 'heartbeat' has already been declared
  // because the `let heartbeat` ref-forward is already in scope.
  heartbeat = startHeartbeat({
    intervalMs: Math.max(1, config.heartbeatIntervalSeconds) * 1000,
    payload: () => {
      const p = {
        agentId: config.agentId,
        // R93.2 — include hostname in the heartbeat payload so the centre's
        // middleware can resolve it from `req.body.hostname` first (matches
        // its documented resolution order at agent-token.js:171). This also
        // makes the heartbeat table's per-row label unambiguous when an
        // operator reads ad_agent_heartbeat directly.
        hostname: config.hostname || osInfo.hostname,
        agentVersion: VERSION,
        pendingQueueSize: queue.count(),
        // 2026-08-21 UX redesign: echo back the agent's last-seen
        // agent_token_version so the centre can decide whether to attach
        // a new credential to the response (auto-delivery).
        agent_token_version: Number(config.agentTokenVersion) || 0
      };
      if (Array.isArray(latestPortResults) && latestPortResults.length > 0) {
        p.ports = latestPortResults.map(x => ({ port: x.port, ok: x.ok, latencyMs: x.latencyMs }));
      }
      p.packages = {
        installed: packageManager.listLocal(),
        pending: packageManager.reportBatch.length + packageManager.queue.length
      };
      return buildPayload(p);
    },
    send
  });

  // R158.61+5.2 (2026-10-10) — fire drainFilePush ONCE immediately on boot
  // (not waiting for the first heartbeat tick at 5s). Earlier agents only
  // triggered the drainer through the heartbeat callback pool, which meant
  // any boot-time race between the drainer's httpGetJson and agentToken
  // resolution could leave the drainer in a permanently-failed state for
  // the lifetime of the process (the 5s tick would repeat the same broken
  // call indefinitely). By firing once at boot we get a fresh stack — if
  // it fails the next heartbeat tick logs a fresh error instead of a
  // cached one, and operators grepping NSSM stderr see the actual root
  // cause (401, DNS, ENOTFOUND, etc.) right after the service starts
  // instead of having to wait 12h+ for a manual restart to correlate.
  setImmediate(async () => {
    try {
      const r = await drainFilePush({
        hostname: config.hostname || osInfo.hostname,
        agentId: config.agentId,
        token: config.agentToken,
        centerUrl: config.centerUrl,
        httpGetJson: agentHttpGetJson,
        httpGetBinary: agentHttpGetBinary,
        httpPostJson: agentHttpPostJson,
        logger
      });
      logger.info({ event: 'file-push.boot-drain', result: r }, 'file-push boot-time drain complete');
    } catch (e) {
      logger.warn({ err: e.message, event: 'file-push.boot-drain' }, 'file-push boot-time drain threw; relying on heartbeat pool');
    }
  });

  // Site/DCs topology discovery. Runs the PowerShell topology script on a long
  // interval (default 4h) and posts the result to the center's discover endpoint.
  // R93.2 — postDiscovery now uses signedRequestJson and posts to the report
  // port (8082) instead of the web port (8080). /api/agent/discover is
  // mounted only on reportApp, so the previous "send to centerUrl" path
  // always 404'd against the web app.
  const discovery = startDiscoveryScheduler({
    intervalHours: config.discoveryIntervalHours,
    run: async () => {
      const snap = await runDiscovery({
        powerShellPath: config.powerShellPath,
        psDiscoveryScriptPath: config.psDiscoveryScriptPath,
        logger
      });
      if (!snap) return;
      await postDiscovery({
        centerUrl: config.centerUrl,
        agentToken: config.agentToken,
        port: cachedPorts.reportPort,
        hostname: config.hostname || osInfo.hostname,
        agentId: config.agentId,
        payload: {
          agentId: config.agentId,
          collectedAt: new Date().toISOString(),
          dc: snap
        }
      });
    },
    logger
  });

  // Periodically refresh config from center. If pollingIntervalMinutes or
  // discoveryIntervalHours changes, the in-memory value updates but the
  // scheduler's existing timers do NOT restart — that takes effect on next
  // service restart. Acceptable trade-off; a runtime restart would require
  // recreating pollTimer / discovery scheduler.
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

  const scheduler = createScheduler({
    config,
    logger,
    queue,
    collect: () => runCollector({
      powerShellPath: config.powerShellPath,
      psScriptPath: config.psScriptPath,
      // R93 — surface the operator's logLevel to runCollector so the
      // collector's pino instance can emit info/error breadcrumbs.
      level: config.logLevel,
      // I-3 — collect-replication.ps1's worst-case latency is bounded by the
      // partner metadata fetch (Get-ADReplicationPartnerMetadata) on the
      // largest hub. 2026-08-28 round-45: per-partner port probing is gone
      // (R35 port monitoring deleted end-to-end) so the 25-partner × 5-port
      // × 1.5s worst-case no longer applies. 200s remains as a defensive
      // ceiling for the history-attempt fetch (3 attempts × 25 partners).
      // runCollector's default timeoutMs is 60s, which would SIGKILL
      // the snapshot mid-emission on large topologies. 200s leaves
      // ~13s headroom so transient TCPSocket.Wait variability doesn't
      // trip the timeout, while still bounding a stuck snapshot well
      // within the agent's scheduler cadence.
      timeoutMs: 200000
    }),
    send: (snap) => postReport({
      centerUrl: config.centerUrl,
      agentToken: config.agentToken,
      port: cachedPorts.reportPort,
      // R93.2 — pass real hostname (not agentId) so the report HMAC
      // matches what the centre's middleware reads off `req.body.hostname`
      // / X-Agent-Hostname. Legacy convention treated hostname === agentId
      // which worked only because both sides hashed with the same wrong
      // value and accidentally agreed; once the centre started reading
      // from headers, the bug surfaced.
      hostname: config.hostname || osInfo.hostname,
      snapshot: snap
    }),
    sendHeartbeat: (extra) => {
      const payload = {
        agentId: config.agentId,
        // R93.2 — same rationale as the AD-runtime heartbeat payload
        // above: include hostname in the body so the centre's body-first
        // resolution picks up the real value.
        hostname: config.hostname || osInfo.hostname,
        agentVersion: VERSION,
        // 2026-08-21 UX redesign: see AD-runtime heartbeat payload above
        // for the rationale. Same contract — the centre decides whether to
        // push a new token, we apply the swap when it does.
        agent_token_version: Number(config.agentTokenVersion) || 0,
        ...extra
      };
      if (Array.isArray(latestPortResults) && latestPortResults.length > 0) {
        payload.ports = latestPortResults.map(x => ({ port: x.port, ok: x.ok, latencyMs: x.latencyMs }));
      }
      return postHeartbeat({
        centerUrl: config.centerUrl,
        agentToken: config.agentToken,
        port: cachedPorts.heartbeatPort,
        // R93.2 — explicit hostname + agentId so signedRequestJson can
        // stamp the full header quartet. Without these the helper would
        // see `undefined` and skip the signature header entirely.
        hostname: config.hostname || osInfo.hostname,
        agentId: config.agentId,
        payload
      }).then(async (r) => {
        await applyAgentTokenDelivery({ result: r, config, configPath, logger });
        // 2026-10-01 R158.13 — apply settingsPatch envelope after every
        // scheduler-driven heartbeat (parallel to applyAgentTokenDelivery
        // above). heartbeatRef.current resolves to the live handle
        // assigned below in startHeartbeat.
        await applySettingsDelivery({ result: r, config, configPath, logger, heartbeat: heartbeatRef.current });
        // R158.48 (2026-10-06) — agent auto-update. Consumes the
        // {upgradeAvailable, upgradeVersion} envelope from the centre.
        // On success the delivery module SIGTERMs this process via
        // setImmediate so NSSM relaunches with the new bundle.
        // R158.50.7e (2026-10-07) — pass agentInstallDir (line 62
        // __dirname = dirname of this script). Without it
        // applyUpgradeDelivery short-circuits at upgrade-delivery.js:114
        // with event='agent.upgrade.skip' reason='no-agent-install-dir'.
        const upgradeR = await applyUpgradeDelivery({ result: r, agentInstallDir: __dirname, config, configPath, logger, fetchUpgrade: boundFetchUpgrade, fetchUpgradeResult: boundFetchUpgradeResult });
        // R158.88.BF1 (2026-10-13) — SIGTERM after apply. R158.48 注释 (upgrade-delivery.js:18) 谎话 "caller schedules setImmediate" 24h 0 真调 = bundle 装盘但 0 进程死 = NSSM 不重拉 = 24h 0 applied 铁证真因. 修在 inline caller (line 769/1248) 不在 makeSendCallback.
        if (upgradeR && upgradeR.applied === true && upgradeR.exiting === true) {
          logger?.info?.({ event: 'agent.upgrade.applied.sigterm', toVersion: upgradeR.newVersion, fromVersion: upgradeR.previousVersion }, 'agent upgrade applied; SIGTERM self for NSSM relaunch');
          setImmediate(() => process.kill(process.pid, 'SIGTERM'));
        }
        return r;
      });
    },
    runHealth: async () => {
      await refreshPortList();
      const r = await runHealthChecks({
        centerUrl: config.centerUrl,
        agentToken: config.agentToken,
        // 2026-09-24 R91.4 — was `hostname: config.agentId`, the same
        // copy/paste bug as the drainer callers. healthcheck.js forwards
        // this value as both the per-probe audit label and as part of
        // the X-Agent-Signature HMAC triple via signedRequestJson; the
        // wrong value produced 'identity mismatch' 401s on every probe.
        hostname: config.hostname || osInfo.hostname,
        heartbeatPort: cachedPorts.heartbeatPort,
        ports: cachedPortList.map(p => p.port)
      });
      if (Array.isArray(r.ports)) latestPortResults = r.ports;
      return r;
    }
  });

  // 2026-08-24 round-12 (T7): wire the scheduler ref into the heartbeat
  // callback closure. The heartbeat was started BEFORE the scheduler was
  // created (preserving the original control flow), so the callback reads
  // it lazily via getScheduler().
  //
  // 2026-08-25 round-12 fan-out: same pattern for discoveryRef. The
  // discovery scheduler is also constructed before its first heartbeat
  // call, so the lazy getter is just a future-proofing belt — by the
  // time a heartbeat can see reportRequested:true, both refs are set.
  schedulerRef = scheduler;
  discoveryRef = discovery;

  scheduler.start();
  packageManager.start();
  logger.info({ agentId: config.agentId, centerUrl: config.centerUrl, agentType: 'ad' }, 'agent started');

  const shutdown = async (sig) => {
    logger.info({ sig }, 'shutting down');
    heartbeat.stop();
    discovery.stop();
    clearInterval(configRefresh);
    await scheduler.stop();
    packageManager.stop();
    queue.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// ============================================================================
// Non-AD runtime — member-server heartbeat + self-register + per-host
// package fetch (T16, spec §4.3). Does NOT touch DC replication data;
// the AD runtime above remains the sole writer to ad_replication_status.
// ============================================================================
async function runNonAdRuntime({ config, logger }) {
  // 2026-09-24 R91.2 — osInfo is now module-level (hoisted from here to
  // agent.js top). The previous shadowing const inside this function put
  // the variable in TDZ for any code path that ran before this line.

  // 1. Self-register once on boot. The endpoint is idempotent (upsert
  //    discovered_via='self-register'), so it's safe to retry on transient
  //    failures. Fire-and-forget with a logger breadcrumb so a center
  //    outage at boot doesn't block the heartbeat from coming up.
  async function selfRegister() {
    // 2026-09-24 R91.4 — used to call `requestJson` with only the
    // X-Agent-Token header. self-register hits the agentMw-protected
    // /api/admin/member-servers/self-register endpoint, which goes
    // through agent-token.js S82 identity binding; without the signature
    // header the request 401s after the 60s grace window. Switched to
    // signedRequestJson with the same triple used by the other agent
    // → center POSTs (heartbeat/report) — keeps the HMAC contract
    // uniform across every endpoint that talks to the centre.
    const r = await signedRequestJson({
      method: 'POST',
      url: `${config.centerUrl}/api/admin/member-servers/self-register`,
      agentToken: config.agentToken,
      hostname: config.hostname || osInfo.hostname,
      agentId: config.agentId,
      body: {
        hostname: config.hostname || osInfo.hostname,
        agentVersion: VERSION,
        osVersion: osInfo.version,
        ipAddress: osInfo.ip,
        // R158.94 (2026-10-13) — send the live install path so the centre
        //   records it in ad_member_servers.install_root (1.0.17 migration).
        //   Derives from __dirname (= dirname of agent.js script) at
        //   runtime so any install location (C:\MemberServer\agent,
        //   /opt/agent/, D:\agent\) auto-resolves, no hardcoding. Same
        //   provenance as agent.js:975/1223 (applyUpgradeDelivery
        //   agentInstallDir=__dirname) — different destination.
        installRoot: __dirname
      },
      timeoutMs: 30_000
    });
    if (!r.ok) {
      logger.warn({ status: r.status, error: r.error, hostname: osInfo.hostname }, 'self-register failed (best-effort)');
    } else {
      logger.info({ hostname: osInfo.hostname }, 'self-register ok');
    }
  }
  // Fire on boot, do not await (the brief shows a non-blocking start so
  // the agent comes up even if the center is briefly unreachable).
  selfRegister();

  // 2. Per-host package fetcher. We do NOT use the legacy
  //    PackageManager's /api/agent/packages endpoint because that route
  //    only returns globally-enabled packages; for non-AD we need the
  //    per-host merged list (server-group bindings + globally enabled)
  //    and the in-agent filter that selects only non-ad / windows
  //    packages. The shape returned by /api/admin/agent/packages-for-host
  //    is { items: Manifest[] }; we feed each filtered manifest into a
  //    lightweight one-shot runner, NOT PackageManager (which would
  //    re-derive intervals / disk cache from a different endpoint).
  let cachedPorts = { heartbeatPort: null, reportPort: null };

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
    if (ok) return;
    // R158.0.1.9 (2026-10-20) — port-scanner 删除. 老分支 (boot: scanOnBoot
    // / runtime: scanOnRuntimeFail + scanFailureThreshold 阈值 + tryRecover
    // CenterPort) 全部删. 现在失败路径只剩 log warn 等下个 tick. 操作员必须
    // 手动 edit appsettings.json (centerUrl / agentToken) 才能恢复. 0 自愈.
    // R158.X.99 (2026-10-21) — 删掉 consecutivePortFailures 死计数 (随
    // scanFailureThreshold 阈值分支一起没了, 没人读它).
    logger.warn(
      { trigger, centerUrl: config.centerUrl },
      'fetchConfig failed; port scan removed in 0.1.9, will retry on next tick'
    );
  }

  await refreshAgentPortsWithRecovery('boot');

  // R158.90 (2026-10-13) — runNonAdRuntime now uses R155 PackageManager,
  //   1:1 parallel to runAdRuntime line 547-563. Pre-R158.90 this
  //   function called `applyPackageList(items, runPackage)` from the
  //   orphan `src/non-ad-scheduler.js` stub whose `runPackage`
  //   (deleted block below, R66 T8 + R91.4 era) saw `pkg.scriptPath`
  //   undefined on every package and debug-logged 'scriptPath not yet
  //   materialized, skipping'. KDLFLPBISrv's `data\packages\` was 1
  //   byte empty for 24h+ because R158.78 + R158.86 ship never
  //   enumerated the agent-end materialize step
  //   (R158.86.6 enumerate-5-dimensions lesson #7).
  //
  //   PackageManager.syncFromCenter calls
  //     GET /api/agent/packages?agentType=non-ad
  //   and the centre's runner.js:381-480 JOIN returns both
  //   `member_eventlog_collector 1.0.0` and
  //   `member_os_baseline_collector 1.0.1` (their package_policies rows
  //   have `scope='agent_type:non-ad'`, seeded by
  //   center/src/services/builtin-packages.js SCOPE_OVERRIDE). The
  //   script_content column is base64-decoded into
  //   `dataDir/packages/<name>/<version>/collect.ps1` (line 181-194),
  //   and the per-package interval timer fires `runOne` (line 405-509)
  //   which `spawn(powershell -File collect.ps1)` and posts the result
  //   to /api/admin/agent/packages/report.
  //
  //   R158.87.6.5 (2026-10-12) — `config` is passed explicitly so
  //   PackageManager reads `this.config.agentType='non-ad'` (from
  //   appsettings.json line 13) and the syncFromCenter URL gets
  //   `?agentType=non-ad` (defence-in-depth alongside the centre's L1
  //   fail-closed `isMemberHostnameFailClosed`).
  //
  //   R93.5 — `getReportPort` is a live getter so the 5min
  //   configRefresh on line 1264 mutating `cachedPorts.reportPort`
  //   propagates without a service restart. Mirrors runAdRuntime line
  //   556 verbatim.
  const packageManager = new PackageManager({
    agentId: config.agentId,
    agentVersion: VERSION,
    centerBaseUrl: config.centerUrl,
    agentToken: config.agentToken,
    hostname: config.hostname || osInfo.hostname,
    // R158.94 (2026-10-13) — derive dataDir from __dirname when
    //   appsettings.json 0 设 agentDataDir. Operator 显式
    //   "agentDataDir": "C:\\MemberServer\\agent\\data" (R158.91 KDLFLPBISrv
    //   ship) 仍 win; 0 显式 override → fallback joinPath(__dirname, 'data')
    //   = 任何 install 路径自动正确. ROOT 闭合 R158.86.6 enumerate lesson #8.
    //   1:1 平行 AD (line 555) + non-AD (line 1164) 两处 PackageManager ctor.
    dataDir: config.agentDataDir || joinPath(__dirname, 'data'),
    logger,
    powerShellPath: config.powerShellPath,
    getReportPort: () => cachedPorts.reportPort,
    // R158.87.6.5 — explicit config (mirrors runAdRuntime line 562).
    // config.agentType='non-ad' from appsettings.json line 13.
    config
  });
  // R155 — start() schedules syncFromCenter (5min cadence + initial
  //   fire-and-forget) AND the periodic flushReportQueue (5s). Mirrors
  //   runAdRuntime line 1005 verbatim. The pre-R158.90 block above
  //   (`pollPackages + setInterval 5min + applyPackageList`) duplicated
  //   this scheduling with a different (incomplete) sync path; deleting
  //   it eliminates the dead branch.
  packageManager.start();

  // 3. Heartbeat loop. Same /api/agent/heartbeat endpoint as the AD flow,
  //    but with agentType: 'non-ad' and the host's hostname so the
  //    center can route into the member-servers touchLastSeen path
  //    (Task 6 of the non-AD plan).
  //
  // 2026-10-01 R158.13 — assign into the module-scope `let heartbeat`
  // slot (line 429) so non-AD heartbeat can be restart()'d when a
  // settingsPatch envelope arrives. Mirror of the AD-runtime patch above.
  heartbeat = startHeartbeat({
    intervalMs: Math.max(1, config.heartbeatIntervalSeconds) * 1000,
    payload: () => ({
      agentId: config.agentId || osInfo.hostname,
      agentVersion: VERSION,
      hostname: config.hostname || osInfo.hostname,
      agentType: 'non-ad',
      pendingQueueSize: 0,
      // 2026-08-21 UX redesign: same contract as AD runtime — see
      // applyAgentTokenDelivery for the response-side handling.
      agent_token_version: Number(config.agentTokenVersion) || 0
    }),
    send: async (p) => {
      const r = await postHeartbeat({
        centerUrl: config.centerUrl,
        agentToken: config.agentToken,
        port: cachedPorts.heartbeatPort,
        // R93.2 — explicit hostname + agentId; payload already has them
        // (line 858-860) but passing them explicitly matches the
        // AD-runtime path and protects against payload-shape regressions.
        hostname: config.hostname || osInfo.hostname,
        agentId: config.agentId || osInfo.hostname,
        payload: p
      });
      await applyAgentTokenDelivery({ result: r, config, configPath, logger });
      // 2026-10-01 R158.13 — non-AD path also consumes settingsPatch;
      // heartbeatRef.current resolves to the live handle (the lazy
      // getter exists at module scope and resolves at the moment a
      // settingsPatch arrives).
      await applySettingsDelivery({ result: r, config, configPath, logger, heartbeat: heartbeatRef.current });
      // R158.48 (2026-10-06) — agent auto-update (non-AD path).
      // Mirror of the AD scheduler call above.
      // R158.50.7e (2026-10-07) — pass agentInstallDir (see line 768
      // R158.50.7e fix rationale; same short-circuit otherwise).
      // R158.88.BF1 (2026-10-13) — non-AD inline caller 跟 AD scheduler inline caller 1:1 平行 SIGTERM. 24h 0 applied 真因 = 两处 inline caller 0 读 r.exiting 0 调 process.kill. setImmediate 让 await chain 干净 return 再死, 跟 upgrade-delivery.js:18 注释 "caller schedules setImmediate" 1:1 闭合.
      const upgradeR2 = await applyUpgradeDelivery({ result: r, agentInstallDir: __dirname, config, configPath, logger, fetchUpgrade: boundFetchUpgrade, fetchUpgradeResult: boundFetchUpgradeResult });
      if (upgradeR2 && upgradeR2.applied === true && upgradeR2.exiting === true) {
        logger?.info?.({ event: 'agent.upgrade.applied.sigterm', toVersion: upgradeR2.newVersion, fromVersion: upgradeR2.previousVersion, runtime: 'non-ad' }, 'agent upgrade applied (non-AD); SIGTERM self for NSSM relaunch');
        setImmediate(() => process.kill(process.pid, 'SIGTERM'));
      }
    }
  });

  // 4. Periodically refresh the cached heartbeat-port override + retry
  //    self-register every 30 minutes (in case the agent started
  //    before center or before DNS).
  const configRefresh = setInterval(async () => {
    await refreshAgentPortsWithRecovery('runtime');
    selfRegister();
  }, 30 * 60_000);

  logger.info({ hostname: osInfo.hostname, centerUrl: config.centerUrl, agentType: 'non-ad' }, 'non-ad agent started');

  const shutdown = async (sig) => {
    logger.info({ sig }, 'non-ad agent shutting down');
    heartbeat.stop();
    // R158.90 — 跟 runAdRuntime line 1014 1:1 平行. clearAllTimers() 跟
    //   clearInterval(packagesRefresh) 都是 pre-R158.90 non-ad-scheduler.js
    //   的产物, 整段 0 用 (无 PackageManager 实例) → 删. shutdown 现在
    //   只关 heartbeat + PackageManager + configRefresh 三件, 跟 AD 1:1.
    if (packageManager) await packageManager.stop();
    clearInterval(configRefresh);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}