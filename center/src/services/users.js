import { getPool } from '../db.js';
import { hashPassword, verifyPassword } from '../auth/password.js';

export async function findByUsername(username) {
  const pool = await getPool();
  const r = await pool.request()
    .input('u', username)
    .query(`SELECT u.id, u.username, u.password_hash, u.status, u.role_id, r.role_name, r.permissions
            FROM sys_users u JOIN sys_roles r ON u.role_id = r.id
            WHERE u.username = @u`);
  return r.recordset[0] || null;
}

export async function listUsers() {
  const pool = await getPool();
  const r = await pool.request()
    .query(`SELECT u.id, u.username, u.status, u.last_login_at, u.created_at, r.role_name
            FROM sys_users u JOIN sys_roles r ON u.role_id = r.id ORDER BY u.id`);
  return r.recordset;
}

export async function createUser({ username, password, roleId, status = 1 }) {
  const pool = await getPool();
  const hash = await hashPassword(password);
  await pool.request()
    .input('u', username)
    .input('h', hash)
    .input('r', roleId)
    .input('s', status)
    .query(`INSERT INTO sys_users (username, password_hash, role_id, status)
            VALUES (@u, @h, @r, @s)`);
}

export async function updateUser(id, { password, roleId, status }) {
  const pool = await getPool();
  const sets = [];
  const req = pool.request().input('id', id);
  if (password) { sets.push('password_hash = @h'); req.input('h', await hashPassword(password)); }
  if (roleId !== undefined) { sets.push('role_id = @r'); req.input('r', roleId); }
  if (status !== undefined) { sets.push('status = @s'); req.input('s', status); }
  if (sets.length === 0) return;
  await req.query(`UPDATE sys_users SET ${sets.join(', ')} WHERE id = @id`);
}

export async function deleteUser(id) {
  const pool = await getPool();
  await pool.request().input('id', id).query('DELETE FROM sys_users WHERE id = @id');
}

export async function authenticate(username, password) {
  const u = await findByUsername(username);
  if (!u || !u.status) return null;
  const ok = await verifyPassword(password, u.password_hash);
  if (!ok) return null;
  return { id: u.id, username: u.username, role: u.role_name, permissions: JSON.parse(u.permissions) };
}

export async function recordLogin(userId) {
  const pool = await getPool();
  await pool.request().input('id', userId).query('UPDATE sys_users SET last_login_at = GETUTCDATE() WHERE id = @id');
}
