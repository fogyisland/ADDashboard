import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitSqlStatements } from '../../src/init/schema-applier.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('splitSqlStatements splits on ; followed by newline', () => {
  const sql = 'CREATE TABLE a (id INT);\nCREATE TABLE b (id INT);\n';
  assert.deepStrictEqual(splitSqlStatements(sql), [
    'CREATE TABLE a (id INT)',
    'CREATE TABLE b (id INT)'
  ]);
});

test('splitSqlStatements ignores semicolons inside single-quoted strings', () => {
  const sql = "INSERT INTO t (v) VALUES ('a;b');\nINSERT INTO t (v) VALUES ('c');";
  assert.deepStrictEqual(splitSqlStatements(sql), [
    "INSERT INTO t (v) VALUES ('a;b')",
    "INSERT INTO t (v) VALUES ('c')"
  ]);
});

test('splitSqlStatements ignores semicolons inside double-quoted strings', () => {
  const sql = 'INSERT INTO t (v) VALUES ("a;b");\nSELECT 1;';
  assert.deepStrictEqual(splitSqlStatements(sql), [
    'INSERT INTO t (v) VALUES ("a;b")',
    'SELECT 1'
  ]);
});

test('splitSqlStatements keeps IF/END block as a single statement', () => {
  const sql = `IF OBJECT_ID('t', 'U') IS NULL
BEGIN
  CREATE TABLE t (id INT);
END;
SELECT 1;`;
  const out = splitSqlStatements(sql);
  assert.strictEqual(out.length, 2);
  assert.match(out[0], /IF OBJECT_ID/);
  assert.match(out[0], /END/);
  assert.strictEqual(out[1], 'SELECT 1');
});

test('splitSqlStatements drops empty statements', () => {
  const sql = 'SELECT 1;;;\nSELECT 2;';
  assert.deepStrictEqual(splitSqlStatements(sql), ['SELECT 1', 'SELECT 2']);
});

test('splitSqlStatements handles real schema file (smoke test against db/schema/mssql/01-tables.sql)', () => {
  const sql = readFileSync(join(__dirname, '../../../db/schema/mssql/01-tables.sql'), 'utf8');
  const stmts = splitSqlStatements(sql);
  // 9 CREATE TABLE blocks (per spec) — assert at least 9
  assert.ok(stmts.length >= 9, `expected >= 9 statements, got ${stmts.length}`);
  // Each statement must contain non-whitespace
  for (const s of stmts) assert.ok(s.trim().length > 0);
});

test('splitSqlStatements handles MySQL DELIMITER $$ directives', () => {
  const sql = 'DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$\nDELIMITER ;\nSELECT 2;';
  const stmts = splitSqlStatements(sql);
  // Expect exactly 2 statements — DELIMITER directives must be stripped (they're
  // client-side, not server-side), and the procedure body (which contains ;)
  // must remain one statement terminated by $$.
  assert.strictEqual(stmts.length, 2, `expected 2 statements, got ${stmts.length}: ${JSON.stringify(stmts)}`);
  assert.match(stmts[0], /CREATE PROCEDURE p\(\) BEGIN SELECT 1; END/);
  assert.doesNotMatch(stmts[0], /DELIMITER/);
  assert.match(stmts[1], /SELECT 2/);
});

test('splitSqlStatements handles real mysql migration with DELIMITER (db/migrations/001-dc-site-discovery.sql)', () => {
  const sql = readFileSync(join(__dirname, '../../../db/migrations/001-dc-site-discovery.sql'), 'utf8');
  const stmts = splitSqlStatements(sql);
  // Expect at minimum: the CREATE PROCEDURE statement, the CALL statements batch, and the INSERT statement
  assert.ok(stmts.length >= 2, `expected >= 2 statements, got ${stmts.length}`);
  // Must contain the CREATE PROCEDURE as a single statement (the stored proc body has ; inside)
  const procStmt = stmts.find(s => /CREATE PROCEDURE/.test(s));
  assert.ok(procStmt, 'expected a single CREATE PROCEDURE statement');
  assert.match(procStmt, /BEGIN/);
  assert.match(procStmt, /END/);
  // Must also include CALL statements (these use the default ; delimiter)
  assert.ok(stmts.some(s => /CALL migrate_001_add_column_if_missing/.test(s)));
});

import { applyAll } from '../../src/init/schema-applier.js';
import { buildMockDb } from '../helpers/db-mock.js';

test('applyAll executes schema, seed, and migrations via db.execute', async () => {
  const calls = [];
  const db = buildMockDb().withRecording(calls);
  const result = await applyAll('mysql', db, { repoRoot: process.cwd() + '/..' });
  const sqls = calls.map(c => c.sql);
  assert.ok(calls.length > 0);
  // At least one CREATE TABLE statement
  assert.ok(sqls.some(s => /CREATE TABLE/i.test(s)));
  // Returns applied structure
  assert.ok(Array.isArray(result.schema));
  assert.ok(Array.isArray(result.seed));
  assert.ok(Array.isArray(result.migrations));
});

test('applyAll mysql createDatabase option issues CREATE DATABASE', async () => {
  const calls = [];
  const db = buildMockDb().withRecording(calls);
  await applyAll('mysql', db, { repoRoot: process.cwd() + '/..', createDatabase: true, databaseName: 'ad_test' });
  const sqls = calls.map(c => c.sql);
  assert.ok(sqls.some(s => /CREATE DATABASE IF NOT EXISTS `ad_test`/i.test(s)));
});
