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

const configPath = process.argv[2] || process.env.APPSETTINGS_PATH || './appsettings.json';
const logger = createLogger({ component: 'center', level: 'info' });

(async () => {
  let config = loadConfigOrNull(configPath);
  let db = null;
  if (config) {
    try {
      await init(config);
      db = getDb();
    } catch (err) {
      logger.warn({ err: err.message }, 'db init failed; falling back to init mode');
      config = null;
      db = null;
    }
  }
  const needsInit = await checkNeedsInit(db);
  const finalConfig = config ?? defaultConfig();

  const app = createApp({ config: finalConfig, db, logger, needsInit });
  if (needsInit) {
    logger.info('init mode: serving /api/init/* and /init');
    app.use('/api/init', initRouter({ logger, configPath, getNeedsInit: () => needsInit }));
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