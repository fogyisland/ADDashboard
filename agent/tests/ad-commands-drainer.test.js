// 2026-09-04 R78 — unit tests for the AD-commands drainer.
//
// Mirrors dispatchers-ad-admin.test.js's hand-rolled fake dispatcher
// pattern. The drainer is pure-functional: every external surface
// (httpGetJson / httpPostJson / dispatchAdCommand) is injected, so
// we can drive it end-to-end with stubs that record calls + synthesize
// canned responses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drainAdCommands, __testing } from '../src/ad-commands-drainer.js';

function silentLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

function capturingLogger() {
  const calls = [];
  const make = (level) => (obj, msg) => calls.push({ level, obj, msg });
  return { calls, info: make('info'), warn: make('warn'), error: make('error'), debug: make('debug') };
}

const baseDeps = () => ({
  hostname: 'DC1',
  token: 'agent-tok',
  centerUrl: 'http://center:8080',
  dispatchAdCommand: async () => ({ success: true, data: null, error: null, exitCode: 0, durationMs: 12 }),
});

test('drainAdCommands: happy path — poll 2 commands, dispatch each, POST 2 results', async () => {
  const getCalls = [];
  const postCalls = [];
  const dispatchCalls = [];
  const dispatchAdCommand = async (args) => {
    dispatchCalls.push(args);
    return { success: true, data: { ok: args.commandType }, error: null, exitCode: 0, durationMs: 7 };
  };
  const httpGetJson = async (args) => {
    getCalls.push(args);
    return {
      ok: true,
      status: 200,
      data: {
        commands: [
          { id: 11, commandType: 'user_enable', params: { sam: 'jdoe' } },
          { id: 12, commandType: 'user_password_reset', params: { sam: 'jdoe', newPassword: 'secret' } },
        ],
      },
    };
  };
  const httpPostJson = async (args) => {
    postCalls.push(args);
    return { ok: true, status: 200, data: { ok: true } };
  };

  const r = await drainAdCommands({
    ...baseDeps(),
    httpGetJson,
    httpPostJson,
    dispatchAdCommand,
    logger: silentLogger(),
  });

  assert.equal(r.processed, 2);
  assert.equal(r.succeeded, 2);
  assert.equal(r.failed, 0);
  assert.equal(getCalls.length, 1, 'one poll');
  assert.match(getCalls[0].url, /\/api\/agent\/ad-commands\?hostname=DC1/);
  assert.match(getCalls[0].url, /limit=/);
  assert.equal(getCalls[0].headers['X-Agent-Token'], 'agent-tok');
  assert.equal(dispatchCalls.length, 2, 'one dispatch per row');
  assert.equal(dispatchCalls[0].commandType, 'user_enable');
  assert.deepEqual(dispatchCalls[0].params, { sam: 'jdoe' });
  assert.equal(dispatchCalls[1].commandType, 'user_password_reset');
  assert.deepEqual(dispatchCalls[1].params, { sam: 'jdoe', newPassword: 'secret' });
  assert.equal(postCalls.length, 2, 'one ack per row');
  assert.match(postCalls[0].url, /\/api\/agent\/ad-commands\/11\/result$/);
  assert.match(postCalls[1].url, /\/api\/agent\/ad-commands\/12\/result$/);
  assert.deepEqual(postCalls[0].body.success, true);
  assert.equal(postCalls[0].body.durationMs, 7);
  assert.deepEqual(postCalls[1].body.success, true);
  assert.equal(postCalls[1].body.durationMs, 7);
});

test('drainAdCommands: empty response → no dispatch + return {processed:0}', async () => {
  const dispatchCalls = [];
  const postCalls = [];
  const httpGetJson = async () => ({ ok: true, status: 200, data: { commands: [] } });
  const httpPostJson = async (a) => { postCalls.push(a); return { ok: true }; };
  const dispatchAdCommand = async (a) => { dispatchCalls.push(a); return { success: true, data: null, error: null, exitCode: 0, durationMs: 1 }; };

  const r = await drainAdCommands({
    ...baseDeps(),
    httpGetJson, httpPostJson, dispatchAdCommand,
    logger: silentLogger(),
  });
  assert.equal(r.processed, 0);
  assert.equal(r.succeeded, 0);
  assert.equal(r.failed, 0);
  assert.equal(dispatchCalls.length, 0);
  assert.equal(postCalls.length, 0);
});

test('drainAdCommands: missing commands array → no dispatch + return {processed:0}', async () => {
  // Defensive: a misbehaving center that returns 200 but no `commands`
  // field should not crash the drainer. Treat as empty queue.
  const dispatchCalls = [];
  const httpGetJson = async () => ({ ok: true, status: 200, data: {} });
  const httpPostJson = async () => ({ ok: true });
  const dispatchAdCommand = async (a) => { dispatchCalls.push(a); return { success: true, data: null, error: null, exitCode: 0, durationMs: 1 }; };

  const r = await drainAdCommands({
    ...baseDeps(),
    httpGetJson, httpPostJson, dispatchAdCommand,
    logger: silentLogger(),
  });
  assert.equal(r.processed, 0);
  assert.equal(dispatchCalls.length, 0);
});

test('drainAdCommands: dispatchAdCommand returns success:false → still POST result with success:false', async () => {
  const postCalls = [];
  const httpGetJson = async () => ({
    ok: true, status: 200,
    data: { commands: [{ id: 21, commandType: 'user_enable', params: { sam: 'x' } }] }
  });
  const httpPostJson = async (args) => { postCalls.push(args); return { ok: true }; };
  const dispatchAdCommand = async () => ({
    success: false, data: null, error: 'PS1 exit 1: access denied',
    exitCode: 1, durationMs: 5
  });

  const r = await drainAdCommands({
    ...baseDeps(),
    httpGetJson, httpPostJson, dispatchAdCommand,
    logger: silentLogger(),
  });
  assert.equal(r.processed, 1);
  assert.equal(r.succeeded, 0);
  assert.equal(r.failed, 1);
  assert.equal(postCalls.length, 1);
  assert.deepEqual(postCalls[0].body.success, false);
  assert.equal(postCalls[0].body.error, 'PS1 exit 1: access denied');
  assert.equal(postCalls[0].body.exitCode, 1);
});

test('drainAdCommands: httpPostJson throws → log + return; does NOT crash', async () => {
  const logger = capturingLogger();
  const httpGetJson = async () => ({
    ok: true, status: 200,
    data: { commands: [{ id: 31, commandType: 'user_enable', params: { sam: 'x' } }] }
  });
  const httpPostJson = async () => { throw new Error('socket hangup'); };
  const dispatchAdCommand = async () => ({ success: true, data: null, error: null, exitCode: 0, durationMs: 1 });

  const r = await drainAdCommands({
    ...baseDeps(),
    httpGetJson, httpPostJson, dispatchAdCommand, logger,
  });
  // The drainer still counts processed (it attempted the dispatch) but
  // does not crash; the next heartbeat will re-poll. The throw is
  // logged at warn level so an operator scanning the log sees it.
  assert.equal(r.processed, 1);
  assert.equal(r.succeeded, 1, 'dispatch itself succeeded; only the ack POST failed');
  assert.equal(r.failed, 0, 'failure metric tracks dispatch failures, not ack POST failures');
  const warn = logger.calls.find(c => c.level === 'warn' && c.obj?.err?.includes?.('socket hangup'));
  assert.ok(warn, 'socket hangup must be logged at warn');
});

test('drainAdCommands: httpPostJson returns !ok → log + return; does NOT throw', async () => {
  const logger = capturingLogger();
  const httpGetJson = async () => ({
    ok: true, status: 200,
    data: { commands: [{ id: 41, commandType: 'user_enable', params: { sam: 'x' } }] }
  });
  const httpPostJson = async () => ({ ok: false, status: 500, data: { error: 'internal' } });
  const dispatchAdCommand = async () => ({ success: true, data: null, error: null, exitCode: 0, durationMs: 1 });

  const r = await drainAdCommands({
    ...baseDeps(),
    httpGetJson, httpPostJson, dispatchAdCommand, logger,
  });
  assert.equal(r.processed, 1);
  const warn = logger.calls.find(c => c.level === 'warn' && c.obj?.status === 500);
  assert.ok(warn, 'non-2xx ack POST must be logged at warn');
});

test('drainAdCommands: poll returns 404 → silently return {processed:0} (no warn)', async () => {
  // The route may not be mounted during centre boot; the operator
  // shouldn't see a flood of warns during that window.
  const logger = capturingLogger();
  const httpGetJson = async () => ({ ok: false, status: 404, data: null });
  const httpPostJson = async () => ({ ok: true });
  const dispatchAdCommand = async () => ({ success: true, data: null, error: null, exitCode: 0, durationMs: 1 });

  const r = await drainAdCommands({
    ...baseDeps(),
    httpGetJson, httpPostJson, dispatchAdCommand, logger,
  });
  assert.equal(r.processed, 0);
  assert.equal(r.status, 404);
  const warn = logger.calls.find(c => c.level === 'warn');
  assert.equal(warn, undefined, '404 poll must NOT log at warn (boot-time expected)');
});

test('drainAdCommands: poll returns 500 → log at warn + return {processed:0}', async () => {
  const logger = capturingLogger();
  const httpGetJson = async () => ({ ok: false, status: 500, data: null });
  const httpPostJson = async () => ({ ok: true });
  const dispatchAdCommand = async () => ({ success: true, data: null, error: null, exitCode: 0, durationMs: 1 });

  await drainAdCommands({
    ...baseDeps(),
    httpGetJson, httpPostJson, dispatchAdCommand, logger,
  });
  const warn = logger.calls.find(c => c.level === 'warn' && c.obj?.status === 500);
  assert.ok(warn, 'non-404 non-2xx poll must log at warn');
});

test('drainAdCommands: poll throws → log + return {processed:0, error}', async () => {
  const logger = capturingLogger();
  const httpGetJson = async () => { throw new Error('ECONNREFUSED'); };
  const httpPostJson = async () => ({ ok: true });
  const dispatchAdCommand = async () => ({ success: true, data: null, error: null, exitCode: 0, durationMs: 1 });

  const r = await drainAdCommands({
    ...baseDeps(),
    httpGetJson, httpPostJson, dispatchAdCommand, logger,
  });
  assert.equal(r.processed, 0);
  assert.match(r.error, /ECONNREFUSED/);
  const warn = logger.calls.find(c => c.level === 'warn');
  assert.ok(warn, 'poll throw must be logged');
});

test('drainAdCommands: missing hostname → return error, no HTTP calls', async () => {
  const getCalls = [];
  const httpGetJson = async (a) => { getCalls.push(a); return { ok: true, data: { commands: [] } }; };
  const r = await drainAdCommands({
    hostname: '',
    token: 't', centerUrl: 'http://x',
    httpGetJson, httpPostJson: async () => ({}), dispatchAdCommand: async () => ({}),
    logger: silentLogger(),
  });
  assert.equal(r.processed, 0);
  assert.match(r.error, /hostname/);
  assert.equal(getCalls.length, 0);
});

test('drainAdCommands: missing httpGetJson/httpPostJson → return error', async () => {
  const r = await drainAdCommands({
    hostname: 'X',
    token: 't', centerUrl: 'http://x',
    dispatchAdCommand: async () => ({}),
    logger: silentLogger(),
  });
  assert.equal(r.processed, 0);
  assert.match(r.error, /httpGetJson/);
});

test('drainAdCommands: missing dispatchAdCommand → return error', async () => {
  const r = await drainAdCommands({
    hostname: 'X',
    token: 't', centerUrl: 'http://x',
    httpGetJson: async () => ({ ok: true, data: { commands: [] } }),
    httpPostJson: async () => ({}),
    logger: silentLogger(),
  });
  assert.equal(r.processed, 0);
  assert.match(r.error, /dispatchAdCommand/);
});

test('drainAdCommands: __testing export re-exports drainAdCommands', () => {
  assert.equal(typeof __testing.drainAdCommands, 'function');
  assert.equal(__testing.drainAdCommands, drainAdCommands);
});