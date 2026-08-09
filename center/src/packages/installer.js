// Package installer — orchestration layer for install/upgrade/uninstall.
//
// Validates manifests (manifest.js), persists to installed_packages
// (db/sql/installed-packages.js), caches the package files under
// data/packages/<name>/<version>/, and (for uninstall) optionally purges
// the package's metric_* rows + package_runs history.
//
// Dialect portability: every execute() call uses `?` placeholders; the
// mssql driver wrapper rewrites them to @p1...@pN at execution time.
//
// Cache layout (for Task 7 — agent package manager — to read):
//   data/packages/<name>/<version>/manifest.json
//   data/packages/<name>/<version>/collect.ps1
//   data/packages/<name>/<version>/content.sha256  (reserved; v1 writes empty)

import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import semver from 'semver';
import { validateManifest } from './manifest.js';
import { installedPackages } from '../db/sql/installed-packages.js';
import { packageRuns } from '../db/sql/package-runs.js';
import { PkgError } from './errors.js';
import { ensureSchema, createSchemaMigrationsTable, applyMigrations, dropSchema, schemaExists, markMigrationsApplied } from './ddl-apply.js';

export const installer = {
  async installPackage(db, { source, packageRef, buffer, registry }) {
    let manifest, scripts;
    if (buffer) {
      ({ manifest, scripts } = parseBuffer(buffer));
    } else if (registry && packageRef) {
      buffer = await registry.downloadPackageByName(packageRef);
      ({ manifest, scripts } = parseBuffer(buffer));
    } else {
      throw new PkgError('PKG_VALIDATION_FAILED', 'must provide buffer or registry+packageRef');
    }

    const { valid, errors } = validateManifest(manifest);
    if (!valid) throw new PkgError('PKG_INVALID_MANIFEST', JSON.stringify(errors));

    const existing = await installedPackages.get(db, manifest.name);
    if (existing) throw new PkgError('PKG_NAME_CONFLICT', `package ${manifest.name} already installed`);

    // v2 path: apply package-supplied DDL before persisting the installed_packages
    // row. If anything fails mid-apply, the package row is never written and the
    // schema is dropped best-effort — center state ends up as if the operation
    // never happened.
    let schemaName = null;
    if (manifest.database) {
      schemaName = manifest.database.schemaName || `pkg_${manifest.name.replace(/-/g, '_')}`;
      if (!/^pkg_[a-z0-9_]+$/.test(schemaName)) {
        throw new PkgError('PKG_DDL_FORBIDDEN', `invalid schemaName: ${schemaName}`);
      }

      // Read migration files from the zip buffer
      const zip = new AdmZip(buffer);
      const migrations = manifest.database.migrations;
      const migrationFiles = migrations.map(rel => {
        const entry = zip.getEntry(rel);
        if (!entry) throw new PkgError('PKG_DDL_FORBIDDEN', `migration file missing: ${rel}`);
        return { filename: rel.split('/').pop(), path: rel, content: entry.getData().toString('utf8') };
      });

      if (await schemaExists(db, schemaName, db.dialect)) {
        throw new PkgError('PKG_SCHEMA_EXISTS', `${schemaName} already exists`);
      }

      try {
        await ensureSchema(db, schemaName, db.dialect);
        await createSchemaMigrationsTable(db, schemaName, db.dialect);
        await applyMigrations(db, { schemaName, dialect: db.dialect, files: migrationFiles });
        await markMigrationsApplied(db, { schemaName, version: manifest.version, filenames: migrationFiles.map(f => f.filename) });
      } catch (e) {
        // Best-effort rollback — drop the schema so center state is as if the
        // operation never happened. The installed_packages row has not been
        // written yet at this point, so no further cleanup is needed there.
        try { await dropSchema(db, schemaName, db.dialect); } catch {}
        if (e instanceof PkgError && (e.code === 'PKG_DDL_FORBIDDEN' || e.code === 'PKG_DDL_INVALID_SQL')) throw e;
        throw new PkgError('PKG_INSTALL_FAILED', e.message);
      }
    }

    // Persist
    await installedPackages.upsert(db, {
      name: manifest.name,
      version: manifest.version,
      type: manifest.type,
      manifest,
      enabled: false,
      params: null,
      source
    });

    // Cache script to disk (data/packages/<name>/<version>/).
    const cacheDir = path.join(process.cwd(), 'data', 'packages', manifest.name, manifest.version);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(cacheDir, 'collect.ps1'), scripts.collect);
    fs.writeFileSync(path.join(cacheDir, 'content.sha256'), '');

    return { name: manifest.name, version: manifest.version };
  },

  async upgradePackage(db, { name, version, manifest: candidateManifest }) {
    const existing = await installedPackages.get(db, name);
    if (!existing) throw new PkgError('PKG_NOT_FOUND', name);
    if (!version) throw new PkgError('PKG_VALIDATION_FAILED', 'version required');
    if (!semver.gt(version, existing.version)) {
      throw new PkgError(
        'PKG_VALIDATION_FAILED',
        `version ${version} is not greater than current ${existing.version}`
      );
    }
    // Real download + validation lives in Task 5 (registry client). This
    // task only orchestrates the row update: caller is expected to have
    // already fetched the new buffer and validated the manifest.
    //
    // If the caller provides a candidate manifest, enforce that the package
    // type does not change across upgrades — gauge → counter (etc.) would
    // silently corrupt persisted metric rows that share the metric_id
    // namespace. The persisted manifest field is refreshed with the
    // candidate (or, if omitted, with the new version field on the
    // existing manifest).
    let newManifest;
    let resolvedType = existing.type;
    if (candidateManifest) {
      if (candidateManifest.type && candidateManifest.type !== existing.type) {
        throw new PkgError(
          'PKG_VALIDATION_FAILED',
          `type change not allowed: existing=${existing.type} candidate=${candidateManifest.type}`
        );
      }
      newManifest = { ...candidateManifest, name, version };
      resolvedType = existing.type;
    } else {
      newManifest = { ...existing.manifest, version };
    }
    await installedPackages.upsert(db, {
      name,
      version,
      type: resolvedType,        // type must not change across upgrades
      manifest: newManifest,
      enabled: false,            // re-enable manually after upgrade
      params: existing.params,
      source: existing.source
    });
    return { name, version };
  },

  async uninstallPackage(db, { name, purgeMetrics }) {
    const existing = await installedPackages.get(db, name);
    if (!existing) throw new PkgError('PKG_NOT_FOUND', name);
    await installedPackages.delete(db, name);
    if (purgeMetrics) {
      // Delete metric_* rows where metric_id LIKE '<name>.%'
      await db.execute(`DELETE FROM metric_gauge WHERE metric_id LIKE ?`, [`${name}.%`]);
      await db.execute(`DELETE FROM metric_counter WHERE metric_id LIKE ?`, [`${name}.%`]);
      await db.execute(`DELETE FROM metric_timeseries WHERE metric_id LIKE ?`, [`${name}.%`]);
      await db.execute(`DELETE FROM metric_status WHERE metric_id LIKE ?`, [`${name}.%`]);
    }
    await db.execute(`DELETE FROM package_runs WHERE package_name = ?`, [name]);
    // Remove cache directory
    const cacheDir = path.join(process.cwd(), 'data', 'packages', name);
    if (fs.existsSync(cacheDir)) fs.rmSync(cacheDir, { recursive: true, force: true });
  },

  async setEnabled(db, { name, enabled }) {
    await db.execute(
      `UPDATE installed_packages SET enabled = ?, updated_at = ? WHERE name = ?`,
      [enabled ? 1 : 0, new Date(), name]
    );
  },

  async updateParams(db, { name, params }) {
    await db.execute(
      `UPDATE installed_packages SET params_json = ?, updated_at = ? WHERE name = ?`,
      [JSON.stringify(params), new Date(), name]
    );
  }
};

function parseBuffer(buffer) {
  const zip = new AdmZip(buffer);
  const manifestEntry = zip.getEntry('manifest.json');
  if (!manifestEntry) throw new PkgError('PKG_VALIDATION_FAILED', 'manifest.json missing');
  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new PkgError('PKG_VALIDATION_FAILED', 'manifest.json is not valid JSON');
    }
    throw e;
  }
  const scriptEntry = zip.getEntry(manifest.agent.script);
  if (!scriptEntry) throw new PkgError('PKG_VALIDATION_FAILED', `${manifest.agent.script} missing`);
  const scripts = { collect: scriptEntry.getData().toString('utf8') };
  return { manifest, scripts };
}