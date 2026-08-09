// e2e: self-contained v2 package — install → agent run → report → uninstall.
//
// Single real-DB end-to-end test exercising the full v2 self-contained package
// pipeline against a live MySQL connection. Pattern follows
// tests/packages/installer-v2.test.js + tests/integration/probe-loop.test.js
// (both gated on TEST_MYSQL_URL per project convention — see
// feedback_real_db_sql_tests.md).
//
// Why this test belongs in tests/e2e/ (and not tests/packages/ or
// tests/integration/): it stitches together the installer v2 path
// (T5), the metricstore v2 ingest path (T8), and the uninstaller v2 path
// (T7) into a single pipeline — the kind of cross-layer coverage that
// belongs at the e2e tier.
//
// Run with:
//   TEST_MYSQL_URL=... npm test --workspace=center -- --test tests/e2e/self-contained-package.test.js
//
// Database note: the brief's example used `database: 'ad_monitoring'`, but
// ad_monitoring does NOT have `installed_packages` / `package_runs` /
// `orphan_schemas` tables — those live in the main `addashboard` database.
// This test switches to `'addashboard'` (same one appsettings.json points
// at in production). Tasks 5/6/7 already established this is the
// "established pre-existing parked concern"; this test resolves it for the
// e2e tier by using the right database from the start.
//
// Manifest schema note: the actual v2 manifest schema (center/src/packages/manifest.js)
// uses `metricSchema` (an object keyed by metric name → { type, nullable }).
// The brief's example manifest object matches this — no drift to fix here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { init, close, getDb } from '../../src/db/index.js';
import { installer } from '../../src/packages/installer.js';
import { metricstore } from '../../src/packages/metricstore.js';
import { orphanSchemas } from '../../src/db/sql/orphan-schemas.js';
import { parseTestUrl } from '../integration/_url.js';

function buildV2Zip(name, schemaName) {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    name, version: '1.0.0', type: 'gauge',
    agent: { minVersion: '1.0.0', script: 'collect.ps1', intervalSec: 60 },
    metrics: [{ key: 'cpu_pct', label: 'CPU%' }],
    database: {
      schemaName,
      migrations: ['migrations/001.sql'],
      metricTable: 'metrics',
      metricSchema: {
        agent_id: { type: 'varchar(64)', nullable: false },
        ts: { type: 'datetime', nullable: false },
        cpu_pct: { type: 'double' }
      }
    }
  })));
  zip.addFile('collect.ps1', Buffer.from(''));
  zip.addFile('migrations/001.sql', Buffer.from(
    `CREATE TABLE ${schemaName}.metrics (agent_id VARCHAR(64) NOT NULL, ts DATETIME NOT NULL, cpu_pct DOUBLE NOT NULL, PRIMARY KEY (agent_id, ts))`
  ));
  return zip.toBuffer();
}

test('e2e: self-contained package install → agent run → report → uninstall', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  // Use 'addashboard' (not 'ad_monitoring'): installed_packages / package_runs /
  // orphan_schemas all live in the main app database, not in the wizard's
  // initial-setup ad_monitoring database.
  await init({
    db: { dialect: 'mysql', mysql: { host, port, database: 'addashboard', user, password } },
    listenPort: 8080, jwtSecret: 'x', agentToken: 'x', staticDir: './dist', logLevel: 'silent', env: 'test'
  });
  const db = getDb();
  const name = 'ad-e2e-v2';
  const schema = 'pkg_ad_e2e_v2';
  try {
    // 1. Install v2 package — should create schema, apply migration, write installed_packages row
    const buf = buildV2Zip(name, schema);
    const installResult = await installer.installPackage(db, { source: 'local', buffer: buf });
    assert.strictEqual(installResult.name, name);
    assert.strictEqual(installResult.version, '1.0.0');

    // 2. Simulate agent run + report via metricstore directly.
    // mysql2 auto-parses JSON columns to objects; no JSON.parse needed.
    const pkg = (await db.execute(`SELECT manifest_json FROM installed_packages WHERE name = ?`, [name])).rows[0];
    const manifest = pkg.manifest_json;
    await metricstore.ingestRun(db, {
      agentId: 'agent-e2e',
      packageName: name,
      manifest,
      runs: [{ metrics: { cpu_pct: 78.4 }, error: null }]
    });

    // 3. Verify metric table populated
    const { rows } = await db.execute(`SELECT * FROM \`${schema}\`.metrics WHERE agent_id = ?`, ['agent-e2e']);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(Number(rows[0].cpu_pct), 78.4);

    // 4. Uninstall with confirm
    await installer.uninstallPackage(db, { name, purgeMetrics: true, confirmDropSchema: true });

    // 5. Verify schema gone
    const { rows: stillThere } = await db.execute(`SELECT 1 FROM information_schema.schemata WHERE schema_name = ?`, [schema]);
    assert.strictEqual(stillThere.length, 0);
    // Verify installed_packages row gone
    const { rows: pkgRows } = await db.execute(`SELECT 1 FROM installed_packages WHERE name = ?`, [name]);
    assert.strictEqual(pkgRows.length, 0);

    // 6. Re-install same package works (idempotency of the install path post-uninstall)
    await installer.installPackage(db, { source: 'local', buffer: buf });
    // Re-ingest a second run to prove the new install is functional
    const pkg2 = (await db.execute(`SELECT manifest_json FROM installed_packages WHERE name = ?`, [name])).rows[0];
    const manifest2 = pkg2.manifest_json;
    await metricstore.ingestRun(db, {
      agentId: 'agent-e2e',
      packageName: name,
      manifest: manifest2,
      runs: [{ metrics: { cpu_pct: 50.0 }, error: null }]
    });
    const { rows: rows2 } = await db.execute(`SELECT * FROM \`${schema}\`.metrics WHERE agent_id = ?`, ['agent-e2e']);
    assert.strictEqual(rows2.length, 1);
    assert.strictEqual(Number(rows2[0].cpu_pct), 50.0);

    // 7. Final cleanup uninstall
    await installer.uninstallPackage(db, { name, purgeMetrics: true, confirmDropSchema: true });
    const { rows: stillThere2 } = await db.execute(`SELECT 1 FROM information_schema.schemata WHERE schema_name = ?`, [schema]);
    assert.strictEqual(stillThere2.length, 0);
  } finally {
    // Best-effort cleanup — make sure no residue leaks between test runs.
    try { await installer.uninstallPackage(db, { name, purgeMetrics: true, confirmDropSchema: true }); } catch {}
    try { await db.execute(`DROP DATABASE IF EXISTS \`${schema}\``); } catch {}
    try { await orphanSchemas.delete(db, schema); } catch {}
    try { await db.execute(`DELETE FROM installed_packages WHERE name = ?`, [name]); } catch {}
    try { await close(); } catch {}
  }
});
