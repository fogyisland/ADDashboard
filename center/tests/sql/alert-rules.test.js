// alert-rules.test.js — covers the alertRules SQL helper module
// (alert_rules + alert_rule_state).
//
// `condition` is a reserved word in both dialects: MySQL needs
// backtick-escaping in identifier position; MSSQL needs bracket-escaping.
// The MySQL `findById` should select the backtick-quoted `condition`
// column.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertRules } from '../../src/db/sql/alert-rules.js';

// ---- alert_rules ----

test('alertRules: insert (MySQL) uses backtick-escaped `condition` identifier', () => {
  assert.match(alertRules.mysql.create, /INSERT INTO alert_rules/i);
  assert.match(alertRules.mysql.create, /`condition`/);
  assert.strictEqual((alertRules.mysql.create.match(/\?/g) || []).length, 7);
  assert.match(alertRules.mysql.findById, /`condition`/);
  assert.match(alertRules.mysql.list, /ORDER BY hostname, name/i);
  assert.match(alertRules.mysql.listEnabled, /WHERE enabled = 1/i);
  assert.match(alertRules.mysql.listAllEnabled, /ORDER BY hostname, rule_id/i);
  assert.match(alertRules.mysql.update, /`condition`/);
  assert.match(alertRules.mysql.delete, /DELETE FROM alert_rules WHERE rule_id = \?/i);
});

test('alertRules: insert (MSSQL) uses bracketed [condition] identifier', () => {
  assert.match(alertRules.mssql.create, /INSERT INTO alert_rules/i);
  assert.match(alertRules.mssql.create, /\[condition\]/);
  assert.strictEqual((alertRules.mssql.create.match(/\?/g) || []).length, 7);
  assert.match(alertRules.mssql.findById, /\[condition\]/);
  assert.match(alertRules.mssql.update, /\[condition\]/);
});

// ---- alert_rule_state ----

test('alertRules: upsertState (MySQL) ON DUPLICATE KEY UPDATE; sets last_evaluated_at=NOW()', () => {
  assert.match(alertRules.mysql.upsertState, /INSERT INTO alert_rule_state/i);
  assert.match(alertRules.mysql.upsertState, /ON DUPLICATE KEY UPDATE/i);
  // 7 params: rule_id, state, first_hit_at, last_evaluated_at (literal NOW in
  // MySQL), last_fired_at, last_recovered_at, suppressed_until — but in MySQL
  // we count only the placeholders, not the NOW() literal.
  const placeholderCount = (alertRules.mysql.upsertState.match(/\?/g) || []).length;
  assert.strictEqual(placeholderCount, 6);
  assert.match(alertRules.mysql.upsertState, /last_evaluated_at = NOW\(\)/);
  assert.match(alertRules.mysql.getState, /FROM alert_rule_state WHERE rule_id = \?/i);
  assert.match(alertRules.mysql.listStatesForEval, /INNER JOIN alert_rules r/i);
  assert.match(alertRules.mysql.listStatesForEval, /WHERE r\.enabled = 1/);
  assert.match(alertRules.mysql.touchEvaluated, /SET last_evaluated_at = NOW\(\)/i);
});

test('alertRules: upsertState (MSSQL) MERGE keyed on rule_id', () => {
  assert.match(alertRules.mssql.upsertState, /MERGE INTO alert_rule_state/i);
  assert.match(alertRules.mssql.upsertState, /ON t\.rule_id = s\.rule_id/i);
  assert.match(alertRules.mssql.upsertState, /WHEN NOT MATCHED THEN INSERT/i);
  assert.match(alertRules.mssql.upsertState, /SYSUTCDATETIME\(\)/);
  assert.match(alertRules.mssql.touchEvaluated, /SET last_evaluated_at = SYSUTCDATETIME\(\)/i);
});

test('alertRules: listStatesForEval inner-joins alert_rules to filter by enabled=1 (MySQL)', () => {
  // The query must INNER JOIN so disabled rules never appear in eval state.
  assert.match(alertRules.mysql.listStatesForEval, /INNER JOIN alert_rules r/i);
  // Both `condition` (backticks) AND recipients + for_minutes + cooldown_minutes
  // (the columns the eval loop needs) must be selected.
  assert.match(alertRules.mysql.listStatesForEval, /`condition`/);
  assert.match(alertRules.mysql.listStatesForEval, /r\.hostname/);
  assert.match(alertRules.mysql.listStatesForEval, /r\.recipients/);
  assert.match(alertRules.mysql.listStatesForEval, /r\.for_minutes/);
  assert.match(alertRules.mysql.listStatesForEval, /r\.cooldown_minutes/);
});
