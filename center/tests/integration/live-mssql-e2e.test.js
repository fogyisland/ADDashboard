// Live MSSQL end-to-end verification — Task #428.
//
// What this proves:
//   1. Fresh DB on a live MSSQL instance works (drops + recreates a smoke DB).
//   2. Center db facade boots with dialect='mssql' (createMssqlDriver).
//   3. bootstrapMigrations + applyAll run all 18 db/migrations/mssql/*.sql
//      files on a clean DB (schema_migrations, ad_dcs, ad_agent_heartbeat,
//      ad_replication_status, package_runs, installed_packages, audit_logs,
//      etc.) without parsing or execution errors.
//   4. seedBuiltinPackages copies the bundled built-ins into the data dir,
//      upserts installed_packages, and applies migrations/mssql/*.sql per
//      built-in (pkg_ad_os_baseline, pkg_ad_local_port_check,
//      pkg_ad_domain_consistency). All 3 pkg_<name>.metrics tables exist.
//   5. metricstore.ingestRunV2 (the live code path used by
//      /api/agent/packages/report) accepts mock agent data for each
//      built-in and lands a row in pkg_<name>.metrics.
//   6. The round-tripped rows are queryable via the same db facade.
//
// Gate: requires TEST_MSSQL_URL in the form "user:password@host:port". The
// same URL is used for both the master DB (DROP/CREATE DATABASE) and the
// smoke DB (migrations + ingest). User must have CREATE DATABASE privilege.
//
// Teardown: drops the smoke database after verification so the SQL Server
// instance stays clean for other use. Safe to re-run; always drops +
// recreates the smoke DB.
//
// NOT in scope (would require VM + agent install + real PS1 runs):
//   - Real PowerShell collect.ps1 scripts (mocked payload only).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sql from 'mssql';
import { parseTestUrl } from './_url.js';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const PROJECT_ROOT = path.resolve(ROOT, '..');
const SOURCE_DIR = path.join(PROJECT_ROOT, 'publish', 'system', 'center', 'data', 'packages');
const DATA_DIR = path.join(ROOT, 'mock-mssql-e2e', 'data', 'packages');
const DB_NAME = 'addashboard_mssql_smoke';

function log(stage, msg) {
  console.log(`[${stage}] ${msg}`);
}

async function withAdminConn(serverCfg, work) {
  const pool = new sql.ConnectionPool({
    server: serverCfg.host,
    port: serverCfg.port,
    database: 'master',
    user: serverCfg.user,
    password: serverCfg.password,
    options: { encrypt: false, trustServerCertificate: true }
  });
  await pool.connect();
  try { return await work(pool); }
  finally { await pool.close(); }
}

async function provisionDatabase(serverCfg) {
  log('PROVISION', `Dropping + recreating ${DB_NAME}`);
  await withAdminConn(serverCfg, async (pool) => {
    await pool.request().batch(`
      IF EXISTS (SELECT 1 FROM sys.databases WHERE name = N'${DB_NAME}')
      BEGIN
        DECLARE @sql nvarchar(max) = N'';
        SELECT @sql = @sql + 'KILL ' + CAST(session_id AS nvarchar(10)) + ';'
          FROM sys.dm_exec_sessions WHERE database_id = DB_ID(N'${DB_NAME}');
        EXEC sp_executesql @sql;
        DROP DATABASE [${DB_NAME}];
      END;
    `);
    await pool.request().batch(`CREATE DATABASE [${DB_NAME}];`);
  });
  log('PROVISION', `Created ${DB_NAME}`);
}

async function teardownDatabase(serverCfg) {
  log('TEARDOWN', `Dropping ${DB_NAME}`);
  try {
    await withAdminConn(serverCfg, async (pool) => {
      await pool.request().batch(`
        IF EXISTS (SELECT 1 FROM sys.databases WHERE name = N'${DB_NAME}')
        BEGIN
          DECLARE @sql nvarchar(max) = N'';
          SELECT @sql = @sql + 'KILL ' + CAST(session_id AS nvarchar(10)) + ';'
            FROM sys.dm_exec_sessions WHERE database_id = DB_ID(N'${DB_NAME}');
          EXEC sp_executesql @sql;
          DROP DATABASE [${DB_NAME}];
        END;
      `);
    });
    log('TEARDOWN', 'OK');
  } catch (e) {
    log('TEARDOWN', `WARN: ${e.message}`);
  }
}

test('integration: live MSSQL end-to-end (mock agent path)', async (t) => {
  if (!process.env.TEST_MSSQL_URL) return t.skip('TEST_MSSQL_URL not set');
  const serverCfg = parseTestUrl('TEST_MSSQL_URL', { defaultPort: 1433 });
  log('START', `server=${serverCfg.host}:${serverCfg.port} user=${serverCfg.user}`);

  if (!fs.existsSync(SOURCE_DIR)) {
    throw new Error(`publish mirror missing: ${SOURCE_DIR}. Run scripts/build-green-package.ps1 + mirror sync first.`);
  }

  // Clean prior data-dir state so the seed copies fresh.
  if (fs.existsSync(DATA_DIR)) {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });

  await provisionDatabase(serverCfg);

  // Boot the center's db facade with MSSQL config. The facade wires
  // createMssqlDriver + buildSql('mssql') and runs bootstrapMigrations
  // (creates schema_migrations if missing — no-op here since we dropped).
  const { init, getDb, close } = await import(pathToFileURL(path.join(ROOT, 'src', 'db', 'index.js')).href);
  await init({
    db: {
      dialect: 'mssql',
      mssql: {
        server: serverCfg.host,
        port: serverCfg.port,
        database: DB_NAME,
        user: serverCfg.user,
        password: serverCfg.password,
        encrypt: false,
        trustServerCertificate: true
      }
    }
  });
  const db = getDb();
  log('DB', `Booted dialect=${db.dialect}`);

  try {
    // Run all schema + seed + migrations via the same code path the
    // init-mode / first-time wizard uses (init/schema-applier.js).
    const { applyAll } = await import(pathToFileURL(path.join(ROOT, 'src', 'init', 'schema-applier.js')).href);
    const applied = await applyAll('mssql', db);
    log('APPLY', `schema files=${applied.schema.length} seed=${applied.seed.length} migrations=${applied.migrations.length}`);

    // Verify a handful of expected tables exist post-migration.
    const expectedTables = [
      'schema_migrations', 'installed_packages', 'package_runs',
      'ad_dcs', 'ad_agent_heartbeat', 'ad_replication_status',
      'audit_logs', 'system_config', 'ad_member_servers'
    ];
    for (const tbl of expectedTables) {
      const r = await db.execute(
        `SELECT 1 FROM sys.tables WHERE name = ? AND schema_id = SCHEMA_ID('dbo')`,
        [tbl]
      );
      assert.equal(r.rows.length, 1, `expected table [dbo].[${tbl}] missing after migrations`);
    }
    log('VERIFY', `${expectedTables.length} dbo tables present`);

    // Seed built-ins: copies files + upserts installed_packages + applies
    // per-package migrations. Same code path the live center uses on
    // every normal-mode start (post round-13).
    const { seedBuiltinPackages } = await import(pathToFileURL(path.join(ROOT, 'src', 'services', 'builtin-packages.js')).href);
    await seedBuiltinPackages({ dataDir: DATA_DIR, sourceDir: SOURCE_DIR, db });
    log('SEED', 'seedBuiltinPackages complete');

    // Verify pkg_<name> schemas + metrics table exist
    const pkgSchemas = ['pkg_ad_os_baseline', 'pkg_ad_local_port_check', 'pkg_ad_domain_consistency'];
    for (const s of pkgSchemas) {
      const r = await db.execute(`SELECT 1 FROM sys.schemas WHERE name = ?`, [s]);
      assert.equal(r.rows.length, 1, `expected schema ${s} missing`);
      const tbl = await db.execute(
        `SELECT 1 FROM sys.tables WHERE name = 'metrics' AND schema_id = SCHEMA_ID(?)`,
        [s]
      );
      assert.equal(tbl.rows.length, 1, `expected ${s}.metrics missing`);
    }
    log('VERIFY', `3 pkg_<name>.metrics tables present`);

    // Mock agent report: invoke metricstore.ingestRunV2 for each built-in
    // with realistic data shapes. This is the EXACT code path
    // /api/agent/packages/report uses after parsing the agent's POST body.
    const { metricstore } = await import(pathToFileURL(path.join(ROOT, 'src', 'packages', 'metricstore.js')).href);
    const fsBuiltin = fs.readdirSync(SOURCE_DIR).filter(name =>
      fs.statSync(path.join(SOURCE_DIR, name)).isDirectory()
    );
    for (const name of fsBuiltin) {
      const manifestPath = path.join(SOURCE_DIR, name, '1.0.0', 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^﻿/, ''));
      if (!manifest.database?.metricTable) {
        log('INGEST', `skip ${name} (v1 package, no v2 metrics table)`);
        continue;
      }
      // Build a fake-but-valid payload covering every declared column.
      // JSON-typed columns must be stringified (MSSQL NVARCHAR(MAX) does
      // not auto-serialize JS objects).
      const metrics = {};
      for (const [k, decl] of Object.entries(manifest.database.metricSchema)) {
        if (k === 'agent_id' || k === 'ts') continue;
        const t = String(decl.type || '').toLowerCase();
        if (t.startsWith('int')) metrics[k] = 42;
        else if (t.startsWith('double') || t.startsWith('float') || t.startsWith('decimal') || t.startsWith('numeric')) metrics[k] = 3.14;
        else if (t.startsWith('json')) metrics[k] = JSON.stringify({ fake: true, ts: new Date().toISOString() });
        else metrics[k] = `mock-${name}-${k}`;
      }
      await metricstore.ingestRun(db, {
        agentId: 'mock-mssql-agent',
        packageName: name,
        manifest,
        runs: [{ metrics }]
      });
      log('INGEST', `${name}: 1 row inserted into ${manifest.database.schemaName}.metrics`);
    }

    // Round-trip read: query each pkg_<name>.metrics table and verify the
    // expected row exists with the expected agent_id.
    for (const s of pkgSchemas) {
      const r = await db.execute(
        `SELECT agent_id FROM [${s}].[metrics] WHERE agent_id = ?`,
        ['mock-mssql-agent']
      );
      assert.equal(r.rows.length, 1, `${s}.metrics expected 1 row for mock-mssql-agent, got ${r.rows.length}`);
      log('VERIFY', `${s}.metrics row round-trip OK`);
    }

    log('DONE', 'MSSQL end-to-end verification PASSED');
  } finally {
    await close();
    await teardownDatabase(serverCfg);
    // Clean up data dir (best-effort)
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  }
});
