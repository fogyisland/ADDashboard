// seedBuiltinPackages — copies bundled built-in packages from the
// publish/ directory into the runtime data/ tree on first normal-mode
// start AND registers them in the installed_packages DB table so the
// agent's /api/agent/packages endpoint serves them. The center and agent
// share a single data/packages/<name>/<version>/ layout (see
// center/src/packages/installer.js — same path used for downloaded +
// cached packages), so seeding the built-in here makes the
// runner/router code path completely uniform across all install sources.
//
// Idempotency:
//   - File copy: skipped when <dataDir>/<name>/<version>/manifest.json
//     already exists. Operator can delete that file to force a re-seed.
//   - DB upsert: re-runs on every call when `db` is provided. The upsert
//     itself is idempotent (INSERT ... ON DUPLICATE KEY UPDATE / MERGE),
//     and re-running recovers the round-12 runAllNow count:0 bug —
//     installs that pre-date the DB-registration step left files on
//     disk but no installed_packages row, so the agent sync returned []
//     and runAllNow() always emitted `count: 0`.
//   - DDL apply: re-runs on every call when `db` is provided, with the
//     same idempotency strategy as installer.upgradePackage — read
//     pkg_<name>.schema_migrations, skip filenames already recorded,
//     then apply the rest. CREATE TABLE IF NOT EXISTS on the
//     per-package SQL files makes the second-run path itself safe even
//     if the schema_migrations row is missing (e.g. the operator
//     dropped the table). Round-13 fix: pre-fix seeder never applied
//     DDL, so metricstore v2 INSERT failed with "Table
//     'pkg_<name>.metrics' doesn't exist" forever.
//
// Audit: emits `seed_builtin_<name>` (with hyphens → underscores) on
// successful file copy only (not on idempotent re-runs). target='packages',
// payload={name,version}. Best-effort: writeAudit failures don't block
// startup (matches writeAudit's own best-effort contract).
//
// Built-in enable contract: registered with enabled=true. Operator-driven
// disable via UI does not persist across restarts — the seeder re-enables
// on every normal-mode start. That's the documented built-in contract:
// built-ins are center-managed, like system packages. If you want to
// keep a built-in permanently disabled, delete <InstallPath>/data/packages/<name>/
// before restart and the seeder will copy + re-enable it; future admin
// work will add a per-package "sticky disabled" flag.
//
// Source dir layout (bundled in publish/center/data/packages/):
//   <name>/<version>/manifest.json
//   <name>/<version>/collect.ps1
//   <name>/<version>/migrations/<dialect>/*.sql  (e.g. 001_initial.sql)
//   <name>/<version>/content.sha256
//
// Dialect resolution for migrations (mirrors installer.installPackage):
//   mysql → migrations/*.sql (top-level only, NOT migrations/mssql/)
//   mssql → migrations/mssql/*.sql if present, else migrations/*.sql
// The mysql/mssql split exists because the two dialects have
// syntactically different DDL (e.g. JSON vs NVARCHAR(MAX) +
// ISJSON CHECK) and the seeder must run the right file or the apply
// crashes with parse errors.
//
// Called from center/server.js IIFE before buildServerApps() in normal
// mode only (init mode has no data/packages consumers).

import fs from 'node:fs';
import path from 'node:path';
import {
  ensureSchema,
  createSchemaMigrationsTable,
  applyMigrations,
  markMigrationsApplied,
  listAppliedMigrations,
  schemaExists
} from '../packages/ddl-apply.js';

export const BUILTIN_PACKAGES = [
  { name: 'ad_os_baseline', version: '1.0.0' },
  { name: 'ad_domain_consistency', version: '1.0.0' },
  { name: 'ad_local_port_check', version: '1.0.0' }
];

// Returns the list of migration files to apply for a given package +
// dialect. Dialect resolution mirrors installer.installPackage: mssql
// prefers migrations/mssql/*.sql and falls back to migrations/*.sql;
// mysql takes migrations/*.sql only (never the mssql subfolder — those
// files reference [pkg_<name>].<table> which is valid MSSQL but breaks
// mysql's parser). Files are returned in lexicographic order so
// 001_initial.sql runs before 002_*.sql.
function resolveMigrationFiles({ pkgDir, dialect }) {
  // Dialect resolution: mssql prefers migrations/mssql/*.sql and only
  // falls back to migrations/*.sql when no MSSQL-specific files exist.
  // Including both when both exist (the pre-fix behavior) caused every
  // migration file to be applied twice under MSSQL: the MSSQL one and the
  // MySQL-shaped one (same filename, different content), producing duplicate
  // CREATE TABLE statements + duplicate schema_migrations INSERTs. mysql
  // always uses migrations/*.sql only — never the mssql/ subfolder, which
  // uses bracketed identifiers that the MySQL parser rejects.
  if (dialect === 'mssql') {
    const mssqlDir = path.join(pkgDir, 'migrations', 'mssql');
    if (fs.existsSync(mssqlDir)) {
      const mssqlFiles = fs.readdirSync(mssqlDir).filter(f => f.endsWith('.sql')).sort();
      if (mssqlFiles.length > 0) {
        return mssqlFiles.map(filename => ({
          filename,
          content: fs.readFileSync(path.join(mssqlDir, filename), 'utf8')
        }));
      }
    }
    const fallbackDir = path.join(pkgDir, 'migrations');
    if (fs.existsSync(fallbackDir)) {
      const files = fs.readdirSync(fallbackDir).filter(f => f.endsWith('.sql')).sort();
      return files.map(filename => ({
        filename,
        content: fs.readFileSync(path.join(fallbackDir, filename), 'utf8')
      }));
    }
    return [];
  }
  // mysql: only top-level migrations/, skip any mssql/ subfolder.
  const dir = path.join(pkgDir, 'migrations');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  return files.map(filename => ({
    filename,
    content: fs.readFileSync(path.join(dir, filename), 'utf8')
  }));
}

export async function seedBuiltinPackages({ dataDir, sourceDir, writeAudit, db }) {
  if (!dataDir) throw new Error('seedBuiltinPackages: dataDir required');
  if (!sourceDir) throw new Error('seedBuiltinPackages: sourceDir required');

  // Lazy-load installedPackages so unit tests that don't pass `db`
  // (and therefore don't pull in DB code) keep working without a live
  // DB. Production always passes `db`.
  let installedPackages = null;
  if (db) {
    ({ installedPackages } = await import('../db/sql/installed-packages.js'));
  }

  for (const pkg of BUILTIN_PACKAGES) {
    const target = path.join(dataDir, pkg.name, pkg.version);
    fs.mkdirSync(target, { recursive: true });
    // Idempotency guard for file copy: skip if manifest.json already present.
    const manifestPath = path.join(target, 'manifest.json');
    const needsCopy = !fs.existsSync(manifestPath);
    if (needsCopy) {
      const src = path.join(sourceDir, pkg.name, pkg.version);
      if (!fs.existsSync(src)) {
        // Source missing is a hard error for the bundled layout — if the
        // publish/ mirror is broken, we want this to surface loudly. The
        // operator can recover by re-running the mirror script (scripts/
        // mirror-and-zip.ps1) and restarting.
        throw new Error(`seedBuiltinPackages: source not found: ${src}`);
      }
      copyDirSync(src, target);
    }

    // Read manifest once for both the installed_packages upsert and the
    // DDL apply — the manifest's `database.schemaName` is what we key
    // both the upsert and the migration apply on.
    const manifestRaw = fs.readFileSync(manifestPath, 'utf8');
    // Defensive BOM strip — packaged manifest.json files from a Windows
    // build pipeline occasionally carry a UTF-8 BOM, which JSON.parse
    // rejects. Same defensive pattern as installer.js for zip-extracted
    // manifests.
    const manifest = JSON.parse(manifestRaw.replace(/^﻿/, ''));

    // DB registration: when db is provided, upsert the installed_packages
    // row so the agent's GET /api/agent/packages endpoint returns this
    // built-in. Runs on every normal-mode restart (idempotent at the DB
    // layer), which is what fixes round-12 runAllNow count:0 — pre-fix
    // installs seeded files but never wrote the row, so /api/agent/packages
    // returned [] and runAllNow() logged `count: 0`.
    if (db && installedPackages) {
      await installedPackages.upsert(db, {
        name: pkg.name,
        version: pkg.version,
        type: manifest.type || 'gauge',
        manifest,
        enabled: true,
        params: null,
        source: 'builtin-seed'
      });
    }

    // Round-13 fix: DDL apply. After installed_packages row exists, run
    // the package migrations so metricstore v2 INSERT has a target table.
    // Idempotent: schema_migrations tracks applied filenames, and the
    // per-package SQL files are CREATE TABLE IF NOT EXISTS so a missing
    // schema_migrations row still produces a safe second apply (the table
    // already exists → CREATE TABLE IF NOT EXISTS is a no-op, but we
    // still INSERT into schema_migrations so the next restart is fully
    // a no-op). Best-effort: a DDL failure here must throw so server.js
    // surfaces it in the boot log — silently swallowing leaves the
    // package in the broken "files exist, row exists, table missing"
    // state we just fixed.
    if (db && manifest.database) {
      const schemaName = manifest.database.schemaName;
      if (!/^pkg_[a-z0-9_]+$/.test(schemaName)) {
        throw new Error(`seedBuiltinPackages: invalid schemaName in manifest for ${pkg.name}: ${schemaName}`);
      }
      const files = resolveMigrationFiles({ pkgDir: target, dialect: db.dialect });
      // Defensive: a package with a database block but no migration
      // files would silently skip DDL — that was the round-12 failure
      // mode. Fail loudly so the bundled package layout is caught in CI
      // instead of at boot time in production.
      if (!files.length) {
        throw new Error(`seedBuiltinPackages: no migration files for ${pkg.name} (dialect=${db.dialect})`);
      }
      // Skip already-applied filenames so a restart is a true no-op for
      // the migration block (parallel to installer.upgradePackage).
      const applied = await listAppliedMigrations(db, schemaName);
      const appliedSet = new Set(applied.map(r => r.filename));
      const toApply = files.filter(f => !appliedSet.has(f.filename));
      // Idempotent: if the schema doesn't exist yet, create it + the
      // schema_migrations table. Both DDLs are themselves idempotent
      // (CREATE DATABASE/SCHEMA IF NOT EXISTS / CREATE TABLE IF NOT
      // EXISTS), so re-running is harmless even when no migrations need
      // to apply.
      if (!(await schemaExists(db, schemaName, db.dialect))) {
        await ensureSchema(db, schemaName, db.dialect);
      }
      await createSchemaMigrationsTable(db, schemaName, db.dialect);
      if (toApply.length) {
        // skipSandbox: built-in packages are reviewed in-tree, never
        // uploaded by an external author. The sandbox's current rules
        // reject MSSQL control-flow patterns and `SELECT 1 FROM
        // sys.tables` guards that legitimate built-in MSSQL migrations
        // need. The installer path keeps the sandbox on — that's the
        // untrusted-upload boundary.
        await applyMigrations(db, { schemaName, dialect: db.dialect, files: toApply, skipSandbox: true });
        await markMigrationsApplied(db, {
          schemaName,
          version: pkg.version,
          filenames: toApply.map(f => f.filename)
        });
      }
    }

    if (needsCopy && writeAudit) {
      // Hyphens → underscores to fit the audit action key style used
      // elsewhere (e.g. seed_listen_port). Best-effort: any thrown error
      // is swallowed by writeAudit itself; we don't await-catch here to
      // stay aligned with the documented audit contract.
      await writeAudit({
        action: `seed_builtin_${pkg.name.replace(/[^a-z0-9_]/gi, '_')}`,
        target: 'packages',
        payload: { name: pkg.name, version: pkg.version }
      });
    }
  }
}

function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}