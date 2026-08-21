// sql-scanner.test.js — verify the static table-reference extractor
// against a synthetic fixture tree. We don't want to depend on the real
// center/src layout so the test stays deterministic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  scanCenterCodeForTables,
  schemaForTable,
  baseTableName
} from '../../src/services/sql-scanner.js';

test('scanCenterCodeForTables: extracts FROM / JOIN / INSERT / UPDATE / DELETE / ALTER / CREATE TABLE', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));
  try {
    fs.writeFileSync(path.join(tmp, 'a.js'), `
      const x = "SELECT * FROM ad_users";
      const y = \`INSERT INTO ad_agent_heartbeat (agent_id) VALUES (?)\`;
      const z = "UPDATE ad_sites SET name = ?";
      const w = "DELETE FROM orphan_schemas WHERE name = ?";
      const v = "ALTER TABLE ad_users ADD COLUMN foo INT";
      const u = "CREATE TABLE IF NOT EXISTS ad_brand_new (id INT PRIMARY KEY)";
    `);
    fs.writeFileSync(path.join(tmp, 'b.js'), `
      const j = "SELECT a.id FROM ad_users a JOIN ad_roles r ON r.id = a.role_id";
    `);
    const refs = scanCenterCodeForTables(tmp);
    const found = new Set(refs.keys());
    for (const t of ['ad_users', 'ad_agent_heartbeat', 'ad_sites', 'orphan_schemas',
                     'ad_roles', 'ad_brand_new']) {
      assert.ok(found.has(t), `expected to find ${t}, got: ${[...found].join(', ')}`);
    }
    // Each should have at least one reference.
    assert.ok(refs.get('ad_users').size >= 2, 'ad_users appears in both files');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('scanCenterCodeForTables: skips information_schema / sys / mysql schemas', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));
  try {
    fs.writeFileSync(path.join(tmp, 'a.js'), `
      const x = "SELECT * FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?";
      const y = "SELECT * FROM sys.tables";
      const z = "SELECT * FROM mysql.user";
      const w = "SELECT * FROM ad_users";
    `);
    const refs = scanCenterCodeForTables(tmp);
    const found = new Set(refs.keys());
    assert.ok(found.has('ad_users'));
    assert.ok(!found.has('TABLES'), 'should not pick up information_schema.TABLES');
    assert.ok(!found.has('tables'), 'should not pick up sys.tables');
    assert.ok(!found.has('user'), 'should not pick up mysql.user');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('schemaForTable: routes pkg_* to a pkg_<name> schema and others to the configured DB', () => {
  assert.equal(schemaForTable('ad_users', 'addashboard'), 'addashboard');
  assert.equal(schemaForTable('audit_logs', 'addashboard'), 'addashboard');
  assert.equal(schemaForTable('pkg_ad_local_port_check', 'addashboard'),
               'pkg_ad_local_port_check');
  assert.equal(schemaForTable('pkg_ad_local_port_check.metrics', 'addashboard'),
               'pkg_ad_local_port_check');
});

test('baseTableName: strips package naming-context suffix', () => {
  assert.equal(baseTableName('metrics'), 'metrics');
  assert.equal(baseTableName('pkg_ad_local_port_check.metrics'), 'metrics');
  assert.equal(baseTableName('ad_users'), 'ad_users');
});