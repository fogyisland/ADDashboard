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

function buildReq(token, { path, agentId, signed = true } = {}) {
  // 2026-09-09 S82 — agent identity binding. Each request carries an
  // X-Agent-Signature derived from (hostname, agentId, body, token).
  // Older tests didn't know about signatures — they relied on the 60s
  // restart grace window. Now we sign by default so tests behave
  // consistently regardless of grace-window timing.
  const headers = token ? { 'x-agent-token': token } : {};
  if (agentId !== undefined) headers['x-agent-id'] = agentId;
  if (token && signed) {
    headers['x-agent-signature'] = _sign({
      token,
      hostname: '',
      agentId: agentId || '',
      body: null
    });
  }
  return { headers, path: path ?? '/api/agent/heartbeat' };
}

// 2026-09-09 S82 — helper for tests that need to opt OUT of signing
// (so they exercise the unsigned-grace path explicitly).
function buildUnsignedReq(token, opts = {}) {
  return buildReq(token, { ...opts, signed: false });
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
  // 2026-09-09 S82 — push restart marker far into the past so the
  // unsigned-request grace window doesn't fire a second warn (which
  // would make logger.warns.length = 2 instead of 1).
  _resetIdentityGraceForTests(Date.now() - 120_000);
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
  _resetIdentityGraceForTests(Date.now() - 120_000);
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
  _resetIdentityGraceForTests(Date.now() - 120_000);
  const logger = recordingLogger();
  const mw = agentToken({ db: stubDb({ current: 'B', previous: 'A' }), logger });
  const req = buildReq('B', { path: '/api/agent/heartbeat', agentId: 'dc01' });
  const res = buildRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(logger.warns.length, 0);
});

// ── 2026-09-09 S82 (security) — agent identity binding ──────────────────────

import { _resetIdentityGraceForTests } from '../../src/auth/agent-token.js';
import { createHmac } from 'node:crypto';

// Mirror the agent's stable-json + HMAC computation. Keep in sync with
// agent/src/lib/agent-identity.js — if these diverge, every signed
// request from a real agent 401s.
function _stableJson(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(_stableJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + _stableJson(value[k])).join(',') + '}';
}
function _sign({ token, hostname, agentId, body }) {
  const bodyStr = body == null ? '' : _stableJson(body);
  return createHmac('sha256', token).update(`${hostname}:${agentId}:${bodyStr}`).digest('hex');
}

function buildSignedReq(token, { agentId, hostname, body, withSig = true } = {}) {
  // Build the headers + body together so the signature matches the body
  // the server will recompute from.
  const headers = { 'x-agent-token': token };
  if (agentId) headers['x-agent-id'] = agentId;
  if (hostname) headers['x-agent-hostname'] = hostname;
  if (withSig) {
    headers['x-agent-signature'] = _sign({
      token,
      hostname: hostname || '',
      agentId: agentId || '',
      body
    });
  }
  return { headers, path: '/api/agent/heartbeat', body };
}

test('S82: signed request with matching (hostname, agentId) → accepted', async () => {
  invalidateAgentTokenCache();
  _resetIdentityGraceForTests(Date.now() - 120_000); // grace already expired
  const mw = agentToken({ db: stubDb({ current: 'TOK', previous: '' }) });
  const body = { agentId: 'agent-1', hostname: 'host-A' };
  const req = buildSignedReq('TOK', { agentId: 'agent-1', hostname: 'host-A', body });
  const res = buildRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.deepEqual(req._agentIdentityBound, { hostname: 'host-A', agentId: 'agent-1' });
});

test('S82: same token + hostname=B claim → 401 (impersonation guard)', async () => {
  invalidateAgentTokenCache();
  _resetIdentityGraceForTests(Date.now() - 120_000); // grace expired
  const mw = agentToken({ db: stubDb({ current: 'TOK', previous: '' }) });
  // Body says host-A (signed for host-A), but headers try to claim host-B
  // via x-agent-hostname. The middleware reads hostname from body FIRST,
  // so signature still matches body host-A; an attacker would need to
  // re-sign with host-B to pass — which they can't without the token.
  // So the only way to "claim" host-B is to send a body whose hostname=B,
  // AND that body has to be signed with host-B. An attacker doesn't have
  // the token so they can't sign.
  const body = { agentId: 'agent-1', hostname: 'host-B' }; // attacker tries B
  // Sign with the WRONG hostname to simulate: attacker re-signed with host-A
  // but body claims host-B → mismatch → reject.
  const wrongSig = _sign({ token: 'TOK', hostname: 'host-A', agentId: 'agent-1', body });
  const headers = {
    'x-agent-token': 'TOK',
    'x-agent-signature': wrongSig,
    'x-agent-hostname': 'host-A',
    'x-agent-id': 'agent-1'
  };
  const req = { headers, path: '/api/agent/heartbeat', body };
  const res = buildRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
  assert.match(res.body.error, /identity mismatch/);
});

test('S82: unsigned request within 60s grace → accepted with warn', async () => {
  invalidateAgentTokenCache();
  _resetIdentityGraceForTests(Date.now()); // restart just happened
  const logger = recordingLogger();
  const mw = agentToken({ db: stubDb({ current: 'TOK', previous: '' }), logger });
  const req = buildSignedReq('TOK', { withSig: false });
  const res = buildRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(logger.warns.length >= 1, true, 'grace-window unsigned must emit a warn');
  const lastWarn = logger.warns[logger.warns.length - 1];
  assert.match(lastWarn.msg, /grace/);
});

test('S82: unsigned request after 60s grace → 401', async () => {
  invalidateAgentTokenCache();
  _resetIdentityGraceForTests(Date.now() - 120_000); // grace expired
  const mw = agentToken({ db: stubDb({ current: 'TOK', previous: '' }) });
  const req = buildSignedReq('TOK', { withSig: false });
  const res = buildRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'missing agent signature');
});

test('S82: signature mismatch (token=A signs for host-A, attacker sends with host-B body) → 401', async () => {
  invalidateAgentTokenCache();
  _resetIdentityGraceForTests(Date.now() - 120_000);
  const mw = agentToken({ db: stubDb({ current: 'TOK', previous: '' }) });
  // Sign body claiming host-A but flip body hostname to host-B AFTER.
  const originalBody = { agentId: 'agent-1', hostname: 'host-A' };
  const sig = _sign({ token: 'TOK', hostname: 'host-A', agentId: 'agent-1', body: originalBody });
  const tamperedBody = { agentId: 'agent-1', hostname: 'host-B' };
  const headers = {
    'x-agent-token': 'TOK',
    'x-agent-signature': sig,
    'x-agent-id': 'agent-1'
  };
  const req = { headers, path: '/api/agent/heartbeat', body: tamperedBody };
  const res = buildRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
  assert.match(res.body.error, /identity mismatch/);
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
  _resetIdentityGraceForTests(Date.now() - 120_000);
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
  _resetIdentityGraceForTests(Date.now() - 120_000);
  const mw = agentToken({ db: stubDb({ current: 'B', previous: 'A' }), logger: { info() {} } });
  const req = buildReq('A', { agentId: 'dc05' });
  const res = buildRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, true);
});

test('warn fires once per previous-token request (cached bundle)', async () => {
  invalidateAgentTokenCache();
  _resetIdentityGraceForTests(Date.now() - 120_000);
  const logger = recordingLogger();
  const mw = agentToken({ db: stubDb({ current: 'B', previous: 'A' }), logger });
  await mw(buildReq('A', { agentId: 'dc06' }), buildRes(), () => {});
  await mw(buildReq('A', { agentId: 'dc06' }), buildRes(), () => {});
  await mw(buildReq('B', { agentId: 'dc07' }), buildRes(), () => {});
  assert.equal(logger.warns.length, 2);
});

// 2026-09-22 S82 hotfix — express.json() sets req.body = {} for GET
// requests with no body. Real agents (and mock-daemon) sign GETs with
// body: null, producing ''. The server must normalize {} → '' so the
// signatures match. Without this, GET /api/agent/ports (and every other
// GET on the heartbeat/report app) 401s with 'identity mismatch' after
// the 60s restart grace window.
test('S82 GET-empty-body: signed with body=null, server sees body={} → accepted', async () => {
  invalidateAgentTokenCache();
  _resetIdentityGraceForTests(Date.now() - 120_000); // grace expired
  const mw = agentToken({ db: stubDb({ current: 'TOK', previous: '' }) });
  const sig = _sign({ token: 'TOK', hostname: '', agentId: '', body: null });
  const headers = {
    'x-agent-token': 'TOK',
    'x-agent-signature': sig
  };
  // express.json() sets req.body = {} for GETs without a body parser payload.
  const req = { headers, path: '/api/agent/ports', body: {} };
  const res = buildRes();
  let called = false;
  await mw(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.notEqual(res.statusCode, 401);
});
