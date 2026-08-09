// alert-events.test.js — covers the alertEvents SQL helper module.
//
// alert_events is the firing log. INSERT and SELECT only — updates would
// defeat the purpose of keeping a history.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertEvents } from '../../src/db/sql/alert-events.js';

test('alertEvents: insert (MySQL) has 4 placeholders (rule_id, hostname, event, detail)', () => {
  assert.match(alertEvents.mysql.insert, /INSERT INTO alert_events/i);
  assert.strictEqual((alertEvents.mysql.insert.match(/\?/g) || []).length, 4);
  assert.match(alertEvents.mysql.findById, /WHERE id = \?/i);
  assert.match(alertEvents.mysql.listByRule, /WHERE rule_id = \?/i);
  assert.match(alertEvents.mysql.listByRule, /ORDER BY created_at DESC, id DESC/i);
  assert.match(alertEvents.mysql.listByHostname, /WHERE hostname = \?/i);
  assert.match(alertEvents.mysql.listByHostname, /ORDER BY created_at DESC, id DESC/i);
  assert.match(alertEvents.mysql.deleteByRule, /DELETE FROM alert_events WHERE rule_id = \?/i);
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

const AE_MYSQL = !!process.env.TEST_MYSQL_URL;
const AE_MSSQL = !!process.env.TEST_MSSQL_URL;
const AE_PREFIX = 'ae-rt-' + Date.now().toString(36) + '-';

test('alertEvents (mysql): insert -> findById -> listByRule -> listByHostname -> listRecent -> deleteByRule round-trip',
  { skip: !AE_MYSQL }, async () => {
    const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
    const db = createMysqlDriver({ host, port, user, password, database: 'addashboard' });
    const m = alertEvents.mysql;
    const hostname = AE_PREFIX + 'host';
    let ruleId = null;
    try {
      const fileSql = fs.readFileSync(join(REPO_ROOT, 'db/migrations/014-member-servers.sql'), 'utf8');
      for (const stmt of splitSqlStatements(fileSql)) {
        await db.execute(stmt, []);
      }

      // Pre-seed: ad_member_servers (FK from alert_rules → FK from alert_events.rule_id
      // is a plain INT, but the events table needs the rule_id to be valid; if we
      // want to test FK enforcement, we need a real rule). Here we skip the rule
      // and just reference rule_id by raw insert; MySQL FKs reference
      // alert_rules.rule_id but for THIS test we can bypass by inserting directly
      // (the alert_events table has no FK declared in migration 014; alert_rules
      // has FK to ad_member_servers but alert_events only has rule_id as plain INT).
      // Re-check: looking at the migration, alert_events has NO FK — just rule_id INT NOT NULL.
      // So we can insert directly with any rule_id.
      ruleId = 999999 + Math.floor(Math.random() * 1000);

      // INSERT event 1
      let r = await db.execute(m.insert, [ruleId, hostname, 'fired', 'cpu > 90 for 5m']);
      assert.ok(r.insertId != null, 'insert should yield insertId');
      const eid1 = r.insertId;

      // INSERT event 2 (same rule, different event type)
      r = await db.execute(m.insert, [ruleId, hostname, 'recovered', 'cpu < 50 for 1m']);
      assert.ok(r.insertId != null);
      const eid2 = r.insertId;

      // findById
      const found1 = await db.query(m.findById, [eid1]);
      assert.strictEqual(found1.rows.length, 1);
      assert.strictEqual(found1.rows[0].event, 'fired');
      assert.strictEqual(found1.rows[0].hostname, hostname);
      assert.strictEqual(found1.rows[0].detail, 'cpu > 90 for 5m');

      // listByRule
      const byRule = await db.query(m.listByRule, [ruleId]);
      assert.ok(byRule.rows.length >= 2, `listByRule should return our 2 events, got ${byRule.rows.length}`);

      // listByHostname
      const byHost = await db.query(m.listByHostname, [hostname]);
      assert.ok(byHost.rows.length >= 2, `listByHostname should return our 2 events, got ${byHost.rows.length}`);

      // listRecent with LIMIT
      const recent = await db.query(m.listRecent, [10]);
      assert.ok(Array.isArray(recent.rows), 'listRecent should return an array of rows');
      // Filter for our events
      const ourRecent = recent.rows.filter(rw => rw.hostname === hostname);
      assert.ok(ourRecent.length >= 2, `listRecent should include our events, got ${ourRecent.length}`);

      // deleteByRule
      r = await db.execute(m.deleteByRule, [ruleId]);
      assert.ok(r.affectedRows >= 2, 'deleteByRule should remove our 2 events');

      // Confirm gone
      const afterDelete = await db.query(m.listByRule, [ruleId]);
      assert.strictEqual(afterDelete.rows.length, 0);
    } finally {
      try { await db.execute('DELETE FROM alert_events WHERE hostname = ?', [hostname]); } catch {}
      if (ruleId != null) {
        try { await db.execute('DELETE FROM alert_events WHERE rule_id = ?', [ruleId]); } catch {}
      }
      await db.close();
    }
  });

test('alertEvents (mssql): insert -> findById -> listByRule -> listByHostname -> listRecent -> deleteByRule round-trip',
  { skip: !AE_MSSQL }, async () => {
    const { user, password, host, port } = parseTestUrl('TEST_MSSQL_URL', { defaultPort: 1433 });
    const db = createMssqlDriver({ server: host, port, database: 'addashboard', user, password });
    const m = alertEvents.mssql;
    const hostname = AE_PREFIX + 'host-mssql';
    let ruleId = null;
    try {
      const fileSql = fs.readFileSync(join(REPO_ROOT, 'db/migrations/mssql/014-member-servers.sql'), 'utf8');
      for (const stmt of splitSqlStatements(fileSql)) {
        await db.execute(stmt, []);
      }

      // alert_events has no FK on rule_id in MSSQL either (plain INT NOT NULL).
      ruleId = 999999 + Math.floor(Math.random() * 1000);

      // INSERT event 1
      let r = await db.execute(m.insert, [ruleId, hostname, 'fired', 'cpu > 90 for 5m']);
      assert.ok(r.insertId != null, 'insert should yield insertId (SCOPE_IDENTITY)');
      const eid1 = r.insertId;

      // INSERT event 2
      r = await db.execute(m.insert, [ruleId, hostname, 'recovered', 'cpu < 50 for 1m']);
      assert.ok(r.insertId != null);
      const eid2 = r.insertId;

      // findById
      const found1 = await db.query(m.findById, [eid1]);
      assert.strictEqual(found1.rows.length, 1);
      assert.strictEqual(found1.rows[0].event, 'fired');
      assert.strictEqual(found1.rows[0].hostname, hostname);
      assert.strictEqual(found1.rows[0].detail, 'cpu > 90 for 5m');

      // listByRule
      const byRule = await db.query(m.listByRule, [ruleId]);
      assert.ok(byRule.rows.length >= 2);

      // listByHostname
      const byHost = await db.query(m.listByHostname, [hostname]);
      assert.ok(byHost.rows.length >= 2);

      // listRecent (function form for MSSQL: TOP n)
      const recent = await db.query(m.listRecent(10));
      assert.ok(Array.isArray(recent.rows));
      const ourRecent = recent.rows.filter(rw => rw.hostname === hostname);
      assert.ok(ourRecent.length >= 2, `listRecent should include our events, got ${ourRecent.length}`);

      // deleteByRule
      r = await db.execute(m.deleteByRule, [ruleId]);
      assert.ok(r.affectedRows >= 2);
      const afterDelete = await db.query(m.listByRule, [ruleId]);
      assert.strictEqual(afterDelete.rows.length, 0);
    } finally {
      try { await db.execute('DELETE FROM alert_events WHERE hostname = ?', [hostname]); } catch {}
      if (ruleId != null) {
        try { await db.execute('DELETE FROM alert_events WHERE rule_id = ?', [ruleId]); } catch {}
      }
      await db.close();
    }
  });

test('alertEvents: listRecent (MySQL) caps with LIMIT ? — caller passes limit', () => {
  assert.match(alertEvents.mysql.listRecent, /ORDER BY created_at DESC, id DESC/);
  assert.match(alertEvents.mysql.listRecent, /LIMIT \?/);
});

test('alertEvents: insert (MSSQL) has 4 placeholders + SCOPE_IDENTITY for the inserted id', () => {
  assert.match(alertEvents.mssql.insert, /INSERT INTO alert_events/i);
  assert.match(alertEvents.mssql.insert, /SELECT SCOPE_IDENTITY\(\) AS id/);
  assert.strictEqual((alertEvents.mssql.insert.match(/\?/g) || []).length, 4);
});

test('alertEvents: listRecent (MSSQL) is a function that interpolates the integer limit', () => {
  // The MSSQL block uses TOP n where n is interpolated (MSSQL doesn't
  // accept TOP @p). assert it is a function that returns a safe string.
  assert.equal(typeof alertEvents.mssql.listRecent, 'function');
  const sql = alertEvents.mssql.listRecent(50);
  assert.match(sql, /SELECT TOP 50/);
  assert.match(sql, /FROM alert_events/);
  assert.match(sql, /ORDER BY created_at DESC, id DESC/);
});
