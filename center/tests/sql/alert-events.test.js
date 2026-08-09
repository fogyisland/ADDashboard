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
