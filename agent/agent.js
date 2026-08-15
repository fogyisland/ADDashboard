import { loadConfig } from './src/config.js';
import { createLogger } from './src/logger.js';
import { runCollector } from './src/collector.js';
import { postReport, postHeartbeat, fetchConfig } from './src/reporter.js';
import { startHeartbeat } from './src/heartbeat.js';
import { runDiscovery, postDiscovery, startDiscoveryScheduler } from './src/discovery.js';
import { runHealthChecks } from './src/healthcheck.js';
import { fetchPortList } from './src/port-config-fetcher.js';
import { openQueue } from './src/local-queue.js';
import { createScheduler } from './src/scheduler.js';
import { PackageManager } from './src/package-manager.js';
import { requestJson } from './src/reporter.js';
import { getOsInfo } from './src/os-info.js';
import { discoverCenterPort } from './src/port-scanner.js';
import { writeCenterUrlAtomic } from './src/appsettings-writer.js';
import {
  applyPackageList,
  clearAllTimers
} from './src/non-ad-scheduler.js';
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

  // Custom-port health probe state. `cachedPortList` is the latest copy of the
  // admin-defined /api/agent/ports list (refreshed on the healthcheck cadence);
  // `latestPortResults` is the most recent probe output, attached to the
  // heartbeat payload when non-empty. Both are mutable cache slots updated by
  // `refreshPortList()` and `runHealth` respectively.
  let cachedPortList = [];
  let latestPortResults = [];
  async function refreshPortList() {
    cachedPortList = await fetchPortList(config.centerUrl, config.agentToken);
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
    dataDir: config.agentDataDir,
    logger,
    powerShellPath: config.powerShellPath
  });

  const heartbeat = startHeartbeat({
    intervalMs: Math.max(1, config.heartbeatIntervalSeconds) * 1000,
    payload: () => {
      const p = { agentId: config.agentId, agentVersion: VERSION, pendingQueueSize: queue.count() };
      if (Array.isArray(latestPortResults) && latestPortResults.length > 0) {
        p.ports = latestPortResults.map(x => ({ port: x.port, ok: x.ok, latencyMs: x.latencyMs }));
      }
      p.packages = {
        installed: packageManager.listLocal(),
        pending: packageManager.reportBatch.length + packageManager.queue.length
      };
      return p;
    },
    send: async (p) => {
      await postHeartbeat({
        centerUrl: config.centerUrl,
        agentToken: config.agentToken,
        port: cachedPorts.heartbeatPort,
        payload: p
      });
    }
  });

  // Site/DCs topology discovery. Runs the PowerShell topology script on a long
  // interval (default 4h) and posts the result to the center's discover endpoint.
  const discovery = startDiscoveryScheduler({
    intervalHours: config.discoveryIntervalHours,
    run: async () => {
      const snap = await runDiscovery({
        powerShellPath: config.powerShellPath,
        psDiscoveryScriptPath: config.psDiscoveryScriptPath
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
    collect: () => runCollector({ powerShellPath: config.powerShellPath, psScriptPath: config.psScriptPath }),
    send: (snap) => postReport({
      centerUrl: config.centerUrl,
      agentToken: config.agentToken,
      port: cachedPorts.reportPort,
      snapshot: snap
    }),
    sendHeartbeat: (extra) => {
      const payload = { agentId: config.agentId, agentVersion: VERSION, ...extra };
      if (Array.isArray(latestPortResults) && latestPortResults.length > 0) {
        payload.ports = latestPortResults.map(x => ({ port: x.port, ok: x.ok, latencyMs: x.latencyMs }));
      }
      return postHeartbeat({
        centerUrl: config.centerUrl,
        agentToken: config.agentToken,
        port: cachedPorts.heartbeatPort,
        payload
      });
    },
    runHealth: async () => {
      await refreshPortList();
      const r = await runHealthChecks({
        centerUrl: config.centerUrl,
        agentToken: config.agentToken,
        hostname: config.agentId,
        heartbeatPort: cachedPorts.heartbeatPort,
        ports: cachedPortList.map(p => p.port)
      });
      if (Array.isArray(r.ports)) latestPortResults = r.ports;
      return r;
    }
  });

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
  const osInfo = getOsInfo();

  // 1. Self-register once on boot. The endpoint is idempotent (upsert
  //    discovered_via='self-register'), so it's safe to retry on transient
  //    failures. Fire-and-forget with a logger breadcrumb so a center
  //    outage at boot doesn't block the heartbeat from coming up.
  async function selfRegister() {
    const r = await requestJson({
      method: 'POST',
      url: `${config.centerUrl}/api/admin/member-servers/self-register`,
      headers: { 'X-Agent-Token': config.agentToken },
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
        return requestJson({
          method: 'POST',
          url: `${config.centerUrl}/api/admin/agent/packages/report`,
          headers: { 'X-Agent-Token': config.agentToken },
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
    const r = await requestJson({
      method: 'GET',
      url: `${config.centerUrl}/api/admin/agent/packages-for-host?hostname=${encodeURIComponent(hostname)}`,
      headers: { 'X-Agent-Token': config.agentToken },
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
      pendingQueueSize: 0
    }),
    send: (p) => postHeartbeat({
      centerUrl: config.centerUrl,
      agentToken: config.agentToken,
      port: cachedPorts.heartbeatPort,
      payload: p
    })
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