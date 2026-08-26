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

test('alertRules: upsertState (MySQL) ON DUPLICATE KEY UPDATE; sets last_evaluated_at=UTC_TIMESTAMP()', () => {
  assert.match(alertRules.mysql.upsertState, /INSERT INTO alert_rule_state/i);
  assert.match(alertRules.mysql.upsertState, /ON DUPLICATE KEY UPDATE/i);
  // 6 placeholders + 2 literal UTC_TIMESTAMP() calls (first_hit_at in
  // VALUES, last_evaluated_at in ON DUPLICATE KEY UPDATE); placeholder count
  // is the only assertion that distinguishes MySQL from MSSQL shape.
  const placeholderCount = (alertRules.mysql.upsertState.match(/\?/g) || []).length;
  assert.strictEqual(placeholderCount, 6);
  assert.match(alertRules.mysql.upsertState, /last_evaluated_at = UTC_TIMESTAMP\(\)/);
  assert.match(alertRules.mysql.getState, /FROM alert_rule_state WHERE rule_id = \?/i);
  assert.match(alertRules.mysql.listStatesForEval, /INNER JOIN alert_rules r/i);
  assert.match(alertRules.mysql.listStatesForEval, /WHERE r\.enabled = 1/);
  assert.match(alertRules.mysql.touchEvaluated, /SET last_evaluated_at = UTC_TIMESTAMP\(\)/i);
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

test('alertRules: listEnabledForHostWithState (MySQL) is a SELECT with LEFT JOIN and 1 placeholder', () => {
  const sql = alertRules.mysql.listEnabledForHostWithState;
  assert.match(sql, /SELECT/i);
  assert.match(sql, /LEFT JOIN alert_rule_state/i);
  assert.equal((sql.match(/\?/g) || []).length, 1);
  assert.ok(!/MERGE/i.test(sql), 'mysql variant must not use MERGE');
});

test('alertRules: listEnabledForHostWithState (MSSQL) is a SELECT with LEFT JOIN and 1 placeholder', () => {
  const sql = alertRules.mssql.listEnabledForHostWithState;
  assert.match(sql, /SELECT/i);
  assert.match(sql, /LEFT JOIN alert_rule_state/i);
  assert.equal((sql.match(/\?/g) || []).length, 1);
  assert.ok(/\[condition\]/.test(sql), 'mssql variant must bracket-quote reserved word condition');
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

const AR_MYSQL = !!process.env.TEST_MYSQL_URL;
const AR_MSSQL = !!process.env.TEST_MSSQL_URL;
const AR_PREFIX = 'ar-rt-' + Date.now().toString(36) + '-';

test('alertRules (mysql): create -> findById -> list -> update -> upsertState -> listStatesForEval -> delete round-trip',
  { skip: !AR_MYSQL }, async () => {
    const { user, password, host, port } = parseTestUrl('TEST_MYSQL_URL', { defaultPort: 3306 });
    const db = createMysqlDriver({ host, port, user, password, database: 'addashboard' });
    const m = alertRules.mysql;
    const hostname = AR_PREFIX + 'host';
    let ruleId = null;
    try {
      const fileSql = fs.readFileSync(join(REPO_ROOT, 'db/migrations/014-member-servers.sql'), 'utf8');
      for (const stmt of splitSqlStatements(fileSql)) {
        await db.execute(stmt, []);
      }

      // FK: alert_rules.hostname -> ad_member_servers.hostname
      await db.execute(
        `INSERT INTO ad_member_servers (hostname, agent_type, discovered_via) VALUES (?, 'non-ad', 'self-register')
         ON DUPLICATE KEY UPDATE updated_at = NOW()`,
        [hostname]
      );

      // CREATE rule
      let r = await db.execute(m.create, [
        hostname,
        'cpu-high',
        '{"metric":"cpu","gt":90}',
        5,
        30,
        'ops@example.com',
        1
      ]);
      assert.ok(r.insertId != null, 'create should yield insertId');
      ruleId = r.insertId;

      // findById
      const found = await db.query(m.findById, [ruleId]);
      assert.strictEqual(found.rows.length, 1);
      assert.strictEqual(found.rows[0].name, 'cpu-high');
      assert.strictEqual(found.rows[0].hostname, hostname);
      assert.strictEqual(Number(found.rows[0].for_minutes), 5);
      assert.strictEqual(Number(found.rows[0].enabled), 1);

      // list / listForHost / listEnabled
      const list = await db.query(m.list);
      assert.ok(list.rows.some(rw => rw.rule_id === ruleId));
      const forHost = await db.query(m.listForHost, [hostname]);
      assert.ok(forHost.rows.some(rw => rw.rule_id === ruleId));
      const enabled = await db.query(m.listEnabled);
      assert.ok(enabled.rows.some(rw => rw.rule_id === ruleId));
      const allEnabled = await db.query(m.listAllEnabled);
      assert.ok(allEnabled.rows.some(rw => rw.rule_id === ruleId));

      // UPDATE: change for_minutes + recipients
      r = await db.execute(m.update, ['cpu-high', '{"metric":"cpu","gt":95}', 10, 60, 'ops@example.com,oncall@example.com', 1, ruleId]);
      assert.strictEqual(r.affectedRows, 1);
      const afterUpdate = await db.query(m.findById, [ruleId]);
      assert.strictEqual(Number(afterUpdate.rows[0].for_minutes), 10);
      assert.strictEqual(Number(afterUpdate.rows[0].cooldown_minutes), 60);
      assert.strictEqual(afterUpdate.rows[0].recipients, 'ops@example.com,oncall@example.com');

      // upsertState (insert branch: rule_id has no state yet)
      r = await db.execute(m.upsertState, [ruleId, 'normal', null, null, null, null]);
      assert.strictEqual(r.affectedRows, 1);
      const state1 = await db.query(m.getState, [ruleId]);
      assert.strictEqual(state1.rows.length, 1);
      assert.strictEqual(state1.rows[0].state, 'normal');
      assert.ok(state1.rows[0].last_evaluated_at, 'last_evaluated_at should be set by NOW()');

      // upsertState (update branch: state -> pending, first_hit_at set)
      r = await db.execute(m.upsertState, [ruleId, 'pending', new Date(), null, null, null]);
      assert.strictEqual(r.affectedRows, 2, 'ON DUPLICATE: 1 update + 1 found');
      const state2 = await db.query(m.getState, [ruleId]);
      assert.strictEqual(state2.rows[0].state, 'pending');
      assert.ok(state2.rows[0].first_hit_at, 'first_hit_at should be populated after update');

      // listStatesForEval: INNER JOIN alert_rules to filter enabled=1
      const evalRows = await db.query(m.listStatesForEval);
      assert.ok(evalRows.rows.some(rw => rw.rule_id === ruleId),
        'listStatesForEval must include our enabled rule via INNER JOIN');

      // listEnabledForHostWithState: LEFT JOIN alert_rule_state
      const withState = await db.query(m.listEnabledForHostWithState, [hostname]);
      const ourRow = withState.rows.find(rw => rw.rule_id === ruleId);
      assert.ok(ourRow, 'listEnabledForHostWithState must return our enabled rule');
      assert.strictEqual(ourRow.state, 'pending');
      assert.ok(ourRow.first_hit_at, 'state JOIN should populate first_hit_at');
      assert.strictEqual(ourRow.name, 'cpu-high');
      assert.strictEqual(Number(ourRow.for_minutes), 10); // matches the post-update value

      // touchEvaluated
      r = await db.execute(m.touchEvaluated, [ruleId]);
      assert.strictEqual(r.affectedRows, 1);
      // clearSuppression
      r = await db.execute(m.clearSuppression, [ruleId]);
      assert.strictEqual(r.affectedRows, 1);
      const cleared = await db.query(m.getState, [ruleId]);
      assert.strictEqual(cleared.rows[0].suppressed_until, null);

      // DELETE
      r = await db.execute(m.delete, [ruleId]);
      assert.strictEqual(r.affectedRows, 1);
      const gone = await db.query(m.findById, [ruleId]);
      assert.strictEqual(gone.rows.length, 0);
      // alert_rule_state cascades via FK ON DELETE CASCADE
      const stateGone = await db.query(m.getState, [ruleId]);
      assert.strictEqual(stateGone.rows.length, 0);
    } finally {
      try { await db.execute('DELETE FROM alert_rules WHERE hostname = ?', [hostname]); } catch {}
      try { await db.execute('DELETE FROM ad_member_servers WHERE hostname = ?', [hostname]); } catch {}
      await db.close();
    }
  });

test('alertRules (mssql): create -> findById -> list -> update -> upsertState -> listStatesForEval -> delete round-trip',
  { skip: !AR_MSSQL }, async () => {
    const { user, password, host, port } = parseTestUrl('TEST_MSSQL_URL', { defaultPort: 1433 });
    const db = createMssqlDriver({ server: host, port, database: 'addashboard', user, password });
    const m = alertRules.mssql;
    const hostname = AR_PREFIX + 'host-mssql';
    let ruleId = null;
    try {
      const fileSql = fs.readFileSync(join(REPO_ROOT, 'db/migrations/mssql/014-member-servers.sql'), 'utf8');
      for (const stmt of splitSqlStatements(fileSql)) {
        await db.execute(stmt, []);
      }

      // FK pre-seed
      await db.execute(
        `MERGE INTO ad_member_servers AS t USING (SELECT ? AS hostname) AS s ON t.hostname = s.hostname
         WHEN NOT MATCHED THEN INSERT (hostname, agent_type, discovered_via) VALUES (s.hostname, 'non-ad', 'self-register');`,
        [hostname]
      );

      // CREATE rule
      let r = await db.execute(m.create, [
        hostname,
        'cpu-high',
        '{"metric":"cpu","gt":90}',
        5,
        30,
        'ops@example.com',
        1
      ]);
      assert.ok(r.insertId != null, 'create should yield insertId (SCOPE_IDENTITY)');
      ruleId = r.insertId;

      // findById
      const found = await db.query(m.findById, [ruleId]);
      assert.strictEqual(found.rows.length, 1);
      assert.strictEqual(found.rows[0].name, 'cpu-high');
      assert.strictEqual(found.rows[0].hostname, hostname);
      assert.strictEqual(Number(found.rows[0].for_minutes), 5);
      assert.strictEqual(Number(found.rows[0].enabled), 1);

      // list / listForHost / listEnabled
      const list = await db.query(m.list);
      assert.ok(list.rows.some(rw => rw.rule_id === ruleId));
      const forHost = await db.query(m.listForHost, [hostname]);
      assert.ok(forHost.rows.some(rw => rw.rule_id === ruleId));
      const enabled = await db.query(m.listEnabled);
      assert.ok(enabled.rows.some(rw => rw.rule_id === ruleId));
      const allEnabled = await db.query(m.listAllEnabled);
      assert.ok(allEnabled.rows.some(rw => rw.rule_id === ruleId));

      // UPDATE
      r = await db.execute(m.update, ['cpu-high', '{"metric":"cpu","gt":95}', 10, 60, 'ops@example.com,oncall@example.com', 1, ruleId]);
      assert.strictEqual(r.affectedRows, 1);
      const afterUpdate = await db.query(m.findById, [ruleId]);
      assert.strictEqual(Number(afterUpdate.rows[0].for_minutes), 10);
      assert.strictEqual(Number(afterUpdate.rows[0].cooldown_minutes), 60);

      // upsertState (insert)
      r = await db.execute(m.upsertState, [ruleId, 'normal', null, null, null, null]);
      assert.ok(r.affectedRows >= 1);
      const state1 = await db.query(m.getState, [ruleId]);
      assert.strictEqual(state1.rows.length, 1);
      assert.strictEqual(state1.rows[0].state, 'normal');
      assert.ok(state1.rows[0].last_evaluated_at, 'last_evaluated_at should be set by SYSUTCDATETIME()');

      // upsertState (update)
      r = await db.execute(m.upsertState, [ruleId, 'pending', new Date(), null, null, null]);
      assert.ok(r.affectedRows >= 1);
      const state2 = await db.query(m.getState, [ruleId]);
      assert.strictEqual(state2.rows[0].state, 'pending');
      assert.ok(state2.rows[0].first_hit_at);

      // listStatesForEval
      const evalRows = await db.query(m.listStatesForEval);
      assert.ok(evalRows.rows.some(rw => rw.rule_id === ruleId),
        'listStatesForEval must include our enabled rule via INNER JOIN');

      // listEnabledForHostWithState: LEFT JOIN alert_rule_state
      // Note: the bracket-quoting of [condition] is an identifier-escape only;
      // the driver returns the column under the plain name `condition`. These
      // assertions read non-reserved columns, so no bracket handling is needed.
      const withState = await db.query(m.listEnabledForHostWithState, [hostname]);
      const ourRow = withState.rows.find(rw => rw.rule_id === ruleId);
      assert.ok(ourRow, 'listEnabledForHostWithState must return our enabled rule');
      assert.strictEqual(ourRow.state, 'pending');
      assert.ok(ourRow.first_hit_at, 'state JOIN should populate first_hit_at');
      assert.strictEqual(ourRow.name, 'cpu-high');
      assert.strictEqual(Number(ourRow.for_minutes), 10); // matches the post-update value

      // touchEvaluated
      r = await db.execute(m.touchEvaluated, [ruleId]);
      assert.strictEqual(r.affectedRows, 1);
      // clearSuppression
      r = await db.execute(m.clearSuppression, [ruleId]);
      assert.strictEqual(r.affectedRows, 1);
      const cleared = await db.query(m.getState, [ruleId]);
      assert.strictEqual(cleared.rows[0].suppressed_until, null);

      // DELETE
      r = await db.execute(m.delete, [ruleId]);
      assert.strictEqual(r.affectedRows, 1);
      const gone = await db.query(m.findById, [ruleId]);
      assert.strictEqual(gone.rows.length, 0);
      // alert_rule_state cascades via FK ON DELETE CASCADE
      const stateGone = await db.query(m.getState, [ruleId]);
      assert.strictEqual(stateGone.rows.length, 0);
    } finally {
      try { await db.execute('DELETE FROM alert_rules WHERE hostname = ?', [hostname]); } catch {}
      try { await db.execute('DELETE FROM ad_member_servers WHERE hostname = ?', [hostname]); } catch {}
      await db.close();
    }
  });
