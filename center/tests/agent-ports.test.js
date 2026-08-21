import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { agentRouter } from '../src/routes/agent.js';
import { _setDbForTest } from '../src/db/index.js';
import { buildMockDb, buildRecordingPool } from './helpers/db-mock.js';

// Task 3: GET /api/agent/ports + heartbeat port-status ingest.
// These tests wire the real agentRouter() against mocked db + services.
// The route imports listPorts/upsertPortStatuses from ../services/ports.js
// and ../services/port-status.js, which use getDb() — so we set the mock db
// via _setDbForTest() and the services read it through the same facade.

const TOKEN = 'test-token';
// I3 (Task 5): the agentToken middleware reads the bundle from db. Inject a
// script that matches `getAgentTokenBundle` and returns `TOKEN` as current.
const AGENT_TOKEN_BUNDLE_REGEX = /agent_token_(current|previous|rotated_at|previous_ttl_days)/i;
const TOKEN_BUNDLE_SCRIPT = { match: AGENT_TOKEN_BUNDLE_REGEX, rows: [{ config_key: 'agent_token_current', config_value: TOKEN }] };

function buildApp({ agentTokenValue = TOKEN } = {}) {
  const app = express();
  app.use(express.json());
  const config = { agentToken: agentTokenValue };
  const logger = { info(){}, error(){}, warn(){}, debug(){} };
  app.use(agentRouter({ config, logger }));
  return app;
}

test('GET /api/agent/ports returns sorted list with auth', async () => {
  // Rows returned in the order the real SQL ORDER BY would produce
  // (sort_order ASC, then port ASC). The mock does not sort — it just
  // echoes — so we feed it the canonical order.
  const db = buildMockDb([
    TOKEN_BUNDLE_SCRIPT,
    {
      match: /FROM\s+system_ports/i,
      rows: [
        { port: 135,   label: 'RPC',  sortOrder: 0 },
        { port: 50003, label: 'KRB3', sortOrder: 2 }
      ]
    }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app).get('/api/agent/ports').set('X-Agent-Token', TOKEN);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, [
    { port: 135, label: 'RPC', sortOrder: 0 },
    { port: 50003, label: 'KRB3', sortOrder: 2 }
  ]);
});

test('GET /api/agent/ports returns [] when no ports configured', async () => {
  const db = buildMockDb([
    TOKEN_BUNDLE_SCRIPT,
    { match: /FROM\s+system_ports/i, rows: [] }
  ]).standard();
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app).get('/api/agent/ports').set('X-Agent-Token', TOKEN);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, []);
});

test('GET /api/agent/ports requires the agent token', async () => {
  const records = [];
  _setDbForTest(buildRecordingPool(records));
  const app = buildApp();
  const r = await supertest(app).get('/api/agent/ports');
  assert.equal(r.status, 401);
  assert.equal(records.length, 0, 'auth failure must not touch DB');
});

test('GET /api/agent/ports returns 500 when the underlying query throws', async () => {
  const db = {
    dialect: 'mysql',
    sql: buildMockDb().standard().sql,
    async query() { throw new Error('boom'); },
    async execute() { return { rows: [], affectedRows: 0, insertId: undefined }; },
    async transaction(work) { return work({ execute: async () => ({ rows: [], affectedRows: 0 }), query: async () => ({ rows: [] }) }); },
    async healthcheck() {},
    async close() {}
  };
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app).get('/api/agent/ports').set('X-Agent-Token', TOKEN);
  assert.equal(r.status, 500);
  assert.deepEqual(r.body, { error: 'internal' });
});

test('POST /api/agent/heartbeat without ports returns {ok:true} (back-compat)', async () => {
  // Records both the heartbeat upsert and any port-status writes; the latter
  // must NOT happen for pre-feature agents.
  const records = [];
  const db = buildMockDb([
    TOKEN_BUNDLE_SCRIPT,
    { match: /FROM\s+system_ports/i, rows: [] }
  ]).withRecording(records);
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .post('/api/agent/heartbeat')
    .set('X-Agent-Token', TOKEN)
    .send({ agentId: 'dc01', agentVersion: '0.1.0' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  // I3: bundle SELECT now happens before the heartbeat upsert, so records
  // contains 2 entries (bundle + upsert). Filter for the upsert only.
  const heartbeatUpserts = records.filter(rec => /INSERT\s+INTO\s+ad_agent_heartbeat/i.test(rec.sql));
  assert.equal(heartbeatUpserts.length, 1, 'must only issue the heartbeat upsert');
  const portStatusHits = records.filter(rec => /FROM\s+system_ports|ad_agent_port_status/i.test(rec.sql));
  assert.equal(portStatusHits.length, 0, 'must not touch ad_agent_port_status when ports absent');
});

test('POST /api/agent/heartbeat with ports upserts each and returns counts', async () => {
  const records = [];
  // system_ports returns [{port:135,...}] so port 50001 will be rejected as
  // not in validPortsSet by upsertPortStatuses — but both rows must still be
  // walked (the function does not short-circuit). We assert counts via the
  // service contract: 1 accepted, 1 rejected → {ok:true, accepted:1, rejected:1}.
  const db = buildMockDb([
    TOKEN_BUNDLE_SCRIPT,
    { match: /FROM\s+system_ports/i, rows: [{ port: 135, label: 'RPC', sortOrder: 0 }] }
  ]).withRecording(records);
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .post('/api/agent/heartbeat')
    .set('X-Agent-Token', TOKEN)
    .send({
      agentId: 'dc01',
      agentVersion: '0.1.0',
      ports: [
        { port: 135, ok: true,  latencyMs: 3 },
        { port: 50001, ok: false, latencyMs: 2000 }
      ]
    });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, accepted: 1, rejected: 1 });
  // Verify heartbeat row was written.
  const heartbeatUpserts = records.filter(rec => /INSERT\s+INTO\s+ad_agent_heartbeat/i.test(rec.sql));
  assert.equal(heartbeatUpserts.length, 1, 'must upsert heartbeat row');
  // 2026-08-21 UX redesign: heartbeat now carries agent_token_version
  // (defaulted to 0 for pre-feature agents). See routes/agent.js:42 + 51.
  assert.deepEqual(heartbeatUpserts[0].params, ['dc01', '0.1.0', null, null, 0, 0]);
  // Verify port-status upsert ran inside a transaction.
  const portStatusUpserts = records.filter(rec => /ad_agent_port_status/i.test(rec.sql));
  assert.equal(portStatusUpserts.length, 1, 'must upsert exactly one accepted port row');
});

test('POST /api/agent/heartbeat returns 400 when ports is not an array', async () => {
  const records = [];
  _setDbForTest(buildRecordingPool(records));
  const app = buildApp();
  const r = await supertest(app)
    .post('/api/agent/heartbeat')
    .set('X-Agent-Token', TOKEN)
    .send({ agentId: 'dc01', ports: 'not-an-array' });
  assert.equal(r.status, 400);
  // Heartbeat row was written before the 400 branch fired (intentional: the
  // agent is alive even if the payload is malformed) but no port-status row.
  const portStatusUpserts = records.filter(rec => /ad_agent_port_status/i.test(rec.sql));
  assert.equal(portStatusUpserts.length, 0);
});

test('POST /api/agent/heartbeat with empty ports[] still takes the ingest path (accepted:0, rejected:0)', async () => {
  // An explicit empty array IS presence; route should return the new shape.
  const records = [];
  const db = buildMockDb([
    TOKEN_BUNDLE_SCRIPT,
    { match: /FROM\s+system_ports/i, rows: [{ port: 135, label: 'RPC', sortOrder: 0 }] }
  ]).withRecording(records);
  _setDbForTest(db);
  const app = buildApp();
  const r = await supertest(app)
    .post('/api/agent/heartbeat')
    .set('X-Agent-Token', TOKEN)
    .send({ agentId: 'dc01', ports: [] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, accepted: 0, rejected: 0 });
});

test('POST /api/agent/heartbeat with wrong token -> 401, no DB writes', async () => {
  const records = [];
  _setDbForTest(buildRecordingPool(records));
  const app = buildApp();
  const r = await supertest(app)
    .post('/api/agent/heartbeat')
    .set('X-Agent-Token', 'WRONG')
    .send({ agentId: 'dc01', ports: [{ port: 135, ok: true }] });
  assert.equal(r.status, 401);
  assert.equal(records.length, 0);
});