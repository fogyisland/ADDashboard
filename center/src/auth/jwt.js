import jwt from 'jsonwebtoken';

export function signJwt({ sub, role }, secret, ttlSec = 3600) {
  return jwt.sign({ role }, secret, { subject: String(sub), expiresIn: ttlSec });
}

export function verifyJwt(token, secret) {
  try {
    const p = jwt.verify(token, secret);
    return { sub: p.sub, role: p.role };
  } catch {
    return null;
  }
}
