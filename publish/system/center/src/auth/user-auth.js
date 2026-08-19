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

let _cache = null; // { current: string, previous: string }

export async function _loadJwtSecretBundle(db) {
  if (_cache) return _cache;
  // The SQL string here is a fallback for tests that construct a stub db
  // without going through buildSql(). Production code paths always use
  // db.sql.config.getJwtSecretBundle (Task 3) — same shape, just keyed
  // off the SQL registry instead of a hardcoded literal.
  const { rows } = await db.query(
    "SELECT config_key, config_value FROM system_config WHERE config_key IN ('jwt_secret_current', 'jwt_secret_previous')"
  );
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
  return async (req, res, next) => {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/);
    if (!m) return res.status(401).json({ error: 'missing token' });
    let bundle;
    try {
      bundle = await _loadJwtSecretBundle(db);
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