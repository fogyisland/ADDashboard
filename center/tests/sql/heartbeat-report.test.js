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
