// migration-013.test.js — verifies migration 013 (orphan_schemas table)
// and the orphanSchemas SQL helpers round-trip against a live DB.
//
// Pattern follows probe-state.test.js (driver-level with parseTestUrl
// from tests/integration/_url.js). Tests are gated on TEST_MYSQL_URL /
// TEST_MSSQL_URL so the suite stays green on dev machines without a
// live DB.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVerifyMarker } from '../../src/init/verify-marker.js';
import { splitSqlStatements } from '../../src/init/schema-applier.js';
import { buildSql } from '../../src/db/sql.js';
import { createMysqlDriver } from '../../src/db/drivers/mysql.js';
import { createMssqlDriver } from '../../src/db/drivers/mssql.js';
import { parseTestUrl } from '../integration/_url.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

const MYSQL = !!process.env.TEST_MYSQL_URL;
const MSSQL = !!process.env.TEST_MSSQL_URL;

// Marker test runs always — both migrations must declare the verify
// marker so bootstrapMigrations can detect a clean apply.
test('migration 013 (mysql + mssql): declares "verify: table orphan_schemas" marker', () => {
  const mysql = parseVerifyMarker(fs.readFileSync(join(REPO_ROOT, 'db/migrations/013-orphan-schemas.sql'), 'utf8'));
  const mssql = parseVerifyMarker(fs.readFileSync(join(REPO_ROOT, 'db/migrations/mssql/013-orphan-schemas.sql'), 'utf8'));
  assert.ok(Array.isArray(mysql) && mysql.length > 0, 'mysql 013 must declare a verify marker');
  assert.ok(Array.isArray(mssql) && mssql.length > 0, 'mssql 013 must declare a verify marker');
  assert.ok(mysql.some(m => m.kind === 'table' && m.name === 'orphan_schemas'),
    `mysql 013 markers must include table orphan_schemas; got ${JSON.stringify(mysql)}`);
  assert.ok(mssql.some(m => m.kind === 'table' && m.name === 'orphan_schemas'),
    `mssql 013 markers must include table orphan_schemas; got ${JSON.stringify(mssql)}`);
});

// SQL registry shape — mirrors the convention from installed-packages.test.js.
test('orphanSchemasSql: mysql.upsert uses ON DUPLICATE KEY UPDATE on (name)', () => {
  // Build SQL via the registry (which bakes in dialect strings).
  const sql = buildSql('mysql');
  assert.match(sql.orphanSchemas.upsert, /INSERT INTO orphan_schemas/);
  assert.match(sql.orphanSchemas.upsert, /ON DUPLICATE KEY UPDATE/);
  assert.match(sql.orphanSchemas.upsert, /last_seen_at = VALUES\(last_seen_at\)/);
  assert.match(sql.orphanSchemas.upsert, /note = VALUES\(note\)/);
  assert.strictEqual((sql.orphanSchemas.upsert.match(/\?/g) || []).length, 3);
});

test('orphanSchemasSql: mssql.upsert uses MERGE on (name)', () => {
  const sql = buildSql('mssql');
  assert.match(sql.orphanSchemas.upsert, /MERGE INTO orphan_schemas/i);
  assert.match(sql.orphanSchemas.upsert, /USING \(SELECT/);
  assert.match(sql.orphanSchemas.upsert, /ON t\.name = s\.name/);
  assert.strictEqual((sql.orphanSchemas.upsert.match(/\?/g) || []).length, 3);
});

test('orphanSchemasSql: list orders by last_seen_at DESC; delete targets name', () => {
  const mysql = buildSql('mysql');
  const mssql = buildSql('mssql');
  for (const variant of [mysql, mssql]) {
    assert.match(variant.orphanSchemas.list, /SELECT \* FROM orphan_schemas/);
    assert.match(variant.orphanSchemas.list, /ORDER BY last_seen_at DESC/);
    assert.match(variant.orphanSchemas.delete, /DELETE FROM orphan_schemas WHERE name = \?/);
  }
});

test('migration 013 (mysql): orphan_schemas round-trip via upsert/list/delete', { skip: !MYSQL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  const db = createMysqlDriver({ host, port, user, password, database: 'addashboard' });
  const sql = buildSql('mysql');
  try {
    // Apply migration (idempotent via CREATE TABLE IF NOT EXISTS)
    const fileSql = fs.readFileSync(join(REPO_ROOT, 'db/migrations/013-orphan-schemas.sql'), 'utf8');
    for (const stmt of splitSqlStatements(fileSql)) {
      await db.execute(stmt, []);
    }

    // Table should now exist
    const probe = await db.execute(sql.probe.table, ['orphan_schemas']);
    assert.ok(probe.rows.length === 1, 'orphan_schemas table must exist after migration');

    // Upsert a row
    await db.execute(sql.orphanSchemas.upsert, ['pkg_test_xyz', new Date('2026-08-09T00:00:00Z'), 'unit test']);

    // list should include it
    const { rows: listed } = await db.execute(sql.orphanSchemas.list, []);
    const found = listed.find(r => r.name === 'pkg_test_xyz');
    assert.ok(found, 'pkg_test_xyz should appear in list');
    assert.strictEqual(found.note, 'unit test');

    // Upsert again (different note) — should update, not insert duplicate
    await db.execute(sql.orphanSchemas.upsert, ['pkg_test_xyz', new Date('2026-08-09T01:00:00Z'), 'updated note']);
    const { rows: relisted } = await db.execute(sql.orphanSchemas.list, []);
    const refound = relisted.find(r => r.name === 'pkg_test_xyz');
    assert.ok(refound, 'pkg_test_xyz should still exist after re-upsert');
    assert.strictEqual(refound.note, 'updated note', 'note must be updated by re-upsert');

    // delete should remove it
    await db.execute(sql.orphanSchemas.delete, ['pkg_test_xyz']);
    const { rows: after } = await db.execute(sql.orphanSchemas.list, []);
    assert.ok(!after.find(r => r.name === 'pkg_test_xyz'), 'pkg_test_xyz should be removed after delete');
  } finally {
    try { await db.execute(sql.orphanSchemas.delete, ['pkg_test_xyz']); } catch {}
    await db.close();
  }
});

test('migration 013 (mssql): orphan_schemas round-trip via upsert/list/delete', { skip: !MSSQL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MSSQL_URL', { defaultPort: 1433 });
  const db = createMssqlDriver({ server: host, port, database: 'addashboard', user, password });
  const sql = buildSql('mssql');
  try {
    const fileSql = fs.readFileSync(join(REPO_ROOT, 'db/migrations/mssql/013-orphan-schemas.sql'), 'utf8');
    for (const stmt of splitSqlStatements(fileSql)) {
      await db.execute(stmt, []);
    }

    const probe = await db.execute(sql.probe.table, ['orphan_schemas']);
    assert.ok(probe.rows.length === 1, 'orphan_schemas table must exist after migration');

    await db.execute(sql.orphanSchemas.upsert, ['pkg_test_xyz', new Date('2026-08-09T00:00:00Z'), 'unit test']);

    const { rows: listed } = await db.execute(sql.orphanSchemas.list, []);
    const found = listed.find(r => r.name === 'pkg_test_xyz');
    assert.ok(found, 'pkg_test_xyz should appear in list');
    assert.strictEqual(found.note, 'unit test');

    await db.execute(sql.orphanSchemas.upsert, ['pkg_test_xyz', new Date('2026-08-09T01:00:00Z'), 'updated note']);
    const { rows: relisted } = await db.execute(sql.orphanSchemas.list, []);
    const refound = relisted.find(r => r.name === 'pkg_test_xyz');
    assert.ok(refound, 'pkg_test_xyz should still exist after re-upsert');
    assert.strictEqual(refound.note, 'updated note', 'note must be updated by re-upsert');

    await db.execute(sql.orphanSchemas.delete, ['pkg_test_xyz']);
    const { rows: after } = await db.execute(sql.orphanSchemas.list, []);
    assert.ok(!after.find(r => r.name === 'pkg_test_xyz'), 'pkg_test_xyz should be removed after delete');
  } finally {
    try { await db.execute(sql.orphanSchemas.delete, ['pkg_test_xyz']); } catch {}
    await db.close();
  }
});

// Helper-function unit tests (no DB required). Same mock-db pattern as
// installed-packages.test.js.
test('orphanSchemas.upsert: passes name/lastSeenAt/note in that order', async () => {
  const calls = [];
  const db = {
    dialect: 'mysql',
    async execute(sql, params = []) {
      calls.push({ sql, params: [...params] });
      return { rows: [], affectedRows: 1 };
    }
  };
  // Import inside test so node:test can isolate failures cleanly.
  const { orphanSchemas } = await import('../../src/db/sql/orphan-schemas.js');
  await orphanSchemas.upsert(db, {
    name: 'pkg-a',
    lastSeenAt: new Date('2026-08-09T00:00:00Z'),
    note: 'drop failed: FK on metric_status'
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO orphan_schemas/);
  assert.equal(calls[0].params[0], 'pkg-a');
  assert.ok(calls[0].params[1] instanceof Date);
  assert.equal(calls[0].params[2], 'drop failed: FK on metric_status');
});

test('orphanSchemas.upsert: null note is passed through (not coerced to empty string)', async () => {
  const calls = [];
  const db = {
    dialect: 'mysql',
    async execute(sql, params = []) {
      calls.push({ sql, params: [...params] });
      return { rows: [], affectedRows: 1 };
    }
  };
  const { orphanSchemas } = await import('../../src/db/sql/orphan-schemas.js');
  await orphanSchemas.upsert(db, {
    name: 'pkg-no-note',
    lastSeenAt: new Date(),
    note: null
  });
  assert.strictEqual(calls[0].params[2], null);
});

test('orphanSchemas.upsert: mssql uses MERGE sql', async () => {
  const calls = [];
  const db = {
    dialect: 'mssql',
    async execute(sql, params = []) {
      calls.push({ sql, params: [...params] });
      return { rows: [], affectedRows: 1 };
    }
  };
  const { orphanSchemas } = await import('../../src/db/sql/orphan-schemas.js');
  await orphanSchemas.upsert(db, {
    name: 'pkg-c',
    lastSeenAt: new Date(),
    note: null
  });
  assert.match(calls[0].sql, /MERGE INTO orphan_schemas/i);
  assert.equal(calls[0].params.length, 3);
});

test('orphanSchemas.list: returns rows verbatim', async () => {
  const fakeRows = [
    { name: 'pkg-a', last_seen_at: new Date(), note: 'x' },
    { name: 'pkg-b', last_seen_at: new Date(), note: null }
  ];
  const calls = [];
  const db = {
    dialect: 'mysql',
    async execute(sql, params = []) {
      calls.push({ sql, params: [...params] });
      return { rows: fakeRows, affectedRows: 0 };
    }
  };
  const { orphanSchemas } = await import('../../src/db/sql/orphan-schemas.js');
  const rows = await orphanSchemas.list(db);
  assert.deepEqual(rows, fakeRows);
  assert.match(calls[0].sql, /SELECT \* FROM orphan_schemas ORDER BY last_seen_at DESC/);
});

test('orphanSchemas.delete: issues DELETE with the schema name', async () => {
  const calls = [];
  const db = {
    dialect: 'mysql',
    async execute(sql, params = []) {
      calls.push({ sql, params: [...params] });
      return { rows: [], affectedRows: 1 };
    }
  };
  const { orphanSchemas } = await import('../../src/db/sql/orphan-schemas.js');
  await orphanSchemas.delete(db, 'pkg-x');
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /DELETE FROM orphan_schemas WHERE name = \?/);
  assert.deepEqual(calls[0].params, ['pkg-x']);
});