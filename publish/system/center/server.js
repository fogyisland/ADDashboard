import express from 'express';
import { createApp } from './src/app.js';
import { loadConfigOrNull, defaultConfig, getRegistryUrl, seedListenPortIfMissing, getListenPort, sha256Hex } from './src/config.js';
import { healthzRouter } from './src/routes/healthz.js';
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
import { createProbeLoop } from './src/services/probe.js';
import { createAlertEvaluationLoop } from './src/services/alert-engine.js';
import { createEmailDeliveryLoop } from './src/services/email.js';
import { createAuditRetentionLoop } from './src/services/audit.js';
import { initRouter } from './src/init/router.js';
import { packageRouter } from './src/packages/router.js';
import { orphanRouter } from './src/packages/orphan-router.js';
import { packageRunner } from './src/packages/runner.js';
import { memberRouter } from './src/routes/member-servers.js';
import { agentPackagesRouter } from './src/routes/agent-packages.js';
import { checkNeedsInit } from './src/init/needs-init.js';
import { closeWizardFacade } from './src/init/wizard-facade.js';
import { hasMarker, writeMarker, installPathFromConfigPath } from './src/init/marker.js';
import { userAuth } from './src/auth/user-auth.js';
import { requirePerm } from './src/auth/rbac.js';
import { getConfig as getSystemConfig, getConfigMap, seedSmtpDefaultsIfMissing } from './src/services/config.js';
import { writeAudit } from './src/services/audit.js';
import { seedBuiltinPackages } from './src/services/builtin-packages.js';

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
  // /healthz must be reachable on all three apps (web/heartbeat/report) so
  // an external monitor (k8s liveness probe, LB health check) can hit any
  // of the three ports and get the same DB-aware status. healthz is an
  // unauthenticated GET, so order doesn't matter — mount before
  // agentRouter so it's first-match.
  heartbeatApp.use(healthzRouter());
  heartbeatApp.use(agentRouter({ config, logger, mount: 'heartbeat' }));

  // reportApp — replication snapshots can be 10MB+ (12+ rows × long error
  // strings). Only the report subset of agentRouter is mounted.
  const reportApp = express();
  reportApp.disable('x-powered-by');
  reportApp.use(express.json({ limit: '10mb' }));
  reportApp.use(healthzRouter());
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
import { pathToFileURL, fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

// ESM has no __dirname — derive it from this file's URL so we can locate
// sibling directories (publish/ in particular, for the built-in package
// seed). Used by the seedBuiltinPackages call below.
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = dirname(__dirname);

// Locate the built-in package source from either the source-tree view
// (cwd=center, __dirname=repo/center) or the bundled publish view
// (cwd=publish, __dirname=publish/system/center). The bundled view puts
// the package source alongside the script; the source view walks up to
// the repo root then descends into publish/system/. Both layouts are
// tried so the same server.js works whether launched via `npm start`
// (cwd=repo-root), `cd center && node server.js` (cwd=center), or from
// the bundled publish/system/center/server.js.
const builtinSourceCandidates = [
  join(repoRoot, 'publish', 'system', 'center', 'data', 'packages'),
  join(__dirname, 'data', 'packages')
];
const resolveBuiltinSourceDir = () => {
  const found = builtinSourceCandidates.find(d => existsSync(d));
  if (!found) throw new Error(`seedBuiltinPackages: source not found in any candidate: ${builtinSourceCandidates.join(', ')}`);
  return found;
};

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

  // Seed listenPort into system_config on first boot, then write the
  // started_version hash so the UI's restart badge can compare pending vs
  // started. Done BEFORE buildServerApps so the value is on disk by the
  // time anything that depends on it (probe service in Task 3) reads it.
  // Idempotent: re-running writes the same hash, no audit row, no side-effects.
  if (!needsInit && db) {
    try {
      await seedListenPortIfMissing(logger);
      const listenPort = await getListenPort();
      const startedVersion = sha256Hex(`${new Date().toISOString()}:${listenPort}`);
      await db.execute(
        db.sql.config.upsert,
        ['center_listen_port_started_version', startedVersion]
      );
      logger.info({ listenPort, startedVersion }, 'center listenPort bound');
    } catch (err) {
      logger.warn({ err: err.message }, 'listenPort seed/version write failed; continuing with appsettings.json value');
    }
    // Seed SMTP + alert-engine defaults (Task 12). Idempotent — only writes
    // rows that are absent. Done in the same normal-mode gate as the
    // listenPort seed so the rows exist before the alert/email loops boot.
    try {
      await seedSmtpDefaultsIfMissing(logger);
    } catch (err) {
      logger.warn({ err: err.message }, 'SMTP defaults seed failed; alerts may be misconfigured');
    }
  }

  // Seed built-in packages (e.g. ad_os_baseline) into data/packages/<name>/<version>/
  // on first normal-mode start. Runs after listenPort seed (same normal-mode
  // gate `!needsInit && db`) and BEFORE buildServerApps so the agent package
  // runner can read the cached collect.ps1 from the same path it uses for
  // downloaded packages. Idempotent: skips if <dataDir>/<name>/<version>/manifest.json
  // already exists. Source is bundled at publish/center/data/packages/ — that
  // mirror is maintained by the mirror script (publish/build) so this seeder
  // stays consistent with what gets shipped in publish.zip.
  if (!needsInit && db) {
    try {
      await seedBuiltinPackages({
        dataDir: process.cwd() + '/data/packages',
        sourceDir: resolveBuiltinSourceDir(),
        writeAudit
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'built-in package seed failed; non-AD package runner will skip until next restart');
    }
  }

  const apps = buildServerApps({ config: finalConfig, db, logger, needsInit, systemConfig });

  // Declared at module scope so the normal-mode bootstrap below can assign
  // it and the normal-mode shutdown handler can stop it. The init-mode
  // branch never starts a probe loop (no DB) and so leaves this as null.
  let probeLoop = null;

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
    // Bootstrap endpoint for agents (web mount — /config.json only). Lets an
    // agent learn heartbeat/report ports + intervals from the web port
    // without needing to know any other port number up front. The dedicated
    // heartbeatApp / reportApp carry the bulk of agent traffic; web just
    // exposes the bootstrap config the agent reads on startup and on
    // periodic config-refresh ticks.
    app.use(agentRouter({ config: finalConfig, logger, mount: 'web' }));
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
      getRepoRoot: () => repoRoot
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
    app.use(orphanRouter({
      db: pkgDb,
      config: finalConfig
    }));
    app.use(packageRunner({
      db: pkgDb,
      getLogger: () => logger,
      config: finalConfig
    }));
    // Member-server admin routes (Task 6): non-AD inventory CRUD, per-host
    // package bind, and the agent-token self-register endpoint. Lives in a
    // dedicated memberRouter per the no-cross-pollination rule with DC
    // agent routes. Mounted on webApp only — heartbeat/report apps stay
    // focused on DC traffic.
    app.use(memberRouter({
      config: finalConfig,
      logger
    }));
    // Agent-facing per-host package list (Task 8: spec §4.3 / global
    // constraint #14). Sits on the web app so non-AD agents hitting
    // /api/admin/agent/packages-for-host?hostname=... on heartbeat get the
    // merged view of global installed_packages + per-host
    // ad_member_server_packages. Backed by agentToken (NOT userAuth) — the
    // agent has no JWT, only the agent_token from appsettings.json.
    app.use(agentPackagesRouter({
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
    // Start the 1 Hz self-probe loop now that all three ports are listening.
    // probe_state is owned by migration 012 (Task 1); the loop will surface
    // a clear error and halt if the table is missing.
    probeLoop = createProbeLoop({
      db: getDb(),
      ports: apps.ports,
      logger,
      writeAudit
    });
    probeLoop.start();

    // AlertEvaluationLoop + EmailDeliveryLoop (Task 11). Both follow the
    // createProbeLoop factory shape (Global Constraint #8): start() schedules
    // a setInterval with an inFlight guard; tick() runs one evaluation pass;
    // stop() clears the interval and waits for the in-flight tick so
    // shutdown can't strand a half-written transaction. Both are mounted
    // AFTER probeLoop because they depend on alert_metrics and outbox tables
    // (migration 014) being live — probeLoop has no such dependency.
    // The 10-second floor (Global Constraint #9) is enforced inside the
    // factory's tick() so the cadence clamp survives caller misconfiguration.
    const alertLoop = createAlertEvaluationLoop({
      db: getDb(),
      getIntervalSeconds: async () => {
        const v = await getSystemConfig();
        return Number(v.alert_eval_interval_seconds) || 60;
      },
      getSystemConfig,
      logger
    });
    const emailLoop = createEmailDeliveryLoop({
      db: getDb(),
      getIntervalSeconds: async () => {
        const v = await getSystemConfig();
        return Number(v.alert_eval_interval_seconds) || 60;
      },
      // Pass getConfigMap (unmasked) so the loop can hand the real
      // smtp_password to nodemailer when authenticating. getSystemConfig is
      // masked on read; using it here would silently authenticate with
      // '********' once the test-mail route bypass is unified with the
      // canonical system_config reader (see T12 fix1 I-4).
      getSystemConfig: getConfigMap
    });
    alertLoop.start();
    emailLoop.start();
    // AuditRetentionLoop (Task #166 / I4). Reads audit_retention_days from
    // system_config on each tick so operators can change retention policy
    // without restarting. Hard-coded 1-hour cadence — coarse-grained
    // background job, no per-tick interval knob. Wired AFTER emailLoop
    // because purgeOldAuditLogs depends on audit_logs (migration 013+) being
    // live; same dependency class as the alert/email loops.
    const auditRetentionLoop = createAuditRetentionLoop({
      getSystemConfig,
      logger
    });
    auditRetentionLoop.start();
    // Bootstrap watchdog: 30 s after startup, if no probe write has landed
    // (all rows still stale or uninitialized), emit a one-shot audit warning
    // so the operator can see in the audit log that the loop is wedged. The
    // .unref() prevents this timer from keeping the process alive during
    // shutdown.
    setTimeout(() => {
      getDb().query(getDb().sql.probeState.getAll).then(({ rows }) => {
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
    const shutdown = async (sig) => {
      logger.info({ sig }, 'shutting down');
      try { await probeLoop.stop(); } catch (e) { logger.warn({ err: e.message }, 'probe stop failed'); }
      try { await alertLoop.stop(); } catch (e) { logger.warn({ err: e.message }, 'alert loop stop failed'); }
      try { await emailLoop.stop(); } catch (e) { logger.warn({ err: e.message }, 'email loop stop failed'); }
      try { await auditRetentionLoop.stop(); } catch (e) { logger.warn({ err: e.message }, 'audit retention loop stop failed'); }
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
