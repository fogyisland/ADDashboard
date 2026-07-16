import { writeFileSync, renameSync, unlinkSync } from 'node:fs';
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