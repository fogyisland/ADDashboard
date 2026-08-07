import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import supertest from 'supertest';
import { heartbeatReportRouter } from '../src/routes/heartbeat-report.js';
import { userAuth } from '../src/auth/user-auth.js';
import { requirePerm } from '../src/auth/rbac.js';
import { signJwt } from '../src/auth/jwt.js';
import { _setDbForTest } from '../src/db/index.js';
import { buildMockDb } from './helpers/db-mock.js';

const SECRET = 'test-secret';
function adminToken() { return signJwt({ sub: 'u1', role: 'admin', permissions: ['*'] }, SECRET, 60); }

function buildApp() {
  const a = express();
  a.use(express.json());
  return a.use(
    heartbeatReportRouter({
      requireAuth: userAuth({ secret: SECRET }),
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

test('agents list: returns rows from ad_agent_heartbeat with reportSummary aggregation', async () => {
  const db = buildMockDb([
    {
      match: /SELECT\s+h\.agent_id\s*,\s*h\.agent_version\s*,\s*h\.last_heartbeat_at\s*,\s*h\.last_report_at\s*,\s*h\.last_report_status\s*,\s*h\.pending_queue_size\s+FROM\s+ad_agent_heartbeat\s+h\s+ORDER\s+BY\s+h\.agent_id/is,
      rows: [fakeHeartbeatRow()]
    },
    {
      match: /FROM\s+ad_replication_status\s+s\s+INNER\s+JOIN\s*\(/is,
      rows: [
        fakeReplicationRow({ status_code: 0, error_message: null }),
        fakeReplicationRow({ dest_dc: 'dc03', status_code: 1, error_message: '延迟高' })
      ]
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
      match: /SELECT\s+h\.agent_id\s*,\s*h\.agent_version\s*,\s*h\.last_heartbeat_at\s*,\s*h\.last_report_at\s*,\s*h\.last_report_status\s*,\s*h\.pending_queue_size\s+FROM\s+ad_agent_heartbeat\s+h\s+ORDER\s+BY\s+h\.agent_id/is,
      rows: [
        fakeHeartbeatRow({
          agent_id: 'dc-never',
          last_report_at: null,
          last_report_status: null,
          pending_queue_size: 0
        })
      ]
    },
    // The summary query should NOT fire when last_report_at is null.
    {
      match: /FROM\s+ad_replication_status\s+s\s+INNER\s+JOIN\s*\(/is,
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

test('report-detail: returns entries for the most recent collected_at (capped at 100)', async () => {
  // The service fetches the most recent 100 entries via latestReportEntries;
  // we simulate the same set so the response shape can be verified end-to-end.
  const entries = [];
  for (let i = 0; i < 3; i++) {
    entries.push(fakeReplicationRow({ source_dc: `src${i}`, dest_dc: `dst${i}` }));
  }
  const db = buildMockDb([
    {
      match: /SELECT\s+collected_at\s*,\s*source_dc\s*,\s*dest_dc\s*,\s*source_site\s*,\s*dest_site\s*,\s*naming_context\s*,\s*status_code\s*,\s*error_message\s*,\s*last_success_time\s*,\s*last_attempt_time\s+FROM\s+ad_replication_status\s+WHERE\s+agent_id\s*=\s*\?/is,
      rows: entries
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
});

test('GET /api/admin/heartbeat-report/agents: 401 without token', async () => {
  _setDbForTest(buildMockDb().standard());
  const res = await supertest(buildApp())
    .get('/api/admin/heartbeat-report/agents');
  assert.equal(res.status, 401);
});