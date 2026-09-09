// 2026-09-09 S82 (security) — agent identity binding unit tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signRequest, verifyRequest, __testing } from '../src/lib/agent-identity.js';

const { stableJson } = __testing;

test('signRequest: returns 64-char hex string', () => {
  const sig = signRequest({ hostname: 'host-A', agentId: 'agent-1', body: { x: 1 }, token: 'tok' });
  assert.match(sig, /^[a-f0-9]{64}$/);
});

test('verifyRequest: signs then verifies round-trips', () => {
  const sig = signRequest({ hostname: 'host-A', agentId: 'agent-1', body: { x: 1 }, token: 'tok' });
  assert.equal(verifyRequest({ signature: sig, hostname: 'host-A', agentId: 'agent-1', body: { x: 1 }, token: 'tok' }), true);
});

test('verifyRequest: hostname mismatch → false (S82 impersonation guard)', () => {
  const sig = signRequest({ hostname: 'host-A', agentId: 'agent-1', body: { x: 1 }, token: 'tok' });
  assert.equal(verifyRequest({ signature: sig, hostname: 'host-B', agentId: 'agent-1', body: { x: 1 }, token: 'tok' }), false);
});

test('verifyRequest: agentId mismatch → false', () => {
  const sig = signRequest({ hostname: 'host-A', agentId: 'agent-1', body: { x: 1 }, token: 'tok' });
  assert.equal(verifyRequest({ signature: sig, hostname: 'host-A', agentId: 'agent-2', body: { x: 1 }, token: 'tok' }), false);
});

test('verifyRequest: body tamper → false', () => {
  const sig = signRequest({ hostname: 'host-A', agentId: 'agent-1', body: { x: 1 }, token: 'tok' });
  assert.equal(verifyRequest({ signature: sig, hostname: 'host-A', agentId: 'agent-1', body: { x: 2 }, token: 'tok' }), false);
});

test('verifyRequest: token mismatch → false', () => {
  const sig = signRequest({ hostname: 'host-A', agentId: 'agent-1', body: { x: 1 }, token: 'tok-A' });
  assert.equal(verifyRequest({ signature: sig, hostname: 'host-A', agentId: 'agent-1', body: { x: 1 }, token: 'tok-B' }), false);
});

test('signRequest: stableJson sorts keys at every level', () => {
  // {b:2,a:1} and {a:1,b:2} must produce identical strings
  const a = stableJson({ b: 2, a: 1 });
  const b = stableJson({ a: 1, b: 2 });
  assert.equal(a, b);
  assert.equal(a, '{"a":1,"b":2}');
});

test('signRequest: nested object key order does not change signature', () => {
  const sig1 = signRequest({ hostname: 'h', agentId: 'a', body: { outer: { b: 2, a: 1 } }, token: 'tok' });
  const sig2 = signRequest({ hostname: 'h', agentId: 'a', body: { outer: { a: 1, b: 2 } }, token: 'tok' });
  assert.equal(sig1, sig2);
});

test('signRequest: null body is acceptable (GET requests)', () => {
  const sig = signRequest({ hostname: 'h', agentId: 'a', body: null, token: 'tok' });
  assert.equal(sig.length, 64);
});

test('verifyRequest: missing signature → false', () => {
  assert.equal(verifyRequest({ signature: '', hostname: 'h', agentId: 'a', body: null, token: 'tok' }), false);
  assert.equal(verifyRequest({ signature: undefined, hostname: 'h', agentId: 'a', body: null, token: 'tok' }), false);
});

test('signRequest: missing token throws', () => {
  assert.throws(() => signRequest({ hostname: 'h', agentId: 'a', body: null }), /token/);
});

test('verifyRequest: different length signatures → false (no timing leak on length)', () => {
  assert.equal(verifyRequest({ signature: 'short', hostname: 'h', agentId: 'a', body: null, token: 'tok' }), false);
});