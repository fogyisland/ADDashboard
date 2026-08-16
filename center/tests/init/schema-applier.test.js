import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitSqlStatements } from '../../src/init/schema-applier.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Repo root, resolved from this file rather than process.cwd() so the test
// works regardless of which directory `node --test` was launched from.
const repoRoot = join(__dirname, '../../..');

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

test('splitSqlStatements handles migration 002 (JSON permissions → role_permissions)', () => {
  // 002-permissions-table.sql replaces the legacy sys_roles.permissions
  // JSON column with the relational role_permissions table. The migration
  // uses a stored procedure with $$ delimiters, so the parser must keep the
  // proc body as one statement.
  const sql = readFileSync(join(__dirname, '../../../db/migrations/002-permissions-table.sql'), 'utf8');
  const stmts = splitSqlStatements(sql);
  assert.ok(stmts.length >= 3, `expected >= 3 statements, got ${stmts.length}: ${JSON.stringify(stmts)}`);
  // Defensive CREATE TABLE role_permissions IF NOT EXISTS (split on ;)
  assert.ok(stmts.some(s => /CREATE TABLE IF NOT EXISTS role_permissions/.test(s)));
  // CREATE PROCEDURE body kept whole (uses $$ delimiter)
  const procStmt = stmts.find(s => /CREATE PROCEDURE migrate_002_permissions_table/.test(s));
  assert.ok(procStmt, 'expected a single CREATE PROCEDURE statement');
  // Body must contain the JSON-unwrapping logic. The implementation changed
  // from WITH RECURSIVE (MySQL 8.0+ only) to a WHILE loop (MySQL 5.7+ OK),
  // so we assert on the discriminator that survives both implementations.
  assert.match(procStmt, /JSON_UNQUOTE\(JSON_EXTRACT/);
  // CALL + DROP PROCEDURE on default ; delimiter
  assert.ok(stmts.some(s => /CALL migrate_002_permissions_table/.test(s)));
  assert.ok(stmts.some(s => /^DROP PROCEDURE migrate_002_permissions_table/.test(s)));
});

test('splitSqlStatements handles MSSQL migration 002 (CTE-based JSON unwrap)', () => {
  // MSSQL version uses native CTE without the `RECURSIVE` keyword (MSSQL
  // auto-detects recursion). The parser must keep each IF...BEGIN...END block
  // as a single statement (the IF/BEGIN/END tracker already handles this,
  // but this test pins the MSSQL shape so a refactor doesn't silently break
  // it).
  const sql = readFileSync(join(__dirname, '../../../db/migrations/mssql/002-permissions-table.sql'), 'utf8');
  const stmts = splitSqlStatements(sql);
  assert.ok(stmts.length >= 3, `expected >= 3 statements, got ${stmts.length}: ${JSON.stringify(stmts)}`);
  // Defensive CREATE TABLE role_permissions wrapped in IF OBJECT_ID guard
  assert.ok(stmts.some(s => /IF OBJECT_ID\('role_permissions'/.test(s)));
  // CTE body (no WITH RECURSIVE on MSSQL — MSSQL auto-detects recursion)
  const cteStmt = stmts.find(s => /WITH nums\(n\) AS \(/.test(s));
  assert.ok(cteStmt, 'expected a single CTE-driven INSERT statement');
  assert.doesNotMatch(cteStmt, /RECURSIVE/, 'MSSQL does not use the RECURSIVE keyword');
  assert.match(cteStmt, /JSON_VALUE\(r\.permissions/);
  // Bug fixed 2026-08-16: previous version used `JSON_LENGTH(r.permissions) > n.n`
  // — that's a MySQL-only function; MSSQL returns
  // "is not a recognized built-in function name" when the upgrade-path IF
  // block actually executes (i.e. legacy sys_roles.permissions column exists
  // and role_permissions is empty). Guard against the regression so future
  // edits don't reintroduce MySQL-only functions in the MSSQL dialect file.
  assert.doesNotMatch(cteStmt, /JSON_LENGTH/, 'MSSQL does not have JSON_LENGTH — use JSON_VALUE(...) IS NOT NULL for "index in range" check.');
  // Legacy column drop, guarded by COL_LENGTH check
  assert.ok(stmts.some(s => /ALTER TABLE sys_roles DROP COLUMN permissions/.test(s)));
});

test('splitSqlStatements parses migration 003 (port healthcheck tables)', () => {
  const sql = readFileSync(join(__dirname, '../../../db/migrations/003-port-healthcheck.sql'), 'utf8');
  const stmts = splitSqlStatements(sql);
  // 2 CREATE TABLE statements, no DELIMITER needed. Defends against
  // yesterday's comment-bug class -- the parser now correctly skips
  // `--` line comments (with apostrophes in them).
  assert.strictEqual(stmts.length, 2, `expected 2 statements, got ${stmts.length}: ${JSON.stringify(stmts)}`);
  assert.ok(stmts.some(s => /CREATE TABLE IF NOT EXISTS system_ports/.test(s)));
  assert.ok(stmts.some(s => /CREATE TABLE IF NOT EXISTS ad_agent_port_status/.test(s)));
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

test('splitSqlStatements parses migration 005 mssql (3 guarded statements: CREATE TABLE + 2 CREATE INDEX)', () => {
  // MSSQL: CREATE TABLE wrapped in IF NOT EXISTS (sysobjects) + 2 CREATE INDEX
  // each guarded by IF NOT EXISTS (sys.indexes). Each guard is its own logical
  // statement. The CREATE INDEX guards are load-bearing for idempotency:
  // without them, re-applying on a partial-state DB (CREATE TABLE succeeded
  // but a previous attempt failed before the indexes ran) throws
  // "index or statistics with name 'idx_changed_at' already exists" — the
  // underlying cause of the wizard's "Could not create constraint or index" 500.
  const sql = readFileSync(join(__dirname, '../../../db/migrations/mssql/005-sys-config-audit.sql'), 'utf8');
  const stmts = splitSqlStatements(sql);
  assert.strictEqual(stmts.length, 3, `expected 3 statements, got ${stmts.length}: ${JSON.stringify(stmts)}`);
  // CREATE TABLE: guarded by sysobjects lookup
  assert.match(stmts[0], /IF NOT EXISTS \(SELECT \* FROM sysobjects/i);
  assert.match(stmts[0], /CREATE TABLE sys_config_audit/i);
  assert.match(stmts[0], /change_type/i);
  // Each CREATE INDEX: guarded by sys.indexes lookup
  assert.match(stmts[1], /IF NOT EXISTS \(SELECT \* FROM sys\.indexes WHERE name = 'idx_changed_at'/i);
  assert.match(stmts[1], /CREATE INDEX idx_changed_at ON sys_config_audit/i);
  assert.match(stmts[2], /IF NOT EXISTS \(SELECT \* FROM sys\.indexes WHERE name = 'idx_config_key'/i);
  assert.match(stmts[2], /CREATE INDEX idx_config_key ON sys_config_audit/i);
});

test('splitSqlStatements parses migration 006 (drop center_public_host/port)', () => {
  // 006 is a single DELETE statement guarded by IN (...) — covers the
  // stock single-semicolon-terminated case for both dialects, and ensures
  // the migration file still parses if the user adds more cleanup rows later.
  const mysqlSql = readFileSync(join(__dirname, '../../../db/migrations/006-drop-public-host-port.sql'), 'utf8');
  const mysqlStmts = splitSqlStatements(mysqlSql);
  assert.strictEqual(mysqlStmts.length, 1);
  assert.match(mysqlStmts[0], /DELETE FROM system_config/i);
  assert.match(mysqlStmts[0], /center_public_host/);
  assert.match(mysqlStmts[0], /center_public_port/);

  const mssqlSql = readFileSync(join(__dirname, '../../../db/migrations/mssql/006-drop-public-host-port.sql'), 'utf8');
  const mssqlStmts = splitSqlStatements(mssqlSql);
  assert.strictEqual(mssqlStmts.length, 1);
  assert.match(mssqlStmts[0], /DELETE FROM system_config/i);
});

test('splitSqlStatements parses migration 007 mysql (4 ADD COLUMN in 1 statement)', () => {
  const sql = readFileSync(join(__dirname, '../../../db/migrations/007-dc-card-counters.sql'), 'utf8');
  const stmts = splitSqlStatements(sql);
  // MySQL: 1 multi-column ALTER
  assert.strictEqual(stmts.length, 1, `expected 1 statement, got ${stmts.length}: ${JSON.stringify(stmts)}`);
  assert.match(stmts[0], /ALTER TABLE ad_replication_status/i);
  assert.match(stmts[0], /users_count/);
  assert.match(stmts[0], /groups_count/);
  assert.match(stmts[0], /gpos_count/);
  assert.match(stmts[0], /locked_count/);
});

test('splitSqlStatements parses migration 007 mssql (4 guarded ADD COLUMN statements)', () => {
  const sql = readFileSync(join(__dirname, '../../../db/migrations/mssql/007-dc-card-counters.sql'), 'utf8');
  const stmts = splitSqlStatements(sql);
  // MSSQL: 4 IF-guarded ALTER blocks
  assert.strictEqual(stmts.length, 4, `expected 4 statements, got ${stmts.length}: ${JSON.stringify(stmts)}`);
  assert.ok(stmts.every(s => /ALTER TABLE ad_replication_status/i.test(s)));
  assert.ok(stmts.every(s => /INFORMATION_SCHEMA\.COLUMNS/.test(s)));
});

test('splitSqlStatements parses migration 008 mysql (1 CREATE TABLE)', () => {
  const sql = readFileSync(join(__dirname, '../../../db/migrations/008-lockout-events.sql'), 'utf8');
  const stmts = splitSqlStatements(sql);
  // MySQL: 1 CREATE TABLE statement
  assert.strictEqual(stmts.length, 1, `expected 1 statement, got ${stmts.length}: ${JSON.stringify(stmts)}`);
  assert.match(stmts[0], /CREATE TABLE IF NOT EXISTS ad_lockout_events/i);
  assert.match(stmts[0], /uq_lockout_dc_record/i);
  assert.match(stmts[0], /event_record_id\s+BIGINT/i);
  assert.match(stmts[0], /target_user_name/);
});

test('splitSqlStatements parses migration 008 mssql (1 guarded CREATE TABLE block)', () => {
  const sql = readFileSync(join(__dirname, '../../../db/migrations/mssql/008-lockout-events.sql'), 'utf8');
  const stmts = splitSqlStatements(sql);
  // MSSQL: IF OBJECT_ID guard wraps CREATE TABLE + CREATE INDEX statements
  // into 1 logical block. The parser keeps IF/BEGIN/END as a single statement.
  assert.strictEqual(stmts.length, 1, `expected 1 statement, got ${stmts.length}: ${JSON.stringify(stmts)}`);
  assert.match(stmts[0], /IF OBJECT_ID\('ad_lockout_events', 'U'\)/i);
  assert.match(stmts[0], /CREATE TABLE ad_lockout_events/i);
  assert.match(stmts[0], /event_record_id\s+BIGINT/i);
  // Verify the unique constraint and at least one index are inside the block
  assert.match(stmts[0], /uq_lockout_dc_record/i);
  assert.match(stmts[0], /CREATE INDEX ix_lockout_occurred/i);
});

test('splitSqlStatements parses migration 009 mysql (schema_migrations: 1 CREATE TABLE IF NOT EXISTS)', () => {
  const sql = readFileSync(join(__dirname, '../../../db/migrations/009-schema-migrations.sql'), 'utf8');
  const stmts = splitSqlStatements(sql);
  // MySQL: single CREATE TABLE IF NOT EXISTS statement
  assert.strictEqual(stmts.length, 1, `expected 1 statement, got ${stmts.length}: ${JSON.stringify(stmts)}`);
  assert.match(stmts[0], /CREATE TABLE IF NOT EXISTS schema_migrations/i);
  assert.match(stmts[0], /checksum\s+CHAR\(64\)/i);
  assert.match(stmts[0], /status\s+VARCHAR\(16\)\s+NOT NULL\s+DEFAULT 'applied'/i);
  // Secondary index on status
  assert.match(stmts[0], /KEY ix_schema_migrations_status\s+\(status\)/i);
});

test('splitSqlStatements parses migration 009 mssql (schema_migrations: 1 IF/BEGIN/END block)', () => {
  const sql = readFileSync(join(__dirname, '../../../db/migrations/mssql/009-schema-migrations.sql'), 'utf8');
  const stmts = splitSqlStatements(sql);
  // MSSQL: IF OBJECT_ID guard wraps CREATE TABLE + CREATE INDEX into 1 logical
  // block. BEGIN/END depth tracker treats the IF...BEGIN...END block as one
  // statement, which is what the schema-applier expects when applying it.
  assert.strictEqual(stmts.length, 1, `expected 1 statement, got ${stmts.length}: ${JSON.stringify(stmts)}`);
  assert.match(stmts[0], /IF OBJECT_ID\('schema_migrations', 'U'\)\s+IS NULL/i);
  assert.match(stmts[0], /CREATE TABLE schema_migrations/i);
  // Verify key schema columns are inside the block (single-statement smoke test)
  assert.match(stmts[0], /checksum\s+CHAR\(64\)/i);
  // Secondary index lives inside the BEGIN/END block too
  assert.match(stmts[0], /CREATE INDEX ix_schema_migrations_status/i);
});

test('backfillMigrations inserts all migration files as status=applied with applied_by=system-init', async () => {
  const { backfillMigrations } = await import('../../src/init/schema-applier.js');
  const upsertCalls = [];
  const db = {
    dialect: 'mysql',
    sql: {
      schemaMigrations: { upsert: 'UPSERT' },
      probe: { table: 'PROBE_TABLE', column: 'PROBE_COLUMN' }
    },
    execute: async (sql, params) => {
      if (sql === 'UPSERT') upsertCalls.push(params);
      return { rows: [], affectedRows: 1 };
    },
    query: async () => ({ rows: [{ ok: 1 }] })
  };
  // repoRoot is the real project root, so backfill reads db/migrations/*.sql
  const result = await backfillMigrations('mysql', db, { repoRoot });
  // 001-009 must all be recorded (009 now handles itself via its own verify
  // marker — the test mock returns rows for every probe, so all migrations
  // are backfilled).
  assert.ok(upsertCalls.length >= 8, `expected >= 8 upsert calls, got ${upsertCalls.length}`);
  assert.equal(result.count, upsertCalls.length);
  assert.deepStrictEqual(result.skipped, []);
  for (const p of upsertCalls) {
    // Param order mirrors the upsert column list in src/db/sql.js:
    // (version, description, type, script, checksum, applied_at,
    //  execution_ms, applied_by, status, error_message)
    assert.equal(p[2], 'sql');           // type
    assert.match(p[3], /^\d{3}-.*\.sql$/); // script = filename
    assert.match(p[4], /^[0-9a-f]{64}$/);  // checksum = sha256 hex
    assert.equal(p[6], 0);               // execution_ms
    assert.equal(p[7], 'system-init');   // applied_by
    assert.equal(p[8], 'applied');       // status
    assert.equal(p[9], null);            // error_message
  }
});

test('backfillMigrations is idempotent and returns 0 when the migrations dir is absent', async () => {
  const { backfillMigrations } = await import('../../src/init/schema-applier.js');
  const db = {
    dialect: 'mysql',
    sql: {
      schemaMigrations: { upsert: 'UPSERT' },
      probe: { table: 'PROBE_TABLE', column: 'PROBE_COLUMN' }
    },
    execute: async () => ({ rows: [], affectedRows: 1 }),
    query: async () => ({ rows: [] })
  };
  const result = await backfillMigrations('mysql', db, { repoRoot: join(__dirname, 'no-such-repo') });
  assert.equal(result.count, 0);
  assert.deepStrictEqual(result.skipped, []);
});
