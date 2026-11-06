// R158.104 (2026-10-14) — self-service API client. 1:1 平行 admin.js /
// dashboard.js 形状 (default export 一个 namespace object, 内部用 `api`
// from ./client.js, axios interceptor 自动加 Authorization Bearer + 401
// 拦截). 6 函数覆盖 sidebar 底部 UserWidget 的 4 个动作:
//   · getProfile()      →  GET  /api/me/profile
//   · changePassword()  →  POST /api/me/change-password
//   · logoutAll()       →  POST /api/me/logout-all
//   · getMcpTokenState()→  GET  /api/me/mcp-token
//   · revealMcpToken()  →  GET  /api/me/mcp-token/reveal
//   · rotateMcpToken()  →  POST /api/me/mcp-token/rotate
//
// 0 改 client.js (R158.103 401 拦截器已正确处理 /api/me/* 401 → /login).
// 0 加 ANONYMOUS_OK_401 白名单 — /api/me/* 是 auth-required, 401 必须
// 走标准 redirect /login 流程.
import api from './client.js';

export const meApi = {
  // Current user profile (no password_hash, no token_version).
  getProfile: () => api.get('/api/me/profile'),
  // Change own password. Body: { oldPassword, newPassword }.
  // Returns { ok: true, newVersion } on success; { error } on failure.
  changePassword: (body) => api.post('/api/me/change-password', body),
  // Bump token_version so every live JWT is invalidated. Returns
  // { ok: true, newVersion }.
  logoutAll: () => api.post('/api/me/logout-all'),
  // MCP token state (no secret): { current_set, previous_set, rotatedAt, version }.
  getMcpTokenState: () => api.get('/api/me/mcp-token'),
  // Reveal the active MCP token so it can be pasted into the AI Agent
  // config. Each call writes a self_token_reveal audit row.
  revealMcpToken: () => api.get('/api/me/mcp-token/reveal'),
  // Rotate the MCP token. The previous token enters the rotation overlap
  // window (still valid until someone — admin — commits). Returns
  // { newToken, rotatedAt, version }.
  rotateMcpToken: () => api.post('/api/me/mcp-token/rotate', {}),
  // R158.X.117 (2026-10-26) — 跨机可访问的 MCP 端点地址.
  //   { endpoint, healthz, serverIp, domain } — endpoint 形如
  //   'http://10.170.140.23:8080/mcp'. 0 用 window.location.origin (操作员
  //   走 localhost 打开 center 时会给出连不上的地址).
  getMcpEndpoint: () => api.get('/api/me/mcp-endpoint')
};
