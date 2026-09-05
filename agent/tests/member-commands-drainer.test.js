// 2026-09-05 R81 — Unit tests for the member-commands drainer.
//
// Mirrors tests/ad-commands-drainer.test.js (R78). Pure-function
// shape: hostname / token / centerUrl / http helpers / dispatcher are
// injected, so tests don't need a live agent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drainMemberCommands } from '../src/member-commands-drainer.js';

const silentLogger = () => ({
  info() {}, warn() {}, error() {}, debug() {}
});

function capturingLogger() {
  const captured = { info: [], warn: [], error: [] };
  return {
    info: (...args) => captured.info.push(args),
    warn: (...args) => captured.warn.push(args),
    error: (...args) => captured.error.push(args),
    debug: () => {},
    captured
  };
}

const baseDeps = () => ({
  hostname: 'HOST1',
  token: 't-1',
  centerUrl: 'http://center.local',
  logger: silentLogger(),
  httpGetJson: async () => ({ ok: true, status: 200, data: { commands: [] } }),
  httpPostJson: async () => ({ ok: true, status: 200, data: {} }),
  dispatchMemberCommand: async () => ({ success: true, data: {}, error: null, exitCode: 0, durationMs: 1 })
});

// ── happy path ──────────────────────────────────────────────────────────

test('drainMemberCommands: drains nothing when queue is empty', async () => {
  const out = await drainMemberCommands(baseDeps());
  assert.deepEqual(out, { processed: 0, succeeded: 0, failed: 0 });
});

test('drainMemberCommands: dispatches claimed commands + acks each', async () => {
  const deps = baseDeps();
  const dispatched = [];
  deps.httpGetJson = async () => ({
    ok: true,
    status: 200,
    data: {
      commands: [
        { id: 1, commandType: 'member_script', params: { script: 'Get-Date', timeoutSec: 5 } },
        { id: 2, commandType: 'member_script', params: { script: 'whoami', timeoutSec: 5 } }
      ]
    }
  });
  deps.dispatchMemberCommand = async ({ commandType, params }) => {
    dispatched.push({ commandType, params });
    return { success: true, data: { stdout: 'ok', stderr: '', exitCode: 0, durationMs: 5 }, error: null, exitCode: 0, durationMs: 5 };
  };
  const acks = [];
  deps.httpPostJson = async ({ url, body }) => {
    acks.push({ url, body });
    return { ok: true, status: 200, data: {} };
  };
  const out = await drainMemberCommands(deps);
  assert.equal(out.processed, 2);
  assert.equal(out.succeeded, 2);
  assert.equal(out.failed, 0);
  assert.equal(dispatched.length, 2);
  assert.equal(acks.length, 2);
  assert.match(acks[0].url, /\/api\/agent\/member-commands\/1\/result/);
  assert.match(acks[1].url, /\/api\/agent\/member-commands\/2\/result/);
  assert.equal(acks[0].body.success, true);
});

test('drainMemberCommands: counts failed dispatch separately from successful', async () => {
  const deps = baseDeps();
  deps.httpGetJson = async () => ({
    ok: true,
    status: 200,
    data: {
      commands: [
        { id: 1, commandType: 'member_script', params: { script: 'ok' } },
        { id: 2, commandType: 'member_script', params: { script: 'fail' } }
      ]
    }
  });
  deps.dispatchMemberCommand = async ({ params }) => {
    if (params.script === 'fail') {
      return { success: false, data: null, error: 'simulated failure', exitCode: 1, durationMs: 1 };
    }
    return { success: true, data: {}, error: null, exitCode: 0, durationMs: 1 };
  };
  const out = await drainMemberCommands(deps);
  assert.equal(out.processed, 2);
  assert.equal(out.succeeded, 1);
  assert.equal(out.failed, 1);
});

// ── error paths ─────────────────────────────────────────────────────────

test('drainMemberCommands: missing hostname → error + zero counters', async () => {
  const deps = baseDeps();
  deps.hostname = '';
  const out = await drainMemberCommands(deps);
  assert.match(out.error, /hostname required/);
  assert.equal(out.processed, 0);
});

test('drainMemberCommands: missing http helpers → error', async () => {
  const deps = baseDeps();
  deps.httpGetJson = null;
  const out = await drainMemberCommands(deps);
  assert.match(out.error, /httpGetJson\/httpPostJson required/);
});

test('drainMemberCommands: missing dispatchMemberCommand → error', async () => {
  const deps = baseDeps();
  deps.dispatchMemberCommand = null;
  const out = await drainMemberCommands(deps);
  assert.match(out.error, /dispatchMemberCommand required/);
});

test('drainMemberCommands: poll HTTP 503 logged + returns 0', async () => {
  const deps = baseDeps();
  const logger = capturingLogger();
  deps.logger = logger;
  deps.httpGetJson = async () => ({ ok: false, status: 503, data: null });
  const out = await drainMemberCommands(deps);
  assert.equal(out.status, 503);
  assert.equal(out.processed, 0);
  assert.equal(logger.captured.warn.length, 1);
});

test('drainMemberCommands: poll HTTP 404 silently swallowed (boot race)', async () => {
  const deps = baseDeps();
  const logger = capturingLogger();
  deps.logger = logger;
  deps.httpGetJson = async () => ({ ok: false, status: 404, data: null });
  const out = await drainMemberCommands(deps);
  assert.equal(out.status, 404);
  assert.equal(logger.captured.warn.length, 0, '404 is a known boot race — no warn');
});

test('drainMemberCommands: poll throws → logged + returns error', async () => {
  const deps = baseDeps();
  const logger = capturingLogger();
  deps.logger = logger;
  deps.httpGetJson = async () => { throw new Error('ECONNREFUSED'); };
  const out = await drainMemberCommands(deps);
  assert.match(out.error, /ECONNREFUSED/);
  assert.equal(logger.captured.warn.length, 1);
});

test('drainMemberCommands: ack POST fails → logged at warn but processed still counted', async () => {
  const deps = baseDeps();
  const logger = capturingLogger();
  deps.logger = logger;
  deps.httpGetJson = async () => ({
    ok: true, status: 200, data: { commands: [
      { id: 5, commandType: 'member_script', params: { script: 'ok' } }
    ]}
  });
  deps.httpPostJson = async () => ({ ok: false, status: 500, data: null });
  const out = await drainMemberCommands(deps);
  assert.equal(out.processed, 1, 'processed counts even if ack fails');
  assert.equal(out.succeeded, 1);
  assert.equal(logger.captured.warn.length, 1);
});