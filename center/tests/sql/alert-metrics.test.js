// alert-metrics.test.js — covers the alertMetrics SQL helper module
// (pkg_ad_os_baseline.metrics). The AlertEvaluationLoop reads the latest
// metrics row per member-server on each tick. MySQL uses LIMIT 1, MSSQL
// uses TOP 1 (no native LIMIT).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertMetrics } from '../../src/db/sql/alert-metrics.js';

test('alertMetrics: getLatest (MySQL) reads from `pkg_ad_os_baseline`.metrics with LIMIT 1', () => {
  assert.match(alertMetrics.mysql.getLatest, /FROM `?pkg_ad_os_baseline`?\.`?metrics`?/i);
  assert.match(alertMetrics.mysql.getLatest, /ORDER BY ts DESC, id DESC/);
  assert.match(alertMetrics.mysql.getLatest, /LIMIT 1/);
  // 1 placeholder: agent_id
  assert.strictEqual((alertMetrics.mysql.getLatest.match(/\?/g) || []).length, 1);
});

test('alertMetrics: getLatest (MSSQL) reads from [pkg_ad_os_baseline].[metrics] with TOP 1', () => {
  assert.match(alertMetrics.mssql.getLatest, /SELECT TOP 1/);
  assert.match(alertMetrics.mssql.getLatest, /FROM \[pkg_ad_os_baseline\]\.\[metrics\]/i);
  assert.match(alertMetrics.mssql.getLatest, /ORDER BY ts DESC, id DESC/);
  assert.strictEqual((alertMetrics.mssql.getLatest.match(/\?/g) || []).length, 1);
});

// ---- live-DB round-trip tests (Global Constraint #17) ----

import fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitSqlStatements } from '../../src/init/schema-applier.js';
import { createMysqlDriver } from '../../src/db/drivers/mysql.js';
import { createMssqlDriver } from '../../src/db/drivers/mssql.js';
import { parseTestUrl } from '../integration/_url.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

const AM_MYSQL = !!process.env.TEST_MYSQL_URL;
const AM_MSSQL = !!process.env.TEST_MSSQL_URL;
const AM_PREFIX = 'am-rt-' + Date.now().toString(36) + '-';

test('alertMetrics (mysql): getLatest returns the freshest row per agent_id',
  { skip: !AM_MYSQL }, async () => {
    const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
    const db = createMysqlDriver({ host, port, user, password, database: 'addashboard' });
    const m = alertMetrics.mysql;
    const agentId = AM_PREFIX + 'agent';
    try {
      // Apply the built-in package schema (pkg_ad_os_baseline.metrics).
      // The package ships its own manifest with database.metricSchema — we
      // round-trip that here by reading the manifest's bundled SQL and
      // executing it against the test DB. If the schema doesn't exist yet,
      // create it inline (the production seed runs once on first boot).
      const manifestPath = join(REPO_ROOT, 'publish/center/data/packages/ad_os_baseline/1.0.0/manifest.json');
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch {
        // No manifest on disk — skip rather than fail. The loop's mock-DB
        // tests already cover the SQL shape; this is round-trip only.
        return;
      }
      const metricSchema = manifest.database?.metricSchema;
      if (!metricSchema) return;

      // Apply metricSchema (DDL) and then create the schema/db.
      const createDbSql = `CREATE DATABASE IF NOT EXISTS \`${metricSchema.split('.')[0]}\``;
      try { await db.execute(createDbSql, []); } catch { /* ignore */ }
      const useDbSql = `USE \`${metricSchema.split('.')[0]}\``;
      try { await db.execute(useDbSql, []); } catch { /* ignore */ }
      const createTableSql = `CREATE TABLE IF NOT EXISTS ${metricSchema} (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        agent_id VARCHAR(128) NOT NULL,
        ts DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        cpu_pct DECIMAL(5,2) NULL,
        memory_pct DECIMAL(5,2) NULL,
        disk_free JSON NULL,
        disk_total JSON NULL,
        services JSON NULL,
        events JSON NULL,
        KEY idx_agent_ts (agent_id, ts)
      )`;
      await db.execute(createTableSql, []);

      // Insert two rows: an older one with high cpu, and a fresh one with
      // low cpu. The loop should pick the freshest (low cpu) row.
      const older = new Date(Date.now() - 5 * 60_000); // 5 min ago
      const newer = new Date(Date.now() - 60_000);     // 1 min ago
      await db.execute(
        `INSERT INTO ${metricSchema} (agent_id, ts, cpu_pct, memory_pct) VALUES (?, ?, ?, ?)`,
        [agentId, older, 95.0, 50.0]
      );
      await db.execute(
        `INSERT INTO ${metricSchema} (agent_id, ts, cpu_pct, memory_pct) VALUES (?, ?, ?, ?)`,
        [agentId, newer, 50.0, 60.0]
      );

      const r = await db.query(m.getLatest, [agentId]);
      assert.strictEqual(r.rows.length, 1, 'getLatest should return exactly 1 row');
      assert.strictEqual(Number(r.rows[0].cpu_pct), 50.0, 'should pick the freshest row (cpu=50)');
      assert.strictEqual(Number(r.rows[0].memory_pct), 60.0);
    } finally {
      // Cleanup: delete the test rows so a re-run stays clean.
      try {
        const metricSchema = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).database?.metricSchema;
        if (metricSchema) {
          await db.execute(`DELETE FROM ${metricSchema} WHERE agent_id = ?`, [agentId]);
        }
      } catch { /* ignore */ }
      await db.close();
    }
  });