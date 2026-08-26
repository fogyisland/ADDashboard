// metricstore-consistency.test.js — unit tests for the ad_domain_consistency
// v2 package's metric shape, exercising metricstore.ingestRunV2 with a mocked
// db.execute. The package's collect.ps1 emits a count + lowercase SHA-256-hash
// per AD class (users / groups / GPOs) plus an error_code bit accumulator;
// these tests verify that:
//   1. All 9 metricSchema columns round-trip with the expected SQL shape.
//   2. The all-success case (error_code = 0) binds correctly into the INSERT.
//   3. Partial failures (one or two classes failed) correctly set error_code
//      bits (1 = users, 2 = groups, 4 = gpos).
//   4. All-failed case (error_code = 7) still round-trips a single INSERT
//      with nulls for every count/hash.
//   5. PKG_METRIC_KEY_UNKNOWN fires when a key is emitted that isn't in the
//      declared metricSchema (defense against typo'd PS1 output).
//   6. The server clock (ts) is stamped by the center, not from PS1 stdout.
//   7. errored runs are skipped (no INSERT issued).
//
// Mocked db.execute pattern matches tests/packages/metricstore-local-port-check.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metricstore } from '../../src/packages/metricstore.js';

const MANIFEST = {
  name: 'ad-domain-consistency',
  version: '1.0.0',
  type: 'gauge',
  description: 'Snapshot local-DC view of users/groups/GPOs and SHA-256-hash each class for cross-DC consistency detection.',
  agent: {
    type: 'ad',
    minVersion: '0.1.0',
    platforms: ['windows'],
    runtime: 'powershell',
    script: 'collect.ps1',
    timeoutMs: 120000,
    intervalSec: 3600
  },
  database: {
    schemaName: 'pkg_ad_domain_consistency',
    migrations: ['migrations/001_initial.sql'],
    metricTable: 'metrics',
    metricSchema: {
      agent_id:    { type: 'varchar(64)', nullable: false },
      ts:          { type: 'datetime',    nullable: false },
      user_count:  { type: 'int' },
      user_hash:   { type: 'varchar(64)' },
      group_count: { type: 'int' },
      group_hash:  { type: 'varchar(64)' },
      gpo_count:   { type: 'int' },
      gpo_hash:    { type: 'varchar(64)' },
      error_code:  { type: 'int' }
    }
  }
};

// Fake SHA-256 hex digests (32 bytes = 64 hex chars). Real collect.ps1
// produces these from the sorted, join('|')-ed class-name list. The values
// here are deterministic stand-ins.
const USERS_HASH  = 'a'.repeat(64);
const GROUPS_HASH = 'b'.repeat(64);
const GPOS_HASH   = 'c'.repeat(64);

// Mocked db.execute that records every call and returns a successful INSERT.
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

// All-success shape: every class produced a non-null count + hash.
function allSuccessMetrics(overrides = {}) {
  return {
    agent_id: 'dc-001',
    user_count: 1234,
    user_hash: USERS_HASH,
    group_count: 567,
    group_hash: GROUPS_HASH,
    gpo_count: 89,
    gpo_hash: GPOS_HASH,
    error_code: 0,
    ...overrides
  };
}

test('consistency: all-success case round-trips a single INSERT into pkg_ad_domain_consistency.metrics', async () => {
  const db = makeMockDb();
  const metrics = allSuccessMetrics();

  await metricstore.ingestRun(db, {
    agentId: 'dc-001',
    packageName: 'ad-domain-consistency',
    manifest: MANIFEST,
    runs: [{ metrics, error: null }]
  });

  const inserts = db._calls.filter(c => /INSERT\s+INTO/i.test(c.sql));
  assert.strictEqual(inserts.length, 1, 'expected one INSERT');
  assert.match(inserts[0].sql, /`pkg_ad_domain_consistency`\.`metrics`/);
  // Column list in manifest declaration order.
  assert.match(inserts[0].sql, /\(agent_id,\s*ts,\s*user_count,\s*user_hash,\s*group_count,\s*group_hash,\s*gpo_count,\s*gpo_hash,\s*error_code\)/);

  const [agentId, ts, userCount, userHash, groupCount, groupHash, gpoCount, gpoHash, errorCode] = inserts[0].params;
  assert.strictEqual(agentId, 'dc-001');
  assert.ok(ts instanceof Date, 'ts param must be a Date stamped by the center, not the script');
  assert.strictEqual(userCount, 1234);
  assert.strictEqual(userHash, USERS_HASH);
  assert.strictEqual(groupCount, 567);
  assert.strictEqual(groupHash, GROUPS_HASH);
  assert.strictEqual(gpoCount, 89);
  assert.strictEqual(gpoHash, GPOS_HASH);
  assert.strictEqual(errorCode, 0);
});

test('consistency: partial failure — users class failed (error_code bit 1 set, count+hash null)', async () => {
  const db = makeMockDb();
  const metrics = allSuccessMetrics({
    user_count: null,
    user_hash: null,
    error_code: 1
  });

  await metricstore.ingestRun(db, {
    agentId: 'dc-001',
    packageName: 'ad-domain-consistency',
    manifest: MANIFEST,
    runs: [{ metrics, error: null }]
  });

  const inserts = db._calls.filter(c => /INSERT\s+INTO/i.test(c.sql));
  assert.strictEqual(inserts.length, 1);
  const [, , userCount, userHash, groupCount, groupHash, gpoCount, gpoHash, errorCode] = inserts[0].params;
  assert.strictEqual(userCount, null);
  assert.strictEqual(userHash, null);
  assert.strictEqual(groupCount, 567, 'groups must still report on partial failure');
  assert.strictEqual(groupHash, GROUPS_HASH);
  assert.strictEqual(gpoCount, 89, 'gpos must still report on partial failure');
  assert.strictEqual(gpoHash, GPOS_HASH);
  assert.strictEqual(errorCode, 1, 'users class failure should set bit 1');
});

test('consistency: partial failure — groups class failed (error_code bit 2 set, count+hash null)', async () => {
  const db = makeMockDb();
  const metrics = allSuccessMetrics({
    group_count: null,
    group_hash: null,
    error_code: 2
  });

  await metricstore.ingestRun(db, {
    agentId: 'dc-001',
    packageName: 'ad-domain-consistency',
    manifest: MANIFEST,
    runs: [{ metrics, error: null }]
  });

  const inserts = db._calls.filter(c => /INSERT\s+INTO/i.test(c.sql));
  assert.strictEqual(inserts.length, 1);
  const [, , userCount, , groupCount, groupHash, gpoCount, gpoHash, errorCode] = inserts[0].params;
  assert.strictEqual(userCount, 1234);
  assert.strictEqual(groupCount, null);
  assert.strictEqual(groupHash, null);
  assert.strictEqual(gpoCount, 89);
  assert.strictEqual(gpoHash, GPOS_HASH);
  assert.strictEqual(errorCode, 2, 'groups class failure should set bit 2');
});

test('consistency: partial failure — gpos class failed (error_code bit 4 set, count+hash null)', async () => {
  const db = makeMockDb();
  const metrics = allSuccessMetrics({
    gpo_count: null,
    gpo_hash: null,
    error_code: 4
  });

  await metricstore.ingestRun(db, {
    agentId: 'dc-001',
    packageName: 'ad-domain-consistency',
    manifest: MANIFEST,
    runs: [{ metrics, error: null }]
  });

  const inserts = db._calls.filter(c => /INSERT\s+INTO/i.test(c.sql));
  assert.strictEqual(inserts.length, 1);
  const [, , userCount, userHash, groupCount, groupHash, gpoCount, gpoHash, errorCode] = inserts[0].params;
  assert.strictEqual(userCount, 1234);
  assert.strictEqual(userHash, USERS_HASH);
  assert.strictEqual(groupCount, 567);
  assert.strictEqual(groupHash, GROUPS_HASH);
  assert.strictEqual(gpoCount, null);
  assert.strictEqual(gpoHash, null);
  assert.strictEqual(errorCode, 4, 'gpos class failure should set bit 4');
});

test('consistency: all-failed case (error_code = 7) still round-trips a single INSERT with nulls', async () => {
  // 1 + 2 + 4 = 7: every class failed. The script must still emit the full
  // metric shape so the INSERT binds cleanly — missing keys would cause
  // metricstore to error out and the row would never land. The script's
  // exit code stays 0 regardless of per-class outcome (the bit accumulator
  // carries the failure info).
  const db = makeMockDb();
  const metrics = {
    agent_id: 'dc-001',
    user_count: null,
    user_hash: null,
    group_count: null,
    group_hash: null,
    gpo_count: null,
    gpo_hash: null,
    error_code: 7
  };

  await metricstore.ingestRun(db, {
    agentId: 'dc-001',
    packageName: 'ad-domain-consistency',
    manifest: MANIFEST,
    runs: [{ metrics, error: null }]
  });

  const inserts = db._calls.filter(c => /INSERT\s+INTO/i.test(c.sql));
  assert.strictEqual(inserts.length, 1, 'all-failed must still emit a row so downstream consumers see the host');
  const [, , userCount, userHash, groupCount, groupHash, gpoCount, gpoHash, errorCode] = inserts[0].params;
  assert.strictEqual(userCount, null);
  assert.strictEqual(userHash, null);
  assert.strictEqual(groupCount, null);
  assert.strictEqual(groupHash, null);
  assert.strictEqual(gpoCount, null);
  assert.strictEqual(gpoHash, null);
  assert.strictEqual(errorCode, 7);
});

test('consistency: error_code covers all 3 classes (1, 2, 4) — combined failures accumulate', async () => {
  // users + groups failed but gpos worked: 1 + 2 = 3.
  const db = makeMockDb();
  const metrics = {
    agent_id: 'dc-001',
    user_count: null,
    user_hash: null,
    group_count: null,
    group_hash: null,
    gpo_count: 89,
    gpo_hash: GPOS_HASH,
    error_code: 3
  };

  await metricstore.ingestRun(db, {
    agentId: 'dc-001',
    packageName: 'ad-domain-consistency',
    manifest: MANIFEST,
    runs: [{ metrics, error: null }]
  });

  const inserts = db._calls.filter(c => /INSERT\s+INTO/i.test(c.sql));
  assert.strictEqual(inserts.length, 1);
  const [, , , , , , gpoCount, gpoHash, errorCode] = inserts[0].params;
  assert.strictEqual(gpoCount, 89);
  assert.strictEqual(gpoHash, GPOS_HASH);
  assert.strictEqual(errorCode, 3, 'bit accumulator must combine users(1) + groups(2) = 3');
});

test('consistency: unknown top-level key triggers PKG_METRIC_KEY_UNKNOWN', async () => {
  // The contract is: PS1 emits exactly the declared columns at the top level.
  // Any extra top-level key (typo, leftover debug field) must be rejected.
  const db = makeMockDb();
  const metrics = {
    ...allSuccessMetrics(),
    rogue_field: 'leaked'
  };

  await assert.rejects(
    () => metricstore.ingestRun(db, {
      agentId: 'dc-001',
      packageName: 'ad-domain-consistency',
      manifest: MANIFEST,
      runs: [{ metrics, error: null }]
    }),
    (err) => err.code === 'PKG_METRIC_KEY_UNKNOWN' && err.message.includes('rogue_field')
  );
});

test('consistency: typo in a hash column name (userHash instead of user_hash) triggers PKG_METRIC_KEY_UNKNOWN', async () => {
  // The brief mandates snake_case column names; a typo must NOT silently
  // round-trip as an empty value. Reject the typo and surface the diff.
  const db = makeMockDb();
  const metrics = {
    agent_id: 'dc-001',
    user_count: 1234,
    userHash: USERS_HASH,  // typo: should be user_hash (camelCase leak)
    group_count: 567,
    group_hash: GROUPS_HASH,
    gpo_count: 89,
    gpo_hash: GPOS_HASH,
    error_code: 0
  };

  await assert.rejects(
    () => metricstore.ingestRun(db, {
      agentId: 'dc-001',
      packageName: 'ad-domain-consistency',
      manifest: MANIFEST,
      runs: [{ metrics, error: null }]
    }),
    (err) => err.code === 'PKG_METRIC_KEY_UNKNOWN' && err.message.includes('userHash')
  );
});

test('consistency: ts is stamped by the center, not taken from PS1 stdout', async () => {
  // Even if PS1 were to (incorrectly) emit a ts field, metricstore ignores it
  // because ts is reserved and always prepended. Verify by including ts in
  // the emitted metrics: it must not trigger PKG_METRIC_KEY_UNKNOWN because
  // ts is in the metricSchema, and it must NOT be bound to the INSERT param.
  const db = makeMockDb();
  const before = Date.now();
  const metrics = {
    ...allSuccessMetrics(),
    ts: '2099-12-31T23:59:59Z'  // bogus value the script might leak
  };
  const after = Date.now();

  await metricstore.ingestRun(db, {
    agentId: 'dc-001',
    packageName: 'ad-domain-consistency',
    manifest: MANIFEST,
    runs: [{ metrics, error: null }]
  });

  const inserts = db._calls.filter(c => /INSERT\s+INTO/i.test(c.sql));
  assert.strictEqual(inserts.length, 1);
  const ts = inserts[0].params[1];
  assert.ok(ts instanceof Date);
  // ts must be a fresh Date stamp from the ingest path, not the bogus value.
  assert.notStrictEqual(ts.getTime(), new Date('2099-12-31T23:59:59Z').getTime());
  assert.ok(ts.getTime() >= before && ts.getTime() <= after, 'ts must fall within the call window');
});

test('consistency: errored runs are skipped (no INSERT issued)', async () => {
  const db = makeMockDb();
  const metrics = allSuccessMetrics();

  await metricstore.ingestRun(db, {
    agentId: 'dc-001',
    packageName: 'ad-domain-consistency',
    manifest: MANIFEST,
    runs: [{ metrics, error: 'powershell crashed' }]
  });

  const inserts = db._calls.filter(c => /INSERT\s+INTO/i.test(c.sql));
  assert.strictEqual(inserts.length, 0, 'errored run must not INSERT');
});

test('consistency: SHA-256 hash format (lowercase 64-char hex) round-trips intact', async () => {
  // Verify the contract: the <class>_hash values are stored verbatim as
  // lowercase 64-character hex digests, not transformed by metricstore. This
  // is the property Task 5 (cross-DC comparison) will rely on for fast
  // equality checks.
  const db = makeMockDb();
  const mixedCase = 'AaBb' + '0'.repeat(60);
  const metrics = allSuccessMetrics({
    user_hash: mixedCase
  });

  await metricstore.ingestRun(db, {
    agentId: 'dc-001',
    packageName: 'ad-domain-consistency',
    manifest: MANIFEST,
    runs: [{ metrics, error: null }]
  });

  const inserts = db._calls.filter(c => /INSERT\s+INTO/i.test(c.sql));
  assert.strictEqual(inserts.length, 1);
  const [, , , userHash] = inserts[0].params;
  assert.strictEqual(userHash, mixedCase, 'hash column must be bound verbatim (no transform)');
  assert.strictEqual(userHash.length, 64, 'SHA-256 hex digest is exactly 64 chars');
});