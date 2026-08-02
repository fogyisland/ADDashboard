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

const configPath = process.argv[2] || process.env.APPSETTINGS_PATH || './appsettings.json';
const config = loadConfig(configPath);
const logger = createLogger({ component: 'agent', level: config.logLevel });

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

// Standalone liveness heartbeat. Interval is read from config at startup;
// changing it via center config requires restarting the agent process — same
// trade-off as pollingIntervalMinutes. The scheduler ALSO sends heartbeats
// after each collect cycle — they overlap intentionally so the center sees
// liveness even when collect cycles are hours apart.
// Constructed after `config` is loaded and the queue exists. Mirrors the
// discovery-scheduler pattern: declare here, start() after scheduler.start(),
// stop() in shutdown(). Initialised with dataDir from config so the package
// cache and persisted report queue live under the agent's data directory.
const packageManager = new PackageManager({
  agentId: config.agentId,
  agentVersion: '0.1.0',
  centerBaseUrl: config.centerUrl,
  agentToken: config.agentToken,
  dataDir: config.agentDataDir,
  logger
});

const heartbeat = startHeartbeat({
  intervalMs: Math.max(1, config.heartbeatIntervalSeconds) * 1000,
  payload: () => {
    const p = { agentId: config.agentId, agentVersion: '0.1.0', pendingQueueSize: queue.count() };
    if (Array.isArray(latestPortResults) && latestPortResults.length > 0) {
      p.ports = latestPortResults.map(x => ({ port: x.port, ok: x.ok, latencyMs: x.latencyMs }));
    }
    p.packages = {
      installed: packageManager.listLocal(),
      pending: packageManager.reportBatch.length + packageManager.queue.length
    };
    return p;
  },
  send: async (p) => { await postHeartbeat({ centerUrl: config.centerUrl, agentToken: config.agentToken, payload: p }); }
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
  send: (snap) => postReport({ centerUrl: config.centerUrl, agentToken: config.agentToken, snapshot: snap }),
  sendHeartbeat: (extra) => {
    const payload = { agentId: config.agentId, agentVersion: '0.1.0', ...extra };
    if (Array.isArray(latestPortResults) && latestPortResults.length > 0) {
      payload.ports = latestPortResults.map(x => ({ port: x.port, ok: x.ok, latencyMs: x.latencyMs }));
    }
    return postHeartbeat({
      centerUrl: config.centerUrl,
      agentToken: config.agentToken,
      payload
    });
  },
  runHealth: async () => {
    await refreshPortList();
    const r = await runHealthChecks({
      centerUrl: config.centerUrl,
      agentToken: config.agentToken,
      hostname: config.agentId,
      ports: cachedPortList.map(p => p.port)
    });
    if (Array.isArray(r.ports)) latestPortResults = r.ports;
    return r;
  }
});

scheduler.start();
packageManager.start();
logger.info({ agentId: config.agentId, centerUrl: config.centerUrl }, 'agent started');

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
