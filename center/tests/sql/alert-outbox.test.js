// alert-outbox.test.js — covers the alertOutbox SQL helper module
// (alert_email_outbox). The delivery loop scans pending rows by
// (sent_at IS NULL AND next_attempt_at <= NOW()), picks the rows it can
// send right now, and updates attempt counters / sent_at as it goes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertOutbox } from '../../src/db/sql/alert-outbox.js';

test('alertOutbox: enqueue (MySQL) has 7 placeholders (alert_event_id, to, cc, subject, text, html, next_attempt_at)', () => {
  assert.match(alertOutbox.mysql.enqueue, /INSERT INTO alert_email_outbox/i);
  assert.strictEqual((alertOutbox.mysql.enqueue.match(/\?/g) || []).length, 7);
});

test('alertOutbox: listPending (MySQL) scans sent_at IS NULL and next_attempt_at <= NOW(), ordered by next_attempt_at ASC,id ASC with LIMIT ?', () => {
  assert.match(alertOutbox.mysql.listPending, /WHERE sent_at IS NULL/i);
  assert.match(alertOutbox.mysql.listPending, /next_attempt_at <= NOW\(\)/i);
  assert.match(alertOutbox.mysql.listPending, /ORDER BY next_attempt_at ASC, id ASC/);
  assert.match(alertOutbox.mysql.listPending, /LIMIT \?/);
});

test('alertOutbox: markSent (MySQL) sets sent_at=NOW(), bumps attempt_count, clears last_error', () => {
  assert.match(alertOutbox.mysql.markSent, /SET sent_at = NOW\(\)/i);
  assert.match(alertOutbox.mysql.markSent, /attempt_count = attempt_count \+ 1/);
  assert.match(alertOutbox.mysql.markSent, /last_error = NULL/);
});

test('alertOutbox: markFailed (MySQL) bumps attempt_count, sets last_error, schedules next_attempt_at via DATE_ADD', () => {
  assert.match(alertOutbox.mysql.markFailed, /attempt_count = attempt_count \+ 1/);
  assert.match(alertOutbox.mysql.markFailed, /last_error = \?/);
  assert.match(alertOutbox.mysql.markFailed, /DATE_ADD\(NOW\(\), INTERVAL \? MINUTE\)/);
  // 3 placeholders: last_error, minutes, id
  assert.strictEqual((alertOutbox.mysql.markFailed.match(/\?/g) || []).length, 3);
});

test('alertOutbox: deleteByEvent uses alert_event_id (the log key, not the outbox id)', () => {
  assert.match(alertOutbox.mysql.deleteByEvent, /DELETE FROM alert_email_outbox WHERE alert_event_id = \?/i);
  assert.match(alertOutbox.mssql.deleteByEvent, /DELETE FROM alert_email_outbox WHERE alert_event_id = \?/i);
});

test('alertOutbox: listPending (MSSQL) is a function that interpolates the integer limit', () => {
  // MSSQL TOP cannot be parameterized; the helper is a function so callers
  // pass the safe-integer limit and we sanitize with Number().
  assert.equal(typeof alertOutbox.mssql.listPending, 'function');
  const sql = alertOutbox.mssql.listPending(100);
  assert.match(sql, /SELECT TOP 100/);
  assert.match(sql, /sent_at IS NULL/i);
  assert.match(sql, /next_attempt_at <= SYSUTCDATETIME\(\)/);
});

test('alertOutbox: markFailed (MSSQL) uses DATEADD(MINUTE, ?, SYSUTCDATETIME())', () => {
  assert.match(alertOutbox.mssql.markFailed, /attempt_count = attempt_count \+ 1/);
  assert.match(alertOutbox.mssql.markFailed, /DATEADD\(MINUTE, \?, SYSUTCDATETIME\(\)\)/);
  assert.strictEqual((alertOutbox.mssql.markFailed.match(/\?/g) || []).length, 3);
});

test('alertOutbox: markSent (MSSQL) uses SYSUTCDATETIME() for sent_at', () => {
  assert.match(alertOutbox.mssql.markSent, /SET sent_at = SYSUTCDATETIME\(\)/i);
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

const AO_MYSQL = !!process.env.TEST_MYSQL_URL;
const AO_MSSQL = !!process.env.TEST_MSSQL_URL;
const AO_PREFIX = 'ao-rt-' + Date.now().toString(36) + '-';

test('alertOutbox (mysql): enqueue -> findById -> listPending -> markFailed -> markSent -> deleteByEvent round-trip',
  { skip: !AO_MYSQL }, async () => {
    const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
    const db = createMysqlDriver({ host, port, user, password, database: 'addashboard' });
    const m = alertOutbox.mysql;
    const hostname = AO_PREFIX + 'host';
    // alert_email_outbox.alert_event_id FK -> alert_events.id, so we need
    // a real alert_events row. alert_events.rule_id has NO FK; alert_events
    // has no FK to anything either, so we can insert with any rule_id.
    let eventId = null;
    try {
      const fileSql = fs.readFileSync(join(REPO_ROOT, 'db/migrations/014-member-servers.sql'), 'utf8');
      for (const stmt of splitSqlStatements(fileSql)) {
        await db.execute(stmt, []);
      }

      // Pre-seed: ad_member_servers (FK chain via alert_rules... but alert_events
      // has no FK, so this is unnecessary for the outbox test). Insert the event
      // directly:
      const ruleId = 999999 + Math.floor(Math.random() * 1000);
      let r = await db.execute(
        `INSERT INTO alert_events (rule_id, hostname, event, detail) VALUES (?, ?, 'fired', 'outbox-rt event')`,
        [ruleId, hostname]
      );
      eventId = r.insertId;
      assert.ok(eventId != null);

      // ENQUEUE outbox row — 7 params: alert_event_id, to, cc, subject, text, html, next_attempt_at
      r = await db.execute(m.enqueue, [
        eventId,
        'ops@example.com',
        'oncall@example.com',
        'ALERT: cpu high',
        'plain text body',
        '<p>html body</p>',
        new Date() // immediately due
      ]);
      assert.ok(r.insertId != null, 'enqueue should yield insertId');
      const outId = r.insertId;

      // findById
      const found = await db.query(m.findById, [outId]);
      assert.strictEqual(found.rows.length, 1);
      assert.strictEqual(found.rows[0].alert_event_id, eventId);
      assert.strictEqual(found.rows[0].subject, 'ALERT: cpu high');
      assert.strictEqual(Number(found.rows[0].attempt_count), 0);
      assert.strictEqual(found.rows[0].sent_at, null);

      // listPending: should include our row (sent_at IS NULL, next_attempt_at <= NOW())
      const pending = await db.query(m.listPending, [100]);
      assert.ok(pending.rows.some(rw => rw.id === outId),
        'listPending must include our pending outbox row');

      // markFailed: attempt_count -> 1, last_error set, next_attempt_at pushed 5 min out
      r = await db.execute(m.markFailed, [outId, 'SMTP connection refused', 5]);
      assert.strictEqual(r.affectedRows, 1);
      const afterFail = await db.query(m.findById, [outId]);
      assert.strictEqual(Number(afterFail.rows[0].attempt_count), 1);
      assert.strictEqual(afterFail.rows[0].last_error, 'SMTP connection refused');
      assert.ok(afterFail.rows[0].next_attempt_at, 'next_attempt_at should be populated');

      // markSent: stamps sent_at, attempt_count += 1, last_error cleared
      r = await db.execute(m.markSent, [outId]);
      assert.strictEqual(r.affectedRows, 1);
      const afterSent = await db.query(m.findById, [outId]);
      assert.ok(afterSent.rows[0].sent_at, 'sent_at should be populated');
      assert.strictEqual(Number(afterSent.rows[0].attempt_count), 2);
      assert.strictEqual(afterSent.rows[0].last_error, null);

      // deleteByEvent
      r = await db.execute(m.deleteByEvent, [eventId]);
      assert.ok(r.affectedRows >= 1);
      const gone = await db.query(m.findById, [outId]);
      assert.strictEqual(gone.rows.length, 0);
    } finally {
      try { await db.execute('DELETE FROM alert_email_outbox WHERE alert_event_id = ?', [eventId]); } catch {}
      try { await db.execute('DELETE FROM alert_events WHERE hostname = ?', [hostname]); } catch {}
      await db.close();
    }
  });

test('alertOutbox (mssql): enqueue -> findById -> listPending -> markFailed -> markSent -> deleteByEvent round-trip',
  { skip: !AO_MSSQL }, async () => {
    const { user, password, host, port } = parseTestUrl('TEST_MSSQL_URL', { defaultPort: 1433 });
    const db = createMssqlDriver({ server: host, port, database: 'addashboard', user, password });
    const m = alertOutbox.mssql;
    const hostname = AO_PREFIX + 'host-mssql';
    let eventId = null;
    try {
      const fileSql = fs.readFileSync(join(REPO_ROOT, 'db/migrations/mssql/014-member-servers.sql'), 'utf8');
      for (const stmt of splitSqlStatements(fileSql)) {
        await db.execute(stmt, []);
      }

      const ruleId = 999999 + Math.floor(Math.random() * 1000);
      // The mssql driver wrapper auto-appends SELECT CAST(SCOPE_IDENTITY()...)
      // for INSERTs, so we just pass a plain INSERT.
      let r = await db.execute(
        `INSERT INTO alert_events (rule_id, hostname, event, detail) VALUES (?, ?, 'fired', 'outbox-rt mssql event')`,
        [ruleId, hostname]
      );
      eventId = r.insertId;
      assert.ok(eventId != null);

      // ENQUEUE — 7 params
      r = await db.execute(m.enqueue, [
        eventId,
        'ops@example.com',
        'oncall@example.com',
        'ALERT: cpu high',
        'plain text body',
        '<p>html body</p>',
        new Date()
      ]);
      assert.ok(r.insertId != null, 'enqueue should yield insertId (SCOPE_IDENTITY)');
      const outId = r.insertId;

      // findById
      const found = await db.query(m.findById, [outId]);
      assert.strictEqual(found.rows.length, 1);
      assert.strictEqual(found.rows[0].alert_event_id, eventId);
      assert.strictEqual(found.rows[0].subject, 'ALERT: cpu high');
      assert.strictEqual(Number(found.rows[0].attempt_count), 0);
      assert.strictEqual(found.rows[0].sent_at, null);

      // listPending (function form for MSSQL)
      const pending = await db.query(m.listPending(100));
      assert.ok(pending.rows.some(rw => rw.id === outId),
        'listPending must include our pending outbox row');

      // markFailed
      r = await db.execute(m.markFailed, [outId, 'SMTP connection refused', 5]);
      assert.strictEqual(r.affectedRows, 1);
      const afterFail = await db.query(m.findById, [outId]);
      assert.strictEqual(Number(afterFail.rows[0].attempt_count), 1);
      assert.strictEqual(afterFail.rows[0].last_error, 'SMTP connection refused');
      assert.ok(afterFail.rows[0].next_attempt_at);

      // markSent
      r = await db.execute(m.markSent, [outId]);
      assert.strictEqual(r.affectedRows, 1);
      const afterSent = await db.query(m.findById, [outId]);
      assert.ok(afterSent.rows[0].sent_at, 'sent_at should be populated');
      assert.strictEqual(Number(afterSent.rows[0].attempt_count), 2);
      assert.strictEqual(afterSent.rows[0].last_error, null);

      // deleteByEvent
      r = await db.execute(m.deleteByEvent, [eventId]);
      assert.ok(r.affectedRows >= 1);
      const gone = await db.query(m.findById, [outId]);
      assert.strictEqual(gone.rows.length, 0);
    } finally {
      try { await db.execute('DELETE FROM alert_email_outbox WHERE alert_event_id = ?', [eventId]); } catch {}
      try { await db.execute('DELETE FROM alert_events WHERE hostname = ?', [hostname]); } catch {}
      await db.close();
    }
  });
