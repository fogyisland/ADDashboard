import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerifyMarker, verifyMarkers } from '../src/init/verify-marker.js';
import { buildSql } from '../src/db/sql.js';

test('parses single table marker', () => {
  const sql = '-- verify: table sys_config_audit\nCREATE TABLE foo (...);';
  assert.deepStrictEqual(parseVerifyMarker(sql), [
    { kind: 'table', name: 'sys_config_audit' }
  ]);
});

test('parses single column marker', () => {
  const sql = '-- verify: column ad_dcs.is_pdc\nALTER TABLE ...;';
  assert.deepStrictEqual(parseVerifyMarker(sql), [
    { kind: 'column', name: 'ad_dcs.is_pdc' }
  ]);
});

test('parses multiple markers in same file', () => {
  const sql = [
    '-- 001-foo.sql',
    '-- verify: column ad_sites.description',
    '-- verify: column ad_dcs.is_gc',
    'CREATE TABLE bar (...);'
  ].join('\n');
  assert.deepStrictEqual(parseVerifyMarker(sql), [
    { kind: 'column', name: 'ad_sites.description' },
    { kind: 'column', name: 'ad_dcs.is_gc' }
  ]);
});

test('returns empty array for SQL with no markers', () => {
  const sql = 'CREATE TABLE foo (id INT);\nINSERT INTO foo VALUES (1);';
  assert.deepStrictEqual(parseVerifyMarker(sql), []);
});

test('stops scanning after 50 lines', () => {
  // 50 non-marker lines, then marker on line 51 — should NOT be parsed
  const lines = [];
  for (let i = 0; i < 50; i++) lines.push(`-- comment line ${i}`);
  lines.push('-- verify: table should_not_be_seen');
  const sql = lines.join('\n');
  assert.deepStrictEqual(parseVerifyMarker(sql), []);
});

test('ignores markers inside block comments', () => {
  const sql = [
    '/*',
    '-- verify: table inside_comment',
    '*/',
    '-- verify: table outside_comment',
    'CREATE TABLE foo;'
  ].join('\n');
  assert.deepStrictEqual(parseVerifyMarker(sql), [
    { kind: 'table', name: 'outside_comment' }
  ]);
});

test('case-insensitive verify keyword', () => {
  const sql = '-- VERIFY: TABLE sys_config_audit\n';
  assert.deepStrictEqual(parseVerifyMarker(sql), [
    { kind: 'table', name: 'sys_config_audit' }
  ]);
});

test('whitespace tolerant between tokens', () => {
  const sql = '--   verify:    table   sys_config_audit   \n';
  assert.deepStrictEqual(parseVerifyMarker(sql), [
    { kind: 'table', name: 'sys_config_audit' }
  ]);
});

// --- verifyMarkers ---

// Mock db shaped like the real facade: db.sql is the already dialect-resolved
// tree from buildSql() (see src/db/index.js), so probe SQL lives at
// db.sql.probe.{table,column} — NOT db.sql[dialect].probe. Using the real
// buildSql output here means a wiring mistake fails the test instead of
// passing against hand-written SQL that production never sees.
function mockDb(dialect, { presentTables = new Set(), presentColumns = new Set() } = {}) {
  const sql = buildSql(dialect);
  const calls = [];
  return {
    dialect,
    sql,
    calls,
    query: (text, params) => {
      calls.push({ text, params });
      if (text === sql.probe.table) {
        return Promise.resolve({ rows: presentTables.has(params[0]) ? [{ ok: 1 }] : [] });
      }
      if (text === sql.probe.column) {
        const colKey = `${params[0]}.${params[1]}`;
        return Promise.resolve({ rows: presentColumns.has(colKey) ? [{ ok: 1 }] : [] });
      }
      throw new Error(`unexpected probe SQL: ${text}`);
    }
  };
}

test('verifyMarkers: all present → ok=true, missing=[]', async () => {
  const db = mockDb('mysql', { presentTables: new Set(['sys_config_audit']) });
  const markers = [{ kind: 'table', name: 'sys_config_audit' }];
  const result = await verifyMarkers(db, markers);
  assert.deepStrictEqual(result, { ok: true, missing: [] });
});

test('verifyMarkers: one table missing → ok=false, missing=[table X]', async () => {
  const db = mockDb('mysql', { presentTables: new Set() });
  const markers = [{ kind: 'table', name: 'sys_config_audit' }];
  const result = await verifyMarkers(db, markers);
  assert.equal(result.ok, false);
  assert.deepStrictEqual(result.missing, ['table sys_config_audit']);
});

test('verifyMarkers: mixed kinds, column missing → ok=false, column missing in list', async () => {
  const db = mockDb('mysql', {
    presentTables: new Set(['sys_config_audit']),
    presentColumns: new Set()  // ad_dcs.is_pdc missing
  });
  const markers = [
    { kind: 'table', name: 'sys_config_audit' },
    { kind: 'column', name: 'ad_dcs.is_pdc' }
  ];
  const result = await verifyMarkers(db, markers);
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes('column ad_dcs.is_pdc'));
  assert.ok(!result.missing.includes('table sys_config_audit'));
});

test('verifyMarkers: column marker splits name into [table, column] params', async () => {
  const db = mockDb('mysql', { presentColumns: new Set(['ad_dcs.is_pdc']) });
  const result = await verifyMarkers(db, [{ kind: 'column', name: 'ad_dcs.is_pdc' }]);
  assert.equal(result.ok, true);
  assert.deepStrictEqual(db.calls[0].params, ['ad_dcs', 'is_pdc']);
});

test('verifyMarkers: works against mssql probe SQL too', async () => {
  const db = mockDb('mssql', {
    presentTables: new Set(['schema_migrations']),
    presentColumns: new Set()
  });
  const result = await verifyMarkers(db, [
    { kind: 'table', name: 'schema_migrations' },
    { kind: 'column', name: 'ad_dcs.is_pdc' }
  ]);
  assert.equal(result.ok, false);
  assert.deepStrictEqual(result.missing, ['column ad_dcs.is_pdc']);
});

test('verifyMarkers: empty marker list → ok=true without querying', async () => {
  const db = mockDb('mysql');
  const result = await verifyMarkers(db, []);
  assert.deepStrictEqual(result, { ok: true, missing: [] });
  assert.equal(db.calls.length, 0);
});

test('verifyMarkers: unqualified column marker is reported missing, not probed', async () => {
  const db = mockDb('mysql');
  const result = await verifyMarkers(db, [{ kind: 'column', name: 'is_pdc' }]);
  assert.equal(result.ok, false);
  assert.deepStrictEqual(result.missing, ['column is_pdc (malformed)']);
  assert.equal(db.calls.length, 0);
});