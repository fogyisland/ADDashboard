import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapMigrations } from '../../src/init/schema-applier.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Real project root so bootstrap finds db/migrations/009-schema-migrations.sql.
const repoRoot = join(__dirname, '../../..');

// Mock db whose SELECT probe fails exactly `failCount` times (simulating
// "table doesn't exist") and succeeds afterwards.
function makeDb({ failCount = 1, dialect = 'mysql' } = {}) {
  const calls = { queries: [], executes: [], upserts: [] };
  let selectAttempts = 0;
  return {
    calls,
    db: {
      dialect,
      sql: { schemaMigrations: { upsert: 'UPSERT', list: 'LIST' } },
      execute: async (sql, params) => {
        calls.executes.push(sql);
        if (sql === 'UPSERT') {
          calls.upserts.push(params);
          return { rows: [], affectedRows: 1 };
        }
        return { rows: [], affectedRows: 0 };
      },
      query: async (sql) => {
        calls.queries.push(sql);
        selectAttempts++;
        if (selectAttempts <= failCount) {
          throw new Error("Table 'schema_migrations' doesn't exist");
        }
        return { rows: [] };
      },
      transaction: async (work) => work({ execute: async () => ({ rows: [], affectedRows: 0 }) })
    }
  };
}

test('bootstrap creates schema_migrations table + backfills existing files on first run', async () => {
  const { db, calls } = makeDb({ failCount: 1 });

  // First run: probe throws -> apply 009 -> backfill 001..008.
  await bootstrapMigrations('mysql', db, { repoRoot });
  assert.equal(calls.queries.length, 1, 'first run probes once');
  assert.ok(
    calls.executes.some(s => /CREATE TABLE IF NOT EXISTS schema_migrations/i.test(s)),
    'first run applies the 009 CREATE TABLE'
  );
  assert.ok(calls.upserts.length >= 8, `expected >= 8 backfilled rows, got ${calls.upserts.length}`);
  for (const p of calls.upserts) {
    assert.equal(p[6], 0);              // execution_ms
    assert.equal(p[7], 'system-init');  // applied_by
    assert.equal(p[8], 'applied');      // status
  }

  // Second run: probe now succeeds -> no DDL, no backfill.
  const executesBefore = calls.executes.length;
  const upsertsBefore = calls.upserts.length;
  await bootstrapMigrations('mysql', db, { repoRoot });
  assert.equal(calls.queries.length, 2, 'second run probes again');
  assert.equal(calls.executes.length, executesBefore, 'second run issues no writes');
  assert.equal(calls.upserts.length, upsertsBefore, 'second run does not re-backfill');
});

test('bootstrap probe uses TOP for mssql (no LIMIT clause in T-SQL)', async () => {
  const { db, calls } = makeDb({ failCount: 0, dialect: 'mssql' });
  await bootstrapMigrations('mssql', db, { repoRoot });
  assert.equal(calls.queries.length, 1);
  assert.match(calls.queries[0], /SELECT TOP 1/i);
  assert.doesNotMatch(calls.queries[0], /LIMIT/i);

  const mysql = makeDb({ failCount: 0, dialect: 'mysql' });
  await bootstrapMigrations('mysql', mysql.db, { repoRoot });
  assert.match(mysql.calls.queries[0], /LIMIT 1/i);
});

test('bootstrap is a no-op when the 009 migration file is missing', async () => {
  // Runtime-only bundles may ship without db/migrations. Bootstrap must not
  // throw — db.init() would otherwise log a spurious failure every start.
  const { db, calls } = makeDb({ failCount: 1 });
  await bootstrapMigrations('mysql', db, { repoRoot: join(__dirname, 'no-such-repo') });
  assert.equal(calls.executes.length, 0);
  assert.equal(calls.upserts.length, 0);
});
