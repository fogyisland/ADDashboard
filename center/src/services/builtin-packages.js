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
//   <name>/<version>/migrations/*.sql
//   <name>/<version>/content.sha256
//
// Called from center/server.js IIFE before buildServerApps() in normal
// mode only (init mode has no data/packages consumers).

import fs from 'node:fs';
import path from 'node:path';

export const BUILTIN_PACKAGES = [
  { name: 'ad_os_baseline', version: '1.0.0' },
  { name: 'ad_domain_consistency', version: '1.0.0' },
  { name: 'ad_local_port_check', version: '1.0.0' }
];

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

    // DB registration: when db is provided, upsert the installed_packages
    // row so the agent's GET /api/agent/packages endpoint returns this
    // built-in. Runs on every normal-mode restart (idempotent at the DB
    // layer), which is what fixes round-12 runAllNow count:0 — pre-fix
    // installs seeded files but never wrote the row, so /api/agent/packages
    // returned [] and runAllNow() logged `count: 0`.
    if (db && installedPackages) {
      const manifestRaw = fs.readFileSync(manifestPath, 'utf8');
      // Defensive BOM strip — packaged manifest.json files from a Windows
      // build pipeline occasionally carry a UTF-8 BOM, which JSON.parse
      // rejects. Same defensive pattern as installer.js for zip-extracted
      // manifests.
      const manifest = JSON.parse(manifestRaw.replace(/^﻿/, ''));
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