import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upsertStatus } from '../src/services/replication.js';

// Fake pool that records every query() call into an array.
// Returns a promise of { recordset: [] } so awaiting doesn't blow up.
function buildRecordingPool(records) {
  return {
    request() {
      const self = {
        _inputs: {},
        input(k, v) { self._inputs[k] = v; return self; },
        async query(q) {
          records.push({ sql: q, inputs: { ...self._inputs } });
          return { recordset: [] };
        }
      };
      return self;
    }
  };
}

const baseRow = {
  agentId: 'agent-1',
  collectedAt: new Date('2026-07-11T00:00:00Z'),
  sourceDc: 'DC-A',
  destDc: 'DC-B',
  sourceSite: 'SiteA',
  destSite: 'SiteB',
  namingContext: 'DC=example,DC=com',
  lastSuccessTime: new Date('2026-07-10T23:55:00Z'),
  lastAttemptTime: new Date('2026-07-10T23:55:30Z'),
  statusCode: 0,
  errorMessage: null
};

test('upsertStatus issues a MERGE per row', async () => {
  const records = [];
  const pool = buildRecordingPool(records);
  await upsertStatus(pool, [baseRow], { appendHistory: false });
  assert.equal(records.length, 1, 'expected exactly one query');
  assert.match(records[0].sql, /MERGE\s+INTO\s+ad_replication_status/i);
});

test('upsertStatus with appendHistory:true issues MERGE + INSERT per row', async () => {
  const records = [];
  const pool = buildRecordingPool(records);
  await upsertStatus(pool, [baseRow], { appendHistory: true });
  assert.equal(records.length, 2, 'expected exactly two queries');
  assert.match(records[0].sql, /MERGE\s+INTO\s+ad_replication_status/i);
  assert.match(records[1].sql, /INSERT\s+INTO\s+ad_replication_history/i);
});

test('upsertStatus binds agentId and namingContext as inputs', async () => {
  const records = [];
  const pool = buildRecordingPool(records);
  await upsertStatus(pool, [baseRow], { appendHistory: false });
  assert.equal(records[0].inputs.agentId, 'agent-1');
  assert.equal(records[0].inputs.namingContext, 'DC=example,DC=com');
});

test('upsertStatus coerces null/undefined nullable text fields to null', async () => {
  const records = [];
  const pool = buildRecordingPool(records);
  const row = { ...baseRow, sourceSite: undefined, errorMessage: undefined };
  await upsertStatus(pool, [row], { appendHistory: false });
  assert.equal(records[0].inputs.sourceSite, null);
  assert.equal(records[0].inputs.errorMessage, null);
});