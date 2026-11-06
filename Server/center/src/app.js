import express from 'express';
import { healthzRouter } from './routes/healthz.js';

// Error middleware factory — exported so server.js can mount the same
// handler on the heartbeat / report apps (R119 multi-port split). Prior
// to this export the error handler lived only inside createApp, so a
// throw on a heartbeat/report route returned an empty body (Express
// default) instead of `{ error: 'internal' }`, and agents entered a
// retry loop on every transient error — see
// dashboard-code-review-2026-09-30.md S3.
export function errorMiddleware({ logger }) {
  return function (err, _req, res, _next) {
    logger?.error?.({ err: err?.message, stack: err?.stack }, 'unhandled');
    // If a streaming response (file-push download / agent file fetch)
    // has already flushed headers, JSON writes will throw too. End the
    // connection instead of hanging on a half-written body.
    if (res.headersSent) {
      try { res.end(); } catch { /* swallow */ }
      return;
    }
    res.status(500).json({ error: 'internal' });
  };
}

export function createApp({ config, db, logger, needsInit = false }) {
  const app = express();
  app.disable('x-powered-by');
  app.locals.needsInit = needsInit;
  app.use(express.json({ limit: '50mb' })); // 2026-09-05 R80-followup: raised from 10mb to 50mb so file-push can handle up to 32mb binary (~43mb base64 + JSON wrapper stays under 50mb). Hard limit: see FILE_PUSH_MAX_BYTES in services/file-push.js (8mb historical / 32mb new).
  app.use((req, _res, next) => {
    req.log = logger.child({ method: req.method, url: req.url });
    next();
  });
  // R120 Task 12 followup — healthzRouter factory now takes { logger }
  // (factory emits a debug-level event on degradation; the 503 status
  // response is the operator signal, the log line is the dev escape hatch).
  // The two heartbeat/report apps in server.js pass { logger } explicitly
  // (R119 multi-port split). webApp must do the same — calling
  // healthzRouter() without args triggers
  //   "Cannot destructure property 'logger' of 'undefined'"
  // on every webApp boot, NSSM 1-3s restart loop (R121 LESSON).
  app.use(healthzRouter({ logger }));
  // Static frontend
  app.use(express.static(config.staticDir, { index: 'index.html', extensions: ['html'] }));
  // SPA fallback. /api/* and /healthz are excluded so admin/agent/heartbeat
  // endpoints always reach their handlers. /config.json is also excluded —
  // it's the web-port bootstrap endpoint mounted later by server.js (via
  // agentRouter with mount:'web'). Without this exclusion the SPA fallback
  // would shadow it (agentRouter mounts AFTER createApp's static+SPA chain).
  // R158.103 (2026-10-14) — `/mcp` 加入 ignore 列表. 操作员 directive "MCP
  //   旁挂模式, Token 独立于 user auth" + R158.102 ship 时 mcpRouter 写在
  //   /mcp/healthz + /mcp POST/GET/DELETE. SPA fallback 不 shadow 整个
  //   /mcp namespace, 让 mcpToken + mcpRouter 真生效 (R158.102 ship 时
  //   漏 enumerate 这一边, R158.103 闭合).
  //
  // R158 verification (2026-10-20) — `mcp-write/` was missing from the
  // ignore list, so GET /mcp-write/healthz fell through to this SPA
  // fallback and returned index.html instead of the MCP-write healthz
  // JSON (the /mcp sibling returned correctly, which is what masked it).
  // `mcp\/` does NOT match `mcp-write/` — the alternation needs its own
  // `mcp-write\/` branch. createApp (which registers this fallback) runs at
  // server.js:213, before the `app.use('/mcp-write', ...)` mounts at
  // server.js:884, so the exclusion is the only thing keeping that
  // namespace reachable.
  app.get(/^\/(?!api\/|healthz|config\.json|mcp\/|mcp-write\/).*/, (_req, res) => {
    res.sendFile('index.html', { root: config.staticDir });
  });
  // Error handler
  app.use(errorMiddleware({ logger }));
  return app;
}
