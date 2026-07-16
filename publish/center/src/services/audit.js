import { getDb } from '../db/index.js';

export async function writeAudit({ userId, action, target, payload }, logger) {
  const db = getDb();
  try {
    await db.execute(db.sql.audit.write, [
      userId ?? null,
      action,
      target ?? null,
      payload == null ? null : JSON.stringify(payload)
    ]);
  } catch (e) {
    if (logger) logger.warn({ err: e.message, action, target }, 'audit write failed (best-effort)');
  }
}

export async function listAudit(limit) {
  const db = getDb();
  const { rows } = await db.query(db.sql.audit.list, [limit]);
  return rows;
}