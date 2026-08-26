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