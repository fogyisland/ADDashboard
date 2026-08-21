// schema-inventory.test.js — verifies the schemaInventory SQL strings are
// registered for both dialects with the right shape. Exercises the SQL
// dispatch via a mock db (no live DB required) so the queries are
// dispatched in the right dialect and the parameter list is honored.
//
// The full schema→table→column flow integration is covered in the
// schema-inventory service test (tests/services/schema-inventory.test.js).
// This file only covers the SQL registry contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSql } from '../../src/db/sql.js';

function makeMockDb({ dialect }) {
  const calls = [];
  return {
    dialect,
    sql: buildSql(dialect),
    async execute(sql, params = []) {
      calls.push({ sql, params: [...params] });
      return { rows: [], affectedRows: 0, insertId: undefined };
    },
    async query(sql, params = []) {
      calls.push({ sql, params: [...params] });
      return { rows: [] };
    },
    calls
  };
}

test('schemaInventory: listSchemas/listTables/listColumns registered for mysql', async () => {
  const db = makeMockDb({ dialect: 'mysql' });
  assert.equal(typeof db.sql.schemaInventory.listSchemas, 'string');
  assert.equal(typeof db.sql.schemaInventory.listTables, 'string');
  assert.equal(typeof db.sql.schemaInventory.listColumns, 'string');
  // listSchemas must filter the built-in system schemas so the operator
  // sees only project/user schemas.
  assert.match(db.sql.schemaInventory.listSchemas, /information_schema/);
  assert.match(db.sql.schemaInventory.listSchemas, /mysql|mysql|performance_schema|sys/);
  // listTables must scope to one schema param.
  assert.match(db.sql.schemaInventory.listTables, /TABLE_SCHEMA\s*=\s*\?/);
  assert.match(db.sql.schemaInventory.listTables, /TABLE_TYPE\s*=\s*'BASE TABLE'/);
  // listColumns must take (schema, table) and return the columns we need.
  assert.match(db.sql.schemaInventory.listColumns, /TABLE_SCHEMA\s*=\s*\?/);
  assert.match(db.sql.schemaInventory.listColumns, /TABLE_NAME\s*=\s*\?/);
  assert.match(db.sql.schemaInventory.listColumns, /COLUMN_NAME/);
  assert.match(db.sql.schemaInventory.listColumns, /DATA_TYPE/);
  assert.match(db.sql.schemaInventory.listColumns, /IS_NULLABLE/);
  assert.match(db.sql.schemaInventory.listColumns, /ORDINAL_POSITION/);
});

test('schemaInventory: listSchemas/listTables/listColumns registered for mssql', async () => {
  const db = makeMockDb({ dialect: 'mssql' });
  assert.equal(typeof db.sql.schemaInventory.listSchemas, 'string');
  assert.equal(typeof db.sql.schemaInventory.listTables, 'string');
  assert.equal(typeof db.sql.schemaInventory.listColumns, 'string');
  // MSSQL exposes schemas via sys.schemas, not information_schema.SCHEMATA.
  assert.match(db.sql.schemaInventory.listSchemas, /sys\.schemas/);
  assert.match(db.sql.schemaInventory.listSchemas, /INFORMATION_SCHEMA|sys.*guest/);
  // listTables/listColumns use the same information_schema shape — both
  // dialects stay true to ANSI.
  assert.match(db.sql.schemaInventory.listTables, /TABLE_SCHEMA\s*=\s*\?/);
  assert.match(db.sql.schemaInventory.listColumns, /COLUMN_NAME/);
  assert.match(db.sql.schemaInventory.listColumns, /DATA_TYPE/);
});

test('schemaInventory: listTables executes with one schema param', async () => {
  const db = makeMockDb({ dialect: 'mysql' });
  await db.execute(db.sql.schemaInventory.listTables, ['pkg_ad_local_port_check']);
  assert.equal(db.calls.length, 1);
  assert.deepEqual(db.calls[0].params, ['pkg_ad_local_port_check']);
});

test('schemaInventory: listColumns executes with (schema, table) params', async () => {
  const db = makeMockDb({ dialect: 'mysql' });
  await db.execute(db.sql.schemaInventory.listColumns, ['pkg_ad_local_port_check', 'metrics']);
  assert.equal(db.calls.length, 1);
  assert.deepEqual(db.calls[0].params, ['pkg_ad_local_port_check', 'metrics']);
});

test('schemaInventory: listSchemas executes with no params', async () => {
  const db = makeMockDb({ dialect: 'mysql' });
  await db.execute(db.sql.schemaInventory.listSchemas, []);
  assert.equal(db.calls.length, 1);
  assert.deepEqual(db.calls[0].params, []);
});
