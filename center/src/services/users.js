import { hashPassword, verifyPassword } from '../auth/password.js';

export async function findByUsername(pool, username) {
  const [rows] = await pool.execute(
    `SELECT u.id, u.username, u.password_hash, u.status, u.role_id, r.role_name, r.permissions
       FROM sys_users u JOIN sys_roles r ON u.role_id = r.id
      WHERE u.username = ?`,
    [username]
  );
  return rows[0] || null;
}

export async function listUsers(pool) {
  const [rows] = await pool.execute(
    `SELECT u.id, u.username, u.status, u.last_login_at, u.created_at, r.role_name
       FROM sys_users u JOIN sys_roles r ON u.role_id = r.id
      ORDER BY u.id`
  );
  return rows;
}

export async function createUser(pool, { username, password, roleId, status = 1 }) {
  const hash = await hashPassword(password);
  await pool.execute(
    `INSERT INTO sys_users (username, password_hash, role_id, status)
     VALUES (?, ?, ?, ?)`,
    [username, hash, roleId, status]
  );
}

export async function updateUser(pool, id, { password, roleId, status }) {
  const sets = [];
  const params = [];
  if (password) { sets.push('password_hash = ?'); params.push(await hashPassword(password)); }
  if (roleId !== undefined) { sets.push('role_id = ?'); params.push(roleId); }
  if (status !== undefined) { sets.push('status = ?'); params.push(status); }
  if (sets.length === 0) return;
  params.push(id);
  await pool.execute(`UPDATE sys_users SET ${sets.join(', ')} WHERE id = ?`, params);
}

export async function deleteUser(pool, id) {
  await pool.execute('DELETE FROM sys_users WHERE id = ?', [id]);
}

export async function authenticate(pool, username, password) {
  const u = await findByUsername(pool, username);
  if (!u || !u.status) return null;
  const ok = await verifyPassword(password, u.password_hash);
  if (!ok) return null;
  return { id: u.id, username: u.username, role: u.role_name, permissions: JSON.parse(u.permissions) };
}

export async function recordLogin(pool, userId) {
  await pool.execute('UPDATE sys_users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?', [userId]);
}