// installer-v2-uninstall.test.js — real-DB integration tests for
// installer.uninstallPackage v2 path (manifest.database present). Gated on
// TEST_MYSQL_URL so the suite stays green on dev machines without a live
// MySQL.
//
// Run with:
//   TEST_MYSQL_URL=... npm test --workspace=center -- --test tests/packages/installer-v2-uninstall.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { init, close, getDb } from '../../src/db/index.js';
import { installer } from '../../src/packages/installer.js';
import { orphanSchemas } from '../../src/db/sql/orphan-schemas.js';
import { parseTestUrl } from '../integration/_url.js';

function buildV2Zip(name) {
  const zip = new AdmZip();
  const schema = `pkg_${name.replace(/-/g, '_')}`;
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    name, version: '1.0.0', type: 'gauge',
    agent: { minVersion: '1.0.0', script: 'collect.ps1', intervalSec: 60 },
    metrics: [{ key: 'val', label: 'Val' }],
    database: { schemaName: schema, migrations: [`migrations/001.sql`], metricTable: 'metrics',
      metricSchema: { agent_id: { type: 'varchar(64)', nullable: false }, ts: { type: 'datetime', nullable: false }, val: { type: 'double' } } }
  })));
  zip.addFile('collect.ps1', Buffer.from('Write-Output "{\"metrics\":{\"val\":0}}"'));
  zip.addFile('migrations/001.sql', Buffer.from(`CREATE TABLE ${schema}.metrics (agent_id VARCHAR(64) NOT NULL, ts DATETIME NOT NULL, val DOUBLE NOT NULL, PRIMARY KEY (agent_id, ts))`));
  return zip.toBuffer();
}

test('installer-v2-uninstall: drops schema when purgeMetrics=true and confirmDropSchema=true', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  await init({
    db: { dialect: 'mysql', mysql: { host, port, database: 'addashboard', user, password } },
    listenPort: 8080, jwtSecret: 'x', agentToken: 'x', staticDir: './dist', logLevel: 'silent', env: 'test'
  });
  const db = getDb();
  const name = 'ad-uninst-v2-ok';
  const schema = `pkg_${name.replace(/-/g, '_')}`;
  try {
    const buf = buildV2Zip(name);
    await installer.installPackage(db, { source: 'local', buffer: buf });
    await installer.uninstallPackage(db, { name, purgeMetrics: true, confirmDropSchema: true });
    const { rows } = await db.execute(`SELECT 1 FROM information_schema.schemata WHERE schema_name = ?`, [schema]);
    assert.strictEqual(rows.length, 0);
  } finally {
    try { await db.execute(`DROP DATABASE IF EXISTS \`${schema}\``); } catch {}
    try { await close(); } catch {}
  }
});

test('installer-v2-uninstall: rejects with PKG_CONFIRM_REQUIRED when confirmDropSchema missing', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  await init({
    db: { dialect: 'mysql', mysql: { host, port, database: 'addashboard', user, password } },
    listenPort: 8080, jwtSecret: 'x', agentToken: 'x', staticDir: './dist', logLevel: 'silent', env: 'test'
  });
  const db = getDb();
  const name = 'ad-uninst-v2-confirm';
  const schema = `pkg_${name.replace(/-/g, '_')}`;
  try {
    const buf = buildV2Zip(name);
    await installer.installPackage(db, { source: 'local', buffer: buf });
    await assert.rejects(
      () => installer.uninstallPackage(db, { name, purgeMetrics: true }),
      (err) => {
        assert.equal(err.code, 'PKG_CONFIRM_REQUIRED');
        assert.equal(err.status, 400);
        return true;
      }
    );
    // Schema still present
    const { rows } = await db.execute(`SELECT 1 FROM information_schema.schemata WHERE schema_name = ?`, [schema]);
    assert.strictEqual(rows.length, 1);
  } finally {
    try { await installer.uninstallPackage(db, { name, purgeMetrics: true, confirmDropSchema: true }); } catch {}
    try { await close(); } catch {}
  }
});

test('installer-v2-uninstall: records orphan_schemas when DROP fails', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  await init({
    db: { dialect: 'mysql', mysql: { host, port, database: 'addashboard', user, password } },
    listenPort: 8080, jwtSecret: 'x', agentToken: 'x', staticDir: './dist', logLevel: 'silent', env: 'test'
  });
  const db = getDb();
  const name = 'ad-uninst-v2-orphan';
  const schema = `pkg_${name.replace(/-/g, '_')}`;
  try {
    const buf = buildV2Zip(name);
    await installer.installPackage(db, { source: 'local', buffer: buf });

    // Simulate DROP failure. Easiest cross-env way: monkey-patch db.execute
    // to throw on DROP DATABASE so the installer's try/catch fires the
    // orphan-schemas record path.
    const origExecute = db.execute.bind(db);
    db.execute = async (sql, params) => {
      if (typeof sql === 'string' && /^DROP DATABASE/.test(sql)) {
        throw new Error('simulated DROP failure');
      }
      return origExecute(sql, params);
    };

    try {
      await installer.uninstallPackage(db, { name, purgeMetrics: true, confirmDropSchema: true });
    } finally {
      db.execute = origExecute;
    }

    const orphans = await orphanSchemas.list(db);
    const found = orphans.find(r => r.name === schema);
    assert.ok(found, `orphan_schemas should record ${schema}; got ${orphans.map(r => r.name).join(',')}`);
  } finally {
    try { await db.execute(`DROP DATABASE IF EXISTS \`${schema}\``); } catch {}
    try { await orphanSchemas.delete(db, `pkg_${name.replace(/-/g, '_')}`); } catch {}
    try { await close(); } catch {}
  }
});
