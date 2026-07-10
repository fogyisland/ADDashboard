export async function writeAudit(pool, { userId, action, target, payload }) {
  await pool.request()
    .input('u', userId ?? null)
    .input('a', action)
    .input('t', target ?? null)
    .input('p', payload == null ? null : JSON.stringify(payload))
    .query(`INSERT INTO audit_logs (user_id, action, target, payload) VALUES (@u, @a, @t, @p)`);
}
