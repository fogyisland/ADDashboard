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
  return mysql.createConnection({
    ...parseTestMysqlUrl(url),
    database: 'addashboard'
  });
}

const sqlRegistry = buildSql('mysql').heartbeat;

for (const [name, sql] of [
  ['agentsList', sqlRegistry.agentsList],
  ['dcsList', sqlRegistry.dcsList],
  ['reportSummaryFor', sqlRegistry.reportSummaryFor('agent', '2026-08-07T00:00:00.000Z')],
  ['latestReportEntries', sqlRegistry.latestReportEntries('agent', '2026-08-07T00:00:00.000Z', 100)]
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
      null,              // agent_token_version
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
