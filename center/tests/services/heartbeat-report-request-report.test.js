// Unit tests for heartbeatReportService.requestReport(agentId) — round-12 T3.
//
// The service must:
//   1. Detect whether the agent row exists in ad_agent_heartbeat (throw
//      AgentNotFoundError if not — UPSERT would silently INSERT a stub row
//      so we cannot rely on the INSERT outcome).
//   2. Detect whether a pending request is already set (return
//      alreadyPending: true when report_requested_at is non-null).
//   3. Call the requestReport UPSERT (db.sql.heartbeat.requestReport) with
//      [agentId, requestedAt] bound params and return the result envelope.
//
// These tests use buildMockDb to stub three SQL calls: SELECT 1 (existence),
// SELECT report_requested_at (alreadyPending), INSERT (UPSERT). The mock
// returns rows shaped like the real driver (`{ rows }`); the service must
// read .rows defensively.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heartbeatReportService } from '../../src/services/heartbeat-report.js';
import { buildMockDb } from '../helpers/db-mock.js';

test('requestReport sets report_requested_at on existing agent', async () => {
  const records = [];
  const db = buildMockDb([
    { match: /SELECT\s+1\s+FROM\s+ad_agent_heartbeat\s+WHERE\s+agent_id\s*=\s*\?/i,
      rows: [{ '1': 1 }] },
    { match: /SELECT\s+report_requested_at\s+FROM\s+ad_agent_heartbeat\s+WHERE\s+agent_id\s*=\s*\?/i,
      rows: [{ report_requested_at: null }] },
    { match: /INSERT\s+INTO\s+ad_agent_heartbeat/i,
      rows: [],
      onExecute: (sql, params) => records.push({ sql, params }) }
  ]).standard();

  const out = await heartbeatReportService.requestReport('KDLWXOFADSRV1', db);
  assert.equal(out.agentId, 'KDLWXOFADSRV1');
  assert.ok(out.requestedAt instanceof Date, 'requestedAt must be Date');
  assert.equal(out.alreadyPending, false);
  // The UPSERT is the third SQL call (existence SELECT, then alreadyPending
  // SELECT, then UPSERT INSERT). At least one INSERT must have been issued.
  assert.ok(records.length >= 1, 'expected INSERT to have been captured');
  assert.equal(records[0].params[0], 'KDLWXOFADSRV1');
  assert.ok(records[0].params[1] instanceof Date, 'requestedAt must be bound as Date');
});

test('requestReport returns alreadyPending=true when flag is already set', async () => {
  const db = buildMockDb([
    { match: /SELECT\s+1\s+FROM\s+ad_agent_heartbeat\s+WHERE\s+agent_id\s*=\s*\?/i,
      rows: [{ '1': 1 }] },
    { match: /SELECT\s+report_requested_at\s+FROM\s+ad_agent_heartbeat\s+WHERE\s+agent_id\s*=\s*\?/i,
      rows: [{ report_requested_at: new Date('2026-08-24T09:00:00Z') }] },
    { match: /INSERT\s+INTO\s+ad_agent_heartbeat/i, rows: [] }
  ]).standard();

  const out = await heartbeatReportService.requestReport('KDLWXOFADSRV1', db);
  assert.equal(out.agentId, 'KDLWXOFADSRV1');
  assert.equal(out.alreadyPending, true);
});

test('requestReport throws AgentNotFoundError when agent is not registered', async () => {
  const db = buildMockDb([{
    match: /SELECT\s+1\s+FROM\s+ad_agent_heartbeat\s+WHERE\s+agent_id\s*=\s*\?/i,
    rows: []
  }]).standard();

  await assert.rejects(
    heartbeatReportService.requestReport('unknown-agent', db),
    (err) => err.code === 'AGENT_NOT_FOUND' && err.agentId === 'unknown-agent'
  );
});
