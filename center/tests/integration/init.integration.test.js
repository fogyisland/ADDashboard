import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, close, getDb } from '../../src/db/index.js';
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
  return { dialect, connParams: cfg.db[dialect], db: getDb() };
}

test('integration: full init wizard flow against real mysql', async (t) => {
  const ctx = await boot();
  if (!ctx) return t.skip('no TEST_*_URL set');
  const { dialect, connParams, db } = ctx;

  try {
    // 1. Drop the admin user (clean slate)
    await db.execute('DELETE FROM sys_users WHERE username = ?', ['admin']);
    await db.execute('DELETE FROM sys_users WHERE username = ?', ['wiz-test-admin']);

    // 2. Apply schema + seed via applyAll
    const { applyAll } = await import('../../src/init/schema-applier.js');
    const applied = await applyAll(dialect, db, { repoRoot: process.cwd() + '/..' });
    assert.ok(applied.schema.length > 0);
    assert.ok(applied.seed.length > 0);

    // 3. Create admin
    const { createAdmin } = await import('../../src/init/admin-creator.js');
    const r = await createAdmin(db, { username: 'wiz-test-admin', password: 'hunter22pass' });
    assert.ok(r.id > 0);
    assert.strictEqual(r.username, 'wiz-test-admin');

    // 4. Verify checkNeedsInit returns false (admin exists)
    const { checkNeedsInit } = await import('../../src/init/needs-init.js');
    assert.strictEqual(await checkNeedsInit(db), false);

    // 5. Cleanup
    await db.execute('DELETE FROM sys_users WHERE username = ?', ['wiz-test-admin']);
  } finally {
    await close();
  }
});