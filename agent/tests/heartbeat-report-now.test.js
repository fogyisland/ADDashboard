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

test('heartbeat send: failed _tick keeps flag unset when the fan-out itself throws (pre-Promise setup bug)', async () => {
  // 2026-08-25 round-12 report-now fan-out: the clear-flag semantic changed.
  // Old: failed _tick → don't arm, retry on next heartbeat.
  // New (per user spec: each collector independent, fan-out completion = arm):
  //   - Promise.allSettled absorbs per-collector rejections → arms clear
  //   - Sync throw from BEFORE Promise.allSettled (rare — e.g., a missing
  //     scheduler getter) → don't arm, retry on next heartbeat
  //
  // This test exercises the rare pre-Promise path: when the getScheduler()
  // getter itself throws synchronously (a setup bug), the flag stays unset
  // so the next heartbeat retries.
  let pendingClear = false;
  // Wire a scheduler getter that throws synchronously when accessed. This
  // triggers a synchronous throw inside the try block BEFORE Promise.allSettled
  // can absorb it — the original "fail = don't arm" defense.
  const buggySchedulerGetter = {
    get _tick() { throw new Error('boom'); }
  };

  const send = makeSendCallback({
    postHeartbeat: async () => ({ ok: true, data: { reportRequested: true } }),
    applyAgentTokenDelivery: async () => {},
    scheduler: buggySchedulerGetter,
    logger: silentLogger,
    getPendingClear: () => pendingClear,
    setPendingClear: (v) => { pendingClear = v; }
  });

  await send({ agentId: 'agent-1' });

  // Pre-Promise sync throw → flag stays unset → next heartbeat retries.
  assert.equal(pendingClear, false, 'pendingReportRequestClear must stay false when the scheduler getter itself throws');

  const buildPayload = makePayload({
    getPendingClear: () => pendingClear,
    setPendingClear: (v) => { pendingClear = v; }
  });
  const payload = buildPayload({ agentId: 'agent-1', pendingQueueSize: 0 });
  assert.ok(!('report_requested_at' in payload), 'payload must not carry null when no successful fan-out');
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

// ============================================================================
// 2026-08-25 round-12 report-now fan-out: when reportRequested=true, the
// heartbeat callback must trigger all THREE collectors in parallel
// (replication + discovery + packages) and arm clear once all settle.
// Each collector is independent — per-collector rejection does NOT block
// the other two or prevent the clear arming.
// ============================================================================

test('report-now fan-out: triggers scheduler._tick + discovery.run + runPackages in parallel', async () => {
  let tickCalled = 0;
  let discoveryCalled = 0;
  let packagesCalled = 0;
  // Track relative ordering via a shared counter — strict === true check
  // would race the JS event loop too tightly to be reliable; what matters
  // is that all three are entered before any of them awaits its I/O.
  let inFlight = 0;
  let maxInFlight = 0;

  const makeGate = () => {
    let release;
    const gate = new Promise(r => { release = r; });
    return { gate, release };
  };
  const tickGate = makeGate();
  const discoveryGate = makeGate();
  const packagesGate = makeGate();

  const fakeScheduler = {
    _tick: async () => {
      tickCalled++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await tickGate.gate;
      inFlight--;
    }
  };
  const fakeDiscovery = {
    run: async () => {
      discoveryCalled++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await discoveryGate.gate;
      inFlight--;
    }
  };
  const fakePackages = async () => {
    packagesCalled++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await packagesGate.gate;
    inFlight--;
  };

  let pendingClear = false;
  const send = makeSendCallback({
    postHeartbeat: async () => ({ ok: true, data: { reportRequested: true } }),
    applyAgentTokenDelivery: async () => {},
    scheduler: fakeScheduler,
    logger: silentLogger,
    getPendingClear: () => pendingClear,
    setPendingClear: (v) => { pendingClear = v; },
    runDiscovery: () => fakeDiscovery.run(),
    runPackages: fakePackages
  });

  const p = send({ agentId: 'agent-1', pendingQueueSize: 0 });

  // Let each collector enter. setImmediate x3 gives each microtask a chance
  // to advance to its first await.
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  assert.equal(tickCalled, 1, 'scheduler._tick must be called exactly once');
  assert.equal(discoveryCalled, 1, 'discovery.run must be called exactly once');
  assert.equal(packagesCalled, 1, 'runPackages must be called exactly once');
  assert.ok(maxInFlight >= 2, `all three collectors must run in parallel (maxInFlight=${maxInFlight})`);

  // Release the gates in reverse order to prove ordering doesn't matter.
  packagesGate.release();
  await new Promise(r => setImmediate(r));
  discoveryGate.release();
  await new Promise(r => setImmediate(r));
  tickGate.release();
  await p;

  assert.equal(pendingClear, true, 'clear flag must arm after all three settled');
});

test('report-now fan-out: arms clear even when one collector rejects (each is independent)', async () => {
  let pendingClear = false;
  const send = makeSendCallback({
    postHeartbeat: async () => ({ ok: true, data: { reportRequested: true } }),
    applyAgentTokenDelivery: async () => {},
    scheduler: { _tick: async () => { throw new Error('replication failed'); } },
    logger: silentLogger,
    getPendingClear: () => pendingClear,
    setPendingClear: (v) => { pendingClear = v; },
    runDiscovery: async () => { throw new Error('discovery failed'); },
    runPackages: async () => { throw new Error('packages failed'); }
  });

  await send({ agentId: 'agent-1' });

  // Per user spec: each collector independent, fan-out completion = arm.
  // All three rejected → all settled → arm clear so we don't retry the
  // whole fan-out on the next heartbeat (each collector already logged
  // its own failure; the operator's dashboard will reflect that).
  assert.equal(pendingClear, true, 'clear must arm even when all three collectors reject');
});

test('report-now fan-out: arms clear when one rejects and two resolve (partial fan-out)', async () => {
  let pendingClear = false;
  const send = makeSendCallback({
    postHeartbeat: async () => ({ ok: true, data: { reportRequested: true } }),
    applyAgentTokenDelivery: async () => {},
    scheduler: { _tick: async () => {} },  // resolves
    logger: silentLogger,
    getPendingClear: () => pendingClear,
    setPendingClear: (v) => { pendingClear = v; },
    runDiscovery: async () => { throw new Error('discovery failed'); },
    runPackages: async () => {}  // resolves
  });

  await send({ agentId: 'agent-1' });

  assert.equal(pendingClear, true, 'clear must arm regardless of which collectors rejected');
});

test('report-now fan-out: falsy runDiscovery / runPackages short-circuits to no-op (non-AD)', async () => {
  // The non-AD runtime and unit tests don't wire discovery or packages.
  // The callback must not crash on undefined collectors — falsy values
  // resolve to Promise.resolve() and count as settled.
  let tickCalled = 0;
  let pendingClear = false;
  const send = makeSendCallback({
    postHeartbeat: async () => ({ ok: true, data: { reportRequested: true } }),
    applyAgentTokenDelivery: async () => {},
    scheduler: { _tick: async () => { tickCalled++; } },
    logger: silentLogger,
    getPendingClear: () => pendingClear,
    setPendingClear: (v) => { pendingClear = v; }
    // runDiscovery: undefined (omitted)
    // runPackages: undefined (omitted)
  });

  await send({ agentId: 'agent-1' });

  assert.equal(tickCalled, 1, 'scheduler._tick must still fire');
  assert.equal(pendingClear, true, 'clear must arm even when discovery+packages are not wired');
});

test('report-now fan-out: emits a summary log with all three collector statuses', async () => {
  const logCalls = [];
  const capturingLogger = {
    info: (obj, msg) => logCalls.push({ level: 'info', obj, msg }),
    warn: () => {}, error: () => {}, debug: () => {}
  };

  const send = makeSendCallback({
    postHeartbeat: async () => ({ ok: true, data: { reportRequested: true } }),
    applyAgentTokenDelivery: async () => {},
    scheduler: { _tick: async () => {} },
    logger: capturingLogger,
    getPendingClear: () => false,
    setPendingClear: () => {},
    runDiscovery: async () => { throw new Error('boom'); },
    runPackages: async () => {}
  });

  await send({ agentId: 'agent-1' });

  const summary = logCalls.find(c => c.obj?.event === 'report-now.fanOut');
  assert.ok(summary, 'must log a report-now.fanOut event');
  assert.equal(summary.obj.summary.length, 3, 'summary must list all three collectors');
  assert.deepEqual(summary.obj.summary.map(s => s.collector),
    ['replication', 'discovery', 'packages']);
  assert.equal(summary.obj.summary[0].status, 'fulfilled');
  assert.equal(summary.obj.summary[1].status, 'rejected');
  assert.equal(summary.obj.summary[1].error, 'boom');
  assert.equal(summary.obj.summary[2].status, 'fulfilled');
  assert.ok(typeof summary.obj.durationMs === 'number', 'duration must be a number');
});