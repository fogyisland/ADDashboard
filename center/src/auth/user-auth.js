import { verifyJwt } from './jwt.js';

export function userAuth({ secret }) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/);
    if (!m) return res.status(401).json({ error: 'missing token' });
    const v = verifyJwt(m[1], secret);
    if (!v) return res.status(401).json({ error: 'invalid token' });
    req.user = v;
    next();
  };
}