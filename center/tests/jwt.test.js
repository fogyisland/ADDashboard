import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signJwt, verifyJwt } from '../src/auth/jwt.js';

test('signJwt/verifyJwt roundtrip', () => {
  const t = signJwt({ sub: 'u1', role: 'admin' }, 'secret', 60);
  const v = verifyJwt(t, 'secret');
  assert.equal(v.sub, 'u1');
  assert.equal(v.role, 'admin');
});

test('verifyJwt returns null on bad signature', () => {
  const t = signJwt({ sub: 'u1', role: 'admin' }, 'secret', 60);
  assert.equal(verifyJwt(t, 'wrong'), null);
});
