// SQL helpers for the package_policies table (migration 023).
//
// R66 split: installed_packages -> package_scripts (script content + sha256
// + manifest) + package_policies (intervalSec + timeoutMs + enabled + params
// + scope). This helper covers package_policies only.
//
// Pattern matches center/src/db/sql/installed-packages.js: dual-dialect SQL
// constants + a thin object that wraps db.execute with JSON
// stringify/parse for params_json, and boolean-to-tinyint conversion for
// enabled.
//
// The service code can also use the raw SQL strings via
// `db.sql.packagePolicies.upsert` for direct execution when JSON
// marshaling is not desired.
//
// 2026-08-29: initial scaffold for R66 task-4.

import { getDb } from '../index.js';

// MySQL: INSERT ... ON DUPLICATE KEY UPDATE. 8 placeholders:
// name, interval_sec, timeout_ms, enabled, params_json, scope, created_at, updated_at.
// `script_id` is set by the service code that joins the two tables — not by
// this helper. `scope` defaults to 'global' when the caller doesn't pass it,
// matching the DB DEFAULT.
const UPSERT_MYSQL = `INSERT INTO package_policies
  (name, interval_sec, timeout_ms, enabled, params_json, scope, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    interval_sec = VALUES(interval_sec),
    timeout_ms = VALUES(timeout_ms),
    enabled = VALUES(enabled),
    params_json = VALUES(params_json),
    scope = VALUES(scope),
    updated_at = VALUES(updated_at)`;

// MSSQL: MERGE with USING (SELECT ...) AS source. 8 placeholders;
// the mssql driver wrapper rewrites ? -> @p1...@p8 at execute() time.
const UPSERT_MSSQL = `MERGE INTO package_policies AS t
  USING (SELECT
    ? AS name, ? AS interval_sec, ? AS timeout_ms, ? AS enabled,
    ? AS params_json, ? AS scope, ? AS created_at, ? AS updated_at
  ) AS s
  ON t.name = s.name
  WHEN MATCHED THEN UPDATE SET
    interval_sec = s.interval_sec,
    timeout_ms = s.timeout_ms,
    enabled = s.enabled,
    params_json = s.params_json,
    scope = s.scope,
    updated_at = s.updated_at
  WHEN NOT MATCHED THEN INSERT
    (name, interval_sec, timeout_ms, enabled, params_json, scope, created_at, updated_at)
    VALUES
    (s.name, s.interval_sec, s.timeout_ms, s.enabled, s.params_json,
     s.scope, s.created_at, s.updated_at);`;

const LIST_MYSQL = `SELECT * FROM package_policies ORDER BY name`;
const LIST_MSSQL = `SELECT * FROM package_policies ORDER BY name`;

const LIST_ENABLED_MYSQL = `SELECT * FROM package_policies WHERE enabled = 1 ORDER BY name`;
const LIST_ENABLED_MSSQL = `SELECT * FROM package_policies WHERE enabled = 1 ORDER BY name`;

const GET_BY_NAME_MYSQL = `SELECT * FROM package_policies WHERE name = ?`;
const GET_BY_NAME_MSSQL = `SELECT * FROM package_policies WHERE name = ?`;

const DELETE_MYSQL = `DELETE FROM package_policies WHERE name = ?`;
const DELETE_MSSQL = `DELETE FROM package_policies WHERE name = ?`;

// SQL registry for db.sql.packagePolicies.* — re-exported from sql.js
// alongside the other domains so the existing frozen-registry pattern
// (services that read db.sql.<domain>.<query>) still works.
export const packagePoliciesSql = {
  upsert: { mysql: UPSERT_MYSQL, mssql: UPSERT_MSSQL },
  list: { mysql: LIST_MYSQL, mssql: LIST_MSSQL },
  listEnabled: { mysql: LIST_ENABLED_MYSQL, mssql: LIST_ENABLED_MSSQL },
  getByName: { mysql: GET_BY_NAME_MYSQL, mssql: GET_BY_NAME_MSSQL },
  delete: { mysql: DELETE_MYSQL, mssql: DELETE_MSSQL }
};

// Map a raw row (driver column shape) to the JS-friendly shape the API
// returns: parsed JSON for params_json, camelCase for the rest, boolean
// for enabled.
//
// `params_json` is MySQL `json`; mysql2 driver auto-parses to JS object
// on read. The mssql driver returns it as a JSON string. Normalize both
// to a JS object here so callers see a consistent shape regardless of
// driver. `script_id` passes through unchanged — service code joins
// `package_scripts` on this FK.
function hydrate(row) {
  if (!row) return row;
  const parseJson = (v) => {
    if (v == null) return null;
    if (typeof v === 'object') return v;        // mysql2 already-parsed json column
    if (typeof v === 'string') return JSON.parse(v);  // mssql / TEXT column
    return v;
  };
  return {
    ...row,
    intervalSec: row.interval_sec,
    timeoutMs: row.timeout_ms,
    enabled: row.enabled === 1 || row.enabled === true,
    params: parseJson(row.params_json),
    scope: row.scope,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// Build the dynamic SET clause for updatePartial. Emits SET bindings only
// for the subset of fields the caller actually provided (anything `undefined`
// is skipped, so the operator can flip a single flag without disturbing the
// rest of the row). `updated_at` is always refreshed on any partial write;
// `name` is the WHERE key and is passed in via the private `_name` field
// by the public `updatePartial` wrapper.
//
// Allowed keys: intervalSec, timeoutMs, enabled, params, scope.
// `enabled` is coerced to 0/1 (DB column is TINYINT / BIT); `params` is
// JSON-stringified when present so the column stays a JSON blob.
function buildUpdatePartial(dialect, fields) {
  const allowed = ['intervalSec', 'timeoutMs', 'enabled', 'params', 'scope'];
  const colMap = {
    intervalSec: 'interval_sec',
    timeoutMs: 'timeout_ms',
    enabled: 'enabled',
    params: 'params_json',
    scope: 'scope'
  };
  const setClauses = [];
  const params = [];
  for (const f of allowed) {
    if (fields[f] === undefined) continue;
    setClauses.push(`${colMap[f]} = ?`);
    let v;
    if (f === 'enabled') v = fields[f] ? 1 : 0;
    else if (f === 'params') v = fields[f] == null ? null : JSON.stringify(fields[f]);
    else v = fields[f];
    params.push(v);
  }
  setClauses.push('updated_at = ?');
  params.push(new Date());
  params.push(fields._name);  // private — caller passes the name under _name
  return { sql: `UPDATE package_policies SET ${setClauses.join(', ')} WHERE name = ?`, params };
}

// Function-style helper API. Each function takes (db, ...) so callers pass
// the db facade explicitly — easy to test against a mock db.
export const packagePolicies = {
  async upsert(db, { name, intervalSec, timeoutMs, enabled, params, scope }) {
    const sql = db.dialect === 'mssql' ? UPSERT_MSSQL : UPSERT_MYSQL;
    const now = new Date();
    await db.execute(sql, [
      name,
      intervalSec,
      timeoutMs,
      enabled ? 1 : 0,
      params == null ? null : JSON.stringify(params),
      scope || 'global',   // default matches DB column DEFAULT 'global'
      now,
      now
    ]);
  },

  async updatePartial(db, name, fields) {
    const { sql, params } = buildUpdatePartial(db.dialect, { ...fields, _name: name });
    await db.execute(sql, params);
  },

  async list(db) {
    const sql = db.dialect === 'mssql' ? LIST_MSSQL : LIST_MYSQL;
    const { rows } = await db.execute(sql, []);
    return rows.map(hydrate);
  },

  async listEnabled(db) {
    const sql = db.dialect === 'mssql' ? LIST_ENABLED_MSSQL : LIST_ENABLED_MYSQL;
    const { rows } = await db.execute(sql, []);
    return rows.map(hydrate);
  },

  async getByName(db, name) {
    const sql = db.dialect === 'mssql' ? GET_BY_NAME_MSSQL : GET_BY_NAME_MYSQL;
    const { rows } = await db.execute(sql, [name]);
    if (!rows || rows.length === 0) return null;
    return hydrate(rows[0]);
  },

  async delete(db, name) {
    const sql = db.dialect === 'mssql' ? DELETE_MSSQL : DELETE_MYSQL;
    await db.execute(sql, [name]);
  }
};

// Convenience: bound to the singleton db (used by route handlers that
// don't already hold a db reference). Thin wrapper that resolves the
// facade via getDb() — does not change the function-shape API.
export const packagePoliciesForDb = {
  upsert: (p) => packagePolicies.upsert(getDb(), p),
  updatePartial: (name, fields) => packagePolicies.updatePartial(getDb(), name, fields),
  list: () => packagePolicies.list(getDb()),
  listEnabled: () => packagePolicies.listEnabled(getDb()),
  getByName: (name) => packagePolicies.getByName(getDb(), name),
  delete: (name) => packagePolicies.delete(getDb(), name)
};