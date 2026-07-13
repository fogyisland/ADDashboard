import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, close, getDb } from '../../src/db/index.js';
import { upsertStatus, listRecent, listBySite } from '../../src/services/replication.js';
import { parseTestUrl } from './_url.js';

function shouldRun(dialect) {
  const urlKey = dialect === 'mysql' ? 'TEST_SQL_URL' : 'TEST_MSSQL_URL';
  return !!process.env[urlKey];
}

async function bootDialect(dialect) {
  const urlKey = dialect === 'mysql' ? 'TEST_SQL_URL' : 'TEST_MSSQL_URL';
  const { user, password, host, port } = parseTestUrl(urlKey, { defaultPort: dialect === 'mysql' ? 3306 : 1433 });
  const cfg = dialect === 'mysql'
    ? { db: { dialect: 'mysql', mysql: { host, port, database: 'ad_monitoring', user, password } } }
    : { db: { dialect: 'mssql', mssql: { server: host, port, database: 'ad_monitoring', user, password } } };
  await init(cfg);
  const db = getDb();
  // NOTE: both drivers execute one statement per execute() call. The mysql
  // driver has multipleStatements:false (see drivers/mysql.js), so a single
  // execute() with two semicolon-separated DELETEs would fail. The mssql
  // driver supports multi-statement only when isInsert (i.e. it wraps with
  // SCOPE_IDENTITY()) — for plain DELETE it's one statement at a time too.
  // Split into two calls for dialect-agnostic safety.
  await db.execute('DELETE FROM ad_replication_history');
  await db.execute('DELETE FROM ad_replication_status');
}

test('integration: replication upsertStatus round-trip (mysql)', async (t) => {
  if (!shouldRun('mysql')) return t.skip('TEST_SQL_URL not set');
  await bootDialect('mysql');
  const row = {
    agentId: 'agent-int-1',
    collectedAt: new Date('2026-07-12T00:00:00Z'),
    sourceDc: 'DC-A', destDc: 'DC-B',
    sourceSite: 'SITE-A', destSite: 'SITE-B',
    namingContext: 'DC=test,DC=com',
    lastSuccessTime: new Date('2026-07-11T23:55:00Z'),
    lastAttemptTime: new Date('2026-07-11T23:55:30Z'),
    statusCode: 0,
    errorMessage: null
  };
  await upsertStatus([row], { appendHistory: true });
  const recent = await listRecent(10);
  assert.ok(recent.find(r => r.source_dc === 'DC-A' && r.dest_dc === 'DC-B'));
  await close();
});

test('integration: replication upsertStatus round-trip (mssql)', async (t) => {
  if (!shouldRun('mssql')) return t.skip('TEST_MSSQL_URL not set');
  await bootDialect('mssql');
  const row = {
    agentId: 'agent-int-1',
    collectedAt: new Date('2026-07-12T00:00:00Z'),
    sourceDc: 'DC-A', destDc: 'DC-B',
    sourceSite: 'SITE-A', destSite: 'SITE-B',
    namingContext: 'DC=test,DC=com',
    lastSuccessTime: new Date('2026-07-11T23:55:00Z'),
    lastAttemptTime: new Date('2026-07-11T23:55:30Z'),
    statusCode: 0,
    errorMessage: null
  };
  await upsertStatus([row], { appendHistory: true });
  const recent = await listRecent(10);
  assert.ok(recent.find(r => r.source_dc === 'DC-A' && r.dest_dc === 'DC-B'));
  await close();
});

test('integration: replication listBySite filters correctly', async (t) => {
  if (!shouldRun('mysql') && !shouldRun('mssql')) return t.skip('no TEST_*_URL set');
  const dialect = shouldRun('mysql') ? 'mysql' : 'mssql';
  await bootDialect(dialect);
  await upsertStatus([
    { agentId: 'a', collectedAt: new Date(), sourceDc: 'X', destDc: 'Y', sourceSite: 'SITE-FOO', destSite: 'SITE-BAR', namingContext: 'NC', lastSuccessTime: null, lastAttemptTime: null, statusCode: 0, errorMessage: null },
    { agentId: 'a', collectedAt: new Date(), sourceDc: 'P', destDc: 'Q', sourceSite: 'OTHER', destSite: 'SITE-FOO', namingContext: 'NC2', lastSuccessTime: null, lastAttemptTime: null, statusCode: 0, errorMessage: null }
  ]);
  const rows = await listBySite('SITE-FOO', 10);
  assert.ok(rows.length >= 2);
  await close();
});
