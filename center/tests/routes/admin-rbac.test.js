// 2026-09-09 S82 (security) — split admin:users permission matrix.
//
// Asserts every admin route (per the S82 spec routing table) requires the
// SPECIFIC permission, while legacy `admin:users` (or `*`) keeps working
// via the _hasPerm legacy-compat path.
//
// Backed by direct calls to requirePerm middleware rather than HTTP-level
// testing because the matrix is the contract; HTTP tests already cover
// "super admin can hit every route" (they use `*`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requirePerm, __testing } from '../../src/auth/rbac.js';

const { ADMIN_PERMISSIONS, LEGACY_UMBRELLA_PERMS, _hasPerm } = __testing;

// ── Pure-logic matrix ────────────────────────────────────────────────────

test('_hasPerm: `*` grants everything', () => {
  assert.equal(_hasPerm(['*'], 'admin:users'), true);
  assert.equal(_hasPerm(['*'], 'admin:file-push'), true);
  assert.equal(_hasPerm(['*'], 'admin:anything-else'), true);
});

test('_hasPerm: legacy admin:users umbrella grants all per-domain perms', () => {
  assert.equal(_hasPerm(['admin:users'], 'admin:users'), true);
  assert.equal(_hasPerm(['admin:users'], 'admin:packages'), true);
  assert.equal(_hasPerm(['admin:users'], 'admin:file-push'), true);
  assert.equal(_hasPerm(['admin:users'], 'admin:member-servers'), true);
  assert.equal(_hasPerm(['admin:users'], 'admin:ad-objects'), true);
  assert.equal(_hasPerm(['admin:users'], 'admin:config'), true);
  assert.equal(_hasPerm(['admin:users'], 'admin:billing'), true);
});

test('_hasPerm: per-domain perm does NOT implicitly grant other per-domain perms', () => {
  // S82: a "package-operator" role with only admin:packages should NOT
  // also be able to push files. Defense-in-depth — a single compromised
  // credential can't escalate.
  assert.equal(_hasPerm(['admin:packages'], 'admin:packages'), true);
  assert.equal(_hasPerm(['admin:packages'], 'admin:file-push'), false);
  assert.equal(_hasPerm(['admin:packages'], 'admin:member-servers'), false);
  assert.equal(_hasPerm(['admin:packages'], 'admin:ad-objects'), false);
  assert.equal(_hasPerm(['admin:packages'], 'admin:config'), false);
  assert.equal(_hasPerm(['admin:packages'], 'admin:users'), false);
});

test('_hasPerm: empty permissions → all false', () => {
  assert.equal(_hasPerm([], 'admin:users'), false);
  assert.equal(_hasPerm([], 'admin:file-push'), false);
  assert.equal(_hasPerm(null, 'admin:users'), false);
  assert.equal(_hasPerm(undefined, 'admin:users'), false);
});

test('ADMIN_PERMISSIONS export lists all 7 perms', () => {
  assert.equal(ADMIN_PERMISSIONS.length, 7);
  for (const p of [
    'admin:users', 'admin:packages', 'admin:file-push',
    'admin:member-servers', 'admin:ad-objects', 'admin:config',
    'admin:billing'
  ]) {
    assert.ok(ADMIN_PERMISSIONS.includes(p), `ADMIN_PERMISSIONS missing ${p}`);
  }
});

test('LEGACY_UMBRELLA_PERMS export lists the compat string', () => {
  assert.ok(LEGACY_UMBRELLA_PERMS.includes('admin:users'));
});

// ── requirePerm: each route per spec routing table ──────────────────────────

function makeRes() {
  const res = { statusCode: 200, jsonPayload: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.jsonPayload = payload; return res; };
  return res;
}

function makeReq(perms) {
  return { user: { permissions: perms } };
}

test('requirePerm: passes when perm present (admin:file-push granted)', () => {
  let nextCalled = false;
  const mw = requirePerm('admin:file-push');
  mw(makeReq(['admin:file-push']), makeRes(), () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('requirePerm: passes when perm present (legacy admin:users granted)', () => {
  let nextCalled = false;
  const mw = requirePerm('admin:file-push');
  mw(makeReq(['admin:users']), makeRes(), () => { nextCalled = true; });
  assert.equal(nextCalled, true, 'legacy admin:users must still grant admin:file-push');
});

test('requirePerm: 403 when perm absent', () => {
  let nextCalled = false;
  const res = makeRes();
  const mw = requirePerm('admin:file-push');
  mw(makeReq(['admin:packages']), res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.jsonPayload, { error: 'forbidden', need: 'admin:file-push' });
});

test('requirePerm: matrix — every spec routing is enforced', () => {
  // Per the S82 spec, an `admin:packages`-only token must NOT be able
  // to hit admin:file-push / admin:member-servers / admin:ad-objects /
  // admin:config / admin:users. Verify each route is properly gated.
  const only = ['admin:packages'];
  const gates = [
    ['admin:users',          '/api/admin/users',          'admin:users'],
    ['admin:packages',       '/api/admin/server-groups/...packages/install', 'admin:file-push'],
    ['admin:file-push',      '/api/admin/file-push',      'admin:file-push'],
    ['admin:member-servers', '/api/admin/member-commands','admin:member-servers'],
    ['admin:ad-objects',     '/api/admin/ad-commands',    'admin:ad-objects'],
    ['admin:config',         '/api/admin/config',         'admin:config'],
    ['admin:ad-objects',     '/api/admin/dcs-catalog',    'admin:ad-objects']
  ];
  for (const [perm, route, gate] of gates) {
    let nextCalled = false;
    const res = makeRes();
    const mw = requirePerm(gate);
    mw(makeReq(only), res, () => { nextCalled = true; });
    assert.equal(nextCalled, false, `admin:packages-only token must NOT reach ${route} (gate=${gate})`);
  }
});

test('requirePerm: wildcard grants every spec route', () => {
  for (const gate of ['admin:users', 'admin:packages', 'admin:file-push', 'admin:member-servers', 'admin:ad-objects', 'admin:config', 'admin:billing']) {
    let nextCalled = false;
    const mw = requirePerm(gate);
    mw(makeReq(['*']), makeRes(), () => { nextCalled = true; });
    assert.equal(nextCalled, true, `wildcard must grant ${gate}`);
  }
});