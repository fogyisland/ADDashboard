// metricstore-v2.test.js — real-DB integration tests for metricstore.ingestRun
// v2 path (manifest.database.metricTable present). Pattern matches
// installer-v2-uninstall.test.js: gated on TEST_MYSQL_URL so the suite stays
// green on dev machines without a live MySQL.
//
// Run with:
//   TEST_MYSQL_URL=... npm test --workspace=center -- --test tests/packages/metricstore-v2.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { init, close, getDb } from '../../src/db/index.js';
import { installer } from '../../src/packages/installer.js';
import { installedPackages } from '../../src/db/sql/installed-packages.js';
import { metricstore } from '../../src/packages/metricstore.js';
import { parseTestUrl } from '../integration/_url.js';

function buildV2Zip(name, { nullable = true } = {}) {
  const zip = new AdmZip();
  const schema = `pkg_${name.replace(/-/g, '_')}`;
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    name, version: '1.0.0', type: 'gauge',
    agent: { minVersion: '1.0.0', script: 'collect.ps1', intervalSec: 60 },
    metrics: [{ key: 'val', label: 'Val' }],
    database: {
      schemaName: schema,
      migrations: ['migrations/001.sql'],
      metricTable: 'metrics',
      metricSchema: {
        agent_id: { type: 'varchar(64)', nullable: false },
        ts: { type: 'datetime', nullable: false },
        val: { type: 'double', nullable }
      }
    }
  })));
  zip.addFile('collect.ps1', Buffer.from(''));
  zip.addFile('migrations/001.sql', Buffer.from(`CREATE TABLE ${schema}.metrics (agent_id VARCHAR(64) NOT NULL, ts DATETIME NOT NULL, val DOUBLE NOT NULL, PRIMARY KEY (agent_id, ts))`));
  return zip.toBuffer();
}

test('metricstore-v2: ingestRun writes to pkg_<name>.<metricTable> for v2 packages', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  await init({
    db: { dialect: 'mysql', mysql: { host, port, database: 'addashboard', user, password } },
    listenPort: 8080, jwtSecret: 'x', agentToken: 'x', staticDir: './dist', logLevel: 'silent', env: 'test'
  });
  const db = getDb();
  const name = 'ad-mstore-v2';
  const schema = `pkg_${name.replace(/-/g, '_')}`;
  try {
    const buf = buildV2Zip(name);
    await installer.installPackage(db, { source: 'local', buffer: buf });
    const pkg = await installedPackages.get(db, name);
    const manifest = pkg.manifest;
    const agentId = 'agent-001';

    await metricstore.ingestRun(db, {
      agentId,
      packageName: name,
      manifest,
      runs: [{ metrics: { val: 78.4 }, error: null }]
    });

    const { rows } = await db.execute(`SELECT * FROM \`${schema}\`.metrics WHERE agent_id = ?`, [agentId]);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(Number(rows[0].val), 78.4);
    assert.strictEqual(rows[0].agent_id, agentId);
  } finally {
    try { await installer.uninstallPackage(db, { name, purgeMetrics: true, confirmDropSchema: true }); } catch {}
    try { await close(); } catch {}
  }
});

test('metricstore-v2: rejects PKG_METRIC_KEY_UNKNOWN for keys not in metricSchema', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  await init({
    db: { dialect: 'mysql', mysql: { host, port, database: 'addashboard', user, password } },
    listenPort: 8080, jwtSecret: 'x', agentToken: 'x', staticDir: './dist', logLevel: 'silent', env: 'test'
  });
  const db = getDb();
  const name = 'ad-mstore-v2-unknown';
  const schema = `pkg_${name.replace(/-/g, '_')}`;
  try {
    const buf = buildV2Zip(name);
    await installer.installPackage(db, { source: 'local', buffer: buf });
    const pkg = await installedPackages.get(db, name);
    const manifest = pkg.manifest;
    await assert.rejects(
      () => metricstore.ingestRun(db, {
        agentId: 'a', packageName: name, manifest,
        runs: [{ metrics: { val: 1, rogueKey: 99 }, error: null }]
      }),
      (err) => err.code === 'PKG_METRIC_KEY_UNKNOWN'
    );
  } finally {
    try { await installer.uninstallPackage(db, { name, purgeMetrics: true, confirmDropSchema: true }); } catch {}
    try { await close(); } catch {}
  }
});

test('metricstore-v2: rejects PKG_METRIC_TYPE_MISMATCH when DOUBLE column receives non-number', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  await init({
    db: { dialect: 'mysql', mysql: { host, port, database: 'addashboard', user, password } },
    listenPort: 8080, jwtSecret: 'x', agentToken: 'x', staticDir: './dist', logLevel: 'silent', env: 'test'
  });
  const db = getDb();
  const name = 'ad-mstore-v2-type';
  const schema = `pkg_${name.replace(/-/g, '_')}`;
  try {
    const buf = buildV2Zip(name);
    await installer.installPackage(db, { source: 'local', buffer: buf });
    const pkg = await installedPackages.get(db, name);
    const manifest = pkg.manifest;
    await assert.rejects(
      () => metricstore.ingestRun(db, {
        agentId: 'a', packageName: name, manifest,
        runs: [{ metrics: { val: '78.4' }, error: null }]
      }),
      (err) => err.code === 'PKG_METRIC_TYPE_MISMATCH'
    );
  } finally {
    try { await installer.uninstallPackage(db, { name, purgeMetrics: true, confirmDropSchema: true }); } catch {}
    try { await close(); } catch {}
  }
});

test('metricstore-v2: rejects PKG_METRIC_REQUIRED when required column missing', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  await init({
    db: { dialect: 'mysql', mysql: { host, port, database: 'addashboard', user, password } },
    listenPort: 8080, jwtSecret: 'x', agentToken: 'x', staticDir: './dist', logLevel: 'silent', env: 'test'
  });
  const db = getDb();
  const name = 'ad-mstore-v2-required';
  const schema = `pkg_${name.replace(/-/g, '_')}`;
  try {
    // Build a manifest where val is required (nullable: false) so we can
    // exercise the required-column check.
    const buf = buildV2Zip(name, { nullable: false });
    await installer.installPackage(db, { source: 'local', buffer: buf });
    const pkg = await installedPackages.get(db, name);
    const manifest = pkg.manifest;
    // Omit val — required column missing
    await assert.rejects(
      () => metricstore.ingestRun(db, {
        agentId: 'a', packageName: name, manifest,
        runs: [{ metrics: {}, error: null }]
      }),
      (err) => err.code === 'PKG_METRIC_REQUIRED'
    );
  } finally {
    try { await installer.uninstallPackage(db, { name, purgeMetrics: true, confirmDropSchema: true }); } catch {}
    try { await close(); } catch {}
  }
});

test('metricstore-v2: skips runs with run.error (no row written)', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  await init({
    db: { dialect: 'mysql', mysql: { host, port, database: 'addashboard', user, password } },
    listenPort: 8080, jwtSecret: 'x', agentToken: 'x', staticDir: './dist', logLevel: 'silent', env: 'test'
  });
  const db = getDb();
  const name = 'ad-mstore-v2-err';
  const schema = `pkg_${name.replace(/-/g, '_')}`;
  try {
    const buf = buildV2Zip(name);
    await installer.installPackage(db, { source: 'local', buffer: buf });
    const pkg = await installedPackages.get(db, name);
    const manifest = pkg.manifest;
    await metricstore.ingestRun(db, {
      agentId: 'a', packageName: name, manifest,
      runs: [{ metrics: { val: 1 }, error: 'script crashed' }]
    });
    const { rows } = await db.execute(`SELECT * FROM \`${schema}\`.metrics`);
    assert.strictEqual(rows.length, 0, 'errored run should not write any rows');
  } finally {
    try { await installer.uninstallPackage(db, { name, purgeMetrics: true, confirmDropSchema: true }); } catch {}
    try { await close(); } catch {}
  }
});