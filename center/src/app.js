import express from 'express';
import { healthzRouter } from './routes/healthz.js';

export function createApp({ config, db, logger, needsInit = false }) {
  const app = express();
  app.disable('x-powered-by');
  app.locals.needsInit = needsInit;
  app.use(express.json({ limit: '50mb' })); // 2026-09-05 R80-followup: raised from 10mb to 50mb so file-push can handle up to 32mb binary (~43mb base64 + JSON wrapper stays under 50mb). Hard limit: see FILE_PUSH_MAX_BYTES in services/file-push.js (8mb historical / 32mb new).
  app.use((req, _res, next) => {
    req.log = logger.child({ method: req.method, url: req.url });
    next();
  });
  app.use(healthzRouter());
  // Static frontend
  app.use(express.static(config.staticDir, { index: 'index.html', extensions: ['html'] }));
  // SPA fallback. /api/* and /healthz are excluded so admin/agent/heartbeat
  // endpoints always reach their handlers. /config.json is also excluded —
  // it's the web-port bootstrap endpoint mounted later by server.js (via
  // agentRouter with mount:'web'). Without this exclusion the SPA fallback
  // would shadow it (agentRouter mounts AFTER createApp's static+SPA chain).
  app.get(/^\/(?!api\/|healthz|config\.json).*/, (_req, res) => {
    res.sendFile('index.html', { root: config.staticDir });
  });
  // Error handler
  app.use((err, _req, res, _next) => {
    logger.error({ err }, 'unhandled');
    res.status(500).json({ error: 'internal' });
  });
  return app;
}
