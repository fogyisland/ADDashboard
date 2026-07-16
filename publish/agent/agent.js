import { loadConfig } from './src/config.js';
import { createLogger } from './src/logger.js';
import { runCollector } from './src/collector.js';
import { postReport, postHeartbeat, fetchConfig } from './src/reporter.js';
import { startHeartbeat } from './src/heartbeat.js';
import { runDiscovery, postDiscovery, startDiscoveryScheduler } from './src/discovery.js';
import { runHealthChecks } from './src/healthcheck.js';
import { openQueue } from './src/local-queue.js';
import { createScheduler } from './src/scheduler.js';

const configPath = process.argv[2] || process.env.APPSETTINGS_PATH || './appsettings.json';
const config = loadConfig(configPath);
const logger = createLogger({ component: 'agent', level: config.logLevel });

const queue = openQueue(config.queueDbPath);

// Standalone liveness heartbeat. Interval is read from config at startup;
// changing it via center config requires restarting the agent process — same
// trade-off as pollingIntervalMinutes. The scheduler ALSO sends heartbeats
// after each collect cycle — they overlap intentionally so the center sees
// liveness even when collect cycles are hours apart.
const heartbeat = startHeartbeat({
  intervalMs: Math.max(1, config.heartbeatIntervalSeconds) * 1000,
  payload: () => ({ agentId: config.agentId, agentVersion: '0.1.0', pendingQueueSize: queue.count() }),
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
  sendHeartbeat: (extra) => postHeartbeat({
    centerUrl: config.centerUrl,
    agentToken: config.agentToken,
    payload: { agentId: config.agentId, agentVersion: '0.1.0', ...extra }
  }),
  runHealth: () => runHealthChecks({ centerUrl: config.centerUrl, agentToken: config.agentToken, hostname: config.agentId })
});

scheduler.start();
logger.info({ agentId: config.agentId, centerUrl: config.centerUrl }, 'agent started');

const shutdown = async (sig) => {
  logger.info({ sig }, 'shutting down');
  heartbeat.stop();
  discovery.stop();
  clearInterval(configRefresh);
  await scheduler.stop();
  queue.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
