// Shared-secret comparison middleware for the agent → center channel.
// At runtime the canonical secret lives in `system_config.agent_token_current`;
// `agent_token_previous` is set during a rotation overlap window so existing
// agents can keep using the old token while the operator rolls the new one
// out to each agent and restarts it.
//
// Comparison is constant-time via crypto.timingSafeEqual to prevent timing
// side-channels leaking the secret byte-by-byte. Mismatched-length compares
// short-circuit (length is fixed by design — 96 hex chars — so length leak
// is not sensitive).
//
// The bundle is cached for the process lifetime; invalidate via
// `invalidateAgentTokenCache()` from the rotate/commit handlers so the very
// next request sees the new state.
//
// A previous-token match emits one warn line (spec §5) carrying
// `{ path, agentId }` — never the token. `logger` is optional; callers that
// have no logger in scope simply get no warn.
//
// The bundle SELECT comes from `db.sql.config.getAgentTokenBundle` (Task 3,
// I3) when the caller supplies a real db facade built via buildSql(). Tests
// that construct ad-hoc stub dbs without db.sql fall back to a literal SQL
// string matching the registry contract so stub query() functions keep
// working.
//
// 2026-09-09 S82 (security) — agent identity binding. After token
// validation, the middleware verifies the `X-Agent-Signature` header
// against the request body + hostname + agentId when present. Without
// this, agent A could authenticate with their valid token and then
// claim hostname=B in the body — impersonating B's reporting surface.
//
// To avoid breaking older agents in the field, an unsigned-request grace
// window was originally 60 seconds after each process restart.
// R161.30 S2 (2026-11-07): the grace default is now 0 (fail-closed) — every
// in-field agent tree signs its requests, so the window only served as an
// impersonation window after each center restart. Opt back in via
// ADDASHBOARD_AGENT_IDENTITY_GRACE_MS if ever needed. Beyond the window
// (now: always), missing signature = 401 'missing agent signature'.
// Mismatched signature = 401 'identity mismatch' immediately.
import crypto from 'node:crypto';
// R161.34 (2026-11-07) — per-agent 签名密钥 service (A-F1 修复)。
//   验签时按 agentId 反查该机的密钥 —— 共享 token 只能证明"持有 token
//   的人签了这条请求", per-agent 密钥才能证明"**这台机器**签了这条请求"。
import { lookupSigningKey } from '../services/agent-signing-key.js';

// Fallback literal used when the db facade doesn't expose db.sql (ad-hoc
// test stubs). Must remain identical to db.sql.config.getAgentTokenBundle
// for both dialects — the SELECT is dialect-portable.
const FALLBACK_BUNDLE_SQL = "SELECT config_key, config_value FROM system_config WHERE config_key IN ('agent_token_current', 'agent_token_previous', 'agent_token_rotated_at', 'agent_token_version')";

let _cache = null; // { current: string, previous: string }

export async function _loadAgentTokenBundle(db, sql) {
  if (_cache) return _cache;
  const effectiveSql = sql
    || db?.sql?.config?.getAgentTokenBundle
    || FALLBACK_BUNDLE_SQL;
  const { rows } = await db.query(effectiveSql);
  const map = Object.fromEntries((rows || []).map(r => [r.config_key, r.config_value]));
  _cache = {
    current: map.agent_token_current ?? '',
    previous: map.agent_token_previous ?? ''
  };
  return _cache;
}

export function invalidateAgentTokenCache() {
  _cache = null;
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// 2026-09-09 S82 (security) — unsigned-request grace window. After
// process restart, old agents (no signature lib) keep working for
// IDENTITY_GRACE_MS. Restart marker is set when the module is first
// imported; tests can override with _resetIdentityGraceForTests.
//
// R161.30 S2 (2026-11-07) — grace 默认收紧为 **0 (fail-closed)**:
//   - 全部在野 agent 树 (Server/agent + Server/noadagent) 的出站请求
//     已经由 agent.js 的 signedRequestJson / agentHttpGetBinary wrapper
//     统一盖 X-Agent-Signature (R91.4 / R93.1 收口)，grace 已无保护对象;
//   - R161.29 单端口后老 Agent (硬编码 :8081/:8082) 本来就静默 404，
//     grace 不再换回任何兼容性;
//   - 60s 窗口 = 每次 center 重启后一个免签冒充窗口，收益为负。
//   逃生阀: 环境变量 ADDASHBOARD_AGENT_IDENTITY_GRACE_MS (毫秒, >=0)，
//   仅当操作员明确要混入未升级 agent 时才设置；负值钳为 0。
const IDENTITY_GRACE_MS = Math.max(
  0,
  Number(process.env.ADDASHBOARD_AGENT_IDENTITY_GRACE_MS ?? 0) || 0
);
let _processStartedAt = Date.now();

export function _resetIdentityGraceForTests(now = Date.now()) {
  _processStartedAt = now;
}

// Stable JSON serialization — must match agent/src/lib/agent-identity.js
// so a signature generated on the agent verifies on the center.
function stableJson(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableJson).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
}

function expectedSignature({ token, hostname, agentId, body }) {
  // GET requests have no body, but express.json() middleware sets
  // `req.body = {}` for them (instead of `null`/`undefined`). Real agents
  // (and mock-daemon) sign GETs with `body: null`, which the equality below
  // also normalizes to ''. Without this normalization, every GET request
  // after the 60s restart-grace window fails with 'identity mismatch' even
  // though the token itself is valid.
  const bodyStr = (body == null
    || (typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0))
    ? '' : stableJson(body);
  const message = `${hostname || ''}:${agentId || ''}:${bodyStr}`;
  return crypto.createHmac('sha256', token).update(message).digest('hex');
}

// Body re-stringification for verification. express.json() has already
// parsed the body; we re-serialize with stableJson so the agent's
// on-wire ordering doesn't matter.
function verifySignature({ suppliedSig, token, hostname, agentId, body }) {
  if (typeof suppliedSig !== 'string' || suppliedSig.length === 0) return false;
  const expected = expectedSignature({ token, hostname, agentId, body });
  if (expected.length !== suppliedSig.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(suppliedSig));
  } catch {
    return false;
  }
}

// R161.34 (2026-11-07) — 取该 agent 的 per-agent 签名密钥 (A-F1)。
//
// 返回形状:
//   { key, version, revoked, lookupFailed }
//   · key           — 该机的密钥 (没有则为 null ⇒ 走共享 token 回退)
//   · revoked       — 该机密钥已被吊销 (⇒ 一律 401)
//   · lookupFailed  — DB 查询失败 (⇒ 503, **绝不**降级成共享 token 验签)
//
// ★ 为什么 lookupFailed 必须 fail-closed:
//   如果 DB 抖动时降级成"用共享 token 验签就算过", 那攻击者只要持有
//   共享 token, 就能冒充任意一台**已领过 per-agent 密钥**的机器 ——
//   一次 DB 抖动就把修复效果清零。⇒ 宁可 503。
async function resolvePerAgentVerification({ db, agentId, logger }) {
  const id = String(agentId || '').trim();
  if (!id) {
    // 没有 agentId ⇒ 无从反查该机的密钥 ⇒ 走共享 token 路径
    // (存量 agent 的 GET /config.json 就是 hostname/agentId 为空串)。
    return { key: null, version: 0, revoked: false, lookupFailed: false };
  }
  const { row, error } = await lookupSigningKey(db, id);
  if (error) {
    logger?.error?.({ err: error.message, agentId: id }, 'per-agent signing key lookup failed');
    return { key: null, version: 0, revoked: false, lookupFailed: true };
  }
  if (!row) {
    // 该机还没领过 per-agent 密钥 (存量 agent) ⇒ 共享 token 路径。
    return { key: null, version: 0, revoked: false, lookupFailed: false };
  }
  return {
    key: row.signing_key || null,
    version: Number(row.key_version || 0),
    revoked: Boolean(row.revoked_at),
    lookupFailed: false
  };
}

export function agentToken({ db, logger }) {
  // Resolve the bundle SELECT once from the db facade's SQL registry. If
  // the db facade has no sql config (e.g. a test stub), pass undefined so
  // _loadAgentTokenBundle falls back to FALLBACK_BUNDLE_SQL.
  const bundleSql = db?.sql?.config?.getAgentTokenBundle;
  return async (req, res, next) => {
    const supplied = req.headers['x-agent-token'];
    if (typeof supplied !== 'string' || supplied === '') {
      return res.status(401).json({ error: 'invalid agent token' });
    }
    let bundle;
    try {
      bundle = await _loadAgentTokenBundle(db, bundleSql);
    } catch (e) {
      // Distinguish auth failure (401) from server failure (503) — an
      // operator looking at the dashboard needs to know whether the agent
      // sent a wrong token or the center can't reach its own DB.
      return res.status(503).json({ error: 'agent token lookup failed' });
    }
    let activeToken = null;
    if (bundle.current && constantTimeEqual(supplied, bundle.current)) {
      activeToken = bundle.current;
    } else if (bundle.previous && constantTimeEqual(supplied, bundle.previous)) {
      activeToken = bundle.previous;
      req._agentTokenMatchedPrevious = true;
      // Spec §5 / C6: warn once per request that hits the OLD token. This
      // line is the operator's only per-agent signal that some agent hasn't
      // been rolled over yet — GET /api/admin/agent-token only reports that
      // the overlap window is open, not who is still behind. Committing
      // before every straggler has appeared here locks that agent out.
      // Never log the token or its length. `logger` is optional (the
      // `logger?.warn?.()` idiom used throughout src/services) so callers
      // and tests that construct agentToken({ db }) keep working.
      logger?.warn?.(
        { path: req.path, agentId: req.headers['x-agent-id'] },
        'agent authenticated with the PREVIOUS agent token (rotation overlap window still open)'
      );
    } else {
      return res.status(401).json({ error: 'invalid agent token' });
    }

    // 2026-09-09 S82 (security) — identity binding. After token
    // validation, verify X-Agent-Signature against (hostname, agentId,
    // body). Missing signature is allowed for IDENTITY_GRACE_MS after
    // process start so old agents in the field don't immediately fail;
    // a warn is emitted for each unsigned request so the operator can
    // see how many stragglers still need the upgrade.
    const suppliedSig = req.headers['x-agent-signature'];
    const inGraceWindow = Date.now() - _processStartedAt < IDENTITY_GRACE_MS;
    const hostname = String(req.body?.hostname || req.headers['x-agent-hostname'] || '');
    const agentId = String(req.body?.agentId || req.headers['x-agent-id'] || '');
    if (!suppliedSig || suppliedSig === '') {
      if (!inGraceWindow) {
        logger?.warn?.(
          { path: req.path, agentId, hostname },
          'agent request missing X-Agent-Signature (S82 identity binding) — rejected'
        );
        return res.status(401).json({ error: 'missing agent signature' });
      }
      logger?.warn?.(
        { path: req.path, agentId, hostname, graceRemainingSec: Math.ceil((IDENTITY_GRACE_MS - (Date.now() - _processStartedAt)) / 1000) },
        `agent request missing X-Agent-Signature within ${IDENTITY_GRACE_MS}ms restart grace (S82) — accepted with warning`
      );
    } else {
      // R161.34 (2026-11-07, A-F1) — per-agent 签名密钥验签 (真正的修复)。
      //
      // ★ 为什么必须多这一层:
      //   共享 token 的 HMAC 只证明"**持有 token 的人**签了这条请求",
      //   不证明"**这台机器**签了这条请求" —— 因为 hostname / agentId
      //   全部是**请求方自报**的。⇒ 用 A 的合法 token + 伪造的
      //   hostname=B, 可以算出**完全合法**的签名 (密钥全局共享, 谁都会签)
      //   ⇒ 循环论证。
      //   ⇒ per-agent 密钥把"自报"变成"可反查": 中心按 agentId 取该机的
      //     密钥重算 HMAC ⇒ 冒充者没有 B 的密钥 ⇒ 算不出 B 的签名。
      //
      // ★★★ 验签路径的选择 (关键设计, 改这里之前先读这段):
      //
      //   情形 A — 该机**已有** per-agent 密钥 (库里查到了):
      //     ⇒ **只**用该机的密钥验签。**不回退**共享 token。
      //     ⇒ 为什么不能回退: 回退 = "共享 token 签的请求也算过"。而共享
      //       token 是**全 fleet 共用**的 ⇒ 任何一台机器 (或任何拿到
      //       token 的人) 都能用它算出任意 agentId 的合法签名 ⇒
      //       per-agent 密钥的保护被**完全绕过** ⇒ A-F1 白修。
      //       (这条被 end-to-end 测试抓到过: 中心"per-agent 优先 → 失败
      //        回退共享 token"的写法下, 伪造请求照样过。)
      //     ⇒ 该机的 agent 必须已经用新密钥签名 (下发后自动切换,
      //       见 services/agent-signing-key.js 的 buildSigningKeyDelivery)。
      //
      //   情形 B — 该机**还没有** per-agent 密钥 (存量 agent):
      //     ⇒ 走共享 token 验签 (旧路径, 零改造兼容)。
      //     ⇒ 该机下一次心跳就会领到密钥并自动切换到情形 A。
      //
      //   情形 C — per-agent 密钥被吊销 ⇒ 一律 401 (已在上面处理)。
      //
      //   情形 D — DB 查询失败 ⇒ 503 (已在上面处理, 绝不降级)。
      const perAgent = await resolvePerAgentVerification({ db, agentId, logger });
      if (perAgent.lookupFailed) {
        return res.status(503).json({ error: 'agent identity lookup failed' });
      }
      // 该机的密钥已被吊销 ⇒ 一律拒绝 (不落到共享 token 回退路径 ——
      //   否则吊销就形同虚设: 该机仍可以用共享 token 继续冒充)。
      if (perAgent.revoked) {
        logger?.warn?.(
          { path: req.path, agentId, hostname },
          'agent signing key revoked — request rejected'
        );
        return res.status(401).json({ error: 'agent signing key revoked' });
      }

      let ok = false;
      if (perAgent.key) {
        // 情形 A: 该机已有专属密钥 ⇒ **只**用它验签 (不回退共享 token)。
        ok = verifySignature({ suppliedSig, token: perAgent.key, hostname, agentId, body: req.body });
      } else {
        // 情形 B: 该机还没有专属密钥 (存量 agent) ⇒ 共享 token 路径。
        ok = verifySignature({ suppliedSig, token: activeToken, hostname, agentId, body: req.body });
      }
      if (!ok) {
        logger?.warn?.(
          { path: req.path, agentId, hostname, usedPerAgentKey: Boolean(perAgent.key) },
          'agent signature mismatch (S82 identity binding) — possible impersonation'
        );
        return res.status(401).json({ error: 'identity mismatch' });
      }
      req._agentIdentityBound = { hostname, agentId };
      // 该机已用 per-agent 密钥签名 ⇒ 中心持有的那把就是它的真身凭据。
      // 把它挂到 req 上, 供 heartbeat 路由决定"要不要再下发一次"。
      if (perAgent.key) {
        req._agentSigningKeyVerified = { agentId, keyVersion: perAgent.version };
      }
    }
    return next();
  };
}