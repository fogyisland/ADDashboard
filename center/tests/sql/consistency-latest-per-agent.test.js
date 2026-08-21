// consistency-latest-per-agent.test.js — real-DB regression test for the
// MySQL 5.7 syntax of db.sql.consistency.latestPerAgent (Task 5).
//
// Background: production runs MySQL 5.7 (no window-function support). The
// query uses the (agent_id, ts) IN (subquery MAX(ts)) form which is portable
// to 5.7. This test pins both the parse-friendliness (mysql2 sends a prepare
// packet → MySQL 5.7 responds with ER_PARSE_ERROR on window functions) and
// the row shape (latest row per agent_id, by MAX(ts)). Skipped when
// TEST_MYSQL_URL is not set so the suite stays green on dev machines.
//
// Pair-tested with the service-level tests in tests/services/consistency.test.js
// which exercise the algorithm on a mocked row set.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { buildSql } from '../../src/db/sql.js';

function parseTestMysqlUrl(raw) {
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

test('db.sql.consistency.latestPerAgent is MySQL 5.7 portable (no window functions)', async (t) => {
  const url = process.env.TEST_MYSQL_URL;
  if (!url) return t.skip('TEST_MYSQL_URL not set');

  const { user, password, host, port } = parseTestMysqlUrl(url);
  const conn = await mysql.createConnection({ host, port, user, password, database: 'addashboard' });
  try {
    const sql = buildSql('mysql').consistency.latestPerAgent;
    // Belt-and-suspenders: confirm the chosen query does NOT contain 5.7-incompatible
    // window-function syntax. A future contributor who re-adds ROW_NUMBER() will
    // see this string assertion fail before the real-DB round trip even runs.
    assert.ok(!/ROW_NUMBER\s*\(/i.test(sql), 'must not use ROW_NUMBER()');
    assert.ok(!/\bOVER\s*\(/i.test(sql), 'must not use window functions');
    // The query should PREPARE + EXECUTE without syntax error.
    const [rows] = await conn.query(sql);
    assert.ok(Array.isArray(rows), 'rows must be an array');
  } finally {
    await conn.end();
  }
});

test('db.sql.consistency.latestPerAgent returns one row per agent_id (MAX ts)', async (t) => {
  const url = process.env.TEST_MYSQL_URL;
  if (!url) return t.skip('TEST_MYSQL_URL not set');

  const { user, password, host, port } = parseTestMysqlUrl(url);
  const conn = await mysql.createConnection({ host, port, user, password, database: 'addashboard' });
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `__t_consistency_${suffix}`;
  try {
    // Create the pkg_ad_domain_consistency.metrics table + seed 3 rows for
    // the same agent with distinct ts. The latest row is the one with the
    // highest ts; the query should return only that row for this agent_id.
    await conn.query(`CREATE TABLE IF NOT EXISTS \`pkg_ad_domain_consistency\`.\`metrics\` (
      agent_id    VARCHAR(64) NOT NULL,
      ts          DATETIME(3) NOT NULL,
      user_count  INT         NULL,
      user_hash   VARCHAR(64) NULL,
      group_count INT         NULL,
      group_hash  VARCHAR(64) NULL,
      gpo_count   INT         NULL,
      gpo_hash    VARCHAR(64) NULL,
      error_code  INT         NULL,
      PRIMARY KEY (agent_id, ts)
    )`);
    const hashOld = '0'.repeat(64);
    const hashNew = '1'.repeat(64);
    const hashMid = '2'.repeat(64);
    // Seed in non-chronological order — the query must still pick the
    // MAX(ts) row, which is hashNew.
    await conn.execute(
      `INSERT INTO \`pkg_ad_domain_consistency\`.\`metrics\`
         (agent_id, ts, user_count, user_hash, group_count, group_hash, gpo_count, gpo_hash, error_code)
       VALUES (?, ?, 100, ?, 50, ?, 10, ?, 0)`,
      [agentId, '2026-08-21 09:00:00.000', hashOld, hashOld, hashOld]
    );
    await conn.execute(
      `INSERT INTO \`pkg_ad_domain_consistency\`.\`metrics\`
         (agent_id, ts, user_count, user_hash, group_count, group_hash, gpo_count, gpo_hash, error_code)
       VALUES (?, ?, 100, ?, 50, ?, 10, ?, 0)`,
      [agentId, '2026-08-21 11:00:00.000', hashNew, hashNew, hashNew]
    );
    await conn.execute(
      `INSERT INTO \`pkg_ad_domain_consistency\`.\`metrics\`
         (agent_id, ts, user_count, user_hash, group_count, group_hash, gpo_count, gpo_hash, error_code)
       VALUES (?, ?, 100, ?, 50, ?, 10, ?, 0)`,
      [agentId, '2026-08-21 10:00:00.000', hashMid, hashMid, hashMid]
    );
    const sql = buildSql('mysql').consistency.latestPerAgent;
    const [rows] = await conn.query(`${sql} AND agent_id = ?`, [agentId]);
    assert.equal(rows.length, 1, 'exactly one row per agent_id');
    assert.equal(rows[0].agent_id, agentId);
    assert.equal(rows[0].user_hash, hashNew, 'returns the MAX(ts) row');
    assert.equal(rows[0].group_hash, hashNew);
    assert.equal(rows[0].gpo_hash, hashNew);
  } finally {
    await conn.execute('DELETE FROM `pkg_ad_domain_consistency`.`metrics` WHERE agent_id = ?', [agentId]).catch(() => {});
    await conn.end();
  }
});
