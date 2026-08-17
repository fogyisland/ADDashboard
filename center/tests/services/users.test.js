import { test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { _setDbForTest, getDb } from '../../src/db/index.js';
import { buildSql } from '../../src/db/sql.js';
import { buildMockDb } from '../helpers/db-mock.js';
import { findByUsername, authenticate, updateUser, bumpTokenVersion } from '../../src/services/users.js';

// users.findByUsername joins role_permissions and aggregates permissions via
// GROUP_CONCAT (mysql) / STRING_AGG (mssql) — the row's `permissions` column
// is therefore a comma-separated string, NOT a JSON-encoded array (the
// sys_roles.permissions JSON column was removed in favour of the relational
// role_permissions table). findByUsername must split the string back into an
// array before the login handler writes it into the JWT.
function buildUsernameMockDb(byUsername) {
  return {
    dialect: 'mysql',
    sql: buildSql('mysql'),
    async query(sql, params = []) {
      if (/FROM\s+sys_users\b/i.test(sql)) {
        const row = byUsername[params[0]];
        return { rows: row ? [row] : [] };
      }
      return { rows: [] };
    },
    async execute() { return { rows: [], affectedRows: 1 }; },
    async transaction() {},
    async healthcheck() {},
    async close() {}
  };
}

test('findByUsername splits single permission from GROUP_CONCAT', async () => {
  _setDbForTest(buildUsernameMockDb({
    admin: {
      id: 1, username: 'admin', status: 1, role_id: 1,
      password_hash: bcrypt.hashSync('pw', 4),
      role_name: 'admin', permissions: '*'
    }
  }));
  const found = await findByUsername('admin');
  assert.ok(found, 'row found');
  assert.deepEqual(found.permissions, ['*'], 'single permission → one-element array');
});

test('findByUsername splits multiple comma-separated permissions', async () => {
  _setDbForTest(buildUsernameMockDb({
    operator1: {
      id: 2, username: 'operator1', status: 1, role_id: 2,
      password_hash: bcrypt.hashSync('pw', 4),
      role_name: 'operator', permissions: 'read:dash,execute:sync'
    }
  }));
  const found = await findByUsername('operator1');
  assert.deepEqual(found.permissions, ['read:dash', 'execute:sync']);
});

test('findByUsername returns [] when permissions is null (no role / role has no permissions)', async () => {
  _setDbForTest(buildUsernameMockDb({
    orphan: {
      id: 3, username: 'orphan', status: 1, role_id: 99,
      password_hash: bcrypt.hashSync('pw', 4)
      // role_name + permissions both null (LEFT JOIN miss)
    }
  }));
  const found = await findByUsername('orphan');
  assert.ok(found);
  assert.deepEqual(found.permissions, [], 'missing permissions → empty array, not undefined');
});

test('findByUsername tolerates an already-array permissions value (test mock shape)', async () => {
  _setDbForTest(buildUsernameMockDb({
    pre: {
      id: 4, username: 'pre', status: 1, role_id: 1,
      password_hash: bcrypt.hashSync('pw', 4),
      role_name: 'admin', permissions: ['*']
    }
  }));
  const found = await findByUsername('pre');
  assert.deepEqual(found.permissions, ['*']);
});

test('authenticate() surfaces the parsed array to the login handler', async () => {
  // Login writes `permissions: user.permissions` straight into the JWT
  // (routes/auth.js:17). If user.permissions is still a string here, signJwt
  // embeds the string and requirePerm's .includes() silently fails → 403.
  _setDbForTest(buildUsernameMockDb({
    admin: {
      id: 1, username: 'admin', status: 1, role_id: 1,
      password_hash: bcrypt.hashSync('correct-horse-battery-staple', 4),
      role_name: 'admin', permissions: '*'
    }
  }));
  const user = await authenticate('admin', 'correct-horse-battery-staple');
  assert.ok(user);
  assert.ok(Array.isArray(user.permissions), 'permissions must be an array, not a string');
  assert.deepEqual(user.permissions, ['*']);
});

// ===== I1 (Task 4): bumpTokenVersion + findByUsername.tokenVersion + updateUser tx-bound bump =====

test('bumpTokenVersion increments token_version by 1 and returns the new value', async () => {
  const records = [];
  _setDbForTest(buildMockDb([
    { match: /UPDATE\s+sys_users\s+SET\s+token_version/i, rows: [{ affectedRows: 1 }] },
    { match: /SELECT\s+token_version\s+FROM\s+sys_users/i, rows: [{ token_version: 1 }] }
  ]).withRecording(records));
  const v = await bumpTokenVersion(7, null);
  assert.equal(v, 1);
  const upd = records.find(r => /UPDATE\s+sys_users\s+SET\s+token_version/i.test(r.sql));
  assert.ok(upd, 'UPDATE must be issued');
  assert.equal(upd.params[0], 7);
});

test('bumpTokenVersion uses the tx wrapper when provided (atomic with caller)', async () => {
  const txCalls = [];
  const txWrapper = {
    sql: getDb().sql,
    execute: async (sql, params) => { txCalls.push({ sql, params }); return { affectedRows: 1 }; },
    query: async (sql, params) => {
      txCalls.push({ sql, params });
      return { rows: [{ token_version: 5 }] };
    }
  };
  const v = await bumpTokenVersion(7, txWrapper);
  assert.equal(v, 5);
  assert.ok(txCalls.length >= 2, 'tx wrapper receives UPDATE + SELECT');
});

test('bumpTokenVersion does NOT call the global db when a tx wrapper is supplied', async () => {
  const txCalls = [];
  const txWrapper = {
    sql: getDb().sql,
    execute: async (sql, params) => { txCalls.push({ sql, params }); return { affectedRows: 1 }; },
    query: async () => ({ rows: [{ token_version: 2 }] })
  };
  const records = [];
  _setDbForTest(buildMockDb([]).withRecording(records));
  await bumpTokenVersion(7, txWrapper);
  assert.equal(records.length, 0, 'global db must NOT receive the bump when tx is supplied');
});

test('findByUsername returns user.tokenVersion as Number, default 0 on missing column', async () => {
  // Row with token_version present (post-migration).
  _setDbForTest(buildMockDb([
    { match: /FROM\s+sys_users/i, rows: [{
      id: 1, username: 'admin', password_hash: 'x', role_id: 1, status: 1, role_name: 'admin', permissions: '*', token_version: 3
    }] }
  ]).standard());
  const u = await findByUsername('admin');
  assert.equal(u.tokenVersion, 3);

  // Row with token_version missing (defensive — migration never ran).
  _setDbForTest(buildMockDb([
    { match: /FROM\s+sys_users/i, rows: [{
      id: 1, username: 'admin', password_hash: 'x', role_id: 1, status: 1, role_name: 'admin', permissions: '*'
    }] }
  ]).standard());
  const u2 = await findByUsername('admin');
  assert.equal(u2.tokenVersion, 0);
});

test('updateUser with password change bumps token_version in the same connection', async () => {
  const records = [];
  const conn = buildMockDb([
    { match: /UPDATE\s+sys_users\s+SET\s+password_hash/i, rows: [{ affectedRows: 1 }] },
    { match: /UPDATE\s+sys_users\s+SET\s+token_version/i, rows: [{ affectedRows: 1 }] },
    { match: /SELECT\s+token_version\s+FROM\s+sys_users/i, rows: [{ token_version: 1 }] }
  ]).withRecording(records);
  _setDbForTest(conn);
  await updateUser(7, { password: 'new-pw-1234567890' });
  // Both UPDATE statements must have been issued on the global db (no tx in caller).
  const pwUpd = records.find(r => /UPDATE\s+sys_users\s+SET\s+password_hash/i.test(r.sql));
  const tokUpd = records.find(r => /UPDATE\s+sys_users\s+SET\s+token_version/i.test(r.sql));
  assert.ok(pwUpd, 'password UPDATE must be issued');
  assert.ok(tokUpd, 'token_version UPDATE must be issued (password change trigger)');
});

test('updateUser with status change bumps token_version', async () => {
  const records = [];
  _setDbForTest(buildMockDb([
    { match: /UPDATE\s+sys_users\s+SET\s+password_hash/i, rows: [{ affectedRows: 1 }] },
    { match: /UPDATE\s+sys_users\s+SET\s+token_version/i, rows: [{ affectedRows: 1 }] },
    { match: /SELECT\s+token_version\s+FROM\s+sys_users/i, rows: [{ token_version: 1 }] }
  ]).withRecording(records));
  await updateUser(7, { status: 0 });
  const tokUpd = records.find(r => /UPDATE\s+sys_users\s+SET\s+token_version/i.test(r.sql));
  assert.ok(tokUpd, 'token_version UPDATE must be issued (status change trigger)');
});

test('updateUser with roleId change bumps token_version', async () => {
  const records = [];
  _setDbForTest(buildMockDb([
    { match: /UPDATE\s+sys_users\s+SET\s+password_hash/i, rows: [{ affectedRows: 1 }] },
    { match: /UPDATE\s+sys_users\s+SET\s+token_version/i, rows: [{ affectedRows: 1 }] },
    { match: /SELECT\s+token_version\s+FROM\s+sys_users/i, rows: [{ token_version: 1 }] }
  ]).withRecording(records));
  await updateUser(7, { roleId: 2 });
  const tokUpd = records.find(r => /UPDATE\s+sys_users\s+SET\s+token_version/i.test(r.sql));
  assert.ok(tokUpd, 'token_version UPDATE must be issued (role change trigger)');
});

test('updateUser with no relevant field (empty patch) does NOT bump token_version', async () => {
  const records = [];
  _setDbForTest(buildMockDb([
    { match: /UPDATE\s+sys_users\s+SET\s+password_hash/i, rows: [{ affectedRows: 1 }] }
  ]).withRecording(records));
  // No password, no roleId, no status — pure read-only call shape, but the
  // existing service still issues the UPDATE (with nulls). Belt-and-braces:
  // pin that no token_version UPDATE fires.
  await updateUser(7, {});
  const tokUpd = records.find(r => /UPDATE\s+sys_users\s+SET\s+token_version/i.test(r.sql));
  assert.equal(tokUpd, undefined, 'no bump when no trigger field present');
});
