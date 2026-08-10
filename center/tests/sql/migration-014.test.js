// migration-014.test.js — verifies migration 014 (non-AD member-server
// management + alert engine: 8 tables) applies cleanly against a live DB
// in both dialects, and is idempotent on rerun.
//
// Pattern follows probe-state.test.js (012) and migration-013.test.js:
//   - driver-level with parseTestUrl from tests/integration/_url.js;
//   - gated on TEST_MYSQL_URL / TEST_MSSQL_URL so the suite stays green
//     on dev machines without a live DB;
//   - splitSqlStatements applied per file (the same code-path the
//     schema-applier uses, minus DDL sandbox scanning which only applies
//     to package schemas).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitSqlStatements } from '../../src/init/schema-applier.js';
import { parseVerifyMarker } from '../../src/init/verify-marker.js';
import { buildSql } from '../../src/db/sql.js';
import { createMysqlDriver } from '../../src/db/drivers/mysql.js';
import { createMssqlDriver } from '../../src/db/drivers/mssql.js';
import { parseTestUrl } from '../integration/_url.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

const MYSQL = !!process.env.TEST_MYSQL_URL;
const MSSQL = !!process.env.TEST_MSSQL_URL;

// Every table declared in the migration must also declare a verify
// marker so bootstrapMigrations can recognize a clean apply on existing
// deployments. Both dialects must agree on the marker set.
describe('migration 014 — declares verify markers for all 8 tables', () => {
  const expected = [
    'ad_member_servers', 'ad_server_groups', 'ad_server_group_members',
    'ad_member_server_packages', 'alert_rules', 'alert_rule_state',
    'alert_events', 'alert_email_outbox'
  ];

  test('mysql 014 markers cover every table', () => {
    const sql = fs.readFileSync(join(REPO_ROOT, 'db/migrations/014-member-servers.sql'), 'utf8');
    const markers = parseVerifyMarker(sql);
    for (const t of expected) {
      assert.ok(
        markers.some(m => m.kind === 'table' && m.name === t),
        `mysql 014 markers must include table ${t}; got ${JSON.stringify(markers)}`
      );
    }
  });

  test('mssql 014 markers cover every table', () => {
    const sql = fs.readFileSync(join(REPO_ROOT, 'db/migrations/mssql/014-member-servers.sql'), 'utf8');
    const markers = parseVerifyMarker(sql);
    for (const t of expected) {
      assert.ok(
        markers.some(m => m.kind === 'table' && m.name === t),
        `mssql 014 markers must include table ${t}; got ${JSON.stringify(markers)}`
      );
    }
  });
});

// apply: actually executes the migration file's statements against the
// live DB, then probes each expected table via the dialect-aware
// db.sql.probe probe (so this also exercises the bootstrapMigrations
// detection path).
test('migration 014 (mysql): all 8 tables exist after apply + idempotent rerun', { skip: !MYSQL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  const db = createMysqlDriver({ host, port, user, password, database: 'addashboard' });
  const sql = buildSql('mysql');
  const fileSql = fs.readFileSync(join(REPO_ROOT, 'db/migrations/014-member-servers.sql'), 'utf8');
  try {
    await applyAndAssertAllEightTables(db, sql, fileSql);
    // Re-apply — splitSqlStatements should produce only CREATE TABLE IF NOT EXISTS
    // statements, so each is a no-op the second time.
    for (const stmt of splitSqlStatements(fileSql)) {
      await db.execute(stmt, []);
    }
    await assertAllEightTablesExist(db, sql);
  } finally {
    await db.close();
  }
});

test('migration 014 (mssql): all 8 tables exist after apply + idempotent rerun', { skip: !MSSQL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MSSQL_URL', { defaultPort: 1433 });
  const db = createMssqlDriver({ server: host, port, database: 'addashboard', user, password });
  const sql = buildSql('mssql');
  const fileSql = fs.readFileSync(join(REPO_ROOT, 'db/migrations/mssql/014-member-servers.sql'), 'utf8');
  try {
    await applyAndAssertAllEightTables(db, sql, fileSql);
    for (const stmt of splitSqlStatements(fileSql)) {
      await db.execute(stmt, []);
    }
    await assertAllEightTablesExist(db, sql);
  } finally {
    await db.close();
  }
});

const EIGHT = [
  'ad_member_servers', 'ad_server_groups', 'ad_server_group_members',
  'ad_member_server_packages', 'alert_rules', 'alert_rule_state',
  'alert_events', 'alert_email_outbox'
];

async function applyAndAssertAllEightTables(db, sql, fileSql) {
  for (const stmt of splitSqlStatements(fileSql)) {
    await db.execute(stmt, []);
  }
  await assertAllEightTablesExist(db, sql);
}

async function assertAllEightTablesExist(db, sql) {
  for (const t of EIGHT) {
    const { rows } = await db.query(sql.probe.table, [t]);
    assert.ok(rows && rows.length === 1, `table ${t} must exist after applying migration 014`);
  }
}
