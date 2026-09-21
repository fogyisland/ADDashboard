// 019-package-interval-override.test.js — defensive regression tests for
// migration 019's R85 hardening.
//
// Background (R85, 2026-09-21): the original 019 was a bare
// `ALTER TABLE installed_packages ADD COLUMN interval_override_sec INT NULL ...`.
// After migration 023 (R66) split installed_packages into package_scripts
// + package_policies and dropped the V0 table, every upgrade from < R66
// to >= R66 had 019 fail with "Table 'installed_packages' doesn't exist",
// which the applier (center/src/services/migrations.js line 165-208)
// isolates in a per-migration try/catch and records as
// `status='failed'` in schema_migrations. That row stayed visible ⚠️ in
// the Schema Migrations admin page forever.
//
// The MSSQL sibling at db/migrations/mssql/019-*.sql already had an
// `IF NOT EXISTS (... sys.columns ...)` guard from R12-r12. This test
// pins the MySQL file to the same intent: a re-run against either side
// of the R66 split (table-missing, table-present-without-column,
// table-present-with-column) must complete without error and produce the
// same post-state. The test stays file-level (no live DB required) so it
// always runs in CI even when TEST_MYSQL_URL is unset.
//
// Two layers of asserts:
//   Layer A (file shape): the SQL text contains the guard pattern —
//     `information_schema.TABLES`, `information_schema.COLUMNS`, the
//     DROP+CREATE PROCEDURE wrapping, and no bare `ADD COLUMN` outside
//     the stored procedure.
//   Layer B (parse): `splitSqlStatements` (the same parser the applier
//     uses at center/src/init/schema-applier.js) returns 3 statements
//     (DROP PROCEDURE, CREATE PROCEDURE, CALL) plus the final DROP.
//     Verifies the file is syntactically valid per the project's SQL
//     splitter and that the splitter already understands the
//     DELIMITER $$ ... $$ DELIMITER ; nesting.
//
// Refactoring this test or the file without updating both is a
// regression — the file's safety contract is the assertion's contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { splitSqlStatements } from '../../src/init/schema-applier.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MYSQL_FILE = join(__dirname, '../../../db/migrations/019-package-interval-override.sql');
const MSSQL_FILE = join(__dirname, '../../../db/migrations/mssql/019-package-interval-override.sql');

test('mysql file: no bare ALTER TABLE before the stored procedure', () => {
  const sql = readFileSync(MYSQL_FILE, 'utf8');
  // The only ALTER allowed inside the file is inside the procedure body.
  // Anchor on the procedure's outer terminator `END$$` — a bare
  // `BEGIN[\s\S]*?END` regex would match the first inner `END IF` and
  // leave the real ALTER (which lives inside the procedure body) in
  // the stripped text, defeating the assertion.
  const stripped = sql.replace(/BEGIN[\s\S]*?END\$\$/g, '<<PROC>>');
  assert.doesNotMatch(
    stripped,
    /ALTER\s+TABLE\s+installed_packages/,
    'no un-wrapped ALTER TABLE on installed_packages outside the stored procedure'
  );
});

test('mysql file: contains both INFORMATION_SCHEMA guards (table + column)', () => {
  const sql = readFileSync(MYSQL_FILE, 'utf8');
  assert.match(sql, /information_schema\.TABLES/, 'must probe information_schema.TABLES for table existence');
  assert.match(sql, /information_schema\.COLUMNS/, 'must probe information_schema.COLUMNS for column existence');
});

test('mysql file: wraps the dynamic ALTER in a stored procedure with DROP IF EXISTS', () => {
  const sql = readFileSync(MYSQL_FILE, 'utf8');
  assert.match(sql, /DROP\s+PROCEDURE\s+IF\s+EXISTS/, 'guards procedure from prior CREATE');
  assert.match(sql, /CREATE\s+PROCEDURE\s+migrate_019_add_column_if_missing/, 'procedure name pinned for diagnostic clarity');
  assert.match(sql, /CALL\s+migrate_019_add_column_if_missing/, 'CALL must run the procedure');
  assert.match(sql, /DROP\s+PROCEDURE\s+migrate_019_add_column_if_missing/, 'final DROP cleans the procedure');
});

test('mysql file: dynamic ALTER uses PREPARE/EXECUTE/DEALLOCATE (column body)', () => {
  const sql = readFileSync(MYSQL_FILE, 'utf8');
  assert.match(sql, /PREPARE\s+stmt\s+FROM/, 'must PREPARE the dynamic ALTER');
  assert.match(sql, /EXECUTE\s+stmt/, 'must EXECUTE the prepared statement');
  assert.match(sql, /DEALLOCATE\s+PREPARE\s+stmt/, 'must DEALLOCATE to release handle');
});

test('mysql file: ALTER body targets installed_packages.interval_override_sec with correct type', () => {
  const sql = readFileSync(MYSQL_FILE, 'utf8');
  assert.match(
    sql,
    /'INT\s+NULL\s+AFTER\s+params_json'/,
    "ADD COLUMN definition pinned: 'INT NULL AFTER params_json'"
  );
  assert.match(
    sql,
    /CALL\s+migrate_019_add_column_if_missing\('installed_packages',\s*'interval_override_sec'/,
    "CALL must pin both table and column name to 'installed_packages' / 'interval_override_sec'"
  );
});

test('mysql file: splitSqlStatements parses to 4 stmts (DROP PROC / CREATE PROC / CALL / DROP PROC), no DELIMITER leakage', async () => {
  const sql = readFileSync(MYSQL_FILE, 'utf8');
  const stmts = splitSqlStatements(sql);
  // Procedure contains 1 BEGIN/END pair → splitter flattens to 1 statement.
  // Total: DROP IF EXISTS PROC + CREATE PROC (containing BEGIN..END) + CALL + DROP PROC = 4.
  assert.equal(stmts.length, 4, `expected 4 stmts after split, got ${stmts.length}`);
  for (const s of stmts) {
    assert.doesNotMatch(s, /DELIMITER/, 'DELIMITER directives must be stripped, not leaked into statements');
  }
  // Smoke: at least the CALL statement uses the correct arguments.
  const callStmt = stmts.find(s => s.trim().startsWith('CALL'));
  assert.ok(callStmt, 'CALL statement present after split');
  assert.match(callStmt, /'installed_packages'/);
  assert.match(callStmt, /'interval_override_sec'/);
});

test('mssql file: sibling guarded with sys.columns IF NOT EXISTS (regression guard)', () => {
  const sql = readFileSync(MSSQL_FILE, 'utf8');
  assert.match(sql, /sys\.columns/, 'mssql sibling must probe sys.columns');
  assert.match(
    sql,
    /IF\s+NOT\s+EXISTS\s*\([\s\S]*?name\s*=\s*'interval_override_sec'[\s\S]*?\)/,
    'mssql sibling must wrap the ALTER in an IF NOT EXISTS (...) guard'
  );
  assert.match(sql, /ALTER\s+TABLE\s+installed_packages/, 'mssql sibling still adds the column when guards pass');
});

test('mysql + mssql siblings agree on target table and column name', () => {
  const mysql = readFileSync(MYSQL_FILE, 'utf8');
  const mssql = readFileSync(MSSQL_FILE, 'utf8');
  assert.match(mysql, /'installed_packages'/, 'mysql file pins installed_packages');
  assert.match(mssql, /installed_packages/, 'mssql file pins installed_packages');
  assert.match(mysql, /'interval_override_sec'/, 'mysql file pins interval_override_sec');
  assert.match(mssql, /interval_override_sec/, 'mssql file pins interval_override_sec');
});
