import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, close, getDb } from '../../src/db/index.js';
import { findByUsername, createUser, updateUser, deleteUser, listUsers } from '../../src/services/users.js';
import { parseTestUrl } from './_url.js';

async function boot() {
  const dialect = process.env.TEST_SQL_URL ? 'mysql' : process.env.TEST_MSSQL_URL ? 'mssql' : null;
  if (!dialect) return null;
  const urlKey = dialect === 'mysql' ? 'TEST_SQL_URL' : 'TEST_MSSQL_URL';
  const { user, password, host, port } = parseTestUrl(urlKey, { defaultPort: dialect === 'mysql' ? 3306 : 1433 });
  const cfg = dialect === 'mysql'
    ? { db: { dialect, mysql: { host, port, database: 'ad_monitoring', user, password } } }
    : { db: { dialect, mssql: { server: host, port, database: 'ad_monitoring', user, password } } };
  await init(cfg);
  return getDb();
}

test('integration: user CRUD round-trip', async (t) => {
  const db = await boot();
  if (!db) return t.skip('no TEST_*_URL set');
  await db.execute('DELETE FROM sys_users WHERE username = ?', ['int-user-1']);
  try {
    await createUser({ username: 'int-user-1', password: 'pw12345', roleId: 1, status: 1 });
    const found = await findByUsername('int-user-1');
    assert.ok(found);
    assert.equal(found.username, 'int-user-1');
    await updateUser(found.id, { status: 0 });
    const after = await findByUsername('int-user-1');
    assert.equal(after.status, 0);
    await deleteUser(found.id);
    const gone = await findByUsername('int-user-1');
    assert.equal(gone, null);
  } finally {
    try {
      const cleanupDb = getDb();
      await cleanupDb.execute('DELETE FROM sys_users WHERE username = ?', ['int-user-1']);
    } catch {}
    await close();
  }
});

test('integration: listUsers returns array including seeded admin', async (t) => {
  const db = await boot();
  if (!db) return t.skip('no TEST_*_URL set');
  try {
    const users = await listUsers();
    assert.ok(Array.isArray(users));
    assert.ok(users.find(u => u.username === 'admin'));
  } finally {
    await close();
  }
});
