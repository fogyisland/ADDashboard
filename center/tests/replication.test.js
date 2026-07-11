import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upsertStatus } from '../src/services/replication.js';
import { buildRecordingPool } from './helpers/mysql-pool.js';

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

test('upsertStatus issues an INSERT ... ON DUPLICATE KEY UPDATE per row', async () => {
  const records = [];
  const pool = buildRecordingPool(records);
  await upsertStatus(pool, [baseRow], { appendHistory: false });
  assert.equal(records.length, 1, 'expected exactly one query');
  assert.match(records[0].sql, /INSERT\s+INTO\s+ad_replication_status/i);
  assert.match(records[0].sql, /ON\s+DUPLICATE\s+KEY\s+UPDATE/i);
});

test('upsertStatus with appendHistory:true issues UPSERT + history INSERT per row', async () => {
  const records = [];
  const pool = buildRecordingPool(records);
  await upsertStatus(pool, [baseRow], { appendHistory: true });
  assert.equal(records.length, 2, 'expected exactly two queries');
  assert.match(records[0].sql, /INSERT\s+INTO\s+ad_replication_status/i);
  assert.match(records[1].sql, /INSERT\s+INTO\s+ad_replication_history/i);
});

test('upsertStatus binds agentId, sourceDc, destDc, namingContext as positional params', async () => {
  const records = [];
  const pool = buildRecordingPool(records);
  await upsertStatus(pool, [baseRow], { appendHistory: false });
  const params = records[0].params;
  // Param order per rowParams(): collectedAt, agentId, sourceDc, destDc,
  // sourceSite, destSite, namingContext, lastSuccessTime, lastAttemptTime,
  // statusCode, errorMessage
  assert.equal(params[1], 'agent-1');
  assert.equal(params[2], 'DC-A');
  assert.equal(params[3], 'DC-B');
  assert.equal(params[6], 'DC=example,DC=com');
});

test('upsertStatus coerces null/undefined nullable text fields to null', async () => {
  const records = [];
  const pool = buildRecordingPool(records);
  const row = { ...baseRow, sourceSite: undefined, errorMessage: undefined };
  await upsertStatus(pool, [row], { appendHistory: false });
  const params = records[0].params;
  assert.equal(params[4], null, 'sourceSite -> null');
  assert.equal(params[10], null, 'errorMessage -> null');
});
