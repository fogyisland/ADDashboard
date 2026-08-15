import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

// ----- listenPort helpers (Task 2) -----
//
// The center's web port is stored in `system_config.listenPort` so the admin
// UI can change it without editing appsettings.json. `getListenPort` is the
// DB-first reader (fallback to appsettings.json default); `seedListenPortIfMissing`
// is the idempotent bootstrap step that copies the appsettings.json value into
// the DB on first boot. Seeding is intentionally a separate step — callers
// that just want the current port (probe service, route wiring) should use
// `getListenPort` and never write.

// Query helper — single-key read reused by both getListenPort and the seed.
async function readListenPortRow() {
  const db = getDb();
  const { rows } = await db.query(
    "SELECT config_value FROM system_config WHERE config_key = 'listenPort'"
  );
  return rows[0]?.config_value ?? null;
}

// Returns the port the center should bind its web server to. Reads
// `system_config.listenPort` first; falls back to the appsettings.json
// default (8080) when the row is absent or holds an invalid value.
//
// Does NOT seed — this is a pure read. The bootstrap IIFE in server.js calls
// `seedListenPortIfMissing()` once on startup so the DB always reflects the
// appsettings.json value when the operator hasn't explicitly changed it.
export async function getListenPort() {
  const raw = await readListenPortRow();
  if (raw != null) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0 && n < 65536) return n;
  }
  return defaultConfig().listenPort;
}

// If `system_config.listenPort` is absent, writes the appsettings.json default
// into it via the dialect-specific upsert. Returns the active value (existing
// or seeded). Idempotent — when the row already exists, no upsert is issued.
export async function seedListenPortIfMissing(logger) {
  const raw = await readListenPortRow();
  if (raw != null) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0 && n < 65536) return n;
  }
  const db = getDb();
  const seed = defaultConfig().listenPort;
  await db.execute(
    db.sql.config.upsert,
    ['listenPort', String(seed)]
  );
  logger?.info?.({ listenPort: seed }, 'seeded listenPort from appsettings.json');
  return seed;
}

// First 16 hex chars (8 bytes) of sha256(input). Used to build the
// pending/started version hashes that gate the "restart required" badge in
// the ConfigView (Task 6). 8 bytes is plenty of entropy for "did the port
// change since startup?" — collisions across valid port values are
// negligible. Matches the spec's "Version hash" section.
export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}
