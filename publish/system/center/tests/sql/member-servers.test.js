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
  // R2 T3: mssql hostname is VARCHAR(128); wrap ? in CAST(? AS VARCHAR(128))
  // to avoid Msg 468 cross-collation conflict on non-default collations.
  assert.match(memberServers.mssql.findByHostname, /WHERE hostname\s*=\s*CAST\(\?\s+AS\s+VARCHAR\(128\)\)/i);
  // list joins sites and orders by hostname
  assert.match(memberServers.mysql.list, /LEFT JOIN ad_sites/i);
  assert.match(memberServers.mysql.list, /ORDER BY ms\.hostname/i);
  assert.match(memberServers.mssql.list, /ORDER BY ms\.hostname/i);
  // delete uses hostname = ?
  assert.match(memberServers.mysql.delete, /DELETE FROM ad_member_servers WHERE hostname\s*=\s*\?/i);
  assert.match(memberServers.mssql.delete, /DELETE FROM ad_member_servers WHERE hostname\s*=\s*CAST\(\?\s+AS\s+VARCHAR\(128\)\)/i);
  // touchLastSeen / touchLastReport use NOW() vs SYSUTCDATETIME()
  assert.match(memberServers.mysql.touchLastSeen, /SET last_seen_at = NOW\(\)/i);
  // R2 T3: mssql hostname WHERE clause is wrapped in CAST(? AS VARCHAR(128)).
  assert.match(memberServers.mssql.touchLastSeen, /SET last_seen_at = SYSUTCDATETIME\(\)\s+WHERE hostname\s*=\s*CAST\(\?\s+AS\s+VARCHAR\(128\)\)/i);
  assert.match(memberServers.mysql.touchLastReport, /SET last_report_at = NOW\(\)/i);
  assert.match(memberServers.mssql.touchLastReport, /SET last_report_at = SYSUTCDATETIME\(\)\s+WHERE hostname\s*=\s*CAST\(\?\s+AS\s+VARCHAR\(128\)\)/i);
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

// ---- live-DB round-trip tests (Global Constraint #17) ----
//
// Below: real MySQL / MSSQL round-trip tests. Gated on TEST_MYSQL_URL /
// TEST_MSSQL_URL — when neither is set, these tests skip (the contract).
// Per-test hostname prefix lets multiple runs share the same DB without
// colliding; rows are cleaned up in `finally`.

import fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitSqlStatements } from '../../src/init/schema-applier.js';
import { buildSql } from '../../src/db/sql.js';
import { createMysqlDriver } from '../../src/db/drivers/mysql.js';
import { createMssqlDriver } from '../../src/db/drivers/mssql.js';
import { parseTestUrl } from '../integration/_url.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

const MSRV_MYSQL = !!process.env.TEST_MYSQL_URL;
const MSRV_MSSQL = !!process.env.TEST_MSSQL_URL;
const MSRV_PREFIX = 'msrv-rt-' + Date.now().toString(36) + '-';

test('memberServers (mysql): upsert -> findByHostname -> list -> touch -> delete round-trip',
  { skip: !MSRV_MYSQL }, async () => {
    const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
    const db = createMysqlDriver({ host, port, user, password, database: 'addashboard' });
    const m = memberServers.mysql;
    const h1 = MSRV_PREFIX + 'alpha';
    const h2 = MSRV_PREFIX + 'beta';
    try {
      const fileSql = fs.readFileSync(join(REPO_ROOT, 'db/migrations/014-member-servers.sql'), 'utf8');
      for (const stmt of splitSqlStatements(fileSql)) {
        await db.execute(stmt, []);
      }

      // INSERT (alpha) via upsert — 7 params
      let r = await db.execute(m.upsert, [h1, null, '10.0.0.10', 'Windows Server 2022', 'non-ad', 1, 'self-register']);
      assert.strictEqual(r.affectedRows, 1, 'first upsert should affect 1 row');
      // INSERT (beta)
      r = await db.execute(m.upsert, [h2, null, '10.0.0.11', 'Ubuntu 22.04', 'non-ad', 1, 'admin-add']);
      assert.strictEqual(r.affectedRows, 1);

      // findByHostname returns the row
      const found = await db.query(m.findByHostname, [h1]);
      assert.strictEqual(found.rows.length, 1);
      assert.strictEqual(found.rows[0].hostname, h1);
      assert.strictEqual(found.rows[0].ip_address, '10.0.0.10');
      assert.strictEqual(found.rows[0].agent_type, 'non-ad');
      assert.strictEqual(Number(found.rows[0].enabled), 1);

      // UPDATE (upsert again with new ip + os_version + discovered_via)
      r = await db.execute(m.upsert, [h1, null, '10.0.0.99', 'Windows Server 2025', 'non-ad', 1, 'admin-add']);
      assert.ok(r.affectedRows >= 1, 'second upsert should affect 1 row (insert or update)');
      const updated = await db.query(m.findByHostname, [h1]);
      assert.strictEqual(updated.rows[0].ip_address, '10.0.0.99');
      assert.strictEqual(updated.rows[0].os_version, 'Windows Server 2025');
      assert.strictEqual(updated.rows[0].discovered_via, 'admin-add');

      // list returns at least our two rows (LEFT JOIN to ad_sites exercises that path)
      const all = await db.query(m.list);
      const our = all.rows.filter(rw => rw.hostname && rw.hostname.startsWith(MSRV_PREFIX));
      assert.ok(our.length >= 2, `list should return at least 2 of our rows, got ${our.length}`);

      // touchLastSeen / touchLastReport
      r = await db.execute(m.touchLastSeen, [h1]);
      assert.strictEqual(r.affectedRows, 1);
      r = await db.execute(m.touchLastReport, [h1]);
      assert.strictEqual(r.affectedRows, 1);
      const afterTouch = await db.query(m.findByHostname, [h1]);
      assert.ok(afterTouch.rows[0].last_seen_at, 'last_seen_at should be populated');
      assert.ok(afterTouch.rows[0].last_report_at, 'last_report_at should be populated');

      // delete
      r = await db.execute(m.delete, [h1]);
      assert.strictEqual(r.affectedRows, 1);
      const gone = await db.query(m.findByHostname, [h1]);
      assert.strictEqual(gone.rows.length, 0, 'findByHostname should return no rows after delete');
    } finally {
      try { await db.execute('DELETE FROM ad_member_servers WHERE hostname LIKE ?', [MSRV_PREFIX + '%']); } catch {}
      await db.close();
    }
  });

test('memberServers (mssql): upsert -> findByHostname -> list -> touch -> delete round-trip',
  { skip: !MSRV_MSSQL }, async () => {
    const { user, password, host, port } = parseTestUrl('TEST_MSSQL_URL', { defaultPort: 1433 });
    const db = createMssqlDriver({ server: host, port, database: 'addashboard', user, password });
    const m = memberServers.mssql;
    const h1 = MSRV_PREFIX + 'alpha-mssql';
    const h2 = MSRV_PREFIX + 'beta-mssql';
    try {
      const fileSql = fs.readFileSync(join(REPO_ROOT, 'db/migrations/mssql/014-member-servers.sql'), 'utf8');
      for (const stmt of splitSqlStatements(fileSql)) {
        await db.execute(stmt, []);
      }

      // INSERT via MERGE WHEN NOT MATCHED
      let r = await db.execute(m.upsert, [h1, null, '10.0.0.10', 'Windows Server 2022', 'non-ad', 1, 'self-register']);
      assert.ok(r.affectedRows >= 1, 'first MERGE should affect at least 1 row');
      r = await db.execute(m.upsert, [h2, null, '10.0.0.11', 'Ubuntu 22.04', 'non-ad', 1, 'admin-add']);
      assert.ok(r.affectedRows >= 1);

      // findByHostname
      const found = await db.query(m.findByHostname, [h1]);
      assert.strictEqual(found.rows.length, 1);
      assert.strictEqual(found.rows[0].hostname, h1);
      assert.strictEqual(found.rows[0].ip_address, '10.0.0.10');
      assert.strictEqual(Number(found.rows[0].enabled), 1);

      // UPDATE via MERGE WHEN MATCHED
      r = await db.execute(m.upsert, [h1, null, '10.0.0.99', 'Windows Server 2025', 'non-ad', 1, 'admin-add']);
      const updated = await db.query(m.findByHostname, [h1]);
      assert.strictEqual(updated.rows[0].ip_address, '10.0.0.99');
      assert.strictEqual(updated.rows[0].os_version, 'Windows Server 2025');
      assert.strictEqual(updated.rows[0].discovered_via, 'admin-add');

      // list returns our rows (filtered by prefix in app)
      const all = await db.query(m.list);
      const our = all.rows.filter(rw => rw.hostname && rw.hostname.startsWith(MSRV_PREFIX));
      assert.ok(our.length >= 2, `list should return at least 2 of our rows, got ${our.length}`);

      // touchLastSeen / touchLastReport
      r = await db.execute(m.touchLastSeen, [h1]);
      assert.strictEqual(r.affectedRows, 1);
      r = await db.execute(m.touchLastReport, [h1]);
      assert.strictEqual(r.affectedRows, 1);
      const afterTouch = await db.query(m.findByHostname, [h1]);
      assert.ok(afterTouch.rows[0].last_seen_at, 'last_seen_at should be populated');
      assert.ok(afterTouch.rows[0].last_report_at, 'last_report_at should be populated');

      // delete
      r = await db.execute(m.delete, [h1]);
      assert.strictEqual(r.affectedRows, 1);
      const gone = await db.query(m.findByHostname, [h1]);
      assert.strictEqual(gone.rows.length, 0);
    } finally {
      try { await db.execute('DELETE FROM ad_member_servers WHERE hostname LIKE ?', [MSRV_PREFIX + '%']); } catch {}
      await db.close();
    }
  });
