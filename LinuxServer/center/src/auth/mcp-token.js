// R158.102 (2026-10-14) — MCP server token middleware. Mirrors auth/agent-token.js
// 1:1 parallel with two simplifications:
//   1. NO identity binding (no X-Mcp-Signature / no HMAC over body). MCP clients
//      (Claude Desktop / Cursor) are HTTP clients, not stateful agents — they
//      don't sign bodies. The header itself is the credential.
//   2. NO 60s restart-grace window — MCP clients reconnect cleanly, no
//      in-flight unauthenticated requests to protect.
//
// Wire shape:
//   Authorization: Bearer mcp_<96-hex>
//
// Comparison is constant-time via crypto.timingSafeEqual. Bundle is cached
// for the process lifetime; invalidate via invalidateMcpTokenCache() from
// the rotate/commit handlers so the very next request sees the new state.
//
// A previous-token match (rotation overlap window still open) emits one warn
// line carrying { path } — never the token. Class agent-token precedent.
import crypto from 'node:crypto';
import { MCP_TOKEN_PREFIX } from '../services/mcp-token.js';
import { parseIpList, matchIp } from '../utils/cidr.js';
import { writeAudit } from '../services/audit.js';

const FALLBACK_BUNDLE_SQL = "SELECT config_key, config_value FROM system_config WHERE config_key IN ('mcp_api_token_current', 'mcp_api_token_previous', 'mcp_api_token_rotated_at', 'mcp_api_token_version')";

// R158.X.99.28 (2026-10-19) — MCP IP whitelist bundle keys. 1:1 平行
// R158.113.c `access_domain` (单 KV) + R158.16 `email_enabled` (toggle) precedent.
// R158.X.99.28.b (2026-10-19) — 1-click 修 F1 HIGH finding: 走新 `db.sql.config.getMcpIpWhitelistBundle`
// IN-list SQL helper (sql.js:784 mysql / 3882 mssql) 替代原 `getAll` 拉全表 +
// 客户端 filter. 1:1 平行 `getMcpTokenBundle` 范式.
const MCP_IP_WHITELIST_KEYS = new Set(['mcp_ip_whitelist', 'mcp_ip_whitelist_enabled']);

const FALLBACK_IP_BUNDLE_SQL = "SELECT config_key, config_value FROM system_config WHERE config_key IN ('mcp_ip_whitelist', 'mcp_ip_whitelist_enabled')";

let _cache = null; // { current: string, previous: string }
let _ipCache = null; // { enabled: bool, parsed: [{ip, cidr, family, raw}] }

export async function _loadMcpTokenBundle(db, sql) {
  if (_cache) return _cache;
  const effectiveSql = sql
    || db?.sql?.config?.getMcpTokenBundle
    || FALLBACK_BUNDLE_SQL;
  const { rows } = await db.query(effectiveSql);
  const map = Object.fromEntries((rows || []).map(r => [r.config_key, r.config_value]));
  _cache = {
    current:  map.mcp_api_token_current  ?? '',
    previous: map.mcp_api_token_previous ?? ''
  };
  return _cache;
}

export function invalidateMcpTokenCache() {
  _cache = null;
  _ipCache = null; // R158.X.99.28 — IP whitelist 同 token 一同 invalidate, 防 drift
}

// R158.X.99.28 — 加载 MCP IP 白名单 bundle. R158.X.99.28.b (2026-10-19) —
// 1-click 修 F1 HIGH finding: 走 `db.sql.config.getMcpIpWhitelistBundle` IN-list
// helper (2 KV row), 0 必拉全表 + 客户端 filter. 1:1 平行 `_loadMcpTokenBundle`
// cache 范式 (module-level 闭包, lazy load, invalidate 重置).
async function _loadMcpIpWhitelist(db) {
  if (_ipCache) return _ipCache;
  const ipBundleSql = db?.sql?.config?.getMcpIpWhitelistBundle || FALLBACK_IP_BUNDLE_SQL;
  const { rows } = await db.query(ipBundleSql);
  const map = Object.fromEntries((rows || []).map(r => [r.config_key, r.config_value]));
  const rawJson = map.mcp_ip_whitelist ?? '[]';
  _ipCache = {
    enabled: map.mcp_ip_whitelist_enabled === '1',
    // 1:1 平行 cidr.js parseIpList (fail-safe: JSON 损坏 → 空列表 → fail-closed when enabled)
    parsed: parseIpList(rawJson)
  };
  return _ipCache;
}

// R158.X.99.28 — clientIp helper. 1:1 平行 routes/system.js:28-33 范式. 包内
// module-level 避免每次 require 重新走 function decl 闭包捕获.
// R158.X.99.report (2026-10-21) — 提为 **单一真源** 并 export. 此前同一行
//   `req.ip || req.socket?.remoteAddress` 在 mcp-token.js / mcp-write-token.js /
//   routes/system.js 各抄一份 (3 份). 3 份漂移风险最高的一次是 F4 那条:
//   有人只改其中一份, 另外两份的白名单仍按旧语义跑, 且不报错.
//   语义注释 (F4 trust proxy 警告) 随本函数一起搬到唯一的权威位置.
export function _clientIp(req) {
  return req.ip || req.socket?.remoteAddress || '';
}

// R158.X.99.28 — IP 验证决策. 1:1 平行 routes/system.js:35-37 `isLocalhost` 范式.
//   - enabled=0 (默认) → 旁路 (1:1 平行 R158.16 email_enabled)
//   - enabled=1 + 空列表 → fail-closed 拒全部 (防误启用 0 必填)
//   - enabled=1 + 命中 → 通过
//   - enabled=1 + 未命中 → 拒绝 + 403 + client_ip 在 body (D4 决策)
//
// ⚠ F4 (2026-10-20) — DO NOT enable `trust proxy` on this app without
//   re-reading this function. `server.js` intentionally sets NO trust proxy,
//   so Express ignores X-Forwarded-For and `_clientIp` returns the real TCP
//   peer — which is what makes the whitelist spoof-resistant today.
//   If `trust proxy` is ever turned on (e.g. to make a reverse proxy in front
//   of the SPA work), `_clientIp` will start honouring client-supplied
//   X-Forwarded-For, and this whitelist becomes trivially bypassable by any
//   caller who sets that header. If you add a proxy, either pin
//   trust proxy to the specific hop/IP, or restrict this check to the socket
//   address (req.socket.remoteAddress) and do NOT switch to req.ip.
function _isIpAllowed(req, ipBundle) {
  if (!ipBundle.enabled) return true;
  if (ipBundle.parsed.length === 0) return false; // fail-closed
  return matchIp(_clientIp(req), ipBundle.parsed);
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function mcpToken({ db, logger }) {
  const bundleSql = db?.sql?.config?.getMcpTokenBundle;
  return async (req, res, next) => {
    // R158.103 (2026-10-14) — /mcp/healthz 公开, 0 token 验证.
    //   操作员监测需求 (跟 /healthz 1:1 平行 precedent): operator 直接
    //   GET /mcp/healthz 验 MCP server 活没活, 不需要 mcp_ token.
    //   SPA fallback 在 app.js:50 已把 /mcp/ 加进 ignore 列表,
    //   mcpRouter 内部 r.get('/mcp/healthz') 仍可达, 这里跳过验证即可.
    //
    // R158.110 (2026-10-16) — 清理冗余分支. mount 在 app.use('/mcp', mcpToken)
    //   之后, req.path 永远是相对路径, 第二个判断 '/mcp/healthz' 永不命中.
    //   保留注释以便 grep 时仍能看到公开短路意图.
    if (req.path === '/healthz') return next();
    const auth = req.headers['authorization'];
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'missing mcp token' });
    }
    const supplied = auth.slice('Bearer '.length).trim();
    if (!supplied || !supplied.startsWith(MCP_TOKEN_PREFIX)) {
      return res.status(401).json({ error: 'invalid mcp token format' });
    }
    let bundle;
    try {
      bundle = await _loadMcpTokenBundle(db, bundleSql);
    } catch (e) {
      // Distinguish auth failure (401) from server failure (503) — operator
      // looking at the dashboard needs to know whether the AI Agent sent
      // a wrong token or the center can't reach its own DB. Class agent-
      // token precedent.
      logger?.error?.({ event: 'mcp.auth.lookup_failed', err: e?.message }, 'mcp token lookup failed');
      return res.status(503).json({ error: 'mcp token lookup failed' });
    }
    // R158.X.99.28 (2026-10-19) — IP whitelist check. 1:1 平行 routes/system.js:35-51
    // `isLocalhost` guard 范式. D4 决策: IP first (在 token 验证之前, 防
    // token brute-force 放大 + 减少 DB bundle load). D3 决策: /healthz 已
    // 短路, 0 必 IP check. 失败写 `mcp.auth.fail` audit (1:1 平行 R158.114
    // `mcp.request.failed` 范式 + 新加的 `mcp.auth.fail` action).
    let ipBundle;
    try {
      ipBundle = await _loadMcpIpWhitelist(db);
    } catch (e) {
      logger?.error?.({ event: 'mcp.ip.lookup_failed', err: e?.message }, 'mcp ip whitelist lookup failed');
      return res.status(503).json({ error: 'mcp ip whitelist lookup failed' });
    }
    if (!_isIpAllowed(req, ipBundle)) {
      const cip = _clientIp(req);
      logger?.warn?.(
        { event: 'mcp.auth.fail', path: req.path, reason: 'ip_not_allowed', client_ip: cip },
        'mcp authentication failed (ip not in whitelist)'
      );
      writeAudit({
        userId: null,
        action: 'mcp.auth.fail',
        target: 'mcp',
        payload: { client_ip: cip, path: req.path, reason: 'ip_not_allowed' }
      }, logger).catch(() => { /* best-effort audit, 0 必 throw */ });
      return res.status(403).json({
        error: 'ip_not_allowed',
        client_ip: cip,
        message: `Client IP ${cip} is not in the MCP IP whitelist.`
      });
    }
    if (!bundle.current) {
      // No current token seeded. Operator action required.
      logger?.warn?.({ path: req.path }, 'mcp request rejected: no current token (operator must seed + reveal)');
      return res.status(503).json({ error: 'mcp not initialized' });
    }
    let matched = 'none';
    if (constantTimeEqual(supplied, bundle.current)) {
      matched = 'current';
    } else if (bundle.previous && constantTimeEqual(supplied, bundle.previous)) {
      matched = 'previous';
      // Class agent-token spec §5: warn once per request that hits the OLD
      // token. This is the operator's only signal that some AI Agent hasn't
      // been rolled over yet — GET /api/admin/mcp-token only reports that
      // the overlap window is open, not who's still behind. Committing
      // before every straggler has been reconfigured locks that client out.
      // Never log the token or its length. `logger` is optional.
      logger?.warn?.(
        { path: req.path },
        'mcp authenticated with the PREVIOUS mcp token (rotation overlap window still open)'
      );
    } else {
      logger?.warn?.(
        { event: 'mcp.auth.fail', path: req.path, reason: 'token mismatch' },
        'mcp authentication failed (token mismatch)'
      );
      return res.status(401).json({ error: 'invalid mcp token' });
    }
    req._mcpTokenMatched = matched;
    logger?.debug?.(
      { event: 'mcp.auth.ok', path: req.path, matched },
      'mcp authenticated'
    );
    return next();
  };
}
