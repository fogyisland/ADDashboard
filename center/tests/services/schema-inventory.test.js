// schema-inventory.test.js — covers getSchemaInventory + the pure diff
// helper against a mock db. The fixtures are shaped like the real
// information_schema rows so the contract is exercised end-to-end.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getSchemaInventory, _test } from '../../src/services/schema-inventory.js';
import { buildSql } from '../../src/db/sql.js';

function makeMockDb({ dialect = 'mysql', schemaFixtures, database }) {
  return {
    dialect,
    database,
    sql: buildSql(dialect),
    async execute(sql, params = []) {
      const s = String(sql);
      if (s.includes('information_schema.TABLES') && !s.includes('COLUMN_NAME')) {
        const schema = params[0];
        const tables = (schemaFixtures[schema] || []).map((t) => ({ table_name: t.name }));
        return { rows: tables };
      }
      if (s.includes('information_schema.COLUMNS')) {
        const [schema, table] = params;
        const t = (schemaFixtures[schema] || []).find((x) => x.name === table);
        return { rows: t ? t.columns : [] };
      }
      return { rows: [] };
    },
    async query(sql) {
      const s = String(sql);
      if (s.includes('information_schema.SCHEMATA') || s.includes('sys.schemas')) {
        const names = Object.keys(schemaFixtures);
        return { rows: names.map((n) => ({ schema_name: n })) };
      }
      return { rows: [] };
    }
  };
}

function pkgDir(tmp, pkgName, manifest) {
  const dir = path.join(tmp, pkgName, '1.0.0');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return tmp;
}

const PORT_MANIFEST = {
  name: 'ad-local-port-check',
  version: '1.0.0',
  database: {
    schemaName: 'pkg_ad_local_port_check',
    metricTable: 'metrics',
    metricSchema: {
      agent_id:   { type: 'varchar(64)', nullable: false },
      ts:         { type: 'datetime',    nullable: false },
      port_135:   { type: 'json' },
      port_445:   { type: 'json' },
      port_50001: { type: 'json' },
      port_50002: { type: 'json' },
      port_50003: { type: 'json' }
    }
  }
};

const CONSISTENCY_MANIFEST = {
  name: 'ad-domain-consistency',
  version: '1.0.0',
  database: {
    schemaName: 'pkg_ad_domain_consistency',
    metricTable: 'metrics',
    metricSchema: {
      agent_id:   { type: 'varchar(64)', nullable: false },
      ts:         { type: 'datetime',    nullable: false },
      user_count: { type: 'int' },
      user_hash:  { type: 'varchar(64)' },
      group_count:{ type: 'int' },
      group_hash: { type: 'varchar(64)' },
      gpo_count:  { type: 'int' },
      gpo_hash:   { type: 'varchar(64)' },
      error_code: { type: 'int' }
    }
  }
};

// ---- pure diff helper ----

test('computeDiff: in_sync when actual == expected', () => {
  const expected = { tables: [{ name: 'metrics', columns: [
    { name: 'agent_id', type: 'varchar(64)', nullable: false },
    { name: 'ts',       type: 'datetime',    nullable: false }
  ]}]};
  const actual = [{ name: 'metrics', columns: [
    { name: 'agent_id', type: 'varchar(64)', nullable: false },
    { name: 'ts',       type: 'datetime',    nullable: false }
  ]}];
  const d = _test.computeDiff(actual, expected);
  assert.equal(d.status, 'in_sync');
  assert.equal(d.missingTables.length, 0);
  assert.equal(d.extraTables.length, 0);
  assert.equal(d.missingColumns.length, 0);
  assert.equal(d.extraColumns.length, 0);
  assert.equal(d.typeMismatches.length, 0);
});

test('computeDiff: missing table → drift', () => {
  const expected = { tables: [{ name: 'metrics', columns: [] }] };
  const actual = [];
  const d = _test.computeDiff(actual, expected);
  assert.equal(d.status, 'drift');
  assert.deepEqual(d.missingTables, [{ name: 'metrics', columns: [] }]);
});

test('computeDiff: extra table → drift', () => {
  const expected = { tables: [] };
  const actual = [{ name: 'junk', columns: [] }];
  const d = _test.computeDiff(actual, expected);
  assert.equal(d.status, 'drift');
  assert.deepEqual(d.extraTables, ['junk']);
});

test('computeDiff: missing column → drift', () => {
  const expected = { tables: [{ name: 'metrics', columns: [
    { name: 'agent_id', type: 'varchar(64)' },
    { name: 'ts',       type: 'datetime' }
  ]}]};
  const actual = [{ name: 'metrics', columns: [
    { name: 'agent_id', type: 'varchar(64)' }
  ]}];
  const d = _test.computeDiff(actual, expected);
  assert.equal(d.status, 'drift');
  assert.equal(d.missingColumns.length, 1);
  assert.equal(d.missingColumns[0].name, 'ts');
});

test('computeDiff: extra column → drift', () => {
  const expected = { tables: [{ name: 'metrics', columns: [
    { name: 'agent_id', type: 'varchar(64)' }
  ]}]};
  const actual = [{ name: 'metrics', columns: [
    { name: 'agent_id', type: 'varchar(64)' },
    { name: 'noise',    type: 'int' }
  ]}];
  const d = _test.computeDiff(actual, expected);
  assert.equal(d.status, 'drift');
  assert.equal(d.extraColumns.length, 1);
  assert.equal(d.extraColumns[0].name, 'noise');
});

test('computeDiff: type mismatch on a real column → drift', () => {
  const expected = { tables: [{ name: 'metrics', columns: [
    { name: 'agent_id', type: 'varchar(64)' }
  ]}]};
  const actual = [{ name: 'metrics', columns: [
    { name: 'agent_id', type: 'int' }
  ]}];
  const d = _test.computeDiff(actual, expected);
  assert.equal(d.status, 'drift');
  assert.equal(d.typeMismatches.length, 1);
  assert.equal(d.typeMismatches[0].name, 'agent_id');
  assert.equal(d.typeMismatches[0].expectedType, 'varchar(64)');
  assert.equal(d.typeMismatches[0].actualType, 'int');
});

test('computeDiff: json expected ↔ nvarchar actual (MSSQL) is equivalent', () => {
  const expected = { tables: [{ name: 'metrics', columns: [
    { name: 'port_135', type: 'json' }
  ]}]};
  const actual = [{ name: 'metrics', columns: [
    { name: 'port_135', type: 'nvarchar(max)' }
  ]}];
  const d = _test.computeDiff(actual, expected);
  assert.equal(d.status, 'in_sync');
  assert.equal(d.typeMismatches.length, 0);
});

test('computeDiff: varchar ↔ nvarchar is equivalent', () => {
  const expected = { tables: [{ name: 'metrics', columns: [
    { name: 'agent_id', type: 'varchar(64)' }
  ]}]};
  const actual = [{ name: 'metrics', columns: [
    { name: 'agent_id', type: 'nvarchar(64)' }
  ]}];
  const d = _test.computeDiff(actual, expected);
  assert.equal(d.status, 'in_sync');
});

// ---- manifestToExpected ----

test('manifestToExpected: produces metricTable with metricSchema columns', () => {
  const got = _test.manifestToExpected(PORT_MANIFEST);
  assert.equal(got.version, '1.0.0');
  assert.equal(got.tables.length, 1);
  assert.equal(got.tables[0].name, 'metrics');
  const colNames = got.tables[0].columns.map((c) => c.name);
  assert.deepEqual(colNames, ['agent_id', 'ts', 'port_135', 'port_445', 'port_50001', 'port_50002', 'port_50003']);
  assert.equal(got.tables[0].columns[0].nullable, false);
  assert.equal(got.tables[0].columns[2].nullable, true);
});

// ---- end-to-end getSchemaInventory ----

test('getSchemaInventory: pkg_* schema with manifest match → in_sync', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-inv-'));
  try {
    const dataDir = pkgDir(tmp, 'ad-local-port-check', PORT_MANIFEST);
    const db = makeMockDb({
      schemaFixtures: {
        'pkg_ad_local_port_check': [{
          name: 'metrics',
          columns: [
            { column_name: 'agent_id', column_type: 'varchar(64)', is_nullable: 'NO' },
            { column_name: 'ts',       column_type: 'datetime',    is_nullable: 'NO' },
            { column_name: 'port_135', column_type: 'json',        is_nullable: 'YES' },
            { column_name: 'port_445', column_type: 'json',        is_nullable: 'YES' },
            { column_name: 'port_50001', column_type: 'json',      is_nullable: 'YES' },
            { column_name: 'port_50002', column_type: 'json',      is_nullable: 'YES' },
            { column_name: 'port_50003', column_type: 'json',      is_nullable: 'YES' }
          ]
        }]
      }
    });
    const inv = await getSchemaInventory(db, { dataDir });
    assert.equal(inv.schemas.length, 1);
    const s = inv.schemas[0];
    assert.equal(s.name, 'pkg_ad_local_port_check');
    assert.equal(s.source, 'package:ad-local-port-check/1.0.0');
    assert.equal(s.status, 'in_sync');
    // We always attach diff for pkg_* schemas (status + structure for the
    // operator's UI); "in_sync" just means the diff arrays are empty.
    assert.equal(s.diff.status, 'in_sync');
    assert.equal(s.diff.missingColumns.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('getSchemaInventory: pkg_* schema with missing column → drift', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-inv-'));
  try {
    const dataDir = pkgDir(tmp, 'ad-domain-consistency', CONSISTENCY_MANIFEST);
    const db = makeMockDb({
      schemaFixtures: {
        'pkg_ad_domain_consistency': [{
          name: 'metrics',
          columns: [
            { column_name: 'agent_id',   column_type: 'varchar(64)', is_nullable: 'NO' },
            { column_name: 'ts',         column_type: 'datetime',    is_nullable: 'NO' },
            { column_name: 'user_count', column_type: 'int',         is_nullable: 'YES' }
            // missing: user_hash, group_count, group_hash, gpo_count, gpo_hash, error_code
          ]
        }]
      }
    });
    const inv = await getSchemaInventory(db, { dataDir });
    assert.equal(inv.schemas[0].status, 'drift');
    assert.equal(inv.schemas[0].diff.missingColumns.length, 6);
    const missingNames = inv.schemas[0].diff.missingColumns.map((c) => c.name).sort();
    assert.deepEqual(missingNames, ['error_code', 'gpo_count', 'gpo_hash', 'group_count', 'group_hash', 'user_hash']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('getSchemaInventory: system schema (no manifest) → status=system', async () => {
  const db = makeMockDb({
    database: 'addashboard',
    schemaFixtures: {
      'addashboard': [{
        name: 'ad_users',
        columns: [
          { column_name: 'id', column_type: 'int', is_nullable: 'NO' }
        ]
      }]
    }
  });
  const inv = await getSchemaInventory(db, { dataDir: '/nonexistent' });
  assert.equal(inv.schemas.length, 1);
  assert.equal(inv.schemas[0].name, 'addashboard');
  assert.equal(inv.schemas[0].source, 'system');
  assert.equal(inv.schemas[0].status, 'system');
  assert.equal(inv.schemas[0].expected, null);
});

test('getSchemaInventory: pkg_* schema but no manifest on disk → falls through to system', async () => {
  const db = makeMockDb({
    database: 'addashboard',
    schemaFixtures: {
      'pkg_ad_orphan': []
    }
  });
  const inv = await getSchemaInventory(db, { dataDir: '/nonexistent' });
  assert.equal(inv.schemas[0].status, 'system');
  assert.equal(inv.schemas[0].source, 'system');
});

test('getSchemaInventory: extra table in pkg_* schema → drift', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-inv-'));
  try {
    const dataDir = pkgDir(tmp, 'ad-local-port-check', PORT_MANIFEST);
    const db = makeMockDb({
      schemaFixtures: {
        'pkg_ad_local_port_check': [
          { name: 'metrics', columns: [{ column_name: 'agent_id', column_type: 'varchar(64)', is_nullable: 'NO' }] },
          { name: 'leftover', columns: [{ column_name: 'junk', column_type: 'int', is_nullable: 'YES' }] }
        ]
      }
    });
    const inv = await getSchemaInventory(db, { dataDir });
    assert.equal(inv.schemas[0].status, 'drift');
    assert.deepEqual(inv.schemas[0].diff.extraTables, ['leftover']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('getSchemaInventory: default filters out unrelated schemas (only center DB + pkg_*)', async () => {
  const db = makeMockDb({
    database: 'addashboard',
    schemaFixtures: {
      'addashboard':             [{ name: 'ad_users', columns: [] }],
      'pkg_ad_local_port_check': [{ name: 'metrics', columns: [] }],
      'pudafo_testpilot':        [],
      'suanming':                [],
      'exdashboard_test':        []
    }
  });
  const inv = await getSchemaInventory(db, { dataDir: '/nonexistent' });
  const names = inv.schemas.map((s) => s.name).sort();
  assert.deepEqual(names, ['addashboard', 'pkg_ad_local_port_check']);
});

test('getSchemaInventory: includeAll bypasses the center-only filter', async () => {
  const db = makeMockDb({
    database: 'addashboard',
    schemaFixtures: {
      'addashboard':      [],
      'pudafo_testpilot': [],
      'suanming':         []
    }
  });
  const inv = await getSchemaInventory(db, { dataDir: '/nonexistent', includeAll: true });
  assert.equal(inv.schemas.length, 3);
});
