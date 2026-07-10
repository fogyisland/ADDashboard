import express from 'express';
import { healthzRouter } from './routes/healthz.js';

export function createApp({ config, pool, logger }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10mb' }));
  app.use((req, _res, next) => {
    req.log = logger.child({ method: req.method, url: req.url });
    next();
  });
  app.use(healthzRouter());
  // Static frontend
  app.use(express.static(config.staticDir, { index: 'index.html', extensions: ['html'] }));
  // SPA fallback
  app.get(/^\/(?!api\/|healthz).*/, (_req, res) => {
    res.sendFile(`${config.staticDir}/index.html`);
  });
  // Error handler
  app.use((err, _req, res, _next) => {
    logger.error({ err }, 'unhandled');
    res.status(500).json({ error: 'internal' });
  });
  return app;
}
