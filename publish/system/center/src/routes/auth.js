import { Router } from 'express';
import { authenticate, recordLogin } from '../services/users.js';
import { signJwt } from '../auth/jwt.js';
import { writeAudit } from '../services/audit.js';
import { getCurrentJwtSecret } from '../services/jwt-secret.js';

export function authRouter({ config, db, logger }) {
  const r = Router();
  r.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'missing credentials' });
    const user = await authenticate(username, password);
    if (!user) {
      await writeAudit({ userId: null, action: 'login_failed', target: username, payload: null }, logger);
      return res.status(401).json({ error: 'invalid credentials' });
    }
    await recordLogin(user.id);
    // I9 T7-fix (critical): sign with the DB-loaded current secret, not the
    // stale appsettings.json value. After a rotation `config.jwtSecret` is
    // the old key — the server's verify path accepts current + previous,
    // but freshly-issued tokens must use the current row or every request
    // gets a 401 on the very next hop.
    const secret = db
      ? await getCurrentJwtSecret(db)
      : config.jwtSecret;
    const token = signJwt({ sub: user.id, role: user.role_name, permissions: user.permissions, tokenVersion: user.tokenVersion }, secret, 8 * 3600);
    await writeAudit({ userId: user.id, action: 'login', target: username, payload: null }, logger);
    res.json({ token, user: { id: user.id, username: user.username, role: user.role_name } });
  });
  return r;
}
