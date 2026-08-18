// I8: ETag support for the agent-side /config.json bootstrap endpoint.
// Center route at center/src/routes/agent.js:184. Agent callers use
// If-None-Match on subsequent fetches; center returns 304 (no body) when
// the supplied ETag matches the current config fingerprint.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { agentRouter } from '../../src/routes/agent.js';
import { buildMockDb } from '../helpers/db-mock.js';
import { _setDbForTest } from '../../src/db/index.js';

const AGENT_TOKEN = 'test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function buildApp() {
  const a = express();
  const config = { jwtSecret: 'test' };
  const logger = { info(){}, error(){}, warn(){}, debug(){} };
  // 'full' mount so /config.json is registered (only on web/full mounts
  // per agent.js:183).
  a.use(agentRouter({ config, logger, mount: 'full' }));
  return a;
}

function stubConfigDb(extra = {}) {
  return buildMockDb([
    {
      // The agent-token middleware (auth/agent-token.js) reads the bundle
      // with a SELECT scoped to agent_token_* rows. Match it FIRST so the
      // lookup sees `agent_token_current: AGENT_TOKEN` even if a later
      // script also matches /system_config/i.
      match: /agent_token_(current|previous|rotated_at|previous_ttl_days)/i,
      rows: [{ config_key: 'agent_token_current', config_value: AGENT_TOKEN }]
    },
    {
      match: /system_config/i,
      rows: [
        { config_key: 'polling_interval_minutes', config_value: extra.polling ?? '15' },
        { config_key: 'latency_threshold_minutes', config_value: '180' },
        { config_key: 'heartbeat_interval_seconds', config_value: '5' },
        { config_key: 'discovery_interval_hours', config_value: '4' },
        { config_key: 'agent_token', config_value: AGENT_TOKEN },
        { config_key: 'agent_token_current', config_value: AGENT_TOKEN },
        { config_key: 'heartbeat_port', config_value: '8081' },
        { config_key: 'report_port', config_value: '8082' },
        { config_key: 'heartbeat_stale_seconds', config_value: '15' }
      ]
    }
  ]).standard();
}

test('GET /config.json returns 200 with ETag header for a valid agent token', async () => {
  _setDbForTest(stubConfigDb());
  const app = buildApp();
  const r = await supertest(app).get('/config.json').set('X-Agent-Token', AGENT_TOKEN);
  assert.equal(r.status, 200);
  assert.ok(r.body.heartbeatPort === 8081, 'body should contain the rendered config');
  const etag = r.headers.etag;
  assert.ok(typeof etag === 'string' && etag.length > 0, 'ETag header must be set');
  // Express emits a weak ETag of the form W/"<size>-<hash>". RFC 7232 allows
  // both weak and strong ETags for conditional GET; the agent side will
  // round-trip whatever the server sends, so the test just asserts the
  // shape is a valid ETag (opaque-tag inside double-quotes, optional W/ prefix).
  assert.match(etag, /^(W\/)?"[A-Za-z0-9_-]+"$/);
});

test('GET /config.json with matching If-None-Match returns 304 with no body', async () => {
  _setDbForTest(stubConfigDb());
  const app = buildApp();
  const first = await supertest(app).get('/config.json').set('X-Agent-Token', AGENT_TOKEN);
  assert.equal(first.status, 200);
  const etag = first.headers.etag;
  const second = await supertest(app).get('/config.json').set('X-Agent-Token', AGENT_TOKEN).set('If-None-Match', etag);
  assert.equal(second.status, 304);
  // Body must be empty on 304 — sending a body would be a contract bug.
  assert.equal(second.text, '');
});

test('GET /config.json with stale If-None-Match returns 200 + fresh body', async () => {
  _setDbForTest(stubConfigDb());
  const app = buildApp();
  const r = await supertest(app).get('/config.json').set('X-Agent-Token', AGENT_TOKEN).set('If-None-Match', '"definitely-not-the-current-etag"');
  assert.equal(r.status, 200);
  assert.equal(r.body.heartbeatPort, 8081);
  assert.ok(r.headers.etag && r.headers.etag !== '"definitely-not-the-current-etag"');
});

test('GET /config.json requires X-Agent-Token (auth unchanged)', async () => {
  _setDbForTest(stubConfigDb());
  const app = buildApp();
  const r = await supertest(app).get('/config.json');
  assert.equal(r.status, 401);
});

test('GET /config.json ETag is stable across requests with unchanged DB', async () => {
  _setDbForTest(stubConfigDb());
  const app = buildApp();
  const r1 = await supertest(app).get('/config.json').set('X-Agent-Token', AGENT_TOKEN);
  const r2 = await supertest(app).get('/config.json').set('X-Agent-Token', AGENT_TOKEN);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r1.headers.etag, r2.headers.etag, 'ETag must be stable when config has not changed');
});

test('GET /config.json ETag changes when a config row changes', async () => {
  // First fetch with the stub above.
  _setDbForTest(stubConfigDb());
  const app = buildApp();
  const r1 = await supertest(app).get('/config.json').set('X-Agent-Token', AGENT_TOKEN);
  const etag1 = r1.headers.etag;
  // Now swap the DB so a different value comes back.
  _setDbForTest(stubConfigDb({ polling: '30' }));
  const r2 = await supertest(app).get('/config.json').set('X-Agent-Token', AGENT_TOKEN);
  assert.notEqual(r2.headers.etag, etag1, 'ETag must change when underlying config changes');
});