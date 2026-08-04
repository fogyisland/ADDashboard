// installed-packages.test.js — covers the installedPackages helper
// module against a mock db (no live DB required for unit tests).
//
// Pattern: matches center/tests/services.test.js's makeMockDb helper —
// records every execute/query call and lets the test shape per-SQL
// responses via _addScript(match, result).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSql } from '../../src/db/sql.js';
import {
  installedPackages,
  installedPackagesSql
} from '../../src/db/sql/installed-packages.js';

// ---- mock db factory ----

function makeMockDb({ dialect = 'mysql' } = {}) {
  const calls = [];
  const scripts = [];
  function lookup(sql) {
    for (const s of scripts) {
      if (s.match.test(sql)) {
        if (typeof s.result === 'function') return s.result();
        return s.result;
      }
    }
    return { rows: [], affectedRows: 0, insertId: undefined };
  }
  return {
    dialect,
    sql: buildSql(dialect),
    async execute(sql, params = []) {
      calls.push({ sql, params: [...params] });
      return lookup(sql);
    },
    async query(sql, params = []) {
      calls.push({ sql, params: [...params] });
      return { rows: lookup(sql).rows };
    },
    async transaction(work) {
      return work({
        execute: async (sql, params = []) => {
          calls.push({ sql, params: [...params] });
          return lookup(sql);
        },
        query: async (sql, params = []) => {
          calls.push({ sql, params: [...params] });
          return { rows: lookup(sql).rows };
        }
      });
    },
    _calls: calls,
    _addScript(match, result) { scripts.push({ match, result }); }
  };
}

// ---- SQL registry shape ----

test('installedPackagesSql: mysql.upsert uses ON DUPLICATE KEY UPDATE on (name)', () => {
  assert.match(installedPackagesSql.upsert.mysql, /INSERT INTO installed_packages/);
  assert.match(installedPackagesSql.upsert.mysql, /ON DUPLICATE KEY UPDATE/);
  assert.match(installedPackagesSql.upsert.mysql, /version = VALUES/);
  // 9 placeholders: name, version, type, manifest_json, enabled,
  // params_json, installed_at, updated_at, source.
  assert.strictEqual((installedPackagesSql.upsert.mysql.match(/\?/g) || []).length, 9);
});

test('installedPackagesSql: mssql.upsert uses MERGE on (name)', () => {
  assert.match(installedPackagesSql.upsert.mssql, /MERGE INTO installed_packages/i);
  assert.match(installedPackagesSql.upsert.mssql, /USING \(SELECT/);
  assert.match(installedPackagesSql.upsert.mssql, /ON t\.name = s\.name/);
  assert.strictEqual((installedPackagesSql.upsert.mssql.match(/\?/g) || []).length, 9);
});

test('installedPackagesSql: list and get/delete are simple SELECT/DELETE', () => {
  assert.match(installedPackagesSql.list.mysql, /SELECT \* FROM installed_packages/);
  assert.match(installedPackagesSql.get.mysql, /SELECT \* FROM installed_packages WHERE name = \?/);
  assert.match(installedPackagesSql.delete.mysql, /DELETE FROM installed_packages WHERE name = \?/);
  assert.match(installedPackagesSql.list.mssql, /SELECT \* FROM installed_packages/);
  assert.match(installedPackagesSql.get.mssql, /SELECT \* FROM installed_packages WHERE name = \?/);
  assert.match(installedPackagesSql.delete.mssql, /DELETE FROM installed_packages WHERE name = \?/);
});

// ---- helper function: upsert ----

test('installedPackages.upsert: stringifies manifest/params, passes 9 params', async () => {
  const db = makeMockDb();
  db._addScript(/INSERT\s+INTO\s+installed_packages/i, { rows: [], affectedRows: 1, insertId: 7 });
  await installedPackages.upsert(db, {
    name: 'pkg-a',
    version: '1.2.3',
    type: 'gauge',
    manifest: { name: 'pkg-a', version: '1.2.3', requires: { foo: 'bar' } },
    enabled: true,
    params: { intervalSec: 30 },
    source: 'local'
  });
  assert.equal(db._calls.length, 1);
  const call = db._calls[0];
  assert.match(call.sql, /INSERT INTO installed_packages/);
  assert.match(call.sql, /ON DUPLICATE KEY UPDATE/);
  assert.equal(call.params.length, 9);
  assert.equal(call.params[0], 'pkg-a');
  assert.equal(call.params[1], '1.2.3');
  assert.equal(call.params[2], 'gauge');
  // manifest is JSON-stringified.
  assert.equal(call.params[3], JSON.stringify({ name: 'pkg-a', version: '1.2.3', requires: { foo: 'bar' } }));
  // enabled is converted to 0/1.
  assert.equal(call.params[4], 1);
  assert.equal(call.params[5], JSON.stringify({ intervalSec: 30 }));
  // installed_at / updated_at are Date instances.
  assert.ok(call.params[6] instanceof Date);
  assert.ok(call.params[7] instanceof Date);
  assert.equal(call.params[8], 'local');
});

test('installedPackages.upsert: enabled=false emits 0', async () => {
  const db = makeMockDb();
  db._addScript(/INSERT\s+INTO\s+installed_packages/i, { rows: [], affectedRows: 1, insertId: 8 });
  await installedPackages.upsert(db, {
    name: 'pkg-b',
    version: '0.1.0',
    type: 'counter',
    manifest: { x: 1 },
    enabled: false,
    params: null,
    source: 'registry:default'
  });
  assert.equal(db._calls[0].params[4], 0);
  assert.equal(db._calls[0].params[5], null); // null params stays null
});

test('installedPackages.upsert: mssql uses MERGE sql', async () => {
  const db = makeMockDb({ dialect: 'mssql' });
  db._addScript(/MERGE\s+INTO\s+installed_packages/i, { rows: [], affectedRows: 1, insertId: 7 });
  await installedPackages.upsert(db, {
    name: 'pkg-c',
    version: '1.0.0',
    type: 'status',
    manifest: { name: 'pkg-c' },
    enabled: true,
    params: null,
    source: 'local'
  });
  assert.match(db._calls[0].sql, /MERGE INTO installed_packages/i);
  assert.equal(db._calls[0].params.length, 9);
});

// ---- helper function: get ----

test('installedPackages.get: returns hydrated row (manifest parsed, enabled bool)', async () => {
  const db = makeMockDb();
  db._addScript(/SELECT \* FROM installed_packages WHERE name = \?/i, {
    rows: [{
      id: 1,
      name: 'pkg-a',
      version: '1.0.0',
      type: 'gauge',
      manifest_json: JSON.stringify({ name: 'pkg-a', version: '1.0.0' }),
      enabled: 1,
      params_json: JSON.stringify({ intervalSec: 30 }),
      installed_at: new Date(),
      updated_at: new Date(),
      source: 'local'
    }],
    affectedRows: 0
  });
  const row = await installedPackages.get(db, 'pkg-a');
  assert.equal(row.name, 'pkg-a');
  assert.equal(row.enabled, true);
  assert.deepEqual(row.manifest, { name: 'pkg-a', version: '1.0.0' });
  assert.deepEqual(row.params, { intervalSec: 30 });
});

test('installedPackages.get: returns null when missing', async () => {
  const db = makeMockDb();
  db._addScript(/SELECT \* FROM installed_packages WHERE name = \?/i, { rows: [], affectedRows: 0 });
  const row = await installedPackages.get(db, 'does-not-exist');
  assert.equal(row, null);
});

test('installedPackages.get: enabled=0 hydrates to false', async () => {
  const db = makeMockDb();
  db._addScript(/SELECT \* FROM installed_packages WHERE name = \?/i, {
    rows: [{
      id: 2,
      name: 'pkg-off',
      version: '1.0.0',
      type: 'gauge',
      manifest_json: '{}',
      enabled: 0,
      params_json: null,
      installed_at: new Date(),
      updated_at: new Date(),
      source: 'local'
    }],
    affectedRows: 0
  });
  const row = await installedPackages.get(db, 'pkg-off');
  assert.equal(row.enabled, false);
  assert.equal(row.params, null);
});

// ---- helper function: list ----

test('installedPackages.list: default returns all rows hydrated', async () => {
  const db = makeMockDb();
  db._addScript(/SELECT \* FROM installed_packages ORDER BY name/i, {
    rows: [
      { id: 1, name: 'a', version: '1', type: 'gauge', manifest_json: '{"k":1}', enabled: 1, params_json: null, installed_at: new Date(), updated_at: new Date(), source: 's' },
      { id: 2, name: 'b', version: '2', type: 'counter', manifest_json: '{"k":2}', enabled: 0, params_json: '{}', installed_at: new Date(), updated_at: new Date(), source: 's' }
    ],
    affectedRows: 0
  });
  const rows = await installedPackages.list(db);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'a');
  assert.equal(rows[0].enabled, true);
  assert.deepEqual(rows[0].manifest, { k: 1 });
  assert.equal(rows[1].enabled, false);
  assert.deepEqual(rows[1].params, {});
});

test('installedPackages.list: enabledOnly=true uses the WHERE enabled=1 query', async () => {
  const db = makeMockDb();
  let capturedSql = null;
  db._addScript(/FROM installed_packages/i, () => {
    capturedSql = db._calls[db._calls.length - 1].sql;
    return { rows: [], affectedRows: 0 };
  });
  await installedPackages.list(db, { enabledOnly: true });
  assert.match(capturedSql, /WHERE enabled = 1/);
});

test('installedPackages.list: enabledOnly=false omits the WHERE clause', async () => {
  const db = makeMockDb();
  let capturedSql = null;
  db._addScript(/FROM installed_packages/i, () => {
    capturedSql = db._calls[db._calls.length - 1].sql;
    return { rows: [], affectedRows: 0 };
  });
  await installedPackages.list(db);
  assert.doesNotMatch(capturedSql, /WHERE/);
});

// ---- helper function: delete ----

test('installedPackages.delete: issues DELETE with the package name', async () => {
  const db = makeMockDb();
  db._addScript(/DELETE\s+FROM\s+installed_packages/i, { rows: [], affectedRows: 1 });
  await installedPackages.delete(db, 'pkg-x');
  assert.equal(db._calls.length, 1);
  assert.match(db._calls[0].sql, /DELETE FROM installed_packages WHERE name = \?/);
  assert.deepEqual(db._calls[0].params, ['pkg-x']);
});
