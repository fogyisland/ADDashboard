// consistency.test.js — unit tests for the Task 5 server-side cross-DC
// consistency scoring service.
//
// Builds a minimal mock DB (buildRecordingPool + _setDbForTest) so the test
// owns the row-level data the service sees, then asserts on the JSON shape
// returned by deriveConsistency(). The mock returns canned rows on any
// SELECT that mentions pkg_ad_domain_consistency so the SQL-text routing
// in the service layer doesn't need to match the actual SQL string.
//
// Test surface:
//   - All agents agree on a class → consensus_count = N, outliers = []
//   - One outlier → outliers list contains the agent with the differing hash
//   - All outliers (3 distinct hashes) → tie-break picks the hash with the
//     latest MAX(ts); consensus_count = 1, all 3 agents in outliers
//   - All-failed class (all hashes null) → consensus_hash: null, count 0
//   - Mixed across classes → per-class independence
//   - Tie-break rule verified: same count, different MAX(ts) → latest wins
//   - Empty result (no rows) → all 3 classes have null/0/[] shape
//   - Outliers are sorted by agent_id ASC for stable UI + assertions

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _setDbForTest } from '../../src/db/index.js';
import { buildRecordingPool, buildMockDb } from '../helpers/db-mock.js';
import { buildClassShape, deriveConsistency } from '../../src/services/consistency.js';

// Fake SHA-256 hex digests (32 bytes = 64 hex chars). Real collect.ps1
// produces these from the sorted, join('|')-ed class-name list; the values
// here are deterministic stand-ins.
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

function row(agent_id, { user_hash = null, group_hash = null, gpo_hash = null, ts }) {
  return {
    agent_id,
    ts,
    user_count:  user_hash  ? 100 : null,
    user_hash,
    group_count: group_hash ? 50  : null,
    group_hash,
    gpo_count:   gpo_hash   ? 10  : null,
    gpo_hash,
    error_code: 0
  };
}

// Build a mock DB whose `query()` returns canned rows for any SELECT against
// pkg_ad_domain_consistency.metrics, and returns the standard auth-success
// defaults for any other SELECT (so callers using _setDbForTest don't trip
// over the userAuth middleware's per-request lookup if they exercise that
// path too — this service doesn't, but the helper covers it).
function makeMock(latestRows) {
  const records = [];
  const db = buildRecordingPool(records);
  // Replace the query function with one that returns the canned rows for
  // consistency-table SELECTs and the helper's auth defaults for others.
  const realQuery = db.query;
  db.query = async (sql, params) => {
    records.push({ sql, params: [...(params || [])] });
    if (/pkg_ad_domain_consistency/i.test(sql) || /consistency/i.test(sql)) {
      return { rows: latestRows };
    }
    return realQuery(sql, params);
  };
  return { db, records };
}

// ----- buildClassShape (pure function) -----

test('buildClassShape: empty input returns null/0/[]', () => {
  const out = buildClassShape('users', []);
  assert.deepEqual(out, {
    class: 'users',
    consensus_hash: null,
    consensus_count: 0,
    agent_count: 0,
    outliers: []
  });
});

test('buildClassShape: all 3 agents agree on hash A → consensus=A, count=3, outliers=[]', () => {
  const rows = [
    { agent_id: 'dc-1', hash: HASH_A, ts: new Date('2026-08-21T10:00:00Z') },
    { agent_id: 'dc-2', hash: HASH_A, ts: new Date('2026-08-21T10:00:00Z') },
    { agent_id: 'dc-3', hash: HASH_A, ts: new Date('2026-08-21T10:00:00Z') }
  ];
  const out = buildClassShape('users', rows);
  assert.equal(out.class, 'users');
  assert.equal(out.consensus_hash, HASH_A);
  assert.equal(out.consensus_count, 3);
  assert.equal(out.agent_count, 3);
  assert.deepEqual(out.outliers, []);
});

test('buildClassShape: 2 agree + 1 differs → consensus has count 2, outlier in list', () => {
  const rows = [
    { agent_id: 'dc-1', hash: HASH_A, ts: new Date('2026-08-21T10:00:00Z') },
    { agent_id: 'dc-2', hash: HASH_A, ts: new Date('2026-08-21T10:00:00Z') },
    { agent_id: 'dc-3', hash: HASH_B, ts: new Date('2026-08-21T10:00:00Z') }
  ];
  const out = buildClassShape('users', rows);
  assert.equal(out.consensus_hash, HASH_A);
  assert.equal(out.consensus_count, 2);
  assert.equal(out.agent_count, 3);
  assert.equal(out.outliers.length, 1);
  assert.equal(out.outliers[0].agent_id, 'dc-3');
  assert.equal(out.outliers[0].hash, HASH_B);
  assert.equal(out.outliers[0].collected_at, '2026-08-21T10:00:00.000Z');
});

test('buildClassShape: all-null class (class-level failure on every agent) → null consensus', () => {
  const rows = [
    { agent_id: 'dc-1', hash: null, ts: new Date('2026-08-21T10:00:00Z') },
    { agent_id: 'dc-2', hash: null, ts: new Date('2026-08-21T10:00:00Z') },
    { agent_id: 'dc-3', hash: null, ts: new Date('2026-08-21T10:00:00Z') }
  ];
  const out = buildClassShape('users', rows);
  assert.equal(out.consensus_hash, null);
  assert.equal(out.consensus_count, 0);
  assert.equal(out.agent_count, 3);
  assert.equal(out.outliers.length, 3);
  // Every outlier is a null hash (the class-level failure propagated)
  assert.ok(out.outliers.every(o => o.hash === null));
});

test('buildClassShape: all 3 hashes distinct → tie-break by MAX(ts) picks latest', () => {
  // All 3 have count=1, so we fall to the tie-break rule. Hash B's agent has
  // the most recent ts, so HASH_B wins.
  const rows = [
    { agent_id: 'dc-1', hash: HASH_A, ts: new Date('2026-08-21T09:00:00Z') },
    { agent_id: 'dc-2', hash: HASH_B, ts: new Date('2026-08-21T10:30:00Z') },
    { agent_id: 'dc-3', hash: HASH_C, ts: new Date('2026-08-21T10:00:00Z') }
  ];
  const out = buildClassShape('users', rows);
  assert.equal(out.consensus_hash, HASH_B);
  assert.equal(out.consensus_count, 1);
  assert.equal(out.agent_count, 3);
  assert.equal(out.outliers.length, 2);
  // dc-1 (A) and dc-3 (C) are outliers; both differ from HASH_B
  const outlierIds = out.outliers.map(o => o.agent_id).sort();
  assert.deepEqual(outlierIds, ['dc-1', 'dc-3']);
});

test('buildClassShape: outliers sorted by agent_id ASC for stable UI', () => {
  // Same 3-hash scenario as above but with shuffled agent_ids. The
  // tie-break winner is still HASH_B (latest ts), and outliers are
  // dc-1 + dc-3 — but the OUTLIER LIST should be sorted by agent_id ASC.
  const rows = [
    { agent_id: 'dc-3', hash: HASH_C, ts: new Date('2026-08-21T10:00:00Z') },
    { agent_id: 'dc-1', hash: HASH_A, ts: new Date('2026-08-21T09:00:00Z') },
    { agent_id: 'dc-2', hash: HASH_B, ts: new Date('2026-08-21T10:30:00Z') }
  ];
  const out = buildClassShape('users', rows);
  assert.equal(out.consensus_hash, HASH_B);
  assert.deepEqual(out.outliers.map(o => o.agent_id), ['dc-1', 'dc-3']);
});

test('buildClassShape: tie on count AND ts → first-encountered wins (insertion order)', () => {
  // 2 hashes each appear 1.5x — actually 1 + 1, so we have to use a different
  // scenario. Use 2 agents per hash (2+2=4 total), same ts. Insertion order
  // determines winner. This pins the tie-break behavior.
  const rows = [
    { agent_id: 'dc-1', hash: HASH_A, ts: new Date('2026-08-21T10:00:00Z') },
    { agent_id: 'dc-2', hash: HASH_A, ts: new Date('2026-08-21T10:00:00Z') },
    { agent_id: 'dc-3', hash: HASH_B, ts: new Date('2026-08-21T10:00:00Z') },
    { agent_id: 'dc-4', hash: HASH_B, ts: new Date('2026-08-21T10:00:00Z') }
  ];
  const out = buildClassShape('users', rows);
  // Both have count 2 and same ts. HASH_A was inserted first → wins.
  assert.equal(out.consensus_hash, HASH_A);
  assert.equal(out.consensus_count, 2);
  assert.deepEqual(out.outliers.map(o => o.agent_id), ['dc-3', 'dc-4']);
});

test('buildClassShape: agents with null hash always in outliers even when non-null consensus exists', () => {
  const rows = [
    { agent_id: 'dc-1', hash: HASH_A, ts: new Date('2026-08-21T10:00:00Z') },
    { agent_id: 'dc-2', hash: HASH_A, ts: new Date('2026-08-21T10:00:00Z') },
    { agent_id: 'dc-3', hash: null,  ts: new Date('2026-08-21T10:00:00Z') }
  ];
  const out = buildClassShape('users', rows);
  assert.equal(out.consensus_hash, HASH_A);
  assert.equal(out.consensus_count, 2);
  assert.equal(out.outliers.length, 1);
  assert.equal(out.outliers[0].agent_id, 'dc-3');
  assert.equal(out.outliers[0].hash, null);
});

// ----- deriveConsistency (integration with db.query) -----

test('deriveConsistency: empty result → all 3 classes have null/0/[]', async () => {
  const { db } = makeMock([]);
  const result = await deriveConsistency(db);
  assert.deepEqual(result, {
    users:  { class: 'users',  consensus_hash: null, consensus_count: 0, agent_count: 0, outliers: [] },
    groups: { class: 'groups', consensus_hash: null, consensus_count: 0, agent_count: 0, outliers: [] },
    gpos:   { class: 'gpos',   consensus_hash: null, consensus_count: 0, agent_count: 0, outliers: [] }
  });
});

test('deriveConsistency: all agents agree on every class → no outliers', async () => {
  const ts = new Date('2026-08-21T10:00:00Z');
  const latestRows = [
    row('dc-1', { user_hash: HASH_A, group_hash: HASH_B, gpo_hash: HASH_C, ts }),
    row('dc-2', { user_hash: HASH_A, group_hash: HASH_B, gpo_hash: HASH_C, ts }),
    row('dc-3', { user_hash: HASH_A, group_hash: HASH_B, gpo_hash: HASH_C, ts })
  ];
  const { db } = makeMock(latestRows);
  const result = await deriveConsistency(db);
  assert.equal(result.users.consensus_hash, HASH_A);
  assert.equal(result.users.consensus_count, 3);
  assert.deepEqual(result.users.outliers, []);
  assert.equal(result.groups.consensus_hash, HASH_B);
  assert.equal(result.gpos.consensus_hash, HASH_C);
});

test('deriveConsistency: outlier in users only → groups + gpos still agree', async () => {
  const ts = new Date('2026-08-21T10:00:00Z');
  const HASH_X = 'd'.repeat(64); // differs only on users
  const latestRows = [
    row('dc-1', { user_hash: HASH_A, group_hash: HASH_B, gpo_hash: HASH_C, ts }),
    row('dc-2', { user_hash: HASH_A, group_hash: HASH_B, gpo_hash: HASH_C, ts }),
    row('dc-3', { user_hash: HASH_X, group_hash: HASH_B, gpo_hash: HASH_C, ts })
  ];
  const { db } = makeMock(latestRows);
  const result = await deriveConsistency(db);
  assert.equal(result.users.consensus_hash, HASH_A);
  assert.equal(result.users.consensus_count, 2);
  assert.equal(result.users.outliers.length, 1);
  assert.equal(result.users.outliers[0].agent_id, 'dc-3');
  assert.equal(result.users.outliers[0].hash, HASH_X);
  // groups + gpos unaffected — both fully agree
  assert.equal(result.groups.consensus_count, 3);
  assert.equal(result.gpos.consensus_count, 3);
  assert.deepEqual(result.groups.outliers, []);
  assert.deepEqual(result.gpos.outliers, []);
});

test('deriveConsistency: shape has snake_case keys at every level', async () => {
  const ts = new Date('2026-08-21T10:00:00Z');
  const latestRows = [
    row('dc-1', { user_hash: HASH_A, group_hash: HASH_B, gpo_hash: HASH_C, ts }),
    row('dc-2', { user_hash: HASH_B, group_hash: HASH_B, gpo_hash: HASH_C, ts })
  ];
  const { db } = makeMock(latestRows);
  const result = await deriveConsistency(db);
  // Top-level class keys
  for (const className of ['users', 'groups', 'gpos']) {
    const c = result[className];
    assert.ok('consensus_hash' in c, `${className} must have consensus_hash`);
    assert.ok('consensus_count' in c, `${className} must have consensus_count`);
    assert.ok('agent_count' in c, `${className} must have agent_count`);
    assert.ok('outliers' in c, `${className} must have outliers`);
    // No camelCase leakage
    for (const k of Object.keys(c)) {
      assert.ok(!/[A-Z]/.test(k), `${className}.${k} must be snake_case`);
    }
    for (const o of c.outliers) {
      assert.ok('agent_id' in o, 'outlier must have agent_id');
      assert.ok('hash' in o, 'outlier must have hash');
      assert.ok('collected_at' in o, 'outlier must have collected_at');
      for (const k of Object.keys(o)) {
        assert.ok(!/[A-Z]/.test(k), `outlier.${k} must be snake_case`);
      }
    }
  }
});

test('deriveConsistency: all-failed users class (error_code bit 1 set) → null consensus', async () => {
  const ts = new Date('2026-08-21T10:00:00Z');
  const latestRows = [
    // All 3 agents: users class failed (user_hash null), others succeeded
    row('dc-1', { user_hash: null, group_hash: HASH_B, gpo_hash: HASH_C, ts }),
    row('dc-2', { user_hash: null, group_hash: HASH_B, gpo_hash: HASH_C, ts }),
    row('dc-3', { user_hash: null, group_hash: HASH_B, gpo_hash: HASH_C, ts })
  ];
  const { db } = makeMock(latestRows);
  const result = await deriveConsistency(db);
  assert.equal(result.users.consensus_hash, null);
  assert.equal(result.users.consensus_count, 0);
  assert.equal(result.users.agent_count, 3);
  assert.equal(result.users.outliers.length, 3);
  assert.ok(result.users.outliers.every(o => o.hash === null));
  // groups + gpos still fully agree
  assert.equal(result.groups.consensus_hash, HASH_B);
  assert.equal(result.groups.consensus_count, 3);
  assert.equal(result.gpos.consensus_hash, HASH_C);
});

test('deriveConsistency: tie on count + different ts → latest ts wins (groups class)', async () => {
  // Construct a scenario where 2 hashes have equal count (1 each) but
  // different MAX(ts). HASH_A's only agent reported at 09:00, HASH_B's at
  // 11:00 → tie-break rule selects HASH_B.
  const latestRows = [
    row('dc-1', {
      user_hash: HASH_A,
      group_hash: HASH_A,
      gpo_hash: HASH_C,
      ts: new Date('2026-08-21T09:00:00Z')
    }),
    row('dc-2', {
      user_hash: HASH_B,
      group_hash: HASH_B,
      gpo_hash: HASH_C,
      ts: new Date('2026-08-21T11:00:00Z')
    })
  ];
  const { db } = makeMock(latestRows);
  const result = await deriveConsistency(db);
  // Users class: 2 distinct hashes, both count 1. dc-2 has the latest ts,
  // so HASH_B wins for users too.
  assert.equal(result.users.consensus_hash, HASH_B);
  assert.equal(result.users.consensus_count, 1);
  assert.equal(result.users.outliers.length, 1);
  assert.equal(result.users.outliers[0].agent_id, 'dc-1');
  // Groups class: same scenario as users — HASH_B wins.
  assert.equal(result.groups.consensus_hash, HASH_B);
  assert.equal(result.groups.outliers[0].agent_id, 'dc-1');
});

test('deriveConsistency: queries the consistency SQL via db.sql registry', async () => {
  const ts = new Date('2026-08-21T10:00:00Z');
  const { db, records } = makeMock([
    row('dc-1', { user_hash: HASH_A, group_hash: HASH_B, gpo_hash: HASH_C, ts })
  ]);
  await deriveConsistency(db);
  // First recorded query should be the latestPerAgent query
  assert.match(records[0].sql, /pkg_ad_domain_consistency/i);
});

test('deriveConsistency: defaults to getDb() when called without arg', async () => {
  // Build a default-state mock and install via _setDbForTest so the service's
  // getDb() returns it. Use the buildMockDb helper which knows the dialect.
  const ts = new Date('2026-08-21T10:00:00Z');
  const fakeRows = [
    row('dc-1', { user_hash: HASH_A, group_hash: HASH_B, gpo_hash: HASH_C, ts })
  ];
  const db = buildMockDb([
    { match: /pkg_ad_domain_consistency/i, rows: fakeRows }
  ], { dialect: 'mysql' }).standard();
  _setDbForTest(db);
  try {
    const result = await deriveConsistency();
    assert.equal(result.users.consensus_hash, HASH_A);
    assert.equal(result.users.consensus_count, 1);
  } finally {
    _setDbForTest(null);
  }
});
