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

test('serverGroups: mssql groups upsert uses MERGE keyed on group_name', () => {
  assert.match(serverGroups.mssql.upsert, /MERGE INTO ad_server_groups/i);
  assert.match(serverGroups.mssql.upsert, /ON t\.group_name = s\.group_name/i);
  assert.match(serverGroups.mssql.upsert, /WHEN NOT MATCHED THEN INSERT/i);
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
