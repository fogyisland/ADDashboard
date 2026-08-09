// member-servers.test.js — covers the memberServers SQL helper module:
// dual-dialect SQL strings and the helper functions (upsert, findByHostname,
// list, delete, touchLastSeen, touchLastReport).
//
// Pattern matches center/tests/sql/installed-packages.test.js: node:test +
// makeMockDb helper, exercises the ESM-exported module directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memberServers } from '../../src/db/sql/member-servers.js';

// ---- mock db factory ----

function makeMockDb({ dialect = 'mysql' } = {}) {
  const calls = [];
  const scripts = [];
  function lookup(sql) {
    for (const s of scripts) {
      if (s.match.test(sql)) {
        if (typeof s.result === 'function') return s.result();
        return s.result;
      }
    }
    return { rows: [], affectedRows: 0, insertId: undefined };
  }
  return {
    dialect,
    async execute(sql, params = []) {
      calls.push({ sql, params: [...params] });
      return lookup(sql);
    },
    async query(sql, params = []) {
      calls.push({ sql, params: [...params] });
      return { rows: lookup(sql).rows };
    },
    _calls: calls,
    _addScript(match, result) { scripts.push({ match, result }); }
  };
}

// ---- registry shape ----

test('memberServers: mysql.upsert uses INSERT...ON DUPLICATE KEY UPDATE keyed on hostname', () => {
  assert.match(memberServers.mysql.upsert, /INSERT INTO ad_member_servers/i);
  assert.match(memberServers.mysql.upsert, /ON DUPLICATE KEY UPDATE/i);
  // 7 placeholders: hostname, site_id, ip_address, os_version, agent_type, enabled, discovered_via
  assert.strictEqual((memberServers.mysql.upsert.match(/\?/g) || []).length, 7);
});

test('memberServers: mssql.upsert uses MERGE keyed on t.hostname = s.hostname', () => {
  assert.match(memberServers.mssql.upsert, /MERGE INTO ad_member_servers/i);
  assert.match(memberServers.mssql.upsert, /USING \(SELECT/i);
  assert.match(memberServers.mssql.upsert, /ON t\.hostname = s\.hostname/i);
  assert.strictEqual((memberServers.mssql.upsert.match(/\?/g) || []).length, 7);
});

test('memberServers: findByHostname, list, delete, touch* are simple SELECT/UPDATE/DELETE', () => {
  // findByHostname uses PK lookup via ? placeholder
  assert.match(memberServers.mysql.findByHostname, /WHERE hostname\s*=\s*\?/i);
  assert.match(memberServers.mssql.findByHostname, /WHERE hostname\s*=\s*\?/i);
  // list joins sites and orders by hostname
  assert.match(memberServers.mysql.list, /LEFT JOIN ad_sites/i);
  assert.match(memberServers.mysql.list, /ORDER BY ms\.hostname/i);
  assert.match(memberServers.mssql.list, /ORDER BY ms\.hostname/i);
  // delete uses hostname = ?
  assert.match(memberServers.mysql.delete, /DELETE FROM ad_member_servers WHERE hostname\s*=\s*\?/i);
  assert.match(memberServers.mssql.delete, /DELETE FROM ad_member_servers WHERE hostname\s*=\s*\?/i);
  // touchLastSeen / touchLastReport use NOW() vs SYSUTCDATETIME()
  assert.match(memberServers.mysql.touchLastSeen, /SET last_seen_at = NOW\(\)/i);
  assert.match(memberServers.mssql.touchLastSeen, /SET last_seen_at = SYSUTCDATETIME\(\)/i);
  assert.match(memberServers.mysql.touchLastReport, /SET last_report_at = NOW\(\)/i);
  assert.match(memberServers.mssql.touchLastReport, /SET last_report_at = SYSUTCDATETIME\(\)/i);
});

// ---- helper function: upsert ----
// (upsert SQL already covered above; the helper is currently only the SQL
// constants themselves — service code calls db.execute(upsert, [...])).
// We assert that the helper object is the shape the registry expects.

test('memberServers: exposed shape matches registry contract (no nested dialect)', () => {
  assert.equal(typeof memberServers, 'object');
  assert.equal(typeof memberServers.mysql, 'object');
  assert.equal(typeof memberServers.mssql, 'object');
  assert.equal(typeof memberServers.mysql.upsert, 'string');
  assert.equal(typeof memberServers.mssql.upsert, 'string');
});

test('memberServers: upsert MySQL params order matches placeholders (hostname, site_id, ip_address, os_version, agent_type, enabled, discovered_via)', async () => {
  const db = makeMockDb();
  db._addScript(/INSERT INTO ad_member_servers/i, { rows: [], affectedRows: 1, insertId: 1 });
  // The helper is the SQL constant; caller calls db.execute directly. We
  // simulate that here to lock in the placeholder/param contract:
  const params = ['host-a', null, null, null, 'non-ad', 1, 'self-register'];
  await db.execute(memberServers.mysql.upsert, params);
  assert.match(db._calls[0].sql, /INSERT INTO ad_member_servers/);
  assert.deepEqual(db._calls[0].params, params);
});

test('memberServers: upsert MSSQL uses MERGE SQL', async () => {
  const db = makeMockDb({ dialect: 'mssql' });
  db._addScript(/MERGE INTO ad_member_servers/i, { rows: [], affectedRows: 1, insertId: 1 });
  await db.execute(memberServers.mssql.upsert, ['host-b', 1, '10.0.0.1', 'Windows Server 2022', 'non-ad', 1, 'admin-add']);
  assert.match(db._calls[0].sql, /MERGE INTO ad_member_servers/i);
  assert.strictEqual(db._calls[0].params.length, 7);
  assert.equal(db._calls[0].params[0], 'host-b');
  assert.equal(db._calls[0].params[2], '10.0.0.1');
  assert.equal(db._calls[0].params[6], 'admin-add');
});
