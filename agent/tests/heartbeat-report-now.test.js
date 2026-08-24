// 2026-08-24 round-12 (T7): heartbeat send callback consumes the center's
// reportRequested flag and arms a one-shot clear on the next payload call.
//
// T7 builds the agent-side wiring per spec. See T-fix for the follow-up that
// addresses the COALESCE bug at the center (this test exercises the spec
// behavior; the clear flag is set correctly, even though the center won't
// honor it until T-fix lands).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSendCallback, makePayload } from '../src/heartbeat-callbacks.js';

// Silent logger; tests don't care about log output.
const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

test('heartbeat send: reportRequested=true triggers scheduler._tick()', async () => {
  let tickCalled = 0;
  const fakeScheduler = { _tick: async () => { tickCalled++; } };

  let pendingClear = false;
  const send = makeSendCallback({
    postHeartbeat: async () => ({ ok: true, data: { reportRequested: true } }),
    applyAgentTokenDelivery: async () => {},
    scheduler: fakeScheduler,
    logger: silentLogger,
    getPendingClear: () => pendingClear,
    setPendingClear: (v) => { pendingClear = v; }
  });

  await send({ agentId: 'agent-1', pendingQueueSize: 0 });

  assert.equal(tickCalled, 1, 'scheduler._tick() must be called exactly once');
});

test('heartbeat send: reportRequested=false does NOT call scheduler._tick()', async () => {
  let tickCalled = 0;
  const fakeScheduler = { _tick: async () => { tickCalled++; } };

  let pendingClear = false;
  const send = makeSendCallback({
    postHeartbeat: async () => ({ ok: true, data: { reportRequested: false } }),
    applyAgentTokenDelivery: async () => {},
    scheduler: fakeScheduler,
    logger: silentLogger,
    getPendingClear: () => pendingClear,
    setPendingClear: (v) => { pendingClear = v; }
  });

  await send({ agentId: 'agent-1', pendingQueueSize: 0 });

  assert.equal(tickCalled, 0, 'scheduler._tick() must NOT be called when reportRequested is false');
});

test('heartbeat send: reportRequested unset does NOT call scheduler._tick()', async () => {
  // Defense-in-depth: older centers may not include the field at all.
  let tickCalled = 0;
  const fakeScheduler = { _tick: async () => { tickCalled++; } };

  let pendingClear = false;
  const send = makeSendCallback({
    postHeartbeat: async () => ({ ok: true, data: {} }),
    applyAgentTokenDelivery: async () => {},
    scheduler: fakeScheduler,
    logger: silentLogger,
    getPendingClear: () => pendingClear,
    setPendingClear: (v) => { pendingClear = v; }
  });

  await send({ agentId: 'agent-1', pendingQueueSize: 0 });

  assert.equal(tickCalled, 0, 'scheduler._tick() must NOT be called when reportRequested is absent');
});

test('heartbeat payload: after successful _tick, next payload carries report_requested_at: null', async () => {
  let pendingClear = false;

  // Step 1: trigger _tick via send (response says reportRequested: true).
  const send = makeSendCallback({
    postHeartbeat: async () => ({ ok: true, data: { reportRequested: true } }),
    applyAgentTokenDelivery: async () => {},
    scheduler: { _tick: async () => {} },
    logger: silentLogger,
    getPendingClear: () => pendingClear,
    setPendingClear: (v) => { pendingClear = v; }
  });
  await send({ agentId: 'agent-1' });

  assert.equal(pendingClear, true, 'send() must arm pendingReportRequestClear after _tick');

  // Step 2: build the next payload; expect report_requested_at: null + flag reset.
  const buildPayload = makePayload({
    getPendingClear: () => pendingClear,
    setPendingClear: (v) => { pendingClear = v; }
  });
  const payload = buildPayload({ agentId: 'agent-1', pendingQueueSize: 0 });

  assert.equal(payload.report_requested_at, null, 'payload must include report_requested_at: null');
  assert.equal(payload.agentId, 'agent-1', 'payload must preserve other fields');
  assert.equal(pendingClear, false, 'pendingReportRequestClear must reset after one-shot emission');
});

test('heartbeat payload: second payload after clear does NOT re-emit report_requested_at: null', async () => {
  let pendingClear = false;

  const send = makeSendCallback({
    postHeartbeat: async () => ({ ok: true, data: { reportRequested: true } }),
    applyAgentTokenDelivery: async () => {},
    scheduler: { _tick: async () => {} },
    logger: silentLogger,
    getPendingClear: () => pendingClear,
    setPendingClear: (v) => { pendingClear = v; }
  });
  await send({ agentId: 'agent-1' });

  const buildPayload = makePayload({
    getPendingClear: () => pendingClear,
    setPendingClear: (v) => { pendingClear = v; }
  });

  // First payload after _tick: should carry the null.
  const p1 = buildPayload({ agentId: 'agent-1', pendingQueueSize: 0 });
  assert.equal(p1.report_requested_at, null, 'first post-tick payload carries null');

  // Second payload: flag is reset, so report_requested_at must be absent.
  const p2 = buildPayload({ agentId: 'agent-1', pendingQueueSize: 0 });
  assert.ok(!('report_requested_at' in p2), 'second payload must not include report_requested_at');
});

test('heartbeat send: failed _tick keeps flag unset (so it can retry next heartbeat)', async () => {
  let pendingClear = false;

  const send = makeSendCallback({
    postHeartbeat: async () => ({ ok: true, data: { reportRequested: true } }),
    applyAgentTokenDelivery: async () => {},
    scheduler: { _tick: async () => { throw new Error('boom'); } },
    logger: silentLogger,
    getPendingClear: () => pendingClear,
    setPendingClear: (v) => { pendingClear = v; }
  });

  await send({ agentId: 'agent-1' });

  // Failed tick must NOT arm the clear — we want to retry on the next heartbeat.
  assert.equal(pendingClear, false, 'pendingReportRequestClear must stay false when _tick throws');

  const buildPayload = makePayload({
    getPendingClear: () => pendingClear,
    setPendingClear: (v) => { pendingClear = v; }
  });
  const payload = buildPayload({ agentId: 'agent-1', pendingQueueSize: 0 });
  assert.ok(!('report_requested_at' in payload), 'payload must not carry null when no successful _tick');
});

test('heartbeat payload: with no pending clear, payload is returned untouched (no null field added)', async () => {
  let pendingClear = false;

  const buildPayload = makePayload({
    getPendingClear: () => pendingClear,
    setPendingClear: (v) => { pendingClear = v; }
  });

  const payload = buildPayload({ agentId: 'agent-1', pendingQueueSize: 0 });
  assert.ok(!('report_requested_at' in payload), 'payload must not gain report_requested_at when flag is false');
});