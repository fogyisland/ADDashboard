import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openQueue } from '../src/local-queue.js';
import { createScheduler } from '../src/scheduler.js';

function fakeLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

test('scheduler tick enqueues snapshot and sends when send returns ok', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sched-'));
  const queue = openQueue(join(dir, 'q.db'));
  const sent = [];
  const scheduler = createScheduler({
    config: { pollingIntervalMinutes: 1, healthCheckIntervalMs: 600_000 },
    logger: fakeLogger(),
    queue,
    collect: async () => ({ ok: true, snapshot: { AgentId: 'X', Entries: [{ SourceDc: 'a', DestDc: 'b', StatusCode: 0 }] } }),
    send: async (snap) => { sent.push(snap); return { ok: true, status: 200 }; },
    sendHeartbeat: async () => {},
    runHealth: async () => ({ ok: true, checks: {} })
  });
  await scheduler._tick();
  assert.equal(sent.length, 1, 'should have sent one report');
  assert.equal(queue.count(), 0, 'queue should be empty after successful send');
  scheduler.stop();
  queue.close();
  rmSync(dir, { recursive: true });
});

test('scheduler tick keeps queue when send returns not ok', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sched-'));
  const queue = openQueue(join(dir, 'q.db'));
  const heartbeats = [];
  const scheduler = createScheduler({
    config: { pollingIntervalMinutes: 1, healthCheckIntervalMs: 600_000 },
    logger: fakeLogger(),
    queue,
    collect: async () => ({ ok: true, snapshot: { AgentId: 'X', Entries: [] } }),
    send: async () => ({ ok: false, status: 500 }),
    sendHeartbeat: async (hb) => { heartbeats.push(hb); },
    runHealth: async () => ({ ok: true, checks: {} })
  });
  await scheduler._tick();
  assert.equal(heartbeats.length, 1, 'should have sent a failed heartbeat');
  assert.equal(heartbeats[0].lastReportStatus, 'failed');
  assert.equal(queue.count(), 1, 'queue should still hold the unsent item');
  scheduler.stop();
  queue.close();
  rmSync(dir, { recursive: true });
});

test('scheduler tick sends failed heartbeat when collect fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sched-'));
  const queue = openQueue(join(dir, 'q.db'));
  const heartbeats = [];
  const scheduler = createScheduler({
    config: { pollingIntervalMinutes: 1, healthCheckIntervalMs: 600_000 },
    logger: fakeLogger(),
    queue,
    collect: async () => ({ ok: false, error: 'boom', snapshot: null }),
    send: async () => ({ ok: true, status: 200 }),
    sendHeartbeat: async (hb) => { heartbeats.push(hb); },
    runHealth: async () => ({ ok: true, checks: {} })
  });
  await scheduler._tick();
  assert.equal(heartbeats.length, 1);
  assert.equal(heartbeats[0].lastReportStatus, 'failed');
  assert.equal(queue.count(), 0, 'collect failure should NOT enqueue anything');
  scheduler.stop();
  queue.close();
  rmSync(dir, { recursive: true });
});

// 2026-08-25: scheduler._tick() must dedupe concurrent calls so a stack of
// heartbeats that all see reportRequested: true doesn't spawn 20 parallel
// collect() runs. Without dedupe, the heartbeat-callbacks path can fire
// _tick() every 3s while a previous 60s collect-replication.ps1 is still
// running — the agent process gets overwhelmed and heartbeats drop.
test('scheduler._tick() dedupes concurrent calls — collect runs only once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sched-'));
  const queue = openQueue(join(dir, 'q.db'));
  let collectCount = 0;
  let releaseCollect;
  const collectGate = new Promise(resolve => { releaseCollect = resolve; });
  const sent = [];
  const scheduler = createScheduler({
    config: { pollingIntervalMinutes: 1, healthCheckIntervalMs: 600_000 },
    logger: fakeLogger(),
    queue,
    collect: async () => {
      collectCount++;
      await collectGate;       // hold collect open until we release
      return { ok: true, snapshot: { AgentId: 'X', Entries: [{ SourceDc: 'a', DestDc: 'b', StatusCode: 0 }] } };
    },
    send: async (snap) => { sent.push(snap); return { ok: true, status: 200 }; },
    sendHeartbeat: async () => {},
    runHealth: async () => ({ ok: true, checks: {} })
  });

  // Fire 4 concurrent _tick() calls — calls 2-4 must short-circuit on
  // the in-flight promise; collect() must be entered exactly once even
  // though 4 callers raced for it.
  const p1 = scheduler._tick();
  const p2 = scheduler._tick();
  const p3 = scheduler._tick();
  const p4 = scheduler._tick();
  // Settle the event loop so call 1 actually enters collect() and the
  // other 3 short-circuit on tickInFlight.
  await new Promise(r => setImmediate(r));
  assert.equal(collectCount, 1, 'collect must run exactly once across concurrent _tick() calls');

  // Now release the gate so the run can finish.
  releaseCollect();
  const allResults = await Promise.all([p1, p2, p3, p4]);

  assert.equal(collectCount, 1, 'collect still exactly once after the run resolves');
  assert.equal(sent.length, 1, 'send must run exactly once (shared run)');
  assert.ok(allResults.every(r => r === undefined || r === allResults[0]),
    'all concurrent _tick() calls should resolve to the same run');

  scheduler.stop();
  queue.close();
  rmSync(dir, { recursive: true });
});

// 2026-08-25: dedupe must release AFTER the run completes so the next
// heartbeat (post-clear) can fire a fresh _tick().
test('scheduler._tick() dedupe releases after completion — next call runs again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sched-'));
  const queue = openQueue(join(dir, 'q.db'));
  let collectCount = 0;
  const scheduler = createScheduler({
    config: { pollingIntervalMinutes: 1, healthCheckIntervalMs: 600_000 },
    logger: fakeLogger(),
    queue,
    collect: async () => {
      collectCount++;
      return { ok: true, snapshot: { AgentId: 'X', Entries: [] } };
    },
    send: async () => ({ ok: true, status: 200 }),
    sendHeartbeat: async () => {},
    runHealth: async () => ({ ok: true, checks: {} })
  });

  await scheduler._tick();
  await scheduler._tick();  // second call must run a fresh collect
  await scheduler._tick();  // third call too

  assert.equal(collectCount, 3, 'sequential _tick() calls must each run their own collect');

  scheduler.stop();
  queue.close();
  rmSync(dir, { recursive: true });
});
