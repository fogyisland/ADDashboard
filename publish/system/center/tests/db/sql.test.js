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

// --- ports + portStatus (T2: custom-port healthcheck) ---

test('mysql: ports.list orders by sort_order, port', () => {
  const sql = buildSql('mysql').ports.list;
  assert.match(sql, /FROM system_ports/i);
  assert.match(sql, /ORDER BY sort_order, port/);
});

test('mysql: ports.create uses 3 positional placeholders (port, label, sort_order)', () => {
  const sql = buildSql('mysql').ports.create;
  assert.strictEqual((sql.match(/\?/g) || []).length, 3);
});

test('mysql: ports.updatePartial builds SET clauses with ?', () => {
  const sql = buildSql('mysql').ports.updatePartial(['port = ?', 'label = ?']);
  assert.match(sql, /SET port = \?, label = \? WHERE id = \?/);
});

test('mssql: ports.updatePartial joins caller ? clauses + adds WHERE id = ?', () => {
  // T2 fix: caller passes `?`-semantic field clauses; updatePartial joins them
  // and appends `WHERE id = ?`. The driver's rewritePlaceholders then maps
  // every ? to @pN uniformly.
  const sql = buildSql('mssql').ports.updatePartial(['port = ?', 'label = ?']);
  assert.match(sql, /SET port = \?, label = \? WHERE id = \?/);
});

test('mysql: portStatus.upsertOne uses ON DUPLICATE KEY UPDATE on (agent_id, port)', () => {
  const sql = buildSql('mysql').portStatus.upsertOne;
  assert.match(sql, /INSERT INTO ad_agent_port_status/);
  assert.match(sql, /ON DUPLICATE KEY UPDATE/);
  // 5 placeholders: agent_id, port, ok, latency_ms, last_checked_at
  assert.strictEqual((sql.match(/\?/g) || []).length, 5);
});

test('mssql: portStatus.upsertOne uses MERGE with USING (VALUES)', () => {
  const sql = buildSql('mssql').portStatus.upsertOne;
  assert.match(sql, /MERGE INTO ad_agent_port_status/i);
  assert.match(sql, /USING \(SELECT \? AS agent_id, \? AS port/i);
});

// --- probe (verify-marker existence checks) ---

test('mysql: probe.table scopes to the current database, 1 placeholder', () => {
  const sql = buildSql('mysql').probe.table;
  assert.match(sql, /information_schema\.TABLES/i);
  assert.match(sql, /TABLE_SCHEMA = DATABASE\(\)/);
  assert.match(sql, /LIMIT 1/);
  assert.strictEqual((sql.match(/\?/g) || []).length, 1);
});

test('mysql: probe.column takes [table, column], 2 placeholders', () => {
  const sql = buildSql('mysql').probe.column;
  assert.match(sql, /information_schema\.COLUMNS/i);
  assert.match(sql, /TABLE_NAME = \?/);
  assert.match(sql, /COLUMN_NAME = \?/);
  assert.strictEqual((sql.match(/\?/g) || []).length, 2);
});

test('mssql: probe uses TOP 1 instead of LIMIT', () => {
  const probe = buildSql('mssql').probe;
  assert.match(probe.table, /SELECT TOP 1/i);
  assert.match(probe.column, /SELECT TOP 1/i);
  assert.doesNotMatch(probe.table, /LIMIT/i);
  assert.doesNotMatch(probe.column, /LIMIT/i);
  assert.strictEqual((probe.table.match(/\?/g) || []).length, 1);
  assert.strictEqual((probe.column.match(/\?/g) || []).length, 2);
});

// --- T1: sites.upsert MERGE trailing probe + dashboard datepart divergence ---

test('mssql sites.upsert MERGE does not have trailing SELECT @@ROWCOUNT', () => {
  const sql = buildSql('mssql').sites.upsert;
  // No second recordset — driver isInsert heuristic must not see a probe.
  assert.doesNotMatch(sql, /@@ROWCOUNT/);
  assert.doesNotMatch(sql, /;\s*SELECT\s+@@/i);
});

test('mssql dashboard.errors uses DATEDIFF_BIG SECOND / 60.0 (sub-minute precision)', () => {
  const sql = buildSql('mssql').dashboard.errors;
  // Must NOT use DATEDIFF(MINUTE, ...) — returns boundary crossings, not absolute minutes
  assert.doesNotMatch(sql, /DATEDIFF\s*\(\s*MINUTE/i);
  // Must use seconds-precision math
  assert.match(sql, /DATEDIFF_BIG\s*\(\s*SECOND/i);
  assert.match(sql, /\/ 60/i);
});

test('mssql dashboard.agents uses DATEDIFF_BIG SECOND (sub-second precision)', () => {
  const sql = buildSql('mssql').dashboard.agents;
  assert.doesNotMatch(sql, /DATEDIFF\s*\(\s*SECOND[^)]*SYSUTCDATETIME/i);
  assert.match(sql, /DATEDIFF_BIG\s*\(\s*SECOND/i);
});

test('mssql dashboard.dcReplicationLinks uses DATEDIFF_BIG SECOND / 60.0', () => {
  const sql = buildSql('mssql').dashboard.dcReplicationLinks('?, ?');
  assert.doesNotMatch(sql, /DATEDIFF\s*\(\s*MINUTE/i);
  assert.match(sql, /DATEDIFF_BIG\s*\(\s*SECOND/i);
  assert.match(sql, /\/ 60/i);
});

// --- T2: sites.updatePartial + ports.* hand-rolled @pN → ? ---

test('mssql sites.updatePartial uses ? placeholders (not hand-rolled @pN)', () => {
  const sql = buildSql('mssql').sites.updatePartial(['site_name = ?', 'region_code = ?']);
  assert.doesNotMatch(sql, /@p\d/i);
  // It IS an UPDATE, so isInsert heuristic doesn't fire — no SCOPE_IDENTITY probe
  assert.match(sql, /UPDATE\s+ad_sites/i);
});

test('mssql ports.* queries use ? placeholders', () => {
  const ports = buildSql('mssql').ports;
  for (const [name, val] of Object.entries(ports)) {
    // updatePartial is a function — invoke it with a sample fields array to get a string
    const sql = typeof val === 'function' ? val(['port = ?', 'label = ?']) : val;
    assert.doesNotMatch(sql, /@p\d/i, `ports.${name} contains hand-rolled @pN`);
  }
});

// --- T3: inline SCOPE_IDENTITY() collisions in 4 INSERT helpers ---

test('mssql alertRules.create does not append inline SCOPE_IDENTITY (driver auto-appends)', () => {
  const sql = buildSql('mssql').alertRules.create;
  assert.doesNotMatch(sql, /SCOPE_IDENTITY/i);
  assert.match(sql, /^\s*INSERT\b/i);
});

test('mssql alertEvents.insert does not append inline SCOPE_IDENTITY', () => {
  const sql = buildSql('mssql').alertEvents.insert;
  assert.doesNotMatch(sql, /SCOPE_IDENTITY/i);
  assert.match(sql, /^\s*INSERT\b/i);
});

test('mssql alertOutbox.enqueue does not append inline SCOPE_IDENTITY', () => {
  const sql = buildSql('mssql').alertOutbox.enqueue;
  assert.doesNotMatch(sql, /SCOPE_IDENTITY/i);
  assert.match(sql, /^\s*INSERT\b/i);
});

test('mssql serverGroups.create does not append inline SCOPE_IDENTITY', () => {
  const sql = buildSql('mssql').serverGroups.create;
  assert.doesNotMatch(sql, /SCOPE_IDENTITY/i);
  assert.match(sql, /^\s*INSERT\b/i);
});
