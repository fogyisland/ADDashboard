// JWT signing + verification helpers. `signJwt` keeps its signature (callers
// pass the current secret explicitly); `verifyJwt` becomes a factory that
// takes a `{ current, previous }` bundle so a single verification tries the
// active secret first, then falls back to the previous one during a rotation
// overlap window.
//
// The bundle is opaque to this module — it does not know about caching or
// the DB. `userAuth` is responsible for loading the bundle (via
// `_loadJwtSecretBundle`) and for invalidating the cache on rotation.
import jwt from 'jsonwebtoken';

export function signJwt({ sub, role, permissions, tokenVersion }, secret, ttlSec = 3600) {
  const payload = {
    role,
    permissions: permissions ?? [],
    tokenVersion: tokenVersion ?? 0
  };
  return jwt.sign(payload, secret, { subject: String(sub), expiresIn: ttlSec });
}

export function verifyJwt(token, secrets) {
  if (typeof token !== 'string' || !token) return null;
  if (!secrets || typeof secrets !== 'object') return null;
  // Try current first, then previous. Any throw from jwt.verify (bad sig,
  // expired, malformed) is caught and we move on. Total miss returns null.
  for (const key of ['current', 'previous']) {
    const s = secrets[key];
    if (typeof s !== 'string' || !s) continue;
    try {
      const p = jwt.verify(token, s);
      return {
        sub: p.sub,
        role: p.role,
        permissions: p.permissions ?? [],
        tokenVersion: typeof p.tokenVersion === 'number' ? p.tokenVersion : 0,
        _matched: key // 'current' or 'previous' — caller logs warn if 'previous'
      };
    } catch {
      // try next key
    }
  }
  return null;
}