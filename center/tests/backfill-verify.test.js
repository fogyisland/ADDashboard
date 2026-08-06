import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backfillMigrations } from '../src/init/schema-applier.js';
import { buildSql } from '../src/db/sql.js';

let repoRoot;
let migrationsDir;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'mig-test-'));
  migrationsDir = join(repoRoot, 'db', 'migrations');
  mkdirSync(migrationsDir, { recursive: true });
});

// Build a mock DB that records executed upserts and answers probe queries
// based on a configurable set of "present" tables/columns.
//
// IMPORTANT: db.sql is the already dialect-resolved registry built by
// buildSql() at db.init() time (see src/db/index.js:27), so the live facade
// is FLAT: db.sql.probe.{table,column} and db.sql.schemaMigrations.upsert —
// NOT db.sql[dialect].{probe,schemaMigrations}. Mocks must use the real
// buildSql() output for the probe SQL strings so wiring mistakes fail the
// test instead of passing against hand-written SQL that production never sees.
function buildMockDb({ presentTables = new Set(), presentColumns = new Set(), upserts = [] } = {}) {
  const sql = buildSql('mysql');
  return {
    sql,
    query: (text, params) => {
      if (text === sql.probe.table) {
        return Promise.resolve({ rows: presentTables.has(params[0]) ? [{ ok: 1 }] : [] });
      }
      if (text === sql.probe.column) {
        const key = `${params[0]}.${params[1]}`;
        return Promise.resolve({ rows: presentColumns.has(key) ? [{ ok: 1 }] : [] });
      }
      return Promise.resolve({ rows: [] });
    },
    execute: (sql, params) => {
      upserts.push({ sql, params });
      return Promise.resolve({ affectedRows: 1 });
    }
  };
}

function makeFile(version, desc, body) {
  const path = join(migrationsDir, `${version}-${desc}.sql`);
  writeFileSync(path, body);
  return path;
}

const silentLogger = { warn: () => {} };

test('all markers present → all rows backfilled', async () => {
  makeFile('001', 'sites', '-- verify: column ad_sites.description\nALTER TABLE ad_sites ADD COLUMN description VARCHAR(256);');
  makeFile('005', 'audit', '-- verify: table sys_config_audit\nCREATE TABLE sys_config_audit (...);');
  const upserts = [];
  const db = buildMockDb({
    presentTables: new Set(['sys_config_audit']),
    presentColumns: new Set(['ad_sites.description']),
    upserts
  });
  const result = await backfillMigrations('mysql', db, { repoRoot, logger: silentLogger });
  assert.equal(result.count, 2);
  assert.deepStrictEqual(result.skipped, []);
  assert.equal(upserts.length, 2);
});

test('005 marker missing → skip 005 with warn, others backfilled', async () => {
  makeFile('001', 'sites', '-- verify: column ad_sites.description\nALTER TABLE ...');
  makeFile('005', 'audit', '-- verify: table sys_config_audit\nCREATE TABLE ...');
  const warns = [];
  const upserts = [];
  const db = buildMockDb({
    presentTables: new Set(),           // sys_config_audit NOT present
    presentColumns: new Set(['ad_sites.description']),
    upserts
  });
  const result = await backfillMigrations('mysql', db, {
    repoRoot,
    logger: { warn: (...args) => warns.push(args) }
  });
  assert.equal(result.count, 1);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].version, '005');
  assert.ok(result.skipped[0].missing.includes('table sys_config_audit'));
  assert.equal(warns.length, 1);
  // 005 was skipped → only 001 was upserted
  const upsertedVersions = upserts.map(u => u.params[0]);
  assert.deepStrictEqual(upsertedVersions, ['001']);
});

test('file without markers is backfilled without probe', async () => {
  makeFile('006', 'cleanup', 'DELETE FROM system_config WHERE config_key IN (...);');
  const upserts = [];
  const db = buildMockDb({ upserts });
  const result = await backfillMigrations('mysql', db, { repoRoot, logger: silentLogger });
  assert.equal(result.count, 1);
  assert.deepStrictEqual(result.skipped, []);
  assert.equal(upserts.length, 1);
});

test('multiple markers on same file, one missing → skip entire file', async () => {
  makeFile(
    '001', 'sites',
    [
      '-- verify: column ad_sites.description',
      '-- verify: column ad_dcs.is_pdc',
      'ALTER TABLE ...'
    ].join('\n')
  );
  const db = buildMockDb({
    presentColumns: new Set(['ad_sites.description'])  // ad_dcs.is_pdc missing
  });
  const result = await backfillMigrations('mysql', db, { repoRoot, logger: silentLogger });
  assert.equal(result.count, 0);
  assert.equal(result.skipped.length, 1);
  assert.ok(result.skipped[0].missing.includes('column ad_dcs.is_pdc'));
});

test('returns { count, skipped } shape', async () => {
  makeFile('001', 'sites', '-- verify: column ad_sites.description\nALTER TABLE ...');
  const db = buildMockDb({ presentColumns: new Set(['ad_sites.description']) });
  const result = await backfillMigrations('mysql', db, { repoRoot, logger: silentLogger });
  assert.ok('count' in result);
  assert.ok('skipped' in result);
  assert.ok(Array.isArray(result.skipped));
});

test('009 is backfilled via marker (no circular skip)', async () => {
  makeFile('009', 'schema-migrations', '-- verify: table schema_migrations\nCREATE TABLE schema_migrations (...);');
  const upserts = [];
  const db = buildMockDb({
    presentTables: new Set(['schema_migrations']),
    upserts
  });
  const result = await backfillMigrations('mysql', db, { repoRoot, logger: silentLogger });
  assert.equal(result.count, 1);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].params[0], '009');  // version is first upsert param
});
