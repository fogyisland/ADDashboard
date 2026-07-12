import bcrypt from 'bcrypt';
import { getDb } from '../db/index.js';

export async function findByUsername(username) {
  const db = getDb();
  const { rows } = await db.query(db.sql.users.findByUsername, [username]);
  return rows[0] ?? null;
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

export async function updateUser(id, { password, roleId, status }) {
  const db = getDb();
  const passwordHash = password ? await bcrypt.hash(password, 12) : null;
  await db.execute(db.sql.users.update, [passwordHash, roleId, status, id]);
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