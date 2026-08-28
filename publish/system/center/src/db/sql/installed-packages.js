// SQL helpers for the installed_packages table.
// Pattern matches center/src/db/sql.js's portStatus domain: dual-dialect
// SQL constants + a thin object that wraps db.execute with parameter
// marshaling (JSON stringify/parse for manifest_json / params_json, and
// boolean-to-tinyint conversion for enabled).
//
// The service code can also use the raw SQL strings via
// `db.sql.installedPackages.upsert` for direct execution when JSON
// marshaling is not desired.
//
// 2026-08-26: added `interval_override_sec` (round-19 follow-up). NULL
// = fall back to manifest.agent.intervalSec. The upsert preserves any
// existing override on conflict (so package re-imports don't clobber
// the operator's runtime tuning); only setIntervalOverride() writes the
// column. Same goes for upgradePackage() in installer.js — see that
// file for the matching fix.

import { getDb } from '../index.js';

// MySQL: INSERT ... ON DUPLICATE KEY UPDATE (10 placeholders). Note
// `interval_override_sec` is NOT in the UPDATE clause — operator-set
// overrides must survive re-imports (see file header).
const UPSERT_MYSQL = `INSERT INTO installed_packages
  (name, version, type, manifest_json, enabled, params_json, interval_override_sec, installed_at, updated_at, source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    version = VALUES(version),
    type = VALUES(type),
    manifest_json = VALUES(manifest_json),
    enabled = VALUES(enabled),
    params_json = VALUES(params_json),
    updated_at = VALUES(updated_at),
    source = VALUES(source)`;

// MSSQL: MERGE with USING (SELECT ...) AS source. 10 placeholders;
// the mssql driver wrapper rewrites ? -> @p1...@p10 at execute() time.
// Same preserving-overrides contract as MySQL — `interval_override_sec`
// is NOT in the UPDATE SET list.
const UPSERT_MSSQL = `MERGE INTO installed_packages AS t
  USING (SELECT
    ? AS name, ? AS version, ? AS type, ? AS manifest_json, ? AS enabled,
    ? AS params_json, ? AS interval_override_sec,
    ? AS installed_at, ? AS updated_at, ? AS source
  ) AS s
  ON t.name = s.name
  WHEN MATCHED THEN UPDATE SET
    version = s.version,
    type = s.type,
    manifest_json = s.manifest_json,
    enabled = s.enabled,
    params_json = s.params_json,
    updated_at = s.updated_at,
    source = s.source
  WHEN NOT MATCHED THEN INSERT
    (name, version, type, manifest_json, enabled, params_json, interval_override_sec, installed_at, updated_at, source)
    VALUES
    (s.name, s.version, s.type, s.manifest_json, s.enabled, s.params_json,
     s.interval_override_sec,
     s.installed_at, s.updated_at, s.source);`;

// Operator-facing interval override writes — admin route PUT
// /api/admin/packages/:name/interval lands here. Both dialects pass
// null-or-int through unchanged; the route owns the 5..86400 range
// check so the SQL stays free of validation logic.
const SET_INTERVAL_MYSQL = `UPDATE installed_packages SET interval_override_sec = ?, updated_at = ? WHERE name = ?`;
const SET_INTERVAL_MSSQL = `UPDATE installed_packages SET interval_override_sec = ?, updated_at = ? WHERE name = ?`;

const LIST_MYSQL = (enabledOnly) =>
  enabledOnly
    ? `SELECT * FROM installed_packages WHERE enabled = 1 ORDER BY name`
    : `SELECT * FROM installed_packages ORDER BY name`;

// MSSQL `LIST` uses TOP when filtered (no parameter); when unfiltered
// the SQL is identical.
const LIST_MSSQL = (enabledOnly) =>
  enabledOnly
    ? `SELECT * FROM installed_packages WHERE enabled = 1 ORDER BY name`
    : `SELECT * FROM installed_packages ORDER BY name`;

const GET_MYSQL = `SELECT * FROM installed_packages WHERE name = ?`;
const GET_MSSQL = `SELECT * FROM installed_packages WHERE name = ?`;

const DELETE_MYSQL = `DELETE FROM installed_packages WHERE name = ?`;
const DELETE_MSSQL = `DELETE FROM installed_packages WHERE name = ?`;

// SQL registry for db.sql.installedPackages.* — re-exported from sql.js
// alongside the other domains so the existing frozen-registry pattern
// (services that read db.sql.<domain>.<query>) still works.
export const installedPackagesSql = {
  upsert: { mysql: UPSERT_MYSQL, mssql: UPSERT_MSSQL },
  list: { mysql: LIST_MYSQL(false), mssql: LIST_MSSQL(false), listEnabledMysql: LIST_MYSQL(true), listEnabledMssql: LIST_MSSQL(true) },
  get: { mysql: GET_MYSQL, mssql: GET_MSSQL },
  delete: { mysql: DELETE_MYSQL, mssql: DELETE_MSSQL },
  setIntervalOverride: { mysql: SET_INTERVAL_MYSQL, mssql: SET_INTERVAL_MSSQL }
};

// Map a raw row (driver column shape) to the JS-friendly shape the API
// returns: parsed JSON, boolean for enabled.
//
// `manifest_json` / `params_json` are MySQL `json` columns; the mysql2 driver
// auto-parses these to JS objects on read. The mssql driver returns them
// as JSON strings. Normalize both to a JS object here so callers see a
// consistent shape regardless of driver.
//
// `interval_override_sec` is INT NULL — surfaced as `intervalOverrideSec`
// (camelCase) so the admin frontend can show it without translation.
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
    manifest: parseJson(row.manifest_json),
    params: parseJson(row.params_json),
    enabled: row.enabled === 1 || row.enabled === true,
    intervalOverrideSec: row.interval_override_sec == null ? null : Number(row.interval_override_sec)
  };
}

// Function-style helper API (matches the brief's installedPackages.upsert/db).
// Each function takes (db, ...) — the caller passes the db facade explicitly
// so the helpers are easy to test against a mock db.
export const installedPackages = {
  async upsert(db, { name, version, type, manifest, enabled, params, source, intervalOverrideSec }) {
    const sql = db.dialect === 'mssql' ? UPSERT_MSSQL : UPSERT_MYSQL;
    const now = new Date();
    // intervalOverrideSec is intentionally optional on upsert: install +
    // upgrade + seeder paths pass undefined so the existing override
    // (if any) is preserved. The admin route's setIntervalOverride is
    // the only path that writes the column.
    await db.execute(sql, [
      name,
      version,
      type,
      JSON.stringify(manifest),
      enabled ? 1 : 0,
      params == null ? null : JSON.stringify(params),
      intervalOverrideSec == null ? null : Number(intervalOverrideSec),
      now,
      now,
      source
    ]);
  },

  async list(db, { enabledOnly = false } = {}) {
    const sql = db.dialect === 'mssql'
      ? (enabledOnly ? LIST_MSSQL(true) : LIST_MSSQL(false))
      : (enabledOnly ? LIST_MYSQL(true) : LIST_MYSQL(false));
    const { rows } = await db.execute(sql, []);
    return rows.map(hydrate);
  },

  async get(db, name) {
    const sql = db.dialect === 'mssql' ? GET_MSSQL : GET_MYSQL;
    const { rows } = await db.execute(sql, [name]);
    if (!rows || rows.length === 0) return null;
    return hydrate(rows[0]);
  },

  async delete(db, name) {
    const sql = db.dialect === 'mssql' ? DELETE_MSSQL : DELETE_MYSQL;
    await db.execute(sql, [name]);
  },

  /**
   * Operator override of the package's execution interval. NULL clears
   * the override (the agent falls back to manifest.agent.intervalSec).
   * The route handler is responsible for the 5..86400 range check — this
   * helper trusts the caller.
   */
  async setIntervalOverride(db, { name, intervalSec }) {
    const sql = db.dialect === 'mssql' ? SET_INTERVAL_MSSQL : SET_INTERVAL_MYSQL;
    await db.execute(sql, [
      intervalSec == null ? null : Number(intervalSec),
      new Date(),
      name
    ]);
  }
};

// Convenience: bound to the singleton db (used by route handlers that
// don't already hold a db reference). Thin wrapper that resolves the
// facade via getDb() — does not change the function-shape API.
export const installedPackagesForDb = {
  upsert: (p) => installedPackages.upsert(getDb(), p),
  list: (opts) => installedPackages.list(getDb(), opts),
  get: (name) => installedPackages.get(getDb(), name),
  delete: (name) => installedPackages.delete(getDb(), name),
  setIntervalOverride: (p) => installedPackages.setIntervalOverride(getDb(), p)
};
