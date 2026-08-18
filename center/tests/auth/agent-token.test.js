import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentToken, invalidateAgentTokenCache, _loadAgentTokenBundle } from '../../src/auth/agent-token.js';

// Minimal stub DB matching the interface agent-token.js reads.
function stubDb(bundle) {
  return {
    async query(_sql, _params) {
      const rows = [];
      if (bundle.current !== undefined)
        rows.push({ config_key: 'agent_token_current', config_value: bundle.current });
      if (bundle.previous !== undefined)
        rows.push({ config_key: 'agent_token_previous', config_value: bundle.previous });
      return { rows };
    }
  };
}

function buildReq(token) {
  return { headers: token ? { 'x-agent-token': token } : {} };
}

function buildRes() {
  let statusCode = 0;
  let jsonBody = null;
  return {
    status(c) { statusCode = c; return this; },
    json(b) { jsonBody = b; return this; },
    get statusCode() { return statusCode; },
    get body() { return jsonBody; }
  };
}

test('accepts the current token', async () => {
  invalidateAgentTokenCache();
  const mw = agentToken({ db: stubDb({ current: 'A', previous: '' }) });
  const req = buildReq('A');
  const res = buildRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(res.statusCode, 0);
});

test('accepts the previous token (rotation overlap)', async () => {
  invalidateAgentTokenCache();
  const mw = agentToken({ db: stubDb({ current: 'B', previous: 'A' }) });
  const req = buildReq('A');
  const res = buildRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(req._agentTokenMatchedPrevious, true);
});

test('rejects an unknown token', async () => {
  invalidateAgentTokenCache();
  const mw = agentToken({ db: stubDb({ current: 'B', previous: '' }) });
  const req = buildReq('Z');
  const res = buildRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
});

test('rejects when header is missing', async () => {
  invalidateAgentTokenCache();
  const mw = agentToken({ db: stubDb({ current: 'A', previous: '' }) });
  const req = buildReq(null);
  const res = buildRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
});

test('rejects empty-string header', async () => {
  invalidateAgentTokenCache();
  const mw = agentToken({ db: stubDb({ current: 'A', previous: '' }) });
  const req = buildReq('');
  const res = buildRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
});

test('caches the bundle across multiple requests', async () => {
  invalidateAgentTokenCache();
  let calls = 0;
  const db = {
    async query() { calls++; return { rows: [{ config_key: 'agent_token_current', config_value: 'A' }] }; }
  };
  const mw = agentToken({ db });
  await mw(buildReq('A'), buildRes(), () => {});
  await mw(buildReq('A'), buildRes(), () => {});
  await mw(buildReq('A'), buildRes(), () => {});
  assert.equal(calls, 1);
});

test('invalidateAgentTokenCache forces a reload', async () => {
  invalidateAgentTokenCache();
  let calls = 0;
  const db = {
    async query() { calls++; return { rows: [{ config_key: 'agent_token_current', config_value: 'A' }] }; }
  };
  const mw = agentToken({ db });
  await mw(buildReq('A'), buildRes(), () => {});
  assert.equal(calls, 1);
  invalidateAgentTokenCache();
  await mw(buildReq('A'), buildRes(), () => {});
  assert.equal(calls, 2);
});

test('_loadAgentTokenBundle returns both keys from rows', async () => {
  invalidateAgentTokenCache();
  const db = {
    async query() {
      return {
        rows: [
          { config_key: 'agent_token_current', config_value: 'A' },
          { config_key: 'agent_token_previous', config_value: 'B' }
        ]
      };
    }
  };
  const bundle = await _loadAgentTokenBundle(db);
  assert.equal(bundle.current, 'A');
  assert.equal(bundle.previous, 'B');
});

test('_loadAgentTokenBundle returns empty strings for missing rows', async () => {
  invalidateAgentTokenCache();
  const db = { async query() { return { rows: [] }; } };
  const bundle = await _loadAgentTokenBundle(db);
  assert.equal(bundle.current, '');
  assert.equal(bundle.previous, '');
});
