// Real-DB regression coverage for the MySQL heartbeat-report SQL helpers.
// Live execution is gated by TEST_MYSQL_URL; dialect-portability assertions
// run on every developer machine even when no MySQL instance is configured.

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

function assertMysql57Portable(sql, name) {
  assert.ok(!/ROW_NUMBER\s*\(/i.test(sql), `${name} must not use ROW_NUMBER()`);
  assert.ok(!/\bOVER\s*\(/i.test(sql), `${name} must not use window functions`);
}

async function openTestConnection(t) {
  const url = process.env.TEST_MYSQL_URL;
  if (!url) {
    t.skip('TEST_MYSQL_URL not set');
    return null;
  }
  // 2026-08-26 hot-fix: pin mysql2 to UTC for DATETIME round-trip. The
  // production code stores UTC-naive strings via toMysqlDatetime() and
  // the SQL helpers compare against UTC_TIMESTAMP(). With the default
  // `timezone: 'local'` (CST = UTC+8), every JS Date read from a
  // DATETIME column is shifted -8h, which makes .getTime() comparisons
  // 8 hours off. Setting `timezone: 'Z'` (or `'+00:00'`) means the
  // stored string is parsed as if it were UTC, matching the storage
  // convention end-to-end.
  return mysql.createConnection({
    ...parseTestMysqlUrl(url),
    database: 'addashboard',
    timezone: 'Z'
  });
}

const sqlRegistry = buildSql('mysql').heartbeat;

for (const [name, sql] of [
  ['agentsList', sqlRegistry.agentsList],
  ['dcsList', sqlRegistry.dcsList],
  ['reportSummaryFor', sqlRegistry.reportSummaryFor('agent', '2026-08-07T00:00:00.000Z')],
  ['latestReportEntries', sqlRegistry.latestReportEntries('agent', '2026-08-07T00:00:00.000Z', 100)],
  // 2026-08-26 round-15: latest-failure-row lookup that the service uses
  // to populate reportSummary.latestErrorMessage / latestFailedLink when
  // the 1-hour window saw a failure. Must stay MySQL 5.7 portable (no
  // ROW_NUMBER / OVER).
  ['latestFailureFor', sqlRegistry.latestFailureFor('agent')]
]) {
  test(`db.sql.heartbeat.${name} stays MySQL 5.7 portable`, () => {
    assertMysql57Portable(sql, `heartbeat.${name}`);
  });
}

test('db.sql.heartbeat agentsList and dcsList parse and return seeded rows', async (t) => {
  const conn = await openTestConnection(t);
  if (!conn) return;

  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `__t_hb_agent_${suffix}`;
  const siteName = `__t_hb_site_${suffix}`;
  let siteId = null;
  try {
    await conn.execute(
      `INSERT INTO ad_sites (site_name, region_code, is_hub, description)
       VALUES (?, 'TST', 0, 'heartbeat-report SQL test')`,
      [siteName]
    );
    const [siteRows] = await conn.execute('SELECT site_id FROM ad_sites WHERE site_name = ?', [siteName]);
    siteId = siteRows[0].site_id;
    await conn.execute(
      `INSERT INTO ad_dcs (dc_name, site_id, ip_address, os_version, is_pdc)
       VALUES (?, ?, '192.0.2.10', 'Windows Test', 1)`,
      [agentId, siteId]
    );
    await conn.execute(
      `INSERT INTO ad_agent_heartbeat
         (agent_id, last_heartbeat_at, agent_version, last_report_at, last_report_status, pending_queue_size)
       VALUES (?, CURRENT_TIMESTAMP, 'test-version', CURRENT_TIMESTAMP, 'ok', 3)`,
      [agentId]
    );

    const [agentRows] = await conn.query(
      `SELECT * FROM (${sqlRegistry.agentsList}) AS agents WHERE agent_id = ?`,
      [agentId]
    );
    assert.equal(agentRows.length, 1);
    assert.equal(agentRows[0].agent_version, 'test-version');

    const [dcRows] = await conn.query(
      `SELECT * FROM (${sqlRegistry.dcsList}) AS dcs WHERE agent_id = ?`,
      [agentId]
    );
    assert.equal(dcRows.length, 1);
    assert.equal(dcRows[0].site_name, siteName);
    assert.equal(dcRows[0].region_code, 'TST');
    assert.equal(dcRows[0].ip_address, '192.0.2.10');
  } finally {
    await conn.execute('DELETE FROM ad_agent_heartbeat WHERE agent_id = ?', [agentId]).catch(() => {});
    await conn.execute('DELETE FROM ad_dcs WHERE dc_name = ?', [agentId]).catch(() => {});
    if (siteId !== null) {
      await conn.execute('DELETE FROM ad_sites WHERE site_id = ?', [siteId]).catch(() => {});
    }
    await conn.end();
  }
});

// 2026-08-24 round-11: the synthetic __healthcheck__ POST path was removed in
// round-9 but the historical rows from before that fix still sit in
// ad_agent_heartbeat. The agentsList / dcsList queries now filter
// `agent_id <> '__healthcheck__'` so the monitor UI stops showing a phantom
// offline agent row. This test seeds both a normal agent and the synthetic
// id, then asserts only the normal agent comes back.
test('db.sql.heartbeat agentsList / dcsList filter out __healthcheck__', async (t) => {
  const conn = await openTestConnection(t);
  if (!conn) return;

  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `__t_hb_real_${suffix}`;
  const siteName = `__t_hb_site_real_${suffix}`;
  let siteId = null;
  try {
    await conn.execute(
      `INSERT INTO ad_sites (site_name, region_code, is_hub, description)
       VALUES (?, 'TST', 0, 'round-11 __healthcheck__ filter test')`,
      [siteName]
    );
    const [siteRows] = await conn.execute('SELECT site_id FROM ad_sites WHERE site_name = ?', [siteName]);
    siteId = siteRows[0].site_id;
    await conn.execute(
      `INSERT INTO ad_dcs (dc_name, site_id, ip_address, os_version, is_pdc)
       VALUES (?, ?, '192.0.2.20', 'Windows Test', 0)`,
      [agentId, siteId]
    );
    // Seed BOTH rows in the same INSERT — one real agent + the synthetic id.
    await conn.execute(
      `INSERT INTO ad_agent_heartbeat
         (agent_id, last_heartbeat_at, agent_version, last_report_at, last_report_status, pending_queue_size)
       VALUES
         (?, CURRENT_TIMESTAMP, 'real-ver',  CURRENT_TIMESTAMP, 'ok', 1),
         ('__healthcheck__', CURRENT_TIMESTAMP, 'synthetic', NULL, NULL, 0)`,
      [agentId]
    );

    // agentsList must return the real agent and never the synthetic id.
    const [agentRows] = await conn.query(
      `SELECT agent_id FROM (${sqlRegistry.agentsList}) AS agents WHERE agent_id IN (?, '__healthcheck__')`,
      [agentId]
    );
    assert.equal(agentRows.length, 1, 'agentsList should hide __healthcheck__');
    assert.equal(agentRows[0].agent_id, agentId);

    // dcsList same guarantee.
    const [dcRows] = await conn.query(
      `SELECT agent_id FROM (${sqlRegistry.dcsList}) AS dcs WHERE agent_id IN (?, '__healthcheck__')`,
      [agentId]
    );
    assert.equal(dcRows.length, 1, 'dcsList should hide __healthcheck__');
    assert.equal(dcRows[0].agent_id, agentId);
  } finally {
    await conn.execute('DELETE FROM ad_agent_heartbeat WHERE agent_id IN (?, \'__healthcheck__\')', [agentId]).catch(() => {});
    await conn.execute('DELETE FROM ad_dcs WHERE dc_name = ?', [agentId]).catch(() => {});
    if (siteId !== null) {
      await conn.execute('DELETE FROM ad_sites WHERE site_id = ?', [siteId]).catch(() => {});
    }
    await conn.end();
  }
});

test('db.sql.heartbeat reportSummaryFor returns only MAX(collected_at) rows', async (t) => {
  const conn = await openTestConnection(t);
  if (!conn) return;

  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `__t_hb_summary_${suffix}`;
  const sourceDc = `__t_hb_src_${suffix}`;
  const oldAt = new Date('2026-08-07T09:00:00Z');
  const latestAt = new Date('2026-08-07T10:00:00Z');
  try {
    await conn.execute(
      `INSERT INTO ad_replication_status
         (collected_at, agent_id, source_dc, dest_dc, source_site, dest_site, naming_context,
          last_success_time, last_attempt_time, status_code, error_message)
       VALUES
         (?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, 0, NULL),
         (?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, 0, NULL),
         (?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, 2, 'latest failure')`,
      [
        oldAt, agentId, sourceDc, `__t_hb_old_${suffix}`, `old-${suffix}`,
        latestAt, agentId, sourceDc, `__t_hb_ok_${suffix}`, `ok-${suffix}`,
        latestAt, agentId, sourceDc, `__t_hb_fail_${suffix}`, `fail-${suffix}`
      ]
    );

    const sql = sqlRegistry.reportSummaryFor(agentId, '2026-08-07T00:00:00.000Z');
    const [rows] = await conn.query(sql, [agentId, new Date('2026-08-07T00:00:00Z'), agentId]);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.status_code).sort(), [0, 2]);
    assert.ok(rows.every((row) => new Date(row.collected_at).getTime() === latestAt.getTime()));
  } finally {
    await conn.execute('DELETE FROM ad_replication_status WHERE agent_id = ?', [agentId]).catch(() => {});
    await conn.end();
  }
});

// 2026-08-24 round-12 — requestReport UPSERT helper
// Inserts a row if missing (agent's first heartbeat hasn't landed yet) or
// updates `report_requested_at` if the row exists. The plan guarantees
// `agentsList` / `dcsList` SELECT expose the new column so callers can
// detect "already pending" without a separate read.
test('db.sql.heartbeat.requestReport sets the column on existing row', async (t) => {
  const conn = await openTestConnection(t);
  if (!conn) return;

  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `__t_hb_req_${suffix}`;
  try {
    // Seed an agent row WITHOUT report_requested_at populated (NULL default).
    await conn.execute(
      `INSERT INTO ad_agent_heartbeat
         (agent_id, last_heartbeat_at, agent_version, last_report_at,
          last_report_status, pending_queue_size)
       VALUES (?, CURRENT_TIMESTAMP, 'v', NULL, NULL, 0)`,
      [agentId]
    );

    const ts = '2026-08-24T10:00:00.000Z';
    const sql = sqlRegistry.requestReport(agentId, ts);
    await conn.query(sql, [agentId, new Date(ts)]);

    const [rows] = await conn.execute(
      'SELECT report_requested_at FROM ad_agent_heartbeat WHERE agent_id = ?',
      [agentId]
    );
    assert.equal(rows.length, 1);
    assert.ok(rows[0].report_requested_at instanceof Date);
    assert.equal(rows[0].report_requested_at.toISOString(), ts);
  } finally {
    await conn.execute('DELETE FROM ad_agent_heartbeat WHERE agent_id = ?', [agentId]).catch(() => {});
    await conn.end();
  }
});

// 2026-08-24 round-12 — COALESCE preserves the column when the heartbeat
// caller (agent.js round-12 T6) hasn't yet been taught to forward the new
// field. Pre-T6 callers will pass `null` for `report_requested_at`; the
// MySQL COALESCE / MSSQL ISNULL guard must NOT clear an existing value.
test('db.sql.heartbeat.upsert preserves report_requested_at when param is null', async (t) => {
  const conn = await openTestConnection(t);
  if (!conn) return;

  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `__t_hb_preserve_${suffix}`;
  const originalTs = new Date('2026-08-24T10:00:00Z');
  try {
    await conn.execute(
      `INSERT INTO ad_agent_heartbeat
         (agent_id, last_heartbeat_at, agent_version, last_report_at,
          last_report_status, pending_queue_size, report_requested_at)
       VALUES (?, CURRENT_TIMESTAMP, 'v', NULL, NULL, 0, ?)`,
      [agentId, originalTs]
    );

    // Drive the upsert with `null` for the new column; COALESCE keeps the
    // original value.
    const upsertSql = sqlRegistry.upsert;
    const params = [
      agentId,           // agent_id
      'v2',              // agent_version
      null,              // last_report_at
      null,              // last_report_status
      0,                 // pending_queue_size
      // 2026-08-26: agent_token_version is NOT NULL on the schema; pass 0
      // (matches what round-12 agents bind on first heartbeat). The test
      // previously bound `null`, which MySQL rejected with
      // "Column 'agent_token_version' cannot be null".
      0,                 // agent_token_version
      null               // report_requested_at (NULL = preserve)
    ];
    await conn.query(upsertSql, params);

    const [rows] = await conn.execute(
      'SELECT report_requested_at FROM ad_agent_heartbeat WHERE agent_id = ?',
      [agentId]
    );
    assert.equal(rows.length, 1);
    assert.ok(rows[0].report_requested_at instanceof Date);
    assert.equal(rows[0].report_requested_at.toISOString(), originalTs.toISOString());
  } finally {
    await conn.execute('DELETE FROM ad_agent_heartbeat WHERE agent_id = ?', [agentId]).catch(() => {});
    await conn.end();
  }
});

test('db.sql.heartbeat latestReportEntries returns only the latest snapshot and caps it at 100', async (t) => {
  const conn = await openTestConnection(t);
  if (!conn) return;

  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `__t_hb_detail_${suffix}`;
  const sourceDc = `__t_hb_src_${suffix}`;
  const oldAt = new Date('2026-08-07T10:00:00Z');
  const latestAt = new Date('2026-08-07T11:00:00Z');
  try {
    const values = [];
    const placeholders = [];
    for (let i = 0; i < 105; i++) {
      placeholders.push('(?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, 0, NULL)');
      values.push(
        latestAt,
        agentId,
        sourceDc,
        `__t_hb_latest_${suffix}_${String(i).padStart(3, '0')}`,
        `latest-${suffix}-${i}`
      );
    }
    for (let i = 0; i < 101; i++) {
      placeholders.push('(?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, 0, NULL)');
      values.push(
        oldAt,
        agentId,
        sourceDc,
        `__t_hb_old_${suffix}_${String(i).padStart(3, '0')}`,
        `old-${suffix}-${i}`
      );
    }
    await conn.execute(
      `INSERT INTO ad_replication_status
         (collected_at, agent_id, source_dc, dest_dc, source_site, dest_site, naming_context,
          last_success_time, last_attempt_time, status_code, error_message)
       VALUES ${placeholders.join(', ')}`,
      values
    );

    const since = new Date('2026-08-07T00:00:00Z');
    const params = [agentId, agentId, since];
    assert.equal(params.length, 3);
    const sql = sqlRegistry.latestReportEntries(agentId, since.toISOString(), 100);
    const [rows] = await conn.query(sql, params);
    assert.equal(rows.length, 100);
    assert.ok(rows.every((row) => row.collected_at instanceof Date));
    assert.ok(rows.every((row) => row.collected_at.getTime() === latestAt.getTime()));
    assert.ok(rows.every((row) => row.dest_dc.includes(`__t_hb_latest_${suffix}_`)));
    assert.deepEqual(
      rows.map((row) => row.dest_dc),
      [...rows].map((row) => row.dest_dc).sort()
    );
  } finally {
    await conn.execute('DELETE FROM ad_replication_status WHERE agent_id = ?', [agentId]).catch(() => {});
    await conn.end();
  }
});

// 2026-08-24 round-12 T-fix — direct UPDATE … SET … = NULL. The heartbeat
// UPSERT's COALESCE / ISNULL guard preserves the column when the agent
// binds `null`, so the T7 ack-loop needs a dedicated helper that
// bypasses the guard and writes NULL. Without this, the column never
// clears and the agent keeps running _tick() every 5s.
test('db.sql.heartbeat.clearReportRequest sets the column to NULL on existing row', async (t) => {
  const conn = await openTestConnection(t);
  if (!conn) return;

  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `__t_hb_clear_${suffix}`;
  try {
    // Seed with a non-null report_requested_at — simulates a pending
    // "report now" request set by the admin route.
    await conn.execute(
      `INSERT INTO ad_agent_heartbeat
         (agent_id, last_heartbeat_at, agent_version, last_report_at,
          last_report_status, pending_queue_size, report_requested_at)
       VALUES (?, CURRENT_TIMESTAMP, 'v', NULL, NULL, 0, ?)`,
      [agentId, new Date('2026-08-24T10:00:00Z')]
    );

    // Run clearReportRequest — the helper must actually wipe the column.
    const sql = sqlRegistry.clearReportRequest(agentId);
    await conn.execute(sql, [agentId]);

    const [rows] = await conn.execute(
      'SELECT report_requested_at FROM ad_agent_heartbeat WHERE agent_id = ?',
      [agentId]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].report_requested_at, null);
  } finally {
    await conn.execute('DELETE FROM ad_agent_heartbeat WHERE agent_id = ?', [agentId]).catch(() => {});
    await conn.end();
  }
});

// 2026-08-26 round-15 — 1-hour threshold rule for the operator dashboard:
//   any data in the past 1 hour        → last_report_status = 'success' / 'partial_failure'
//   data exists but oldest > 1 hour    → last_report_status = 'stale'  (NOT null, NOT '未上传')
//   agent has NEVER produced a row      → last_report_status IS NULL
//
// The rule must hold across both the all-history MAX (used for the
// timestamp display) and the 1-hour-window counts (used for the summary).
// We seed three agents and assert all three branches come back with the
// expected status + counts in one round-trip via agentsList.
test('db.sql.heartbeat.agentsList 1-hour threshold rule (success / stale / never)', async (t) => {
  const conn = await openTestConnection(t);
  if (!conn) return;

  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const recentAgent = `__t_hb_recent_${suffix}`;
  const staleAgent  = `__t_hb_stale_${suffix}`;
  const neverAgent  = `__t_hb_never_${suffix}`;
  // 2026-08-26 round-15: floor to seconds so the DATETIME round-trip
  // matches exactly (mysql2 strips sub-second precision on DATETIME columns).
  // 2026-08-26 hot-fix: SQL uses UTC_TIMESTAMP() to match the production
  // storage convention (toMysqlDatetime writes UTC components). mysql2
  // default-bound JS Dates get converted to session-timezone strings —
  // that breaks the comparison. Bind the timestamps as pre-formatted
  // UTC-naive strings (`YYYY-MM-DD HH:MM:SS` derived from the JS Date's
  // UTC components) so the stored value matches what production writes.
  const fmtUtc = (d) => {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
           `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  };
  const withinHour  = new Date(Math.floor((Date.now() - 5 * 60 * 1000) / 1000) * 1000);
  const olderThanHr = new Date(Math.floor((Date.now() - 2 * 60 * 60 * 1000) / 1000) * 1000);
  const withinHourUtc  = fmtUtc(withinHour);
  const olderThanHrUtc = fmtUtc(olderThanHr);
  try {
    // Seed heartbeat rows for all three agents so the outer query joins.
    await conn.query(
      `INSERT INTO ad_agent_heartbeat (agent_id, last_heartbeat_at, pending_queue_size)
       VALUES (?, CURRENT_TIMESTAMP, 0), (?, CURRENT_TIMESTAMP, 0), (?, CURRENT_TIMESTAMP, 0)`,
      [recentAgent, staleAgent, neverAgent]
    );
    // Seed replication rows for recent (status_code=0 → success) and
    // stale (one success outside the 1-hour window so it shouldn't
    // contribute to the window counts).
    await conn.query(
      `INSERT INTO ad_replication_status
         (collected_at, agent_id, source_dc, dest_dc, naming_context,
          last_success_time, last_attempt_time, status_code, error_message)
       VALUES
         (?, ?, ?, ?, 'CN=Config', NULL, NULL, 0, NULL),
         (?, ?, ?, ?, 'CN=Config', NULL, NULL, 0, NULL)`,
      [withinHourUtc, recentAgent, recentAgent, '__dc_summary__',
       olderThanHrUtc, staleAgent,  staleAgent,  '__dc_summary__']
    );

    // Run the new agentsList SQL and pull the three rows back.
    const [rows] = await conn.query(
      `SELECT agent_id, last_report_at, last_report_status,
              success_count, fail_count, total_count
       FROM (${sqlRegistry.agentsList}) AS agents
       WHERE agent_id IN (?, ?, ?)`,
      [recentAgent, staleAgent, neverAgent]
    );
    const byId = Object.fromEntries(rows.map(r => [r.agent_id, r]));
    // 2026-08-26 round-15: mysql2 returns SUM()/COUNT() as JS strings by
    // default (no number coercion), matching what the service sees — so
    // we coerce in the assertion. The service's `Number(row.x) || 0`
    // pattern would silently turn the test green even if SQL returned
    // garbage; the explicit cast keeps the test honest.
    const num = (v) => Number(v);
    assert.equal(byId[recentAgent].last_report_status, 'success',
      'recent agent (within 1h, no failures) → success');
    assert.equal(num(byId[recentAgent].success_count), 1);
    assert.equal(num(byId[recentAgent].fail_count), 0);
    assert.equal(num(byId[recentAgent].total_count), 1);
    assert.ok(byId[recentAgent].last_report_at instanceof Date,
      'recent agent last_report_at derived from MAX(collected_at)');

    assert.equal(byId[staleAgent].last_report_status, 'stale',
      'stale agent (data exists but >1h ago) → stale, NOT null, NOT 未上传');
    assert.equal(num(byId[staleAgent].success_count), 0,
      'stale agent has zero rows in 1-hour window');
    assert.equal(num(byId[staleAgent].fail_count), 0);
    assert.equal(num(byId[staleAgent].total_count), 0);
    assert.ok(byId[staleAgent].last_report_at instanceof Date,
      'stale agent last_report_at is the historical timestamp, NOT null');

    assert.equal(byId[neverAgent].last_report_status, null,
      'never-uploaded agent → null status (UI shows ⏸ 未上传)');
    assert.equal(byId[neverAgent].last_report_at, null,
      'never-uploaded agent → null timestamp');
    assert.equal(num(byId[neverAgent].success_count), 0);
    assert.equal(num(byId[neverAgent].fail_count), 0);
    assert.equal(num(byId[neverAgent].total_count), 0);
  } finally {
    await conn.execute('DELETE FROM ad_replication_status WHERE agent_id IN (?, ?, ?)', [recentAgent, staleAgent, neverAgent]).catch(() => {});
    await conn.execute('DELETE FROM ad_agent_heartbeat WHERE agent_id IN (?, ?, ?)', [recentAgent, staleAgent, neverAgent]).catch(() => {});
    await conn.end();
  }
});

// 2026-08-26 round-15 — latestFailureFor returns the most recent failing
// row inside the 1-hour window. Critical for the dashboard's "错误摘要"
// column when an agent has a mix of success/fail.
test('db.sql.heartbeat.latestFailureFor returns the most recent failing row in the 1h window', async (t) => {
  const conn = await openTestConnection(t);
  if (!conn) return;

  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const agentId = `__t_hb_lf_${suffix}`;
  // 2026-08-26 round-15: floor to seconds so DATETIME round-trip is exact.
  // 2026-08-26 hot-fix: SQL uses UTC_TIMESTAMP(); bind as pre-formatted
  // UTC strings (production writes via toMysqlDatetime).
  const fmtUtc = (d) => {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
           `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  };
  const recentFail = new Date(Math.floor((Date.now() - 3 * 60 * 1000) / 1000) * 1000);  // 3 min ago — in window
  const oldFail    = new Date(Math.floor((Date.now() - 90 * 60 * 1000) / 1000) * 1000); // 90 min ago — out of window
  try {
    await conn.query(
      `INSERT INTO ad_replication_status
         (collected_at, agent_id, source_dc, dest_dc, naming_context,
          last_success_time, last_attempt_time, status_code, error_message)
       VALUES
         (?, ?, ?, ?, 'CN=Config', NULL, NULL, 2, 'old timeout'),
         (?, ?, ?, ?, 'CN=Config', NULL, NULL, 2, 'recent partial')`,
      [fmtUtc(oldFail), agentId, agentId, 'old-dest',
       fmtUtc(recentFail), agentId, agentId, 'recent-dest']
    );
    const sql = sqlRegistry.latestFailureFor(agentId);
    const [rows] = await conn.execute(sql, [agentId]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].dest_dc, 'recent-dest', 'must be the in-window failure, not the stale one');
    assert.equal(rows[0].error_message, 'recent partial');
    assert.ok(rows[0].collected_at instanceof Date);
    // 2026-08-26 hot-fix: compare via UTC-naive string format instead of
    // getTime(). mysql2 with default `timezone: 'local'` reads a DATETIME
    // column as if the stored string were local time, then converts to
    // UTC for the JS Date — so getTime() returns the stored value minus
    // the session offset (8h on the dev box). The DATETIME column has no
    // timezone, but mysql2 gives it one on read. The string form is the
    // unambiguous representation that matches the insert side. Reuse the
    // outer fmtUtc from line 517 — a re-declaration inside `try` would
    // shadow it for the entire block and put the line-532 reference in TDZ.
    assert.equal(fmtUtc(rows[0].collected_at), fmtUtc(recentFail));
  } finally {
    await conn.execute('DELETE FROM ad_replication_status WHERE agent_id = ?', [agentId]).catch(() => {});
    await conn.end();
  }
});
