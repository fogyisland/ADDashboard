// probe-state.test.js — verifies migration 012 (probe_state table) and the
// probeState SQL helpers (getAll / upsertRow) round-trip against a live DB.
//
// Pattern follows audit-migration.test.js + migration-004.test.js (driver-
// level with parseTestUrl from tests/integration/_url.js). Tests are gated
// on TEST_MYSQL_URL / TEST_MSSQL_URL so the suite stays green on dev
// machines without a live DB.

import { test } from 'node:test';
import assert from 'node:assert/strict';
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

const MYSQL = !!process.env.TEST_MYSQL_URL;
const MSSQL = !!process.env.TEST_MSSQL_URL;

test('migration 012 (mysql + mssql): declares "verify: table probe_state" marker', () => {
  const mysql = fs.readFileSync(join(REPO_ROOT, 'db/migrations/012-probe-state.sql'), 'utf8');
  const mssql = fs.readFileSync(join(REPO_ROOT, 'db/migrations/mssql/012-probe-state.sql'), 'utf8');
  assert.ok(/verify:\s*table\s+probe_state/i.test(mysql.split('\n').slice(0, 50).join('\n')),
    'mysql 012 must declare a verify marker for table probe_state');
  assert.ok(/verify:\s*table\s+probe_state/i.test(mssql.split('\n').slice(0, 50).join('\n')),
    'mssql 012 must declare a verify marker for table probe_state');
});

test('migration 012 (mysql): probe_state round-trip via getAll/upsertRow', { skip: !MYSQL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  const db = createMysqlDriver({ host, port, user, password, database: 'addashboard' });
  const sql = buildSql('mysql');
  try {
    // Apply migration (idempotent via CREATE TABLE IF NOT EXISTS + INSERT IGNORE)
    const fileSql = fs.readFileSync(join(REPO_ROOT, 'db/migrations/012-probe-state.sql'), 'utf8');
    for (const stmt of splitSqlStatements(fileSql)) {
      await db.execute(stmt, []);
    }

    // Seed rows should exist
    const seedResult = await db.execute('SELECT COUNT(*) AS n FROM probe_state');
    assert.ok(Number(seedResult.rows[0].n) >= 3, `expected at least 3 seed rows, got ${seedResult.rows[0].n}`);

    // getAll must return 3 rows minimum (seed)
    const { rows: before } = await db.execute(sql.probeState.getAll);
    assert.ok(before.length >= 3, `expected getAll to return seed rows, got ${before.length}`);

    // Upsert an update to the existing 'web' row
    await db.execute(sql.probeState.upsertRow('web', 'healthy', 12, '2026-08-08T10:00:00Z', '2026-08-08T10:00:00Z', 0));

    const { rows } = await db.execute(sql.probeState.getAll);
    const web = rows.find(r => r.port_role === 'web');
    assert.ok(web, 'web row must exist after upsert');
    assert.strictEqual(web.status, 'healthy');
    assert.strictEqual(Number(web.latency_ms), 12);
    assert.strictEqual(Number(web.consecutive_failures), 0);

    // Upsert a 4th role to confirm NOT MATCHED branch fires (no PK collision,
    // just a different port_role than the 3 seeds)
    await db.execute(sql.probeState.upsertRow('extra', 'degraded', 250, '2026-08-08T10:01:00Z', null, 3));
    const { rows: after } = await db.execute(sql.probeState.getAll);
    const extra = after.find(r => r.port_role === 'extra');
    assert.ok(extra, 'extra row must be inserted by upsert');
    assert.strictEqual(extra.status, 'degraded');
    assert.strictEqual(Number(extra.consecutive_failures), 3);
  } finally {
    try { await db.execute("DELETE FROM probe_state WHERE port_role = 'extra'"); } catch {}
    try { await db.execute("UPDATE probe_state SET status='unknown', latency_ms=NULL, last_probe_at=NULL, last_up_at=NULL, consecutive_failures=0 WHERE port_role='web'"); } catch {}
    await db.close();
  }
});

test('migration 012 (mssql): probe_state round-trip via getAll/upsertRow', { skip: !MSSQL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MSSQL_URL', { defaultPort: 1433 });
  const db = createMssqlDriver({ server: host, port, database: 'addashboard', user, password });
  const sql = buildSql('mssql');
  try {
    const fileSql = fs.readFileSync(join(REPO_ROOT, 'db/migrations/mssql/012-probe-state.sql'), 'utf8');
    for (const stmt of splitSqlStatements(fileSql)) {
      await db.execute(stmt, []);
    }

    const seedResult = await db.execute('SELECT COUNT(*) AS n FROM probe_state');
    assert.ok(Number(seedResult.rows[0].n) >= 3, `expected at least 3 seed rows, got ${seedResult.rows[0].n}`);

    const { rows: before } = await db.execute(sql.probeState.getAll);
    assert.ok(before.length >= 3, `expected getAll to return seed rows, got ${before.length}`);

    await db.execute(sql.probeState.upsertRow('web', 'healthy', 12, '2026-08-08T10:00:00Z', '2026-08-08T10:00:00Z', 0));

    const { rows } = await db.execute(sql.probeState.getAll);
    const web = rows.find(r => r.port_role === 'web');
    assert.ok(web, 'web row must exist after upsert');
    assert.strictEqual(web.status, 'healthy');
    assert.strictEqual(Number(web.latency_ms), 12);

    await db.execute(sql.probeState.upsertRow('extra', 'degraded', 250, '2026-08-08T10:01:00Z', null, 3));
    const { rows: after } = await db.execute(sql.probeState.getAll);
    const extra = after.find(r => r.port_role === 'extra');
    assert.ok(extra, 'extra row must be inserted by upsert');
    assert.strictEqual(extra.status, 'degraded');
    assert.strictEqual(Number(extra.consecutive_failures), 3);
  } finally {
    try { await db.execute("DELETE FROM probe_state WHERE port_role = 'extra'"); } catch {}
    try { await db.execute("UPDATE probe_state SET status='unknown', latency_ms=NULL, last_probe_at=NULL, last_up_at=NULL, consecutive_failures=0 WHERE port_role='web'"); } catch {}
    await db.close();
  }
});