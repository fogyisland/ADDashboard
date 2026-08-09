// installer-v2-upgrade.test.js — real-DB integration tests for installer.upgradePackage
// v2 path (manifest.database present on both old AND new manifest). Pattern matches
// installer-v2.test.js: gated on TEST_MYSQL_URL so the suite stays green on dev
// machines without a live MySQL.
//
// Run with:
//   TEST_MYSQL_URL=... npm test --workspace=center -- --test tests/packages/installer-v2-upgrade.test.js
//
// Test approach: the v2 install path is exercised by T5 (installer-v2.test.js).
// Here we focus on the upgrade diff algorithm. We seed the install state
// directly (installed_packages row + pkg_<name>.schema_migrations row) and
// call upgradePackage to verify it applies only the new files and surfaces
// PKG_UPGRADE_FAILED + package_runs on mid-failure.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { init, close, getDb } from '../../src/db/index.js';
import { installer } from '../../src/packages/installer.js';
import { installedPackages } from '../../src/db/sql/installed-packages.js';
import { parseTestUrl } from '../integration/_url.js';

function buildV2Zip({ name, version, sqlFiles, metricSchema }) {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    name, version, type: 'gauge',
    agent: { minVersion: '1.0.0', script: 'collect.ps1', intervalSec: 60 },
    metrics: [{ key: 'val', label: 'Val' }],
    database: {
      schemaName: `pkg_${name.replace(/-/g, '_')}`,
      migrations: sqlFiles.map(f => `migrations/${f.filename}`),
      metricTable: 'metrics',
      metricSchema
    }
  })));
  zip.addFile('collect.ps1', Buffer.from('Write-Output "{\"metrics\":{\"val\":0}}"'));
  for (const f of sqlFiles) {
    zip.addFile(`migrations/${f.filename}`, Buffer.from(f.content));
  }
  return zip.toBuffer();
}

const SCHEMA = (name) => `pkg_${name.replace(/-/g, '_')}`;

// Seed an installed v2 package (1.0.0) without going through installer.installPackage
// so this test does not depend on the install-path code from T5. We need:
//  - installed_packages row with manifest.database
//  - pkg_<name> schema + schema_migrations table with one applied row
//
// All SQL uses fully qualified `<schema>.table` names — no `USE` — because
// mysql2's pool persists `USE` per-connection and a stray `USE pkg_x` in
// the test would leak into subsequent pool queries (causing them to look
// for tables in the wrong schema). The orchestrator's applyMigrations also
// has this issue (it does `USE <schema>` in createSchemaMigrationsTable),
// which is why the ddl-apply T4 tests pass only because the test does the
// `USE` last and ends; the v2 path then never reads from addashboard again.
async function seedV1Installed(db, { name, version, schema }) {
  const manifest = {
    name, version, type: 'gauge',
    agent: { minVersion: '1.0.0', script: 'collect.ps1', intervalSec: 60 },
    metrics: [{ key: 'val', label: 'Val' }],
    database: {
      schemaName: schema,
      migrations: ['migrations/001.sql'],
      metricTable: 'metrics',
      metricSchema: { agent_id: { type: 'varchar(64)', nullable: false }, ts: { type: 'datetime', nullable: false }, val: { type: 'double' } }
    }
  };
  // First insert the installed_packages row, BEFORE we touch the pkg schema —
  // so the mysql2 pool's "current database" stays as the center db and the
  // installed_packages upsert goes to the right place.
  await installedPackages.upsert(db, {
    name, version, type: 'gauge', manifest, enabled: true, params: null, source: 'local'
  });
  // Create the package schema + metrics table + schema_migrations. All
  // statements are fully qualified; the package schema's connection state
  // is restored by the next call (the orchestrator's applyMigrations also
  // does `USE` then a fully qualified INSERT, which the pool handles OK
  // because the INSERT targets the explicit schema).
  await db.execute(`CREATE DATABASE IF NOT EXISTS \`${schema}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await db.execute(`CREATE TABLE IF NOT EXISTS \`${schema}\`.schema_migrations (filename VARCHAR(255) NOT NULL PRIMARY KEY, version VARCHAR(32) NOT NULL, applied_at DATETIME NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await db.execute(`CREATE TABLE \`${schema}\`.metrics (agent_id VARCHAR(64) NOT NULL, ts DATETIME NOT NULL, val DOUBLE NOT NULL, PRIMARY KEY (agent_id, ts)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await db.execute(`INSERT INTO \`${schema}\`.schema_migrations (filename, version, applied_at) VALUES ('001.sql', ?, ?)`, [version, new Date()]);
}

test('installer-v2-upgrade: applies only new migration files', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const { user, password, host, port, host: _h } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  await init({
    db: { dialect: 'mysql', mysql: { host, port, database: 'addashboard', user, password } },
    listenPort: 8080, jwtSecret: 'x', agentToken: 'x', staticDir: './dist', logLevel: 'silent', env: 'test'
  });
  const db = getDb();
  const name = 'ad_upg_v2';
  const schema = SCHEMA(name);
  try {
    await seedV1Installed(db, { name, version: '1.0.0', schema });

    // Upgrade to 1.1.0 with one new migration
    const buf2 = buildV2Zip({
      name, version: '1.1.0',
      sqlFiles: [
        { filename: '001.sql', content: `CREATE TABLE ${schema}.metrics (agent_id VARCHAR(64) NOT NULL, ts DATETIME NOT NULL, val DOUBLE NOT NULL, PRIMARY KEY (agent_id, ts))` },
        { filename: '002.sql', content: `ALTER TABLE ${schema}.metrics ADD COLUMN extra DOUBLE NULL` }
      ],
      metricSchema: { agent_id: { type: 'varchar(64)', nullable: false }, ts: { type: 'datetime', nullable: false }, val: { type: 'double' }, extra: { type: 'double' } }
    });
    const candidateManifest = JSON.parse(new AdmZip(buf2).getEntry('manifest.json').getData().toString('utf8'));
    await installer.upgradePackage(db, { name, version: '1.1.0', manifest: candidateManifest, buffer: buf2 });

    // Use fully qualified reads (no `USE`) so the pool's connection state
    // doesn't leak into other tests.
    const { rows } = await db.execute(`SELECT filename FROM \`${schema}\`.schema_migrations ORDER BY filename`);
    assert.deepStrictEqual(rows.map(r => r.filename), ['001.sql', '002.sql']);

    const { rows: cols } = await db.execute(`SHOW COLUMNS FROM \`${schema}\`.metrics`);
    assert.ok(cols.some(c => c.Field === 'extra'), 'extra column should be present after upgrade');

    // The installed_packages row reflects the new version and new manifest.database.
    const pkg = await installedPackages.get(db, name);
    assert.equal(pkg.version, '1.1.0');
    assert.ok(pkg.manifest.database, 'manifest.database should be persisted on the installed row');
  } finally {
    try { await db.execute(`DROP DATABASE IF EXISTS \`${schema}\``); } catch {}
    try { await db.execute(`DELETE FROM installed_packages WHERE name = ?`, [name]); } catch {}
    try { await db.execute(`DELETE FROM package_runs WHERE package_name = ?`, [name]); } catch {}
    try { await close(); } catch {}
  }
});

test('installer-v2-upgrade: PKG_UPGRADE_FAILED on bad migration, partial state preserved', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  await init({
    db: { dialect: 'mysql', mysql: { host, port, database: 'addashboard', user, password } },
    listenPort: 8080, jwtSecret: 'x', agentToken: 'x', staticDir: './dist', logLevel: 'silent', env: 'test'
  });
  const db = getDb();
  const name = 'ad_upg_v2_bad';
  const schema = SCHEMA(name);
  try {
    await seedV1Installed(db, { name, version: '1.0.0', schema });

    // Upgrade to 1.1.0 with one new good + one new bad. MySQL DDL implicit-
    // commits, so 002_bogus.sql will be applied (creating `bogus`) before
    // 003_bad.sql fails on unknown table. That is the partial state we are
    // deliberately preserving per spec — no automatic rollback.
    const buf2 = buildV2Zip({
      name, version: '1.1.0',
      sqlFiles: [
        { filename: '002_bogus.sql', content: `CREATE TABLE ${schema}.bogus (id INT)` },
        { filename: '003_bad.sql', content: `ALTER TABLE ${schema}.does_not_exist ADD COLUMN x INT` }
      ],
      metricSchema: { agent_id: { type: 'varchar(64)', nullable: false }, ts: { type: 'datetime', nullable: false }, val: { type: 'double' } }
    });
    const candidateManifest = JSON.parse(new AdmZip(buf2).getEntry('manifest.json').getData().toString('utf8'));
    await assert.rejects(
      () => installer.upgradePackage(db, { name, version: '1.1.0', manifest: candidateManifest, buffer: buf2 }),
      (err) => {
        assert.equal(err.code, 'PKG_UPGRADE_FAILED', `expected PKG_UPGRADE_FAILED, got ${err.code}: ${err.message}`);
        return true;
      }
    );

    // Switch to the package schema to verify partial state
    const { rows } = await db.execute(`SELECT filename, version FROM \`${schema}\`.schema_migrations ORDER BY filename`);
    const filenames = rows.map(r => r.filename);
    assert.ok(filenames.includes('001.sql'), '001.sql from install should be present');
    assert.ok(filenames.includes('002_bogus.sql'), '002_bogus.sql should be present (partial state preserved)');
    assert.ok(!filenames.includes('003_bad.sql'), '003_bad.sql should NOT be present');

    // 002_bogus.sql was applied (CREATE TABLE completed + row inserted into
    // schema_migrations with version = '__pending__'), then 003_bad.sql failed
    // mid-apply. markMigrationsApplied was never called, so the 002_bogus.sql
    // row stays at '__pending__'. The version update is a single
    // markMigrationsApplied pass over all `toApply` filenames, so a partial
    // upgrade leaves the partial-apply rows at '__pending__'. Admin must
    // uninstall + reinstall to recover.
    const { rows: bogusRow } = await db.execute(
      `SELECT version FROM \`${schema}\`.schema_migrations WHERE filename = '002_bogus.sql'`
    );
    assert.equal(bogusRow[0].version, '__pending__', '002_bogus.sql should be at __pending__ because markMigrationsApplied never ran after the mid-apply failure');

    // A row was written to package_runs with the upgrade error message.
    const { rows: runRows } = await db.execute(
      `SELECT error FROM package_runs WHERE package_name = ? AND error LIKE '%upgrade mid-failure%'`,
      [name]
    );
    assert.ok(runRows.length >= 1, 'package_runs should record the upgrade mid-failure');

    // The installed_packages row was NOT updated to 1.1.0 — installer.upgradePackage
    // bails before the upsert when the DDL apply throws.
    const pkg = await installedPackages.get(db, name);
    assert.equal(pkg.version, '1.0.0', 'installed version should remain 1.0.0 after failed upgrade');
  } finally {
    try { await db.execute(`DROP DATABASE IF EXISTS \`${schema}\``); } catch {}
    try { await db.execute(`DELETE FROM installed_packages WHERE name = ?`, [name]); } catch {}
    try { await db.execute(`DELETE FROM package_runs WHERE package_name = ?`, [name]); } catch {}
    try { await close(); } catch {}
  }
});
