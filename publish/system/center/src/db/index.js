// DB facade. The ONLY place that knows which driver (mysql/mssql) is in use.
// Boot order:
//   1. loadConfig() reads appsettings.json, exposes config.db.dialect + config.db.{mysql|mssql}
//   2. db.init(config) initializes the matching driver and the frozen SQL registry,
//      then runs a vendor-specific probe query to verify the configured dialect
//      matches the actual backend (R96). Misconfigured installs now fail loud at
//      boot instead of silently returning empty matrix / 500 "internal".
//   3. db.execute/db.query/db.transaction/db.healthcheck/db.close are used by app code

import { join } from 'node:path';
import { buildSql, SUPPORTED_DIALECTS } from './sql.js';
import { createMysqlDriver } from './drivers/mysql.js';
import { createMssqlDriver } from './drivers/mssql.js';
import { DbError } from './errors.js';
import { bootstrapMigrations } from '../init/schema-applier.js';

// R96: vendor-specific probe queries. Each is a SELECT of a function name
// that ONLY the matching backend recognises:
//   - MySQL:  UTC_TIMESTAMP() returns the server's UTC clock
//   - MSSQL:  SYSUTCDATETIME() returns the server's UTC datetime2
// If the configured dialect is wrong, the probe throws a recognisable error:
//   - MySQL on MSSQL  → MSSQL error 195, level 15: "'UTC_TIMESTAMP' is not a recognized built-in function name"
//   - MSSQL on MySQL  → MySQL error 1305: "FUNCTION db.SYSUTCDATETIME does not exist"
// The dialect names are chosen so the probe is a single SELECT with no params
// and no dependency on schema state (works against an empty database).
const DIALECT_PROBE_SQL = {
  mysql: 'SELECT UTC_TIMESTAMP() AS v',
  mssql: 'SELECT SYSUTCDATETIME() AS v'
};

// R96: match a function-not-found error from either backend. MSSQL error
// 195 and MySQL error 1305 both produce messages of the form
//   'XYZ' is not a recognized built-in function name
// or
//   FUNCTION db.XYZ does not exist
// The probe failure surfaces the configured + detected dialect so the
// operator can self-diagnose without reading SQL Server logs.
const FN_NOT_FOUND_RE = /(is not a recognized built-in function name|FUNCTION .* does not exist)/i;

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

  // R96: test seam. Tests pass `opts.driverFactory(cfg)` to swap the real
  // driver construction with a stub. Defaults to the production factory so
  // server.js never needs to know about the seam.
  const factory = opts.driverFactory ?? (
    dialect === 'mysql' ? createMysqlDriver : createMssqlDriver
  );
  const driver = factory(driverCfg);
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

  // R96: vendor-specific probe. Run BEFORE registering state + BEFORE the
  // schema_migrations bootstrap so a misconfigured install fails boot fast
  // (instead of silently booting with a broken facade). The probe SELECT
  // uses a function name only the *matching* backend recognises — a wrong
  // dialect surfaces immediately with a recognisable error.
  //
  // The probe goes through the facade (not raw driver.execute) so the
  // DbError.wrap normalization is exercised end-to-end. We do NOT swallow
  // the error here — the install is misconfigured and the operator must
  // see it. The error message names both the configured and detected
  // dialects so the operator can self-diagnose from the boot log alone.
  await runDialectProbe(dialect, db);

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

  // R96 test seam: tests pass `opts.bootstrapMigrations` as a stub to
  // skip the real schema bootstrap. Production passes nothing → the real
  // bootstrap runs.
  const doBootstrap = opts.bootstrapMigrations ?? (
    async (d, b, o) => {
      try {
        await bootstrapMigrations(d, b, o);
      } catch (e) {
        console.error(`schema_migrations bootstrap failed (non-fatal): ${e.message}`);
      }
    }
  );

  // Create schema_migrations + backfill on deployments upgrading from pre-009
  // code. No-op once the table exists. Deliberately non-fatal: migration
  // *tracking* must never stop the server from serving. A hard failure here
  // (e.g. the DB user lacks CREATE TABLE) would bubble out of init() and make
  // server.js drop a working install back into the init wizard.
  await doBootstrap(dialect, db, bootstrapOpts);
  return db;
}

// R96: probe the configured dialect by running a vendor-specific function
// call. If the backend is actually the *other* dialect, the probe throws
// MSSQL error 195 (level 15) or MySQL error 1305 — both message patterns
// contain the phrase "is not a recognized built-in function name" / "does
// not exist", which is unique enough that we can identify a misconfigured
// install without false positives on real-world SQL errors.
//
// The probe is intentionally narrow: only one SELECT, no params, no
// schema state needed. If the operator's DB is genuinely unreachable or
// credentials are wrong, the error message will be different (connection
// refused / login failed) — we don't claim those are dialect mismatches.
async function runDialectProbe(dialect, db) {
  const probeSql = DIALECT_PROBE_SQL[dialect];
  try {
    await db.query(probeSql, []);
    return; // happy path
  } catch (e) {
    const msg = e?.message || String(e);
    if (FN_NOT_FOUND_RE.test(msg)) {
      // The configured dialect's function name does not exist on the
      // backend → the backend is the *other* dialect. Name both so the
      // operator can flip db.dialect without reading SQL Server logs.
      const detected = dialect === 'mysql' ? 'mssql' : 'mysql';
      throw new Error(
        `database dialect mismatch: appsettings.json sets db.dialect='${dialect}' ` +
        `but the backend appears to be ${detected} ` +
        `(probe query "${probeSql}" failed: ${msg}). ` +
        `Fix: edit appsettings.json and change db.dialect from '${dialect}' to '${detected}'.`
      );
    }
    // Some other error (connection refused, login failed, etc) — let it
    // propagate untouched. Pre-R96 this was the only failure mode the
    // operator could see at boot, so the surrounding handler still works.
    throw e;
  }
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