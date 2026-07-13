import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, close, getDb } from '../../src/db/index.js';
import { writeAudit, listAudit } from '../../src/services/audit.js';
import { parseTestUrl } from './_url.js';

function dialectFromEnv() {
  if (process.env.TEST_SQL_URL) return 'mysql';
  if (process.env.TEST_MSSQL_URL) return 'mssql';
  return null;
}

async function boot() {
  const dialect = dialectFromEnv();
  if (!dialect) return null;
  const urlKey = dialect === 'mysql' ? 'TEST_SQL_URL' : 'TEST_MSSQL_URL';
  const { user, password, host, port } = parseTestUrl(urlKey, { defaultPort: dialect === 'mysql' ? 3306 : 1433 });
  const cfg = dialect === 'mysql'
    ? { db: { dialect, mysql: { host, port, database: 'ad_monitoring', user, password } } }
    : { db: { dialect, mssql: { server: host, port, database: 'ad_monitoring', user, password } } };
  await init(cfg);
  return getDb();
}

test('integration: writeAudit + listAudit round-trip', async (t) => {
  const db = await boot();
  if (!db) return t.skip('no TEST_*_URL set');
  try {
    await writeAudit({ userId: 1, action: 'integration-test', target: 'tgt', payload: { x: 1 } });
    const rows = await listAudit(10);
    assert.ok(rows.find(r => r.action === 'integration-test'));
  } finally {
    try {
      const cleanupDb = getDb();
      await cleanupDb.execute('DELETE FROM audit_logs WHERE action = ?', ['integration-test']);
    } catch {}
    await close();
  }
});
