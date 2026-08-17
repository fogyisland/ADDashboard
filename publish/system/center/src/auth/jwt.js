import jwt from 'jsonwebtoken';

export function signJwt({ sub, role, permissions, tokenVersion }, secret, ttlSec = 3600) {
  const payload = {
    role,
    permissions: permissions ?? [],
    tokenVersion: tokenVersion ?? 0
  };
  return jwt.sign(payload, secret, { subject: String(sub), expiresIn: ttlSec });
}

export function verifyJwt(token, secret) {
  try {
    const p = jwt.verify(token, secret);
    return {
      sub: p.sub,
      role: p.role,
      permissions: p.permissions ?? [],
      tokenVersion: typeof p.tokenVersion === 'number' ? p.tokenVersion : 0
    };
  } catch {
    return null;
  }
}
