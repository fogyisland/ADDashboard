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
import crypto from 'node:crypto';

// Fallback literal used when the db facade doesn't expose db.sql (ad-hoc
// test stubs). Must remain identical to db.sql.config.getAgentTokenBundle
// for both dialects — the SELECT is dialect-portable.
const FALLBACK_BUNDLE_SQL = "SELECT config_key, config_value FROM system_config WHERE config_key IN ('agent_token_current', 'agent_token_previous', 'agent_token_rotated_at', 'agent_token_previous_ttl_days')";

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

export function agentToken({ db, logger }) {
  // Resolve the bundle SELECT once from the db facade's SQL registry. If the
  // db facade has no sql config (e.g. a test stub), pass undefined so
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
    if (bundle.current && constantTimeEqual(supplied, bundle.current)) return next();
    if (bundle.previous && constantTimeEqual(supplied, bundle.previous)) {
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
      return next();
    }
    return res.status(401).json({ error: 'invalid agent token' });
  };
}
