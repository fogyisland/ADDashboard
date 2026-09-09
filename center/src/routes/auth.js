import { Router } from 'express';
import { authenticate, recordLogin } from '../services/users.js';
import { signJwt } from '../auth/jwt.js';
import { writeAudit } from '../services/audit.js';
import { getCurrentJwtSecret } from '../services/jwt-secret.js';

// 2026-09-09 S82 (security) — login brute-force protection. Without this,
// POST /api/auth/login accepts unlimited retries — bcrypt rounds=12 means
// ~250ms per attempt, so an attacker can grind through a 6-char password
// in hours. Map<key, {fails, firstAt}> per (ip, username) pair; after
// MAX_FAILS within WINDOW_MS we 429 with a Retry-After header. Successful
// login clears the entry. In-memory only — a process restart resets the
// counter, which is fine (an attacker would have to ride a restart AND
// keep their previous IP+username pace). No `express-rate-limit` dep.
const MAX_FAILS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const _failBuckets = new Map();

function _bucketFor(ip, username) {
  const key = `${ip}:${username}`;
  const now = Date.now();
  const entry = _failBuckets.get(key);
  if (!entry) return null;
  if (now - entry.firstAt >= WINDOW_MS) {
    _failBuckets.delete(key);
    return null;
  }
  return { key, entry };
}

function _recordFail(ip, username) {
  const key = `${ip}:${username}`;
  const now = Date.now();
  const entry = _failBuckets.get(key);
  if (!entry || now - entry.firstAt >= WINDOW_MS) {
    _failBuckets.set(key, { fails: 1, firstAt: now });
    return { fails: 1, firstAt: now };
  }
  entry.fails += 1;
  return { fails: entry.fails, firstAt: entry.firstAt };
}

function _clearFails(ip, username) {
  _failBuckets.delete(`${ip}:${username}`);
}

// Test helper — reset the in-memory bucket state.
export function _resetLoginRateLimitForTests() {
  _failBuckets.clear();
}

export function authRouter({ config, db, logger }) {
  const r = Router();
  r.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'missing credentials' });
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const bucket = _bucketFor(ip, username);
    if (bucket && bucket.entry.fails >= MAX_FAILS) {
      const retryAfterSec = Math.max(1, Math.ceil((WINDOW_MS - (Date.now() - bucket.entry.firstAt)) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({ error: 'too many failed login attempts; retry later' });
    }
    const user = await authenticate(username, password);
    if (!user) {
      const updated = _recordFail(ip, username);
      await writeAudit({ userId: null, action: 'login_failed', target: username, payload: { failsInWindow: updated.fails } }, logger);
      return res.status(401).json({ error: 'invalid credentials' });
    }
    _clearFails(ip, username);
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
