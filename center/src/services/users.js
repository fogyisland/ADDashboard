import bcrypt from 'bcryptjs';
import { getDb } from '../db/index.js';

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