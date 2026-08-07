// audit-migration.test.js — verifies migrations 010 (payload JSON) and 011
// (composite indexes) are present and apply cleanly against a live DB.
//
// Marker test runs always; DB-guarded tests skip cleanly when neither
// TEST_MYSQL_URL nor TEST_MSSQL_URL is set.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVerifyMarker } from '../../src/init/verify-marker.js';
import { splitSqlStatements } from '../../src/init/schema-applier.js';
import { createMysqlDriver } from '../../src/db/drivers/mysql.js';
import { createMssqlDriver } from '../../src/db/drivers/mssql.js';
import { parseTestUrl } from '../integration/_url.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

const MYSQL = !!process.env.TEST_MYSQL_URL;
const MSSQL = !!process.env.TEST_MSSQL_URL;

test('migration 010 (mysql + mssql): declares "verify: table audit_logs" marker so bootstrapMigrations works', () => {
  const mysql = parseVerifyMarker(fs.readFileSync(join(REPO_ROOT, 'db/migrations/010-audit-logs-json.sql'), 'utf8'));
  const mssql = parseVerifyMarker(fs.readFileSync(join(REPO_ROOT, 'db/migrations/mssql/010-audit-logs-json.sql'), 'utf8'));
  assert.ok(Array.isArray(mysql) && mysql.length > 0, 'mysql 010 must declare a verify marker');
  assert.ok(Array.isArray(mssql) && mssql.length > 0, 'mssql 010 must declare a verify marker');
  assert.ok(mysql.some(m => m.kind === 'table' && m.name === 'audit_logs'),
    `mysql 010 markers must include table audit_logs; got ${JSON.stringify(mysql)}`);
  assert.ok(mssql.some(m => m.kind === 'table' && m.name === 'audit_logs'),
    `mssql 010 markers must include table audit_logs; got ${JSON.stringify(mssql)}`);
});

test('migration 010 (mysql): payload column DATA_TYPE becomes json after migration', { skip: !MYSQL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
  const db = createMysqlDriver({ host, port, user, password, database: 'addashboard' });
  try {
    const sql = fs.readFileSync(join(REPO_ROOT, 'db/migrations/010-audit-logs-json.sql'), 'utf8');
    for (const stmt of splitSqlStatements(sql)) {
      await db.execute(stmt, []);
    }

    const { rows } = await db.execute(
      `SELECT DATA_TYPE FROM information_schema.columns
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs' AND COLUMN_NAME = 'payload'`
    );
    assert.equal(rows[0]?.DATA_TYPE, 'json',
      `expected DATA_TYPE=json for audit_logs.payload, got ${rows[0]?.DATA_TYPE}`);

    // Insert one row with JSON.stringify payload, SELECT it back, assert parse equality
    const sample = { hello: 'world', n: 42, nested: { arr: [1, 2, 3] } };
    await db.execute(
      `INSERT INTO audit_logs (user_id, action, target, payload) VALUES (?, ?, ?, CAST(? AS JSON))`,
      [1, 'migration-010-test', 'tgt', JSON.stringify(sample)]
    );
    const { rows: back } = await db.execute(
      `SELECT payload FROM audit_logs WHERE action = ? ORDER BY id DESC LIMIT 1`,
      ['migration-010-test']
    );
    assert.equal(back.length, 1, 'expected inserted row to be SELECTable');
    // mysql2 may return JSON columns as already-parsed objects, or as raw strings
    const parsed = typeof back[0].payload === 'string' ? JSON.parse(back[0].payload) : back[0].payload;
    assert.deepEqual(parsed, sample);
  } finally {
    try { await db.execute(`DELETE FROM audit_logs WHERE action = ?`, ['migration-010-test']); } catch {}
    await db.close();
  }
});

test('migration 010 (mssql): payload column becomes NVARCHAR(MAX) + ISJSON CHECK exists', { skip: !MSSQL }, async () => {
  const { user, password, host, port } = parseTestUrl('TEST_MSSQL_URL', { defaultPort: 1433 });
  const db = createMssqlDriver({ server: host, port, database: 'addashboard', user, password });
  try {
    const sql = fs.readFileSync(join(REPO_ROOT, 'db/migrations/mssql/010-audit-logs-json.sql'), 'utf8');
    for (const stmt of splitSqlStatements(sql)) {
      await db.execute(stmt, []);
    }

    // sys.columns: max_length = -1 (NVARCHAR(MAX))
    const { rows: cols } = await db.execute(
      `SELECT max_length FROM sys.columns
       WHERE object_id = OBJECT_ID('audit_logs') AND name = 'payload'`
    );
    assert.equal(cols[0]?.max_length, -1,
      `expected max_length=-1 (NVARCHAR(MAX)) for audit_logs.payload, got ${cols[0]?.max_length}`);

    // sys.check_constraints: ck_audit_logs_payload_json
    const { rows: checks } = await db.execute(
      `SELECT name FROM sys.check_constraints WHERE name = 'ck_audit_logs_payload_json'`
    );
    assert.equal(checks.length, 1,
      `expected CHECK constraint ck_audit_logs_payload_json, found ${checks.length}`);
  } finally {
    await db.close();
  }
});

test('migration 011 (mysql + mssql): both indexes exist after run', { skip: !MYSQL && !MSSQL }, async () => {
  const sql = fs.readFileSync(
    MYSQL
      ? join(REPO_ROOT, 'db/migrations/011-audit-logs-indexes.sql')
      : join(REPO_ROOT, 'db/migrations/mssql/011-audit-logs-indexes.sql'),
    'utf8'
  );
  const INDEX_NAMES = ['ix_audit_action_time', 'ix_audit_user_time'];

  if (MYSQL) {
    const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
    const db = createMysqlDriver({ host, port, user, password, database: 'addashboard' });
    try {
      for (const stmt of splitSqlStatements(sql)) {
        await db.execute(stmt, []);
      }
      const placeholders = INDEX_NAMES.map(() => '?').join(',');
      const { rows } = await db.execute(
        `SELECT INDEX_NAME FROM information_schema.statistics
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs'
           AND INDEX_NAME IN (${placeholders})`,
        INDEX_NAMES
      );
      const found = new Set(rows.map(r => r.INDEX_NAME));
      for (const name of INDEX_NAMES) {
        assert.ok(found.has(name), `missing MySQL index: ${name}`);
      }
    } finally {
      await db.close();
    }
  } else {
    const { user, password, host, port } = parseTestUrl('TEST_MSSQL_URL', { defaultPort: 1433 });
    const db = createMssqlDriver({ server: host, port, database: 'addashboard', user, password });
    try {
      for (const stmt of splitSqlStatements(sql)) {
        await db.execute(stmt, []);
      }
      const { rows } = await db.execute(
        `SELECT name FROM sys.indexes
         WHERE object_id = OBJECT_ID('audit_logs') AND name IN ('ix_audit_action_time', 'ix_audit_user_time')`
      );
      const found = new Set(rows.map(r => r.name));
      for (const name of INDEX_NAMES) {
        assert.ok(found.has(name), `missing MSSQL index: ${name}`);
      }
    } finally {
      await db.close();
    }
  }
});

test('migration 010: rerun is a no-op (idempotent)', { skip: !MYSQL && !MSSQL }, async () => {
  if (MYSQL) {
    const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
    const db = createMysqlDriver({ host, port, user, password, database: 'addashboard' });
    try {
      const { rows: beforeRows } = await db.execute(`SELECT COUNT(*) AS n FROM audit_logs`);
      const before = Number(beforeRows[0].n);

      const sql = fs.readFileSync(join(REPO_ROOT, 'db/migrations/010-audit-logs-json.sql'), 'utf8');
      // Apply twice; second apply must NOT throw
      for (const stmt of splitSqlStatements(sql)) {
        await db.execute(stmt, []);
      }
      for (const stmt of splitSqlStatements(sql)) {
        await db.execute(stmt, []);
      }

      const { rows: afterRows } = await db.execute(`SELECT COUNT(*) AS n FROM audit_logs`);
      const after = Number(afterRows[0].n);
      assert.equal(after, before, `rerun must not change row count; before=${before} after=${after}`);
    } finally {
      await db.close();
    }
  } else {
    const { user, password, host, port } = parseTestUrl('TEST_MSSQL_URL', { defaultPort: 1433 });
    const db = createMssqlDriver({ server: host, port, database: 'addashboard', user, password });
    try {
      const { rows: beforeRows } = await db.execute(`SELECT COUNT_BIG(*) AS n FROM audit_logs`);
      const before = Number(beforeRows[0].n);

      const sql = fs.readFileSync(join(REPO_ROOT, 'db/migrations/mssql/010-audit-logs-json.sql'), 'utf8');
      // Apply twice; second apply must NOT throw
      for (const stmt of splitSqlStatements(sql)) {
        await db.execute(stmt, []);
      }
      for (const stmt of splitSqlStatements(sql)) {
        await db.execute(stmt, []);
      }

      const { rows: afterRows } = await db.execute(`SELECT COUNT_BIG(*) AS n FROM audit_logs`);
      const after = Number(afterRows[0].n);
      assert.equal(after, before, `rerun must not change row count; before=${before} after=${after}`);
    } finally {
      await db.close();
    }
  }
});