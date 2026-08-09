// SQL helpers for the orphan_schemas table (migration 013).
// Pattern matches center/src/db/sql/installed-packages.js: dual-dialect
// SQL constants + a thin object that wraps db.execute with parameter
// marshaling.
//
// Records DROP SCHEMA failures from the package uninstaller (T7) so admin
// can manually clean up. T10 (orphan-router) reads + deletes rows when
// admin confirms a drop; T12 (OrphanSchemasView) renders them.
//
// Service code can also use the raw SQL strings via
// `db.sql.orphanSchemas.upsert` for direct execution when parameter
// marshaling is not desired.

import { getDb } from '../index.js';

// MySQL: INSERT ... ON DUPLICATE KEY UPDATE (3 placeholders).
const UPSERT_MYSQL = `INSERT INTO orphan_schemas (name, last_seen_at, note)
  VALUES (?, ?, ?)
  ON DUPLICATE KEY UPDATE
    last_seen_at = VALUES(last_seen_at),
    note = VALUES(note)`;

// MSSQL: MERGE with USING (SELECT ...) AS source. 3 placeholders; the
// mssql driver wrapper rewrites ? -> @p1...@p3 at execute() time.
const UPSERT_MSSQL = `MERGE INTO orphan_schemas AS t
  USING (SELECT ? AS name, ? AS last_seen_at, ? AS note) AS s
  ON t.name = s.name
  WHEN MATCHED THEN UPDATE SET
    last_seen_at = s.last_seen_at,
    note = s.note
  WHEN NOT MATCHED THEN INSERT (name, last_seen_at, note)
    VALUES (s.name, s.last_seen_at, s.note)`;

// Sort by recency — admin wants the freshest failures first.
const LIST_MYSQL = `SELECT * FROM orphan_schemas ORDER BY last_seen_at DESC`;
const LIST_MSSQL = `SELECT * FROM orphan_schemas ORDER BY last_seen_at DESC`;

const DELETE_MYSQL = `DELETE FROM orphan_schemas WHERE name = ?`;
const DELETE_MSSQL = `DELETE FROM orphan_schemas WHERE name = ?`;

// SQL registry for db.sql.orphanSchemas.* — re-exported from sql.js
// alongside the other domains so the existing frozen-registry pattern
// (services that read db.sql.<domain>.<query>) still works.
export const orphanSchemasSql = {
  upsert: { mysql: UPSERT_MYSQL, mssql: UPSERT_MSSQL },
  list:   { mysql: LIST_MYSQL,   mssql: LIST_MSSQL },
  delete: { mysql: DELETE_MYSQL, mssql: DELETE_MSSQL }
};

// Function-style helper API (matches the brief's orphanSchemas.upsert/db).
// Each function takes (db, ...) — the caller passes the db facade explicitly
// so the helpers are easy to test against a mock db.
export const orphanSchemas = {
  async upsert(db, { name, lastSeenAt, note }) {
    const sql = db.dialect === 'mssql' ? UPSERT_MSSQL : UPSERT_MYSQL;
    await db.execute(sql, [name, lastSeenAt, note ?? null]);
  },

  async list(db) {
    const sql = db.dialect === 'mssql' ? LIST_MSSQL : LIST_MYSQL;
    const { rows } = await db.execute(sql, []);
    return rows;
  },

  async delete(db, name) {
    const sql = db.dialect === 'mssql' ? DELETE_MSSQL : DELETE_MYSQL;
    await db.execute(sql, [name]);
  }
};

// Convenience: bound to the singleton db (used by route handlers that
// don't already hold a db reference). Thin wrapper that resolves the
// facade via getDb() — does not change the function-shape API.
export const orphanSchemasForDb = {
  upsert: (p) => orphanSchemas.upsert(getDb(), p),
  list: () => orphanSchemas.list(getDb()),
  delete: (name) => orphanSchemas.delete(getDb(), name)
};