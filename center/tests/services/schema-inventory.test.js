// schema-inventory.test.js — covers the code ↔ DB inventory service.
// The shape: scanCenterCodeForTables finds table names in source,
// migration-parser extracts expected CREATE TABLE columns from SQL files,
// then the service compares against information_schema for actual state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getCodeSchemaInventory, _test } from '../../src/services/schema-inventory.js';

// Pure diff tests — no fixtures needed.
test('_test.diffColumns: identical columns → in_sync', () => {
  const diff = _test.diffColumns(
    [{ name: 'id', type: 'int', nullable: false }, { name: 'name', type: 'varchar(64)', nullable: false }],
    [{ name: 'id', type: 'int', nullable: false }, { name: 'name', type: 'varchar(64)', nullable: false }]
  );
  assert.equal(diff.status, 'in_sync');
});

test('_test.diffColumns: missing column surfaces in missingColumns', () => {
  const diff = _test.diffColumns(
    [{ name: 'id', type: 'int', nullable: false }, { name: 'name', type: 'varchar(64)', nullable: false }],
    [{ name: 'id', type: 'int', nullable: false }]
  );
  assert.equal(diff.status, 'drift');
  assert.deepEqual(diff.missingColumns, [{ name: 'name', expectedType: 'varchar(64)' }]);
});

test('_test.diffColumns: extra column surfaces in extraColumns', () => {
  const diff = _test.diffColumns(
    [{ name: 'id', type: 'int', nullable: false }],
    [{ name: 'id', type: 'int', nullable: false }, { name: 'junk', type: 'int', nullable: true }]
  );
  assert.equal(diff.status, 'drift');
  assert.deepEqual(diff.extraColumns, [{ name: 'junk', actualType: 'int' }]);
});

test('_test.diffColumns: json ↔ nvarchar/varchar/text is equivalent', () => {
  for (const alias of ['nvarchar', 'varchar', 'text', 'longtext', 'ntext', 'char']) {
    const diff = _test.diffColumns(
      [{ name: 'payload', type: 'json', nullable: true }],
      [{ name: 'payload', type: alias, nullable: true }]
    );
    assert.equal(diff.status, 'in_sync', `json ↔ ${alias} should be equivalent`);
  }
});

test('_test.diffColumns: varchar ↔ nvarchar is equivalent', () => {
  const diff = _test.diffColumns(
    [{ name: 'name', type: 'varchar(64)', nullable: false }],
    [{ name: 'name', type: 'nvarchar(64)', nullable: false }]
  );
  assert.equal(diff.status, 'in_sync');
});

test('_test.diffColumns: type mismatch surfaces in typeMismatches', () => {
  const diff = _test.diffColumns(
    [{ name: 'name', type: 'varchar(64)', nullable: false }],
    [{ name: 'name', type: 'int', nullable: false }]
  );
  assert.equal(diff.status, 'drift');
  assert.equal(diff.typeMismatches.length, 1);
  assert.equal(diff.typeMismatches[0].name, 'name');
});

// End-to-end with real fixtures: code-scanned tables, migration-parsed
// expectations, mock DB actual state.
function makeFixtureCode(srcRoot) {
  fs.writeFileSync(path.join(srcRoot, 'a.js'), `
    const q1 = "SELECT * FROM ad_users WHERE id = ?";
    const q2 = "SELECT * FROM ad_sites";
    const q3 = "UPDATE ad_users SET role = ? WHERE id = ?";
  `);
}

function makeFixtureMigrations(repoRoot) {
  const schemaDir = path.join(repoRoot, 'db', 'schema');
  const migDir = path.join(repoRoot, 'db', 'migrations');
  fs.mkdirSync(schemaDir, { recursive: true });
  fs.mkdirSync(migDir, { recursive: true });
  fs.writeFileSync(path.join(schemaDir, '01-tables.sql'),
    `CREATE TABLE IF NOT EXISTS ad_users (
       id BIGINT AUTO_INCREMENT PRIMARY KEY,
       username VARCHAR(64) NOT NULL,
       role VARCHAR(32) NOT NULL DEFAULT 'viewer'
     );
     CREATE TABLE IF NOT EXISTS ad_sites (
       id INT PRIMARY KEY,
       name VARCHAR(64) NOT NULL
     );`);
}

function makeMockDb(actualByTable) {
  return {
    database: 'addashboard',
    sql: {
      schemaInventory: {
        listColumns: 'LIST_COLUMNS_SQL'
      }
    },
    async execute(sql, params) {
      if (sql === 'LIST_COLUMNS_SQL') {
        const [schema, table] = params;
        const cols = (actualByTable[table] || []).slice();
        return { rows: cols };
      }
      return { rows: [] };
    }
  };
}

test('getCodeSchemaInventory: end-to-end on a small fixture', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-repo-'));
  const srcRoot = path.join(repoRoot, 'center', 'src');
  fs.mkdirSync(srcRoot, { recursive: true });
  try {
    makeFixtureCode(srcRoot);
    makeFixtureMigrations(repoRoot);

    const db = makeMockDb({
      'ad_users': [
        { column_name: 'id', column_type: 'bigint', is_nullable: 'NO' },
        { column_name: 'username', column_type: 'varchar(64)', is_nullable: 'NO' },
        { column_name: 'role', column_type: 'varchar(32)', is_nullable: 'NO' }
      ],
      'ad_sites': [
        { column_name: 'id', column_type: 'int', is_nullable: 'NO' },
        { column_name: 'name', column_type: 'varchar(64)', is_nullable: 'NO' }
      ]
    });

    const inv = await getCodeSchemaInventory(db, {
      srcRoot,
      repoRoot,
      dataDir: ''
    });
    // Single schema (addashboard) since none of the tables are pkg_*.
    assert.equal(inv.schemas.length, 1);
    assert.equal(inv.schemas[0].name, 'addashboard');
    // Two tables referenced in code, both in_sync.
    assert.equal(inv.schemas[0].tables.length, 2);
    for (const t of inv.schemas[0].tables) {
      assert.equal(t.status, 'in_sync', `${t.name} should be in_sync`);
    }
    // codeRefs present for both tables.
    const adUsers = inv.schemas[0].tables.find((t) => t.name === 'ad_users');
    assert.ok(adUsers.codeRefs.length >= 2);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('getCodeSchemaInventory: drift when actual is missing a column', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-repo-'));
  const srcRoot = path.join(repoRoot, 'center', 'src');
  fs.mkdirSync(srcRoot, { recursive: true });
  try {
    makeFixtureCode(srcRoot);
    makeFixtureMigrations(repoRoot);
    // ad_users in DB but missing the `role` column → drift.
    const db = makeMockDb({
      'ad_users': [
        { column_name: 'id', column_type: 'bigint', is_nullable: 'NO' },
        { column_name: 'username', column_type: 'varchar(64)', is_nullable: 'NO' }
      ]
    });
    const inv = await getCodeSchemaInventory(db, { srcRoot, repoRoot, dataDir: '' });
    const adUsers = inv.schemas[0].tables.find((t) => t.name === 'ad_users');
    assert.equal(adUsers.status, 'drift');
    assert.equal(adUsers.diff.missingColumns.length, 1);
    assert.equal(adUsers.diff.missingColumns[0].name, 'role');
    // ad_sites has no DB rows → missing_in_db.
    const adSites = inv.schemas[0].tables.find((t) => t.name === 'ad_sites');
    assert.equal(adSites.status, 'missing_in_db');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('getCodeSchemaInventory: pkg_* schema reads expected from manifest', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-repo-'));
  const srcRoot = path.join(repoRoot, 'center', 'src');
  fs.mkdirSync(srcRoot, { recursive: true });
  try {
    fs.writeFileSync(path.join(srcRoot, 'a.js'), `
      const q = "INSERT INTO pkg_ad_local_port_check.metrics (agent_id) VALUES (?)";
    `);
    const dataDir = path.join(repoRoot, 'center', 'data', 'packages');
    fs.mkdirSync(path.join(dataDir, 'ad-local-port-check', '1.0.0'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'ad-local-port-check', '1.0.0', 'manifest.json'),
      JSON.stringify({
        version: '1.0.0',
        database: {
          schemaName: 'pkg_ad_local_port_check',
          metricTable: 'metrics',
          metricSchema: {
            agent_id: { type: 'varchar(64)', nullable: false },
            ts: { type: 'datetime', nullable: false },
            port_135: { type: 'json', nullable: true }
          }
        }
      }));
    // Matched DB columns → in_sync.
    const db = makeMockDb({
      'metrics': [
        { column_name: 'agent_id', column_type: 'varchar(64)', is_nullable: 'NO' },
        { column_name: 'ts', column_type: 'datetime', is_nullable: 'NO' },
        { column_name: 'port_135', column_type: 'json', is_nullable: 'YES' }
      ]
    });
    // makeMockDb always lists against the configured schema. For pkg_*
    // we override the listColumns query so the right schema gets hit.
    db.execute = async (sql, params) => {
      if (sql === 'LIST_COLUMNS_SQL') {
        const [schema, table] = params;
        const cols = (schema === 'pkg_ad_local_port_check' && table === 'metrics')
          ? db._actualMetrics : [];
        return { rows: cols };
      }
      return { rows: [] };
    };
    db._actualMetrics = [
      { column_name: 'agent_id', column_type: 'varchar(64)', is_nullable: 'NO' },
      { column_name: 'ts', column_type: 'datetime', is_nullable: 'NO' },
      { column_name: 'port_135', column_type: 'json', is_nullable: 'YES' }
    ];
    const inv = await getCodeSchemaInventory(db, { srcRoot, repoRoot, dataDir });
    assert.equal(inv.schemas.length, 1);
    assert.equal(inv.schemas[0].name, 'pkg_ad_local_port_check');
    const tbl = inv.schemas[0].tables[0];
    assert.equal(tbl.name, 'metrics');
    assert.equal(tbl.source, 'package');
    assert.equal(tbl.status, 'in_sync');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('getCodeSchemaInventory: returns empty schemas when code references no tables', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-repo-'));
  const srcRoot = path.join(repoRoot, 'center', 'src');
  fs.mkdirSync(srcRoot, { recursive: true });
  try {
    fs.writeFileSync(path.join(srcRoot, 'a.js'), 'const x = 1 + 2;');
    const db = makeMockDb({});
    const inv = await getCodeSchemaInventory(db, { srcRoot, repoRoot, dataDir: '' });
    assert.deepEqual(inv.schemas, []);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});