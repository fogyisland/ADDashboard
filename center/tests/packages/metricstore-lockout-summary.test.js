// metricstore-lockout-summary.test.js — unit tests for the ad_lockout_summary
// v2 package's metric shape, exercising metricstore.ingestRunV2 with a mocked
// db.execute. The package's collect.ps1 emits a single locked_count column
// (Search-ADAccount -LockedOut | count) plus an error_code bit. These tests
// verify that:
//   1. locked_count round-trips as an INT into pkg_ad_lockout_summary.metrics.
//   2. error_code = 0 on success and = 1 when ActiveDirectory RSAT is missing.
//   3. locked_count=null when RSAT is missing (the row is still useful for
//      gap detection — the bit accumulator carries the failure).
//   4. PKG_METRIC_KEY_UNKNOWN fires on unknown top-level keys (typo defense).
//   5. ts is stamped by the center, not from PS1 stdout.
//
// Mocked db.execute pattern matches tests/packages/metricstore.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metricstore } from '../../src/packages/metricstore.js';

const MANIFEST = {
  name: 'ad-lockout-summary',
  version: '1.0.0',
  type: 'gauge',
  description: 'Count of currently locked AD user accounts on this DC.',
  agent: {
    type: 'ad',
    minVersion: '0.1.0',
    platforms: ['windows'],
    runtime: 'powershell',
    script: 'collect.ps1',
    timeoutMs: 60000,
    intervalSec: 900
  },
  database: {
    schemaName: 'pkg_ad_lockout_summary',
    migrations: ['migrations/001_initial.sql'],
    metricTable: 'metrics',
    metricSchema: {
      agent_id:     { type: 'varchar(64)', nullable: false },
      ts:           { type: 'datetime',    nullable: false },
      locked_count: { type: 'int' },
      error_code:   { type: 'int' }
    }
  }
};

function makeMockDb() {
  const calls = [];
  return {
    dialect: 'mysql',
    async execute(sql, params = []) {
      calls.push({ sql, params: [...params] });
      return { rows: [], affectedRows: 1 };
    },
    _calls: calls
  };
}

test('lockout-summary: happy path round-trips locked_count + error_code=0 into pkg_ad_lockout_summary.metrics', async () => {
  const db = makeMockDb();
  const metrics = {
    agent_id: 'DC01',
    locked_count: 3,
    error_code: 0
  };

  await metricstore.ingestRun(db, {
    agentId: 'DC01',
    packageName: 'ad-lockout-summary',
    manifest: MANIFEST,
    runs: [{ metrics, error: null }]
  });

  const inserts = db._calls.filter(c => /INSERT\s+INTO/i.test(c.sql));
  assert.strictEqual(inserts.length, 1, 'expected one INSERT');
  assert.match(inserts[0].sql, /`pkg_ad_lockout_summary`\.`metrics`/);
  assert.match(inserts[0].sql, /\(agent_id,\s*ts,\s*locked_count,\s*error_code\)/);

  const [agentId, ts, lockedCount, errorCode] = inserts[0].params;
  assert.strictEqual(agentId, 'DC01');
  assert.ok(ts instanceof Date, 'ts must be a Date stamped by the center');
  assert.strictEqual(lockedCount, 3);
  assert.strictEqual(errorCode, 0);
});

test('lockout-summary: zero locked accounts (clean state) round-trips locked_count=0', async () => {
  // Operators want to see a clean DC with locked_count=0 trend, not a
  // missing row. Assert that 0 is preserved (not coerced to null).
  const db = makeMockDb();
  const metrics = {
    agent_id: 'DC02',
    locked_count: 0,
    error_code: 0
  };

  await metricstore.ingestRun(db, {
    agentId: 'DC02',
    packageName: 'ad-lockout-summary',
    manifest: MANIFEST,
    runs: [{ metrics, error: null }]
  });

  const inserts = db._calls.filter(c => /INSERT\s+INTO/i.test(c.sql));
  assert.strictEqual(inserts.length, 1);
  const [, , lockedCount] = inserts[0].params;
  assert.strictEqual(lockedCount, 0, 'locked_count=0 must round-trip as 0 (not null)');
});

test('lockout-summary: RSAT missing → error_code=1, locked_count=null (row still inserted)', async () => {
  // When ActiveDirectory RSAT is not installed (member-server case), the
  // script can't Search-ADAccount -LockedOut. The bit accumulator carries
  // the failure (error_code=1) and locked_count stays null so the gap
  // chart can still render. The row must still INSERT — failing the
  // whole run would erase the failure signal.
  const db = makeMockDb();
  const metrics = {
    agent_id: 'MEMBER-01',
    locked_count: null,
    error_code: 1
  };

  await metricstore.ingestRun(db, {
    agentId: 'MEMBER-01',
    packageName: 'ad-lockout-summary',
    manifest: MANIFEST,
    runs: [{ metrics, error: null }]
  });

  const inserts = db._calls.filter(c => /INSERT\s+INTO/i.test(c.sql));
  assert.strictEqual(inserts.length, 1, 'failed-class runs must still INSERT (carry error_code bit)');
  const [, , lockedCount, errorCode] = inserts[0].params;
  assert.strictEqual(lockedCount, null);
  assert.strictEqual(errorCode, 1);
});

test('lockout-summary: unknown top-level key triggers PKG_METRIC_KEY_UNKNOWN', async () => {
  // Defense against typo'd PS1 output (e.g., 'lockd_count'). The script
  // contract is locked_count + error_code; anything else is a bug.
  const db = makeMockDb();
  const metrics = {
    agent_id: 'DC01',
    locked_count: 5,
    error_code: 0,
    rogue_field: 'leaked'
  };

  await assert.rejects(
    () => metricstore.ingestRun(db, {
      agentId: 'DC01',
      packageName: 'ad-lockout-summary',
      manifest: MANIFEST,
      runs: [{ metrics, error: null }]
    }),
    (err) => err.code === 'PKG_METRIC_KEY_UNKNOWN' && err.message.includes('rogue_field')
  );
});

test('lockout-summary: ts is stamped by the center, not taken from PS1 stdout', async () => {
  // Even if the PS1 script leaked a ts field (it shouldn't — see the script
  // contract), metricstore ignores it because ts is reserved.
  const db = makeMockDb();
  const before = Date.now();
  const metrics = {
    agent_id: 'DC01',
    locked_count: 5,
    error_code: 0,
    ts: '2099-12-31T23:59:59Z'
  };
  const after = Date.now();

  await metricstore.ingestRun(db, {
    agentId: 'DC01',
    packageName: 'ad-lockout-summary',
    manifest: MANIFEST,
    runs: [{ metrics, error: null }]
  });

  const inserts = db._calls.filter(c => /INSERT\s+INTO/i.test(c.sql));
  const ts = inserts[0].params[1];
  assert.ok(ts instanceof Date);
  assert.ok(ts.getTime() >= before && ts.getTime() <= after, 'ts must fall within the call window');
});

test('lockout-summary: errored runs are skipped (no INSERT issued)', async () => {
  const db = makeMockDb();
  const metrics = {
    agent_id: 'DC01',
    locked_count: 5,
    error_code: 0
  };

  await metricstore.ingestRun(db, {
    agentId: 'DC01',
    packageName: 'ad-lockout-summary',
    manifest: MANIFEST,
    runs: [{ metrics, error: 'powershell crashed' }]
  });

  const inserts = db._calls.filter(c => /INSERT\s+INTO/i.test(c.sql));
  assert.strictEqual(inserts.length, 0, 'errored run must not INSERT');
});
