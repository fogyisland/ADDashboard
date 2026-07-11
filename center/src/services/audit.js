// Audit log writer (MySQL). Best-effort: never throws out of `writeAudit`,
// so admin/login flows still return success/failure on their own action.
// Signature: writeAudit(pool, { userId, action, target, payload, logger? })

export async function writeAudit(pool, { userId, action, target, payload, logger } = {}) {
  try {
    await pool.execute(
      `INSERT INTO audit_logs (user_id, action, target, payload) VALUES (?, ?, ?, ?)`,
      [userId ?? null, action, target ?? null, payload == null ? null : JSON.stringify(payload)]
    );
  } catch (e) {
    if (logger && typeof logger.error === 'function') {
      logger.error({ err: e, action, target }, 'audit write failed');
    }
  }
}