// installer-v2.test.js — real-DB integration tests for installer.installPackage
// v2 path (manifest.database present). Pattern matches ddl-apply.test.js:
// gated on TEST_MYSQL_URL so the suite stays green on dev machines without
// a live MySQL.
//
// Run with:
//   TEST_MYSQL_URL=... npm test --workspace=center -- --test tests/packages/installer-v2.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { init, close, getDb } from '../../src/db/index.js';
import { installer } from '../../src/packages/installer.js';
import { installedPackages } from '../../src/db/sql/installed-packages.js';
import { parseTestUrl } from '../integration/_url.js';

function buildV2Zip({ name, sqlFiles, metricSchema }) {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    name, version: '1.0.0', type: 'gauge',
    agent: { minVersion: '1.0.0', script: 'collect.ps1', intervalSec: 60 },
    metrics: [{ key: 'val', label: 'Val', unit: '%' }],
    database: {
      schemaName: `pkg_${name.replace(/-/g, '_')}`,
      migrations: sqlFiles.map(f => `migrations/${f.filename}`),
      metricTable: 'metrics',
      metricSchema
    }
  })));
  zip.addFile('collect.ps1', Buffer.from('Write-Output "{\"metrics\":{\"val\":0.0}}"'));
  for (const f of sqlFiles) {
    zip.addFile(`migrations/${f.filename}`, Buffer.from(f.content));
  }
  return zip.toBuffer();
}

const SCHEMA = (name) => `pkg_${name.replace(/-/g, '_')}`;

test('installer-v2: installs v2 package, applies DDL, writes installed_packages row', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  await init({
    db: { dialect: 'mysql', mysql: { host, port, database: 'ad_monitoring', user, password } },
    listenPort: 8080, jwtSecret: 'x', agentToken: 'x', staticDir: './dist', logLevel: 'silent', env: 'test'
  });
  const db = getDb();
  const name = 'ad-cpu-monitor-v2-install';
  const schema = SCHEMA(name);
  try {
    const buf = buildV2Zip({
      name,
      sqlFiles: [{ filename: '001.sql', content: `CREATE TABLE ${schema}.metrics (agent_id VARCHAR(64) NOT NULL, ts DATETIME NOT NULL, val DOUBLE NOT NULL, PRIMARY KEY (agent_id, ts))` }],
      metricSchema: { agent_id: { type: 'varchar(64)', nullable: false }, ts: { type: 'datetime', nullable: false }, val: { type: 'double' } }
    });
    await installer.installPackage(db, { source: 'local', buffer: buf });
    const pkg = await installedPackages.get(db, name);
    assert.ok(pkg);
    assert.deepStrictEqual(pkg.manifest.database.schemaName, schema);
    const { rows } = await db.execute(`SHOW TABLES FROM \`${schema}\``);
    const tables = rows.map(r => Object.values(r)[0]);
    assert.ok(tables.includes('metrics'));
    assert.ok(tables.includes('schema_migrations'));
  } finally {
    try { await installer.uninstallPackage(db, { name, purgeMetrics: true, confirmDropSchema: true }); } catch {}
    try { await db.execute(`DROP DATABASE IF EXISTS \`${schema}\``); } catch {}
    try { await close(); } catch {}
  }
});

test('installer-v2: rejects install with PKG_DDL_FORBIDDEN, leaves no residue', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  await init({
    db: { dialect: 'mysql', mysql: { host, port, database: 'ad_monitoring', user, password } },
    listenPort: 8080, jwtSecret: 'x', agentToken: 'x', staticDir: './dist', logLevel: 'silent', env: 'test'
  });
  const db = getDb();
  const name = 'ad-cpu-monitor-evil';
  const schema = SCHEMA(name);
  try {
    const buf = buildV2Zip({
      name,
      sqlFiles: [{ filename: '001.sql', content: 'DROP TABLE main.foo' }],
      metricSchema: { agent_id: { type: 'varchar(64)', nullable: false }, ts: { type: 'datetime', nullable: false }, val: { type: 'double' } }
    });
    await assert.rejects(
      () => installer.installPackage(db, { source: 'local', buffer: buf }),
      /PKG_DDL_FORBIDDEN/
    );
    const pkg = await installedPackages.get(db, name);
    assert.strictEqual(pkg, null);
    // No schema
    const { rows } = await db.execute(`SELECT 1 FROM information_schema.schemata WHERE schema_name = ?`, [schema]);
    assert.strictEqual(rows.length, 0);
  } finally {
    try { await db.execute(`DROP DATABASE IF EXISTS \`${schema}\``); } catch {}
    try { await close(); } catch {}
  }
});

test('installer-v2: PKG_SCHEMA_EXISTS when schema already present', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  await init({
    db: { dialect: 'mysql', mysql: { host, port, database: 'ad_monitoring', user, password } },
    listenPort: 8080, jwtSecret: 'x', agentToken: 'x', staticDir: './dist', logLevel: 'silent', env: 'test'
  });
  const db = getDb();
  const name = 'ad-cpu-monitor-dup';
  const schema = SCHEMA(name);
  try {
    // Pre-create schema
    await db.execute(`CREATE DATABASE IF NOT EXISTS \`${schema}\``);
    const buf = buildV2Zip({
      name,
      sqlFiles: [{ filename: '001.sql', content: `CREATE TABLE ${schema}.metrics (agent_id VARCHAR(64) NOT NULL)` }],
      metricSchema: { agent_id: { type: 'varchar(64)', nullable: false }, ts: { type: 'datetime', nullable: false }, val: { type: 'double' } }
    });
    await assert.rejects(
      () => installer.installPackage(db, { source: 'local', buffer: buf }),
      /PKG_SCHEMA_EXISTS/
    );
  } finally {
    try { await db.execute(`DROP DATABASE IF EXISTS \`${schema}\``); } catch {}
    try { await close(); } catch {}
  }
});
