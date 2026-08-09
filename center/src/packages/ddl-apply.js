// DDL apply orchestrator — used by installer.installPackage / upgradePackage
// and uninstaller. All operations assume a schema name in the canonical
// `pkg_<name>` form (regex-checked at the installer layer; this module
// trusts the caller to pass a valid name).

import { scanSql } from './ddl-sandbox.js';
import { PkgError } from './errors.js';

// MySQL treats "schema" and "database" as the same concept. We use
// `CREATE DATABASE` everywhere for MySQL and `CREATE SCHEMA` for MSSQL
// to keep the SQL faithful to each dialect.
function ensureSchemaSql(schemaName, dialect) {
  if (dialect === 'mysql') {
    return `CREATE DATABASE IF NOT EXISTS \`${schemaName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`;
  }
  return `CREATE SCHEMA [${schemaName}]`;
}

function dropSchemaSql(schemaName, dialect) {
  if (dialect === 'mysql') return `DROP DATABASE \`${schemaName}\``;
  return `DROP SCHEMA [${schemaName}]`;
}

function schemaMigrationsDdl(dialect) {
  if (dialect === 'mysql') {
    return `CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    VARCHAR(255) NOT NULL PRIMARY KEY,
      version     VARCHAR(32)  NOT NULL,
      applied_at  DATETIME     NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
  }
  return `CREATE TABLE schema_migrations (
    filename    NVARCHAR(255) NOT NULL PRIMARY KEY,
    version     NVARCHAR(32)  NOT NULL,
    applied_at  DATETIMEOFFSET NOT NULL
  )`;
}

export async function schemaExists(db, schemaName, dialect) {
  if (dialect === 'mysql') {
    const { rows } = await db.execute(
      `SELECT 1 FROM information_schema.schemata WHERE schema_name = ? LIMIT 1`,
      [schemaName]
    );
    return rows.length > 0;
  }
  const { rows } = await db.execute(
    `SELECT 1 FROM sys.schemas WHERE name = ?`,
    [schemaName]
  );
  return rows.length > 0;
}

export async function ensureSchema(db, schemaName, dialect) {
  await db.execute(ensureSchemaSql(schemaName, dialect));
}

export async function createSchemaMigrationsTable(db, schemaName, dialect) {
  // Switch into the schema then create. For MSSQL the bracketed identifier
  // form is portable; for MySQL we prefix.
  const ddl = schemaMigrationsDdl(dialect);
  if (dialect === 'mysql') {
    await db.execute(`USE \`${schemaName}\``);
  }
  await db.execute(ddl);
  // MySQL `USE` only affects the connection — not all drivers persist this.
  // Always fully-qualify subsequent statements: `<schemaName>.schema_migrations`.
}

export async function applyMigrations(db, { schemaName, dialect, files }) {
  if (!Array.isArray(files)) throw new Error('files must be an array');
  for (const file of files) {
    const { ok, blocked } = scanSql(file.content, schemaName);
    if (!ok) {
      throw new PkgError('PKG_DDL_FORBIDDEN', `${file.filename}: ${blocked}`);
    }
  }
  // All scans passed — execute each + record in schema_migrations
  for (const file of files) {
    try {
      await db.execute(file.content);
    } catch (e) {
      throw new PkgError('PKG_DDL_INVALID_SQL', `${file.filename}: ${e.message}`);
    }
    await db.execute(
      `INSERT INTO \`${schemaName}\`.schema_migrations (filename, version, applied_at) VALUES (?, ?, ?)`,
      [file.filename, '__pending__', new Date()]
    );
  }
  // version is filled by installer after the loop (it knows the manifest.version).
  // We mark with __pending__ so a partial apply leaves a traceable record;
  // the installer overwrites it with the actual version via UPDATE.
}

export async function markMigrationsApplied(db, { schemaName, version, filenames }) {
  if (!filenames.length) return;
  for (const filename of filenames) {
    await db.execute(
      `UPDATE \`${schemaName}\`.schema_migrations SET version = ? WHERE filename = ?`,
      [version, filename]
    );
  }
}

export async function listAppliedMigrations(db, schemaName) {
  const { rows } = await db.execute(
    `SELECT filename, version, applied_at FROM \`${schemaName}\`.schema_migrations ORDER BY filename`
  );
  return rows;
}

export async function dropSchema(db, schemaName, dialect) {
  // Idempotent: swallow "schema doesn't exist" errors
  try {
    await db.execute(dropSchemaSql(schemaName, dialect));
  } catch (e) {
    if (/does not exist|can't drop|Unknown database/i.test(e.message)) return;
    throw e;
  }
}
