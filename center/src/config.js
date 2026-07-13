import { readFileSync } from 'node:fs';
import { SUPPORTED_DIALECTS } from './db/sql.js';

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
