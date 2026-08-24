import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { agentRouter } from '../src/routes/agent.js';
import { _setDbForTest } from '../src/db/index.js';
import { upsertDiscoveredDc } from '../src/services/discovery.js';
import { buildMockDb, buildRecordingPool } from './helpers/db-mock.js';

// The agent routes issue:
//   - INSERT INTO ad_agent_heartbeat ... ON DUPLICATE KEY UPDATE  (heartbeat)
//   - SELECT ... FROM system_config ...                            (report, GET config)
//   - UPDATE ad_agent_heartbeat SET last_report_at = NOW() ...     (report only)
// To keep tests independent of exact SQL phrasing we key mocks by
// a coarse fragment match.
//
// I3 (Task 5): the agentToken middleware now resolves the bundle via
// `db.sql.config.getAgentTokenBundle` (see auth/agent-token.js). Tests
// that pass `agentTokenValue: 'tok'` and expect a 200 must seed the
// agent_token_current row so the bundle lookup matches `tok`. We do this
// via a helper script that matches the bundle SELECT and returns the
// supplied token as current. buildApp injects that script for every test
// that supplies a token; tests asserting the wrong-token 401 already
// work because the supplied token in the request doesn't match.
const AGENT_TOKEN_BUNDLE_REGEX = /agent_token_(current|previous|rotated_at|previous_ttl_days)/i;

// Build a db with the agent-token bundle script pre-seeded. Tests that
// want recording pass an explicit `records` array; tests that don't use
// `withRecording` get a regular mock. Tests that need richer scripts can
// pass `extraScripts` to merge in additional SELECT/INSERT mocks.
function buildAgentDb({ agentTokenValue, records = [], extraScripts = [] } = {}) {
  const scripts = [...extraScripts];
  if (agentTokenValue) {
    scripts.push({
      match: AGENT_TOKEN_BUNDLE_REGEX,
      rows: [{ config_key: 'agent_token_current', config_value: agentTokenValue }]
    });
  }
  return scripts.length
    ? buildMockDb(scripts).withRecording(records)
    : buildRecordingPool(records);
}

function buildApp({ agentTokenValue, records, extraScripts } = {}) {
  const app = express();
  app.use(express.json());
  const db = buildAgentDb({ agentTokenValue, records, extraScripts });
  _setDbForTest(db);
  const config = { agentToken: agentTokenValue };
  const logger = { info(){}, error(){}, warn(){}, debug(){} };
  app.use(agentRouter({ config, logger }));
  return app;
}

test('POST /api/agent/heartbeat with correct token -> 200 and UPSERT was issued', async () => {
  const records = [];
  // round-12 T6: handler now reads back report_requested_at after the
  // upsert. The mock returns null so reportRequested stays false.
  const app = buildApp({
    agentTokenValue: 'tok',
    records,
    extraScripts: [
      { match: /SELECT\s+report_requested_at\s+FROM\s+ad_agent_heartbeat\s+WHERE\s+agent_id\s*=\s*\?/is,
        rows: [{ report_requested_at: null }] }
    ]
  });
  const res = await supertest(app)
    .post('/api/agent/heartbeat')
    .set('X-Agent-Token', 'tok')
    .send({ agentId: 'agent-1', agentVersion: '1.0.0', pendingQueueSize: 3 });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  // I3: the agentToken middleware also issues a SELECT against
  // system_config for the bundle. Filter for the heartbeat UPSERT only.
  const upserts = records.filter(r => /INSERT\s+INTO\s+ad_agent_heartbeat/i.test(r.sql));
  assert.equal(upserts.length, 1);
  assert.match(upserts[0].sql, /ON\s+DUPLICATE\s+KEY\s+UPDATE/i);
  // 2026-08-21 UX redesign: heartbeat now carries agent_token_version
  // (defaulted to 0 for pre-feature agents). See routes/agent.js:42 + 51.
  // round-12 T6: 8th param is report_requested_at (null when agent
  // doesn't forward it — COALESCE in upsert preserves the column).
  assert.deepEqual(upserts[0].params, ['agent-1', '1.0.0', null, null, 3, 0, null]);
  // round-12 T6: response carries reportRequested: false (read-back null).
  assert.equal(res.body.reportRequested, false);
});

// round-12 T-fix: explicit-null body field triggers clearReportRequest
// instead of the preserve-via-COALESCE path. Without this, the T7 agent's
// "ack by sending null" loop would never actually wipe the column.
test('POST /api/agent/heartbeat: explicit null body field triggers clearReportRequest', async () => {
  let clearCalled = false;
  const records = [];
  const app = buildApp({
    agentTokenValue: 'tok',
    records,
    extraScripts: [
      // The clear path goes through clearReportRequest (UPDATE … = NULL)
      // — NOT through the heartbeat UPSERT. The mock fires onExecute for
      // the UPDATE so the test can assert the SQL was issued; the read-
      // back SELECT returns null so reportRequested stays false.
      {
        match: /UPDATE\s+ad_agent_heartbeat\s+SET\s+report_requested_at\s*=\s*NULL/i,
        rows: [],
        onExecute: () => { clearCalled = true; }
      },
      {
        match: /SELECT\s+report_requested_at\s+FROM\s+ad_agent_heartbeat\s+WHERE\s+agent_id\s*=\s*\?/is,
        rows: [{ report_requested_at: null }]
      }
    ]
  });

  const r = await supertest(app)
    .post('/api/agent/heartbeat')
    .set('X-Agent-Token', 'tok')
    .send({
      agentId: 'agent-1',
      agentVersion: '1.0.0',
      pendingQueueSize: 0,
      report_requested_at: null   // explicit clear
    });

  assert.equal(r.status, 200);
  assert.equal(clearCalled, true);
  assert.equal(r.body.reportRequested, false);
  // UPSERT must NOT have fired — the explicit null routes to clearReportRequest.
  const upserts = records.filter(rec => /INSERT\s+INTO\s+ad_agent_heartbeat/i.test(rec.sql));
  assert.equal(upserts.length, 0);
});

test('POST /api/agent/heartbeat with wrong token -> 401 and no UPSERT issued', async () => {
  const records = [];
  const app = buildApp({ agentTokenValue: 'tok', records });
  const res = await supertest(app)
    .post('/api/agent/heartbeat')
    .set('X-Agent-Token', 'WRONG')
    .send({ agentId: 'agent-1' });
  assert.equal(res.status, 401);
  assert.equal(records.length, 0);
});

test('POST /api/agent/heartbeat missing agentId -> 400 and no UPSERT issued', async () => {
  const records = [];
  const app = buildApp({ agentTokenValue: 'tok', records });
  const res = await supertest(app)
    .post('/api/agent/heartbeat')
    .set('X-Agent-Token', 'tok')
    .send({});
  assert.equal(res.status, 400);
  assert.equal(records.length, 0);
});

// round-12 T6: heartbeat response carries `reportRequested: boolean`.
// The handler reads back report_requested_at after the upsert so the
// response reflects the post-write state. COALESCE in the upsert means
// binding null preserves the column — older agents that don't forward
// the field (or that attempt a "clear" by sending null) get the existing
// value preserved. See brief Step 4 + Option A rationale.
test('POST /api/agent/heartbeat: response carries reportRequested: true when flag is set', async () => {
  const records = [];
  const app = buildApp({
    agentTokenValue: 'tok',
    records,
    extraScripts: [
      // Mock the post-upsert read-back SELECT to return a non-null
      // report_requested_at — simulates a pending "report now" request
      // that was set via the admin route (T5).
      { match: /SELECT\s+report_requested_at\s+FROM\s+ad_agent_heartbeat\s+WHERE\s+agent_id\s*=\s*\?/is,
        rows: [{ report_requested_at: new Date('2026-08-24T10:00:00Z') }] }
    ]
  });
  const r = await supertest(app)
    .post('/api/agent/heartbeat')
    .set('X-Agent-Token', 'tok')
    .send({ agentId: 'agent-1', agentVersion: '1.0.0', pendingQueueSize: 0 });
  assert.equal(r.status, 200);
  assert.equal(r.body.reportRequested, true);
  // UPSERT must include report_requested_at as the 7th bound param
  // (last_heartbeat_at uses CURRENT_TIMESTAMP so it's not bound).
  // Agent didn't forward the field → null → COALESCE preserves the column.
  const upserts = records.filter(rec => /INSERT\s+INTO\s+ad_agent_heartbeat/i.test(rec.sql));
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].params.length, 7);
  assert.equal(upserts[0].params[6], null);
});

test('POST /api/agent/heartbeat: response carries reportRequested: false when flag is null', async () => {
  const records = [];
  const app = buildApp({
    agentTokenValue: 'tok',
    records,
    extraScripts: [
      // Read-back returns null — either the column was never set, or
      // a future "clear" path managed to wipe it. Either way, the
      // response should report reportRequested: false.
      { match: /SELECT\s+report_requested_at\s+FROM\s+ad_agent_heartbeat\s+WHERE\s+agent_id\s*=\s*\?/is,
        rows: [{ report_requested_at: null }] }
    ]
  });
  const r = await supertest(app)
    .post('/api/agent/heartbeat')
    .set('X-Agent-Token', 'tok')
    .send({ agentId: 'agent-1', agentVersion: '1.0.0', pendingQueueSize: 0 });
  assert.equal(r.status, 200);
  assert.equal(r.body.reportRequested, false);
});

test('POST /api/agent/report with correct token -> 200, config echoed', async () => {
  // scripts provides:
  //  - history_enabled lookup (1st system_config SELECT, narrowed)
  //  - full config bundle (2nd system_config SELECT in getAgentConfig)
  //  - agent_token bundle script for the auth middleware (injected by buildApp)
  const app = buildApp({
    agentTokenValue: 'tok',
    extraScripts: [
      { match: /SELECT\s+config_key,\s*config_value\s+FROM\s+system_config/i, rows: [{ config_key: 'history_enabled', config_value: 'true' }] },
      { match: /FROM\s+system_config/i, rows: [
        { config_key: 'polling_interval_minutes', config_value: '15' },
        { config_key: 'latency_threshold_minutes', config_value: '180' },
        { config_key: 'heartbeat_interval_seconds', config_value: '5' },
        { config_key: 'agent_token', config_value: 'tok' }
      ]}
    ]
  });
  const res = await supertest(app)
    .post('/api/agent/report')
    .set('X-Agent-Token', 'tok')
    .send({ agentId: 'agent-1', collectedAt: '2026-07-11T00:00:00Z', data: [] });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.config.pollingIntervalMinutes, 15);
  assert.equal(res.body.config.latencyThresholdMinutes, 180);
  assert.equal(res.body.config.heartbeatIntervalSeconds, 5);
});

test('POST /api/agent/report missing payload -> 400', async () => {
  const records = [];
  const app = buildApp({ agentTokenValue: 'tok', records });
  const res = await supertest(app)
    .post('/api/agent/report')
    .set('X-Agent-Token', 'tok')
    .send({ agentId: 'agent-1' });
  assert.equal(res.status, 400);
  assert.equal(records.length, 0);
});

test('GET /api/agent/config -> 200 returns polling/latency/heartbeat/token', async () => {
  const app = buildApp({
    agentTokenValue: 'tok',
    extraScripts: [
      { match: /FROM\s+system_config/i, rows: [
        { config_key: 'polling_interval_minutes', config_value: '5' },
        { config_key: 'latency_threshold_minutes', config_value: '60' },
        { config_key: 'heartbeat_interval_seconds', config_value: '3' },
        { config_key: 'agent_token', config_value: 'tok' }
      ]}
    ]
  });
  const res = await supertest(app)
    .get('/api/agent/config')
    .set('X-Agent-Token', 'tok');
  assert.equal(res.status, 200);
  assert.equal(res.body.pollingIntervalMinutes, 5);
  assert.equal(res.body.latencyThresholdMinutes, 60);
  assert.equal(res.body.heartbeatIntervalSeconds, 3);
  assert.equal(res.body.agentToken, 'tok');
});

test('GET /api/agent/config with missing keys -> defaults fill in', async () => {
  const app = buildApp({
    agentTokenValue: 'tok',
    extraScripts: [
      { match: /FROM\s+system_config/i, rows: [] }
    ]
  });
  const res = await supertest(app)
    .get('/api/agent/config')
    .set('X-Agent-Token', 'tok');
  assert.equal(res.status, 200);
  assert.equal(res.body.pollingIntervalMinutes, 15);
  assert.equal(res.body.latencyThresholdMinutes, 180);
  assert.equal(res.body.heartbeatIntervalSeconds, 5);
});

// /config.json is the web-port bootstrap endpoint. Same payload shape as
// /api/agent/config so existing agent code keeps working when the URL
// changes; same X-Agent-Token auth contract.
test('GET /config.json with correct token -> 200 returns full agent config', async () => {
  const app = buildApp({
    agentTokenValue: 'tok',
    extraScripts: [
      { match: /FROM\s+system_config/i, rows: [
        { config_key: 'polling_interval_minutes', config_value: '5' },
        { config_key: 'heartbeat_port', config_value: '9081' },
        { config_key: 'report_port', config_value: '9082' },
        { config_key: 'agent_token', config_value: 'tok' }
      ]}
    ]
  });
  const res = await supertest(app)
    .get('/config.json')
    .set('X-Agent-Token', 'tok');
  assert.equal(res.status, 200);
  assert.equal(res.body.pollingIntervalMinutes, 5);
  assert.equal(res.body.heartbeatPort, 9081);
  assert.equal(res.body.reportPort, 9082);
  assert.equal(res.body.agentToken, 'tok');
});

test('GET /config.json with wrong token -> 401', async () => {
  const app = buildApp({ agentTokenValue: 'tok' });
  const res = await supertest(app)
    .get('/config.json')
    .set('X-Agent-Token', 'WRONG');
  assert.equal(res.status, 401);
});

test('GET /config.json without token -> 401', async () => {
  const app = buildApp({ agentTokenValue: 'tok' });
  const res = await supertest(app).get('/config.json');
  assert.equal(res.status, 401);
});

test('POST /api/agent/report with wrong token -> 401', async () => {
  const records = [];
  const app = buildApp({ agentTokenValue: 'tok', records });
  const res = await supertest(app)
    .post('/api/agent/report')
    .set('X-Agent-Token', 'WRONG')
    .send({ agentId: 'agent-1', collectedAt: '2026-07-11T00:00:00Z', data: [] });
  assert.equal(res.status, 401);
  assert.equal(records.length, 0);
});

// ----- DISCOVER -----

test('POST /api/agent/discover with correct token -> 200 and UPSERT to ad_dcs', async () => {
  const records = [];
  const app = buildApp({ agentTokenValue: 'tok', records });
  const res = await supertest(app)
    .post('/api/agent/discover')
    .set('X-Agent-Token', 'tok')
    .send({
      agentId: 'DC-BJ-01',
      collectedAt: '2026-07-12T00:00:00.000Z',
      dc: {
        name: 'DC-BJ-01',
        siteHint: 'Beijing-Site',
        osVersion: 'Windows Server 2019',
        whenCreated: '2024-03-15T08:00:00.000Z',
        isPdc: false,
        isGc: true,
        isRidMaster: false,
        isSchemaMaster: false,
        isDomainNamingMaster: false,
        isInfrastructureMaster: false
      }
    });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(records.length, 1);
  assert.match(records[0].sql, /INSERT\s+INTO\s+ad_dcs/i);
  assert.match(records[0].sql, /ON\s+DUPLICATE\s+KEY\s+UPDATE/i);
  // site_id must NOT appear in the SQL
  assert.doesNotMatch(records[0].sql, /site_id\s*=/i);
});

test('POST /api/agent/discover missing dc.name -> 400', async () => {
  const records = [];
  const app = buildApp({ agentTokenValue: 'tok', records });
  const res = await supertest(app)
    .post('/api/agent/discover')
    .set('X-Agent-Token', 'tok')
    .send({ agentId: 'DC-BJ-01', collectedAt: '2026-07-12T00:00:00.000Z', dc: {} });
  assert.equal(res.status, 400);
  assert.equal(records.length, 0);
});

test('POST /api/agent/discover with wrong token -> 401', async () => {
  const records = [];
  const app = buildApp({ agentTokenValue: 'tok', records });
  const res = await supertest(app)
    .post('/api/agent/discover')
    .set('X-Agent-Token', 'WRONG')
    .send({ agentId: 'DC-BJ-01', collectedAt: '2026-07-12T00:00:00.000Z', dc: { name: 'X' } });
  assert.equal(res.status, 401);
  assert.equal(records.length, 0);
});

test('upsertDiscoveredDc converts booleans to 0/1', async () => {
  const records = [];
  _setDbForTest(buildRecordingPool(records));
  await upsertDiscoveredDc({
    agentId: 'A1',
    collectedAt: '2026-07-12T00:00:00.000Z',
    dc: {
      name: 'A1', siteHint: 'S1', osVersion: 'Win2022', whenCreated: '2024-01-01T00:00:00.000Z',
      isPdc: true, isGc: true, isRidMaster: false, isSchemaMaster: false,
      isDomainNamingMaster: false, isInfrastructureMaster: true
    }
  });
  // params: [name, siteHint, osVersion, whenCreated, isPdc, isGc, isRidMaster, isSchemaMaster, isDomainNamingMaster, isInfrastructureMaster, collectedAt, agentId]
  assert.deepEqual(records[0].params, [
    'A1', 'S1', 'Win2022', '2024-01-01 00:00:00',
    1, 1, 0, 0, 0, 1,
    '2026-07-12 00:00:00', 'A1'
  ]);
});