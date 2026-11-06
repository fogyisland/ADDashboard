import bcrypt from 'bcryptjs';
import { getDb } from '../db/index.js';
import { hashPassword, verifyPassword } from '../auth/password.js';

// Decode the comma-separated permissions string produced by GROUP_CONCAT (mysql)
// or STRING_AGG (mssql) in users.findByUsername. Tolerant of test mocks that
// already pass arrays, and of null when the user has no role or the role has
// no permissions.
function decodePermissions(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  if (typeof value !== 'string') return [];
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

export async function findByUsername(username) {
  const db = getDb();
  const { rows } = await db.query(db.sql.users.findByUsername, [username]);
  const row = rows[0];
  if (!row) return null;
  row.permissions = decodePermissions(row.permissions);
  // Default 0 keeps the code defensive even if migration 015 hasn't run
  // (the DB default is 0 anyway, so this only matters in a hypothetical
  // pre-migration scenario where the column doesn't exist yet).
  row.tokenVersion = Number(row.token_version ?? 0);
  return row;
}

export async function listUsers() {
  const db = getDb();
  const { rows } = await db.query(db.sql.users.list);
  return rows;
}

export async function createUser({ username, password, roleId, status }) {
  const db = getDb();
  const passwordHash = await bcrypt.hash(password, 12);
  await db.execute(db.sql.users.create, [username, passwordHash, roleId, status ?? 1]);
}

export async function updateUser(id, { password, roleId, status }, tx = null) {
  const conn = tx ?? getDb();
  const passwordHash = password ? await bcrypt.hash(password, 12) : null;
  await conn.execute(conn.sql.users.update, [passwordHash, roleId ?? null, status ?? null, id]);
  // Bump token_version iff a JWT-invalidating field changed. roleId/status
  // use != null (so explicit 0/null still bumps); password uses truthy
  // (so empty-string/blank inputs don't bump; existing service treats
  // them as no-op too).
  if (password || roleId != null || status != null) {
    await bumpTokenVersion(id, conn);
  }
}

export async function deleteUser(id) {
  const db = getDb();
  await db.execute(db.sql.users.delete, [id]);
}

export async function recordLogin(id) {
  const db = getDb();
  await db.execute(db.sql.users.recordLogin, [id]);
}

export async function authenticate(username, password) {
  const user = await findByUsername(username);
  if (!user || user.status !== 1) return null;
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return null;
  await recordLogin(user.id);
  return user;
}

export async function countAdmins() {
  const db = getDb();
  const { rows } = await db.query(db.sql.users.countAdmins);
  return rows[0]?.n ?? 0;
}

// I1: bump token_version by 1 and return the new value. `tx` may be a
// caller's open transaction wrapper (so the bump commits atomically with
// the surrounding data write); pass null to use the global db facade.
// Backed by db.sql.users.bumpTokenVersion (ANSI-safe UPDATE col = col + 1).
export async function bumpTokenVersion(userId, tx = null) {
  const conn = tx ?? getDb();
  await conn.execute(conn.sql.users.bumpTokenVersion, [userId]);
  const { rows } = await conn.query(conn.sql.users.getTokenVersion, [userId]);
  return Number(rows[0]?.token_version ?? 0);
}

// R158.104 (2026-10-14) — self-service Profile (GET /api/me/profile).
// Reuses the db.sql.users.meProfile helper added in this ship (1:1 parallel
// to findByUsername, MINUS password_hash / token_version). Returns null if
// the row is gone (operator deleted the user between JWT issue + request).
export async function getMeProfile(userId) {
  const db = getDb();
  const { rows } = await db.query(db.sql.users.meProfile, [userId]);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role_name,
    status: row.status,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at
  };
}

// R158.104 (2026-10-14) — self-service change password (POST /api/me/change-password).
// Returns a result envelope so the route can return 200/400/401 distinctly:
//   { ok: true,  userId }
//   { ok: false, error: 'user_not_found' | 'invalid_old_password' | 'password_too_short' | 'password_reused' }
//
// Side effect: on success, calls bumpTokenVersion(userId) so every JWT for
// this user becomes invalid (same precedent as admin updateUser at line 48
// — "JWT-invalidating field changed"). The user must re-login.
//
// Notes:
//   · findByUsername is reused to get the current password_hash (it returns
//     the full row including hash + role + perms); we never log the hash.
//   · verifyPassword is the centralized bcrypt wrapper (auth/password.js:9).
//   · hashPassword is the centralized bcrypt wrapper (auth/password.js:5).
//     Hard-coded 12 rounds (password.js:3), matching the existing createUser
//     / updateUser path. No 2nd source of truth.
export async function changeMyPassword(userId, oldPassword, newPassword) {
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return { ok: false, error: 'password_too_short' };
  }
  // Look up the user by their current id (NOT by username — the id came
  // from req.user.sub, which is the JWT subject). findByUsername needs
  // the username, so we go through the lighter getAuthStatus path... but
  // getAuthStatus only returns token_version + status, not password_hash.
  // The cleanest path is to re-use findByUsername: look up by username via
  // the row id (cheaper: a single SELECT by PK would be ideal, but we
  // don't have one in the SQL registry; the existing findByUsername works
  // for both). For a self-service endpoint, the username can be derived
  // from req.user.sub lookup via getMeProfile.
  const db = getDb();
  const profile = await getMeProfile(userId);
  if (!profile) return { ok: false, error: 'user_not_found' };
  // Re-use findByUsername to grab the password_hash. This costs an extra
  // SELECT but keeps the service layer single-source-of-truth on auth
  // (no new SQL helper needed for a one-off self-service flow).
  const user = await findByUsername(profile.username);
  if (!user) return { ok: false, error: 'user_not_found' };
  const oldOk = await verifyPassword(oldPassword, user.password_hash);
  if (!oldOk) return { ok: false, error: 'invalid_old_password' };
  // Refuse to "change" to the same password (defense against trivial
  // "click confirm, nothing changes" workflows + audit-noise reduction).
  const sameHash = await verifyPassword(newPassword, user.password_hash);
  if (sameHash) return { ok: false, error: 'password_reused' };
  const newHash = await hashPassword(newPassword);
  await db.execute(db.sql.users.update, [newHash, null, null, userId]);
  // JWT invalidation: bump token_version so the current JWT (and any
  // other live JWT) immediately fails userAuth:75 (`token_version` check).
  // Mirrors the admin updateUser precedent at services/users.js:48.
  const newVersion = await bumpTokenVersion(userId);
  return { ok: true, userId, newVersion };
}