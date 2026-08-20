// 015-user-token-version-mysql.test.js — real-MySQL integration test for
// migration 015 (I1 JWT token_version revocation).
//
// Pattern follows migration-014.test.js: driver-level with splitSqlStatements
// (the same code path the schema-applier uses), gated on TEST_MYSQL_URL so
// the suite stays green on dev machines without a live DB.
//
// Verifies:
//   1. Apply: sys_users.token_version column exists with DEFAULT 0 NOT NULL.
//   2. INSERT without specifying the column yields token_version = 0.
//   3. ANSI UPDATE token_version = token_version + 1 bumps to 1.
//   4. Re-apply is idempotent (no-op the second time).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitSqlStatements } from '../../src/init/schema-applier.js';
import { parseTestUrl } from '../integration/_url.js';
import { createMysqlDriver } from '../../src/db/drivers/mysql.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const MIGRATION_FILE = join(REPO_ROOT, 'db/migrations/015-user-token-version.sql');

const MYSQL = !!process.env.TEST_MYSQL_URL;

test('migration 015 (mysql): sys_users.token_version column exists with DEFAULT 0 NOT NULL', { skip: !MYSQL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  const db = createMysqlDriver({ host, port, user, password, database: 'addashboard' });
  const fileSql = fs.readFileSync(MIGRATION_FILE, 'utf8');
  const TEST_USER = '__test_i1_t8';

  try {
    // 1. Apply the migration (uses splitSqlStatements so DELIMITER $$ ... $$
    //    procedure blocks are handled correctly).
    for (const stmt of splitSqlStatements(fileSql)) {
      await db.execute(stmt, []);
    }

    // 1a. Verify the column exists with DEFAULT 0 NOT NULL.
    const colsResult = await db.execute(
      `SELECT COLUMN_NAME, COLUMN_DEFAULT, IS_NULLABLE
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sys_users' AND COLUMN_NAME = 'token_version'`,
      []
    );
    assert.equal(colsResult.rows.length, 1, 'token_version column must exist after applying migration 015');
    assert.equal(colsResult.rows[0].COLUMN_DEFAULT, '0', 'token_version COLUMN_DEFAULT must be 0');
    assert.equal(colsResult.rows[0].IS_NULLABLE, 'NO', 'token_version must be NOT NULL');

    // 2. INSERT without the column — DEFAULT 0 must land.
    await db.execute(
      "INSERT INTO sys_users (username, password_hash, role_id) VALUES (?, 'x', 1)",
      [TEST_USER]
    );
    const rowsResult = await db.execute(
      "SELECT token_version FROM sys_users WHERE username = ?",
      [TEST_USER]
    );
    assert.equal(Number(rowsResult.rows[0].token_version), 0, 'DEFAULT 0 must apply on INSERT');

    // 3. ANSI UPDATE bumps to 1.
    await db.execute(
      "UPDATE sys_users SET token_version = token_version + 1 WHERE username = ?",
      [TEST_USER]
    );
    const rows2Result = await db.execute(
      "SELECT token_version FROM sys_users WHERE username = ?",
      [TEST_USER]
    );
    assert.equal(Number(rows2Result.rows[0].token_version), 1, 'ANSI UPDATE must bump to 1');

    // 4. Re-apply — must be idempotent (procedure uses information_schema guard).
    for (const stmt of splitSqlStatements(fileSql)) {
      await db.execute(stmt, []);
    }
    const rows3Result = await db.execute(
      "SELECT token_version FROM sys_users WHERE username = ?",
      [TEST_USER]
    );
    assert.equal(Number(rows3Result.rows[0].token_version), 1, 're-apply must not reset token_version');
  } finally {
    // Best-effort cleanup.
    try {
      await db.execute("DELETE FROM sys_users WHERE username = ?", [TEST_USER]);
    } catch {
      // ignore
    }
    await db.close();
  }
});

// Regression: the production code path is db.transaction() -> tx.execute(stmt, []),
// NOT the bare db.execute(stmt, []) used in the test above. The transaction path
// used to force conn.execute() (MySQL binary protocol) regardless of params,
// which rejects CREATE PROCEDURE bodies that themselves issue PREPARE/EXECUTE/
// DEALLOCATE PREPARE (server-side prepared statements). The fix routes no-param
// statements through conn.query() (COM_QUERY text protocol) so the procedure
// body goes through. This test pins that the transaction path works for 015.
//
// Without TEST_MYSQL_URL the test is skipped (same gate as the integration
// test above).
test('migration 015 (mysql): applies via transaction() path (CREATE PROCEDURE body)', { skip: !MYSQL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  const db = createMysqlDriver({ host, port, user, password, database: 'addashboard' });
  const fileSql = fs.readFileSync(MIGRATION_FILE, 'utf8');

  try {
    const stmts = splitSqlStatements(fileSql);
    // The split must produce at least the procedure body statement (BEGIN ... END).
    assert.ok(
      stmts.some(s => /CREATE\s+PROCEDURE/i.test(s) && /BEGIN\b/.test(s)),
      'splitSqlStatements must surface the CREATE PROCEDURE body as one statement'
    );
    // Run each statement through tx.execute() — the production path used by
    // services/migrations.js applyMigration(). Pre-fix this aborts with
    // "This command is not supported in the prepared statement protocol yet"
    // on the CREATE PROCEDURE statement.
    await db.transaction(async (tx) => {
      for (const stmt of stmts) {
        await tx.execute(stmt, []);
      }
    });
    // Spot-check the column exists — same shape as the main test above.
    const colsResult = await db.execute(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sys_users' AND COLUMN_NAME = 'token_version'`,
      []
    );
    assert.equal(colsResult.rows.length, 1, 'token_version column must exist after tx-path apply');
  } finally {
    await db.close();
  }
});
