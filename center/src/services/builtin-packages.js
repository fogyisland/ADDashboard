// seedBuiltinPackages — copies bundled built-in packages from the
// publish/ directory into the runtime data/ tree on first normal-mode
// start. The center and agent share a single data/packages/<name>/<version>/
// layout (see center/src/packages/installer.js — same path used for
// downloaded + cached packages), so seeding the built-in here makes the
// runner/router code path completely uniform across all install sources.
//
// Idempotency: skips copy + audit write when <dataDir>/<name>/<version>/manifest.json
// already exists. The operator can delete that file to force a re-seed.
//
// Audit: emits `seed_builtin_<name>` (with hyphens → underscores) on
// successful seed, target='packages', payload={name,version}. Best-effort:
// writeAudit failures don't block startup (matches writeAudit's own
// best-effort contract in services/audit.js).
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
  { name: 'ad_os_baseline', version: '1.0.0' }
];

export async function seedBuiltinPackages({ dataDir, sourceDir, writeAudit }) {
  if (!dataDir) throw new Error('seedBuiltinPackages: dataDir required');
  if (!sourceDir) throw new Error('seedBuiltinPackages: sourceDir required');

  for (const pkg of BUILTIN_PACKAGES) {
    const target = path.join(dataDir, pkg.name, pkg.version);
    fs.mkdirSync(target, { recursive: true });
    // Idempotency guard: skip copy if manifest.json already present.
    if (fs.existsSync(path.join(target, 'manifest.json'))) continue;
    const src = path.join(sourceDir, pkg.name, pkg.version);
    if (!fs.existsSync(src)) {
      // Source missing is a hard error for the bundled layout — if the
      // publish/ mirror is broken, we want this to surface loudly. The
      // operator can recover by re-running the mirror script (scripts/
      // mirror-and-zip.ps1) and restarting.
      throw new Error(`seedBuiltinPackages: source not found: ${src}`);
    }
    copyDirSync(src, target);
    if (writeAudit) {
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