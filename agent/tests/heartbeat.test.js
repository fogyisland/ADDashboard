import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHeartbeat } from '../src/heartbeat.js';

test('startHeartbeat fires on interval and is stoppable', async () => {
  let calls = 0;
  const h = startHeartbeat({ intervalMs: 20, payload: () => ({ agentId: 'X' }), send: async () => { calls++; } });
  await new Promise(r => setTimeout(r, 70));
  h.stop();
  assert.ok(calls >= 2, `expected >=2 calls, got ${calls}`);
});