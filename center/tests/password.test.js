import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/auth/password.js';

test('hashPassword produces verifiable hash', async () => {
  const h = await hashPassword('hunter2');
  assert.notEqual(h, 'hunter2');
  assert.equal(await verifyPassword('hunter2', h), true);
  assert.equal(await verifyPassword('wrong', h), false);
});
