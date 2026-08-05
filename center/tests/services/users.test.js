import { test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { _setDbForTest } from '../../src/db/index.js';
import { buildSql } from '../../src/db/sql.js';
import { findByUsername, authenticate } from '../../src/services/users.js';

// users.findByUsername joins role_permissions and aggregates permissions via
// GROUP_CONCAT (mysql) / STRING_AGG (mssql) — the row's `permissions` column
// is therefore a comma-separated string, NOT a JSON-encoded array (the
// sys_roles.permissions JSON column was removed in favour of the relational
// role_permissions table). findByUsername must split the string back into an
// array before the login handler writes it into the JWT.
function buildMockDb(byUsername) {
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
  _setDbForTest(buildMockDb({
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
  _setDbForTest(buildMockDb({
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
  _setDbForTest(buildMockDb({
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
  _setDbForTest(buildMockDb({
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
  _setDbForTest(buildMockDb({
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
