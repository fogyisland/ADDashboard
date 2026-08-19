import { test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { signJwt, verifyJwt } from '../src/auth/jwt.js';

// I9 — Task 1: verifyJwt's second arg is now a { current, previous } bundle
// (was a single secret string). The single-secret tests below wrap the
// secret in `{ current: ... }` so they exercise the same code path the
// production userAuth middleware uses after T2/T3 add the bundle loader.
test('signJwt/verifyJwt roundtrip', () => {
  const t = signJwt({ sub: 'u1', role: 'admin' }, 'secret', 60);
  const v = verifyJwt(t, { current: 'secret', previous: '' });
  assert.equal(v.sub, 'u1');
  assert.equal(v.role, 'admin');
});

test('verifyJwt returns null on bad signature', () => {
  const t = signJwt({ sub: 'u1', role: 'admin' }, 'secret', 60);
  assert.equal(verifyJwt(t, { current: 'wrong', previous: '' }), null);
});

test('signJwt writes tokenVersion into the payload; verifyJwt returns it as a number', () => {
  const t = signJwt({ sub: 'u1', role: 'admin', tokenVersion: 7 }, 'secret', 60);
  const v = verifyJwt(t, { current: 'secret', previous: '' });
  assert.equal(v.tokenVersion, 7);
  assert.equal(typeof v.tokenVersion, 'number');
});

test('signJwt defaults missing tokenVersion to 0', () => {
  const t = signJwt({ sub: 'u1', role: 'admin' }, 'secret', 60);
  const v = verifyJwt(t, { current: 'secret', previous: '' });
  assert.equal(v.tokenVersion, 0);
});

test('verifyJwt defaults missing tokenVersion claim in JWT to 0 (backward compat)', () => {
  // Manually craft a JWT that lacks the tokenVersion claim (simulates a
  // pre-migration token). jwt.sign with an empty object payload omits
  // tokenVersion entirely.
  const t = jwt.sign({ role: 'admin', permissions: [] }, 'secret', { subject: 'u1', expiresIn: 60 });
  const v = verifyJwt(t, { current: 'secret', previous: '' });
  assert.equal(v.sub, 'u1');
  assert.equal(v.tokenVersion, 0);
});
