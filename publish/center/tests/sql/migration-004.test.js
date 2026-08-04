// migration-004.test.js — verifies that migration 004 (package system)
// has been applied to the test database, creating the 6 new tables.
//
// Runs against TEST_MYSQL_URL (MySQL only for v1). MSSQL coverage is
// added in Task 5/6 integration tests.
//
// Skipped when TEST_MYSQL_URL is not set so the suite stays green on
// developer machines without a live MySQL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMysqlDriver } from '../../src/db/drivers/mysql.js';

const NEW_TABLES = [
  'installed_packages',
  'metric_gauge',
  'metric_counter',
  'metric_timeseries',
  'metric_status',
  'package_runs'
];

function parseTestMysqlUrl(raw) {
  // Format: [user[:password]@]host[:port]
  let user = 'root', password = '', host = raw, port = 3306;
  const atIdx = raw.lastIndexOf('@');
  if (atIdx >= 0) {
    const creds = raw.slice(0, atIdx);
    host = raw.slice(atIdx + 1);
    const colonIdx = creds.indexOf(':');
    if (colonIdx >= 0) {
      user = creds.slice(0, colonIdx);
      password = creds.slice(colonIdx + 1);
    } else {
      user = creds;
    }
  }
  const portIdx = host.lastIndexOf(':');
  if (portIdx >= 0 && /^\d+$/.test(host.slice(portIdx + 1))) {
    port = parseInt(host.slice(portIdx + 1), 10);
    host = host.slice(0, portIdx);
  }
  return { user, password, host, port };
}

test('migration 004 package system — all 6 tables exist (MySQL)', async (t) => {
  const url = process.env.TEST_MYSQL_URL;
  if (!url) return t.skip('TEST_MYSQL_URL not set');

  const { user, password, host, port } = parseTestMysqlUrl(url);
  const db = createMysqlDriver({ host, port, user, password, database: 'addashboard' });
  try {
    const placeholders = NEW_TABLES.map(() => '?').join(',');
    const result = await db.execute(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME IN (${placeholders})`,
      NEW_TABLES
    );
    assert.equal(result.rows.length, 6,
      `expected 6 migration-004 tables, found ${result.rows.length}: ${result.rows.map(r => r.TABLE_NAME).join(', ')}`);
    const names = new Set(result.rows.map(r => r.TABLE_NAME));
    for (const expected of NEW_TABLES) {
      assert.ok(names.has(expected), `missing table: ${expected}`);
    }
  } finally {
    await db.close();
  }
});
