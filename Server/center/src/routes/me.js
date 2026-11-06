// R158.104 (2026-10-14) — self-service /api/me/* router. 3 endpoints:
//   GET  /api/me/profile         — current user info (id / username / role / status / lastLoginAt / createdAt)
//   POST /api/me/change-password — change own password (bcrypt verify + bumpTokenVersion)
//   POST /api/me/logout-all      — bumpTokenVersion only (revoke all live JWTs)
//
// All 3 endpoints carry [requireAuth (userAuth)] and NO requirePerm —
// every logged-in user can self-service. Class R112 eventlog / R116
// os-baseline 1:1 parallel (auth-required, no perm gate). The frontend
// surfaces them via the UserWidget popover in the AppLayout sidebar
// (web/src/components/UserWidget.vue).
//
// Wire shape:
//   GET  /api/me/profile           → 200 { id, username, role, status, lastLoginAt, createdAt }
//                                       401 missing / invalid / revoked token
//                                       404 user not found
//   POST /api/me/change-password   → 200 { ok: true, newVersion }
//                                       400 { error: 'password_too_short' | 'password_reused' | 'invalid_old_password' }
//                                       401 missing / invalid / revoked token
//                                       404 user not found
//   POST /api/me/logout-all        → 200 { ok: true, newVersion }
//                                       401 missing / invalid / revoked token
//                                       404 user not found
//
// Audit classification mirrors the admin user-CRUD audit log shape
// (R158.69 precedent): action ∈ {self_password_change, self_token_revoke},
// userId = req.user.sub (the actor), target = username (the affected row
// is the same user here, but keeping `target` populated means future
// audit-log views can filter uniformly).
import { Router } from 'express';
import { getMeProfile, changeMyPassword } from '../services/users.js';
import { bumpTokenVersion } from '../services/users.js';
import { writeAudit } from '../services/audit.js';

export function createMeRouter({ db, requireAuth }) {
  const r = Router();

  // GET /api/me/profile — read-only profile. Never returns password_hash
  // or token_version (getMeProfile is the curated projection).
  r.get('/api/me/profile', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.sub;
      if (!userId) return res.status(401).json({ error: 'no subject' });
      const profile = await getMeProfile(userId);
      if (!profile) return res.status(404).json({ error: 'user not found' });
      res.json(profile);
    } catch (e) {
      req.log?.error?.({ event: 'me.profile_failed', err: e?.message }, 'me profile lookup failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // POST /api/me/change-password — self-service password rotation.
  // Body: { oldPassword, newPassword }. newPassword must be >= 8 chars
  // and must not equal the current password.
  r.post('/api/me/change-password', requireAuth, async (req, res) => {
    const { oldPassword, newPassword } = req.body || {};
    if (typeof oldPassword !== 'string' || !oldPassword
        || typeof newPassword !== 'string' || !newPassword) {
      return res.status(400).json({ error: 'missing old or new password' });
    }
    const userId = req.user?.sub;
    if (!userId) return res.status(401).json({ error: 'no subject' });
    try {
      const result = await changeMyPassword(userId, oldPassword, newPassword);
      if (!result.ok) {
        // Map service-layer error codes to HTTP statuses. The widget
        // surfaces the .error string verbatim, so keep the codes stable.
        if (result.error === 'invalid_old_password') return res.status(400).json({ error: result.error });
        if (result.error === 'password_too_short' || result.error === 'password_reused') return res.status(400).json({ error: result.error });
        if (result.error === 'user_not_found') return res.status(404).json({ error: result.error });
        return res.status(500).json({ error: 'internal' });
      }
      // Audit AFTER successful write. Use writeAudit (NOT writeAuditRequired)
      // — a self-service password change must not 500 the response because
      // the audit table is unreachable; the password is already changed.
      // Class agent-token reveal precedent: R158.102 adminMcpRouter uses
      // writeAudit inside the transaction; here we use writeAudit outside
      // because the password write already committed in changeMyPassword.
      await writeAudit({
        userId,
        action: 'self_password_change',
        target: req.user?.username ?? null,
        payload: { newVersion: result.newVersion }
      }, req.log);
      res.json({ ok: true, newVersion: result.newVersion });
    } catch (e) {
      req.log?.error?.({ event: 'me.change_password_failed', err: e?.message }, 'me change password failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  // POST /api/me/logout-all — bump token_version so every live JWT for
  // this user is immediately rejected. The current request's JWT is
  // ALREADY verified by userAuth (it was issued before the bump), so the
  // response will return 200; the NEXT request from this user will 401.
  r.post('/api/me/logout-all', requireAuth, async (req, res) => {
    const userId = req.user?.sub;
    if (!userId) return res.status(401).json({ error: 'no subject' });
    try {
      // Defensive: confirm the user still exists. Otherwise bumpTokenVersion
      // on a non-existent row is a silent no-op and the response lies.
      const profile = await getMeProfile(userId);
      if (!profile) return res.status(404).json({ error: 'user not found' });
      const newVersion = await bumpTokenVersion(userId);
      await writeAudit({
        userId,
        action: 'self_token_revoke',
        target: req.user?.username ?? null,
        payload: { newVersion }
      }, req.log);
      res.json({ ok: true, newVersion });
    } catch (e) {
      req.log?.error?.({ event: 'me.logout_all_failed', err: e?.message }, 'me logout-all failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  return r;
}
