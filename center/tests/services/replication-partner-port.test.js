// Tests for the partner_port_status JSON column added to ad_replication_status
// by migration 016. Mocks the db facade (no real DB) and asserts that
// upsertStatus() round-trips the partnerPortStatus field correctly through
// rowParams():
//
//   1. INSERT path — partnerPortStatus object round-trips as a JSON string
//      in the bound params and the SQL column list includes partner_port_status.
//   2. NULL path — undefined/null partnerPortStatus becomes a NULL param so
//      pre-feature rows and callers that omit the field stay valid.
//   3. UPDATE path — re-upserting the same (sourceDc, destDc, namingContext)
//      key exercises the ON DUPLICATE KEY UPDATE / MERGE WHEN MATCHED branch,
//      so partner_port_status is overwritten with the new value (not just
//      inserted once).
//
// All three tests use the project's buildRecordingPool helper so they share
// the same mocking style as tests/replication.test.js. We exercise BOTH
// dialects because MySQL and MSSQL diverge on the upsert shape (INSERT ...
// ON DUPLICATE KEY UPDATE vs MERGE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _setDbForTest } from '../../src/db/index.js';
import { upsertStatus } from '../../src/services/replication.js';
import { buildMockDb } from '../helpers/db-mock.js';

const baseRow = {
  agentId: 'agent-1',
  collectedAt: new Date('2026-08-20T00:00:00Z'),
  sourceDc: 'DC-A',
  destDc: 'DC-B',
  sourceSite: 'SiteA',
  destSite: 'SiteB',
  namingContext: 'DC=example,DC=com',
  lastSuccessTime: new Date('2026-08-19T23:55:00Z'),
  lastAttemptTime: new Date('2026-08-19T23:55:30Z'),
  statusCode: 0,
  errorMessage: null
};

const samplePartnerPortStatus = [
  { port: 389, state: 'ok' },
  { port: 636, state: 'ok' },
  { port: 3268, state: 'unreachable' }
];

// MySQL (dialect: 'mysql') — INSERT ... ON DUPLICATE KEY UPDATE path.
test('mysql: upsertStatus INSERTs partner_port_status with JSON-stringified payload', async () => {
  const records = [];
  const db = buildMockDb([], { dialect: 'mysql' }).withRecording(records);
  _setDbForTest(db);
  const row = { ...baseRow, partnerPortStatus: samplePartnerPortStatus };
  await upsertStatus([row], { appendHistory: false });
  assert.equal(records.length, 1);
  // SQL column list must include the new column in both the INSERT and
  // the ON DUPLICATE KEY UPDATE clause.
  assert.match(records[0].sql, /partner_port_status/i);
  assert.match(records[0].sql, /partner_port_status\s*=\s*VALUES\(partner_port_status\)/i);
  // 16 bound params: 15 legacy + partner_port_status at index 15.
  assert.equal(records[0].params.length, 16);
  // Param 15 must be a JSON string (driver wraps JSON-bound values; we
  // pre-stringify so the column receives a JSON-encoded string in the mock
  // capture too). Round-trip parse equality verifies shape.
  const json = records[0].params[15];
  assert.equal(typeof json, 'string');
  assert.deepEqual(JSON.parse(json), samplePartnerPortStatus);
});

test('mysql: upsertStatus binds NULL when partnerPortStatus is omitted', async () => {
  const records = [];
  const db = buildMockDb([], { dialect: 'mysql' }).withRecording(records);
  _setDbForTest(db);
  // Pre-feature caller — no partnerPortStatus field at all.
  await upsertStatus([baseRow], { appendHistory: false });
  assert.equal(records.length, 1);
  assert.equal(records[0].params.length, 16);
  assert.equal(records[0].params[15], null, 'omitted partnerPortStatus -> null param');
});

test('mysql: upsertStatus binds NULL when partnerPortStatus is explicitly null', async () => {
  const records = [];
  const db = buildMockDb([], { dialect: 'mysql' }).withRecording(records);
  _setDbForTest(db);
  await upsertStatus([{ ...baseRow, partnerPortStatus: null }], { appendHistory: false });
  assert.equal(records[0].params[15], null);
});

test('mysql: upsertStatus UPDATE path overwrites partner_port_status on re-upsert', async () => {
  const records = [];
  const db = buildMockDb([], { dialect: 'mysql' }).withRecording(records);
  _setDbForTest(db);
  // First upsert: INSERT (no existing row for this key).
  await upsertStatus([{ ...baseRow, partnerPortStatus: samplePartnerPortStatus }]);
  assert.equal(records.length, 1);
  // Second upsert with a different payload but the same (sourceDc, destDc,
  // namingContext) key — driver still issues the SAME upsertStatus SQL
  // (we mock at the db facade, so the dialect's ON DUPLICATE KEY UPDATE
  // branch is what the production driver would exercise). Assert the new
  // JSON string is what got bound on the second call.
  const updated = [{ port: 389, state: 'ok' }, { port: 636, state: 'degraded' }];
  await upsertStatus([{ ...baseRow, partnerPortStatus: updated }]);
  assert.equal(records.length, 2);
  assert.deepEqual(JSON.parse(records[1].params[15]), updated);
  // Both calls bind a 16-element param tuple so the column position stays
  // stable across INSERT and UPDATE.
  assert.equal(records[0].params.length, 16);
  assert.equal(records[1].params.length, 16);
});

// MSSQL (dialect: 'mssql') — MERGE WHEN MATCHED THEN UPDATE path.
test('mssql: upsertStatus MERGEs partner_port_status with JSON-stringified payload', async () => {
  const records = [];
  const db = buildMockDb([], { dialect: 'mssql' }).withRecording(records);
  _setDbForTest(db);
  const row = { ...baseRow, partnerPortStatus: samplePartnerPortStatus };
  await upsertStatus([row], { appendHistory: false });
  assert.equal(records.length, 1);
  // MERGE shape: column list, INSERT list, and UPDATE SET clause all reference
  // the new column.
  assert.match(records[0].sql, /MERGE\s+INTO\s+ad_replication_status/i);
  assert.match(records[0].sql, /partner_port_status/i);
  assert.match(records[0].sql, /WHEN\s+MATCHED\s+THEN\s+UPDATE\s+SET[\s\S]*partner_port_status\s*=\s*s\.partner_port_status/i);
  assert.match(records[0].sql, /WHEN\s+NOT\s+MATCHED\s+THEN\s+INSERT[\s\S]*partner_port_status[\s\S]*VALUES/i);
  assert.equal(records[0].params.length, 16);
  const json = records[0].params[15];
  assert.equal(typeof json, 'string');
  assert.deepEqual(JSON.parse(json), samplePartnerPortStatus);
});

test('mssql: upsertStatus binds NULL when partnerPortStatus is omitted', async () => {
  const records = [];
  const db = buildMockDb([], { dialect: 'mssql' }).withRecording(records);
  _setDbForTest(db);
  await upsertStatus([baseRow], { appendHistory: false });
  assert.equal(records[0].params[15], null, 'omitted partnerPortStatus -> null param');
});

test('mssql: upsertStatus UPDATE path overwrites partner_port_status on re-upsert', async () => {
  const records = [];
  const db = buildMockDb([], { dialect: 'mssql' }).withRecording(records);
  _setDbForTest(db);
  await upsertStatus([{ ...baseRow, partnerPortStatus: samplePartnerPortStatus }]);
  const updated = [{ port: 389, state: 'ok' }];
  await upsertStatus([{ ...baseRow, partnerPortStatus: updated }]);
  assert.equal(records.length, 2);
  assert.deepEqual(JSON.parse(records[1].params[15]), updated);
  assert.equal(records[0].params.length, 16);
  assert.equal(records[1].params.length, 16);
});

// Shared round-trip assertion (uses both dialects' mock): the partnerPortStatus
// JS object survives the JSON.stringify / parse round-trip unchanged.
test('partnerPortStatus JS object survives JSON round-trip for both dialects', async () => {
  for (const dialect of ['mysql', 'mssql']) {
    const records = [];
    const db = buildMockDb([], { dialect }).withRecording(records);
    _setDbForTest(db);
    const payload = { partners: [{ host: 'dc-b.example.com', port: 389, state: 'ok' }] };
    await upsertStatus([{ ...baseRow, partnerPortStatus: payload }]);
    assert.deepEqual(
      JSON.parse(records[0].params[15]),
      payload,
      `${dialect}: round-trip mismatch`
    );
  }
});