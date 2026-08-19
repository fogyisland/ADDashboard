import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signJwt, verifyJwt } from '../../src/auth/jwt.js';

test('verifyJwt: accepts token signed with current secret', () => {
  const tok = signJwt({ sub: 'u1', role: 'admin', permissions: [] }, 'CUR', 60);
  const v = verifyJwt(tok, { current: 'CUR', previous: '' });
  assert.equal(v.sub, 'u1');
  assert.equal(v.role, 'admin');
});

test('verifyJwt: accepts token signed with previous secret during overlap', () => {
  const tok = signJwt({ sub: 'u1', role: 'admin', permissions: [] }, 'PREV', 60);
  const v = verifyJwt(tok, { current: 'CUR', previous: 'PREV' });
  assert.equal(v.sub, 'u1');
});

test('verifyJwt: rejects token signed with neither secret', () => {
  const tok = signJwt({ sub: 'u1', role: 'admin', permissions: [] }, 'OTHER', 60);
  const v = verifyJwt(tok, { current: 'CUR', previous: 'PREV' });
  assert.equal(v, null);
});

test('verifyJwt: returns null on malformed token', () => {
  const v = verifyJwt('not-a-jwt', { current: 'CUR', previous: '' });
  assert.equal(v, null);
});

test('verifyJwt: returns null on expired token', () => {
  // jwt.sign accepts expiresIn as a number of seconds; -1 = expired
  const tok = signJwt({ sub: 'u1', role: 'admin', permissions: [] }, 'CUR', -1);
  const v = verifyJwt(tok, { current: 'CUR', previous: '' });
  assert.equal(v, null);
});

test('verifyJwt: previous empty string means no previous-match', () => {
  // Sign with the value that would have been "previous" but pass previous: ''.
  // jwt.verify treats empty string as a valid HMAC key only if the token was
  // signed with the empty string — which we won't do — so this is a miss.
  const tok = signJwt({ sub: 'u1', role: 'admin', permissions: [] }, 'PREV', 60);
  const v = verifyJwt(tok, { current: 'CUR', previous: '' });
  assert.equal(v, null);
});

test('verifyJwt: payload preserves tokenVersion', () => {
  const tok = signJwt({ sub: 'u1', role: 'admin', permissions: [], tokenVersion: 5 }, 'CUR', 60);
  const v = verifyJwt(tok, { current: 'CUR', previous: '' });
  assert.equal(v.tokenVersion, 5);
});

test('signJwt: emits a JWT with sub in subject claim', async () => {
  const tok = signJwt({ sub: 42, role: 'admin', permissions: [] }, 'CUR', 60);
  // decode without verifying (jsonwebtoken decodes payload only)
  const jwt = await import('jsonwebtoken');
  const p = jwt.default.decode(tok);
  assert.equal(p.sub, '42');
});