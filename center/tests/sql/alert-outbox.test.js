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
