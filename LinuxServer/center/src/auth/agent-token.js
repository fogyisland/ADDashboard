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
// To avoid breaking older agents in the field, the unsigned-request
// grace window is 60 seconds after each process restart. Beyond that
// window, missing signature = 401 'missing agent signature'. Mismatched
// signature = 401 'identity mismatch' immediately.
import crypto from 'node:crypto';

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
// process restart, 60s window where old agents (no signature lib) keep
// working. Restart marker is set when the module is first imported;
// tests can override with _resetIdentityGraceForTests.
const IDENTITY_GRACE_MS = 60 * 1000;
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
        'agent request missing X-Agent-Signature within 60s restart grace (S82) — accepted with warning'
      );
    } else {
      const ok = verifySignature({ suppliedSig, token: activeToken, hostname, agentId, body: req.body });
      if (!ok) {
        logger?.warn?.(
          { path: req.path, agentId, hostname },
          'agent signature mismatch (S82 identity binding) — possible impersonation'
        );
        return res.status(401).json({ error: 'identity mismatch' });
      }
      req._agentIdentityBound = { hostname, agentId };
    }
    return next();
  };
}