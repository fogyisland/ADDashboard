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

function buildReq(token, { path, agentId } = {}) {
  const headers = token ? { 'x-agent-token': token } : {};
  if (agentId !== undefined) headers['x-agent-id'] = agentId;
  return { headers, path: path ?? '/api/agent/heartbeat' };
}

// Records warn() calls the way pino would receive them: (fields, message).
function recordingLogger() {
  const warns = [];
  return {
    warns,
    info() {},
    error() {},
    debug() {},
    warn(fields, msg) { warns.push({ fields, msg }); }
  };
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

// ---- I3 Task 7 fix: previous-token match must emit a warn (spec §5) ----
// The warn line is the operator's only per-agent signal that some agent is
// still presenting the old token — without it there is no safe moment to
// click "commit" (the GET state endpoint only reports that the window is
// open, not which agents are behind).

test('emits a warn with path + agentId on a previous-token match', async () => {
  invalidateAgentTokenCache();
  const logger = recordingLogger();
  const mw = agentToken({ db: stubDb({ current: 'B', previous: 'A' }), logger });
  const req = buildReq('A', { path: '/api/agent/heartbeat', agentId: 'dc01' });
  const res = buildRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(logger.warns.length, 1);
  assert.deepEqual(logger.warns[0].fields, { path: '/api/agent/heartbeat', agentId: 'dc01' });
  assert.equal(typeof logger.warns[0].msg, 'string');
  assert.ok(logger.warns[0].msg.length > 0);
});

test('previous-token warn never carries the token or its length', async () => {
  invalidateAgentTokenCache();
  const logger = recordingLogger();
  const mw = agentToken({ db: stubDb({ current: 'newtok', previous: 'oldtok' }), logger });
  await mw(buildReq('oldtok', { path: '/api/agent/ports', agentId: 'dc02' }), buildRes(), () => {});
  assert.equal(logger.warns.length, 1);
  const serialized = JSON.stringify(logger.warns[0]);
  assert.equal(serialized.includes('oldtok'), false);
  assert.equal(serialized.includes('newtok'), false);
  assert.equal(Object.keys(logger.warns[0].fields).sort().join(','), 'agentId,path');
});

test('does NOT warn on a current-token match', async () => {
  invalidateAgentTokenCache();
  const logger = recordingLogger();
  const mw = agentToken({ db: stubDb({ current: 'B', previous: 'A' }), logger });
  const req = buildReq('B', { path: '/api/agent/heartbeat', agentId: 'dc01' });
  const res = buildRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(logger.warns.length, 0);
});

test('does NOT warn on a rejected token', async () => {
  invalidateAgentTokenCache();
  const logger = recordingLogger();
  const mw = agentToken({ db: stubDb({ current: 'B', previous: 'A' }), logger });
  const res = buildRes();
  await mw(buildReq('Z', { agentId: 'dc03' }), res, () => {});
  assert.equal(res.statusCode, 401);
  assert.equal(logger.warns.length, 0);
});

test('previous-token match with no logger does not throw', async () => {
  invalidateAgentTokenCache();
  const mw = agentToken({ db: stubDb({ current: 'B', previous: 'A' }) });
  const req = buildReq('A', { agentId: 'dc04' });
  const res = buildRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(req._agentTokenMatchedPrevious, true);
});

test('previous-token match with a logger lacking warn() does not throw', async () => {
  invalidateAgentTokenCache();
  const mw = agentToken({ db: stubDb({ current: 'B', previous: 'A' }), logger: { info() {} } });
  const req = buildReq('A', { agentId: 'dc05' });
  const res = buildRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, true);
});

test('warn fires once per previous-token request (cached bundle)', async () => {
  invalidateAgentTokenCache();
  const logger = recordingLogger();
  const mw = agentToken({ db: stubDb({ current: 'B', previous: 'A' }), logger });
  await mw(buildReq('A', { agentId: 'dc06' }), buildRes(), () => {});
  await mw(buildReq('A', { agentId: 'dc06' }), buildRes(), () => {});
  await mw(buildReq('B', { agentId: 'dc07' }), buildRes(), () => {});
  assert.equal(logger.warns.length, 2);
});
