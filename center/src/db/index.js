// DB facade. The ONLY place that knows which driver (mysql/mssql) is in use.
// Boot order:
//   1. loadConfig() reads appsettings.json, exposes config.db.dialect + config.db.{mysql|mssql}
//   2. db.init(config) initializes the matching driver and the frozen SQL registry
//   3. db.execute/db.query/db.transaction/db.healthcheck/db.close are used by app code

import { join } from 'node:path';
import { buildSql, SUPPORTED_DIALECTS } from './sql.js';
import { createMysqlDriver } from './drivers/mysql.js';
import { createMssqlDriver } from './drivers/mssql.js';
import { DbError } from './errors.js';
import { bootstrapMigrations } from '../init/schema-applier.js';

let state = null;

export async function init(config, opts = {}) {
  if (state) return state.db;
  const dialect = config.db?.dialect;
  if (!dialect) throw new Error('config.db.dialect is required');
  if (!SUPPORTED_DIALECTS.includes(dialect)) {
    throw new Error(`unsupported dialect: ${dialect}; supported: ${SUPPORTED_DIALECTS.join(', ')}`);
  }

  const driverCfg = config.db[dialect];
  if (!driverCfg) throw new Error(`config.db.${dialect} is required when dialect='${dialect}'`);

  const driver = dialect === 'mysql' ? createMysqlDriver(driverCfg) : createMssqlDriver(driverCfg);
  const sql = buildSql(dialect);
  const db = {
    dialect,
    sql,
    execute: async (s, p) => { try { return await driver.execute(s, p); } catch (e) { throw DbError.wrap(e); } },
    query:   async (s, p) => { try { return await driver.query(s, p);   } catch (e) { throw DbError.wrap(e); } },
    transaction: async (work) => { try { return await driver.transaction(work, sql); } catch (e) { throw DbError.wrap(e); } },
    healthcheck: async () => { try { await driver.healthcheck(); } catch (e) { throw DbError.wrap(e); } },
    close: async () => { try { await driver.close(); } catch (e) { throw DbError.wrap(e); } }
  };
  state = { db, driver };

  // DB H4 (2026-09-22): backfill may now invoke a .js migration helper
  // (e.g. R66's `023-package-scripts-policies-split.js`) which in turn
  // needs `dataDir` + `writeAudit`. Bootstrap runs BEFORE any service is
  // constructed, so the only sane place to source these is `opts` — the
  // server.js caller already has `repoRoot` and the imported `writeAudit`
  // in scope at line 35 / 153. Both are optional (fresh DB → helper is a
  // safe no-op; pre-009 upgrade path → helper runs the real data
  // migration). When neither is supplied, the helper falls back to
  // `${cwd}/data/packages` (matching services/migrations.js:189).
  const bootstrapOpts = {
    getDataDir: opts.getDataDir ?? (opts.repoRoot
      ? () => join(opts.repoRoot, 'data', 'packages')
      : null),
    writeAudit: opts.writeAudit ?? null
  };

  // Create schema_migrations + backfill on deployments upgrading from pre-009
  // code. No-op once the table exists. Deliberately non-fatal: migration
  // *tracking* must never stop the server from serving. A hard failure here
  // (e.g. the DB user lacks CREATE TABLE) would bubble out of init() and make
  // server.js drop a working install back into the init wizard.
  try {
    await bootstrapMigrations(dialect, db, bootstrapOpts);
  } catch (e) {
    console.error(`schema_migrations bootstrap failed (non-fatal): ${e.message}`);
  }
  return db;
}

export function getDb() {
  if (!state) throw new Error('db not initialized; call db.init(config) first');
  return state.db;
}

export async function close() {
  if (!state) return;
  await state.db.close();
  state = null;
}

// Test helper — replace the facade with a mock so tests don't need a real DB.
export function _setDbForTest(mockDb) {
  state = { db: mockDb, driver: null };
}