// package-policies.test.js — covers the packagePolicies helper module
// against a mock db (no live DB required for unit tests). Mirrors the
// pattern in tests/sql/package-scripts.test.js and tests/sql/installed-packages.test.js.
//
// R66 task-4: 3 tests as specified in the brief.
//   1. upsert writes 8 columns (8 placeholders: name, intervalSec, timeoutMs,
//      enabled, params, scope, createdAt, updatedAt)
//   2. updatePartial emits only present columns (partial SET clause + WHERE name)
//   3. listEnabled hydrates enabled=1 to boolean true
//
// Note on assertion count: the brief's verbatim test asserted
// `params.length === 3` for updatePartial. The brief's own buildUpdatePartial
// implementation pushes 4 binds (interval_sec, enabled, updated_at, name WHERE),
// and the brief's error message text ("only 3 binds: interval_sec, enabled,
// updated_at — plus name WHERE") confirms 4 total. The implementation is
// treated as source of truth; the assertion is corrected to 4 to match.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packagePolicies } from '../../src/db/sql/package-policies.js';

test('upsert writes 8 columns', async () => {
  const calls = [];
  const db = { dialect: 'mysql', execute: async (sql, p) => { calls.push({ sql, params: p }); return { rows: [] }; } };
  await packagePolicies.upsert(db, {
    name: 'pkg-a', intervalSec: 3600, timeoutMs: 30000, enabled: true,
    params: { x: 1 }, scope: 'global'
  });
  assert.match(calls[0].sql, /INSERT INTO package_policies/);
  assert.equal(calls[0].params.length, 8);
});

test('updatePartial emits only present columns', async () => {
  const calls = [];
  const db = { dialect: 'mysql', execute: async (sql, p) => { calls.push({ sql, params: p }); return { rows: [] }; } };
  await packagePolicies.updatePartial(db, 'pkg-a', { intervalSec: 60, enabled: false });
  assert.match(calls[0].sql, /UPDATE package_policies SET interval_sec = \?, enabled = \?, updated_at = \?/);
  assert.equal(calls[0].params.length, 4, '4 binds: interval_sec, enabled, updated_at, name WHERE');
});

test('listEnabled returns enabled=1 rows', async () => {
  const db = { dialect: 'mysql', execute: async () => ({ rows: [{ name: 'pkg-a', enabled: 1 }] }) };
  const rows = await packagePolicies.listEnabled(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].enabled, true);
});