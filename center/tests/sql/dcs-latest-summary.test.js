// dcs-latest-summary.test.js — real-DB regression test for the MySQL 5.7 syntax
// of db.sql.replication.latestSummaryPerDc.
//
// Background: production ran MySQL 5.7 (no window-function support). The original
// query used ROW_NUMBER() OVER (PARTITION BY ...) which parses fine on MySQL 8
// and MSSQL 2017+ but is a syntax error on MySQL 5.7. The /api/dcs/summary route
// caught the parse error and returned 500 with no diagnostic. This test runs the
// actual SQL string from the registry against a real MySQL 5.7 DB so that any
// future reintroduction of window-function syntax (or other 5.7-incompatible
// SQL) fails the suite loud.
//
// Skipped when TEST_MYSQL_URL is not set so the suite stays green on
// developer machines without a live MySQL.

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

test('db.sql.replication.latestSummaryPerDc parses on MySQL 5.7 (no window functions)', async (t) => {
  const url = process.env.TEST_MYSQL_URL;
  if (!url) return t.skip('TEST_MYSQL_URL not set');

  const { user, password, host, port } = parseTestMysqlUrl(url);
  const conn = await mysql.createConnection({ host, port, user, password, database: 'addashboard' });
  try {
    const sql = buildSql('mysql').replication.latestSummaryPerDc;

    // Assert: query PREPARES without syntax error. mysql2 sends a prepare
    // packet on first query; MySQL responds with a parse error if the
    // statement is invalid. A 5.7-incompatible construct (e.g. window
    // functions) triggers ER_PARSE_ERROR before any row is materialized.
    const [rows] = await conn.query(sql);
    assert.ok(Array.isArray(rows), 'rows must be an array');

    // Belt-and-suspenders: confirm the chosen query does NOT contain the
    // 5.7-incompatible ROW_NUMBER() construct. Future contributors who
    // re-add window functions will see this string assertion fail before
    // they even get to the live DB.
    assert.ok(!/ROW_NUMBER\s*\(/i.test(sql),
      'mysql latestSummaryPerDc must NOT use ROW_NUMBER() — incompatible with MySQL 5.7');
  } finally {
    await conn.end();
  }
});

test('db.sql.replication.latestSummaryPerDc returns summary rows without parse error (semantics)', async (t) => {
  const url = process.env.TEST_MYSQL_URL;
  if (!url) return t.skip('TEST_MYSQL_URL not set');

  const { user, password, host, port } = parseTestMysqlUrl(url);
  const conn = await mysql.createConnection({ host, port, user, password, database: 'addashboard' });
  try {
    const sql = buildSql('mysql').replication.latestSummaryPerDc;

    // Insert one sentinel summary row, verify the query selects it back.
    // Schema enforces UNIQUE (source_dc, dest_dc, naming_context) so for
    // any single DC there is at most one summary row at any time — the
    // "latest per group" semantics collapses to "the one row that exists".
    const sentinelDc = `__t_dcssum_${Date.now()}__`;
    await conn.execute(
      `INSERT INTO ad_replication_status
         (collected_at, agent_id, source_dc, dest_dc, source_site, dest_site, naming_context,
          last_success_time, last_attempt_time, status_code, error_message,
          users_count, groups_count, gpos_count, locked_count)
       VALUES (?, ?, ?, ?, NULL, NULL, '__dc_summary__', NULL, NULL, 0, NULL, ?, ?, ?, ?)`,
      [new Date('2026-08-07T11:00:00Z'), 'agent_test_summary', sentinelDc, '__self_summary__', 200, 40, 6, 3]
    );

    // Wrap the SQL in a subquery so we can filter by source_dc safely
    // without touching the production query's ORDER BY position. The
    // route's contract is "all summary rows, latest per DC" — this test
    // verifies that, then narrows to the sentinel row.
    const [rows] = await conn.query(
      `SELECT * FROM (${sql}) AS s WHERE source_dc = ?`,
      [sentinelDc]
    );
    assert.equal(rows.length, 1, `expected 1 summary row for sentinel DC; got ${rows.length}`);
    assert.equal(rows[0].users_count, 200);
  } finally {
    await conn.execute(
      `DELETE FROM ad_replication_status WHERE agent_id = 'agent_test_summary'`
    ).catch(() => {});
    await conn.end();
  }
});
