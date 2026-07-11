import { Router } from 'express';
import { authenticate, recordLogin } from '../services/users.js';
import { signJwt } from '../auth/jwt.js';
import { writeAudit } from '../services/audit.js';

export function authRouter({ config, pool, logger }) {
  const r = Router();
  r.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'missing credentials' });
    const user = await authenticate(pool, username, password);
    if (!user) {
      await writeAudit(pool, { userId: null, action: 'login_failed', target: username, payload: null });
      return res.status(401).json({ error: 'invalid credentials' });
    }
    await recordLogin(pool, user.id);
    const token = signJwt({ sub: user.id, role: user.role }, config.jwtSecret, 8 * 3600);
    await writeAudit(pool, { userId: user.id, action: 'login', target: username, payload: null });
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  });
  return r;
}
