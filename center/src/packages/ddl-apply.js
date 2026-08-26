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

function schemaMigrationsDdl(dialect, schemaName) {
  if (dialect === 'mysql') {
    return `CREATE TABLE IF NOT EXISTS \`${schemaName}\`.schema_migrations (
      filename    VARCHAR(255) NOT NULL PRIMARY KEY,
      version     VARCHAR(32)  NOT NULL,
      applied_at  DATETIME     NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
  }
  return `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = N'schema_migrations' AND schema_id = SCHEMA_ID(N'${schemaName}'))
    CREATE TABLE [${schemaName}].[schema_migrations] (
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
  // The DDL is fully schema-qualified; no `USE <schema>` needed. The mysql2
  // pool persists `USE` per-connection across pool queries (verified in T6
  // review Concern 3), so a stray `USE pkg_x` here would leak into subsequent
  // `installedPackages.upsert/delete` calls and break unqualified INSERTs
  // on `installed_packages`. Same for the MSSQL default-database context.
  const ddl = schemaMigrationsDdl(dialect, schemaName);
  await db.execute(ddl);
}

export async function applyMigrations(db, { schemaName, dialect, files, skipSandbox = false }) {
  if (!Array.isArray(files)) throw new Error('files must be an array');
  // Sandbox skip path is reserved for trusted built-in packages (see
  // seedBuiltinPackages). Built-ins are reviewed in-tree, never uploaded
  // by an external author, so they don't need the sandbox defense the
  // installer path uses. Built-in MSSQL files use `IF EXISTS (SELECT 1
  // FROM sys.tables ...)` and multi-statement control flow (`IF ...
  // BEGIN ... END; IF ... BEGIN ... END;`) which the current sandbox
  // cannot parse (it blocks both `SELECT` and multi-statement).
  // Tightening the sandbox to allow these patterns safely is a separate
  // piece of work; for now the sandbox skip is the contained fix.
  if (!skipSandbox) {
    for (const file of files) {
      const { ok, blocked } = scanSql(file.content, schemaName);
      if (!ok) {
        throw new PkgError('PKG_DDL_FORBIDDEN', `${file.filename}: ${blocked}`);
      }
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
  // Capture the connection's current default database before the DROP so
  // we can restore it. After `DROP DATABASE pkg_x` the connection has no
  // current DB and the next unqualified query (e.g. `DELETE FROM
  // installed_packages`) will fail. mysql2's pool persists `USE` per
  // connection, so we can't rely on the driver-config default — the
  // install path's `createSchemaMigrationsTable` used to `USE pkg_x` and
  // would leave the connection in the (now-dropped) schema. Restore to
  // whatever the connection was in before, so uninstall is safe regardless
  // of which path the caller took to get here.
  let prevDb = null;
  try {
    if (dialect === 'mysql') {
      const { rows } = await db.execute('SELECT DATABASE() AS db');
      prevDb = rows[0]?.db ?? null;
    } else {
      const { rows } = await db.execute('SELECT DB_NAME() AS db');
      prevDb = rows[0]?.db ?? null;
    }
  } catch { /* best effort — proceed with drop even if introspection fails */ }
  try {
    await db.execute(dropSchemaSql(schemaName, dialect));
    // Successful drop. If the dropped schema was the current DB, fall back to
    // the driver default (passed via the SQL pattern; we use the schemaName
    // of the dropped DB to detect this).
    if (prevDb && prevDb !== schemaName) {
      if (dialect === 'mysql') await db.execute(`USE \`${prevDb}\``);
      else await db.execute(`USE [${prevDb}]`);
    }
  } catch (e) {
    if (/does not exist|can't drop|Unknown database/i.test(e.message)) return;
    throw e;
  }
}
