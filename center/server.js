import { createApp } from './src/app.js';
import { loadConfigOrNull, defaultConfig } from './src/config.js';
import { init, close, getDb } from './src/db/index.js';
import { createLogger } from './src/logger.js';
import { authRouter } from './src/routes/auth.js';
import { agentRouter } from './src/routes/agent.js';
import { dashboardRouter } from './src/routes/dashboard.js';
import { adminRouter } from './src/routes/admin.js';
import { initRouter } from './src/init/router.js';
import { checkNeedsInit } from './src/init/needs-init.js';
import { closeWizardFacade } from './src/init/wizard-facade.js';
import { hasMarker, writeMarker, installPathFromConfigPath } from './src/init/marker.js';

const configPath = process.argv[2] || process.env.APPSETTINGS_PATH || './appsettings.json';
const installPath = installPathFromConfigPath(configPath);
const logger = createLogger({ component: 'center', level: 'info' });

(async () => {
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
    logger.error('init marker present but config missing — refusing to start. To recover: restore appsettings.json (preferred) OR clear the .initialized marker + registry value AND delete appsettings.json to re-run the wizard.');
    process.exit(2);
  }
  const needsInit = markerLocked ? false : await checkNeedsInit(db);
  const finalConfig = config ?? defaultConfig();

  const app = createApp({ config: finalConfig, db, logger, needsInit });
  if (needsInit) {
    logger.info('init mode: serving /api/init/* and /init');
    app.use('/api/init', initRouter({ logger, configPath, installPath, getNeedsInit: () => needsInit }));
  } else {
    app.use(authRouter({ config: finalConfig, logger }));
    app.use(agentRouter({ config: finalConfig, logger }));
    app.use(dashboardRouter({ config: finalConfig, logger }));
    app.use(adminRouter({ config: finalConfig, logger }));
  }

  const server = app.listen(finalConfig.listenPort, () => {
    logger.info({ port: finalConfig.listenPort, needsInit }, 'center listening');
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
})().catch(err => {
  logger.error({ err: err.message }, 'fatal');
  process.exit(1);
});