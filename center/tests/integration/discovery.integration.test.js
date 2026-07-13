import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, close, getDb } from '../../src/db/index.js';
import { upsertDiscoveredDc } from '../../src/services/discovery.js';
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

test('integration: upsertDiscoveredDc inserts new DC', async (t) => {
  const db = await boot();
  if (!db) return t.skip('no TEST_*_URL set');
  await db.execute('DELETE FROM ad_dcs WHERE dc_name = ?', ['DC-INT-1']);
  try {
    await upsertDiscoveredDc({
      agentId: 'agent-int-1',
      collectedAt: new Date('2026-07-12T00:00:00Z'),
      dc: { name: 'DC-INT-1', siteHint: 'SITE-X', osVersion: 'Win2022', whenCreated: new Date('2020-01-01T00:00:00Z'),
            isPdc: true, isGc: true, isRidMaster: false, isSchemaMaster: false, isDomainNamingMaster: false, isInfrastructureMaster: false }
    });
    const { rows } = await db.query('SELECT dc_name, is_pdc, is_gc FROM ad_dcs WHERE dc_name = ?', ['DC-INT-1']);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].is_pdc), 1);
    assert.equal(Number(rows[0].is_gc), 1);
  } finally {
    try {
      await db.execute('DELETE FROM ad_dcs WHERE dc_name = ?', ['DC-INT-1']);
    } catch {}
    await close();
  }
});
