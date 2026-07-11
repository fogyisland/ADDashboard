import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { agentRouter } from '../src/routes/agent.js';

// Mock pool: request().query() delegates to a handler capturing SQL + inputs.
// Closure-based capture: each request() call returns a fresh object whose
// `query()` records itself via closure on `self`, then resets _inputs.
function buildMockPool(captured) {
  return {
    request() {
      const self = {
        _inputs: {},
        input(k, v) { self._inputs[k] = v; return self; },
        async query(q) {
          captured.push({ sql: q, inputs: { ...self._inputs } });
          // Special-case reads that the route performs
          if (/SELECT\s+config_value\s+FROM\s+system_config/i.test(q)) {
            return { recordset: [{ config_key: 'history_enabled', config_value: 'false' }] };
          }
          if (/FROM\s+system_config/i.test(q)) {
            return { recordset: [
              { config_key: 'polling_interval_minutes', config_value: '15' },
              { config_key: 'latency_threshold_minutes', config_value: '180' },
              { config_key: 'agent_token', config_value: 'tok' }
            ] };
          }
          return { recordset: [] };
        }
      };
      return self;
    }
  };
}

function buildApp({ pool, agentTokenValue }) {
  const app = express();
  app.use(express.json());
  const config = { agentToken: agentTokenValue };
  const logger = { info(){}, error(){}, warn(){}, debug(){} };
  app.use(agentRouter({ config, pool, logger }));
  return app;
}

test('POST /api/agent/heartbeat with correct token -> 200 and MERGE was issued', async () => {
  const captured = [];
  const pool = buildMockPool(captured);
  const app = buildApp({ pool, agentTokenValue: 'tok' });
  const res = await supertest(app)
    .post('/api/agent/heartbeat')
    .set('X-Agent-Token', 'tok')
    .send({ agentId: 'agent-1', agentVersion: '1.0.0', pendingQueueSize: 3 });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(captured.some(c => /MERGE\s+INTO\s+ad_agent_heartbeat/i.test(c.sql)),
    'expected MERGE into ad_agent_heartbeat to be issued');
});

test('POST /api/agent/heartbeat with wrong token -> 401', async () => {
  const captured = [];
  const pool = buildMockPool(captured);
  const app = buildApp({ pool, agentTokenValue: 'tok' });
  const res = await supertest(app)
    .post('/api/agent/heartbeat')
    .set('X-Agent-Token', 'WRONG')
    .send({ agentId: 'agent-1' });
  assert.equal(res.status, 401);
  // No MERGE should have been issued
  assert.ok(!captured.some(c => /MERGE\s+INTO\s+ad_agent_heartbeat/i.test(c.sql)));
});

test('POST /api/agent/heartbeat missing agentId -> 400', async () => {
  const captured = [];
  const pool = buildMockPool(captured);
  const app = buildApp({ pool, agentTokenValue: 'tok' });
  const res = await supertest(app)
    .post('/api/agent/heartbeat')
    .set('X-Agent-Token', 'tok')
    .send({});
  assert.equal(res.status, 400);
  assert.ok(!captured.some(c => /MERGE\s+INTO\s+ad_agent_heartbeat/i.test(c.sql)));
});