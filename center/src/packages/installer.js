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
import { orphanSchemas } from '../db/sql/orphan-schemas.js';
import { PkgError } from './errors.js';
import { ensureSchema, createSchemaMigrationsTable, applyMigrations, dropSchema, schemaExists, markMigrationsApplied, listAppliedMigrations } from './ddl-apply.js';

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

  async upgradePackage(db, { name, version, manifest: candidateManifest, buffer }) {
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
      resolvedType = existing.type;
    }

    // v2 path: diff migrations against pkg_<name>.schema_migrations and apply
    // only the new ones. We only enter this branch when BOTH the existing
    // installed manifest and the candidate manifest have a `database` field —
    // upgrading a v1 package to a v2 manifest is not supported in this plan
    // (see spec §"v1/v2 routing"). On mid-failure we do NOT attempt automatic
    // rollback because MySQL DDL implicit-commits leave the schema in a
    // partial state; we log to package_runs and rethrow as PKG_UPGRADE_FAILED
    // so the admin can fix forward.
    if (existing.manifest.database && candidateManifest?.database) {
      if (!buffer) {
        throw new PkgError('PKG_VALIDATION_FAILED', 'buffer required for v2 upgrade');
      }
      const schemaName = candidateManifest.database.schemaName || existing.manifest.database.schemaName;
      if (!/^pkg_[a-z0-9_]+$/.test(schemaName)) {
        throw new PkgError('PKG_DDL_FORBIDDEN', `invalid schemaName: ${schemaName}`);
      }

      const applied = await listAppliedMigrations(db, schemaName, db.dialect);
      const appliedSet = new Set(applied.map(r => r.filename));
      const zip = new AdmZip(buffer);
      const migrations = candidateManifest.database.migrations;
      const migrationFiles = migrations.map(rel => {
        const entry = zip.getEntry(rel);
        if (!entry) throw new PkgError('PKG_DDL_FORBIDDEN', `migration file missing: ${rel}`);
        return { filename: rel.split('/').pop(), path: rel, content: entry.getData().toString('utf8') };
      });
      const toApply = migrationFiles.filter(f => !appliedSet.has(f.filename));

      if (toApply.length) {
        try {
          await applyMigrations(db, { schemaName, dialect: db.dialect, files: toApply });
          await markMigrationsApplied(db, { schemaName, version, filenames: toApply.map(f => f.filename), dialect: db.dialect });
        } catch (e) {
          // No automatic rollback on upgrade — MySQL DDL implicit-commits, so
          // already-applied migration files in `toApply` have been committed
          // and remain in schema_migrations (with version = '__pending__' for
          // any not yet touched by the markMigrationsApplied UPDATE). Log the
          // failure to package_runs for admin visibility; admin must fix
          // forward (re-upload a corrected migration) or uninstall + reinstall.
          try {
            await packageRuns.insert(db, {
              agentId: 'system',
              packageName: name,
              startedAt: new Date(),
              finishedAt: new Date(),
              exitCode: null,
              stdoutPreview: null,
              stderrPreview: null,
              error: `upgrade mid-failure: ${e.message}`
            });
          } catch {}
          if (e instanceof PkgError && (e.code === 'PKG_DDL_FORBIDDEN' || e.code === 'PKG_DDL_INVALID_SQL')) {
            throw new PkgError('PKG_UPGRADE_FAILED', `${e.code}: ${e.message}`);
          }
          throw new PkgError('PKG_UPGRADE_FAILED', e.message);
        }
      }
      newManifest = { ...candidateManifest, name, version };
    } else if (candidateManifest) {
      newManifest = { ...candidateManifest, name, version };
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

  async uninstallPackage(db, { name, purgeMetrics, confirmDropSchema }) {
    // Built-in packages (e.g. `ad-os-baseline`) cannot be uninstalled via
    // the global uninstall path — the package is part of the center's own
    // baseline bundle. Per-server unbind via DELETE
    // /api/admin/member-servers/:hostname/packages/<name> (Task 7) is a
    // separate code path and remains allowed.
    const BUILTIN = new Set(['ad-os-baseline']);
    if (BUILTIN.has(name)) {
      throw new PkgError(
        'PKG_BUILTIN',
        `${name} is a built-in package and cannot be uninstalled`
      );
    }

    const existing = await installedPackages.get(db, name);
    if (!existing) throw new PkgError('PKG_NOT_FOUND', name);

    // v2: drop pkg_<name> schema first if requested. v1 packages (no
    // manifest.database) fall through to the existing v1 metric_* purge
    // branch. The DROP happens before the `installedPackages.delete` so
    // that the connection's `USE` state set by `createSchemaMigrationsTable`
    // on install is reset by `dropSchema`'s restore-prevDb logic before
    // the unqualified `DELETE FROM installed_packages` runs.
    if (existing.manifest.database) {
      if (!purgeMetrics) {
        // v2 uninstall without purge: leave the schema in place; uninstall
        // just removes the installed_packages row + cache (the next lines).
      } else {
        if (!confirmDropSchema) {
          throw new PkgError(
            'PKG_CONFIRM_REQUIRED',
            `set confirmDropSchema=true to drop pkg schema for ${name}`
          );
        }
        const schemaName = existing.manifest.database.schemaName;
        try {
          await dropSchema(db, schemaName, db.dialect);
        } catch (e) {
          // Best-effort: record the orphan and continue. The uninstall
          // still completes (installed_packages row + cache removed) so
          // the admin can re-install if they want. T10 reads
          // orphan_schemas and lets admin re-attempt the drop.
          try {
            await orphanSchemas.upsert(db, {
              name: schemaName,
              lastSeenAt: new Date(),
              note: `uninstall DROP failed: ${e.message}`
            });
          } catch (orphanErr) {
            // Even the orphan-record failed (e.g. orphan_schemas table
            // missing). Log and proceed — do not block uninstall.
            console.error(`orphan_schemas.upsert also failed: ${orphanErr.message}`);
          }
        }
      }
    } else if (purgeMetrics) {
      // Existing v1 path: delete metric_* rows where metric_id LIKE '<name>.%'
      await db.execute(`DELETE FROM metric_gauge WHERE metric_id LIKE ?`, [`${name}.%`]);
      await db.execute(`DELETE FROM metric_counter WHERE metric_id LIKE ?`, [`${name}.%`]);
      await db.execute(`DELETE FROM metric_timeseries WHERE metric_id LIKE ?`, [`${name}.%`]);
      await db.execute(`DELETE FROM metric_status WHERE metric_id LIKE ?`, [`${name}.%`]);
    }

    await db.execute(`DELETE FROM package_runs WHERE package_name = ?`, [name]);
    await installedPackages.delete(db, name);
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
  },

  /**
   * 2026-08-26: per-package operator interval override. `intervalSec`
   * may be null to clear the override (fall back to manifest default).
   * Range check (5..86400) is enforced by the route handler — installer
   * trusts the caller (matches setEnabled / updateParams pattern).
   */
  async setIntervalOverride(db, { name, intervalSec }) {
    await installedPackages.setIntervalOverride(db, { name, intervalSec });
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