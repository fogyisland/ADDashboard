// Returns true if the init wizard should run.
// null db → true (no DB connection).
// db.query throws → true (DB unreachable).
// admin count === 0 → true (no admin yet).
// admin count > 0 → false (already initialized).

export async function checkNeedsInit(db) {
  if (!db) return true;
  try {
    const r = await db.query(
      "SELECT COUNT(*) AS n FROM sys_users u JOIN sys_roles r ON u.role_id = r.id WHERE r.role_name = 'admin'"
    );
    const n = r.rows?.[0]?.n ?? 0;
    return n === 0;
  } catch {
    return true;
  }
}
