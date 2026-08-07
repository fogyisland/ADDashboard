import express from 'express';
import { createApp } from './src/app.js';
import { loadConfigOrNull, defaultConfig, getRegistryUrl } from './src/config.js';
import { init, close, getDb } from './src/db/index.js';
import { createLogger } from './src/logger.js';
import { startServers, closeAll } from './src/multi-port.js';
import { authRouter } from './src/routes/auth.js';
import { agentRouter } from './src/routes/agent.js';
import { dashboardRouter } from './src/routes/dashboard.js';
import { adminRouter } from './src/routes/admin.js';
import { dcsRouter } from './src/routes/dcs.js';
import { lockoutRouter } from './src/routes/lockout.js';
import { schemaMigrationsRouter } from './src/routes/schema-migrations.js';
import { heartbeatReportRouter } from './src/routes/heartbeat-report.js';
import { initRouter } from './src/init/router.js';
import { packageRouter } from './src/packages/router.js';
import { packageRunner } from './src/packages/runner.js';
import { checkNeedsInit } from './src/init/needs-init.js';
import { closeWizardFacade } from './src/init/wizard-facade.js';
import { hasMarker, writeMarker, installPathFromConfigPath } from './src/init/marker.js';
import { userAuth } from './src/auth/user-auth.js';
import { requirePerm } from './src/auth/rbac.js';
import { getConfig as getSystemConfig } from './src/services/config.js';

// Build the three independent Express apps that server.js will run:
//   - webApp:        admin UI, auth, dashboard, init routes (existing scope)
//   - heartbeatApp:  POST /api/agent/heartbeat (light, frequent)
//   - reportApp:     POST /api/agent/report + /discover + GET /config (heavy, sparse)
//
// heartbeat/report are isolated so they can run on separate ports (firewall
// rules, dedicated nginx upstreams). The contract is consumed by Tests 1–3
// (the `mount` parameter on agentRouter gates which routes each app exposes)
// and by the runtime IIFE below which feeds the three apps to startServers.
export function buildServerApps({ config, db, logger, needsInit, systemConfig = {} }) {
  // systemConfig shape: { heartbeat_port, report_port, heartbeat_stale_seconds }
  // — same key naming as the system_config table (Task 1). When the table is
  // unreachable (init mode / db not yet bootstrapped) the caller passes an
  // empty object and we fall back to the documented defaults (8081, 8082).
  const heartbeatPort = Number(systemConfig.heartbeat_port) || 8081;
  const reportPort    = Number(systemConfig.report_port)    || 8082;

  // Web app: createApp gives us healthz + static + SPA fallback + JSON body
  // parsing + the req.log middleware. Routes are mounted below in the IIFE
  // because they need init-mode vs normal-mode branching and auth deps that
  // are only valid after the DB is up.
  const webApp = createApp({ config, db, logger, needsInit });

  // heartbeatApp — small payloads, tight body limit. Only the heartbeat
  // subset of agentRouter is mounted (the `mount` gate from Task 3).
  const heartbeatApp = express();
  heartbeatApp.disable('x-powered-by');
  heartbeatApp.use(express.json({ limit: '256kb' }));
  heartbeatApp.use(agentRouter({ config, logger, mount: 'heartbeat' }));

  // reportApp — replication snapshots can be 10MB+ (12+ rows × long error
  // strings). Only the report subset of agentRouter is mounted.
  const reportApp = express();
  reportApp.disable('x-powered-by');
  reportApp.use(express.json({ limit: '10mb' }));
  reportApp.use(agentRouter({ config, logger, mount: 'report' }));

  return {
    webApp,
    heartbeatApp,
    reportApp,
    ports: {
      web: config.listenPort,
      heartbeat: heartbeatPort,
      report: reportPort
    }
  };
}

const configPath = process.argv[2] || process.env.APPSETTINGS_PATH || './appsettings.json';
const installPath = installPathFromConfigPath(configPath);
const logger = createLogger({ component: 'center', level: 'info' });

// Last-line-of-defense traps for any exception that escapes the (async)
// bootstrap. Without these, an uncaught throw outside the explicit
// IIFE .catch fires Node's default behavior (exit 1, no stderr trace),
// which combined with NSSM restart produces the "ran for <1500ms,
// restart delayed" diagnostic with no visible cause. The logger is
// synchronous (pino destination {dest:2,sync:true}) so the lines below
// land on stderr before process.exit fires.
process.on('uncaughtException', (err, origin) => {
  logger.fatal({ err: err && err.message, stack: err && err.stack, origin }, 'uncaughtException');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.fatal({ err: err.message, stack: err.stack }, 'unhandledRejection');
  process.exit(1);
});

// Main-entry guard. When this module is `import`ed (e.g. by tests calling
// `buildServerApps`) we must NOT fire the runtime IIFE — that would try to
// read appsettings, open a DB, and bind a real port inside the test process
// (with predictably bad consequences). Only run the bootstrap when invoked
// directly via `node server.js [configPath]`. We compare pathToFileURL of
// process.argv[1] against import.meta.url — works on both Windows
// (drive-letter case) and POSIX, and is robust to symlinks.
import { pathToFileURL } from 'node:url';
const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
await ((async () => {
  // Init-complete marker (file + registry) hard-locks the wizard off once
  // /finalize has run. Checked first so an attacker who deletes appsettings.json
  // cannot re-trigger the wizard without also clearing the marker.
  const markerLocked = await hasMarker(installPath);

  let config = loadConfigOrNull(configPath);
  let db = null;
  if (config) {
    // Marker only locks the wizard off; DB still needs to initialize for
    // normal-mode routes to work. If init fails, only fall through to init
    // mode when the wizard is NOT locked (otherwise we'd let an operator
    // recover a broken DB by re-running init, which the marker forbids).
    try {
      await init(config);
      db = getDb();
    } catch (err) {
      logger.warn({ err: err.message }, 'db init failed');
      if (markerLocked) {
        logger.error('db init failed and wizard is locked by marker — refusing to start. To recover: restore db connectivity (preferred) OR clear the marker + appsettings.json to re-run the wizard.');
        process.exit(2);
      }
      logger.warn('falling back to init mode');
      config = null;
      db = null;
    }
  }
  if (markerLocked) logger.info('init marker present; wizard locked out');
  // Refuse to start in normal mode if marker says init is done but config is
  // missing — that's an inconsistent state that would let /api/auth/* crash
  // with "db not initialized". Operator must clear the marker (and restore or
  // rebuild appsettings.json) before the service can run.
  if (markerLocked && !config) {
    logger.error('init marker present but config missing — refusing to start. To recover: restore appsettings.json (preferred) OR clear the ADDASHBOARD_INITIALIZED key in .env + registry value AND delete appsettings.json to re-run the wizard.');
    process.exit(2);
  }
  const needsInit = markerLocked ? false : await checkNeedsInit(db);
  const finalConfig = config ?? defaultConfig();

  // Read multi-port settings from system_config (only in normal mode — the
  // table doesn't exist yet during init). Fall back to {} so the helper
  // resolves the 8081/8082 defaults documented in the spec.
  let systemConfig = {};
  if (!needsInit) {
    try {
      systemConfig = await getSystemConfig();
    } catch (err) {
      logger.warn({ err: err.message }, 'system_config read failed; using port defaults');
    }
  }

  const apps = buildServerApps({ config: finalConfig, db, logger, needsInit, systemConfig });

  const app = apps.webApp;
  // initRouter is mounted in BOTH modes. The /status endpoint is intentionally
  // reachable in normal mode so the frontend router's `beforeEach` can probe
  // init state without 404 noise. Other init routes stay guarded by the
  // router's internal getNeedsInit() check (only /status is always exposed).
  app.use('/api/init', initRouter({ logger, configPath, installPath, getNeedsInit: () => needsInit }));
  if (needsInit) {
    logger.info('init mode: serving /api/init/* and /init');
  } else {
    app.use(authRouter({ config: finalConfig, logger }));
    // Note: agentRouter is intentionally NOT mounted on the web app in normal
    // mode — heartbeat/report traffic now flows through apps.heartbeatApp /
    // apps.reportApp which are bound to dedicated ports. The webApp keeps
    // every other admin-facing route below.
    app.use(dashboardRouter({ config: finalConfig, logger }));
    app.use(adminRouter({ config: finalConfig, logger }));
    // DC summary endpoint (Task 4). Mirrors the adminRouter's per-route
    // [userAuth, requirePerm('admin:users')] middleware — the router
    // factory accepts the same auth deps so the per-route chain is
    // identical to other admin read endpoints.
    app.use(dcsRouter({
      requireAuth: userAuth({ secret: finalConfig.jwtSecret }),
      requirePerm: (perm) => requirePerm(perm)
    }));
    // Lockout troubleshooting — multi-filter search across ad_lockout_events.
    // Same auth contract as dcsRouter: per-route [userAuth, requirePerm('admin:users')].
    app.use(lockoutRouter({
      requireAuth: userAuth({ secret: finalConfig.jwtSecret }),
      requirePerm: (perm) => requirePerm(perm)
    }));
    // Schema migrations admin (list/apply/dry-run/reset). Same auth contract
    // as dcsRouter and lockoutRouter: per-route [userAuth, requirePerm('admin:users')].
    app.use(schemaMigrationsRouter({
      requireAuth: userAuth({ secret: finalConfig.jwtSecret }),
      requirePerm: (perm) => requirePerm(perm),
      logger,
      getRepoRoot: () => process.cwd()
    }));
    // Heartbeat/Report admin aggregator (Task 6). Read-only per-agent view
    // joining ad_agent_heartbeat with the latest ad_replication_status
    // snapshot. Same auth contract as the other admin read endpoints above.
    app.use(heartbeatReportRouter({
      requireAuth: userAuth({ secret: finalConfig.jwtSecret }),
      requirePerm: (perm) => requirePerm(perm)
    }));
    // Package system routes (Task 6). Both routers apply their own
    // per-route auth (userAuth+requirePerm for admin, agentToken for
    // agent) — Express does not propagate per-route middleware from a
    // sibling Router, so we wire the auth inside each package router
    // factory and pass the config through.
    const pkgDb = getDb();
    app.use(packageRouter({
      db: pkgDb,
      getLogger: () => logger,
      getRegistryUrl,
      config: finalConfig
    }));
    app.use(packageRunner({
      db: pkgDb,
      getLogger: () => logger,
      config: finalConfig
    }));
  }

  if (needsInit) {
    // Init mode: the wizard owns the web port. heartbeat/report servers are
    // NOT started — the spec explicitly says agents shouldn't be talking to
    // a half-bootstrapped center, and there's no DB yet to ingest into.
    const server = apps.webApp.listen(finalConfig.listenPort, () => {
      logger.info({ port: finalConfig.listenPort, needsInit }, 'center listening (init mode)');
    });
    const shutdown = async (sig) => {
      logger.info({ sig }, 'shutting down');
      server.close(async () => {
        try { await closeWizardFacade(); } catch {}
        try { await close(); } catch {}
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10000).unref();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } else {
    // Normal mode: three concurrent servers. startServers dedupes by port
    // (the spec says overlapping ports collapse to one server, first wins),
    // so a misconfigured triple-with-same-port falls back to single-server
    // behavior without throwing — matches the documented contract.
    const servers = await startServers({
      logger,
      roleAppPortList: [
        { role: 'web',       app: apps.webApp,       port: apps.ports.web },
        { role: 'heartbeat', app: apps.heartbeatApp, port: apps.ports.heartbeat },
        { role: 'report',    app: apps.reportApp,    port: apps.ports.report }
      ]
    });
    const shutdown = async (sig) => {
      logger.info({ sig }, 'shutting down');
      await closeAll(servers, logger);
      try { await closeWizardFacade(); } catch {}
      try { await close(); } catch {}
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }
})().catch(err => {
  logger.error({ err: err.message }, 'fatal');
  process.exit(1);
}));
} // end if (invokedDirectly)
