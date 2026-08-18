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
import crypto from 'node:crypto';

let _cache = null; // { current: string, previous: string }

export async function _loadAgentTokenBundle(db) {
  if (_cache) return _cache;
  const { rows } = await db.query(
    // SQL string injected by the caller's `db` facade; see Task 3.
    // We accept any db facade that returns { rows: [{ config_key, config_value }] }
    // for the bundle SELECT. The exact SQL lives in db.sql.config.getAgentTokenBundle.
    // (We intentionally keep this string here as a fallback for tests that
    //  construct a stub db without going through buildSql.)
    "SELECT config_key, config_value FROM system_config WHERE config_key IN ('agent_token_current', 'agent_token_previous')"
  );
  const map = Object.fromEntries(rows.map(r => [r.config_key, r.config_value]));
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

export function agentToken({ db }) {
  return async (req, res, next) => {
    const supplied = req.headers['x-agent-token'];
    if (typeof supplied !== 'string' || supplied === '') {
      return res.status(401).json({ error: 'invalid agent token' });
    }
    let bundle;
    try {
      bundle = await _loadAgentTokenBundle(db);
    } catch (e) {
      // Distinguish auth failure (401) from server failure (503) — an
      // operator looking at the dashboard needs to know whether the agent
      // sent a wrong token or the center can't reach its own DB.
      return res.status(503).json({ error: 'agent token lookup failed' });
    }
    if (bundle.current && constantTimeEqual(supplied, bundle.current)) return next();
    if (bundle.previous && constantTimeEqual(supplied, bundle.previous)) {
      req._agentTokenMatchedPrevious = true;
      return next();
    }
    return res.status(401).json({ error: 'invalid agent token' });
  };
}
