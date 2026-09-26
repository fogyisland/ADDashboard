// lockout-etl.test.js — R107.1 centre-side ETL coverage.
//
// Closes the gap that /admin/lockout-troubleshooting returned zero rows
// even though the agent's ad_lockout_list (v2 package) was running on
// real DCs — the JSON-array payload in pkg_ad_lockout_list.metrics was
// never split into individual rows in ad_lockout_events. See
// progress_2026_09_25_r107_lockout_events_etl_missing.md.
//
// Three layers of coverage:
//   1. Service-layer wrapper: verify upsertEvent dispatch wiring (params
//      order matches sql.js MySQL helper — 9 params; ids preserved).
//   2. Batch wrapper: skip null entries (missing dedupe key), swallow
//      per-event errors so one bad event doesn't kill the batch.
//   3. Runner post-hook: POST /api/agent/packages/report with an
//      ad_lockout_list run triggers the ETL — assert 200 + per-event
//      upsert calls captured by recording array.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { default as supertest } from 'supertest';
import { buildMockDb } from './helpers/db-mock.js';
import { packageRunner } from '../src/packages/runner.js';
import { agentToken, _resetIdentityGraceForTests } from '../src/auth/agent-token.js';
import * as lockoutService from '../src/services/lockout.js';

// R66 — agentToken middleware reads the bundle from db at request time.
// Token bundle script so X-Agent-Token header is accepted instead of 503.
const AGENT_ID = 'agent-lockout-1';
const TEST_TOKEN = 'test-agent-token';
const TOKEN_BUNDLE_REGEX = /agent_token_(current|previous|rotated_at|previous_ttl_days)/i;
const TOKEN_BUNDLE_SCRIPT = { match: TOKEN_BUNDLE_REGEX, rows: [{ config_key: 'agent_token_current', config_value: TEST_TOKEN }] };

// S82 — reset the 60s identity-binding grace to NOW so the runner tests below
// pass without needing X-Agent-Signature headers. The auth/agent-token tests
// in this run may push _processStartedAt backward via the same hook, so we
// reset here too (idempotent, no-op if already in grace).
_resetIdentityGraceForTests(Date.now());

function buildApp(db) {
  const app = express();
  app.use(express.json());
  const agentMw = agentToken({ db, logger: null });
  app.use(packageRunner({
    db,
    agentMw,
    getLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} })
  }));
  return app;
}

function authHeader() {
  return { 'X-Agent-Token': TEST_TOKEN, 'X-Agent-Id': AGENT_ID };
}

// Helper — match the upsertEvent INSERT/UPDATE in either dialect.
// MySQL: `INSERT ... ON DUPLICATE KEY UPDATE` (line 632).
// MSSQL: `MERGE INTO ad_lockout_events AS t USING (...) AS s ON ...` (line 1589).
const UPSERT_LOCKOUT_REGEX = /(INSERT\s+INTO\s+ad_lockout_events|MERGE\s+INTO\s+ad_lockout_events)/i;

// Real ad_lockout_list manifest declares metricSchema with these 5 keys
// (center/data/packages/ad_lockout_list/1.0.0/manifest.json). The metricstore
// validator (metricstore.js:107-113) rejects unknown keys with PKG_METRIC_KEY_UNKNOWN,
// so the test fixtures must mirror the real schema exactly.
const LOCKOUT_LIST_METRICSCHEMA = {
  agent_id:    { type: 'varchar(64)', nullable: false },
  ts:          { type: 'datetime',    nullable: false },
  events:      { type: 'json' },
  event_count: { type: 'int' },
  error_code:  { type: 'int' }
};

function adLockoutListManifestJson() {
  return JSON.stringify({
    name: 'ad_lockout_list',
    version: '1.0.0',
    type: 'timeseries',
    agent: { minVersion: '1.0.0', script: 'collect.ps1', intervalSec: 900, timeoutMs: 60000 },
    database: { metricTable: 'metrics', metricSchema: LOCKOUT_LIST_METRICSCHEMA },
    metrics: []
  });
}

function adLockoutListScriptRow() {
  return {
    name: 'ad_lockout_list',
    version: '1.0.0',
    script_content: 'Write-Output "ok"',
    script_sha256: 'a'.repeat(64),
    manifest_json: adLockoutListManifestJson(),
    source: 'builtin-seed',
    created_at: new Date(),
    updated_at: new Date()
  };
}

describe('lockout service — upsertEvent dispatch', () => {
  test('calls db.execute with the upsertEvent SQL and 9-param array in correct order', async () => {
    const records = [];
    const db = buildMockDb([
      { match: UPSERT_LOCKOUT_REGEX, rows: [] }
    ]).withRecording(records);

    const evt = {
      occurredAt: '2026-09-25T10:00:00.000Z',
      collectedAt: undefined, // service fills with new Date()
      dcName: 'DC-01',
      eventRecordId: 'rec-1',
      targetUserName: 'alice',
      subjectUserName: 'DC-01$',
      subjectDomain: 'CORP',
      callerComputerName: 'WS-DEV-42'
      // No evt.agentId — service uses the fallbackAgentId arg.
    };

    const res = await lockoutService.upsertEvent(db, evt, AGENT_ID);
    assert.equal(res.ok, true);
    // Exactly one SQL call captured.
    assert.equal(records.length, 1);
    assert.match(records[0].sql, UPSERT_LOCKOUT_REGEX);
    // 9-param order: occurred_at, collected_at, agent_id, dc_name,
    // event_record_id, target_user_name, subject_user_name, subject_domain,
    // caller_computer_name (must match both MySQL line 632 and MSSQL line 1589).
    const p = records[0].params;
    assert.equal(p.length, 9);
    assert.equal(p[0] instanceof Date, true);
    assert.equal(p[1] instanceof Date, true); // collectedAt filled by service
    assert.equal(p[2], AGENT_ID);              // agentId from fallbackAgentId
    assert.equal(p[3], 'DC-01');
    assert.equal(p[4], 'rec-1');
    assert.equal(p[5], 'alice');
    assert.equal(p[6], 'DC-01$');
    assert.equal(p[7], 'CORP');
    assert.equal(p[8], 'WS-DEV-42');
  });

  test('snake_case field names are accepted as fallback (PowerShell wire format)', async () => {
    const records = [];
    const db = buildMockDb([
      { match: UPSERT_LOCKOUT_REGEX, rows: [] }
    ]).withRecording(records);

    const evt = {
      occurred_at: '2026-09-25T10:00:00.000Z',
      dc_name: 'DC-02',
      event_record_id: 'rec-2',
      target_user_name: 'bob',
      subject_user_name: 'DC-02$',
      subject_domain: 'CORP',
      caller_computer_name: 'WS-99'
      // No agentId — fallback to caller-supplied fallback
    };

    const res = await lockoutService.upsertEvent(db, evt, 'fallback-dc');
    assert.equal(res.ok, true);
    const p = records[0].params;
    assert.equal(p[2], 'fallback-dc'); // agentId fallback
    assert.equal(p[3], 'DC-02');
    assert.equal(p[4], 'rec-2');
    assert.equal(p[5], 'bob');
    assert.equal(p[8], 'WS-99');
  });

  test('missing event_record_id returns { ok: false } without issuing SQL', async () => {
    const records = [];
    const db = buildMockDb().withRecording(records);
    const evt = { dcName: 'DC-01', targetUserName: 'alice' };
    const res = await lockoutService.upsertEvent(db, evt);
    assert.equal(res.ok, false);
    assert.match(res.reason, /event_record_id/);
    assert.equal(records.length, 0);
  });
});

describe('lockout service — upsertEvents batch wrapper', () => {
  test('iterates events array, dedupes by event_record_id presence, swallows per-event errors', async () => {
    const records = [];
    const db = buildMockDb([
      { match: UPSERT_LOCKOUT_REGEX, rows: [] },
      // Inject a synthetic failure on the SECOND call to prove one bad
      // event doesn't kill the batch.
      { match: UPSERT_LOCKOUT_REGEX, throwOnExecute: new Error('db timeout'), onExecute: () => {} }
    ]).withRecording(records);

    // Reset to clean state — re-create the db with one throw-on-execute
    // script so we can target a specific call index.
    const records2 = [];
    const db2 = buildMockDb([
      {
        match: UPSERT_LOCKOUT_REGEX,
        rows: [],
        onExecute: (_sql, _params) => {
          // Track call index — fail on the second call only.
          db2.records && db2.records.push({ _tag: 'exec', index: db2.records.length });
          if (db2.records.filter(r => r._tag === 'exec').length === 2) {
            throw new Error('synthetic db timeout');
          }
        }
      }
    ]).withRecording(records2);

    const events = [
      { eventRecordId: 'a', dcName: 'DC-1', targetUserName: 'alice' },
      { eventRecordId: 'b', dcName: 'DC-2', targetUserName: 'bob' },
      { /* missing eventRecordId — should be skipped, not error */ },
      { eventRecordId: 'c', dcName: 'DC-3', targetUserName: 'carol' }
    ];

    const result = await lockoutService.upsertEvents(db2, events, 'agent-x');
    assert.equal(result.upserted, 2); // a, c
    assert.equal(result.skipped, 1);   // missing eventRecordId
    assert.equal(result.errors.length, 1); // the synthetic failure on b
    assert.equal(result.errors[0].error, 'synthetic db timeout');
    assert.equal(result.errors[0].index, 1);
  });

  test('non-array input is a no-op (defensive: collect.ps1 may emit event_count=0)', async () => {
    const records = [];
    const db = buildMockDb().withRecording(records);
    const r1 = await lockoutService.upsertEvents(db, undefined, 'agent');
    const r2 = await lockoutService.upsertEvents(db, null, 'agent');
    const r3 = await lockoutService.upsertEvents(db, 'not-an-array', 'agent');
    assert.deepEqual(r1, { upserted: 0, skipped: 0, errors: [] });
    assert.deepEqual(r2, { upserted: 0, skipped: 0, errors: [] });
    assert.deepEqual(r3, { upserted: 0, skipped: 0, errors: [] });
    assert.equal(records.length, 0);
  });
});

describe('lockout runner post-hook — POST /api/agent/packages/report with ad_lockout_list', () => {
  test('flattens events[] payload into per-event upsertEvent calls and returns 200', async () => {
    const records = [];
    const db = buildMockDb([
      TOKEN_BUNDLE_SCRIPT,
      // packageScripts.get fetches by name; return a synthetic script row so
      // the runner proceeds past the "package not installed" branch.
      { match: /FROM\s+package_scripts/i, rows: [adLockoutListScriptRow()] },
      { match: UPSERT_LOCKOUT_REGEX, rows: [] }
    ]).withRecording(records);

    const events = [
      { eventRecordId: 'evt-1', dcName: 'DC-A', targetUserName: 'alice', occurredAt: '2026-09-25T11:00:00.000Z' },
      { eventRecordId: 'evt-2', dcName: 'DC-A', targetUserName: 'bob',   occurredAt: '2026-09-25T11:01:00.000Z' }
    ];

    const r = await supertest(buildApp(db))
      .post('/api/agent/packages/report')
      .set(authHeader())
      .send({
        runs: [{
          packageName: 'ad_lockout_list',
          exitCode: 0,
          startedAt: new Date(Date.now() - 30000).toISOString(),
          finishedAt: new Date().toISOString(),
          metrics: { events, event_count: 2, error_code: 0 }
        }]
      });

    assert.equal(r.status, 200);
    assert.equal(r.body.processed, 1);
    // No errors reported — both events upserted cleanly.
    assert.equal(r.body.errors.length, 0);
    // Find the upsertEvent calls in the recording. There will be other SQL
    // (package_runs INSERT, metricstore INSERT) — filter by regex.
    const upserts = records.filter(r => UPSERT_LOCKOUT_REGEX.test(r.sql));
    assert.equal(upserts.length, 2);
    // First upsert binds evt-1; second binds evt-2.
    assert.equal(upserts[0].params[4], 'evt-1');
    assert.equal(upserts[1].params[4], 'evt-2');
    // Both upserts record agentId from X-Agent-Id header.
    assert.equal(upserts[0].params[2], AGENT_ID);
    assert.equal(upserts[1].params[2], AGENT_ID);
  });

  test('events[] empty array is a no-op (no upsertEvent issued)', async () => {
    const records = [];
    const db = buildMockDb([
      TOKEN_BUNDLE_SCRIPT,
      { match: /FROM\s+package_scripts/i, rows: [adLockoutListScriptRow()] }
    ]).withRecording(records);

    const r = await supertest(buildApp(db))
      .post('/api/agent/packages/report')
      .set(authHeader())
      .send({
        runs: [{
          packageName: 'ad_lockout_list',
          exitCode: 0,
          startedAt: new Date(Date.now() - 30000).toISOString(),
          finishedAt: new Date().toISOString(),
          metrics: { events: [], event_count: 0, error_code: 0 }
        }]
      });

    assert.equal(r.status, 200);
    assert.equal(r.body.processed, 1);
    // No upsertEvent calls — empty events array.
    const upserts = records.filter(rec => UPSERT_LOCKOUT_REGEX.test(rec.sql));
    assert.equal(upserts.length, 0);
  });

  test('other v2 packages (e.g. ad_lockout_summary) do NOT trigger the ETL post-hook', async () => {
    const records = [];
    const db = buildMockDb([
      TOKEN_BUNDLE_SCRIPT,
      { match: /FROM\s+package_scripts/i, rows: [{
        name: 'ad_lockout_summary',
        version: '1.0.0',
        script_content: 'Write-Output "ok"',
        script_sha256: 'a'.repeat(64),
        manifest_json: JSON.stringify({
          name: 'ad_lockout_summary',
          version: '1.0.0',
          type: 'gauge',
          agent: { minVersion: '1.0.0', script: 'collect.ps1', intervalSec: 900, timeoutMs: 60000 },
          database: { metricTable: 'metrics', metricSchema: {} },
          metrics: [{ key: 'locked_count', label: 'Locked', unit: 'count', thresholds: {} }]
        }),
        source: 'builtin-seed',
        created_at: new Date(),
        updated_at: new Date()
      }] }
    ]).withRecording(records);

    // Send a summary run with metrics that contain an `events` field — the
    // post-hook is gated on packageName === 'ad_lockout_list', so this
    // should NOT trigger upsertEvent.
    const r = await supertest(buildApp(db))
      .post('/api/agent/packages/report')
      .set(authHeader())
      .send({
        runs: [{
          packageName: 'ad_lockout_summary',
          exitCode: 0,
          startedAt: new Date(Date.now() - 30000).toISOString(),
          finishedAt: new Date().toISOString(),
          metrics: {
            locked_count: 5,
            events: [{ eventRecordId: 'should-not-fire', dcName: 'DC-Z' }]
          }
        }]
      });

    assert.equal(r.status, 200);
    const upserts = records.filter(rec => UPSERT_LOCKOUT_REGEX.test(rec.sql));
    assert.equal(upserts.length, 0);
  });
});