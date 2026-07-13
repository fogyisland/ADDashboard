import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkNeedsInit } from '../../src/init/needs-init.js';

test('checkNeedsInit returns true when db is null', async () => {
  assert.strictEqual(await checkNeedsInit(null), true);
});

test('checkNeedsInit returns true when db.query throws (DB unreachable)', async () => {
  const db = { query: async () => { throw new Error('connection refused'); } };
  assert.strictEqual(await checkNeedsInit(db), true);
});

test('checkNeedsInit returns true when admin count is 0', async () => {
  const db = { query: async (sql) => {
    assert.match(sql, /sys_users/);
    assert.match(sql, /role_name\s*=\s*'admin'/);
    return { rows: [{ n: 0 }] };
  }};
  assert.strictEqual(await checkNeedsInit(db), true);
});

test('checkNeedsInit returns false when admin count > 0', async () => {
  const db = { query: async () => ({ rows: [{ n: 1 }] }) };
  assert.strictEqual(await checkNeedsInit(db), false);
});
