import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSql } from '../../src/db/sql.js';

// --- users.createAdmin + users.count (T2: init-wizard) ---

test('mysql users.createAdmin inserts with subquery for role_id', () => {
  const sql = buildSql('mysql');
  assert.match(sql.users.createAdmin, /INSERT INTO sys_users/);
  assert.match(sql.users.createAdmin, /role_name\s*=\s*'admin'/);
  // 2 placeholders: username, password_hash (role_id comes from subquery, no placeholder)
  const placeholders = (sql.users.createAdmin.match(/\?/g) || []).length;
  assert.strictEqual(placeholders, 2);
});

test('mssql users.createAdmin uses INSERT ... SELECT ... FROM', () => {
  const sql = buildSql('mssql');
  assert.match(sql.users.createAdmin, /INSERT INTO sys_users/);
  assert.match(sql.users.createAdmin, /SELECT\s+\?,\s+\?,/);
  assert.match(sql.users.createAdmin, /role_name\s*=\s*'admin'/);
});

test('mysql users.count joins sys_roles filtering admin', () => {
  const sql = buildSql('mysql');
  assert.match(sql.users.count, /COUNT\(\*\)/);
  assert.match(sql.users.count, /JOIN\s+sys_roles/);
  assert.match(sql.users.count, /role_name\s*=\s*'admin'/);
});

test('mssql users.count matches mysql semantics', () => {
  const sql = buildSql('mssql');
  assert.match(sql.users.count, /COUNT\(\*\)/);
  assert.match(sql.users.count, /JOIN\s+sys_roles/);
});
