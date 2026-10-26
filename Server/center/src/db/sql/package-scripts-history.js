// R152 — package_scripts_history SQL helpers
//
// Append-only history for package publishes. The script-service layer
// calls packageScriptsHistory.insert(db, ...) after every successful
// installScript / editScript, and the read-side endpoint
// GET /api/admin/packages/:name/history calls listByName.
//
// Idempotency: the (name, version, script_sha256) UNIQUE index means
// re-publishing the same package version with the same sha is a no-op
// rather than a duplicate row. We use INSERT IGNORE on MySQL — the
// affectedRows count is 0 on duplicate, which the service helper
// ignores (it does not need to differentiate).

const INSERT_MYSQL = `INSERT IGNORE INTO package_scripts_history
  (name, version, script_sha256, manifest_json, source, published_at)
  VALUES (?, ?, ?, ?, ?, ?)`;

// MSSQL has no INSERT IGNORE. We use a guarded INSERT via IF NOT EXISTS
// inside the service helper (a SELECT first), so the helper itself
// stays dialect-neutral. This query is the unconditional INSERT used by
// that helper after the existence check passes.
const INSERT_MSSQL = `INSERT INTO package_scripts_history
  (name, version, script_sha256, manifest_json, source, published_at)
  VALUES (?, ?, ?, ?, ?, ?)`;

const EXISTS_MSSQL = `SELECT 1 AS hit FROM package_scripts_history
  WHERE name = ? AND version = ? AND script_sha256 = ?`;

// Same query on both dialects — the difference is just JSON column
// handling on the application side (MSSQL returns NVARCHAR that we
// JSON.parse at the caller; MySQL returns a parsed object already).
const LIST_BY_NAME_MYSQL = `SELECT version, script_sha256, manifest_json, source, published_at
  FROM package_scripts_history WHERE name = ?
  ORDER BY published_at DESC, version DESC`;
const LIST_BY_NAME_MSSQL = LIST_BY_NAME_MYSQL;

export const packageScriptsHistory = {
  insert: {
    mysql: INSERT_MYSQL,
    mssql: INSERT_MSSQL
  },
  existsMssql: EXISTS_MSSQL,
  listByName: {
    mysql: LIST_BY_NAME_MYSQL,
    mssql: LIST_BY_NAME_MSSQL
  }
};
