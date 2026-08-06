import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import supertest from 'supertest';
import { agentRouter } from '../src/routes/agent.js';
import { _setDbForTest } from '../src/db/index.js';
import { buildMockDb } from './helpers/db-mock.js';

function buildApp({ agentTokenValue = 'test-token' } = {}) {
  const a = express();
  a.use(express.json());
  return a.use(agentRouter({
    config: { agentToken: agentTokenValue },
    logger: { info() {}, warn() {}, error() {}, debug() {} }
  }));
}

test('POST /api/agent/report persists lockoutEvents via db.sql.lockout.upsertEvent', async () => {
  const records = [];
  const db = buildMockDb().withRecording(records);
  // data:[] is allowed by the existing validation; replication upsert is a
  // no-op on empty array. buildMockDb.standard() returns empty rows for any
  // unmatched query, so getConfig() returns {} and history_enabled is false.
  _setDbForTest(db);

  const res = await supertest(buildApp({ agentTokenValue: 'test-token' }))
    .post('/api/agent/report')
    .set('X-Agent-Token', 'test-token')
    .send({
      agentId: 'DC01',
      collectedAt: '2026-08-06T10:00:00.000Z',
      data: [],
      lockoutEvents: [
        {
          eventRecordId: 12345678,
          occurredAt: '2026-08-06T09:45:00.000Z',
          targetUserName: 'alice',
          subjectUserName: 'DC01$',
          subjectDomain: 'CORP',
          callerComputerName: 'WS-DEV-42'
        },
        {
          eventRecordId: 12345679,
          occurredAt: '2026-08-06T09:50:00.000Z',
          targetUserName: 'alice',
          subjectUserName: 'DC01$',
          subjectDomain: 'CORP',
          callerComputerName: 'WS-DEV-42'
        }
      ]
    });

  assert.equal(res.status, 200);

  // Find the upsertEvent calls
  const upsertCalls = records.filter((r) => r.sql === db.sql.lockout.upsertEvent);
  assert.equal(upsertCalls.length, 2, `expected 2 upsertEvent calls, got ${upsertCalls.length}`);

  // First event: 9 params in the order [occurredAt, collectedAt, agentId, dcName,
  // eventRecordId, targetUserName, subjectUserName, subjectDomain, callerComputerName]
  const p0 = upsertCalls[0].params;
  assert.equal(p0.length, 9, `expected 9 params, got ${p0.length}`);
  // occurredAt / collectedAt are passed through toMysqlDatetime, which converts
  // ISO 8601 to MySQL DATETIME ("YYYY-MM-DD HH:MM:SS") since the columns are
  // DATETIME (no fractional seconds) per migration 008.
  assert.equal(p0[0], '2026-08-06 09:45:00');         // occurredAt (converted)
  assert.equal(p0[1], '2026-08-06 10:00:00');         // collectedAt (converted from payload.collectedAt)
  assert.equal(p0[2], 'DC01');                       // agentId
  assert.equal(p0[3], 'DC01');                       // dcName — falls back to agentId when not in payload
  assert.equal(p0[4], 12345678);                     // eventRecordId
  assert.equal(p0[5], 'alice');                      // targetUserName
  assert.equal(p0[6], 'DC01$');                      // subjectUserName
  assert.equal(p0[7], 'CORP');                       // subjectDomain
  assert.equal(p0[8], 'WS-DEV-42');                  // callerComputerName
});