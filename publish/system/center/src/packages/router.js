// Admin-facing REST endpoints for the package system.
//
// Endpoints (all require userAuth + admin:packages permission):
//   GET    /api/admin/packages                                  → list all installed
//   GET    /api/admin/packages/:name                            → single pkg + recentRuns
//   GET    /api/admin/packages/:name/ddl-preview                → {schemaName, files:[...]}
//   POST   /api/admin/packages/install                          → install via buffer or
//                                                                 registry (body gains
//                                                                 optional confirmDropSchema)
//   POST   /api/admin/packages/:name/upgrade                    → upgrade via registry
//   POST   /api/admin/packages/:name/enable                     → setEnabled(true)
//   POST   /api/admin/packages/:name/disable                    → setEnabled(false)
//   DELETE /api/admin/packages/:name?purgeMetrics=…&confirmDropSchema=…  → uninstall
//   PUT    /api/admin/packages/:name/params                     → updateParams
//   GET    /api/admin/packages/registry/refresh                 → force-refresh registry
//   GET    /api/admin/packages/registry/list                    → list cached registry index
//
// All PkgError instances thrown by installer / registry / compat are
// mapped to HTTP responses via the `statusFor` helper; everything else
// falls back to 500 with `{ ok: false, error: { code, message } }`.

import express from 'express';
import AdmZip from 'adm-zip';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installedPackages } from '../db/sql/installed-packages.js';
import { packageRuns } from '../db/sql/package-runs.js';
import { installer } from './installer.js';
import { RegistryClient } from './registry.js';
import { checkAll } from './compat.js';
import { PkgError } from './errors.js';
import { validateManifest } from './manifest.js';
import { getCenterVersion } from '../config.js';
import { userAuth } from '../auth/user-auth.js';
import { requirePerm } from '../auth/rbac.js';
import { getDb } from '../db/index.js';

function resolveBuffer(body) {
  // body.buffer can arrive as:
  //   - a Buffer (supertest/test paths)
  //   - a JSON-encoded Buffer (express.json serialises it to
  //     { type: 'Buffer', data: [..] } — re-hydrate)
  //   - a base64 string (frontend uploads the file as base64)
  if (!body) return null;
  const b = body.buffer;
  if (b == null) return null;
  if (Buffer.isBuffer(b)) return b;
  if (typeof b === 'string') return Buffer.from(b, 'base64');
  if (b && b.type === 'Buffer' && Array.isArray(b.data)) {
    return Buffer.from(b.data);
  }
  return null;
}

function candidateManifestFromBuffer(buffer) {
  // Parse the package ZIP in-memory to extract the manifest. Reused by
  // /upgrade so we can run checkAll() against the candidate before any
  // row is touched.
  const zip = new AdmZip(buffer);
  const manifestEntry = zip.getEntry('manifest.json');
  if (!manifestEntry) {
    throw new PkgError('PKG_VALIDATION_FAILED', 'manifest.json missing');
  }
  return JSON.parse(manifestEntry.getData().toString('utf8'));
}

export function packageRouter({ db, getLogger, getRegistryUrl, config }) {
  const r = express.Router();
  // Per-route auth (same pattern as adminRouter / agentRouter in src/routes).
  // We do NOT rely on parent-router middleware inheritance because Express
  // does not propagate per-route auth from a sibling Router onto another
  // Router mounted at root.
  //
  // db is required (Task 5: userAuth reads token_version/status per request).
  // Lazy fallback to getDb() keeps the wiring traceable from server.js while
  // being permissive about explicit vs implicit db.
  const _db = db ?? getDb();
  // userAuth takes a `logger` directly (not a getter). packageRouter's API
  // exposes `getLogger` (a thunk) so callers can swap the logger at runtime
  // (used by tests). Resolve it once at factory time and pass the value
  // through to userAuth. Resolves I9 — Task 1: the previous version
  // referenced `logger` here, which was undefined inside this scope and
  // caused `ReferenceError: logger is not defined` on every request.
  const auth = [
    userAuth({ db: _db, logger: getLogger?.() ?? null }),
    requirePerm('admin:packages')
  ];

  r.get('/api/admin/packages', auth, async (_req, res) => {
    try {
      const installed = await installedPackages.list(db);
      res.json({ packages: installed });
    } catch (e) {
      const log = getLogger ? getLogger() : null;
      if (log) log.error({ err: e }, 'admin packages list failed');
      res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: e.message } });
    }
  });

  // GET /api/admin/packages/registry/refresh — force-refresh registry.
  // Registered BEFORE /:name to follow static-before-dynamic convention.
  r.get('/api/admin/packages/registry/refresh', auth, async (_req, res) => {
    try {
      const registryUrl = await getRegistryUrl();
      if (!registryUrl) {
        return res.status(400).json({
          ok: false,
          error: { code: 'PKG_VALIDATION_FAILED', message: 'registry not configured' }
        });
      }
      const registry = new RegistryClient({
        baseUrl: registryUrl,
        cacheDir: join(process.cwd(), 'data', 'registry-cache'),
        logger: getLogger ? getLogger() : null
      });
      const idx = await registry.fetchIndex(true);
      res.json({
        ok: true,
        data: { updatedAt: idx.updatedAt, packages: idx.packages.length }
      });
    } catch (e) {
      if (e instanceof PkgError) {
        return res
          .status(e.status || 400)
          .json({ ok: false, error: { code: e.code, message: e.message } });
      }
      const log = getLogger ? getLogger() : null;
      if (log) log.error({ err: e }, 'admin registry refresh failed');
      res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: e.message } });
    }
  });

  // GET /api/admin/packages/registry/list — list cached registry index.
  // Reads the cached index.json without hitting the registry. Used by the
  // frontend RegistryView to browse available packages. When no registry
  // is configured we return an empty result (200) so the frontend can
  // render a graceful "未配置" state instead of an error.
  // Registered BEFORE /:name to follow static-before-dynamic convention.
  r.get('/api/admin/packages/registry/list', auth, async (_req, res) => {
    try {
      const registryUrl = await getRegistryUrl();
      if (!registryUrl) {
        return res.json({ url: null, packages: [], updatedAt: null });
      }
      const registry = new RegistryClient({
        baseUrl: registryUrl,
        cacheDir: join(process.cwd(), 'data', 'registry-cache'),
        logger: getLogger ? getLogger() : null
      });
      const idx = await registry.fetchIndex();
      res.json({
        url: registryUrl,
        packages: idx.packages,
        updatedAt: idx.updatedAt
      });
    } catch (e) {
      if (e instanceof PkgError) {
        return res
          .status(e.status || 400)
          .json({ ok: false, error: { code: e.code, message: e.message } });
      }
      const log = getLogger ? getLogger() : null;
      if (log) log.error({ err: e }, 'admin registry list failed');
      res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: e.message } });
    }
  });

  // GET /api/admin/packages/:name/ddl-preview — show the cached migration
  // files for a v2 package before re-install / upgrade / uninstall. Returns
  // { schemaName, files: [{path, filename, content}] }. For v1 packages
  // (no manifest.database) returns { schemaName: null, files: [] }.
  // Registered BEFORE /:name to follow static-before-dynamic convention.
  r.get('/api/admin/packages/:name/ddl-preview', auth, async (req, res) => {
    try {
      const pkg = await installedPackages.get(db, req.params.name);
      if (!pkg) {
        return res.status(404).json({
          ok: false,
          error: { code: 'PKG_NOT_FOUND', message: req.params.name }
        });
      }
      if (!pkg.manifest.database) {
        return res.json({ schemaName: null, files: [] });
      }
      const schemaName = pkg.manifest.database.schemaName;
      const cacheDir = join(process.cwd(), 'data', 'packages', req.params.name, pkg.version);
      const files = [];
      for (const rel of pkg.manifest.database.migrations) {
        const filename = rel.split('/').pop();
        const content = readFileSync(join(cacheDir, rel), 'utf8');
        files.push({ path: rel, filename, content });
      }
      res.json({ schemaName, files });
    } catch (e) {
      const log = getLogger ? getLogger() : null;
      if (log) log.error({ err: e }, 'admin package ddl-preview failed');
      res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: e.message } });
    }
  });

  r.get('/api/admin/packages/:name', auth, async (req, res) => {
    try {
      const pkg = await installedPackages.get(db, req.params.name);
      if (!pkg) {
        return res.status(404).json({
          ok: false,
          error: { code: 'PKG_NOT_FOUND', message: req.params.name }
        });
      }
      const recentRuns = await packageRuns.listRecent(db, {
        packageName: req.params.name,
        limit: 20
      });
      res.json({ package: pkg, recentRuns });
    } catch (e) {
      const log = getLogger ? getLogger() : null;
      if (log) log.error({ err: e }, 'admin package get failed');
      res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: e.message } });
    }
  });

  r.post('/api/admin/packages/install', auth, async (req, res) => {
    const { source, packageRef, buffer: rawBuffer, confirmDropSchema: _confirmDropSchema } = req.body || {};
    const buffer = resolveBuffer({ buffer: rawBuffer });
    try {
      // When a buffer is supplied, run the compat check before we touch
      // the DB. checkAll('*', …) skips the agent constraint (admin-side
      // install only needs to satisfy the center version). When the caller
      // doesn't supply a buffer, the registry path inside installPackage
      // will download the package and validate; we skip the upfront check.
      if (buffer) {
        const candidate = candidateManifestFromBuffer(buffer);
        const { valid } = validateManifest(candidate);
        if (!valid) {
          throw new PkgError('PKG_INVALID_MANIFEST', 'manifest failed validation');
        }
        const compat = checkAll(getCenterVersion(), '*', candidate);
        if (!compat.ok) {
          throw new PkgError(
            compat.code || 'PKG_CENTER_INCOMPATIBLE',
            compat.error || 'center incompat'
          );
        }
      }
      const result = await installer.installPackage(db, {
        source,
        packageRef,
        buffer
      });
      res.json({ ok: true, data: result });
    } catch (e) {
      if (e instanceof PkgError) {
        return res
          .status(e.status || 400)
          .json({ ok: false, error: { code: e.code, message: e.message } });
      }
      const log = getLogger ? getLogger() : null;
      if (log) log.error({ err: e }, 'admin package install failed');
      res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: e.message } });
    }
  });

  r.post('/api/admin/packages/:name/upgrade', auth, async (req, res) => {
    const { name } = req.params;
    const { version } = req.body || {};
    try {
      const registryUrl = await getRegistryUrl();
      if (!registryUrl) {
        return res.status(400).json({
          ok: false,
          error: { code: 'PKG_VALIDATION_FAILED', message: 'registry not configured' }
        });
      }
      const registry = new RegistryClient({
        baseUrl: registryUrl,
        cacheDir: join(process.cwd(), 'data', 'registry-cache'),
        logger: getLogger ? getLogger() : null
      });
      const idx = await registry.fetchIndex();
      const pkgEntry = idx.packages.find((p) => p.name === name);
      if (!pkgEntry) {
        return res.status(404).json({
          ok: false,
          error: { code: 'PKG_NOT_FOUND', message: name }
        });
      }
      const targetVersion = version || pkgEntry.latestVersion;
      const versionEntry = pkgEntry.versions.find((v) => v.version === targetVersion);
      if (!versionEntry) {
        return res.status(404).json({
          ok: false,
          error: { code: 'PKG_NOT_FOUND', message: `version ${targetVersion}` }
        });
      }
      const buffer = await registry.downloadPackage(name, versionEntry);

      // Parse the candidate package from the buffer (registry path
      // doesn't pass the buffer to installPackage; here we explicitly
      // need it for the compat check).
      const candidate = candidateManifestFromBuffer(buffer);
      const { valid } = validateManifest(candidate);
      if (!valid) {
        throw new PkgError('PKG_INVALID_MANIFEST', 'manifest failed validation');
      }
      const compat = checkAll(getCenterVersion(), '*', candidate);
      if (!compat.ok) {
        throw new PkgError(
          compat.code || 'PKG_CENTER_INCOMPATIBLE',
          compat.error || 'center incompat'
        );
      }

      // Step 1: write the new files to data/packages so the script is
      // available to agents that pull after the upgrade.
      const fs = await import('node:fs');
      const path = await import('node:path');
      const cacheDir = path.join(process.cwd(), 'data', 'packages', name, targetVersion);
      fs.mkdirSync(cacheDir, { recursive: true });
      const zip = new AdmZip(buffer);
      const scriptEntry = zip.getEntry(candidate.agent.script);
      if (!scriptEntry) {
        throw new PkgError(
          'PKG_VALIDATION_FAILED',
          `${candidate.agent.script} missing`
        );
      }
      fs.writeFileSync(path.join(cacheDir, 'manifest.json'), JSON.stringify(candidate, null, 2));
      fs.writeFileSync(path.join(cacheDir, 'collect.ps1'), scriptEntry.getData().toString('utf8'));
      fs.writeFileSync(path.join(cacheDir, 'content.sha256'), '');

      // Step 2: delegate the row upsert to the installer. Pass the
      // candidate manifest so type-stability is enforced.
      const result = await installer.upgradePackage(db, {
        name,
        version: targetVersion,
        manifest: candidate
      });
      res.json({ ok: true, data: result });
    } catch (e) {
      if (e instanceof PkgError) {
        return res
          .status(e.status || 400)
          .json({ ok: false, error: { code: e.code, message: e.message } });
      }
      const log = getLogger ? getLogger() : null;
      if (log) log.error({ err: e }, 'admin package upgrade failed');
      res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: e.message } });
    }
  });

  r.post('/api/admin/packages/:name/enable', auth, async (req, res) => {
    try {
      await installer.setEnabled(db, { name: req.params.name, enabled: true });
      res.json({ ok: true });
    } catch (e) {
      if (e instanceof PkgError) {
        return res
          .status(e.status || 400)
          .json({ ok: false, error: { code: e.code, message: e.message } });
      }
      const log = getLogger ? getLogger() : null;
      if (log) log.error({ err: e }, 'admin package enable failed');
      res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: e.message } });
    }
  });

  r.post('/api/admin/packages/:name/disable', auth, async (req, res) => {
    try {
      await installer.setEnabled(db, { name: req.params.name, enabled: false });
      res.json({ ok: true });
    } catch (e) {
      if (e instanceof PkgError) {
        return res
          .status(e.status || 400)
          .json({ ok: false, error: { code: e.code, message: e.message } });
      }
      const log = getLogger ? getLogger() : null;
      if (log) log.error({ err: e }, 'admin package disable failed');
      res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: e.message } });
    }
  });

  r.delete('/api/admin/packages/:name', auth, async (req, res) => {
    try {
      const purgeMetrics = req.query.purgeMetrics === 'true';
      const confirmDropSchema = req.query.confirmDropSchema === 'true';
      await installer.uninstallPackage(db, {
        name: req.params.name,
        purgeMetrics,
        confirmDropSchema
      });
      res.json({ ok: true });
    } catch (e) {
      if (e instanceof PkgError) {
        return res
          .status(e.status || 400)
          .json({ ok: false, error: { code: e.code, message: e.message } });
      }
      const log = getLogger ? getLogger() : null;
      if (log) log.error({ err: e }, 'admin package uninstall failed');
      res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: e.message } });
    }
  });

  r.put('/api/admin/packages/:name/params', auth, async (req, res) => {
    try {
      const { params } = req.body || {};
      await installer.updateParams(db, { name: req.params.name, params });
      res.json({ ok: true });
    } catch (e) {
      const log = getLogger ? getLogger() : null;
      if (log) log.error({ err: e }, 'admin package updateParams failed');
      res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: e.message } });
    }
  });

  // PUT /api/admin/packages/:name/interval — operator override of the
  // package's execution interval. Body shape:
  //   { intervalSec: 300 }   // set override
  //   { intervalSec: null }  // clear override (fall back to manifest default)
  //
  // 400 on out-of-range or non-integer values; the route owns the
  // validation so installer.setIntervalOverride can stay simple. The
  // 5..86400 range mirrors the manifest schema constraint
  // (manifest.js: agent.intervalSec minimum=5, maximum=86400).
  //
  // Agent consumes the merged manifest from /api/admin/agent/packages-for-host
  // (see routes/agent-packages.js). That handler now reads
  // `interval_override_sec` and rewrites manifest.agent.intervalSec before
  // returning to the agent — the agent's setInterval is keyed on the
  // resolved interval, so a different override value will rebuild the
  // timer on the next poll (the existing (name, intervalSec) idempotency
  // in agent/src/non-ad-scheduler.js handles the no-op case).
  r.put('/api/admin/packages/:name/interval', auth, async (req, res) => {
    const { intervalSec } = req.body || {};
    if (intervalSec != null) {
      // Must be a positive integer in 5..86400. Reject anything else.
      const n = Number(intervalSec);
      if (!Number.isInteger(n) || n < 5 || n > 86400) {
        return res.status(400).json({
          ok: false,
          error: {
            code: 'PKG_VALIDATION_FAILED',
            message: 'intervalSec must be an integer in [5, 86400] or null'
          }
        });
      }
    }
    try {
      // Confirm the package exists before writing — UPDATE … WHERE name = ?
      // is silent on a missing row, which would leave the operator thinking
      // the change applied when it didn't. Surface 404 instead.
      const existing = await installedPackages.get(db, req.params.name);
      if (!existing) {
        return res.status(404).json({
          ok: false,
          error: { code: 'PKG_NOT_FOUND', message: req.params.name }
        });
      }
      await installer.setIntervalOverride(db, {
        name: req.params.name,
        intervalSec: intervalSec == null ? null : Number(intervalSec)
      });
      // Audit the override change so the operator can correlate later —
      // mirrors the existing package-event audit pattern.
      if (getLogger) {
        getLogger().info({
          pkg: req.params.name,
          prev: existing.intervalOverrideSec ?? null,
          next: intervalSec == null ? null : Number(intervalSec),
          manifestDefault: existing.manifest?.agent?.intervalSec ?? null
        }, 'admin package interval override applied');
      }
      res.json({ ok: true });
    } catch (e) {
      const log = getLogger ? getLogger() : null;
      if (log) log.error({ err: e }, 'admin package setIntervalOverride failed');
      res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: e.message } });
    }
  });

  return r;
}