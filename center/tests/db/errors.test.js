// Unit tests for db/errors.js DbError.wrap.
//
// Wrap is on the hot path: every tx-level throw in the route layer
// (PUT /api/admin/config, agent-token rotate, etc) passes through it.
// When a business throw carries a `{ httpStatus, blockedKey, ... }`
// marker, route catch blocks use those properties to decide whether to
// surface a 4xx (actionable, the UI can fix the input) vs a generic
// 500 (server bug, give up). If wrap drops those properties on the
// floor, every business throw from inside a tx becomes a 500 — the
// original error message hides behind `originalError` and the catch
// never sees it.
//
// Bug we are guarding against:
//   - admin.js catch block (line 277 et al): `if (e.httpStatus === 400)`
//     did NOT trigger when putConfigInTx threw from inside a tx because
//     DbError.wrap stashed httpStatus on `wrapped.originalError.httpStatus`,
//     not on the wrapper. Result: PUT /api/admin/config with a legacy
//     ad_agent_token change returned 500 { error: "internal" } instead of
//     400 with the actionable message.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DbError } from '../../src/db/errors.js';

test('DbError.wrap preserves httpStatus on the wrapper (not just originalError)', () => {
  // Simulates putConfigInTx throwing from inside a tx:
  //   throw Object.assign(new Error('...'), { httpStatus: 400, blockedKey: 'ad_agent_token' });
  const inner = Object.assign(new Error('legacy key write rejected'), {
    httpStatus: 400,
    blockedKey: 'ad_agent_token'
  });
  const wrapped = DbError.wrap(inner);
  // The wrapper IS a DbError, but the marker must surface at the top level
  // so route catches can read `e.httpStatus` without reaching into originalError.
  assert.equal(wrapped.httpStatus, 400,
    'wrapper.httpStatus must equal the inner httpStatus — route catch reads e.httpStatus');
  assert.equal(wrapped.blockedKey, 'ad_agent_token');
  // Inner is preserved for diagnostics.
  assert.equal(wrapped.originalError, inner);
});

test('DbError.wrap preserves arbitrary httpStatus (4xx other than 400)', () => {
  const inner = Object.assign(new Error('rate limited'), { httpStatus: 429 });
  const wrapped = DbError.wrap(inner);
  assert.equal(wrapped.httpStatus, 429);
});

test('DbError.wrap leaves wrapper.httpStatus undefined when inner has none', () => {
  // Generic SQL errors don't carry an httpStatus — wrapper must not invent one.
  const wrapped = DbError.wrap(new Error('column too long'));
  assert.equal(wrapped.httpStatus, undefined);
});

test('DbError.wrap is idempotent (wrapping a DbError returns it unchanged)', () => {
  const inner = DbError.wrap(Object.assign(new Error('x'), { httpStatus: 400 }));
  const wrapped2 = DbError.wrap(inner);
  assert.strictEqual(wrapped2, inner,
    'second wrap must return the same DbError instance — no double-wrapping');
  assert.equal(wrapped2.httpStatus, 400, 'marker survives second wrap');
});