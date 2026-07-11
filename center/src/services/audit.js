// Audit log writer. Best-effort: never throws out of `writeAudit`,
// so admin/login flows still return success/failure on their own action.
// Signature: writeAudit(pool, { userId, action, target, payload, logger? })
//   - `logger` is optional; if provided, errors are logged via logger.error.
//   - When `logger` is omitted (e.g. the login route callsite), errors are
//     swallowed silently. This matches the brief's "best-effort" contract.

export async function writeAudit(pool, { userId, action, target, payload, logger } = {}) {
  try {
    await pool.request()
      .input('u', userId ?? null)
      .input('a', action)
      .input('t', target ?? null)
      .input('p', payload == null ? null : JSON.stringify(payload))
      .query(`INSERT INTO audit_logs (user_id, action, target, payload) VALUES (@u, @a, @t, @p)`);
  } catch (e) {
    if (logger && typeof logger.error === 'function') {
      logger.error({ err: e, action, target }, 'audit write failed');
    }
    // swallow — best-effort
  }
}
