import jwt from 'jsonwebtoken';

export function signJwt({ sub, role, permissions }, secret, ttlSec = 3600) {
  const payload = { role, permissions: permissions ?? [] };
  return jwt.sign(payload, secret, { subject: String(sub), expiresIn: ttlSec });
}

export function verifyJwt(token, secret) {
  try {
    const p = jwt.verify(token, secret);
    return { sub: p.sub, role: p.role, permissions: p.permissions ?? [] };
  } catch {
    return null;
  }
}
