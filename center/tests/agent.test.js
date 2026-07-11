import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { agentRouter } from '../src/routes/agent.js';
import { buildMockPool, buildRecordingPool } from './helpers/mysql-pool.js';

// The agent routes issue:
//   - INSERT INTO ad_agent_heartbeat ... ON DUPLICATE KEY UPDATE  (heartbeat)
//   - SELECT ... FROM system_config ...                            (report, GET config)
//   - UPDATE ad_agent_heartbeat SET last_report_at = NOW() ...     (report only)
// To keep tests independent of exact SQL phrasing we key mocks by
// a coarse fragment match.

function buildApp({ pool, agentTokenValue }) {
  const app = express();
  app.use(express.json());
  const config = { agentToken: agentTokenValue };
  const logger = { info(){}, error(){}, warn(){}, debug(){} };
  app.use(agentRouter({ config, pool, logger }));
  return app;
}

test('POST /api/agent/heartbeat with correct token -> 200 and UPSERT was issued', async () => {
  const records = [];
  const pool = buildRecordingPool(records);
  const app = buildApp({ pool, agentTokenValue: 'tok' });
  const res = await supertest(app)
    .post('/api/agent/heartbeat')
    .set('X-Agent-Token', 'tok')
    .send({ agentId: 'agent-1', agentVersion: '1.0.0', pendingQueueSize: 3 });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(records.length, 1);
  assert.match(records[0].sql, /INSERT\s+INTO\s+ad_agent_heartbeat/i);
  assert.match(records[0].sql, /ON\s+DUPLICATE\s+KEY\s+UPDATE/i);
  assert.deepEqual(records[0].params, ['agent-1', '1.0.0', null, null, 3]);
});

test('POST /api/agent/heartbeat with wrong token -> 401 and no UPSERT issued', async () => {
  const records = [];
  const pool = buildRecordingPool(records);
  const app = buildApp({ pool, agentTokenValue: 'tok' });
  const res = await supertest(app)
    .post('/api/agent/heartbeat')
    .set('X-Agent-Token', 'WRONG')
    .send({ agentId: 'agent-1' });
  assert.equal(res.status, 401);
  assert.equal(records.length, 0);
});

test('POST /api/agent/heartbeat missing agentId -> 400 and no UPSERT issued', async () => {
  const records = [];
  const pool = buildRecordingPool(records);
  const app = buildApp({ pool, agentTokenValue: 'tok' });
  const res = await supertest(app)
    .post('/api/agent/heartbeat')
    .set('X-Agent-Token', 'tok')
    .send({});
  assert.equal(res.status, 400);
  assert.equal(records.length, 0);
});

test('POST /api/agent/report with correct token -> 200, config echoed', async () => {
  // scripts provides:
  //  - history_enabled lookup (1st system_config SELECT, narrowed)
  //  - full config bundle (2nd system_config SELECT in getAgentConfig)
  const pool = buildMockPool([
    { match: /SELECT\s+config_key,\s*config_value\s+FROM\s+system_config/i, rows: [{ config_key: 'history_enabled', config_value: 'true' }] },
    { match: /FROM\s+system_config/i, rows: [
      { config_key: 'polling_interval_minutes', config_value: '15' },
      { config_key: 'latency_threshold_minutes', config_value: '180' },
      { config_key: 'heartbeat_interval_seconds', config_value: '5' },
      { config_key: 'agent_token', config_value: 'tok' }
    ]}
  ]);
  const app = buildApp({ pool, agentTokenValue: 'tok' });
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
  const pool = buildRecordingPool(records);
  const app = buildApp({ pool, agentTokenValue: 'tok' });
  const res = await supertest(app)
    .post('/api/agent/report')
    .set('X-Agent-Token', 'tok')
    .send({ agentId: 'agent-1' });
  assert.equal(res.status, 400);
  assert.equal(records.length, 0);
});

test('GET /api/agent/config -> 200 returns polling/latency/heartbeat/host/port', async () => {
  const pool = buildMockPool([
    { match: /FROM\s+system_config/i, rows: [
      { config_key: 'polling_interval_minutes', config_value: '5' },
      { config_key: 'latency_threshold_minutes', config_value: '60' },
      { config_key: 'heartbeat_interval_seconds', config_value: '3' },
      { config_key: 'agent_token', config_value: 'tok' },
      { config_key: 'center_public_host', config_value: 'ad-dashboard.contoso.com' },
      { config_key: 'center_public_port', config_value: '443' }
    ]}
  ]);
  const app = buildApp({ pool, agentTokenValue: 'tok' });
  const res = await supertest(app)
    .get('/api/agent/config')
    .set('X-Agent-Token', 'tok');
  assert.equal(res.status, 200);
  assert.equal(res.body.pollingIntervalMinutes, 5);
  assert.equal(res.body.latencyThresholdMinutes, 60);
  assert.equal(res.body.heartbeatIntervalSeconds, 3);
  assert.equal(res.body.agentToken, 'tok');
  assert.equal(res.body.centerPublicHost, 'ad-dashboard.contoso.com');
  assert.equal(res.body.centerPublicPort, '443');
});

test('GET /api/agent/config with missing center_public_* keys -> null fields, not undefined', async () => {
  const pool = buildMockPool([
    { match: /FROM\s+system_config/i, rows: [
      { config_key: 'polling_interval_minutes', config_value: '15' },
      { config_key: 'latency_threshold_minutes', config_value: '180' }
    ]}
  ]);
  const app = buildApp({ pool, agentTokenValue: 'tok' });
  const res = await supertest(app)
    .get('/api/agent/config')
    .set('X-Agent-Token', 'tok');
  assert.equal(res.status, 200);
  assert.equal(res.body.centerPublicHost, null);
  assert.equal(res.body.centerPublicPort, null);
});

test('POST /api/agent/report with wrong token -> 401', async () => {
  const records = [];
  const pool = buildRecordingPool(records);
  const app = buildApp({ pool, agentTokenValue: 'tok' });
  const res = await supertest(app)
    .post('/api/agent/report')
    .set('X-Agent-Token', 'WRONG')
    .send({ agentId: 'agent-1', collectedAt: '2026-07-11T00:00:00Z', data: [] });
  assert.equal(res.status, 401);
  assert.equal(records.length, 0);
});
