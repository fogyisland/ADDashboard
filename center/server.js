import { createApp } from './src/app.js';
import { loadConfig } from './src/config.js';
import { initPool, closePool, getPool } from './src/db.js';
import { createLogger } from './src/logger.js';
import { authRouter } from './src/routes/auth.js';
import { agentRouter } from './src/routes/agent.js';
import { dashboardRouter } from './src/routes/dashboard.js';
import { adminRouter } from './src/routes/admin.js';

const configPath = process.argv[2] || process.env.APPSETTINGS_PATH || './appsettings.json';
const config = loadConfig(configPath);
const logger = createLogger({ component: 'center', level: config.logLevel });

(async () => {
  await initPool(config);
  const pool = await getPool();
  const app = createApp({ config, pool, logger });
  app.use(authRouter({ config, pool, logger }));
  app.use(agentRouter({ config, pool, logger }));
  app.use(dashboardRouter({ config, pool, logger }));
  app.use(adminRouter({ config, pool, logger }));
  const server = app.listen(config.listenPort, () => {
    logger.info({ port: config.listenPort }, 'center listening');
  });
  const shutdown = async (sig) => {
    logger.info({ sig }, 'shutting down');
    server.close(async () => { await closePool(); process.exit(0); });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
})().catch(err => {
  logger.error({ err }, 'fatal');
  process.exit(1);
});