import { writeFileSync, renameSync, unlinkSync, readFileSync, existsSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { loadConfig } from '../config.js';

export function writeConfig({ path, dialect, connParams, listenPort, agentToken, jwtSecret, logLevel, env, staticDir }) {
  const cfg = {
    db: {
      dialect,
      [dialect]: connParams
    },
    listenPort,
    jwtSecret,
    agentToken,
    staticDir,
    logLevel: logLevel || 'info',
    env: env || 'prod'
  };
  const tmpPath = join(dirname(path), `.${basename(path)}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(cfg, null, 2), 'utf8');
  renameSync(tmpPath, path);
  // Post-write validation: ensure written file is parseable and meets loadConfig's required-key contract.
  // If validation fails, delete the file and rethrow so the caller sees a clear error and no half-baked config remains.
  try {
    loadConfig(path);
  } catch (err) {
    try { unlinkSync(path); } catch (_) { /* best-effort cleanup */ }
    throw err;
  }
  return cfg;
}

// R158.License-config (2026-10-15) — patchConfigAtomic: read-modify-write appsettings.json
// atomically (write tmp + rename, same idiom as writeConfig). Used by
// ensureSignatureAndInstalledAt at boot to lazy-add `signature` + `installedAt`
// without overwriting operator-edited values.
//
// Returns { changed: bool, cfg: object } so the boot caller can log what landed.
// If the file is missing or invalid, throws — caller decides whether to swallow
// (boot-time failure is non-fatal, see server.js ensureSignatureAndInstalledAt).
//
// Post-write validation runs loadConfig to confirm the patched file still
// satisfies the required-key contract (dialect + listenPort + jwtSecret +
// agentToken + staticDir). If validation fails, the file is unlinked so the
// next boot re-enters the init wizard rather than serving half-baked config.
export function patchConfigAtomic({ path, patch }) {
  if (!existsSync(path)) {
    throw new Error(`patchConfigAtomic: file not found: ${path}`);
  }
  const raw = readFileSync(path, 'utf8');
  const cfg = JSON.parse(raw);
  const next = { ...cfg, ...patch };
  const tmpPath = join(dirname(path), `.${basename(path)}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(next, null, 2), 'utf8');
  renameSync(tmpPath, path);
  try {
    loadConfig(path);
  } catch (err) {
    try { unlinkSync(path); } catch (_) { /* best-effort cleanup */ }
    throw err;
  }
  // changed = true iff at least one patched key differs from the original
  const changed = Object.keys(patch).some(k => cfg[k] !== next[k]);
  return { changed, cfg: next };
}