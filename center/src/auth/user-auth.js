import { verifyJwt } from './jwt.js';

// Per-request middleware. Requires a `db` facade exposing `query(sql, params)`
// and `sql` (used here to resolve the token_version/status SELECT string).
// On a valid JWT, the middleware fetches the user's current `token_version`
// and `status` from the DB and rejects mismatches with three distinct 401
// messages — operators reading the response can tell whether the user was
// deleted, disabled, or had their tokens revoked.
export function userAuth({ secret, db }) {
  return async (req, res, next) => {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/);
    if (!m) return res.status(401).json({ error: 'missing token' });
    const v = verifyJwt(m[1], secret);
    if (!v) return res.status(401).json({ error: 'invalid token' });
    try {
      const { rows } = await db.query(db.sql.users.getAuthStatus, [v.sub]);
      const row = rows[0];
      if (!row) return res.status(401).json({ error: 'user not found' });
      if (row.status !== 1) return res.status(401).json({ error: 'user disabled' });
      if (Number(row.token_version) !== v.tokenVersion) return res.status(401).json({ error: 'token revoked' });
      req.user = { ...v, status: row.status };
      next();
    } catch (e) {
      // Surface DB failures as 500 (not as a thrown exception bubbling to
      // Express's default error handler), so callers see the same JSON
      // shape other routes use for internal errors: { error: 'internal' }.
      res.status(500).json({ error: 'internal' });
    }
  };
}
