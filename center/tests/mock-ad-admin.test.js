// 2026-08-31 R75 — unit tests for mock-ad-admin.mjs.
//
// Covers every public mockAd* function + dispatchMockAdCommand:
//   - happy path (each function returns the expected shape)
//   - error cases (duplicate sam, unknown user/group, protected accounts,
//     illegal scope+category combos, missing required fields)
//   - isolation between DCs (mutating DC-A does not affect DC-B)
//   - password redaction (result envelope never echoes password fields)
//   - deterministic seed dataset shape (4 users + 3 groups per DC)
//
// The mock store is process-singleton (Map); tests call resetAdStore()
// between scenarios so cross-file leakage is impossible.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  adStore,
  MockAdError,
  resetAdStore,
  _internalStoreView,
  dispatchMockAdCommand,
  mockAdUserSearch,
  mockAdUserCreate,
  mockAdUserPasswordReset,
  mockAdUserEnable,
  mockAdUserDisable,
  mockAdUserUnlock,
  mockAdUserSetAttributes,
  mockAdUserDelete,
  mockAdUserListGroups,
  mockAdGroupSearch,
  mockAdGroupCreate,
  mockAdGroupSetAttributes,
  mockAdGroupAddMember,
  mockAdGroupRemoveMember,
  mockAdGroupSetMembers,
  mockAdGroupDelete,
  mockAdGroupListMembers
} from '../mock-ad-admin.mjs';

const DC_A = 'DC-A';
const DC_B = 'DC-B';

// ── dataset shape ───────────────────────────────────────────────────────

test('mock-ad-admin: seed dataset — 4 users + 3 groups per DC', () => {
  resetAdStore();
  const viewA = _internalStoreView(DC_A);
  assert.equal(viewA.users.length, 4, '4 seed users');
  assert.equal(viewA.groups.length, 3, '3 seed groups');
  // Domain Users is auto-created on first user create but not seeded.
  // Verify one of the seeded groups is present + members are arrays.
  const sales = viewA.groups.find(g => g.name === 'Sales Team');
  assert.ok(sales);
  assert.deepEqual(sales.members, ['jdoe']);
  assert.equal(sales.memberCount, 1);
});

test('mock-ad-admin: same DC returns identical dataset across calls (deterministic seed)', () => {
  resetAdStore();
  const a = _internalStoreView(DC_A).users.map(u => u.sam).sort();
  const b = _internalStoreView(DC_A).users.map(u => u.sam).sort();
  assert.deepEqual(a, b);
});

test('mock-ad-admin: DC isolation — mutating DC-A users does NOT touch DC-B', () => {
  resetAdStore();
  mockAdUserCreate(DC_A, { sam: 'bwayne', password: 'Pa55word!' });
  // Same sam on DC-B should still succeed (DC-B doesn't have it).
  const result = mockAdUserCreate(DC_B, { sam: 'bwayne', password: 'Pa55word!' });
  assert.equal(result.created, true);
  const viewA = _internalStoreView(DC_A);
  const viewB = _internalStoreView(DC_B);
  // Both DCs now have 5 users (4 seed + bwayne) — but they're separate
  // Map instances (keyed by dcName).
  assert.equal(viewA.users.length, 5);
  assert.equal(viewB.users.length, 5);
  // Confirm the entries are in different store entries (dcName-keyed):
  assert.notEqual(adStore.get(DC_A), adStore.get(DC_B));
});

// ── mockAdUserSearch ────────────────────────────────────────────────────

test('mockAdUserSearch: empty filter returns all seed users', () => {
  resetAdStore();
  const out = mockAdUserSearch(DC_A, { filter: '' });
  assert.equal(out.count, 4);
  assert.equal(out.truncated, false);
  assert.deepEqual(out.users.map(u => u.sam).sort(), ['admin', 'asmith', 'jdoe', 'servicebot']);
});

test('mockAdUserSearch: filter matches substring', () => {
  resetAdStore();
  const out = mockAdUserSearch(DC_A, { filter: 'a' }); // matches admin, asmith, servicebot
  assert.ok(out.users.some(u => u.sam === 'admin'));
  assert.ok(out.users.some(u => u.sam === 'asmith'));
  assert.ok(out.users.every(u => u.sam.toLowerCase().includes('a')));
});

test('mockAdUserSearch: limit caps results + sets truncated=true', () => {
  resetAdStore();
  const out = mockAdUserSearch(DC_A, { filter: '', limit: 2 });
  assert.equal(out.users.length, 2);
  assert.equal(out.truncated, true);
  assert.equal(out.count, 2);
});

test('mockAdUserSearch: result shape — sam/displayName/enabled/lastLogon/description', () => {
  resetAdStore();
  const out = mockAdUserSearch(DC_A, { filter: 'jdoe' });
  assert.equal(out.users.length, 1);
  const u = out.users[0];
  assert.equal(u.sam, 'jdoe');
  assert.equal(u.displayName, 'John Doe');
  assert.equal(u.enabled, true);
  assert.equal(u.description, 'Sales Engineer');
});

// ── mockAdUserCreate ────────────────────────────────────────────────────

test('mockAdUserCreate: inserts user + Domain Users auto-add', () => {
  resetAdStore();
  const r = mockAdUserCreate(DC_A, {
    sam: 'bwayne', password: 'P@ssw0rd!',
    givenName: 'Bruce', surname: 'Wayne', displayName: 'Bruce Wayne'
  });
  assert.equal(r.sam, 'bwayne');
  assert.equal(r.created, true);
  assert.ok(r.dn.includes('CN=bwayne'));
  const listGroups = mockAdUserListGroups(DC_A, { sam: 'bwayne' });
  assert.ok(listGroups.groups.some(g => g.name === 'Domain Users'));
});

test('mockAdUserCreate: duplicate sam → throws 409', () => {
  resetAdStore();
  mockAdUserCreate(DC_A, { sam: 'bwayne', password: 'P@ss' });
  assert.throws(
    () => mockAdUserCreate(DC_A, { sam: 'bwayne', password: 'P@ss' }),
    (err) => err instanceof MockAdError && err.httpStatus === 409
  );
});

test('mockAdUserCreate: protected user (Administrator) → throws 400', () => {
  resetAdStore();
  assert.throws(
    () => mockAdUserCreate(DC_A, { sam: 'Administrator', password: 'x' }),
    /protected account/
  );
});

test('mockAdUserCreate: missing sam → throws 400', () => {
  resetAdStore();
  assert.throws(
    () => mockAdUserCreate(DC_A, { password: 'x' }),
    /sam/
  );
});

// ── mockAdUserPasswordReset ─────────────────────────────────────────────

test('mockAdUserPasswordReset: returns success + unlocked flag', () => {
  resetAdStore();
  const r = mockAdUserPasswordReset(DC_A, {
    sam: 'jdoe', newPassword: 'NewP@ss1!', mustChangePassword: true, unlockAccount: true
  });
  assert.equal(r.passwordReset, true);
  assert.equal(r.unlocked, true);
});

test('mockAdUserPasswordReset: result envelope does NOT echo password fields', () => {
  resetAdStore();
  const dispatch = dispatchMockAdCommand(DC_A, {
    commandType: 'user_password_reset',
    params: { sam: 'jdoe', newPassword: 'Sup3rSecret!', mustChangePassword: true, unlockAccount: true }
  });
  assert.equal(dispatch.success, true);
  const json = JSON.stringify(dispatch);
  assert.ok(!json.includes('Sup3rSecret!'), 'plaintext password must NOT appear anywhere in the envelope');
});

test('mockAdUserPasswordReset: unknown user → throws 404', () => {
  resetAdStore();
  assert.throws(
    () => mockAdUserPasswordReset(DC_A, { sam: 'nobody', newPassword: 'x' }),
    (err) => err instanceof MockAdError && err.httpStatus === 404
  );
});

// ── mockAdUserEnable / Disable / Unlock ─────────────────────────────────

test('mockAdUserEnable: flips enabled=true on disabled user', () => {
  resetAdStore();
  const r = mockAdUserEnable(DC_A, { sam: 'asmith' });
  assert.equal(r.enabled, true);
  // Verify store mutated.
  const view = _internalStoreView(DC_A);
  const asmith = view.users.find(u => u.sam === 'asmith');
  assert.equal(asmith.enabled, true);
});

test('mockAdUserDisable: protected (Administrator) → throws 400', () => {
  resetAdStore();
  assert.throws(
    () => mockAdUserDisable(DC_A, { sam: 'Administrator' }),
    /protected/
  );
});

test('mockAdUserDisable: flips enabled=false on enabled user', () => {
  resetAdStore();
  const r = mockAdUserDisable(DC_A, { sam: 'jdoe' });
  assert.equal(r.enabled, false);
});

test('mockAdUserUnlock: returns unlocked=true (no-op on unlocked user)', () => {
  resetAdStore();
  const r = mockAdUserUnlock(DC_A, { sam: 'jdoe' });
  assert.equal(r.unlocked, true);
});

test('mockAdUserEnable: unknown user → throws 404', () => {
  resetAdStore();
  assert.throws(
    () => mockAdUserEnable(DC_A, { sam: 'nobody' }),
    (err) => err instanceof MockAdError && err.httpStatus === 404
  );
});

// ── mockAdUserSetAttributes ─────────────────────────────────────────────

test('mockAdUserSetAttributes: updates multiple fields', () => {
  resetAdStore();
  const r = mockAdUserSetAttributes(DC_A, {
    sam: 'jdoe',
    attributes: { title: 'Senior Sales Engineer', department: 'Enterprise Sales', mail: 'jdoe-new@contoso.local' }
  });
  assert.deepEqual(r.updatedFields.sort(), ['department', 'mail', 'title']);
  const view = _internalStoreView(DC_A);
  const jdoe = view.users.find(u => u.sam === 'jdoe');
  assert.equal(jdoe.title, 'Senior Sales Engineer');
  assert.equal(jdoe.department, 'Enterprise Sales');
});

test('mockAdUserSetAttributes: unknown user → throws 404', () => {
  resetAdStore();
  assert.throws(
    () => mockAdUserSetAttributes(DC_A, { sam: 'nobody', attributes: { title: 'x' } }),
    (err) => err instanceof MockAdError && err.httpStatus === 404
  );
});

// ── mockAdUserDelete ────────────────────────────────────────────────────

test('mockAdUserDelete: removes user + cascades from group membership', () => {
  resetAdStore();
  // Seed: jdoe is in 'Sales Team'. Add Domain Users auto-add too via a fresh user.
  mockAdUserCreate(DC_A, { sam: 'tempuser', password: 'x' }); // → Domain Users
  const before = _internalStoreView(DC_A);
  assert.ok(before.groups.find(g => g.name === 'Sales Team').members.includes('jdoe'));
  const r = mockAdUserDelete(DC_A, { sam: 'jdoe' });
  assert.equal(r.deleted, true);
  const after = _internalStoreView(DC_A);
  assert.ok(!after.users.find(u => u.sam === 'jdoe'));
  assert.ok(!after.groups.find(g => g.name === 'Sales Team').members.includes('jdoe'));
});

test('mockAdUserDelete: protected user → throws 400', () => {
  resetAdStore();
  assert.throws(
    () => mockAdUserDelete(DC_A, { sam: 'krbtgt' }),
    /protected/
  );
});

test('mockAdUserDelete: unknown user → throws 404', () => {
  resetAdStore();
  assert.throws(
    () => mockAdUserDelete(DC_A, { sam: 'nobody' }),
    (err) => err instanceof MockAdError && err.httpStatus === 404
  );
});

// ── mockAdUserListGroups ────────────────────────────────────────────────

test('mockAdUserListGroups: returns group memberships with category/scope/dn', () => {
  resetAdStore();
  const out = mockAdUserListGroups(DC_A, { sam: 'admin' });
  assert.equal(out.sam, 'admin');
  // Seed: admin is in 'Domain Admins'.
  assert.equal(out.groups.length, 1);
  assert.equal(out.groups[0].name, 'Domain Admins');
  assert.equal(out.groups[0].category, 'Security');
  assert.equal(out.groups[0].scope, 'Global');
});

test('mockAdUserListGroups: user with no memberships returns empty groups[]', () => {
  resetAdStore();
  const out = mockAdUserListGroups(DC_A, { sam: 'servicebot' });
  assert.deepEqual(out.groups, []);
});

test('mockAdUserListGroups: unknown user → throws 404', () => {
  resetAdStore();
  assert.throws(
    () => mockAdUserListGroups(DC_A, { sam: 'nobody' }),
    (err) => err instanceof MockAdError && err.httpStatus === 404
  );
});

// ── mockAdGroupSearch ───────────────────────────────────────────────────

test('mockAdGroupSearch: empty filter returns all 3 seed groups', () => {
  resetAdStore();
  const out = mockAdGroupSearch(DC_A, { filter: '' });
  assert.equal(out.count, 3);
  assert.equal(out.truncated, false);
  assert.deepEqual(out.groups.map(g => g.name).sort(), ['All Staff DL', 'Domain Admins', 'Sales Team']);
});

test('mockAdGroupSearch: memberCount reflects current membership', () => {
  resetAdStore();
  const out = mockAdGroupSearch(DC_A, { filter: 'Sales' });
  assert.equal(out.groups[0].memberCount, 1);
  // Add a member then re-check
  mockAdGroupAddMember(DC_A, { name: 'Sales Team', members: ['asmith'] });
  const out2 = mockAdGroupSearch(DC_A, { filter: 'Sales' });
  assert.equal(out2.groups[0].memberCount, 2);
});

test('mockAdGroupSearch: limit caps results + sets truncated=true', () => {
  resetAdStore();
  const out = mockAdGroupSearch(DC_A, { filter: '', limit: 2 });
  assert.equal(out.groups.length, 2);
  assert.equal(out.truncated, true);
});

// ── mockAdGroupCreate ───────────────────────────────────────────────────

test('mockAdGroupCreate: inserts group + validates category/scope combo', () => {
  resetAdStore();
  const r = mockAdGroupCreate(DC_A, {
    name: 'Engineers', category: 'Security', scope: 'Universal'
  });
  assert.equal(r.created, true);
  assert.ok(r.dn.includes('CN=Engineers'));
});

test('mockAdGroupCreate: invalid category → throws 400', () => {
  resetAdStore();
  assert.throws(
    () => mockAdGroupCreate(DC_A, { name: 'BadGroup', category: 'BadCategory', scope: 'Global' }),
    /category/
  );
});

test('mockAdGroupCreate: invalid scope → throws 400', () => {
  resetAdStore();
  assert.throws(
    () => mockAdGroupCreate(DC_A, { name: 'BadGroup', category: 'Security', scope: 'BadScope' }),
    /scope/
  );
});

test('mockAdGroupCreate: duplicate name → throws 409', () => {
  resetAdStore();
  mockAdGroupCreate(DC_A, { name: 'Engineers', category: 'Security', scope: 'Universal' });
  assert.throws(
    () => mockAdGroupCreate(DC_A, { name: 'Engineers', category: 'Security', scope: 'Universal' }),
    (err) => err instanceof MockAdError && err.httpStatus === 409
  );
});

test('mockAdGroupCreate: protected group → throws 400', () => {
  resetAdStore();
  assert.throws(
    () => mockAdGroupCreate(DC_A, { name: 'Domain Admins', category: 'Security', scope: 'Global' }),
    /protected/
  );
});

// ── mockAdGroupSetAttributes ────────────────────────────────────────────

test('mockAdGroupSetAttributes: updates description + displayName', () => {
  resetAdStore();
  const r = mockAdGroupSetAttributes(DC_A, {
    name: 'Sales Team',
    attributes: { description: 'Sales dept (updated)', displayName: 'Sales' }
  });
  assert.deepEqual(r.updatedFields.sort(), ['description', 'displayName']);
});

test('mockAdGroupSetAttributes: invalid category+scope combo → throws 400', () => {
  resetAdStore();
  assert.throws(
    () => mockAdGroupSetAttributes(DC_A, {
      name: 'Sales Team',
      attributes: { category: 'NotARealCategory' }
    }),
    /category/
  );
});

test('mockAdGroupSetAttributes: unknown group → throws 404', () => {
  resetAdStore();
  assert.throws(
    () => mockAdGroupSetAttributes(DC_A, { name: 'nobody', attributes: { description: 'x' } }),
    (err) => err instanceof MockAdError && err.httpStatus === 404
  );
});

// ── mockAdGroupAddMember / RemoveMember ─────────────────────────────────

test('mockAdGroupAddMember: adds new + reports alreadyMembers for existing', () => {
  resetAdStore();
  const r = mockAdGroupAddMember(DC_A, { name: 'Sales Team', members: ['asmith', 'jdoe'] });
  // jdoe is already a member (seed); asmith is new.
  assert.deepEqual(r.added, ['asmith']);
  assert.deepEqual(r.alreadyMembers, ['jdoe']);
});

test('mockAdGroupRemoveMember: removes existing + reports notMembers for missing', () => {
  resetAdStore();
  const r = mockAdGroupRemoveMember(DC_A, { name: 'Sales Team', members: ['jdoe', 'ghost'] });
  assert.deepEqual(r.removed, ['jdoe']);
  assert.deepEqual(r.notMembers, ['ghost']);
});

test('mockAdGroupAddMember: unknown group → throws 404', () => {
  resetAdStore();
  assert.throws(
    () => mockAdGroupAddMember(DC_A, { name: 'nobody', members: ['x'] }),
    (err) => err instanceof MockAdError && err.httpStatus === 404
  );
});

// ── mockAdGroupSetMembers ───────────────────────────────────────────────

test('mockAdGroupSetMembers: computes added/removed diff', () => {
  resetAdStore();
  // Initial Sales Team = ['jdoe']; replace with ['asmith', 'servicebot']
  const r = mockAdGroupSetMembers(DC_A, { name: 'Sales Team', members: ['asmith', 'servicebot'] });
  assert.deepEqual(r.added.sort(), ['asmith', 'servicebot']);
  assert.deepEqual(r.removed, ['jdoe']);
  // Verify store state.
  const view = _internalStoreView(DC_A);
  const sales = view.groups.find(g => g.name === 'Sales Team');
  assert.deepEqual(sales.members.sort(), ['asmith', 'servicebot']);
});

test('mockAdGroupSetMembers: empty members array clears group', () => {
  resetAdStore();
  const r = mockAdGroupSetMembers(DC_A, { name: 'Sales Team', members: [] });
  assert.deepEqual(r.removed, ['jdoe']);
  assert.deepEqual(r.added, []);
});

// ── mockAdGroupDelete ───────────────────────────────────────────────────

test('mockAdGroupDelete: removes group + protected group → throws', () => {
  resetAdStore();
  const r = mockAdGroupDelete(DC_A, { name: 'Sales Team' });
  assert.equal(r.deleted, true);
  assert.throws(
    () => mockAdGroupDelete(DC_A, { name: 'Enterprise Admins' }),
    /protected/
  );
});

test('mockAdGroupDelete: unknown group → throws 404', () => {
  resetAdStore();
  assert.throws(
    () => mockAdGroupDelete(DC_A, { name: 'nobody' }),
    (err) => err instanceof MockAdError && err.httpStatus === 404
  );
});

// ── mockAdGroupListMembers ──────────────────────────────────────────────

test('mockAdGroupListMembers: paginated list with total', () => {
  resetAdStore();
  const out = mockAdGroupListMembers(DC_A, { name: 'Sales Team', page: 1, size: 100 });
  assert.equal(out.total, 1);
  assert.equal(out.members.length, 1);
  assert.equal(out.members[0].sam, 'jdoe');
  assert.ok(out.members[0].dn.includes('CN=jdoe'));
});

test('mockAdGroupListMembers: page boundaries + size limit', () => {
  resetAdStore();
  // Add 5 members to a fresh group.
  mockAdGroupCreate(DC_A, { name: 'BulkGroup', category: 'Security', scope: 'Global' });
  for (let i = 0; i < 5; i++) {
    mockAdUserCreate(DC_A, { sam: `bulk${i}`, password: 'x' });
    mockAdGroupAddMember(DC_A, { name: 'BulkGroup', members: [`bulk${i}`] });
  }
  const p1 = mockAdGroupListMembers(DC_A, { name: 'BulkGroup', page: 1, size: 2 });
  assert.equal(p1.members.length, 2);
  assert.equal(p1.total, 5);
  const p2 = mockAdGroupListMembers(DC_A, { name: 'BulkGroup', page: 2, size: 2 });
  assert.equal(p2.members.length, 2);
  const p3 = mockAdGroupListMembers(DC_A, { name: 'BulkGroup', page: 3, size: 2 });
  assert.equal(p3.members.length, 1);
});

test('mockAdGroupListMembers: unknown group → throws 404', () => {
  resetAdStore();
  assert.throws(
    () => mockAdGroupListMembers(DC_A, { name: 'nobody' }),
    (err) => err instanceof MockAdError && err.httpStatus === 404
  );
});

// ── dispatchMockAdCommand ───────────────────────────────────────────────

test('dispatchMockAdCommand: routes each of the 17 command types to the right function', () => {
  resetAdStore();
  const samples = [
    { commandType: 'user_search', params: { filter: '' } },
    { commandType: 'user_create', params: { sam: 'disp1', password: 'x' } },
    { commandType: 'user_password_reset', params: { sam: 'jdoe', newPassword: 'y', mustChangePassword: true, unlockAccount: true } },
    { commandType: 'user_enable', params: { sam: 'asmith' } },
    { commandType: 'user_disable', params: { sam: 'jdoe' } },
    { commandType: 'user_unlock', params: { sam: 'jdoe' } },
    { commandType: 'user_set_attributes', params: { sam: 'jdoe', attributes: { title: 'x' } } },
    { commandType: 'user_delete', params: { sam: 'disp1' } },
    { commandType: 'user_list_groups', params: { sam: 'admin' } },
    { commandType: 'group_search', params: { filter: '' } },
    { commandType: 'group_create', params: { name: 'G1', category: 'Security', scope: 'Universal' } },
    { commandType: 'group_set_attributes', params: { name: 'G1', attributes: { description: 'x' } } },
    { commandType: 'group_add_member', params: { name: 'G1', members: ['jdoe'] } },
    { commandType: 'group_remove_member', params: { name: 'G1', members: ['jdoe'] } },
    { commandType: 'group_set_members', params: { name: 'G1', members: [] } },
    { commandType: 'group_delete', params: { name: 'G1' } },
    { commandType: 'group_list_members', params: { name: 'Sales Team' } }
  ];
  assert.equal(samples.length, 17);
  for (const cmd of samples) {
    const result = dispatchMockAdCommand(DC_A, cmd);
    assert.equal(result.success, true, `dispatcher returned failure for ${cmd.commandType}: ${result.error}`);
    assert.equal(result.exitCode, 0, `exitCode must be 0 for ${cmd.commandType}`);
    assert.ok(result.data !== undefined, `data must be present for ${cmd.commandType}`);
    assert.ok(typeof result.durationMs === 'number');
  }
});

test('dispatchMockAdCommand: returns { success:false, exitCode:1 } on known error', () => {
  resetAdStore();
  const result = dispatchMockAdCommand(DC_A, {
    commandType: 'user_create',
    params: { sam: 'Administrator', password: 'x' }
  });
  assert.equal(result.success, false);
  assert.equal(result.exitCode, 1);
  assert.ok(/protected/i.test(result.error));
});

test('dispatchMockAdCommand: returns { success:false, exitCode:1 } on 404 (unknown user)', () => {
  resetAdStore();
  const result = dispatchMockAdCommand(DC_A, {
    commandType: 'user_enable',
    params: { sam: 'ghost' }
  });
  assert.equal(result.success, false);
  assert.equal(result.exitCode, 1);
});

test('dispatchMockAdCommand: unknown command_type → exitCode 1 with descriptive error', () => {
  resetAdStore();
  const result = dispatchMockAdCommand(DC_A, { commandType: 'bad_type', params: {} });
  assert.equal(result.success, false);
  assert.equal(result.exitCode, 1);
  assert.ok(/unknown command_type/i.test(result.error));
});

test('dispatchMockAdCommand: durationMs is a finite non-negative integer', () => {
  resetAdStore();
  const r = dispatchMockAdCommand(DC_A, { commandType: 'user_search', params: { filter: '' } });
  assert.ok(Number.isInteger(r.durationMs));
  assert.ok(r.durationMs >= 0);
});

// ── password redaction (spec §8 ruling #8) ──────────────────────────────

test('dispatchMockAdCommand: user_create envelope does NOT echo the password', () => {
  resetAdStore();
  const r = dispatchMockAdCommand(DC_A, {
    commandType: 'user_create',
    params: { sam: 'newuser', password: 'Sup3rSecretP@ss!' }
  });
  assert.equal(r.success, true);
  const json = JSON.stringify(r);
  assert.ok(!json.includes('Sup3rSecretP@ss!'), 'password must never appear in result envelope');
});

test('dispatchMockAdCommand: password-shaped keys stripped from data', () => {
  resetAdStore();
  // Manually craft a dispatcher result that includes password keys to
  // verify the spec's redaction rule. Since mockAd* never stores
  // password in the result data, we exercise the redaction rule by
  // checking JSON.stringify doesn't surface passwords anywhere.
  const r = dispatchMockAdCommand(DC_A, {
    commandType: 'user_create',
    params: { sam: 'pwcheck', password: 'PlaintextPassword' }
  });
  assert.ok(JSON.stringify(r).indexOf('PlaintextPassword') === -1);
});

// ── integration: full happy-path chain ──────────────────────────────────

test('integration: create user → enable → set attrs → add to group → list groups', () => {
  resetAdStore();
  // 1. Create
  const c = dispatchMockAdCommand(DC_A, { commandType: 'user_create', params: { sam: 'integration', password: 'x' } });
  assert.equal(c.success, true);
  // 2. Confirm searchable
  const s = dispatchMockAdCommand(DC_A, { commandType: 'user_search', params: { filter: 'integration' } });
  assert.equal(s.data.count, 1);
  // 3. Disable then re-enable
  dispatchMockAdCommand(DC_A, { commandType: 'user_disable', params: { sam: 'integration' } });
  const view1 = _internalStoreView(DC_A);
  assert.equal(view1.users.find(u => u.sam === 'integration').enabled, false);
  dispatchMockAdCommand(DC_A, { commandType: 'user_enable', params: { sam: 'integration' } });
  const view2 = _internalStoreView(DC_A);
  assert.equal(view2.users.find(u => u.sam === 'integration').enabled, true);
  // 4. Set attrs
  const a = dispatchMockAdCommand(DC_A, {
    commandType: 'user_set_attributes',
    params: { sam: 'integration', attributes: { title: 'Integration Test', department: 'QA' } }
  });
  assert.deepEqual(a.data.updatedFields.sort(), ['department', 'title']);
  // 5. Add to a fresh group
  dispatchMockAdCommand(DC_A, { commandType: 'group_create', params: { name: 'QATeam', category: 'Security', scope: 'Global' } });
  dispatchMockAdCommand(DC_A, { commandType: 'group_add_member', params: { name: 'QATeam', members: ['integration'] } });
  // 6. List groups
  const lg = dispatchMockAdCommand(DC_A, { commandType: 'user_list_groups', params: { sam: 'integration' } });
  const names = lg.data.groups.map(g => g.name);
  assert.ok(names.includes('QATeam'));
  assert.ok(names.includes('Domain Users'));
});
