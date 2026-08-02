import { readFileSync, existsSync } from 'node:fs';
import { SUPPORTED_DIALECTS } from './db/sql.js';
import { getDb } from './db/index.js';

// Reads the center version from package.json at module load. Used by the
// package router's compat checks (checkCenterCompat) so admin installs
// reject manifests that require a newer center than the running build.
const PKG_VERSION = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
let _centerVersion = '0.0.0';
try {
  _centerVersion = JSON.parse(PKG_VERSION).version || _centerVersion;
} catch {
  // fall through — leave as '0.0.0'
}

export function getCenterVersion() {
  return _centerVersion;
}

const REQUIRED_BY_DIALECT = {
  mysql: ['db.mysql.host', 'db.mysql.database'],
  mssql: ['db.mssql.server', 'db.mssql.database']
};

const TOP_LEVEL_REQUIRED = ['listenPort', 'jwtSecret', 'agentToken', 'staticDir'];

export function loadConfig(path) {
  const raw = readFileSync(path, 'utf8');
  const cfg = JSON.parse(raw);

  // Validate dialect
  const dialect = cfg.db?.dialect;
  if (!dialect) throw new Error('config missing required key: db.dialect');
  if (!SUPPORTED_DIALECTS.includes(dialect)) {
    throw new Error(`config.db.dialect invalid: '${dialect}'; supported: ${SUPPORTED_DIALECTS.join(', ')}`);
  }

  // Validate dialect-specific connection block
  for (const k of REQUIRED_BY_DIALECT[dialect]) {
    const v = k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), cfg);
    if (v === undefined || v === null || v === '') {
      throw new Error(`config missing required key: ${k}`);
    }
  }

  // Validate top-level required
  for (const k of TOP_LEVEL_REQUIRED) {
    if (cfg[k] === undefined || cfg[k] === null || cfg[k] === '') {
      throw new Error(`config missing required key: ${k}`);
    }
  }

  return {
    db: { dialect, [dialect]: cfg.db[dialect] },
    listenPort: cfg.listenPort,
    jwtSecret: cfg.jwtSecret,
    agentToken: cfg.agentToken,
    staticDir: cfg.staticDir,
    logLevel: cfg.logLevel || 'info',
    env: cfg.env || 'prod',
    frontendDevProxy: cfg.frontendDevProxy || null
  };
}

export function loadConfigOrNull(path) {
  if (!existsSync(path)) return null;
  return loadConfig(path);
}

export function defaultConfig() {
  return {
    db: undefined,
    listenPort: 8080,
    jwtSecret: '',
    agentToken: '',
    staticDir: './dist',
    logLevel: 'info',
    env: 'prod',
    frontendDevProxy: null
  };
}

// Reads the package registry URL from the system_config table. Returns
// null when the key is absent (no registry configured yet).
//
// Used by the admin REST endpoints in center/src/packages/router.js to
// gate the /packages/registry/refresh and /packages/:name/upgrade routes.
export async function getRegistryUrl() {
  const db = getDb();
  const { rows } = await db.query(
    "SELECT config_value FROM system_config WHERE config_key = 'package_registry_url'"
  );
  return rows[0]?.config_value || null;
}
