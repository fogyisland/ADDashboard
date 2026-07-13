import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, close, getDb } from '../../src/db/index.js';
import { upsertStatus, listBySite } from '../../src/services/replication.js';
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

test('integration: site-replication-matrix returns rows for site', async (t) => {
  const db = await boot();
  if (!db) return t.skip('no TEST_*_URL set');
  await db.execute('DELETE FROM ad_replication_status WHERE source_dc = ? AND dest_dc = ?', ['A1', 'A2']);
  try {
    await upsertStatus([
      { agentId: 'a', collectedAt: new Date('2026-07-12T00:00:00Z'), sourceDc: 'A1', destDc: 'A2',
        sourceSite: 'SITE-X', destSite: 'SITE-X', namingContext: 'NC', lastSuccessTime: null, lastAttemptTime: null, statusCode: 0, errorMessage: null }
    ]);
    const rows = await listBySite('SITE-X', 100);
    assert.ok(rows.length >= 1);
    assert.ok(rows.find(r => r.source_dc === 'A1' && r.dest_dc === 'A2'));
  } finally {
    try {
      const cleanupDb = getDb();
      await cleanupDb.execute('DELETE FROM ad_replication_status WHERE source_dc = ? AND dest_dc = ?', ['A1', 'A2']);
    } catch {}
    await close();
  }
});
