// metricstore-lockout-list.test.js — unit tests for the ad_lockout_list v2
// package's metric shape, exercising metricstore.ingestRunV2 with a mocked
// db.execute. The package's collect.ps1 emits an `events` JSON column
// (array of {EventRecordId, OccurredAt, TargetUserName, ...}), an
// event_count INT, and an error_code bit accumulator. These tests verify:
//   1. A populated events array round-trips into pkg_ad_lockout_list.metrics.
//   2. An empty events array (no lockouts in the last 15 min) still INSERTs
//      a row — the gap chart needs clean "0 events" rows too.
//   3. error_code=1 (RSAT missing / log unreadable) → events=[], INSERTed.
//   4. The events column carries the full event shape the UI expects.
//   5. PKG_METRIC_KEY_UNKNOWN fires on unknown top-level keys.
//
// Mocked db.execute pattern matches tests/packages/metricstore.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metricstore } from '../../src/packages/metricstore.js';

const MANIFEST = {
  name: 'ad-lockout-list',
  version: '1.0.0',
  type: 'gauge',
  description: 'Last 15 minutes of Security event 4740 (user account locked out).',
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
    schemaName: 'pkg_ad_lockout_list',
    migrations: ['migrations/001_initial.sql'],
    metricTable: 'metrics',
    metricSchema: {
      agent_id:    { type: 'varchar(64)', nullable: false },
      ts:          { type: 'datetime',    nullable: false },
      events:      { type: 'json' },
      event_count: { type: 'int' },
      error_code:  { type: 'int' }
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

test('lockout-list: populated events array round-trips into pkg_ad_lockout_list.metrics', async () => {
  const db = makeMockDb();
  const events = [
    {
      EventRecordId: 9001,
      OccurredAt: '2026-08-26T10:00:00.000Z',
      TargetUserName: 'alice',
      SubjectUserName: 'admin01',
      SubjectDomain: 'CORP',
      CallerComputerName: 'WS-DEV-42'
    },
    {
      EventRecordId: 9002,
      OccurredAt: '2026-08-26T10:05:00.000Z',
      TargetUserName: 'bob',
      SubjectUserName: 'admin02',
      SubjectDomain: 'CORP',
      CallerComputerName: 'WS-DEV-43'
    }
  ];
  const metrics = {
    agent_id: 'DC01',
    events,
    event_count: 2,
    error_code: 0
  };

  await metricstore.ingestRun(db, {
    agentId: 'DC01',
    packageName: 'ad-lockout-list',
    manifest: MANIFEST,
    runs: [{ metrics, error: null }]
  });

  const inserts = db._calls.filter(c => /INSERT\s+INTO/i.test(c.sql));
  assert.strictEqual(inserts.length, 1);
  assert.match(inserts[0].sql, /`pkg_ad_lockout_list`\.`metrics`/);
  assert.match(inserts[0].sql, /\(agent_id,\s*ts,\s*events,\s*event_count,\s*error_code\)/);

  const [agentId, ts, eventsParam, eventCount, errorCode] = inserts[0].params;
  assert.strictEqual(agentId, 'DC01');
  assert.ok(ts instanceof Date);
  assert.deepStrictEqual(eventsParam, events, 'events array must round-trip unchanged');
  assert.strictEqual(eventCount, 2);
  assert.strictEqual(errorCode, 0);
});

test('lockout-list: empty events array (no lockouts) still INSERTs (gap chart needs clean rows)', async () => {
  // Important: a DC with NO lockouts in the last 15 min still has to ship
  // a row so the dashboard's "最近 15 分钟锁定事件" panel can render
  // "0 events" instead of "no data". The script always emits
  // events=@() even when the WinEvent query returns nothing.
  const db = makeMockDb();
  const metrics = {
    agent_id: 'DC01',
    events: [],
    event_count: 0,
    error_code: 0
  };

  await metricstore.ingestRun(db, {
    agentId: 'DC01',
    packageName: 'ad-lockout-list',
    manifest: MANIFEST,
    runs: [{ metrics, error: null }]
  });

  const inserts = db._calls.filter(c => /INSERT\s+INTO/i.test(c.sql));
  assert.strictEqual(inserts.length, 1);
  const [, , eventsParam, eventCount] = inserts[0].params;
  assert.deepStrictEqual(eventsParam, [], 'empty events array must round-trip as []');
  assert.strictEqual(eventCount, 0);
});

test('lockout-list: WinEvent query failed → error_code=1, events=[], still INSERTs', async () => {
  // When Get-WinEvent fails (RSAT absent, security log unreadable, etc.),
  // the script must still INSERT a row with the failure bit so the gap
  // chart can render the red dot. We tolerate the failure rather than
  // skipping the row — otherwise the operator gets a green DC during
  // an ActiveDirectory outage, which is the worst-case silent failure.
  const db = makeMockDb();
  const metrics = {
    agent_id: 'MEMBER-01',
    events: [],
    event_count: 0,
    error_code: 1
  };

  await metricstore.ingestRun(db, {
    agentId: 'MEMBER-01',
    packageName: 'ad-lockout-list',
    manifest: MANIFEST,
    runs: [{ metrics, error: null }]
  });

  const inserts = db._calls.filter(c => /INSERT\s+INTO/i.test(c.sql));
  assert.strictEqual(inserts.length, 1, 'failed-WinEvent runs must still INSERT');
  const [, , eventsParam, eventCount, errorCode] = inserts[0].params;
  assert.deepStrictEqual(eventsParam, []);
  assert.strictEqual(eventCount, 0);
  assert.strictEqual(errorCode, 1);
});

test('lockout-list: events array preserves the 6 fields the UI reads', async () => {
  // The UI reads EventRecordId for dedup keying, OccurredAt for the
  // timestamp column, and the 4 user/computer fields for the row text.
  // The metricstore is shape-agnostic inside JSON columns, so this test
  // pins the contract on the script side by asserting what gets bound.
  const db = makeMockDb();
  const events = [
    {
      EventRecordId: 12345678,
      OccurredAt: '2026-08-26T11:00:00.000Z',
      TargetUserName: 'alice',
      SubjectUserName: 'admin01',
      SubjectDomain: 'CORP',
      CallerComputerName: 'WS-DEV-42'
    }
  ];
  await metricstore.ingestRun(db, {
    agentId: 'DC01',
    packageName: 'ad-lockout-list',
    manifest: MANIFEST,
    runs: [{ metrics: { agent_id: 'DC01', events, event_count: 1, error_code: 0 }, error: null }]
  });

  const inserts = db._calls.filter(c => /INSERT\s+INTO/i.test(c.sql));
  const eventsParam = inserts[0].params[2];
  assert.strictEqual(eventsParam.length, 1);
  const ev = eventsParam[0];
  assert.strictEqual(ev.EventRecordId, 12345678);
  assert.strictEqual(ev.OccurredAt, '2026-08-26T11:00:00.000Z');
  assert.strictEqual(ev.TargetUserName, 'alice');
  assert.strictEqual(ev.SubjectUserName, 'admin01');
  assert.strictEqual(ev.SubjectDomain, 'CORP');
  assert.strictEqual(ev.CallerComputerName, 'WS-DEV-42');
});

test('lockout-list: unknown top-level key triggers PKG_METRIC_KEY_UNKNOWN', async () => {
  const db = makeMockDb();
  await assert.rejects(
    () => metricstore.ingestRun(db, {
      agentId: 'DC01',
      packageName: 'ad-lockout-list',
      manifest: MANIFEST,
      runs: [{
        metrics: {
          agent_id: 'DC01',
          events: [],
          event_count: 0,
          error_code: 0,
          debug_payload: 'leaked'
        },
        error: null
      }]
    }),
    (err) => err.code === 'PKG_METRIC_KEY_UNKNOWN' && err.message.includes('debug_payload')
  );
});

test('lockout-list: errored runs are skipped (no INSERT issued)', async () => {
  const db = makeMockDb();
  await metricstore.ingestRun(db, {
    agentId: 'DC01',
    packageName: 'ad-lockout-list',
    manifest: MANIFEST,
    runs: [{
      metrics: { agent_id: 'DC01', events: [], event_count: 0, error_code: 0 },
      error: 'powershell crashed'
    }]
  });

  const inserts = db._calls.filter(c => /INSERT\s+INTO/i.test(c.sql));
  assert.strictEqual(inserts.length, 0, 'errored run must not INSERT');
});
