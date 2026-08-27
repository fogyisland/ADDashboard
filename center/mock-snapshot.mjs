// mock-snapshot.mjs — shared helper for mock-*.mjs runners.
//
// 2026-08-27 round-24: the operator's directive is "mock 反过去执行 agent
// 路径", i.e. mocks must drive the same code paths the real agent drives.
// Before this refactor, each mock-*.mjs hand-rolled the camelCase
// data[] shape that /api/agent/report expects — duplicating the agent's
// `toCamelEntry()` conversion and missing every field the agent adds over
// time (round-18 dropped LockedCount on __dc_summary__, round-13 added
// PartnerPortStatus, etc.). The mock silently drifted out of sync.
//
// 2026-08-27 round-35: added buildPartnerPortEntries producing
// __partner_ports__:% rows in the EXACT shape
// collect-replication.ps1::Get-PartnerPortSnapshot emits. The matrix
// view (复制状态概览) reads these via latestPartnerPortPerPair; without
// them the port badges render as "无探测". The operator's "缺少端口检查"
// complaint in round-34 traced here — mocks never exercised the partner-
// port code path, so even with a live daemon the dashboard never saw
// probe data.
//
// This module produces a snapshot in the EXACT PascalCase shape that
// collect-replication.ps1 emits, then defers to the real
// `postReport()` from agent/src/reporter.js. Field changes in the
// reporter are automatically picked up by every mock that imports this.
//
// Public surface:
//   buildDcCounters(agentId)                 -> { usersCount, groupsCount, gposCount }
//   buildSummaryEntry(agentId, ...)          -> __dc_summary__ entry (PS1 shape)
//   buildLinkEntries(agentId, links, ...)    -> per-link entries (PS1 shape)
//   buildPartnerPortEntries({ agentId, peers, ports, ... })
//                                            -> __partner_ports__:% entries (PS1 shape)
//   buildReplicationHistoryEntries({ agentId, peers, ... })
//                                            -> per-attempt history entries (PS1 shape)
//   buildSnapshot({ agentId, links, ... })   -> full snapshot (PS1 shape)
//   postSnapshot({ centerUrl, agentToken, snapshot }) -> wraps reporter.postReport
//   dcSummaryRowOf(snapshot)                 -> quick accessor for tests
//
// All values that hit the DB flow through reporter.toCamelEntry() before
// the wire — so this module never has to know about the camelCase wire
// shape. Future field additions in toCamelEntry are picked up for free.

import crypto from 'node:crypto';
import { postReport } from '../agent/src/reporter.js';

// Stable per-DC counters derived from a SHA-256 of the agentId. Same agent
// always yields the same numbers across runs (looks like real AD data),
// different agents get different numbers (simulates per-DC AD scale).
// Ranges chosen to look like realistic small/medium AD deployments:
//   - usersCount: 500..5000
//   - groupsCount: 50..600 (roughly 10-15% of users)
//   - gposCount: 10..100
export function buildDcCounters(agentId) {
  if (typeof agentId !== 'string' || !agentId) {
    throw new TypeError('buildDcCounters: agentId required');
  }
  const hash = crypto.createHash('sha256').update(agentId).digest();
  const u32 = (off) => hash.readUInt32BE(off);
  return {
    usersCount:  500 + (u32(0) % 4501),
    groupsCount:  50 + (u32(4) %  551),
    gposCount:   10 + (u32(8) %   91),
  };
}

// 2026-08-26 round-18: LockoutCount moved out of collect-replication.ps1.
// It's now emitted by ad_lockout_summary / ad_lockout_list packages on a
// 15-min cadence. The real __dc_summary__ entry still carries the
// locked_count column in the SQL schema (and the centre's latestSummaryPerDc
// still reads it), but the agent stops setting it to non-null here.
// Mock mirrors that — LockedCount: null — so the operator sees the same
// shape they'd see from a real agent. To exercise the lockedCount path,
// run the ad_lockout_summary package (mock-package-report.mjs).
export function buildSummaryEntry(agentId, collectedAt, sourceSite = null) {
  const counters = buildDcCounters(agentId);
  return {
    SourceDc:         agentId,
    DestDc:           agentId,            // mirror real PS1: self-loop
    SourceSite:       sourceSite,
    DestSite:         null,
    NamingContext:    '__dc_summary__',
    LastSuccessTime:  collectedAt,
    LastAttemptTime:  collectedAt,
    StatusCode:       0,
    ErrorMessage:     null,
    UsersCount:       counters.usersCount,
    GroupsCount:      counters.groupsCount,
    GposCount:        counters.gposCount,
    LockedCount:      null,
    PartnerPortStatus: null
  };
}

// Convert a mock-friendly link descriptor to a PS1 PascalCase entry.
// link shape (camelCase, mock-ergonomic):
//   {
//     destDc, destSite?, namingContext?, statusCode?, errorMessage?,
//     partnerPortStatus?  // round-13: per-partner port probe JSON
//   }
export function buildLinkEntries(agentId, collectedAt, links = [], sourceSite = null) {
  const out = [];
  for (const link of links) {
    out.push({
      SourceDc:         agentId,
      DestDc:           link.destDc,
      SourceSite:       sourceSite,
      DestSite:         link.destSite ?? null,
      NamingContext:    link.namingContext ?? `CN=${agentId}->${link.destDc}`,
      LastSuccessTime:  link.statusCode === 0 ? collectedAt : null,
      LastAttemptTime:  collectedAt,
      StatusCode:       link.statusCode ?? 0,
      ErrorMessage:     link.statusCode === 0 ? null : (link.errorMessage ?? 'unknown'),
      UsersCount:       null,
      GroupsCount:      null,
      GposCount:        null,
      LockedCount:      null,
      PartnerPortStatus: link.partnerPortStatus ?? null
    });
  }
  return out;
}

// 2026-08-27 round-35: build a __partner_ports__:% entry per peer.
// Mirrors collect-replication.ps1::Get-PartnerPortSnapshot + Get-PartnerNamingContext
// byte-for-byte:
//   - naming_context = '__partner_ports__:<truncated_host>_<4-byte SHA-256 hex>'
//     (truncated_host = first 64 chars of the peer hostname)
//   - status_code   = 0 when every port is reachable, else the count of unreachable ports
//   - partner_port_status = JSON string of { checked_at, ports: { <port>:
//     { reachable, latencyMs, error } } }
//   - dest_dc       = the partner hostname (NOT the partner's agentId —
//     the PS1 does `Get-ADReplicationPartnerMetadata -Target $ComputerName`
//     which yields FQDN hostnames; the daemon should pass peer hostnames here)
//
// Deterministic outcomes: SHA-256(agentId|peerHost|port) drives the
// reachable flag (top byte threshold 32 → ~87% reachable, simulating a
// healthy-but-not-perfect AD) and the latency (next 16 bits → 2..15 ms).
// Tests and live dashboards get stable probe data across runs.
//
// portOverrides: optional list of { host, portResults: [{port, reachable,
// latencyMs, error}] } — used by mock-multi-agent to inject the
// operator's known "FZ1 partial failure" scenario deterministically.
export function buildPartnerPortEntries({
  agentId,
  collectedAt,
  peers = [],
  ports = [135, 445, 50001, 50002, 50003],
  sourceSite = null,
  portOverrides = null
} = {}) {
  if (typeof agentId !== 'string' || !agentId) {
    throw new TypeError('buildPartnerPortEntries: agentId required');
  }
  const ts = collectedAt instanceof Date
    ? collectedAt.toISOString()
    : String(collectedAt);

  const overrideMap = new Map();
  if (Array.isArray(portOverrides)) {
    for (const o of portOverrides) {
      if (o && typeof o.host === 'string') overrideMap.set(o.host, o);
    }
  }

  const out = [];
  for (const peer of peers) {
    const peerHost = typeof peer === 'string' ? peer : peer?.host;
    if (!peerHost) continue;

    const portResults = [];
    let unreachableCount = 0;
    const override = overrideMap.get(peerHost);
    for (const port of ports) {
      let result;
      if (override && Array.isArray(override.portResults)) {
        const ovr = override.portResults.find((p) => p.port === port);
        if (ovr) result = ovr;
      }
      if (!result) {
        result = probeMockPort(agentId, peerHost, port);
      }
      portResults.push(result);
      if (!result.reachable) unreachableCount++;
    }

    const portMap = {};
    for (const r of portResults) {
      portMap[String(r.port)] = {
        reachable: r.reachable,
        latencyMs: r.latencyMs ?? null,
        error: r.error ?? null
      };
    }
    const payload = JSON.stringify({ checked_at: ts, ports: portMap });

    out.push({
      SourceDc:         agentId,
      DestDc:           peerHost,
      SourceSite:       sourceSite,
      DestSite:         null,
      NamingContext:    partnerPortNamingContext(peerHost),
      LastSuccessTime:  ts,
      LastAttemptTime:  ts,
      // Mirrors Get-PartnerPortSnapshot: status_code = 0 when every port
      // is reachable, else the count of unreachable ports. The route's
      // partner.fillPortLookup reads this directly.
      StatusCode:       unreachableCount,
      ErrorMessage:     null,
      UsersCount:       null,
      GroupsCount:      null,
      GposCount:        null,
      LockedCount:      null,
      PartnerPortStatus: payload
    });
  }
  return out;
}

// Mirror collect-replication.ps1::Get-PartnerNamingContext verbatim.
// Exported for unit tests.
export function partnerPortNamingContext(peerHost) {
  if (!peerHost) return null;
  const truncated = peerHost.length > 64 ? peerHost.slice(0, 64) : peerHost;
  const hash = crypto.createHash('sha256').update(peerHost).digest();
  // 4-byte hex suffix — same shape PS1 emits via -join ($bytes[0..3] | %{ $_.ToString('x2') }).
  const hashStr = hash.slice(0, 4).toString('hex');
  return `__partner_ports__:${truncated}_${hashStr}`;
}

// Deterministic per-port mock probe. Real PS1 actually does TCP connect;
// we synthesize a stable outcome so the dashboard renders consistent
// data across daemon cycles. The hash distribution gives ~87% reachable.
function probeMockPort(agentId, peerHost, port) {
  const hash = crypto.createHash('sha256')
    .update(`${agentId}|${peerHost}|${port}`)
    .digest();
  const reachable = hash[0] >= 32;
  if (!reachable) {
    return { port, reachable: false, latencyMs: null, error: 'timeout (mock)' };
  }
  const latencyMs = 2 + (hash.readUInt16BE(2) % 14); // 2..15 ms
  return { port, reachable: true, latencyMs, error: null };
}

// 2026-08-27 round-42 (复制日志监控): emit per-attempt history rows that
// land in ad_replication_history (extended cols: last_attempt_time,
// attempt_duration_ms, objects_transferred). Mirrors collect-replication.ps1
// ::BuildReplicationHistoryRows byte-for-byte: every entry has its own
// (collected_at, last_attempt_time) timestamp; success rows carry
// attempt_duration_ms + objects_transferred; failure rows carry null
// for both plus a realistic error_message. Without these rows the
// /admin/replication-log/monitor view's expandable caret shows nothing
// and the operator sees a frozen snapshot.
//
// Determinism: SHA-256(agentId|peerHost|namingContext|attemptIdx) drives
// (status, duration, objects) so a given attempt-always-resolves-the-same
// across daemon cycles. Naming context uses a synthetic `__history__:<hash>`
// key that the route forks off into ad_replication_history ONLY (never
// ad_replication_status) — the centre's routes/agent.js splits incoming
// data[] on this prefix. The route's historyByPair lookup (grouped by
// source\1dest\1naming_context) strips the `__history__:` prefix before
// building the lookup key so dashboard groupings match the link's NC.
//
// The agent's reporter.toCamelEntry accepts every PascalCase key below
// and converts them to camelCase on the wire. Centre's
// historyParams reads attemptDurationMs/objectsTransferred off the
// camelCase entry — same shape for both mock + real agents.
//
// History opt-out: when historyEnabled=false the helper returns [] so
// the caller doesn't have to guard against appending empty arrays.
export function buildReplicationHistoryEntries({
  agentId,
  collectedAt,                                    // ISO string or Date
  peers = [],                                     // partner identifiers (link.destDc)
  sourceSite = null,
  historyEnabled = true,
  attemptsPerPair = 3                             // how many historical entries per partner
} = {}) {
  if (typeof agentId !== 'string' || !agentId) {
    throw new TypeError('buildReplicationHistoryEntries: agentId required');
  }
  if (!historyEnabled) return [];
  if (!Array.isArray(peers) || peers.length === 0) return [];
  if (attemptsPerPair < 1) return [];

  const ts = collectedAt instanceof Date
    ? collectedAt.toISOString()
    : String(collectedAt);

  // Anchor for back-dated attempt timestamps. We spread attempts across
  // the past N×5 minutes so the dashboard's "时间" column shows a
  // realistic timeline rather than 10 identical timestamps. Each
  // attempt is 5 min apart; for attemptsPerPair=3 the oldest attempt
  // is 10 min before `ts`.
  const baseTime = Date.parse(ts);
  const STEP_MS = 5 * 60_000;

  const out = [];
  for (const peer of peers) {
    const peerHost = typeof peer === 'string' ? peer : peer?.host;
    if (!peerHost) continue;
    // The REAL link NC (not the synthetic __history__ one). The route
    // strips the `__history__:` prefix before building its lookup key.
    const realNamingContext = `CN=${agentId}->${peerHost}`;

    for (let i = 0; i < attemptsPerPair; i++) {
      // attemptIdx 0 = most recent = matches `ts`; older attempts go back
      // in 5-min steps. We always generate one PER ROW, so a fresh
      // daemon tick refreshes the timeline without touching older rows.
      const attemptAt = new Date(baseTime - i * STEP_MS);
      const attemptIso = attemptAt.toISOString();

      // Deterministic per-(agent, peer, NC, attemptIdx) outcome.
      // status: bit 0 of hash[0] — even = success (0), odd = failure (2).
      // duration: 50..300ms on success, null on failure.
      // objects: 10..5000 on success, null on failure.
      const hash = crypto.createHash('sha256')
        .update(`${agentId}|${peerHost}|${realNamingContext}|${i}`)
        .digest();
      const isFail = (hash[0] & 1) === 1;
      const statusCode = isFail ? 2 : 0;
      const attemptDurationMs = isFail
        ? null
        : 50 + (hash.readUInt16BE(1) % 251);  // 50..300 ms
      const objectsTransferred = isFail
        ? null
        : 10 + (hash.readUInt16BE(3) % 4991); // 10..5000
      const lastSuccessTime = isFail ? null : attemptIso;
      const errorMessage = isFail
        ? pickFailureError(hash)
        : null;

      // Stable synthetic naming_context so the route's fork can
      // recognise these rows. The 8-byte SHA-256 hex ensures no two
      // (agent, peer, NC, attemptIdx) tuples collide.
      const historyHash = crypto.createHash('sha256')
        .update(`${agentId}|${peerHost}|${realNamingContext}|${i}|history`)
        .digest()
        .slice(0, 4)
        .toString('hex');
      const namingContext = `__history__:${historyHash}`;

      out.push({
        SourceDc:         agentId,
        DestDc:           peerHost,
        SourceSite:       sourceSite,
        DestSite:         null,
        NamingContext:    namingContext,
        LastSuccessTime:  lastSuccessTime,
        LastAttemptTime:  attemptIso,
        AttemptDurationMs: attemptDurationMs,
        ObjectsTransferred: objectsTransferred,
        StatusCode:       statusCode,
        ErrorMessage:     errorMessage,
        // PS1 history rows are summary/link-only: never carry counters
        // or port probes. Centre's historyParams reads
        // attemptDurationMs/objectsTransferred off this entry; the rest
        // (usersCount/groupsCount/gposCount/lockedCount/partnerPortStatus)
        // are stored on ad_replication_status only.
        UsersCount:       null,
        GroupsCount:      null,
        GposCount:        null,
        LockedCount:      null,
        PartnerPortStatus: null,
        // 2026-08-27 round-42: route forks data[] on the
        // `__history__:%` NamingContext prefix into the dedicated
        // insertHistoryEntries path. historyParams strips the prefix
        // and binds `_realNamingContext` instead so the stored row
        // matches the link's NC (the dashboard's historyByPair lookup
        // joins on this). Real agents never set this — the literal
        // namingContext is bound instead, which equals _realNamingContext
        // for them anyway.
        _RealNamingContext: realNamingContext
      });
    }
  }
  return out;
}

// Pick a realistic AD-replication error message for a failed history
// attempt. Deterministic per hash slot so the same attempt always
// resolves the same error text across runs.
const FAILURE_ERRORS = [
  'RPC server unavailable',
  'Target principal name incorrect',
  'The replication operation timed out',
  'The directory service is too busy',
  'No writeable DC available for this partition',
  'Replication access was denied',
  'Schema mismatch between source and destination'
];
function pickFailureError(hash) {
  return FAILURE_ERRORS[hash[0] % FAILURE_ERRORS.length];
}

// Build a complete snapshot the way collect-replication.ps1 would emit it.
// Always appends a __dc_summary__ entry so the centre's
// GET /api/dcs/summary → DcCard UI has live counters even when there are
// no replication links (e.g. a brand-new DC that only did its first
// heartbeat). Without this the Server Overview renders — / 0 / — / —
// which they mistake for "the data path never executed".
//
// 2026-08-27 round-35: optionally accepts partnerPortEntries — the
// __partner_ports__:% rows Get-PartnerPortSnapshot emits in the real PS1.
// When present, they're appended after the per-link entries (and before
// the summary). Without these rows the matrix view's port badges render
// as "无探测"; the operator reports the view looks empty.
//
// 2026-08-27 round-42 (复制日志监控): also accepts historyEntries — the
// per-attempt ad_replication_history rows Get-ADReplicationPartnerMetadata
// ._ResultHistory emits in the real PS1. When present, they're appended
// after the partner-port entries (and before the summary). Without these
// rows the 复制日志监控 view's expandable caret shows nothing and the
// operator cannot drill into recent failure details.
export function buildSnapshot({
  agentId,
  collectedAt,                            // ISO string or Date
  sourceSite = null,
  links = [],
  partnerPortEntries = [],
  historyEntries = []
} = {}) {
  if (typeof agentId !== 'string' || !agentId) {
    throw new TypeError('buildSnapshot: agentId required');
  }
  const ts = collectedAt instanceof Date
    ? collectedAt.toISOString()
    : String(collectedAt);
  return {
    AgentId:     agentId,
    CollectedAt: ts,
    Site:        sourceSite,
    Entries: [
      ...buildLinkEntries(agentId, ts, links, sourceSite),
      ...(Array.isArray(partnerPortEntries) ? partnerPortEntries : []),
      ...(Array.isArray(historyEntries) ? historyEntries : []),
      buildSummaryEntry(agentId, ts, sourceSite)
    ]
  };
}

// Wrapper around reporter.postReport so callers don't have to import
// the agent module. Snapshot is passed verbatim — reporter.postReport
// runs toCamelEntry() on each entry before posting.
export function postSnapshot({ centerUrl, agentToken, snapshot }) {
  return postReport({ centerUrl, agentToken, snapshot });
}

// Convenience: pull the __dc_summary__ entry out of a snapshot for tests.
export function dcSummaryRowOf(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.Entries)) return null;
  return snapshot.Entries.find((e) => e.NamingContext === '__dc_summary__') ?? null;
}