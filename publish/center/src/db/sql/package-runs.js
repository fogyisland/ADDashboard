// SQL helpers for the package_runs table.
//
// package_runs is an audit log: one row per package execution on an
// agent. There is no UNIQUE constraint — each run is a new row.
// `listRecent` is the only read query and supports filtering by agent
// and/or package name with a configurable LIMIT (default 20).
//
// `insert` returns the new row id. The mysql2 driver returns insertId
// on the OkPacket; the mssql driver returns a `rows[0].id` row from the
// SCOPE_IDENTITY() select appended after the INSERT (see the mssql
// driver wrapper). The caller reads either field.

const INSERT_MYSQL = `INSERT INTO package_runs
  (agent_id, package_name, started_at, finished_at, exit_code, stdout_preview, stderr_preview, error)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

// The mssql driver wrapper auto-appends `SELECT CAST(SCOPE_IDENTITY() AS bigint)
// AS id` after any INSERT (see center/src/db/drivers/mssql.js). The insertId
// field on the result object is what callers should consume.
const INSERT_MSSQL = `INSERT INTO package_runs
  (agent_id, package_name, started_at, finished_at, exit_code, stdout_preview, stderr_preview, error)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

function buildListSql({ dialect, agentId, packageName, limit }) {
  // LIMIT is integer-only — we coerce at the JS layer because the mssql
  // driver does not support `LIMIT ?`. The mysql driver accepts both
  // `LIMIT <int>` and `LIMIT ?`.
  const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 20, 1000));
  const where = [];
  const params = [];
  if (agentId) { where.push('agent_id = ?'); params.push(agentId); }
  if (packageName) { where.push('package_name = ?'); params.push(packageName); }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  // mysql uses LIMIT <n>; mssql uses TOP <n> (placed after SELECT).
  if (dialect === 'mssql') {
    const sql = `SELECT TOP ${safeLimit} * FROM package_runs ${whereClause} ORDER BY started_at DESC`;
    return { sql, params };
  }
  const sql = `SELECT * FROM package_runs ${whereClause} ORDER BY started_at DESC LIMIT ${safeLimit}`;
  return { sql, params };
}

export const packageRunsSql = {
  insert: { mysql: INSERT_MYSQL, mssql: INSERT_MSSQL }
  // listRecent is built dynamically per call (LIMIT/TOP is integer-only).
  // Use packageRuns.listRecent(db, opts) below.
};

export const packageRuns = {
  async insert(db, { agentId, packageName, startedAt, finishedAt, exitCode, stdoutPreview, stderrPreview, error }) {
    const sql = db.dialect === 'mssql' ? INSERT_MSSQL : INSERT_MYSQL;
    const params = [
      agentId,
      packageName,
      startedAt,
      finishedAt ?? null,
      exitCode ?? null,
      stdoutPreview ?? null,
      stderrPreview ?? null,
      error ?? null
    ];
    const result = await db.execute(sql, params);
    // Both drivers surface the new id via `insertId` on the execute()
    // result object:
    //   mysql2 — OkPacket.insertId
    //   mssql  — populated from the SCOPE_IDENTITY() batch that the
    //            driver wrapper auto-appends (see drivers/mssql.js).
    if (result.insertId != null) return Number(result.insertId);
    return undefined;
  },

  async listRecent(db, { agentId, packageName, limit } = {}) {
    const { sql, params } = buildListSql({ dialect: db.dialect, agentId, packageName, limit });
    const { rows } = await db.execute(sql, params);
    return rows;
  }
};
