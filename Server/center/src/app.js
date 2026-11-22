import express from 'express';
import { healthzRouter } from './routes/healthz.js';
// R161.34 (2026-11-07, security) — 安全响应头。
//   ★ 必须挂在**最前面** (早于 body parser / 静态资源 / 任何路由),
//     否则静态资源响应、404、以及 error middleware 兜底的 500 都会漏掉。
import { securityHeaders } from './middleware/securityHeaders.js';

// Error middleware factory — exported so server.js can mount the same
// handler on the heartbeat / report apps (R119 multi-port split). Prior
// to this export the error handler lived only inside createApp, so a
// throw on a heartbeat/report route returned an empty body (Express
// default) instead of `{ error: 'internal' }`, and agents entered a
// retry loop on every transient error — see
// dashboard-code-review-2026-09-30.md S3.
export function errorMiddleware({ logger }) {
  return function (err, _req, res, _next) {
    // R161.31 (2026-11-07) — body-parser 的错误必须**原样透出状态码**。
    //
    // ★ 为什么: body-parser 抛的 `entity.too.large` 带 `status: 413` 与
    //   `type: 'entity.too.large'`。旧实现一律回 500 ⇒ 客户端看到的是
    //   "服务器内部错误"，无法区分"我发太大了"和"服务器坏了" ⇒ 代理层
    //   / 监控会把它当服务端故障告警。R161.31 起 body 按路径分档，超限是
    //   **客户端错误**（改小 body / 换端点即可），必须回 413 + 明确文案。
    //
    // ★ 同理处理 JSON 语法错误: `entity.parse.failed` ⇒ 400（body 不是
    //   合法 JSON), 而不是 500。
    const type = String(err?.type || '');
    if (type === 'entity.too.large') {
      logger?.warn?.({ err: err?.message, limit: err?.limit }, 'request body too large');
      if (!res.headersSent) {
        res.status(413).json({ error: 'payload too large' });
      }
      return;
    }
    if (type === 'entity.parse.failed') {
      logger?.warn?.({ err: err?.message }, 'request body is not valid JSON');
      if (!res.headersSent) {
        res.status(400).json({ error: 'invalid JSON body' });
      }
      return;
    }
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
  // R161.34 (2026-11-07, security) — 安全响应头 —— 进程内第一个 app.use。
  //   放在这里 (早于 body parser) 的原因: 静态资源、API、404、**以及
  //   error middleware 兜底的 500** 都要带上这些头。晚挂一个就漏一类。
  app.use(securityHeaders());
  // R161.31 (2026-11-07) — body parser **按路径分流**。
  //
  // ★ 旧实现: 全局 express.json({limit:'50mb'})。后果 = **每一个** 请求
  //   （包括 60s 一次的心跳、健康检查、SPA 静态资源请求）都挂着一个
  //   "最多读 50MB" 的 body 解析器。express 的 json parser 在 content-type
  //   不匹配时直接跳过，所以真正的开销是: (a) 每个请求都多跑一次
  //   type-is 判定 + (b) 任何未受控的 JSON 端点（admin 批量导入等）
  //   单请求就能吃掉 50MB 内存 —— 一个未授权/低权限的 POST 就能让
  //   进程 RSS 暴涨（body-parser 把整个 body 读进内存后再 JSON.parse）。
  //
  // ★ 新实现: 分三档
  //   1. 大体量端点 (50mb) —— 只有文件推送上传真的需要:
  //      POST /api/admin/file-push (base64 32MB 二进制 ≈ 43MB 文本)
  //   2. 中体量端点 (10mb) —— agent 上报类:
  //      POST /api/agent/report (复制快照 12+ 行长错误串)
  //      POST /api/agent/packages/report (批量包指标)
  //      POST /api/agent/{ad,member}-commands/:id/result (脚本 stdout JSON)
  //      ★ 升级包不走 body —— GET /api/agent/upgrade 是**响应**方向, 不受
  //        body 上限约束; POST /api/agent/upgrade-result 只是几十字节的状态。
  //   3. 其余全部端点 (1mb) —— 管理台 JSON / 心跳 / init / MCP。
  //
  // ★ 实现约束: express 的 body parser **只解析一次** —— 第一个匹配的
  //   parser 消费掉请求流后, 后续 parser 看到 req._body=true 会跳过。
  //   所以必须把"大体量 parser"挂在**路径前缀**上, 且排在通用 parser
  //   **之前**, 否则通用 parser 先消费了流, 大体量 parser 拿不到 body。
  //
  // ★ 兼容性: 上限值与旧实现保持一致（50mb / 10mb），不会让原本能通过的
  //   请求变成 413 —— 只是把"所有端点都能收 50mb"收窄成"只有该收的收"。
  const BIG_BODY_LIMIT = '50mb';
  const MEDIUM_BODY_LIMIT = '10mb';
  const DEFAULT_BODY_LIMIT = '1mb';

  // ① 大体量: 文件推送上传 (base64 二进制)。挂在精确路径上 —— 用
  //   app.use(path, parser) 形式而不是 app.post(...)，这样同一路径下的
  //   其他方法 (PUT/PATCH) 也会被覆盖，防止将来新增方法绕过限制。
  app.use('/api/admin/file-push', express.json({ limit: BIG_BODY_LIMIT }));
  // ② 中体量: agent 上报 (复制快照 / 包指标)。心跳体积很小（几百字节），
  //   落在默认档即可。
  app.use('/api/agent/report', express.json({ limit: MEDIUM_BODY_LIMIT }));
  app.use('/api/agent/packages/report', express.json({ limit: MEDIUM_BODY_LIMIT }));
  // 命令执行结果回传 —— body 是脚本 stdout 的 JSON 结果行。服务端对
  // member-command 的 stdout/stderr 有 32KB/8KB 截断, 但 ad-command 的
  // result.data **不截断** (services/ad-admin-commands.js:530 只截了
  // error 到 2000 字符) ⇒ 走中体量档, 避免极端 stdout 撑爆默认档。
  app.use('/api/agent/ad-commands', express.json({ limit: MEDIUM_BODY_LIMIT }));
  app.use('/api/agent/member-commands', express.json({ limit: MEDIUM_BODY_LIMIT }));
  // ③ 通用档: 其余全部端点。
  app.use(express.json({ limit: DEFAULT_BODY_LIMIT }));
  // 2026-09-05 R80-followup: 大体量上限从 10mb 提到 50mb 是为了 file-push
  // 能传 32mb 二进制（≈43mb base64 + JSON 包装 < 50mb）。硬上限另见
  // services/file-push.js 侧的 FILE_PUSH_MAX_BYTES（8mb 历史值 / 32mb 新值）。
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
