import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import supertest from 'supertest';
import { heartbeatReportRouter } from '../src/routes/heartbeat-report.js';
import { userAuth } from '../src/auth/user-auth.js';
import { requirePerm } from '../src/auth/rbac.js';
import { signJwt } from '../src/auth/jwt.js';
import { _setDbForTest } from '../src/db/index.js';
import { buildSql } from '../src/db/sql.js';
import { buildMockDb } from './helpers/db-mock.js';

const SECRET = 'test-secret';
function adminToken() { return signJwt({ sub: 'u1', role: 'admin', permissions: ['*'] }, SECRET, 60); }

function buildApp() {
  const a = express();
  a.use(express.json());
  return a.use(
    heartbeatReportRouter({
      requireAuth: userAuth({ db: { query: async (q) => /jwt_secret/i.test(q) ? { rows: [{ config_key: 'jwt_secret_current', config_value: SECRET }] } : { rows: [{ token_version: 0, status: 1 }] }, sql: buildSql('mysql') }, logger: null }),
      requirePerm
    })
  );
}

function fakeHeartbeatRow(overrides = {}) {
  return {
    agent_id: 'dc01',
    agent_version: '0.1.0',
    last_heartbeat_at: new Date('2026-08-07T15:30:00Z'),
    last_report_at: new Date('2026-08-07T15:00:00Z'),
    last_report_status: 'ok',
    pending_queue_size: 0,
    report_requested_at: null,
    ...overrides
  };
}

function fakeReplicationRow(overrides = {}) {
  return {
    source_dc: 'dc01',
    dest_dc: 'dc02',
    source_site: 'siteA',
    dest_site: 'siteB',
    naming_context: 'DC=contoso,DC=com',
    status_code: 0,
    error_message: null,
    last_success_time: new Date('2026-08-07T15:00:00Z'),
    last_attempt_time: new Date('2026-08-07T15:00:00Z'),
    collected_at: new Date('2026-08-07T15:00:00Z'),
    ...overrides
  };
}

// 2026-08-26 round-15: the agentsList / dcsList SQL now LEFT JOINs
// ad_replication_status subqueries to derive last_report_at,
// last_report_status, success_count / fail_count / total_count from the
// 1-hour window. The mock-DB regex must match the new SQL shape (which
// starts the same way but adds subqueries); the rows returned must carry
// the new aggregate fields so the service can populate reportSummary
// without a second DB roundtrip.
test('agents list: derives last_report_at and reportSummary from replication aggregation', async () => {
  const recent = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes ago — within 1h
  const db = buildMockDb([
    {
      match: /SELECT\s+h\.agent_id[\s\S]*?FROM\s+ad_agent_heartbeat\s+h[\s\S]*?ad_replication_status[\s\S]*?WHERE\s+h\.agent_id\s*<>\s*'__healthcheck__'/i,
      rows: [{
        agent_id: 'dc01',
        agent_version: '0.1.0',
        last_heartbeat_at: new Date('2026-08-07T15:30:00Z'),
        // round-15: last_report_at now comes from MAX(collected_at), not
        // the heartbeat self-declared column.
        last_report_at: recent,
        last_report_status: 'success',
        success_count: 1,
        fail_count: 1,
        total_count: 2,
        pending_queue_size: 0,
        report_requested_at: null
      }]
    },
    // When fail_count > 0 the service runs latestFailureFor to populate
    // latestErrorMessage / latestFailedLink. Mock it to return the
    // failure row that matches the agent's recent snapshot.
    {
      match: /FROM\s+ad_replication_status[\s\S]*?status_code\s*<>\s*0[\s\S]*?ORDER\s+BY\s+collected_at[\s\S]*?LIMIT\s+1|SELECT\s+TOP\s+1[\s\S]*?status_code\s*<>\s*0/is,
      rows: [fakeReplicationRow({ dest_dc: 'dc03', status_code: 1, error_message: '延迟高' })]
    },
    {
      match: /SELECT\s+config_key\s*,\s*config_value\s+FROM\s+system_config/i,
      rows: [{ config_key: 'heartbeat_stale_seconds', config_value: '15' }]
    }
  ]).standard();
  _setDbForTest(db);

  const res = await supertest(buildApp())
    .get('/api/admin/heartbeat-report/agents')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.agents.length, 1);
  assert.equal(res.body.agents[0].agentId, 'dc01');
  assert.equal(res.body.heartbeatStaleSeconds, 15);
  const summary = res.body.agents[0].reportSummary;
  assert.ok(summary, 'summary should be present');
  assert.equal(summary.totalLinks, 2);
  assert.equal(summary.successCount, 1);
  assert.equal(summary.failCount, 1);
  assert.equal(summary.latestErrorMessage, '延迟高');
  assert.equal(summary.latestFailedLink, 'dc01→dc03');
});

test('agents list: agent with no reports -> lastReportAt null, reportSummary null', async () => {
  const db = buildMockDb([
    {
      match: /SELECT\s+h\.agent_id[\s\S]*?FROM\s+ad_agent_heartbeat\s+h[\s\S]*?ad_replication_status[\s\S]*?WHERE\s+h\.agent_id\s*<>\s*'__healthcheck__'/i,
      rows: [{
        agent_id: 'dc-never',
        agent_version: '0.1.0',
        last_heartbeat_at: new Date('2026-08-07T15:30:00Z'),
        // round-15: NULL last_report_at signals "agent has NEVER produced
        // a replication row" — derived from the LEFT JOIN to rep.*  being
        // empty. Service must surface this as lastReportAt: null +
        // reportSummary: null so the UI renders ⏸ 未上传.
        last_report_at: null,
        last_report_status: null,
        success_count: 0,
        fail_count: 0,
        total_count: 0,
        pending_queue_size: 0,
        report_requested_at: null
      }]
    },
    // The latestFailureFor query must NOT fire when total_count is 0;
    // the service short-circuits before calling it.
    {
      match: /FROM\s+ad_replication_status[\s\S]*?status_code\s*<>\s*0[\s\S]*?ORDER\s+BY\s+collected_at[\s\S]*?LIMIT\s+1|SELECT\s+TOP\s+1[\s\S]*?status_code\s*<>\s*0/is,
      rows: []
    },
    {
      match: /SELECT\s+config_key\s*,\s*config_value\s+FROM\s+system_config/i,
      rows: [{ config_key: 'heartbeat_stale_seconds', config_value: '15' }]
    }
  ]).standard();
  _setDbForTest(db);

  const res = await supertest(buildApp())
    .get('/api/admin/heartbeat-report/agents')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.agents.length, 1);
  assert.equal(res.body.agents[0].agentId, 'dc-never');
  assert.equal(res.body.agents[0].lastReportAt, null);
  assert.equal(res.body.agents[0].reportSummary, null);
});

// 2026-08-26 round-18 follow-up: the agentsList SQL selects
// h.report_requested_at but the service must map it to JSON so the 回报
// button can flip to "已请求回报" / "回报(待清理)" after click. Before the
// fix, the field was undefined → the frontend always saw no pending
// request, so the badge never appeared and "未更新为最新时间" was reported.
test('agents list: reportRequestedAt is exposed (round-18 follow-up)', async () => {
  const requestedAt = new Date('2026-08-26T11:42:00Z');
  const db = buildMockDb([
    {
      match: /SELECT\s+h\.agent_id[\s\S]*?FROM\s+ad_agent_heartbeat\s+h[\s\S]*?ad_replication_status[\s\S]*?WHERE\s+h\.agent_id\s*<>\s*'__healthcheck__'/i,
      rows: [{
        agent_id: 'dc-pending',
        agent_version: '0.1.0',
        last_heartbeat_at: new Date('2026-08-26T11:42:00Z'),
        last_report_at: new Date('2026-08-26T11:41:00Z'),
        last_report_status: 'success',
        success_count: 1,
        fail_count: 0,
        total_count: 1,
        pending_queue_size: 0,
        report_requested_at: requestedAt
      }]
    },
    {
      match: /SELECT\s+config_key\s*,\s*config_value\s+FROM\s+system_config/i,
      rows: [{ config_key: 'heartbeat_stale_seconds', config_value: '15' }]
    }
  ]).standard();
  _setDbForTest(db);

  const res = await supertest(buildApp())
    .get('/api/admin/heartbeat-report/agents')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.agents.length, 1);
  assert.equal(res.body.agents[0].reportRequestedAt, '2026-08-26T11:42:00.000Z');
});

test('agents list: reportRequestedAt is null when no pending request', async () => {
  const db = buildMockDb([
    {
      match: /SELECT\s+h\.agent_id[\s\S]*?FROM\s+ad_agent_heartbeat\s+h[\s\S]*?ad_replication_status[\s\S]*?WHERE\s+h\.agent_id\s*<>\s*'__healthcheck__'/i,
      rows: [{
        agent_id: 'dc-idle',
        agent_version: '0.1.0',
        last_heartbeat_at: new Date('2026-08-26T11:42:00Z'),
        last_report_at: new Date('2026-08-26T11:41:00Z'),
        last_report_status: 'success',
        success_count: 1,
        fail_count: 0,
        total_count: 1,
        pending_queue_size: 0,
        report_requested_at: null
      }]
    },
    {
      match: /SELECT\s+config_key\s*,\s*config_value\s+FROM\s+system_config/i,
      rows: [{ config_key: 'heartbeat_stale_seconds', config_value: '15' }]
    }
  ]).standard();
  _setDbForTest(db);

  const res = await supertest(buildApp())
    .get('/api/admin/heartbeat-report/agents')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.agents[0].reportRequestedAt, null);
});

test('report-detail: returns entries for the most recent collected_at (capped at 100)', async () => {
  // The service fetches the most recent 100 entries via latestReportEntries;
  // we simulate the same set so the response shape can be verified end-to-end.
  const entries = [];
  for (let i = 0; i < 3; i++) {
    entries.push(fakeReplicationRow({ source_dc: `src${i}`, dest_dc: `dst${i}` }));
  }
  const queryParams = [];
  const db = buildMockDb([
    {
      match: /SELECT\s+collected_at\s*,\s*source_dc\s*,\s*dest_dc\s*,\s*source_site\s*,\s*dest_site\s*,\s*naming_context\s*,\s*status_code\s*,\s*error_message\s*,\s*last_success_time\s*,\s*last_attempt_time\s+FROM\s+ad_replication_status\s+WHERE\s+agent_id\s*=\s*\?\s+AND\s+collected_at\s*=\s*\(\s*SELECT\s+(?:MAX\s*\(\s*collected_at\s*\)|TOP\s+1\s+collected_at)\s+FROM\s+ad_replication_status\s+WHERE\s+agent_id\s*=\s*\?\s+AND\s+collected_at\s*>=\s*\?/is,
      onQuery: (sql, params) => {
        queryParams.push(...params);
        return { rows: entries };
      }
    }
  ]).standard();
  _setDbForTest(db);

  const res = await supertest(buildApp())
    .get('/api/admin/heartbeat-report/agents/dc01/report-detail')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.agentId, 'dc01');
  assert.ok(res.body.collectedAt, 'collectedAt should be present');
  assert.ok(Array.isArray(res.body.entries));
  assert.equal(res.body.entries.length, 3);
  assert.ok(res.body.entries.length <= 100);
  assert.equal(res.body.entries[0].sourceDc, 'src0');
  assert.equal(res.body.entries[0].destDc, 'dst0');
  assert.equal(queryParams.length, 3);
  assert.deepEqual(queryParams.slice(0, 2), ['dc01', 'dc01']);
});

test('GET /api/admin/heartbeat-report/agents: 401 without token', async () => {
  _setDbForTest(buildMockDb().standard());
  const res = await supertest(buildApp())
    .get('/api/admin/heartbeat-report/agents');
  assert.equal(res.status, 401);
});

// ============================================================================
// 2026-08-26 round-19+ — heartbeat-table + DC-tab 删除 buttons.
// DELETE /api/admin/heartbeat-report/agents/:agentId cascades through
// ad_agent_heartbeat + ad_replication_status (source + dest) + package_runs.
// DELETE /api/admin/heartbeat-report/dcs/:dcName removes only ad_dcs.
// ============================================================================

// 2026-08-26 round-19+ — admin DELETE returns cascade counts. Each
// DELETE statement reports affectedRows=1 in the mock (mock-db forces
// affectedRows=1 for all mutations; see db-mock.js:131-134), so the
// service aggregates source+dest to compute the replication total. We
// capture the SQL fired via the mock's records[] array to assert that
// all four statements ran in order.
test('DELETE /agents/:agentId: cascades 4 DELETEs and returns per-table counts', async () => {
  const records = [];
  const db = buildMockDb([
    // Existence check (SELECT 1 FROM ad_agent_heartbeat WHERE agent_id = ?)
    // — return one row so the service proceeds past the existence guard.
    {
      match: /SELECT\s+1\s+FROM\s+ad_agent_heartbeat\s+WHERE\s+agent_id\s*=\s*\?/i,
      rows: [{ '1': 1 }]
    }
  ]).withRecording(records);
  _setDbForTest(db);

  const res = await supertest(buildApp())
    .delete('/api/admin/heartbeat-report/agents/dc01')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.agentId, 'dc01');
  // mock forces affectedRows=1 per mutation; service sums source+dest.
  assert.equal(res.body.deleted.heartbeat, 1);
  assert.equal(res.body.deleted.replication, 2);
  assert.equal(res.body.deleted.package_runs, 1);
  // Filter to just the mutation statements — SELECT 1 (existence) and the
  // userAuth's getAuthStatus SELECT both precede them.
  const deletes = records.filter(r => /^\s*DELETE\b/i.test(r.sql));
  assert.equal(deletes.length, 4, 'four DELETE statements must fire');
  assert.match(deletes[0].sql, /ad_agent_heartbeat/);
  assert.match(deletes[1].sql, /source_dc/);
  assert.match(deletes[2].sql, /dest_dc/);
  assert.match(deletes[3].sql, /package_runs/);
  // Each DELETE binds [agentId] as the single param.
  for (const d of deletes) {
    assert.deepEqual(d.params, ['dc01']);
  }
});

// 2026-08-26 round-19+ — DELETE on a missing agent returns 404 (existence
// guard). No DELETE statements should fire — the service throws before any
// write so the dashboard never sees a partially-cascaded delete.
test('DELETE /agents/:agentId: 404 when agent missing', async () => {
  const records = [];
  // Default mock returns empty rows for unmatched queries → SELECT 1 returns
  // empty → service throws AgentNotFoundError before any DELETE runs.
  const db = buildMockDb([]).withRecording(records);
  _setDbForTest(db);

  const res = await supertest(buildApp())
    .delete('/api/admin/heartbeat-report/agents/ghost')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'agent_not_found');
  const deletes = records.filter(r => /^\s*DELETE\b/i.test(r.sql));
  assert.equal(deletes.length, 0, 'no DELETE statements should run');
});

// 2026-08-26 round-19+ — DELETE without admin token returns 401. Same
// contract as the other GETs in this router.
test('DELETE /agents/:agentId: 401 without token', async () => {
  _setDbForTest(buildMockDb().standard());
  const res = await supertest(buildApp())
    .delete('/api/admin/heartbeat-report/agents/dc01');
  assert.equal(res.status, 401);
});

// 2026-08-26 round-19+ — DC-tab delete only touches ad_dcs. The route
// calls a single DELETE on ad_dcs.dc_name; no heartbeat / replication /
// package_runs writes — that's the whole point of the DC-tab being a
// separate surface.
test('DELETE /dcs/:dcName: returns ok with single DELETE on ad_dcs', async () => {
  const records = [];
  const db = buildMockDb([]).withRecording(records);
  _setDbForTest(db);

  const res = await supertest(buildApp())
    .delete('/api/admin/heartbeat-report/dcs/ncadsrv1')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.dcName, 'ncadsrv1');
  assert.equal(res.body.deleted.dcs, 1);
  const deletes = records.filter(r => /^\s*DELETE\b/i.test(r.sql));
  assert.equal(deletes.length, 1, 'only ad_dcs DELETE must fire');
  assert.match(deletes[0].sql, /ad_dcs/);
  assert.deepEqual(deletes[0].params, ['ncadsrv1']);
});

// 2026-08-26 round-19+ — DC DELETE on a missing dc returns 404. The
// service throws when affectedRows=0 so a typo doesn't silently no-op.
// Mock has no matching DELETE script → default affectedRows=1, so we
// install an explicit script that flips the behavior.
test('DELETE /dcs/:dcName: 404 when dc missing', async () => {
  // The mock's makeExec returns affectedRows=1 unconditionally for any
  // matched DELETE (db-mock.js:131-134). We need affectedRows=0 to
  // trigger DC_NOT_FOUND, so use a throwOnExecute to simulate a 404
  // path indirectly — easier route is to provide NO matching script for
  // ad_dcs AND rely on the default-mock behavior: scripts that don't
  // match fall through to lookup() which returns []. Then makeExec
  // detects a mutation and sets affectedRows=1 anyway. That gives us
  // affectedRows=1 from the default mock, NOT 0. So to test the 404
  // path we instead pre-fill the mock with a script that matches and
  // returns affectedRows=0 via throwOnExecute-on-no-match? The cleanest
  // approach: monkey-patch db.execute for this test only via onExecute
  // override. Since db-mock.js exposes onExecute but not a way to set
  // affectedRows=0, we instead inject a script whose match DOES catch
  // the DELETE and whose result includes affectedRows — but makeExec
  // overrides that. So we use a different strategy: use onExecute to
  // throw a DC_NOT_FOUND error directly, mimicking what affectedRows=0
  // would produce in the service.
  const db = buildMockDb([
    {
      match: /DELETE\s+FROM\s+ad_dcs/i,
      // onExecute fires before makeExec's response-build, but the
      // service inspects result.affectedRows — which makeExec overrides
      // to 1. So we can't observe 0 via the mock without a custom
      // execute. The simpler approach is to use an onExecute that throws,
      // but then the test would observe a 500, not 404. Best compromise:
      // we don't have a perfect mock for affectedRows=0, so write the
      // test as "DELETE on a dc whose lookup returns no rows" via a
      // direct mock override of execute() — bypasses makeExec entirely.
      execute: async () => ({ rows: [], affectedRows: 0 })
    }
  ]).standard();
  // Override execute() to simulate "no row affected" — this is what the
  // service consumes to decide between ok (200) and DC_NOT_FOUND (404).
  const origExecute = db.execute;
  db.execute = async (sql, params = []) => {
    if (/DELETE\s+FROM\s+ad_dcs/i.test(sql)) {
      return { rows: [], affectedRows: 0, insertId: undefined };
    }
    return origExecute(sql, params);
  };
  _setDbForTest(db);

  const res = await supertest(buildApp())
    .delete('/api/admin/heartbeat-report/dcs/ghost-dc')
    .set('Authorization', `Bearer ${adminToken()}`);
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'dc_not_found');
});

// 2026-08-26 round-19+ — DELETE without admin token returns 401.
test('DELETE /dcs/:dcName: 401 without token', async () => {
  _setDbForTest(buildMockDb().standard());
  const res = await supertest(buildApp())
    .delete('/api/admin/heartbeat-report/dcs/ncadsrv1');
  assert.equal(res.status, 401);
});