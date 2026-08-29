// metricstore-v2.test.js — real-DB integration tests for metricstore.ingestRun
// v2 path (manifest.database.metricTable present). Pattern matches
// installer-v2-uninstall.test.js: gated on TEST_MYSQL_URL so the suite stays
// green on dev machines without a live MySQL.
//
// R66 T13 — rewritten to seed packages via script-service.installScript +
// setPolicy (V1 two-table path) instead of the deleted installer.installPackage
// V0 ZIP flow. The metricstore.ingestRun contract is unchanged — it still
// reads the merged manifest from the input arg — so the test assertions
// carry over verbatim.
//
// Run with:
//   TEST_MYSQL_URL=... npm test --workspace=center -- --test tests/packages/metricstore-v2.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, close, getDb } from '../../src/db/index.js';
import { installScript, setPolicy } from '../../src/packages/script-service.js';
import { packageScripts } from '../../src/db/sql/package-scripts.js';
import { metricstore } from '../../src/packages/metricstore.js';
import { parseTestUrl } from '../integration/_url.js';

function buildV2Manifest(name, { nullable = true } = {}) {
  return {
    name,
    version: '1.0.0',
    type: 'gauge',
    description: 'metricstore-v2 fixture',
    agent: { type: 'ad', script: 'collect.ps1' },
    metrics: [{ key: 'val', label: 'Val' }],
    database: {
      schemaName: `pkg_${name.replace(/-/g, '_')}`,
      // The schema DDL itself is still applied by hand here — script-service
      // does NOT manage schema migrations (those are an installer concern);
      // metricstore v2 only needs the table to exist + a valid
      // metricSchema on the merged manifest it ingests against.
      migrations: ['migrations/001.sql'],
      metricTable: 'metrics',
      metricSchema: {
        agent_id: { type: 'varchar(64)', nullable: false },
        ts: { type: 'datetime', nullable: false },
        val: { type: 'double', nullable }
      }
    }
  };
}

async function applyV2Schema(db, name) {
  const schema = `pkg_${name.replace(/-/g, '_')}`;
  await db.execute(
    `CREATE TABLE IF NOT EXISTS \`${schema}\`.metrics (agent_id VARCHAR(64) NOT NULL, ts DATETIME NOT NULL, val DOUBLE NOT NULL, PRIMARY KEY (agent_id, ts))`
  );
  return schema;
}

async function seedV2Package(db, name, { nullable = true } = {}) {
  // R66 T13 — V1 path: installScript writes package_scripts + a default
  // package_policies row; setPolicy flips enabled=true and overrides any
  // metricSchema fields. No ZIP buffer, no AdmZip.
  const manifest = buildV2Manifest(name, { nullable });
  const content = `Write-Output '{"metrics":{"val":0.0}}'`;
  await installScript({
    db, name, content, type: 'gauge', agentType: 'ad',
    description: manifest.description, intervalSec: 60, timeoutMs: 30000,
    source: 'test-metricstore-v2'
  });
  // script-service doesn't apply DDL — caller owns schema creation in this
  // fixture. The merged manifest surfaced to metricstore.ingestRun still
  // includes manifest.database so the v2 path fires.
  const schema = await applyV2Schema(db, name);
  // Fetch the row the service just wrote (manifest stored JSON-stringified
  // in package_scripts; script-service.test.js mirrors this contract).
  const row = await packageScripts.get(db, name);
  return { manifest: row.manifest, schema };
}

async function cleanupV2Package(db, name) {
  const schema = `pkg_${name.replace(/-/g, '_')}`;
  try { await db.execute(`DROP DATABASE IF EXISTS \`${schema}\``); } catch {}
  try { await db.execute(`DELETE FROM package_policies WHERE name = ?`, [name]); } catch {}
  try { await db.execute(`DELETE FROM package_scripts WHERE name = ?`, [name]); } catch {}
}

test('metricstore-v2: ingestRun writes to pkg_<name>.<metricTable> for v2 packages', { skip: !process.env.TEST_MYSQL_URL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  await init({
    db: { dialect: 'mysql', mysql: { host, port, database: 'addashboard', user, password } },
    listenPort: 8080, jwtSecret: 'x', agentToken: 'x', staticDir: './dist', logLevel: 'silent', env: 'test'
  });
  const db = getDb();
  const name = 'ad-mstore-v2';
  try {
    const { manifest, schema } = await seedV2Package(db, name);
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
    try { await cleanupV2Package(db, name); } catch {}
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
  try {
    const { manifest } = await seedV2Package(db, name);
    await assert.rejects(
      () => metricstore.ingestRun(db, {
        agentId: 'a', packageName: name, manifest,
        runs: [{ metrics: { val: 1, rogueKey: 99 }, error: null }]
      }),
      (err) => err.code === 'PKG_METRIC_KEY_UNKNOWN'
    );
  } finally {
    try { await cleanupV2Package(db, name); } catch {}
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
  try {
    const { manifest } = await seedV2Package(db, name);
    await assert.rejects(
      () => metricstore.ingestRun(db, {
        agentId: 'a', packageName: name, manifest,
        runs: [{ metrics: { val: '78.4' }, error: null }]
      }),
      (err) => err.code === 'PKG_METRIC_TYPE_MISMATCH'
    );
  } finally {
    try { await cleanupV2Package(db, name); } catch {}
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
  try {
    // Build a manifest where val is required (nullable: false) so we can
    // exercise the required-column check.
    const { manifest } = await seedV2Package(db, name, { nullable: false });
    // Omit val — required column missing
    await assert.rejects(
      () => metricstore.ingestRun(db, {
        agentId: 'a', packageName: name, manifest,
        runs: [{ metrics: {}, error: null }]
      }),
      (err) => err.code === 'PKG_METRIC_REQUIRED'
    );
  } finally {
    try { await cleanupV2Package(db, name); } catch {}
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
  try {
    const { manifest, schema } = await seedV2Package(db, name);
    await metricstore.ingestRun(db, {
      agentId: 'a', packageName: name, manifest,
      runs: [{ metrics: { val: 1 }, error: 'script crashed' }]
    });
    const { rows } = await db.execute(`SELECT * FROM \`${schema}\`.metrics`);
    assert.strictEqual(rows.length, 0, 'errored run should not write any rows');
  } finally {
    try { await cleanupV2Package(db, name); } catch {}
    try { await close(); } catch {}
  }
});
