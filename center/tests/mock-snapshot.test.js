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
  buildPartnerPortEntries,
  buildReplicationHistoryEntries,
  partnerPortNamingContext,
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

// ----- partnerPortNamingContext -----

test('partnerPortNamingContext: emits __partner_ports__:<host>_<8hex> for short hostnames', () => {
  // Shape mirrors collect-replication.ps1::Get-PartnerNamingContext:
  //   <prefix>:<host_truncated_to_64>_<4-byte SHA-256 hex = 8 hex chars>
  const nc = partnerPortNamingContext('MOCK-NCADSRV1');
  assert.match(nc, /^__partner_ports__:MOCK-NCADSRV1_[0-9a-f]{8}$/);
});

test('partnerPortNamingContext: truncates host to 64 chars + keeps 8-hex suffix', () => {
  // 80-char host → first 64 chars + 8 hex.
  const longHost = 'a'.repeat(80);
  const nc = partnerPortNamingContext(longHost);
  assert.match(nc, /^__partner_ports__:a{64}_[0-9a-f]{8}$/);
});

test('partnerPortNamingContext: same host always yields the same suffix (deterministic)', () => {
  // The naming_context must be stable across runs — operators correlate
  // partner-port rows by this string, so hash drift would break that
  // lookup. Hash is over the FULL host (not the truncated form), so a
  // longer host produces the same suffix it always would.
  const a = partnerPortNamingContext('MOCK-DC-EXAMPLE');
  const b = partnerPortNamingContext('MOCK-DC-EXAMPLE');
  assert.equal(a, b);
});

test('partnerPortNamingContext: returns null for empty/falsy host', () => {
  assert.equal(partnerPortNamingContext(null), null);
  assert.equal(partnerPortNamingContext(''), null);
});

// ----- buildPartnerPortEntries -----

test('buildPartnerPortEntries: emits one entry per peer, no summary', () => {
  const ts = '2026-08-27T12:00:00.000Z';
  const entries = buildPartnerPortEntries({
    agentId: 'MOCK-DC1',
    collectedAt: ts,
    peers: ['MOCK-DC2', 'MOCK-DC3'],
    sourceSite: 'MOCK-NC'
  });
  assert.equal(entries.length, 2);
  // No __dc_summary__ here — that row is appended by buildSnapshot only.
  for (const e of entries) {
    assert.ok(e.NamingContext.startsWith('__partner_ports__:'));
  }
  assert.equal(entries[0].DestDc, 'MOCK-DC2');
  assert.equal(entries[1].DestDc, 'MOCK-DC3');
  // SourceDc is the agent doing the probing (NOT the partner).
  for (const e of entries) assert.equal(e.SourceDc, 'MOCK-DC1');
});

test('buildPartnerPortEntries: PS1-shape keys are all present', () => {
  const ts = '2026-08-27T12:00:00.000Z';
  const [entry] = buildPartnerPortEntries({
    agentId: 'MOCK-DC1',
    collectedAt: ts,
    peers: ['MOCK-DC2']
  });
  const expectedKeys = [
    'SourceDc', 'DestDc', 'SourceSite', 'DestSite',
    'NamingContext', 'LastSuccessTime', 'LastAttemptTime',
    'StatusCode', 'ErrorMessage',
    'UsersCount', 'GroupsCount', 'GposCount', 'LockedCount',
    'PartnerPortStatus'
  ];
  for (const k of expectedKeys) {
    assert.ok(Object.prototype.hasOwnProperty.call(entry, k), `missing key: ${k}`);
  }
});

test('buildPartnerPortEntries: accepts a Date object and normalizes to ISO', () => {
  // The mock daemon passes new Date() — the helper must coerce it to ISO
  // the same way buildSummaryEntry / buildLinkEntries do. Otherwise the
  // SQL driver binds a Date object, which MySQL handles fine but MSSQL
  // rejects (tedious expects ISO strings).
  const d = new Date('2026-08-27T12:00:00.000Z');
  const [entry] = buildPartnerPortEntries({
    agentId: 'MOCK-DC1',
    collectedAt: d,
    peers: ['MOCK-DC2']
  });
  assert.equal(entry.LastSuccessTime, d.toISOString());
  assert.equal(entry.LastAttemptTime, d.toISOString());
});

test('buildPartnerPortEntries: statusCode is 0 when every port reachable', () => {
  // portOverrides force ALL ports reachable → StatusCode=0 (matches PS1:
  // 0 when every probe succeeded).
  const ts = '2026-08-27T12:00:00.000Z';
  const [entry] = buildPartnerPortEntries({
    agentId: 'MOCK-DC1',
    collectedAt: ts,
    peers: ['MOCK-DC2'],
    portOverrides: [{
      host: 'MOCK-DC2',
      portResults: [
        { port: 135, reachable: true, latencyMs: 3 },
        { port: 445, reachable: true, latencyMs: 4 },
        { port: 50001, reachable: true, latencyMs: 5 },
        { port: 50002, reachable: true, latencyMs: 6 },
        { port: 50003, reachable: true, latencyMs: 7 }
      ]
    }]
  });
  assert.equal(entry.StatusCode, 0);
});

test('buildPartnerPortEntries: statusCode equals count of unreachable ports', () => {
  // 3 of 5 ports unreachable → StatusCode=3. Mirrors PS1 line 215+
  // status_code = 0 if all reachable else count of unreachable.
  const ts = '2026-08-27T12:00:00.000Z';
  const [entry] = buildPartnerPortEntries({
    agentId: 'MOCK-DC1',
    collectedAt: ts,
    peers: ['MOCK-DC2'],
    portOverrides: [{
      host: 'MOCK-DC2',
      portResults: [
        { port: 135, reachable: true, latencyMs: 3 },
        { port: 445, reachable: false, latencyMs: null, error: 'timeout' },
        { port: 50001, reachable: false, latencyMs: null, error: 'timeout' },
        { port: 50002, reachable: true, latencyMs: 6 },
        { port: 50003, reachable: false, latencyMs: null, error: 'timeout' }
      ]
    }]
  });
  assert.equal(entry.StatusCode, 3);
});

test('buildPartnerPortEntries: PartnerPortStatus JSON shape — checked_at + ports map keyed by port string', () => {
  const ts = '2026-08-27T12:00:00.000Z';
  // Force ALL 5 ports via override so the assertion doesn't depend on
  // the SHA-256 distribution. Override-only outcome: every port reflects
  // exactly what the override specifies.
  const [entry] = buildPartnerPortEntries({
    agentId: 'MOCK-DC1',
    collectedAt: ts,
    peers: ['MOCK-DC2'],
    portOverrides: [{
      host: 'MOCK-DC2',
      portResults: [
        { port: 135,   reachable: true,  latencyMs: 3 },
        { port: 445,   reachable: false, latencyMs: null, error: 'ConnectionRefused (FZ1 operator scenario)' },
        { port: 50001, reachable: true,  latencyMs: 5 },
        { port: 50002, reachable: true,  latencyMs: 6 },
        { port: 50003, reachable: false, latencyMs: null, error: 'timeout' }
      ]
    }]
  });
  // String per spec — the agent's reporter.toCamelEntry passes it through
  // verbatim; the centre's partnerPortStatus parser accepts both string
  // (MSSQL) and object (MySQL) forms.
  assert.equal(typeof entry.PartnerPortStatus, 'string');
  const parsed = JSON.parse(entry.PartnerPortStatus);
  assert.equal(parsed.checked_at, ts);
  assert.deepEqual(Object.keys(parsed.ports).sort(), ['135', '445', '50001', '50002', '50003']);
  assert.equal(parsed.ports['135'].reachable, true);
  assert.equal(parsed.ports['135'].latencyMs, 3);
  assert.equal(parsed.ports['445'].reachable, false);
  assert.equal(parsed.ports['445'].latencyMs, null);
  assert.equal(parsed.ports['445'].error, 'ConnectionRefused (FZ1 operator scenario)');
  assert.equal(parsed.ports['50003'].reachable, false);
  assert.equal(parsed.ports['50003'].error, 'timeout');
});

test('buildPartnerPortEntries: SHA-256-driven outcomes are deterministic per (agent, peer, port)', () => {
  // The mock daemon calls buildPartnerPortEntries on every replication tick.
  // If outcomes drift between calls, the matrix view's per-port badges
  // flicker; pinning determinism here prevents a future refactor from
  // regressing that.
  const ts = '2026-08-27T12:00:00.000Z';
  const first  = buildPartnerPortEntries({ agentId: 'MOCK-DC1', collectedAt: ts, peers: ['MOCK-DC2'] });
  const second = buildPartnerPortEntries({ agentId: 'MOCK-DC1', collectedAt: ts, peers: ['MOCK-DC2'] });
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(first[0].StatusCode, second[0].StatusCode);
  assert.equal(first[0].PartnerPortStatus, second[0].PartnerPortStatus);
});

test('buildPartnerPortEntries: override map does not affect other peers', () => {
  // The override is keyed by hostname — overrides for one peer must NOT
  // bleed into a different peer's entry. The matrix view shows each
  // partner row independently; cross-contamination would hide real
  // failures.
  const ts = '2026-08-27T12:00:00.000Z';
  const entries = buildPartnerPortEntries({
    agentId: 'MOCK-DC1',
    collectedAt: ts,
    peers: ['MOCK-DC2', 'MOCK-DC3'],
    portOverrides: [{
      host: 'MOCK-DC2',
      portResults: [
        { port: 50001, reachable: false, latencyMs: null, error: 'timeout' }
      ]
    }]
  });
  // MOCK-DC2 → StatusCode reflects the forced failure (port 50001).
  // Default port list has 5 ports; 1 override matches, the other 4 fall
  // through to the SHA-256 helper. Total unreachable could be 1+0..4.
  assert.ok(entries[0].StatusCode >= 1, `MOCK-DC2 should have at least 1 unreachable, got ${entries[0].StatusCode}`);
  // MOCK-DC3 → purely SHA-256 derived.
  const e3 = JSON.parse(entries[1].PartnerPortStatus);
  assert.equal(Object.keys(e3.ports).length, 5);
});

test('buildPartnerPortEntries: empty peers → empty result', () => {
  const ts = '2026-08-27T12:00:00.000Z';
  const entries = buildPartnerPortEntries({
    agentId: 'MOCK-DC1',
    collectedAt: ts,
    peers: []
  });
  assert.deepEqual(entries, []);
});

test('buildPartnerPortEntries: peer entries with {host: ...} objects work (mock-multi-agent shape)', () => {
  // mock-multi-agent.mjs uses {host} objects; the daemon uses raw strings.
  // Both shapes must be accepted so neither caller has to reshape data.
  const ts = '2026-08-27T12:00:00.000Z';
  const entries = buildPartnerPortEntries({
    agentId: 'MOCK-DC1',
    collectedAt: ts,
    peers: [{ host: 'MOCK-DC2' }, { host: 'MOCK-DC3' }]
  });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].DestDc, 'MOCK-DC2');
  assert.equal(entries[1].DestDc, 'MOCK-DC3');
});

test('buildPartnerPortEntries: peer entries skip entries without a usable host', () => {
  // Defensive: malformed peers (null/undefined host) are dropped, not
  // thrown. The daemon constructs the peers list from a known-good
  // scenario so this never happens in practice, but a future caller might
  // pass sloppy data.
  const ts = '2026-08-27T12:00:00.000Z';
  const entries = buildPartnerPortEntries({
    agentId: 'MOCK-DC1',
    collectedAt: ts,
    peers: ['MOCK-DC2', null, '', undefined, { host: 'MOCK-DC3' }, {}]
  });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].DestDc, 'MOCK-DC2');
  assert.equal(entries[1].DestDc, 'MOCK-DC3');
});

test('buildPartnerPortEntries: rejects missing agentId', () => {
  assert.throws(
    () => buildPartnerPortEntries({ agentId: '', collectedAt: '2026-08-27T12:00:00.000Z', peers: ['x'] }),
    /agentId/
  );
  assert.throws(
    () => buildPartnerPortEntries({ collectedAt: '2026-08-27T12:00:00.000Z', peers: ['x'] }),
    /agentId/
  );
});

// ----- buildSnapshot with partnerPortEntries -----

test('buildSnapshot: partnerPortEntries are interleaved between links and summary', () => {
  // Order: links → partner-port entries → summary. The route doesn't
  // care about ordering, but the operator reading the raw snapshot in
  // debug output expects this canonical shape.
  const ts = '2026-08-27T12:00:00.000Z';
  const partnerPortEntries = buildPartnerPortEntries({
    agentId: 'MOCK-DC1',
    collectedAt: ts,
    peers: ['MOCK-DC2']
  });
  const snap = buildSnapshot({
    agentId: 'MOCK-DC1',
    collectedAt: ts,
    sourceSite: 'MOCK-NC',
    links: [{ destDc: 'MOCK-DC2', statusCode: 0 }],
    partnerPortEntries
  });
  assert.equal(snap.Entries.length, 3);
  assert.equal(snap.Entries[0].NamingContext, 'CN=MOCK-DC1->MOCK-DC2');
  assert.ok(snap.Entries[1].NamingContext.startsWith('__partner_ports__:'));
  assert.equal(snap.Entries[2].NamingContext, '__dc_summary__');
});

test('buildSnapshot: defaults partnerPortEntries to empty when omitted', () => {
  // Backward compat: pre-round-35 callers buildSnapshot({ links: ... })
  // without partnerPortEntries. Should still work, summary still appended.
  const ts = '2026-08-27T12:00:00.000Z';
  const snap = buildSnapshot({
    agentId: 'MOCK-DC1',
    collectedAt: ts,
    links: [{ destDc: 'MOCK-DC2', statusCode: 0 }]
  });
  assert.equal(snap.Entries.length, 2);
  assert.equal(snap.Entries[0].NamingContext, 'CN=MOCK-DC1->MOCK-DC2');
  assert.equal(snap.Entries[1].NamingContext, '__dc_summary__');
});

test('buildSnapshot: matrix route lookup key — link.destDc === partner-port.DestDc', async () => {
  // 2026-08-27 round-35: this is the integration invariant. The route
  // builds perPortByPair keyed by `${source_dc}${sep}${dest_dc}` against
  // latestPartnerPortPerPair rows. If a link entry has destDc='X' but
  // the matching partner-port row has DestDc='X.mock.local', the lookup
  // misses and the matrix view's perPort column is null.
  //
  // Mock-helper invariant: passing the same peers[] string to
  // buildLinkEntries (via links[]) and buildPartnerPortEntries produces
  // entries with identical DestDc values.
  const ts = '2026-08-27T12:00:00.000Z';
  const peerIds = ['MOCK-DC2', 'MOCK-DC3'];
  const links = peerIds.map((d) => ({ destDc: d, statusCode: 0 }));
  const portEntries = buildPartnerPortEntries({
    agentId: 'MOCK-DC1',
    collectedAt: ts,
    peers: peerIds
  });
  const linkEntries = buildLinkEntries('MOCK-DC1', ts, links);
  assert.equal(linkEntries.length, portEntries.length);
  for (let i = 0; i < linkEntries.length; i++) {
    assert.equal(linkEntries[i].DestDc, portEntries[i].DestDc);
    assert.equal(linkEntries[i].SourceDc, portEntries[i].SourceDc);
  }
});

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
    assert.equal(e.DestSite, null);
    // PS1 history rows never carry counters or port probes — they're
    // summary/link-only. Centre's historyParams only reads the 11
    // INSERT-shape fields; the rest stay null on the row.
    assert.equal(e.UsersCount, null);
    assert.equal(e.GroupsCount, null);
    assert.equal(e.GposCount, null);
    assert.equal(e.LockedCount, null);
    assert.equal(e.PartnerPortStatus, null);
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
  // ISO the same way buildPartnerPortEntries does. Otherwise the
  // SQL driver binds a Date object, which MSSQL's tedious rejects.
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

test('buildSnapshot: historyEntries are interleaved between partner-port and summary', () => {
  // Canonical ordering: links → partner-port entries → history entries
  // → summary. The route forks on NamingContext prefix, not position;
  // ordering matters only for human-readable debug output.
  const ts = '2026-08-27T12:00:00.000Z';
  const partnerPortEntries = buildPartnerPortEntries({
    agentId: 'MOCK-DC1', collectedAt: ts, peers: ['MOCK-DC2']
  });
  const historyEntries = buildReplicationHistoryEntries({
    agentId: 'MOCK-DC1', collectedAt: ts, peers: ['MOCK-DC2']
  });
  const snap = buildSnapshot({
    agentId: 'MOCK-DC1',
    collectedAt: ts,
    sourceSite: 'MOCK-NC',
    links: [{ destDc: 'MOCK-DC2', statusCode: 0 }],
    partnerPortEntries,
    historyEntries
  });
  // 1 link + 1 partner-port + N history + 1 summary
  assert.equal(snap.Entries[0].NamingContext, 'CN=MOCK-DC1->MOCK-DC2');
  assert.ok(snap.Entries[1].NamingContext.startsWith('__partner_ports__:'));
  // Last entry is always __dc_summary__ — invariant for the matrix view's
  // server-overview counters.
  assert.equal(snap.Entries[snap.Entries.length - 1].NamingContext, '__dc_summary__');
  // History entries sit in the middle, prefixed with __history__:
  const historyIdx = snap.Entries.findIndex(e => e.NamingContext.startsWith('__history__:'));
  assert.ok(historyIdx >= 2, `expected history entries starting at idx 2, got idx ${historyIdx}`);
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