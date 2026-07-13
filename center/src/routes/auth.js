import { Router } from 'express';
import { authenticate, recordLogin } from '../services/users.js';
import { signJwt } from '../auth/jwt.js';
import { writeAudit } from '../services/audit.js';

export function authRouter({ config, logger }) {
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
    const token = signJwt({ sub: user.id, role: user.role, permissions: user.permissions }, config.jwtSecret, 8 * 3600);
    await writeAudit({ userId: user.id, action: 'login', target: username, payload: null }, logger);
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  });
  return r;
}
