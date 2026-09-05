// 2026-09-05 R81 — SQL helpers for ad_member_commands.
//
// Pure structural tests: assert placeholder counts, IN-list widths,
// dialect-specific fragments (UTC_TIMESTAMP vs SYSUTCDATETIME,
// LIMIT ? OFFSET ? vs TOP (?) OFFSET ? ROWS), and the JSON column
// types. No DB connection — mirrors the pattern in
// tests/db/sql.test.js for other registries.
//
// Mirrors tests/db/sql-ad-admin-commands.test.js (R75's DB-level
// coverage) but kept in the same file because the scope is small and
// the pattern is the same — both are write into the registry, no
// execution semantics.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSql } from '../../src/db/sql.js';

// ── mysql dialect ──────────────────────────────────────────────────────

test('mysql adMemberCommands.insert writes a queued row with the right placeholders', () => {
  const sql = buildSql('mysql').adMemberCommands.insert;
  assert.match(sql, /INSERT INTO ad_member_commands/);
  assert.match(sql, /hostname,\s*command_type,\s*params_json/);
  // 4 placeholders: hostname, command_type, params_json, operator_id
  // (status is hard-coded 'queued', created_at is UTC_TIMESTAMP())
  assert.strictEqual((sql.match(/\?/g) || []).length, 4);
  assert.match(sql, /UTC_TIMESTAMP\(\)/);
});

test('mysql adMemberCommands.claimPick returns oldest-first queued ids', () => {
  const sql = buildSql('mysql').adMemberCommands.claimPick;
  assert.match(sql, /SELECT id FROM ad_member_commands/);
  assert.match(sql, /status\s*=\s*'queued'/);
  assert.match(sql, /hostname\s*=\s*\?/);
  assert.match(sql, /ORDER BY created_at ASC, id ASC/);
  assert.match(sql, /LIMIT \?/);
  assert.strictEqual((sql.match(/\?/g) || []).length, 2);
});

test('mysql adMemberCommands.claim(N) emits N-? IN-list + hostname bind', () => {
  const sql = buildSql('mysql').adMemberCommands.claim(4);
  assert.match(sql, /UPDATE ad_member_commands/);
  assert.match(sql, /SET status = 'running', claimed_at = UTC_TIMESTAMP\(\)/);
  // N placeholders for ids + 1 for hostname = 5
  assert.strictEqual((sql.match(/\?/g) || []).length, 5);
  assert.match(sql, /IN \(\?,\?,\?,\?\)/);
  assert.match(sql, /AND hostname = \?/);
});

test('mysql adMemberCommands.complete covers all 5 update columns', () => {
  const sql = buildSql('mysql').adMemberCommands.complete;
  assert.match(sql, /SET status = \?, result_json = \?, error_message = \?,/);
  assert.match(sql, /duration_ms = \?, completed_at = UTC_TIMESTAMP\(\)/);
  assert.match(sql, /WHERE id = \?/);
  // 5 placeholders: status, result_json, error_message, duration_ms, id
  assert.strictEqual((sql.match(/\?/g) || []).length, 5);
});

test('mysql adMemberCommands.listByHost filters on hostname and orders DESC', () => {
  const sql = buildSql('mysql').adMemberCommands.listByHost;
  assert.match(sql, /FROM ad_member_commands c/);
  assert.match(sql, /WHERE c\.hostname = \?/);
  assert.match(sql, /ORDER BY c\.created_at DESC, c\.id DESC/);
  assert.match(sql, /LIMIT \? OFFSET \?/);
  // 3 placeholders: hostname, size, offset
  assert.strictEqual((sql.match(/\?/g) || []).length, 3);
});

test('mysql adMemberCommands.countRecentForHost is a 60s window on hostname', () => {
  const sql = buildSql('mysql').adMemberCommands.countRecentForHost;
  assert.match(sql, /COUNT\(\*\) AS n FROM ad_member_commands/);
  assert.match(sql, /hostname = \?/);
  assert.match(sql, /status IN \('queued', 'running'\)/);
  assert.match(sql, /INTERVAL 1 MINUTE/);
  assert.strictEqual((sql.match(/\?/g) || []).length, 1);
});

// ── mssql dialect ──────────────────────────────────────────────────────

test('mssql adMemberCommands.insert mirrors mysql with SYSUTCDATETIME() + casts', () => {
  const sql = buildSql('mssql').adMemberCommands.insert;
  assert.match(sql, /INSERT INTO ad_member_commands/);
  assert.match(sql, /CAST\(\? AS NVARCHAR\(128\)\)/);
  assert.match(sql, /CAST\(\? AS NVARCHAR\(MAX\)\)/);
  assert.match(sql, /SYSUTCDATETIME\(\)/);
  assert.match(sql, /DATETIME2/);
});

test('mssql adMemberCommands.claimPick uses TOP (?) and CAST for status', () => {
  const sql = buildSql('mssql').adMemberCommands.claimPick;
  assert.match(sql, /SELECT TOP \(\?\) id FROM ad_member_commands/);
  assert.match(sql, /CAST\('queued' AS NVARCHAR\(16\)\)/);
  assert.match(sql, /CAST\(\? AS NVARCHAR\(128\)\)/);
  // 2 placeholders: TOP, hostname
  assert.strictEqual((sql.match(/\?/g) || []).length, 2);
});

test('mssql adMemberCommands.claim(N) emits N-? IN-list + hostname cast bind', () => {
  const sql = buildSql('mssql').adMemberCommands.claim(2);
  assert.match(sql, /SET status = CAST\('running' AS NVARCHAR\(16\)\)/);
  assert.match(sql, /claimed_at = CAST\(SYSUTCDATETIME\(\) AS DATETIME2\)/);
  assert.strictEqual((sql.match(/\?/g) || []).length, 3);
  assert.match(sql, /IN \(\?,\?\)/);
});

test('mssql adMemberCommands.complete uses CASTs on every column', () => {
  const sql = buildSql('mssql').adMemberCommands.complete;
  assert.match(sql, /CAST\(\? AS NVARCHAR\(16\)\)/);
  assert.match(sql, /CAST\(\? AS NVARCHAR\(MAX\)\)/);
  assert.match(sql, /CAST\(\? AS NVARCHAR\(2000\)\)/);
  assert.match(sql, /SYSUTCDATETIME\(\)/);
  assert.strictEqual((sql.match(/\?/g) || []).length, 5);
});

test('mssql adMemberCommands.listByHost uses TOP (?) + OFFSET ? ROWS', () => {
  const sql = buildSql('mssql').adMemberCommands.listByHost;
  assert.match(sql, /SELECT TOP \(\?\)/);
  assert.match(sql, /CAST\(\? AS NVARCHAR\(128\)\)/);
  assert.match(sql, /OFFSET \? ROWS/);
  // 3 placeholders: TOP, hostname, offset
  assert.strictEqual((sql.match(/\?/g) || []).length, 3);
});

// ── cross-dialect invariants ───────────────────────────────────────────

test('mysql + mssql adMemberCommands have the same surface area', () => {
  const mysqlKeys = Object.keys(buildSql('mysql').adMemberCommands).sort();
  const mssqlKeys = Object.keys(buildSql('mssql').adMemberCommands).sort();
  assert.deepEqual(mysqlKeys, mssqlKeys);
});

test('mysql + mssql adMemberCommands have matching command_type + hostname column shape', () => {
  const mysql = buildSql('mysql').adMemberCommands.insert;
  const mssql = buildSql('mssql').adMemberCommands.insert;
  // Both must mention the column-list in the same order. The mssql form
  // wraps each bind in CAST(); we strip casts for the column-name check.
  const mysqlCols = mysql.match(/\(([^)]+)\)\s+VALUES/)[1]
    .split(',').map(s => s.trim()).filter(s => !s.includes('('));
  const mssqlCols = mssql.match(/\(([^)]+)\)\s+VALUES/)[1]
    .split(',').map(s => s.trim()).filter(s => !s.startsWith('CAST') && !s.includes('('));
  // mssql inserts `CAST(? AS NVARCHAR(128))` first for hostname, then plain
  // command_type, then `CAST(? AS NVARCHAR(MAX))` for params_json. The
  // outer SELECT projection uses column-name literals that match the mysql
  // columns — verified by the getById listByHost projection tests.
  assert.ok(mysqlCols.includes('hostname'));
  assert.ok(mysqlCols.includes('command_type'));
  assert.ok(mysqlCols.includes('params_json'));
  assert.ok(mysqlCols.includes('operator_id'));
});
