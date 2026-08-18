// 015-user-token-version-mssql.test.js — real-MSSQL integration test for
// migration 015 (I1 JWT token_version revocation).
//
// Pattern follows the MySQL sibling: driver-level with splitSqlStatements
// (the same code path the schema-applier uses), gated on TEST_MSSQL_URL
// so the suite stays green on dev machines without a live DB.
//
// Verifies:
//   1. Apply: sys_users.token_version column exists with DEFAULT 0 NOT NULL.
//   2. INSERT without specifying the column yields token_version = 0.
//   3. ANSI UPDATE token_version = token_version + 1 bumps to 1.
//   4. Re-apply is idempotent (no-op the second time; IF NOT EXISTS guard).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitSqlStatements } from '../../src/init/schema-applier.js';
import { parseTestUrl } from '../integration/_url.js';
import { createMssqlDriver } from '../../src/db/drivers/mssql.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const MIGRATION_FILE = join(REPO_ROOT, 'db/migrations/mssql/015-user-token-version.sql');

const MSSQL = !!process.env.TEST_MSSQL_URL;

test('migration 015 (mssql): sys_users.token_version column exists with DEFAULT 0 NOT NULL', { skip: !MSSQL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MSSQL_URL', { defaultPort: 1433 });
  const db = createMssqlDriver({ server: host, port, database: 'addashboard', user, password });
  const fileSql = fs.readFileSync(MIGRATION_FILE, 'utf8');
  const TEST_USER = '__test_i1_t9';

  try {
    // 1. Apply the migration (uses splitSqlStatements so BEGIN...END blocks
    //    stay grouped as a single statement).
    for (const stmt of splitSqlStatements(fileSql)) {
      await db.execute(stmt, []);
    }

    // 1a. Verify the column exists with DEFAULT 0 NOT NULL.
    //     MSSQL catalogs: COLUMN_DEFAULT for INT DEFAULT 0 is ((0));
    //     IS_NULLABLE = 'NO'.
    const colsResult = await db.query(
      `SELECT COLUMN_NAME, COLUMN_DEFAULT, IS_NULLABLE
         FROM information_schema.COLUMNS
        WHERE TABLE_NAME = 'sys_users' AND COLUMN_NAME = 'token_version'`,
      []
    );
    const cols = colsResult.rows;
    assert.equal(cols.length, 1, 'token_version column must exist after applying migration 015');
    // MSSQL wraps default expressions in parens; either '0' or '((0))' is acceptable.
    assert.ok(
      cols[0].COLUMN_DEFAULT === '0' || cols[0].COLUMN_DEFAULT === '((0))',
      `token_version COLUMN_DEFAULT must be 0; got ${JSON.stringify(cols[0].COLUMN_DEFAULT)}`
    );
    assert.equal(cols[0].IS_NULLABLE, 'NO', 'token_version must be NOT NULL');

    // 2. INSERT without the column — DEFAULT 0 must land.
    await db.execute(
      "INSERT INTO sys_users (username, password_hash, role_id) VALUES (@p1, 'x', 1)",
      [TEST_USER]
    );
    const rowsResult = await db.query(
      "SELECT token_version FROM sys_users WHERE username = @p1",
      [TEST_USER]
    );
    assert.equal(Number(rowsResult.rows[0].token_version), 0, 'DEFAULT 0 must apply on INSERT');

    // 3. ANSI UPDATE bumps to 1.
    await db.execute(
      "UPDATE sys_users SET token_version = token_version + 1 WHERE username = @p1",
      [TEST_USER]
    );
    const rowsResult2 = await db.query(
      "SELECT token_version FROM sys_users WHERE username = @p1",
      [TEST_USER]
    );
    assert.equal(Number(rowsResult2.rows[0].token_version), 1, 'ANSI UPDATE must bump to 1');

    // 4. Re-apply — must be idempotent (IF NOT EXISTS guard wraps ALTER).
    for (const stmt of splitSqlStatements(fileSql)) {
      await db.execute(stmt, []);
    }
    const rowsResult3 = await db.query(
      "SELECT token_version FROM sys_users WHERE username = @p1",
      [TEST_USER]
    );
    assert.equal(Number(rowsResult3.rows[0].token_version), 1, 're-apply must not reset token_version');
  } finally {
    // Best-effort cleanup.
    try {
      await db.execute("DELETE FROM sys_users WHERE username = @p1", [TEST_USER]);
    } catch {
      // ignore
    }
    await db.close();
  }
});
