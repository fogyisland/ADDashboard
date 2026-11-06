import { hashPassword } from '../auth/password.js';

export class AdminConflictError extends Error {
  constructor() { super('admin user already exists'); this.code = 'ADMIN_EXISTS'; }
}

export async function createAdmin(db, { username, password }) {
  const countResult = await db.execute(db.sql.users.count, []);
  const n = countResult.rows?.[0]?.n ?? 0;
  if (n > 0) throw new AdminConflictError();

  const hash = await hashPassword(password);
  const insertResult = await db.execute(
    db.sql.users.createAdmin,
    [username, hash]
  );
  return { id: insertResult.insertId, username };
}