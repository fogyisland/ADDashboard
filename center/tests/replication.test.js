import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _setDbForTest } from '../src/db/index.js';
import { upsertStatus } from '../src/services/replication.js';
import { buildRecordingPool } from './helpers/db-mock.js';

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
  const db = buildRecordingPool(records);
  _setDbForTest(db);
  await upsertStatus([baseRow], { appendHistory: false });
  assert.equal(records.length, 1, 'expected exactly one query');
  assert.match(records[0].sql, /INSERT\s+INTO\s+ad_replication_status/i);
  assert.match(records[0].sql, /ON\s+DUPLICATE\s+KEY\s+UPDATE/i);
});

test('upsertStatus with appendHistory:true issues UPSERT + history INSERT per row', async () => {
  const records = [];
  const db = buildRecordingPool(records);
  _setDbForTest(db);
  await upsertStatus([baseRow], { appendHistory: true });
  assert.equal(records.length, 2, 'expected exactly two queries');
  assert.match(records[0].sql, /INSERT\s+INTO\s+ad_replication_status/i);
  assert.match(records[1].sql, /INSERT\s+INTO\s+ad_replication_history/i);
});

test('upsertStatus binds agentId, sourceDc, destDc, namingContext as positional params', async () => {
  const records = [];
  const db = buildRecordingPool(records);
  _setDbForTest(db);
  await upsertStatus([baseRow], { appendHistory: false });
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
  const db = buildRecordingPool(records);
  _setDbForTest(db);
  const row = { ...baseRow, sourceSite: undefined, errorMessage: undefined };
  await upsertStatus([row], { appendHistory: false });
  const params = records[0].params;
  assert.equal(params[4], null, 'sourceSite -> null');
  assert.equal(params[10], null, 'errorMessage -> null');
});

// 2026-08-25 production p5 NVARCHAR bug: KDLWXOFADSRV1 reports were rejected
// because sourceSite reached p5 as a non-null non-string value, which the
// tedious NVARCHAR validator rejects ("Validation failed for parameter 'p5'.
// Invalid string."). The new asNullableString() coercion in rowParams()
// must:
//   - leave true null as null (so the SQL MERGE sets the column to NULL)
//   - coerce a stray non-string non-null value (0, false, {}, etc.) to a
//     string so the driver accepts the parameter
test('upsertStatus: sourceSite=null stays null at p5 (no NVARCHAR crash)', async () => {
  const records = [];
  const db = buildRecordingPool(records);
  _setDbForTest(db);
  const row = { ...baseRow, sourceSite: null, destSite: null };
  await upsertStatus([row], { appendHistory: false });
  const params = records[0].params;
  assert.equal(params[4], null, 'sourceSite=null must stay null');
  assert.equal(params[5], null, 'destSite=null must stay null');
});

test('upsertStatus: non-string non-null sourceSite is coerced to string (defensive)', async () => {
  // Simulate the production shape where PS1 emitted a number / object instead
  // of a string. The ?? null fallback only catches null/undefined, so a 0 /
  // false / {} slips through. asNullableString must coerce these so the
  // MSSQL driver accepts the parameter.
  const records = [];
  const db = buildRecordingPool(records);
  _setDbForTest(db);
  const row1 = { ...baseRow, sourceSite: 0 };
  await upsertStatus([row1], { appendHistory: false });
  assert.equal(records[0].params[4], '0', 'sourceSite=0 must coerce to "0"');
  const row2 = { ...baseRow, sourceSite: false };
  await upsertStatus([row2], { appendHistory: false });
  assert.equal(records[1].params[4], 'false', 'sourceSite=false must coerce to "false"');
});

// 2026-08-27 round-25 bug: rowParams() checked `row.naming_context` (snake_case)
// to gate the per-DC counters, but the route layer passes the camelCase
// payload straight from agent/src/reporter.js#toCamelEntry. So isSummary
// was always false → usersCount/groupsCount/gposCount always NULL on
// __dc_summary__ rows. The Server Overview consequently renders "—" for
// every mock DC (and was probably doing the same for real DCs, masked by
// the fact that some teams populate users/groups via package-side packages
// instead). Fix: rowParams() must read row.namingContext (camelCase, matching
// the postReport wire shape) and the new test pins that contract.
test('upsertStatus: __dc_summary__ row carries usersCount/groupsCount/gposCount to SQL params', async () => {
  const records = [];
  const db = buildRecordingPool(records);
  _setDbForTest(db);
  const summaryRow = {
    ...baseRow,
    sourceDc: 'DC-SUMMARY',
    destDc: 'DC-SUMMARY',
    namingContext: '__dc_summary__',
    usersCount: 1234,
    groupsCount: 56,
    gposCount: 7,
    lockedCount: 1
  };
  await upsertStatus([summaryRow], { appendHistory: false });
  const params = records[0].params;
  // rowParams order: collectedAt(0), agentId(1), sourceDc(2), destDc(3),
  // sourceSite(4), destSite(5), namingContext(6), lastSuccessTime(7),
  // lastAttemptTime(8), statusCode(9), errorMessage(10), usersCount(11),
  // groupsCount(12), gposCount(13), lockedCount(14)
  // 2026-08-28 round-45: partnerPortStatus(15) removed — R35 port monitoring
  // surface dropped. Schema column kept inert; binding list is now 15 deep.
  assert.equal(params[11], 1234, 'usersCount must be bound for __dc_summary__ row');
  assert.equal(params[12], 56,   'groupsCount must be bound for __dc_summary__ row');
  assert.equal(params[13], 7,    'gposCount must be bound for __dc_summary__ row');
  assert.equal(params[14], 1,    'lockedCount must be bound for __dc_summary__ row');
});

test('upsertStatus: per-link entries keep usersCount/groupsCount/gposCount null', async () => {
  // Even if a per-link entry somehow ships counter values (it shouldn't), the
  // service must not propagate them — only __dc_summary__ rows are the
  // counters' home. This guards against future PS1 drift.
  const records = [];
  const db = buildRecordingPool(records);
  _setDbForTest(db);
  const linkRow = {
    ...baseRow,
    namingContext: 'CN=link-A',
    usersCount: 999, // noise that should be ignored
    groupsCount: 999,
    gposCount: 999,
    lockedCount: 999
  };
  await upsertStatus([linkRow], { appendHistory: false });
  const params = records[0].params;
  assert.equal(params[11], null, 'usersCount must be null on non-summary rows');
  assert.equal(params[12], null, 'groupsCount must be null on non-summary rows');
  assert.equal(params[13], null, 'gposCount must be null on non-summary rows');
  assert.equal(params[14], null, 'lockedCount must be null on non-summary rows');
});