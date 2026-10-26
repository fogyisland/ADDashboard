// R158.104 (2026-10-14) — self-service /api/me/mcp-token/* router. 3 endpoints:
//   GET  /api/me/mcp-token         — state (no secret): { current_set, previous_set, rotatedAt, version }
//   GET  /api/me/mcp-token/reveal  — active token + audit row
//   POST /api/me/mcp-token/rotate  — generate new token, bump version, write audit
//
// NO POST /api/me/mcp-token/commit endpoint. Commit (clearing the previous
// token so all AI Agents on the old token are immediately locked out) is
// intentionally kept admin-only (/api/admin/mcp-token/commit, gated by
// admin:config). Rationale: any logged-in user rotating their own token
// would otherwise be able to force-commit — that affects ALL other users'
// AI Agent tokens, not just their own. Cross-user impact → admin-only.
//
// F1/F2 (2026-10-20) — permission + cache-hardening fix. See the comment
// block above `authConfig` inside createMeMcpRouter for the full rationale.
// Summary: reveal + rotate moved from requireAuth-only to
// [requireAuth, requirePerm('admin:config')], matching /api/admin/mcp-token/*
// (admin-mcp.js:36), because the MCP token is a single GLOBAL value —
// "自己的 token" was never true, so any logged-in user could read the
// credential every AI Agent uses. state stays requireAuth-only (no secret).
// Both secret-bearing responses now send Cache-Control: no-store.
// audit userId = req.user.sub (the operator's own subject), not the legacy
// anonymous "operator" used by some admin endpoints, so every rotate/reveal
// is traceable to a specific user.
//
// 1:1 reuse of services/mcp-token.js exports — no new service code.
import { Router } from 'express';
import {
  getMcpTokenState,
  rotateMcpToken,
  revealMcpToken
} from '../services/mcp-token.js';
import { invalidateMcpTokenCache } from '../auth/mcp-token.js';
// R158.X.117 (2026-10-26) — 端点地址真源.
//   getPrimaryIPv4 → 服务器真实 IP (utils/network.js).
//   getConfig/getConfigMap → system_config 的 access_domain / listenPort.
//   isLoopbackHost → system-settings-v2.js 导出的本机地址判定 (单一真源, 2 处共用).
import { getPrimaryIPv4 } from '../utils/network.js';
import { getConfig, getConfigMap } from '../services/config.js';
import { isLoopbackHost, splitHostPort } from './system-settings-v2.js';

export function createMeMcpRouter({ db, requireAuth, requirePerm }) {
  const r = Router();
  const authOnly = requireAuth;
  // F1 (2026-10-20) — requireAuth + admin:config, same chain as
  //   adminMcpRouter:36. Falls back to requireAuth-only when requirePerm is
  //   not injected (test harnesses that only pass { db, requireAuth }).
  //
  //   Why reveal/rotate need this gate: system_config.mcp_api_token_current
  //   is a SINGLE GLOBAL value, not per-user. "自己的 token" was never true —
  //   any logged-in account calling GET /api/me/mcp-token/reveal got the
  //   exact bearer credential every AI Agent uses for all 8 /mcp read tools.
  //   The /me page sits in the ordinary user menu (views/MeView.vue:58), not
  //   the admin sidebar, so it required no admin:config.
  //
  //   rotate gets the same gate for the same reason: it moves the global
  //   current token to previous and installs a new one. The header comment
  //   (lines 6-11) already argued commit must stay admin-only because it
  //   "affects ALL other users' AI Agent tokens, not just their own" — rotate
  //   has that identical global blast radius, so the asymmetry did not hold.
  //
  //   state (GET /api/me/mcp-token) stays requireAuth-only: booleans + version,
  //   never a secret (services/mcp-token.js:49-57).
  const authConfig = requirePerm ? [requireAuth, requirePerm('admin:config')] : requireAuth;

  // GET /api/me/mcp-token — state (no secret). Same shape as
  // /api/admin/mcp-token (admin-mcp.js:77). 1:1 reuse of service fn.
  r.get('/api/me/mcp-token', authOnly, async (req, res) => {
    try {
      const s = await getMcpTokenState(db);
      res.json(s);
    } catch (e) {
      req.log?.error?.({ event: 'me.mcp_token.state_failed', err: e?.message }, 'me mcp-token state get failed');
      res.status(500).json({ error: 'state get failed' });
    }
  });

  // GET /api/me/mcp-token/reveal — read the active token so the user
  // can copy it into their AI Agent (Claude Desktop / Cursor). Each
  // reveal writes an audit row (R158.102 admin-mcp.js:91 precedent).
  // Note: the admin route uses `r.get` and returns the same shape.
  r.get('/api/me/mcp-token/reveal', authConfig, async (req, res) => {
    try {
      const out = await revealMcpToken(db, {
        logger: req.log,
        userId: req.user?.sub ?? null
      });
      // F2 (2026-10-20) — Cache-Control: no-store. The body carries a live
      //   bearer credential; without this it can persist in browser cache /
      //   history and in any reverse proxy that logs response bodies.
      res.set('Cache-Control', 'no-store');
      res.json(out);
    } catch (e) {
      req.log?.error?.({ event: 'me.mcp_token.reveal_failed', err: e?.message }, 'me mcp-token reveal failed');
      res.status(500).json({ error: 'reveal failed' });
    }
  });

  // POST /api/me/mcp-token/rotate — generate a new token, the previous
  // one enters the rotation overlap window (still valid until someone
  // — admin — commits). After rotate, the cache MUST be invalidated so
  // the very next /mcp request sees the new state (class admin-mcp.js:48
  // precedent).
  r.post('/api/me/mcp-token/rotate', authConfig, async (req, res) => {
    try {
      const out = await rotateMcpToken(db, {
        logger: req.log,
        userId: req.user?.sub ?? null
      });
      invalidateMcpTokenCache();
      // F2 — rotate's response body carries the NEW token in plaintext.
      res.set('Cache-Control', 'no-store');
      res.json(out);
    } catch (e) {
      req.log?.error?.({ event: 'me.mcp_token.rotate_failed', err: e?.message }, 'me mcp-token rotate failed');
      res.status(500).json({ error: 'rotate failed' });
    }
  });

  // GET /api/me/mcp-endpoint — R158.X.117 (2026-10-26) — **新增**端点
  //   (0 改既有 3 个 /api/me/mcp-token* 端点).
  //
  //   用途: 前端 MeMcpTokenView.vue 的 "接入端点" + AI Agent config JSON 模板.
  //   旧实现用 `window.location.origin` 拼 URL —— 操作员如果是通过
  //   `http://localhost:8080` 打开 center 的, 模板里就是
  //   `"url": "http://localhost:8080/mcp"`, 贴到**另一台机器**的
  //   Claude Desktop / Cursor 上必然连不上 (localhost 解析成客户端自己).
  //   ⇒ 端点地址必须来自**服务器**, 不是来自浏览器地址栏.
  //
  //   wire shape: { endpoint, healthz, serverIp, domain }
  //     endpoint  — 跨机可访问的 MCP 端点 URL (http://<host>:<port>/mcp)
  //     healthz   — 免鉴权健康检查 URL
  //     serverIp  — 服务器真实 IP
  //     domain    — 操作员配的访问域名 (本机地址视为未配 ⇒ 空串)
  //
  //   判据跟 admin 侧 GET /api/admin/system-settings-v2/access-domain 1:1 平行:
  //     有访问域名 (非本机地址) → 用域名
  //     否则 → 用 getPrimaryIPv4() 的真实 IP
  //   0 用 listen.host (0.0.0.0 是 bind 地址, 客户端连不上).
  r.get('/api/me/mcp-endpoint', authOnly, async (req, res) => {
    try {
      const cfg = await getConfig();
      const map = await getConfigMap();
      const listenPort = Number(map?.listenPort) || 8080;
      const serverIp = getPrimaryIPv4();

      const rawDomain = String(cfg?.access_domain || '').trim();
      // 本机地址 (localhost / 127.x / ::1 / 0.0.0.0) 对跨机客户端不可用 ⇒ 视为未配.
      const isLoop = isLoopbackHost(rawDomain);
      const { host: domainHost, port: domainPort } = splitHostPort(rawDomain);
      const domain = isLoop ? '' : domainHost;
      const port = Number(domainPort) || listenPort;

      const host = domain || serverIp;
      const base = `http://${host}:${port}`;
      res.json({
        endpoint: `${base}/mcp`,
        healthz: `${base}/mcp/healthz`,
        serverIp,
        domain
      });
    } catch (e) {
      req.log?.error?.({ event: 'me.mcp_endpoint.failed', err: e?.message }, 'me mcp-endpoint get failed');
      res.status(500).json({ error: 'endpoint get failed' });
    }
  });

  return r;
}
