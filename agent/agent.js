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
import { discoverCenterPort } from './src/port-scanner.js';
import { writeCenterUrlAtomic } from './src/appsettings-writer.js';
import { applyAgentTokenDelivery } from './src/agent-token-delivery.js';
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
import {
  applyPackageList,
  clearAllTimers
} from './src/non-ad-scheduler.js';
import http from 'node:http';
import https from 'node:https';
import { URL as NodeURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join as joinPath } from 'node:path';

const VERSION = '0.1.0';

// Default appsettings.json lives next to this script so the agent works
// regardless of cwd. argv[2] and APPSETTINGS_PATH still win when provided.
const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = joinPath(__dirname, 'appsettings.json');
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

// Spec §4 row 204: single-flight guard so two concurrent triggers
// (e.g. boot + first configRefresh tick) don't race on the same
// appsettings.json + .tmp file. Second caller awaits the first.
let inFlightRecovery = null;

async function tryRecoverCenterPort({ config, configPath, logger, trigger }) {
  if (inFlightRecovery) return inFlightRecovery;
  inFlightRecovery = (async () => {
    try {
      return await _tryRecoverCenterPortImpl({ config, configPath, logger, trigger });
    } finally {
      inFlightRecovery = null;
    }
  })();
  return inFlightRecovery;
}

async function _tryRecoverCenterPortImpl({ config, configPath, logger, trigger }) {
  const r = await fetchConfig({ centerUrl: config.centerUrl, agentToken: config.agentToken });
  if (r.ok) return { ok: true, recovered: false };

  // fetchConfig failed. Decide whether to scan based on trigger + config flags.
  const enabled = trigger === 'boot' ? config.scanOnBoot : config.scanOnRuntimeFail;
  if (!enabled) {
    logger.warn({ trigger, centerUrl: config.centerUrl }, 'fetchConfig failed; scan disabled by config');
    return { ok: false, recovered: false };
  }

  const host = deriveScanHost(config);
  // 2026-09-22 S82 — stamp (hostname, agentId) into the probe signature
  // so the centre accepts the GET after the 60s restart-grace window.
  const scan = await discoverCenterPort({
    host, agentToken: config.agentToken,
    hostname: config.hostname || osInfo.hostname,
    agentId: config.agentId,
    logger
  });
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
  async function refreshPortList() {
    // 2026-09-22 S82 — stamp (hostname, agentId) so the centre accepts
    // GET /api/agent/ports after the 60s restart-grace window.
    cachedPortList = await fetchPortList(
      config.centerUrl, config.agentToken,
      { hostname: config.hostname || osInfo.hostname, agentId: config.agentId }
    );
  }
  // Initial refresh on startup, before any heartbeat fires.
  await refreshPortList();

  // Center-configured heartbeat / report ports. Refreshed every 5min alongside
  // the existing config refresh; null = no override (use centerUrl verbatim).
  let cachedPorts = { heartbeatPort: null, reportPort: null };

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

  const packageManager = new PackageManager({
    agentId: config.agentId,
    agentVersion: VERSION,
    centerBaseUrl: config.centerUrl,
    agentToken: config.agentToken,
    hostname: config.hostname || osInfo.hostname,
    dataDir: config.agentDataDir,
    logger,
    powerShellPath: config.powerShellPath
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
  const getDiscovery = () => discoveryRef;

  const send = makeSendCallback({
    postHeartbeat: (payload) => postHeartbeat({
      centerUrl: config.centerUrl,
      agentToken: config.agentToken,
      port: cachedPorts.heartbeatPort,
      payload
    }),
    applyAgentTokenDelivery: ({ result }) => applyAgentTokenDelivery({
      result, config, configPath, logger
    }),
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

  const buildPayload = makePayload({ getPendingClear, setPendingClear });

  const heartbeat = startHeartbeat({
    intervalMs: Math.max(1, config.heartbeatIntervalSeconds) * 1000,
    payload: () => {
      const p = {
        agentId: config.agentId,
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

  // Site/DCs topology discovery. Runs the PowerShell topology script on a long
  // interval (default 4h) and posts the result to the center's discover endpoint.
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
      snapshot: snap
    }),
    sendHeartbeat: (extra) => {
      const payload = {
        agentId: config.agentId,
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
        payload
      }).then(async (r) => {
        await applyAgentTokenDelivery({ result: r, config, configPath, logger });
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
        ipAddress: osInfo.ip
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

  // Local cache of which packages are currently scheduled. The center is
  // the source of truth; on every poll we diff against the previously-
  // scheduled set and (re)start / stop timers accordingly. The map + the
  // timer-scheduling functions live in src/non-ad-scheduler.js so unit
  // tests can import the SAME functions the runtime uses — no re-statement,
  // no drift — and assert handle stability across polls (regression test
  // for the timer-starvation bug where unconditional clearInterval on every
  // 5-minute poll reset the countdown for any package whose intervalSec was
  // >= 300, so it never fired).
  function runPackage(pkg) {
    // v1 contract: /api/admin/agent/packages-for-host returns parsed
    // manifests WITHOUT a top-level scriptPath — the agent is expected to
    // derive it from a local cache directory once package materialization
    // is wired. v1 has no materialization path, so we skip-and-log when
    // scriptPath is missing rather than crashing spawn() with undefined.
    // v2 contract (future task): derive scriptPath =
    //   join(config.agentDataDir, 'packages', pkg.name, pkg.version, 'collect.ps1').
    if (!pkg.scriptPath) {
      logger.debug({ name: pkg.name }, 'non-ad package: scriptPath not yet materialized, skipping');
      return;
    }
    // Fire-and-forget; errors logged inside runPackageScript.
    import('./src/package-runner.js').then(({ runPackageScript }) => {
      runPackageScript({
        scriptPath: pkg.scriptPath,
        params: pkg.params || {},
        timeoutMs: pkg.agent?.timeoutMs || 30_000,
        logger,
        powerShellPath: config.powerShellPath
      }).then((result) => {
        // Best-effort report POST; failures are dropped (no on-disk
        // queue for non-AD in v1 — packages are heartbeat-lightweight
        // metrics, not critical replication data).
        //
        // 2026-09-24 R91.4 — packages/report is behind agentMw + S82,
        // so stamp the (hostname, agentId, body) signature like the rest
        // of the centre-facing POSTs.
        return signedRequestJson({
          method: 'POST',
          url: `${config.centerUrl}/api/admin/agent/packages/report`,
          agentToken: config.agentToken,
          hostname: config.hostname || osInfo.hostname,
          agentId: config.agentId,
          body: {
            runs: [{
              packageName: pkg.name,
              hostname: config.hostname || osInfo.hostname,
              ...result
            }]
          },
          timeoutMs: 30_000
        });
      }).catch((e) => {
        logger.warn({ err: e.message, name: pkg.name }, 'non-ad package run failed');
      });
    }).catch((e) => {
      logger.warn({ err: e.message, name: pkg.name }, 'non-ad package runner import failed');
    });
  }

  async function pollPackages() {
    const hostname = config.hostname || osInfo.hostname;
    // 2026-09-24 R91.4 — packages-for-host is behind agentMw + S82.
    // Without X-Agent-Signature it 401s after the 60s grace window,
    // so non-AD agents stop receiving their package manifest and
    // never run anything. Switched to signedRequestJson so the GET
    // (no body) gets the proper empty-body signature.
    const r = await signedRequestJson({
      method: 'GET',
      url: `${config.centerUrl}/api/admin/agent/packages-for-host?hostname=${encodeURIComponent(hostname)}`,
      agentToken: config.agentToken,
      hostname,
      agentId: config.agentId,
      timeoutMs: 30_000
    });
    if (!r.ok) {
      logger.warn({ status: r.status, error: r.error }, 'non-ad packages-for-host poll failed');
      return;
    }
    const items = Array.isArray(r.data?.items) ? r.data.items : [];
    applyPackageList(items, runPackage);
  }

  // Initial poll + periodic refresh (every 5 minutes, same cadence as the
  // AD runtime's configRefresh). The first poll may race with the
  // self-register fire-and-forget above; that's fine — center tolerates
  // a package poll from an unknown hostname (returns empty list).
  pollPackages();
  const packagesRefresh = setInterval(() => {
    pollPackages().catch((e) => logger.warn({ err: e.message }, 'non-ad packages poll crashed'));
  }, 5 * 60_000);

  // 3. Heartbeat loop. Same /api/agent/heartbeat endpoint as the AD flow,
  //    but with agentType: 'non-ad' and the host's hostname so the
  //    center can route into the member-servers touchLastSeen path
  //    (Task 6 of the non-AD plan).
  const heartbeat = startHeartbeat({
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
        payload: p
      });
      await applyAgentTokenDelivery({ result: r, config, configPath, logger });
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
    clearAllTimers();
    clearInterval(packagesRefresh);
    clearInterval(configRefresh);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}