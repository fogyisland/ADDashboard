// agent/tests/local-queue.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openQueue } from '../src/local-queue.js';

test('queue enqueues, peeks, deletes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'q-'));
  const path = join(dir, 'q.db');
  const q = openQueue(path);
  q.enqueue('{"a":1}');
  q.enqueue('{"a":2}');
  assert.equal(q.count(), 2);
  const items = q.peek(10);
  assert.equal(items.length, 2);
  q.delete([items[0].id]);
  assert.equal(q.count(), 1);
  q.close();
  rmSync(dir, { recursive: true });
});

test('queue survives reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'q-'));
  const path = join(dir, 'q.db');

  // First open: enqueue and close.
  const q1 = openQueue(path);
  q1.enqueue('{"durable":true}');
  assert.equal(q1.count(), 1);
  q1.close();

  // Second open on same path: data must still be there.
  const q2 = openQueue(path);
  assert.equal(q2.count(), 1);
  const items = q2.peek(10);
  assert.equal(items.length, 1);
  assert.equal(items[0].payload, '{"durable":true}');
  q2.close();

  rmSync(dir, { recursive: true });
});
