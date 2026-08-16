// server-groups.test.js — covers the serverGroups SQL helper module
// (group inventory + membership + per-host package assignments).
//
// Pattern matches center/tests/sql/installed-packages.test.js: node:test +
// mock-DB assertions on the exported SQL blocks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serverGroups } from '../../src/db/sql/server-groups.js';

// ---- ad_server_groups ----

test('serverGroups: mysql groups upsert keyed on group_name (UNIQUE)', () => {
  assert.match(serverGroups.mysql.upsert, /INSERT INTO ad_server_groups/i);
  assert.match(serverGroups.mysql.upsert, /ON DUPLICATE KEY UPDATE/i);
  assert.strictEqual((serverGroups.mysql.upsert.match(/\?/g) || []).length, 2);
  assert.match(serverGroups.mysql.list, /SELECT.*member_count/i);
  assert.match(serverGroups.mysql.list, /ORDER BY g\.group_name/i);
  assert.match(serverGroups.mysql.delete, /DELETE FROM ad_server_groups WHERE group_id = \?/i);
});

test('serverGroups: mssql upsert is dead code (deleted — no caller; create is the entry point)', () => {
  // Audit 2026-08-16: serverGroups.mssql.upsert was a MERGE with an inline
  // SCOPE_IDENTITY() probe that returned NULL on the UPDATE branch. grep
  // confirmed no caller; the dead function was removed. If a future caller
  // needs upsert semantics, use serverGroups.upsertPackage pattern or
  // route through the driver's own INSERT-prefixed auto-probe.
  assert.equal(serverGroups.mssql.upsert, undefined, 'mssql upsert must remain removed');
});

// ---- ad_server_group_members ----

test('serverGroups: addMember MySQL keyed on (group_id, hostname) double-row PK', () => {
  assert.match(serverGroups.mysql.addMember, /INSERT INTO ad_server_group_members/i);
  assert.match(serverGroups.mysql.addMember, /ON DUPLICATE KEY UPDATE/i);
  assert.strictEqual((serverGroups.mysql.addMember.match(/\?/g) || []).length, 2);
  assert.match(serverGroups.mysql.removeMember, /DELETE FROM ad_server_group_members WHERE group_id = \? AND hostname = \?/i);
  assert.match(serverGroups.mysql.listMembers, /WHERE m\.group_id = \?/i);
  assert.match(serverGroups.mysql.listMembers, /ORDER BY m\.hostname/i);
  assert.match(serverGroups.mysql.listGroupsForHostname, /INNER JOIN ad_server_group_members/i);
  assert.match(serverGroups.mysql.listGroupsForHostname, /WHERE m\.hostname = \?/i);
});

test('serverGroups: addMember MSSQL keyed on (group_id, hostname) double-row PK', () => {
  assert.match(serverGroups.mssql.addMember, /MERGE INTO ad_server_group_members/i);
  assert.match(serverGroups.mssql.addMember, /ON t\.group_id = s\.group_id AND t\.hostname = s\.hostname/i);
  // MSSQL insert-only pattern: no WHEN MATCHED THEN UPDATE (since adding
  // an existing pair is a no-op).
  assert.doesNotMatch(serverGroups.mssql.addMember, /WHEN MATCHED THEN UPDATE/i);
  assert.strictEqual((serverGroups.mssql.addMember.match(/\?/g) || []).length, 2);
});

// ---- ad_member_server_packages ----

test('serverGroups: package upsert (MySQL) keyed on (hostname, package_name) double-row PK', () => {
  assert.match(serverGroups.mysql.upsertPackage, /INSERT INTO ad_member_server_packages/i);
  assert.match(serverGroups.mysql.upsertPackage, /ON DUPLICATE KEY UPDATE/i);
  assert.strictEqual((serverGroups.mysql.upsertPackage.match(/\?/g) || []).length, 3);
  assert.match(serverGroups.mysql.touchPackageRun, /SET last_run_at = NOW\(\)/i);
  assert.match(serverGroups.mysql.removePackage, /DELETE FROM ad_member_server_packages WHERE hostname = \? AND package_name = \?/i);
  assert.match(serverGroups.mysql.listPackagesForHost, /WHERE msp\.hostname = \?/i);
  assert.match(serverGroups.mysql.listPackagesForHost, /LEFT JOIN installed_packages/i);
  assert.match(serverGroups.mysql.listHostsForPackage, /WHERE msp\.package_name = \?/i);
});

test('serverGroups: package upsert (MSSQL) keyed on (hostname, package_name) double-row PK', () => {
  assert.match(serverGroups.mssql.upsertPackage, /MERGE INTO ad_member_server_packages/i);
  assert.match(serverGroups.mssql.upsertPackage, /ON t\.hostname = s\.hostname AND t\.package_name = s\.package_name/i);
  assert.strictEqual((serverGroups.mssql.upsertPackage.match(/\?/g) || []).length, 3);
  assert.match(serverGroups.mssql.touchPackageRun, /SET last_run_at = SYSUTCDATETIME\(\)/i);
});

// ---- Bulk operations added in Task 7 (server-groups admin routes) ----
// SQL-shape assertions for the new blocks. The real-DB round-trip is below.

test('serverGroups: mysql bulkInstallPackage uses INSERT IGNORE ... SELECT FROM ad_server_group_members', () => {
  assert.match(serverGroups.mysql.bulkInstallPackage, /INSERT\s+IGNORE\s+INTO\s+ad_member_server_packages/i);
  assert.match(serverGroups.mysql.bulkInstallPackage, /FROM\s+ad_server_group_members/i);
  assert.match(serverGroups.mysql.bulkInstallPackage, /WHERE\s+m\.group_id\s+=\s+\?/i);
  assert.strictEqual((serverGroups.mysql.bulkInstallPackage.match(/\?/g) || []).length, 3);
});

test('serverGroups: mssql bulkInstallPackage uses INSERT ... SELECT FROM ... WHERE NOT EXISTS (idempotent)', () => {
  assert.match(serverGroups.mssql.bulkInstallPackage, /INSERT\s+INTO\s+ad_member_server_packages/i);
  assert.match(serverGroups.mssql.bulkInstallPackage, /FROM\s+ad_server_group_members/i);
  assert.match(serverGroups.mssql.bulkInstallPackage, /NOT\s+EXISTS/i);
  // 4 params: package_name, enabled, group_id, package_name (NOT EXISTS subquery)
  assert.strictEqual((serverGroups.mssql.bulkInstallPackage.match(/\?/g) || []).length, 4);
});

test('serverGroups: bulkUninstallPackage joins via ad_server_group_members', () => {
  assert.match(serverGroups.mysql.bulkUninstallPackage, /DELETE\s+(msp\s+)?FROM\s+ad_member_server_packages/i);
  assert.match(serverGroups.mysql.bulkUninstallPackage, /INNER\s+JOIN\s+ad_server_group_members/i);
  assert.match(serverGroups.mssql.bulkUninstallPackage, /DELETE\s+(msp\s+)?FROM\s+ad_member_server_packages/i);
  assert.match(serverGroups.mssql.bulkUninstallPackage, /INNER\s+JOIN\s+ad_server_group_members/i);
  assert.strictEqual((serverGroups.mysql.bulkUninstallPackage.match(/\?/g) || []).length, 2);
  assert.strictEqual((serverGroups.mssql.bulkUninstallPackage.match(/\?/g) || []).length, 2);
});

test('serverGroups: bulkSetEnabled updates enabled flag via joined set', () => {
  assert.match(serverGroups.mysql.bulkSetEnabled, /UPDATE\s+ad_member_server_packages/i);
  assert.match(serverGroups.mysql.bulkSetEnabled, /INNER\s+JOIN\s+ad_server_group_members/i);
  assert.match(serverGroups.mysql.bulkSetEnabled, /SET\s+msp\.enabled\s+=\s+\?/i);
  assert.match(serverGroups.mssql.bulkSetEnabled, /UPDATE\s+msp\s+SET\s+msp\.enabled\s+=\s+\?/i);
  // 3 params: enabled, group_id, package_name
  assert.strictEqual((serverGroups.mysql.bulkSetEnabled.match(/\?/g) || []).length, 3);
  assert.strictEqual((serverGroups.mssql.bulkSetEnabled.match(/\?/g) || []).length, 3);
});

// ---- live-DB round-trip tests (Global Constraint #17) ----

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

const SG_MYSQL = !!process.env.TEST_MYSQL_URL;
const SG_MSSQL = !!process.env.TEST_MSSQL_URL;
const SG_PREFIX = 'sg-rt-' + Date.now().toString(36) + '-';

test('serverGroups (mysql): create group -> addMember -> listMembers -> upsertPackage -> listPackagesForHost -> delete round-trip',
  { skip: !SG_MYSQL }, async () => {
    const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
    const db = createMysqlDriver({ host, port, user, password, database: 'addashboard' });
    const m = serverGroups.mysql;
    const groupName = SG_PREFIX + 'group';
    const hostname = SG_PREFIX + 'host';
    const pkgName = SG_PREFIX + 'pkg';
    let groupId = null;
    try {
      const fileSql = fs.readFileSync(join(REPO_ROOT, 'db/migrations/014-member-servers.sql'), 'utf8');
      for (const stmt of splitSqlStatements(fileSql)) {
        await db.execute(stmt, []);
      }

      // Pre-seed: a member server (FK from ad_server_group_members.hostname) and
      // a row in installed_packages (FK from ad_member_server_packages.package_name).
      await db.execute(
        `INSERT INTO ad_member_servers (hostname, agent_type, discovered_via) VALUES (?, 'non-ad', 'self-register')
         ON DUPLICATE KEY UPDATE updated_at = NOW()`,
        [hostname]
      );
      await db.execute(
        `INSERT INTO installed_packages (name, version, type, manifest_json, enabled, source) VALUES (?, '1.0.0', 'gauge', '{}', 1, 'local')
         ON DUPLICATE KEY UPDATE updated_at = NOW()`,
        [pkgName]
      );

      // CREATE group (insertId is the AUTO_INCREMENT group_id)
      let r = await db.execute(m.create, [groupName, 'test group']);
      assert.ok(r.insertId != null, 'create should yield insertId');
      groupId = r.insertId;

      // findById confirms row landed
      const found = await db.query(m.findById, [groupId]);
      assert.strictEqual(found.rows.length, 1);
      assert.strictEqual(found.rows[0].group_name, groupName);

      // UPDATE: change description via update
      r = await db.execute(m.update, [groupName, 'updated description', groupId]);
      assert.strictEqual(r.affectedRows, 1);
      const afterUpdate = await db.query(m.findById, [groupId]);
      assert.strictEqual(afterUpdate.rows[0].description, 'updated description');

      // addMember: insert into ad_server_group_members
      r = await db.execute(m.addMember, [groupId, hostname]);
      assert.strictEqual(r.affectedRows, 1);

      // listMembers: should include our host
      const members = await db.query(m.listMembers, [groupId]);
      assert.strictEqual(members.rows.length, 1);
      assert.strictEqual(members.rows[0].hostname, hostname);

      // listGroupsForHostname: should include our group
      const groups = await db.query(m.listGroupsForHostname, [hostname]);
      assert.ok(groups.rows.some(g => g.group_id === groupId));

      // upsertPackage: insert into ad_member_server_packages
      r = await db.execute(m.upsertPackage, [hostname, pkgName, 1]);
      assert.strictEqual(r.affectedRows, 1);

      // Update: same row but with enabled=0
      r = await db.execute(m.upsertPackage, [hostname, pkgName, 0]);
      assert.strictEqual(r.affectedRows, 2, 'ON DUPLICATE KEY UPDATE: 1 update + 1 found');

      // listPackagesForHost: should include our package (LEFT JOIN to installed_packages)
      const packages = await db.query(m.listPackagesForHost, [hostname]);
      const our = packages.rows.find(p => p.package_name === pkgName);
      assert.ok(our, 'our package must be in listPackagesForHost result');
      assert.strictEqual(Number(our.enabled), 0, 'enabled should be 0 after the update');

      // listHostsForPackage: should include our host
      const hosts = await db.query(m.listHostsForPackage, [pkgName]);
      assert.ok(hosts.rows.some(h => h.hostname === hostname));

      // touchPackageRun: stamps last_run_at
      r = await db.execute(m.touchPackageRun, [hostname, pkgName]);
      assert.strictEqual(r.affectedRows, 2);
      const afterTouch = await db.query(m.listPackagesForHost, [hostname]);
      const touched = afterTouch.rows.find(p => p.package_name === pkgName);
      assert.ok(touched.last_run_at, 'last_run_at should be populated after touch');

      // DELETE cascade: removeMember then delete the group (cascades to group_members + server_packages)
      r = await db.execute(m.removeMember, [groupId, hostname]);
      assert.strictEqual(r.affectedRows, 1);
      r = await db.execute(m.delete, [groupId]);
      assert.strictEqual(r.affectedRows, 1);
      const gone = await db.query(m.findById, [groupId]);
      assert.strictEqual(gone.rows.length, 0);
    } finally {
      // Best-effort cleanup
      try { await db.execute('DELETE FROM ad_member_server_packages WHERE package_name = ?', [pkgName]); } catch {}
      try { await db.execute('DELETE FROM ad_server_group_members WHERE hostname = ?', [hostname]); } catch {}
      if (groupId != null) {
        try { await db.execute('DELETE FROM ad_server_groups WHERE group_id = ?', [groupId]); } catch {}
      }
      try { await db.execute('DELETE FROM ad_member_servers WHERE hostname = ?', [hostname]); } catch {}
      try { await db.execute('DELETE FROM installed_packages WHERE name = ?', [pkgName]); } catch {}
      await db.close();
    }
  });

test('serverGroups (mssql): create group -> addMember -> listMembers -> upsertPackage -> listPackagesForHost -> delete round-trip',
  { skip: !SG_MSSQL }, async () => {
    const { user, password, host, port } = parseTestUrl('TEST_MSSQL_URL', { defaultPort: 1433 });
    const db = createMssqlDriver({ server: host, port, database: 'addashboard', user, password });
    const m = serverGroups.mssql;
    const groupName = SG_PREFIX + 'group-mssql';
    const hostname = SG_PREFIX + 'host-mssql';
    const pkgName = SG_PREFIX + 'pkg-mssql';
    let groupId = null;
    try {
      const fileSql = fs.readFileSync(join(REPO_ROOT, 'db/migrations/mssql/014-member-servers.sql'), 'utf8');
      for (const stmt of splitSqlStatements(fileSql)) {
        await db.execute(stmt, []);
      }

      // Pre-seed: ad_member_servers (FK target) + installed_packages (FK target)
      // MSSQL MERGE upsert for member server
      await db.execute(
        `MERGE INTO ad_member_servers AS t USING (SELECT ? AS hostname) AS s ON t.hostname = s.hostname
         WHEN NOT MATCHED THEN INSERT (hostname, agent_type, discovered_via) VALUES (s.hostname, 'non-ad', 'self-register');`,
        [hostname]
      );
      // MSSQL MERGE upsert for installed_packages
      await db.execute(
        `MERGE INTO installed_packages AS t USING (SELECT ? AS name) AS s ON t.name = s.name
         WHEN NOT MATCHED THEN INSERT (name, version, type, manifest_json, enabled, source)
         VALUES (s.name, '1.0.0', 'gauge', '{}', 1, 'local');`,
        [pkgName]
      );

      // CREATE group (mssql: INSERT + SCOPE_IDENTITY() → insertId)
      let r = await db.execute(m.create, [groupName, 'test group mssql']);
      assert.ok(r.insertId != null, 'create should yield insertId (SCOPE_IDENTITY)');
      groupId = r.insertId;

      // findById
      const found = await db.query(m.findById, [groupId]);
      assert.strictEqual(found.rows.length, 1);
      assert.strictEqual(found.rows[0].group_name, groupName);

      // UPDATE
      r = await db.execute(m.update, [groupName, 'updated mssql', groupId]);
      assert.strictEqual(r.affectedRows, 1);
      const afterUpdate = await db.query(m.findById, [groupId]);
      assert.strictEqual(afterUpdate.rows[0].description, 'updated mssql');

      // addMember via MERGE WHEN NOT MATCHED
      r = await db.execute(m.addMember, [groupId, hostname]);
      assert.ok(r.affectedRows >= 1);

      // listMembers
      const members = await db.query(m.listMembers, [groupId]);
      assert.strictEqual(members.rows.length, 1);
      assert.strictEqual(members.rows[0].hostname, hostname);

      // listGroupsForHostname
      const groups = await db.query(m.listGroupsForHostname, [hostname]);
      assert.ok(groups.rows.some(g => g.group_id === groupId));

      // upsertPackage: insert
      r = await db.execute(m.upsertPackage, [hostname, pkgName, 1]);
      assert.ok(r.affectedRows >= 1);

      // upsertPackage: update (same key, enabled=0) — should hit WHEN MATCHED branch
      r = await db.execute(m.upsertPackage, [hostname, pkgName, 0]);
      assert.ok(r.affectedRows >= 1);

      // listPackagesForHost
      const packages = await db.query(m.listPackagesForHost, [hostname]);
      const our = packages.rows.find(p => p.package_name === pkgName);
      assert.ok(our, 'our package must be in listPackagesForHost result');
      assert.strictEqual(Number(our.enabled), 0);

      // listHostsForPackage
      const hosts = await db.query(m.listHostsForPackage, [pkgName]);
      assert.ok(hosts.rows.some(h => h.hostname === hostname));

      // touchPackageRun
      r = await db.execute(m.touchPackageRun, [hostname, pkgName]);
      assert.ok(r.affectedRows >= 1);
      const afterTouch = await db.query(m.listPackagesForHost, [hostname]);
      const touched = afterTouch.rows.find(p => p.package_name === pkgName);
      assert.ok(touched.last_run_at, 'last_run_at should be populated after touch');

      // DELETE: removeMember then group delete
      r = await db.execute(m.removeMember, [groupId, hostname]);
      assert.strictEqual(r.affectedRows, 1);
      r = await db.execute(m.delete, [groupId]);
      assert.strictEqual(r.affectedRows, 1);
      const gone = await db.query(m.findById, [groupId]);
      assert.strictEqual(gone.rows.length, 0);
    } finally {
      try { await db.execute('DELETE FROM ad_member_server_packages WHERE package_name = ?', [pkgName]); } catch {}
      try { await db.execute('DELETE FROM ad_server_group_members WHERE hostname = ?', [hostname]); } catch {}
      if (groupId != null) {
        try { await db.execute('DELETE FROM ad_server_groups WHERE group_id = ?', [groupId]); } catch {}
      }
      try { await db.execute('DELETE FROM ad_member_servers WHERE hostname = ?', [hostname]); } catch {}
      try { await db.execute('DELETE FROM installed_packages WHERE name = ?', [pkgName]); } catch {}
      await db.close();
    }
  });

// ---- Bulk operations added in Task 7 (server-groups admin routes) ----
// Each pair below exercises the new SQL blocks (bulkInstallPackage,
// bulkUninstallPackage, bulkSetEnabled) against a real DB. Skipped when
// TEST_MYSQL_URL / TEST_MSSQL_URL are unset (the project convention — see
// Global Constraint #17).

test('serverGroups (mysql): bulkInstallPackage -> bulkSetEnabled -> bulkUninstallPackage round-trip',
  { skip: !SG_MYSQL }, async () => {
    const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
    const db = createMysqlDriver({ host, port, user, password, database: 'addashboard' });
    const m = serverGroups.mysql;
    const groupName = SG_PREFIX + 'bulk-group';
    const host1 = SG_PREFIX + 'bulk-1';
    const host2 = SG_PREFIX + 'bulk-2';
    const pkgName = SG_PREFIX + 'bulk-pkg';
    let groupId = null;
    try {
      const fileSql = fs.readFileSync(join(REPO_ROOT, 'db/migrations/014-member-servers.sql'), 'utf8');
      for (const stmt of splitSqlStatements(fileSql)) {
        await db.execute(stmt, []);
      }
      // Pre-seed: member servers + installed_packages (FK targets)
      for (const h of [host1, host2]) {
        await db.execute(
          `INSERT INTO ad_member_servers (hostname, agent_type, discovered_via) VALUES (?, 'non-ad', 'self-register')
           ON DUPLICATE KEY UPDATE updated_at = NOW()`,
          [h]
        );
      }
      await db.execute(
        `INSERT INTO installed_packages (name, version, type, manifest_json, enabled, source) VALUES (?, '1.0.0', 'gauge', '{}', 1, 'local')
         ON DUPLICATE KEY UPDATE updated_at = NOW()`,
        [pkgName]
      );
      // CREATE group + add both members
      const cr = await db.execute(m.create, [groupName, 'bulk-test']);
      groupId = cr.insertId;
      await db.execute(m.addMember, [groupId, host1]);
      await db.execute(m.addMember, [groupId, host2]);

      // bulkInstallPackage — MySQL: INSERT IGNORE ... SELECT FROM
      // 3 params: package_name, enabled, group_id
      let r = await db.execute(m.bulkInstallPackage, [pkgName, 1, groupId]);
      assert.strictEqual(r.affectedRows, 2, 'bulk install should affect both members');

      // bulkInstallPackage is idempotent — second call is a no-op
      r = await db.execute(m.bulkInstallPackage, [pkgName, 1, groupId]);
      assert.strictEqual(r.affectedRows, 0, 'second bulk install should be no-op (INSERT IGNORE)');

      // Verify both rows landed
      const pkgs = await db.query(m.listHostsForPackage, [pkgName]);
      const our = pkgs.rows.filter(rw => [host1, host2].includes(rw.hostname));
      assert.strictEqual(our.length, 2);

      // bulkSetEnabled = 0
      r = await db.execute(m.bulkSetEnabled, [0, groupId, pkgName]);
      assert.strictEqual(r.affectedRows, 2, 'disable should affect both members');

      const afterDisable = await db.query(m.listHostsForPackage, [pkgName]);
      for (const row of afterDisable.rows.filter(rw => [host1, host2].includes(rw.hostname))) {
        assert.strictEqual(Number(row.enabled), 0);
      }

      // bulkUninstallPackage
      r = await db.execute(m.bulkUninstallPackage, [groupId, pkgName]);
      assert.strictEqual(r.affectedRows, 2);

      // Verify cleanup
      const gone = await db.query(m.listHostsForPackage, [pkgName]);
      const oursGone = gone.rows.filter(rw => [host1, host2].includes(rw.hostname));
      assert.strictEqual(oursGone.length, 0, 'rows should be gone after bulk uninstall');
    } finally {
      try { await db.execute('DELETE FROM ad_member_server_packages WHERE package_name = ?', [pkgName]); } catch {}
      try { await db.execute('DELETE FROM ad_server_group_members WHERE hostname LIKE ?', [SG_PREFIX + 'bulk-%']); } catch {}
      if (groupId != null) {
        try { await db.execute('DELETE FROM ad_server_groups WHERE group_id = ?', [groupId]); } catch {}
      }
      try { await db.execute('DELETE FROM ad_member_servers WHERE hostname LIKE ?', [SG_PREFIX + 'bulk-%']); } catch {}
      try { await db.execute('DELETE FROM installed_packages WHERE name = ?', [pkgName]); } catch {}
      await db.close();
    }
  });

test('serverGroups (mssql): bulkInstallPackage -> bulkSetEnabled -> bulkUninstallPackage round-trip',
  { skip: !SG_MSSQL }, async () => {
    const { user, password, host, port } = parseTestUrl('TEST_MSSQL_URL', { defaultPort: 1433 });
    const db = createMssqlDriver({ server: host, port, database: 'addashboard', user, password });
    const m = serverGroups.mssql;
    const groupName = SG_PREFIX + 'bulk-mssql';
    const host1 = SG_PREFIX + 'bulk-mssql-1';
    const host2 = SG_PREFIX + 'bulk-mssql-2';
    const pkgName = SG_PREFIX + 'bulk-mssql-pkg';
    let groupId = null;
    try {
      const fileSql = fs.readFileSync(join(REPO_ROOT, 'db/migrations/mssql/014-member-servers.sql'), 'utf8');
      for (const stmt of splitSqlStatements(fileSql)) {
        await db.execute(stmt, []);
      }
      for (const h of [host1, host2]) {
        await db.execute(
          `MERGE INTO ad_member_servers AS t USING (SELECT ? AS hostname) AS s ON t.hostname = s.hostname
           WHEN NOT MATCHED THEN INSERT (hostname, agent_type, discovered_via) VALUES (s.hostname, 'non-ad', 'self-register');`,
          [h]
        );
      }
      await db.execute(
        `MERGE INTO installed_packages AS t USING (SELECT ? AS name) AS s ON t.name = s.name
         WHEN NOT MATCHED THEN INSERT (name, version, type, manifest_json, enabled, source)
         VALUES (s.name, '1.0.0', 'gauge', '{}', 1, 'local');`,
        [pkgName]
      );
      // CREATE group + add both members
      const cr = await db.execute(m.create, [groupName, 'bulk-test mssql']);
      groupId = cr.insertId;
      await db.execute(m.addMember, [groupId, host1]);
      await db.execute(m.addMember, [groupId, host2]);

      // bulkInstallPackage — MSSQL: INSERT ... SELECT FROM ... WHERE NOT EXISTS
      // 4 params: package_name, enabled, group_id, package_name (for NOT EXISTS)
      let r = await db.execute(m.bulkInstallPackage, [pkgName, 1, groupId, pkgName]);
      assert.ok(r.affectedRows >= 2, `bulk install should affect both members, got ${r.affectedRows}`);

      // Idempotent — NOT EXISTS makes the second call a no-op
      r = await db.execute(m.bulkInstallPackage, [pkgName, 1, groupId, pkgName]);
      assert.strictEqual(r.affectedRows, 0, 'second bulk install should be no-op (NOT EXISTS)');

      const pkgs = await db.query(m.listHostsForPackage, [pkgName]);
      const our = pkgs.rows.filter(rw => [host1, host2].includes(rw.hostname));
      assert.strictEqual(our.length, 2);

      // bulkSetEnabled = 0
      r = await db.execute(m.bulkSetEnabled, [0, groupId, pkgName]);
      assert.ok(r.affectedRows >= 2);

      const afterDisable = await db.query(m.listHostsForPackage, [pkgName]);
      for (const row of afterDisable.rows.filter(rw => [host1, host2].includes(rw.hostname))) {
        assert.strictEqual(Number(row.enabled), 0);
      }

      // bulkUninstallPackage
      r = await db.execute(m.bulkUninstallPackage, [groupId, pkgName]);
      assert.ok(r.affectedRows >= 2);

      const gone = await db.query(m.listHostsForPackage, [pkgName]);
      const oursGone = gone.rows.filter(rw => [host1, host2].includes(rw.hostname));
      assert.strictEqual(oursGone.length, 0);
    } finally {
      try { await db.execute('DELETE FROM ad_member_server_packages WHERE package_name = ?', [pkgName]); } catch {}
      try { await db.execute('DELETE FROM ad_server_group_members WHERE hostname LIKE ?', [SG_PREFIX + 'bulk-mssql-%']); } catch {}
      if (groupId != null) {
        try { await db.execute('DELETE FROM ad_server_groups WHERE group_id = ?', [groupId]); } catch {}
      }
      try { await db.execute('DELETE FROM ad_member_servers WHERE hostname LIKE ?', [SG_PREFIX + 'bulk-mssql-%']); } catch {}
      try { await db.execute('DELETE FROM installed_packages WHERE name = ?', [pkgName]); } catch {}
      await db.close();
    }
  });
