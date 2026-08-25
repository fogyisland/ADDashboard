import express from 'express';
import { createApp } from './src/app.js';
import { loadConfigOrNull, defaultConfig, getRegistryUrl, seedListenPortIfMissing, getListenPort, sha256Hex } from './src/config.js';
import { healthzRouter } from './src/routes/healthz.js';
import { init, close, getDb } from './src/db/index.js';
import { createLogger, createRotatedLogger } from './src/logger.js';
import { startServers, closeAll } from './src/multi-port.js';
import { authRouter } from './src/routes/auth.js';
import { agentRouter } from './src/routes/agent.js';
import { dashboardRouter } from './src/routes/dashboard.js';
import { adminRouter } from './src/routes/admin.js';
import { dcsRouter } from './src/routes/dcs.js';
import { lockoutRouter } from './src/routes/lockout.js';
import { schemaMigrationsRouter } from './src/routes/schema-migrations.js';
import { heartbeatReportRouter } from './src/routes/heartbeat-report.js';
import { systemRouter } from './src/routes/system.js';
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
  // agentRouter factory calls getDb() eagerly to construct the agentToken
  // middleware. In init mode db is null → throw → bubbles up to the IIFE
  // .catch → process.exit → NSSM restart loop. heartbeatApp isn't listened
  // in init mode anyway (see the `if (needsInit)` branch in the IIFE), so
  // just skip the agentRouter mount there.
  if (!needsInit) {
    heartbeatApp.use(agentRouter({ config, logger, mount: 'heartbeat' }));
  }

  // reportApp — replication snapshots can be 10MB+ (12+ rows × long error
  // strings). Only the report subset of agentRouter is mounted.
  const reportApp = express();
  reportApp.disable('x-powered-by');
  reportApp.use(express.json({ limit: '10mb' }));
  reportApp.use(healthzRouter());
  if (!needsInit) {
    reportApp.use(agentRouter({ config, logger, mount: 'report' }));
  }

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

// Fatal-trap registration MUST happen synchronously at module load so that
// tests that mock `process.on` (see init-mode-survival.test.js) see the
// uncaughtException / unhandledRejection listeners immediately on import.
// The bootstrap below installs the rotated logger into these traps via
// setFatalLogger — until that happens, the traps use the sync stderr
// fallback (same destination the previous module-top-level logger used).
// Without this split, the tests' `await import('...')` would race the
// bootstrap's `await createRotatedLogger(...)` and the listeners would
// appear missing.
const fatalState = { logger: null };
function setFatalLogger(logger) { fatalState.logger = logger; }
process.on('uncaughtException', (err, origin) => {
  const log = fatalState.logger || createLogger({ component: 'center', level: 'info' });
  if (err && err.message && err.message.startsWith('db not initialized')) {
    log.warn({ err: err.message, origin }, 'init-mode uncaughtException (kept alive)');
    return;
  }
  log.fatal({ err: err && err.message, stack: err && err.stack, origin }, 'uncaughtException');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const log = fatalState.logger || createLogger({ component: 'center', level: 'info' });
  const err = reason instanceof Error ? reason : new Error(String(reason));
  if (err.message && err.message.startsWith('db not initialized')) {
    log.warn({ err: err.message }, 'init-mode unhandledRejection (kept alive)');
    return;
  }
  log.fatal({ err: err.message, stack: err.stack }, 'unhandledRejection');
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
  // Create the rotated-file logger FIRST — every subsequent log line
  // (bootstrap progress, runtime diagnostics, fatal traps) lands in
  // <installPath>/logs/center.log via pino-roll's daily rotation. Sync
  // SonicBoom writes preserve the "fatal line survives process.exit()"
  // guarantee the previous stderr logger had. See src/logger.js for the
  // full rationale; NSSM AppStderr must be cleared by the installer so
  // pino-roll is the sole writer of this file (see install-center.ps1).
  const logFile = process.env.ADDASHBOARD_LOG_FILE
      || join(installPath, 'logs', 'center.log');
  const logger = await createRotatedLogger({
    component: 'center',
    level: 'info',
    file: logFile
  });

  // Hand the rotated logger to the fatal-trap handlers that were registered
  // synchronously at module load (above). Until this point the traps used
  // a sync stderr fallback — the file-open side effect of createRotatedLogger
  // must not run during import (tests import buildServerApps from this
  // module and need zero file-open side effects). The handlers keep the
  // same behavior either way (sync destination + process.exit), so this
  // handoff is invisible to the rest of the system.
  setFatalLogger(logger);
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

  // Auto-apply pending DB migrations on every normal-mode startup. Runs
  // BEFORE buildServerApps so routes that reference newly-added columns
  // (e.g. ad_agent_heartbeat.report_requested_at from migration 018) see
  // the schema they expect. Idempotent — already-applied migrations are
  // skipped in one cheap SELECT. Wrap in try/catch so a failed migration
  // never blocks the server from serving (the failed row is recorded in
  // schema_migrations with status='failed' and surfaces via the admin
  // migrations UI for operator inspection).
  //
  // This is the safety net that makes start.ps1's "Restart-Service"
  // fallback work: when the API endpoint isn't available (first deploy of
  // /api/system/update, or rollback), the new code still applies its own
  // pending migrations on the next startup instead of crashing.
  if (!needsInit && db) {
    try {
      const { createMigrationsService } = await import('./src/services/migrations.js');
      const migrationService = createMigrationsService({ db, logger, getRepoRoot: () => repoRoot });
      const migrationResult = await migrationService.upgrade({ appliedBy: 'startup' });
      if (migrationResult.migrations.applied.length > 0 || migrationResult.seed.ran) {
        logger.info({
          applied: migrationResult.migrations.applied.length,
          failed: migrationResult.migrations.failed.length,
          seed: migrationResult.seed.reason
        }, 'startup auto-migration');
      }
    } catch (e) {
      logger.warn({ err: e.message }, 'startup auto-migration failed; continuing with current schema');
    }
  }
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
    // I3: seed agent-token bundle from appsettings.json on first boot.
    // After this point, runtime reads from system_config.agent_token_current;
    // appsettings.json is bootstrap-only. Idempotent (no-op if row exists) and
    // also auto-expires any stale agent_token_previous past TTL (spec §1.4).
    // Wrapped in try/catch to mirror the other seed calls in this gate — a
    // transient DB error here must not crash the bootstrap; the middleware
    // will surface a 503 on the first agent request if the row is missing.
    try {
      const { seedAgentTokenIfMissing } = await import('./src/services/agent-token.js');
      await seedAgentTokenIfMissing(db, finalConfig.agentToken, logger);
    } catch (err) {
      logger.warn({ err: err.message }, 'agent token seed failed; agents will fail auth until DB row is populated');
    }
    // I9: seed jwt-secret bundle from appsettings.json on first boot.
    // After this point, runtime reads from system_config.jwt_secret_current;
    // appsettings.json is bootstrap-only. Idempotent (no-op if row exists) and
    // also auto-expires any stale jwt_secret_previous past TTL (default 30d).
    // Same try/catch pattern as agent-token above: a transient DB error here
    // must not crash bootstrap; userAuth will surface a clear failure on the
    // first login attempt if the row is missing.
    try {
      const { seedJwtSecretIfMissing } = await import('./src/services/jwt-secret.js');
      await seedJwtSecretIfMissing(db, finalConfig.jwtSecret, logger);
    } catch (err) {
      logger.warn({ err: err.message }, 'jwt secret seed failed; logins will fail until DB row is populated');
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
    app.use(authRouter({ config: finalConfig, logger, db: getDb() }));
    // System update endpoint (no auth, localhost-only — see system.js for the
    // contract). Mounted before all the admin routers so an operator can
    // trigger an update from the host without needing credentials. The route
    // applies pending DB migrations and schedules process.exit(0) so NSSM
    // picks up the new code on the next launch.
    app.use(systemRouter({
      logger,
      getRepoRoot: () => repoRoot
    }));
    // Bootstrap endpoint for agents (web mount — /config.json only). Lets an
    // agent learn heartbeat/report ports + intervals from the web port
    // without needing to know any other port number up front. The dedicated
    // heartbeatApp / reportApp carry the bulk of agent traffic; web just
    // exposes the bootstrap config the agent reads on startup and on
    // periodic config-refresh ticks.
    app.use(agentRouter({ config: finalConfig, logger, mount: 'web' }));
    app.use(dashboardRouter({ config: finalConfig, logger, db: getDb() }));
    app.use(adminRouter({ config: finalConfig, logger, db: getDb() }));
    // DC summary endpoint (Task 4). Mirrors the adminRouter's per-route
    // [userAuth, requirePerm('admin:users')] middleware — the router
    // factory accepts the same auth deps so the per-route chain is
    // identical to other admin read endpoints.
    app.use(dcsRouter({
      requireAuth: userAuth({ db: getDb(), logger }),
      requirePerm: (perm) => requirePerm(perm)
    }));
    // Lockout troubleshooting — multi-filter search across ad_lockout_events.
    // Same auth contract as dcsRouter: per-route [userAuth, requirePerm('admin:users')].
    app.use(lockoutRouter({
      requireAuth: userAuth({ db: getDb(), logger }),
      requirePerm: (perm) => requirePerm(perm)
    }));
    // Schema migrations admin (list/apply/dry-run/reset). Same auth contract
    // as dcsRouter and lockoutRouter: per-route [userAuth, requirePerm('admin:users')].
    app.use(schemaMigrationsRouter({
      requireAuth: userAuth({ db: getDb(), logger }),
      requirePerm: (perm) => requirePerm(perm),
      logger,
      getRepoRoot: () => repoRoot
    }));
    // Heartbeat/Report admin aggregator (Task 6). Read-only per-agent view
    // joining ad_agent_heartbeat with the latest ad_replication_status
    // snapshot. Same auth contract as the other admin read endpoints above.
    app.use(heartbeatReportRouter({
      requireAuth: userAuth({ db: getDb(), logger }),
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
      config: finalConfig,
      logger
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
      logger,
      db: getDb()
    }));
    // Agent-facing per-host package list (Task 8: spec §4.3 / global
    // constraint #14). Sits on the web app so non-AD agents hitting
    // /api/admin/agent/packages-for-host?hostname=... on heartbeat get the
    // merged view of global installed_packages + per-host
    // ad_member_server_packages. Backed by agentToken (NOT userAuth) — the
    // agent has no JWT, only the agent_token from appsettings.json.
    app.use(agentPackagesRouter({
      config: finalConfig,
      logger
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
  // Bootstrap itself rejected — fall back to a sync stderr logger so the
  // crash trace is at least on fd 2 (which the install script's stderr
  // capture will route somewhere — see install-center.ps1's stderr
  // handling). The rotated logger isn't available here because the
  // failure may have happened during its construction.
  const fallback = createLogger({ component: 'center', level: 'info' });
  fallback.fatal({ err: err.message, stack: err.stack }, 'bootstrap failed before logger ready');
  process.exit(1);
}));
} // end if (invokedDirectly)
