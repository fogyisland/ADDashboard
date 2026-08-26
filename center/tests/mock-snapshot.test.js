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
  buildSnapshot,
  dcSummaryRowOf
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
  // + round-13: PartnerPortStatus
  // + round-18: LockedCount stays in the SQL schema but the PS1 entry
  //   stops setting it (it's sourced from ad_lockout_summary now).
  const ts = '2026-08-27T12:00:00.000Z';
  const entry = buildSummaryEntry('MOCK-DC1', ts, 'MOCK-NC');
  const expectedKeys = [
    'SourceDc', 'DestDc', 'SourceSite', 'DestSite',
    'NamingContext', 'LastSuccessTime', 'LastAttemptTime',
    'StatusCode', 'ErrorMessage',
    'UsersCount', 'GroupsCount', 'GposCount',
    'LockedCount', 'PartnerPortStatus'
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
  // PartnerPortStatus is null on the summary row (it's a per-partner field).
  assert.equal(entry.PartnerPortStatus, null);
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

test('buildLinkEntries: partnerPortStatus passes through from link descriptor', () => {
  const portJson = JSON.stringify({ port_135: { reachable: true } });
  const entries = buildLinkEntries('MOCK-DC1', '2026-08-27T12:00:00.000Z', [
    { destDc: 'MOCK-DC2', statusCode: 0, partnerPortStatus: portJson }
  ]);
  assert.equal(entries[0].PartnerPortStatus, portJson);
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