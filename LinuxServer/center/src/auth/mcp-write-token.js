// R158.113 (2026-10-17) — MCP write tools token middleware. 1:1 平行 auth/mcp-token.js
// 唯一区别: prefix `mcpw_` (写端). /mcp-write/healthz 公开短路 (跟 /mcp/healthz 1:1 平行,
// R158.103 锁). 0 me 端入口 (操作员 directive "个人账户默认不能申请写入").
// 503 vs 401 区分 + bundle cache + constantTimeEqual 全部跟 mcp-token.js 1:1 平行.
import crypto from 'node:crypto';
import { MCP_WRITE_TOKEN_PREFIX } from '../services/mcp-write-token.js';
import { parseIpList, matchIp } from '../utils/cidr.js';
import { writeAudit } from '../services/audit.js';
// R158.X.99.report (2026-10-21) — `_clientIp` 不再本地抄一份, 改为 import
//   auth/mcp-token.js 的导出 (R158.X.99.28 遗留的 3 份同源代码收敛到 1 份).
//   语义与 ⚠ F4 trust proxy 警告见 mcp-token.js 中该函数定义处 —— 那是唯一的
//   权威位置, 不要在别处重新解释 req.ip 的可信度.
import { _clientIp } from './mcp-token.js';

const FALLBACK_BUNDLE_SQL = "SELECT config_key, config_value FROM system_config WHERE config_key IN ('mcp_write_token_current', 'mcp_write_token_previous', 'mcp_write_token_rotated_at', 'mcp_write_token_version')";

// R158.X.99.28 (2026-10-19) — MCP write IP whitelist bundle keys. 1:1 平行
// auth/mcp-token.js MCP_IP_WHITELIST_KEYS (R158.X.99.28 决策 D6: 复用 system_config KV).
// 1 个白名单跨 read/write 双端 share (避免分别维护 2 套).
// R158.X.99.28.b (2026-10-19) — 1-click 修 F1 HIGH finding: 走新
// `db.sql.config.getMcpIpWhitelistBundle` IN-list SQL helper 替代原 `getAll`
// 拉全表 + 客户端 filter. 1:1 平行 mcp-token.js.
const MCP_WRITE_IP_WHITELIST_KEYS = new Set(['mcp_ip_whitelist', 'mcp_ip_whitelist_enabled']);

const FALLBACK_IP_BUNDLE_SQL = "SELECT config_key, config_value FROM system_config WHERE config_key IN ('mcp_ip_whitelist', 'mcp_ip_whitelist_enabled')";

let _cache = null; // { current: string, previous: string }
let _ipCache = null; // { enabled: bool, parsed: [{ip, cidr, family, raw}] }

export async function _loadMcpWriteTokenBundle(db, sql) {
  if (_cache) return _cache;
  const effectiveSql = sql
    || db?.sql?.config?.getMcpWriteTokenBundle
    || FALLBACK_BUNDLE_SQL;
  const { rows } = await db.query(effectiveSql);
  const map = Object.fromEntries((rows || []).map(r => [r.config_key, r.config_value]));
  _cache = {
    current:  map.mcp_write_token_current  ?? '',
    previous: map.mcp_write_token_previous ?? ''
  };
  return _cache;
}

export function invalidateMcpWriteTokenCache() {
  _cache = null;
  _ipCache = null; // R158.X.99.28 — IP whitelist 同 token 一同 invalidate
}

// R158.X.99.28 — 加载 MCP write IP 白名单 bundle. R158.X.99.28.b (2026-10-19) —
// 1-click 修 F1 HIGH finding: 走 `db.sql.config.getMcpIpWhitelistBundle` IN-list
// helper (共享 1 个白名单 across read/write 双端), 0 必拉全表 + 客户端 filter.
async function _loadMcpWriteIpWhitelist(db) {
  if (_ipCache) return _ipCache;
  const ipBundleSql = db?.sql?.config?.getMcpIpWhitelistBundle || FALLBACK_IP_BUNDLE_SQL;
  const { rows } = await db.query(ipBundleSql);
  const map = Object.fromEntries((rows || []).map(r => [r.config_key, r.config_value]));
  const rawJson = map.mcp_ip_whitelist ?? '[]';
  _ipCache = {
    enabled: map.mcp_ip_whitelist_enabled === '1',
    parsed: parseIpList(rawJson)
  };
  return _ipCache;
}

// R158.X.99.28 — IP 验证决策. 1:1 平行 auth/mcp-token.js `_isIpAllowed` (D2/D4 锁).
function _isIpAllowed(req, ipBundle) {
  if (!ipBundle.enabled) return true;
  if (ipBundle.parsed.length === 0) return false;
  return matchIp(_clientIp(req), ipBundle.parsed);
}
// ⚠ F4 (2026-10-20) — same `trust proxy` footgun as the read side: see the
//   long warning above `_isIpAllowed` in auth/mcp-token.js. server.js sets no
//   trust proxy today, which is the ONLY reason req.ip is not attacker-
//   controllable via X-Forwarded-For. Keep it that way, or pin it to the hop.

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function mcpWriteToken({ db, logger }) {
  const bundleSql = db?.sql?.config?.getMcpWriteTokenBundle;
  return async (req, res, next) => {
    // R158.113 (2026-10-17) — /mcp-write/healthz 公开, 0 token 验证 (跟
    //   /mcp/healthz 1:1 平行 R158.103 锁). mount 在 app.use('/mcp-write',
    //   mcpWriteToken) 之后, req.path 永远是相对路径, '/healthz' 命中.
    if (req.path === '/healthz') return next();
    const auth = req.headers['authorization'];
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'missing mcp write token' });
    }
    const supplied = auth.slice('Bearer '.length).trim();
    if (!supplied || !supplied.startsWith(MCP_WRITE_TOKEN_PREFIX)) {
      return res.status(401).json({ error: 'invalid mcp write token format' });
    }
    let bundle;
    try {
      bundle = await _loadMcpWriteTokenBundle(db, bundleSql);
    } catch (e) {
      logger?.error?.({ event: 'mcp-write.auth.lookup_failed', err: e?.message }, 'mcp write token lookup failed');
      return res.status(503).json({ error: 'mcp write token lookup failed' });
    }
    // R158.X.99.28 (2026-10-19) — MCP write IP whitelist check. 1:1 平行
    // auth/mcp-token.js line 136-165 范式. D4 决策: IP first (在 token 验证之前,
    // 防 token brute-force 放大). D3 决策: /healthz 已 line 88 短路, 0 必 IP check.
    // 失败写 `mcp-write.auth.fail` audit (1:1 平行 R158.114 + mcp.auth.fail).
    let ipBundle;
    try {
      ipBundle = await _loadMcpWriteIpWhitelist(db);
    } catch (e) {
      logger?.error?.({ event: 'mcp-write.ip.lookup_failed', err: e?.message }, 'mcp write ip whitelist lookup failed');
      return res.status(503).json({ error: 'mcp write ip whitelist lookup failed' });
    }
    if (!_isIpAllowed(req, ipBundle)) {
      const cip = _clientIp(req);
      logger?.warn?.(
        { event: 'mcp-write.auth.fail', path: req.path, reason: 'ip_not_allowed', client_ip: cip },
        'mcp-write authentication failed (ip not in whitelist)'
      );
      writeAudit({
        userId: null,
        action: 'mcp-write.auth.fail',
        target: 'mcp-write',
        payload: { client_ip: cip, path: req.path, reason: 'ip_not_allowed' }
      }, logger).catch(() => { /* best-effort audit, 0 必 throw */ });
      return res.status(403).json({
        error: 'ip_not_allowed',
        client_ip: cip,
        message: `Client IP ${cip} is not in the MCP write IP whitelist.`
      });
    }
    if (!bundle.current) {
      logger?.warn?.({ path: req.path }, 'mcp-write request rejected: no current token (operator must seed + reveal)');
      return res.status(503).json({ error: 'mcp-write not initialized' });
    }
    let matched = 'none';
    if (constantTimeEqual(supplied, bundle.current)) {
      matched = 'current';
    } else if (bundle.previous && constantTimeEqual(supplied, bundle.previous)) {
      matched = 'previous';
      logger?.warn?.(
        { path: req.path },
        'mcp-write authenticated with the PREVIOUS mcp write token (rotation overlap window still open)'
      );
    } else {
      logger?.warn?.(
        { event: 'mcp-write.auth.fail', path: req.path, reason: 'token mismatch' },
        'mcp-write authentication failed (token mismatch)'
      );
      return res.status(401).json({ error: 'invalid mcp write token' });
    }
    req._mcpWriteTokenMatched = matched;
    logger?.debug?.(
      { event: 'mcp-write.auth.ok', path: req.path, matched },
      'mcp-write authenticated'
    );
    return next();
  };
}
