// Per-request middleware that loads the JWT signing-secret bundle from
// `system_config` (rows `jwt_secret_current`, `jwt_secret_previous`) and
// verifies the bearer token against both. The bundle is cached for the
// process lifetime; rotate/commit handlers MUST call
// `invalidateJwtSecretCache()` after a write so the very next request sees
// the new state.
//
// On a valid JWT the middleware fetches the user's current `token_version`
// and `status` from the DB and rejects mismatches with three distinct 401
// messages — operators reading the response can tell whether the user was
// deleted, disabled, or had their tokens revoked.
//
// This module never logs the secret or its length (per spec §5). It logs a
// `warn` line on previous-secret match (operator's signal that a straggler
// is still on the old key) and an `error` if the DB lookup itself throws.
import { verifyJwt } from './jwt.js';

// Fallback literal used when the db facade doesn't expose db.sql (ad-hoc
// test stubs). Must remain identical to db.sql.config.getJwtSecretBundle
// for both dialects — the SELECT is dialect-portable. I9 T7-fix (important):
// the previous version hardcoded a 2-key literal here. Production code
// always supplies the db facade via buildSql() (see server.js), so the
// 4-key registry string is now used end-to-end. This fallback only fires
// for ad-hoc test stubs that construct a minimal db without db.sql.
const FALLBACK_BUNDLE_SQL = "SELECT config_key, config_value FROM system_config WHERE config_key IN ('jwt_secret_current', 'jwt_secret_previous', 'jwt_secret_rotated_at', 'jwt_secret_previous_ttl_days')";

let _cache = null; // { current: string, previous: string }

export async function _loadJwtSecretBundle(db, sql) {
  if (_cache) return _cache;
  const effectiveSql = sql
    || db?.sql?.config?.getJwtSecretBundle
    || FALLBACK_BUNDLE_SQL;
  const { rows } = await db.query(effectiveSql);
  const map = Object.fromEntries((rows || []).map(r => [r.config_key, r.config_value]));
  _cache = {
    current: map.jwt_secret_current ?? '',
    previous: map.jwt_secret_previous ?? ''
  };
  return _cache;
}

export function invalidateJwtSecretCache() {
  _cache = null;
}

export function userAuth({ db, logger }) {
  // Resolve the bundle SELECT once from the db facade's SQL registry. If
  // the db facade has no sql config (e.g. a test stub), pass undefined so
  // _loadJwtSecretBundle falls back to FALLBACK_BUNDLE_SQL — matches the
  // proven pattern in agent-token.js (I3).
  const bundleSql = db?.sql?.config?.getJwtSecretBundle;
  return async (req, res, next) => {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/);
    if (!m) return res.status(401).json({ error: 'missing token' });
    let bundle;
    try {
      bundle = await _loadJwtSecretBundle(db, bundleSql);
    } catch (e) {
      logger?.error?.({ err: e }, 'userAuth: jwt_secret bundle lookup failed');
      return res.status(500).json({ error: 'internal' });
    }
    const v = verifyJwt(m[1], bundle);
    if (!v) return res.status(401).json({ error: 'invalid token' });
    if (v._matched === 'previous') {
      req._jwtSecretMatchedPrevious = true;
      logger?.warn?.({ path: req.path, sub: v.sub }, 'userAuth: token verified with previous JWT secret (rotation overlap)');
    }
    try {
      const { rows } = await db.query(db.sql.users.getAuthStatus, [v.sub]);
      const row = rows[0];
      if (!row) return res.status(401).json({ error: 'user not found' });
      if (row.status !== 1) return res.status(401).json({ error: 'user disabled' });
      if (Number(row.token_version) !== v.tokenVersion) return res.status(401).json({ error: 'token revoked' });
      req.user = { sub: v.sub, role: v.role, permissions: v.permissions, tokenVersion: v.tokenVersion, status: row.status };
      next();
    } catch (e) {
      logger?.error?.({ err: e }, 'userAuth: users.getAuthStatus lookup failed');
      res.status(500).json({ error: 'internal' });
    }
  };
}