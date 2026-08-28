// mock-snapshot.test.js — round-24 lock-down of the shared snapshot helper.
//
// These tests pin the PascalCase shape that collect-replication.ps1 emits
// (so any future drift is caught here) and verify the deterministic
// per-DC counter generation. The integration path (postSnapshot → real
// reporter → real centre) is exercised by the live mock-*.mjs scripts;
// this file only proves the helper itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDcCounters,
  buildSummaryEntry,
  buildLinkEntries,
  buildReplicationHistoryEntries,
  buildSnapshot,
  dcSummaryRowOf,
  buildMockHeartbeatPorts,
  MOCK_PORT_LATENCY_MS,
  fetchConfiguredPorts
} from '../mock-snapshot.mjs';

// ----- buildDcCounters -----

test('buildDcCounters: same agentId yields identical numbers across calls', () => {
  const a = buildDcCounters('MOCK-NC1');
  const b = buildDcCounters('MOCK-NC1');
  assert.equal(a.usersCount, b.usersCount);
  assert.equal(a.groupsCount, b.groupsCount);
  assert.equal(a.gposCount, b.gposCount);
});

test('buildDcCounters: different agentIds yield different numbers', () => {
  const a = buildDcCounters('MOCK-NC1');
  const b = buildDcCounters('MOCK-NC2');
  // At least one of the three counters must differ; they live in independent
  // 32-bit hash slots so collision across all three is vanishingly small.
  assert.notDeepEqual(a, b);
});

test('buildDcCounters: counters stay within the documented realistic range', () => {
  // Round-24 spec:
  //   usersCount: 500..5000
  //   groupsCount: 50..600
  //   gposCount: 10..100
  for (const id of ['MOCK-NC1', 'MOCK-HUB1', 'MOCK-FZ2', 'MOCK-XM1']) {
    const c = buildDcCounters(id);
    assert.ok(c.usersCount >= 500 && c.usersCount <= 5000, `usersCount out of range for ${id}: ${c.usersCount}`);
    assert.ok(c.groupsCount >= 50 && c.groupsCount <= 600, `groupsCount out of range for ${id}: ${c.groupsCount}`);
    assert.ok(c.gposCount >= 10 && c.gposCount <= 100, `gposCount out of range for ${id}: ${c.gposCount}`);
  }
});

test('buildDcCounters: rejects missing agentId', () => {
  assert.throws(() => buildDcCounters(''), /agentId/);
  assert.throws(() => buildDcCounters(null), /agentId/);
});

// ----- buildSummaryEntry -----

test('buildSummaryEntry: emits the EXACT PascalCase keys collect-replication.ps1 produces', () => {
  // Any future drift here will be caught. The keys list mirrors PS1:
  //   $summaryEntry = [PSCustomObject]@{ SourceDc, DestDc, SourceSite, DestSite,
  //     NamingContext, LastSuccessTime, LastAttemptTime, StatusCode,
  //     ErrorMessage, UsersCount, GroupsCount, GposCount }
  // + round-18: LockedCount stays in the SQL schema but the PS1 entry
  //   stops setting it (it's sourced from ad_lockout_summary now).
  // - round-45: PartnerPortStatus removed (R35 port monitoring deleted).
  const ts = '2026-08-27T12:00:00.000Z';
  const entry = buildSummaryEntry('MOCK-DC1', ts, 'MOCK-NC');
  const expectedKeys = [
    'SourceDc', 'DestDc', 'SourceSite', 'DestSite',
    'NamingContext', 'LastSuccessTime', 'LastAttemptTime',
    'StatusCode', 'ErrorMessage',
    'UsersCount', 'GroupsCount', 'GposCount',
    'LockedCount'
  ];
  for (const k of expectedKeys) {
    assert.ok(Object.prototype.hasOwnProperty.call(entry, k), `missing key: ${k}`);
  }
  // NamingContext must be '__dc_summary__' — that's the SQL filter key.
  assert.equal(entry.NamingContext, '__dc_summary__');
  // SourceDc / DestDc both equal the agentId (self-loop), matching PS1.
  assert.equal(entry.SourceDc, 'MOCK-DC1');
  assert.equal(entry.DestDc, 'MOCK-DC1');
  // SourceSite is forwarded; DestSite is null on the summary row.
  assert.equal(entry.SourceSite, 'MOCK-NC');
  assert.equal(entry.DestSite, null);
  // StatusCode=0 + ErrorMessage=null on a healthy snapshot.
  assert.equal(entry.StatusCode, 0);
  assert.equal(entry.ErrorMessage, null);
  // LockedCount is null (round-18).
  assert.equal(entry.LockedCount, null);
});

test('buildSummaryEntry: counter values match buildDcCounters for the same agentId', () => {
  const ts = '2026-08-27T12:00:00.000Z';
  const entry = buildSummaryEntry('MOCK-DC1', ts);
  const counters = buildDcCounters('MOCK-DC1');
  assert.equal(entry.UsersCount, counters.usersCount);
  assert.equal(entry.GroupsCount, counters.groupsCount);
  assert.equal(entry.GposCount, counters.gposCount);
});

// ----- buildLinkEntries -----

test('buildLinkEntries: PS1-shape keys are all present', () => {
  const entries = buildLinkEntries('MOCK-DC1', '2026-08-27T12:00:00.000Z', [
    { destDc: 'MOCK-DC2', statusCode: 0 },
    { destDc: 'MOCK-DC3', statusCode: 1, errorMessage: 'boom' }
  ]);
  assert.equal(entries.length, 2);
  // Healthy link has LastSuccessTime set; failing link has it null.
  assert.equal(entries[0].LastSuccessTime, '2026-08-27T12:00:00.000Z');
  assert.equal(entries[0].StatusCode, 0);
  assert.equal(entries[0].ErrorMessage, null);
  assert.equal(entries[1].LastSuccessTime, null);
  assert.equal(entries[1].StatusCode, 1);
  assert.equal(entries[1].ErrorMessage, 'boom');
  // Per-link entries never carry counters (only the summary does).
  for (const e of entries) {
    assert.equal(e.UsersCount, null);
    assert.equal(e.GroupsCount, null);
    assert.equal(e.GposCount, null);
    assert.equal(e.LockedCount, null);
  }
});

// ----- buildSnapshot -----

test('buildSnapshot: appends __dc_summary__ entry after the per-link entries', () => {
  const ts = '2026-08-27T12:00:00.000Z';
  const snap = buildSnapshot({
    agentId: 'MOCK-DC1',
    collectedAt: ts,
    sourceSite: 'MOCK-NC',
    links: [{ destDc: 'MOCK-DC2', statusCode: 0 }]
  });
  assert.equal(snap.AgentId, 'MOCK-DC1');
  assert.equal(snap.CollectedAt, ts);
  assert.equal(snap.Site, 'MOCK-NC');
  // 1 link + 1 summary
  assert.equal(snap.Entries.length, 2);
  assert.equal(snap.Entries[0].NamingContext, 'CN=MOCK-DC1->MOCK-DC2');
  assert.equal(snap.Entries[1].NamingContext, '__dc_summary__');
});

test('buildSnapshot: still includes __dc_summary__ when there are no links', () => {
  // This is the round-24 bug case: a brand-new DC that hasn't yet
  // replicated to anyone still lands a self-row in ad_replication_status
  // so the Server Overview can render its counters immediately.
  const snap = buildSnapshot({ agentId: 'MOCK-NEW', collectedAt: '2026-08-27T12:00:00.000Z' });
  assert.equal(snap.Entries.length, 1);
  assert.equal(snap.Entries[0].NamingContext, '__dc_summary__');
  assert.equal(snap.Entries[0].UsersCount >= 500, true);
});

test('buildSnapshot: rejects missing agentId', () => {
  assert.throws(() => buildSnapshot({ agentId: '', collectedAt: 'x' }), /agentId/);
});

// ----- dcSummaryRowOf -----

test('dcSummaryRowOf: pulls the __dc_summary__ entry out of a snapshot', () => {
  const snap = buildSnapshot({ agentId: 'MOCK-DC1', collectedAt: '2026-08-27T12:00:00.000Z' });
  const row = dcSummaryRowOf(snap);
  assert.ok(row);
  assert.equal(row.NamingContext, '__dc_summary__');
});

test('dcSummaryRowOf: returns null when no summary entry is present', () => {
  assert.equal(dcSummaryRowOf(null), null);
  assert.equal(dcSummaryRowOf({ Entries: [] }), null);
});

// ----- partnerPortNamingContext -----
//
// 2026-08-28 round-45: partnerPortNamingContext + buildPartnerPortEntries +
// buildSnapshot-with-partner-port tests DELETED. The R35 port monitoring
// surface is removed end-to-end — no `__partner_ports__:%` rows are emitted
// by mock or real agent, no `partnerPortStatus` JSON shape, no per-port
// portOverrides parameter. The matrix view's failure signal now travels
// through the replication link's statusCode + errorMessage directly.

// ----- buildSnapshot (round-45 — partnerPortEntries removed) -----

// 2026-08-28 round-45: buildSnapshot's partner-port interleaving/defaults/
// matrix-lookup tests are DELETED. partnerPortEntries is gone; the helper
// emits links + history + summary only.

// ----- buildReplicationHistoryEntries (round-42 复制日志监控) -----

test('buildReplicationHistoryEntries: emits attemptsPerPair * peers entries, no summary', () => {
  // 3 attempts × 2 peers = 6 entries. None of them is __dc_summary__.
  // Every entry carries SourceDc/DestDc/DestSite=null/SourceSite/etc.
  const ts = '2026-08-27T12:00:00.000Z';
  const entries = buildReplicationHistoryEntries({
    agentId: 'MOCK-DC1',
    collectedAt: ts,
    peers: ['MOCK-DC2', 'MOCK-DC3'],
    sourceSite: 'MOCK-NC',
    attemptsPerPair: 3
  });
  assert.equal(entries.length, 6);
  for (const e of entries) {
    assert.ok(e.NamingContext.startsWith('__history__:'),
      `expected synthetic history NC, got ${e.NamingContext}`);
    assert.equal(e.SourceDc, 'MOCK-DC1');
    assert.equal(e.SourceSite, 'MOCK-NC');
    // PS1 history rows never carry counters or port probes — they're
    // summary/link-only. Centre's historyParams only reads the 11
    // INSERT-shape fields; the rest stay null on the row.
    assert.equal(e.UsersCount, null);
    assert.equal(e.GroupsCount, null);
    assert.equal(e.GposCount, null);
    assert.equal(e.LockedCount, null);
  }
});

test('buildReplicationHistoryEntries: each peer gets the configured number of attempts', () => {
  const ts = '2026-08-27T12:00:00.000Z';
  const entries = buildReplicationHistoryEntries({
    agentId: 'MOCK-DC1',
    collectedAt: ts,
    peers: ['MOCK-DC2'],
    attemptsPerPair: 5
  });
  assert.equal(entries.length, 5);
});

test('buildReplicationHistoryEntries: attempts are back-dated 5 min apart', () => {
  // Most recent attempt (idx 0) lands at `ts`; older attempts go back
  // 5, 10, 15 minutes. This is what the dashboard's 时间 column reads.
  const ts = '2026-08-27T12:00:00.000Z';
  const entries = buildReplicationHistoryEntries({
    agentId: 'MOCK-DC1',
    collectedAt: ts,
    peers: ['MOCK-DC2'],
    attemptsPerPair: 3
  });
  const times = entries.map(e => Date.parse(e.LastAttemptTime));
  // Sort descending so idx 0 is at the front (chronological newest-first).
  times.sort((a, b) => b - a);
  assert.equal(times[0], Date.parse(ts));
  assert.equal(times[1], Date.parse(ts) - 5 * 60_000);
  assert.equal(times[2], Date.parse(ts) - 10 * 60_000);
});

test('buildReplicationHistoryEntries: success attempts carry duration + objects; failures carry error', () => {
  // The hash distribution gives ~50% success / ~50% failure. We don't
  // pin the exact count (deterministic-but-variable) — instead we walk
  // every entry and assert the field invariants hold for whichever
  // status it has.
  const ts = '2026-08-27T12:00:00.000Z';
  const entries = buildReplicationHistoryEntries({
    agentId: 'MOCK-DC1',
    collectedAt: ts,
    peers: ['MOCK-DC2', 'MOCK-DC3', 'MOCK-DC4'],
    attemptsPerPair: 4
  });
  let successCount = 0, failCount = 0;
  for (const e of entries) {
    if (e.StatusCode === 0) {
      successCount++;
      assert.ok(e.AttemptDurationMs >= 50 && e.AttemptDurationMs <= 300,
        `success attempt duration out of range: ${e.AttemptDurationMs}`);
      assert.ok(e.ObjectsTransferred >= 10 && e.ObjectsTransferred <= 5000,
        `success attempt objects out of range: ${e.ObjectsTransferred}`);
      assert.equal(e.ErrorMessage, null);
      assert.equal(e.LastSuccessTime, e.LastAttemptTime);
    } else {
      failCount++;
      assert.equal(e.AttemptDurationMs, null);
      assert.equal(e.ObjectsTransferred, null);
      assert.ok(typeof e.ErrorMessage === 'string' && e.ErrorMessage.length > 0,
        `failure attempt missing error message: ${JSON.stringify(e)}`);
      assert.equal(e.LastSuccessTime, null);
    }
  }
  // 4 attempts × 3 peers = 12 entries. With 50/50 split we expect
  // both populations to be present (SHA-256 distribution isn't degenerate
  // over a 12-entry window — verified empirically across rounds).
  assert.ok(successCount > 0, 'expected at least one success attempt');
  assert.ok(failCount > 0, 'expected at least one failure attempt');
  assert.equal(successCount + failCount, 12);
});

test('buildReplicationHistoryEntries: historyEnabled=false returns []', () => {
  // Round-42 spec: when the centre's system_config.history_enabled flag
  // is false, the mock helper returns no rows (matches real-agent
  // BuildReplicationHistoryRows being skipped). Centre's
  // insertHistoryEntries is also a no-op in this case — both ends
  // guard the path.
  const ts = '2026-08-27T12:00:00.000Z';
  const entries = buildReplicationHistoryEntries({
    agentId: 'MOCK-DC1',
    collectedAt: ts,
    peers: ['MOCK-DC2'],
    historyEnabled: false
  });
  assert.deepEqual(entries, []);
});

test('buildReplicationHistoryEntries: empty peers → empty result', () => {
  // A heartbeat report with zero links (e.g. a brand-new DC that
  // hasn't replicated to anyone yet) must not produce phantom
  // history rows. The route's historyByPair wouldn't find any links
  // to attach them to anyway.
  const ts = '2026-08-27T12:00:00.000Z';
  const entries = buildReplicationHistoryEntries({
    agentId: 'MOCK-DC1',
    collectedAt: ts,
    peers: []
  });
  assert.deepEqual(entries, []);
});

test('buildReplicationHistoryEntries: deterministic per (agent, peer, NC, attemptIdx)', () => {
  // The mock daemon calls this on every replication tick. If outcomes
  // drift between calls, the dashboard's attempt table flickers and
  // operators can't correlate "I saw this failure 3 minutes ago" with
  // a stable identity. Pin determinism here.
  const ts = '2026-08-27T12:00:00.000Z';
  const first  = buildReplicationHistoryEntries({
    agentId: 'MOCK-DC1', collectedAt: ts, peers: ['MOCK-DC2'], attemptsPerPair: 4
  });
  const second = buildReplicationHistoryEntries({
    agentId: 'MOCK-DC1', collectedAt: ts, peers: ['MOCK-DC2'], attemptsPerPair: 4
  });
  assert.equal(first.length, second.length);
  for (let i = 0; i < first.length; i++) {
    assert.equal(first[i].StatusCode, second[i].StatusCode);
    assert.equal(first[i].AttemptDurationMs, second[i].AttemptDurationMs);
    assert.equal(first[i].ObjectsTransferred, second[i].ObjectsTransferred);
    assert.equal(first[i].ErrorMessage, second[i].ErrorMessage);
    assert.equal(first[i].NamingContext, second[i].NamingContext);
    assert.equal(first[i].LastAttemptTime, second[i].LastAttemptTime);
  }
});

test('buildReplicationHistoryEntries: synthetic NC encodes 8-hex hash, real NC alongside', () => {
  // Naming context shape: `__history__:<8hex>` so the route's
  // data[] fork can recognise it (startsWith('__history__:')). The
  // mock also forwards the link's real NC via _realNamingContext so
  // the centre's historyParams can strip the prefix and bind the real
  // NC into ad_replication_history — that's what the dashboard's
  // historyByPair joins on.
  const ts = '2026-08-27T12:00:00.000Z';
  const [entry] = buildReplicationHistoryEntries({
    agentId: 'MOCK-DC1',
    collectedAt: ts,
    peers: ['MOCK-DC2']
  });
  assert.match(entry.NamingContext, /^__history__:[0-9a-f]{8}$/);
  // _realNamingContext is the link's real NC (CN=<agent>-><peer>).
  assert.equal(entry._RealNamingContext, 'CN=MOCK-DC1->MOCK-DC2');
});

test('buildReplicationHistoryEntries: accepts a Date object and normalizes to ISO', () => {
  // The mock daemon passes new Date() — the helper must coerce it to
  // ISO the same way buildSummaryEntry / buildLinkEntries do. Otherwise
  // the SQL driver binds a Date object, which MSSQL's tedious rejects.
  const d = new Date('2026-08-27T12:00:00.000Z');
  const entries = buildReplicationHistoryEntries({
    agentId: 'MOCK-DC1',
    collectedAt: d,
    peers: ['MOCK-DC2']
  });
  assert.equal(entries[0].LastAttemptTime, d.toISOString());
});

test('buildReplicationHistoryEntries: rejects missing agentId', () => {
  const ts = '2026-08-27T12:00:00.000Z';
  assert.throws(
    () => buildReplicationHistoryEntries({ agentId: '', collectedAt: ts, peers: ['x'] }),
    /agentId/
  );
  assert.throws(
    () => buildReplicationHistoryEntries({ collectedAt: ts, peers: ['x'] }),
    /agentId/
  );
});

// ----- buildSnapshot with historyEntries -----

test('buildSnapshot: historyEntries are interleaved between links and summary', () => {
  // 2026-08-28 round-45: partnerPortEntries is gone (R35 port monitoring
  // surface removed). Canonical ordering is now links → history entries
  // → summary. The route forks on NamingContext prefix (links go to
  // ad_replication_status, __history__:% to ad_replication_history,
  // __dc_summary__ to ad_dc_summary), so position only matters for
  // human-readable debug output.
  const ts = '2026-08-27T12:00:00.000Z';
  const historyEntries = buildReplicationHistoryEntries({
    agentId: 'MOCK-DC1', collectedAt: ts, peers: ['MOCK-DC2']
  });
  const snap = buildSnapshot({
    agentId: 'MOCK-DC1',
    collectedAt: ts,
    sourceSite: 'MOCK-NC',
    links: [{ destDc: 'MOCK-DC2', statusCode: 0 }],
    historyEntries
  });
  // 1 link + N history + 1 summary
  assert.equal(snap.Entries[0].NamingContext, 'CN=MOCK-DC1->MOCK-DC2');
  // Last entry is always __dc_summary__ — invariant for the matrix view's
  // server-overview counters.
  assert.equal(snap.Entries[snap.Entries.length - 1].NamingContext, '__dc_summary__');
  // History entries sit in the middle, prefixed with __history__:
  const historyIdx = snap.Entries.findIndex(e => e.NamingContext.startsWith('__history__:'));
  assert.ok(historyIdx >= 1, `expected history entries starting at idx 1, got idx ${historyIdx}`);
});

test('buildSnapshot: defaults historyEntries to empty when omitted', () => {
  // Backward compat: callers that don't pass historyEntries still work.
  // The mock daemon is the only caller right now; future real-agent
  // wiring (round-42 T10) will pass them too.
  const ts = '2026-08-27T12:00:00.000Z';
  const snap = buildSnapshot({
    agentId: 'MOCK-DC1',
    collectedAt: ts,
    links: [{ destDc: 'MOCK-DC2', statusCode: 0 }]
  });
  // 1 link + 1 summary = 2 entries; no history, no partner-port.
  assert.equal(snap.Entries.length, 2);
});

// ----- R58.2: buildMockHeartbeatPorts -----
//
// Operator directive: "Mock 也补发 — 填充固定 latency". The helper stamps
// fixed per-port latency from a static map; tests pin the contract so a
// future refactor (e.g. switching to jitter) is caught here before the
// dashboard renders nonsense latencies.

test('buildMockHeartbeatPorts: emits one row per valid port with fixed latency', () => {
  const ports = [
    { port: 135,  label: 'RPC' },
    { port: 445,  label: 'SMB' },
    { port: 50001, label: 'NTDS Replication' },
    { port: 389,  label: 'LDAP' }
  ];
  const out = buildMockHeartbeatPorts('MOCK-NC1', ports);
  assert.equal(out.length, 4);
  for (const row of out) {
    assert.equal(row.ok, true, `port ${row.port} should be reachable`);
    assert.ok(Number.isInteger(row.latencyMs), `latencyMs must be integer, got ${row.latencyMs}`);
    assert.ok(row.latencyMs >= 1 && row.latencyMs <= 100, `latencyMs out of plausible range: ${row.latencyMs}`);
  }
  // Spot-check fixed latencies from MOCK_PORT_LATENCY_MS.
  const byPort = Object.fromEntries(out.map((r) => [r.port, r.latencyMs]));
  assert.equal(byPort[135], 3);
  assert.equal(byPort[445], 5);
  assert.equal(byPort[50001], 8);
});

test('buildMockHeartbeatPorts: deterministic across calls (same agentId, same input)', () => {
  // The fixed-latency map is static so two calls with the same input
  // must produce identical output. This pins determinism so future
  // changes (jitter, randomization) trip a test failure here.
  const ports = [{ port: 445 }, { port: 389 }];
  const a = buildMockHeartbeatPorts('MOCK-NC1', ports);
  const b = buildMockHeartbeatPorts('MOCK-NC1', ports);
  assert.deepEqual(a, b);
});

test('buildMockHeartbeatPorts: default latency (5ms) for ports outside the map', () => {
  // 9999 isn't in MOCK_PORT_LATENCY_MS — helper falls back to 5ms default.
  const out = buildMockHeartbeatPorts('MOCK-NC1', [{ port: 9999 }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].port, 9999);
  assert.equal(out[0].latencyMs, 5);
  assert.equal(out[0].ok, true);
});

test('buildMockHeartbeatPorts: filters out entries without integer port', () => {
  // Defends against an upstream caller (services/ports.js) that might
  // ever return rows with a malformed port column — the centre's
  // upsertPortStatuses would reject them anyway, but failing here keeps
  // the mock heartbeat body clean.
  const ports = [
    { port: 135 },            // ok
    { port: 'not-a-number' }, // filtered
    { port: null },           // filtered
    {},                       // filtered (no port)
    { port: 445 }             // ok
  ];
  const out = buildMockHeartbeatPorts('MOCK-NC1', ports);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((r) => r.port).sort(), [135, 445]);
});

test('buildMockHeartbeatPorts: empty ports array → empty ports[]', () => {
  // Defends against pre-R58.2 caller code paths that may still pass [].
  assert.deepEqual(buildMockHeartbeatPorts('MOCK-NC1', []), []);
  assert.deepEqual(buildMockHeartbeatPorts('MOCK-NC1', undefined), []);
});

test('buildMockHeartbeatPorts: rejects non-array ports argument', () => {
  // TypeError is the only documented signal — caller should NOT swallow it.
  assert.throws(() => buildMockHeartbeatPorts('MOCK-NC1', 'not-an-array'), TypeError);
  assert.throws(() => buildMockHeartbeatPorts('MOCK-NC1', null), TypeError);
});

test('MOCK_PORT_LATENCY_MS: every port maps to a positive integer ≤ 100ms', () => {
  // Sanity bound on the static map — if someone adds an unrealistic entry
  // (e.g. latencyMs: 99999), this test catches it before it pollutes the
  // dashboard's per-port latency column.
  for (const [port, ms] of Object.entries(MOCK_PORT_LATENCY_MS)) {
    assert.ok(Number.isInteger(Number(port)), `${port} must be integer port number`);
    assert.ok(Number.isInteger(ms) && ms > 0 && ms <= 100, `port ${port} latencyMs out of range: ${ms}`);
  }
});

// ----- R58.2: fetchConfiguredPorts -----

test('fetchConfiguredPorts: returns parsed array on 200 JSON', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ([{ port: 135, label: 'RPC' }, { port: 445, label: 'SMB' }])
  });
  const out = await fetchConfiguredPorts({
    centerUrl: 'http://center.local:8081',
    agentToken: 'tok',
    fetchImpl: fakeFetch,
    timeoutMs: 1000
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].port, 135);
});

test('fetchConfiguredPorts: returns [] on non-2xx response', async () => {
  const fakeFetch = async () => ({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) });
  const out = await fetchConfiguredPorts({ centerUrl: 'http://center.local:8081', agentToken: 'bad', fetchImpl: fakeFetch });
  assert.deepEqual(out, []);
});

test('fetchConfiguredPorts: returns [] on network error (no throw)', async () => {
  const fakeFetch = async () => { throw new Error('ECONNREFUSED'); };
  const out = await fetchConfiguredPorts({ centerUrl: 'http://center.local:8081', agentToken: 'tok', fetchImpl: fakeFetch });
  assert.deepEqual(out, []);
});

test('fetchConfiguredPorts: returns [] when response body is not an array', async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ ports: [] }) });
  const out = await fetchConfiguredPorts({ centerUrl: 'http://center.local:8081', agentToken: 'tok', fetchImpl: fakeFetch });
  assert.deepEqual(out, []);
});

test('fetchConfiguredPorts: returns [] when centerUrl or agentToken missing', async () => {
  // Guard against callers that pass undefined — helper short-circuits
  // instead of hitting the network with no token (would 401 every call).
  assert.deepEqual(await fetchConfiguredPorts({ centerUrl: null, agentToken: 'tok' }), []);
  assert.deepEqual(await fetchConfiguredPorts({ centerUrl: 'http://x', agentToken: null }), []);
});