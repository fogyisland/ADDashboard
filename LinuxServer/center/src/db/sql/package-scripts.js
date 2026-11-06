// SQL helpers for the package_scripts table (migration 023).
//
// R66 split: installed_packages -> package_scripts (script content + sha256
// + manifest) + package_policies (intervalSec + timeoutMs + enabled + params).
// This helper covers package_scripts only.
//
// Pattern matches center/src/db/sql/installed-packages.js: dual-dialect SQL
// constants + a thin object that wraps db.execute with JSON
// stringify/parse for manifest_json.
//
// The service code can also use the raw SQL strings via
// `db.sql.packageScripts.upsert` for direct execution when JSON
// marshaling is not desired.
//
// 2026-08-29: initial scaffold for R66 task-3.

import { getDb } from '../index.js';

// MySQL: INSERT ... ON DUPLICATE KEY UPDATE. 7 placeholders:
// name, version, script_content, script_sha256, manifest_json, source, now, now
// (created_at + updated_at share `now` on insert; updated_at refreshes on update).
const UPSERT_MYSQL = `INSERT INTO package_scripts
  (name, version, script_content, script_sha256, manifest_json, source, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    version = VALUES(version),
    script_content = VALUES(script_content),
    script_sha256 = VALUES(script_sha256),
    manifest_json = VALUES(manifest_json),
    source = VALUES(source),
    updated_at = VALUES(updated_at)`;

// MSSQL: MERGE with USING (SELECT ...) AS source. 8 placeholders;
// the mssql driver wrapper rewrites ? -> @p1...@p8 at execute() time.
const UPSERT_MSSQL = `MERGE INTO package_scripts AS t
  USING (SELECT
    ? AS name, ? AS version, ? AS script_content, ? AS script_sha256,
    ? AS manifest_json, ? AS source, ? AS created_at, ? AS updated_at
  ) AS s
  ON t.name = s.name
  WHEN MATCHED THEN UPDATE SET
    version = s.version,
    script_content = s.script_content,
    script_sha256 = s.script_sha256,
    manifest_json = s.manifest_json,
    source = s.source,
    updated_at = s.updated_at
  WHEN NOT MATCHED THEN INSERT
    (name, version, script_content, script_sha256, manifest_json, source, created_at, updated_at)
    VALUES
    (s.name, s.version, s.script_content, s.script_sha256,
     s.manifest_json, s.source, s.created_at, s.updated_at);`;

// updateScript is the narrow "just the script bytes" write used by the
// runner when re-uploading a script without disturbing the manifest
// (e.g. hot-fix on the same package). Both dialects use `?` placeholders.
const UPDATE_SCRIPT_MYSQL = `UPDATE package_scripts SET script_content = ?, script_sha256 = ?, updated_at = ? WHERE name = ?`;
const UPDATE_SCRIPT_MSSQL = `UPDATE package_scripts SET script_content = ?, script_sha256 = ?, updated_at = ? WHERE name = ?`;

const LIST_MYSQL = `SELECT * FROM package_scripts ORDER BY name`;
const LIST_MSSQL = `SELECT * FROM package_scripts ORDER BY name`;

const GET_MYSQL = `SELECT * FROM package_scripts WHERE name = ?`;
const GET_MSSQL = `SELECT * FROM package_scripts WHERE name = ?`;

const DELETE_MYSQL = `DELETE FROM package_scripts WHERE name = ?`;
const DELETE_MSSQL = `DELETE FROM package_scripts WHERE name = ?`;

// 2026-09-29 P1-1 (G1) — heartbeat-side change-watermark. We MAX over
// (package_scripts.updated_at, package_policies.updated_at) so that
// any script edit OR any policy flip (enable/disable / interval /
// params) bumps the watermark. The agent compares the heartbeat
// response's packagesChangedAt against its last-seen value and fires
// a syncFromCenter when the centre is newer. Subqueries use the same
// `?` placeholder pattern as the rest of the helper so mssql / mysql
// drivers both work via the dialect-portable rewrite at db.execute
// time.
//
// We use UNION ALL + MAX(t) instead of a CROSS JOIN so we don't have
// to fan out rows; on a 50-package install this is ~50× cheaper.
const LATEST_CHANGE_MYSQL = `
  SELECT MAX(t) AS latest_at FROM (
    SELECT MAX(updated_at) AS t FROM package_scripts
    UNION ALL
    SELECT MAX(updated_at) AS t FROM package_policies
  ) AS _w
`;
const LATEST_CHANGE_MSSQL = LATEST_CHANGE_MYSQL;

// SQL registry for db.sql.packageScripts.* — re-exported from sql.js
// alongside the other domains so the existing frozen-registry pattern
// (services that read db.sql.<domain>.<query>) still works.
export const packageScriptsSql = {
  upsert: { mysql: UPSERT_MYSQL, mssql: UPSERT_MSSQL },
  list: { mysql: LIST_MYSQL, mssql: LIST_MSSQL },
  get: { mysql: GET_MYSQL, mssql: GET_MSSQL },
  delete: { mysql: DELETE_MYSQL, mssql: DELETE_MSSQL },
  updateScript: { mysql: UPDATE_SCRIPT_MYSQL, mssql: UPDATE_SCRIPT_MSSQL }
};

// Map a raw row (driver column shape) to the JS-friendly shape the API
// returns: parsed JSON for manifest_json, camelCase for the rest.
//
// `manifest_json` is MySQL `json`; mysql2 driver auto-parses to JS
// object on read. The mssql driver returns it as a JSON string.
// Normalize both to a JS object here so callers see a consistent
// shape regardless of driver.
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
    scriptContent: row.script_content,
    scriptSha256: row.script_sha256,
    manifest: parseJson(row.manifest_json),
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// Function-style helper API. Each function takes (db, ...) so callers
// pass the db facade explicitly — easy to test against a mock db.
export const packageScripts = {
  async upsert(db, { name, version, scriptContent, scriptSha256, manifest, source }) {
    const sql = db.dialect === 'mssql' ? UPSERT_MSSQL : UPSERT_MYSQL;
    const now = new Date();
    await db.execute(sql, [
      name,
      version,
      scriptContent,
      scriptSha256,
      JSON.stringify(manifest),
      source ?? '',
      now,
      now
    ]);
  },

  async updateScript(db, { name, scriptContent, scriptSha256 }) {
    const sql = db.dialect === 'mssql' ? UPDATE_SCRIPT_MSSQL : UPDATE_SCRIPT_MYSQL;
    await db.execute(sql, [
      scriptContent,
      scriptSha256,
      new Date(),
      name
    ]);
  },

  async list(db) {
    const sql = db.dialect === 'mssql' ? LIST_MSSQL : LIST_MYSQL;
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

  // 2026-09-29 P1-1 (G1) — heartbeat watermark. Returns the latest
  // updated_at across BOTH package_scripts and package_policies so the
  // agent's heartbeat handler can detect any script content change OR
  // any policy flip (enable/disable / interval / timeout / params).
  // NULL when both tables are empty (fresh-install centre). The agent
  // treats NULL as "no change ever" and never skips a sync for that
  // reason — the regular 5min setInterval still applies.
  async latestChangeAt(db) {
    const sql = db.dialect === 'mssql' ? LATEST_CHANGE_MSSQL : LATEST_CHANGE_MYSQL;
    const { rows } = await db.execute(sql, []);
    const v = rows?.[0]?.latest_at ?? null;
    if (!v) return null;
    // mysql2 returns a Date object; mssql driver returns a Date too in
    // recent node-mssql versions, but historically a string. Coerce
    // both to ISO so the wire shape is stable.
    return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
  }
};

// Convenience: bound to the singleton db (used by route handlers that
// don't already hold a db reference). Thin wrapper that resolves the
// facade via getDb() — does not change the function-shape API.
export const packageScriptsForDb = {
  upsert: (p) => packageScripts.upsert(getDb(), p),
  updateScript: (p) => packageScripts.updateScript(getDb(), p),
  list: () => packageScripts.list(getDb()),
  get: (name) => packageScripts.get(getDb(), name),
  delete: (name) => packageScripts.delete(getDb(), name)
};