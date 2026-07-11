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
