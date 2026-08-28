// mock-snapshot.mjs — shared helper for mock-*.mjs runners.
//
// 2026-08-27 round-24: the operator's directive is "mock 反过去执行 agent
// 路径", i.e. mocks must drive the same code paths the real agent drives.
// Before this refactor, each mock-*.mjs hand-rolled the camelCase
// data[] shape that /api/agent/report expects — duplicating the agent's
// `toCamelEntry()` conversion and missing every field the agent adds over
// time. The mock silently drifted out of sync.
//
// 2026-08-28 round-45: buildPartnerPortEntries / partnerPortNamingContext /
// probeMockPort deleted. R35 port monitoring surface removed end-to-end —
// the route no longer reads partner_port_status, the matrix view no longer
// renders per-port columns, and the real agent's Get-PartnerPortSnapshot
// is dropped from collect-replication.ps1. Mocks stay in lockstep: no
// __partner_ports__:% rows emitted.
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
//   buildReplicationHistoryEntries({ agentId, peers, ... })
//                                            -> per-attempt history entries (PS1 shape)
//   buildMockHeartbeatPorts(agentId, ports)  -> [{port, ok, latencyMs}, ...] for heartbeat body
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
    LockedCount:      null
  };
}

// Convert a mock-friendly link descriptor to a PS1 PascalCase entry.
// link shape (camelCase, mock-ergonomic):
//   {
//     destDc, destSite?, namingContext?, statusCode?, errorMessage?
//   }
// 2026-08-28 round-45: partnerPortStatus field removed — R35 port
// monitoring surface deleted end-to-end (collect-replication.ps1, route,
// view, mock). Real agents no longer emit per-port probe rows; mock must
// stay in lockstep.
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
      LockedCount:      null
    });
  }
  return out;
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

// 2026-08-28 round-58.2 — emit per-port probe rows for the heartbeat
// body (`ports[]` field), the way the real agent's collect-heartbeat.ps1
// does. Lands in ad_agent_port_status via the centre's upsertPortStatuses
// path (routes/agent.js:246-280). Mock previously sent `ports: []` so the
// ad_agent_port_status table stayed empty for mock agents and the
// operator's "复制伙伴端口健康监控" view's per-port latency column rendered
// as `—`.
//
// Operator directive: "Mock 也补发 — 填充固定 latency". The real agent
// probes each port via TcpClient + Stopwatch (collect-replication.ps1
// ::Probe-Port); the mock uses FIXED per-port latencies instead of jitter
// or random — deterministic so test snapshots stay stable across runs
// and so the operator can spot regressions (a port that suddenly reports
// `120ms` when it should be `5ms` is a smoking gun).
//
// Latency map (intentionally narrow, ~3-9ms, mirrors "healthy DC local
// port response" — real AD probes typically see <10ms for loopback or
// intra-DC TCP connect time). The map is keyed by port number; ports not
// in the map get a default of 5ms. All entries are `ok: true` because
// the mock is healthy — failure cases can be modeled via
// FZ1_PARTNER_OVERRIDES in the partner-port path if needed (separate
// concern from ad_agent_port_status).
//
// Argument shape: `ports` is the system_ports list returned by
// /api/agent/ports — array of `{id, port, label, sortOrder}`. Caller
// fetches once at startup and caches; this helper is pure so it can be
// unit-tested without network.
export const MOCK_PORT_LATENCY_MS = Object.freeze({
  135: 3,    // RPC — fast local
  88:  3,    // Kerberos
  389: 4,    // LDAP
  445: 5,    // SMB
  636: 6,    // LDAPS (TLS handshake)
  3268: 7,   // GC
  50001: 8,  // NTDS replication
  50002: 8,  // NETLOGON replication
  50003: 8   // DFSR replication
});
const DEFAULT_MOCK_LATENCY_MS = 5;

export function buildMockHeartbeatPorts(agentId, ports = []) {
  if (!Array.isArray(ports)) {
    throw new TypeError('buildMockHeartbeatPorts: ports must be an array');
  }
  return ports
    .filter((p) => {
      if (!p || typeof p !== 'object') return false;
      const n = Number(p.port);
      // Match services/ports.js::isValidPort: integer AND in [1, 65535].
      // This rejects null (Number(null)=0 is integer but not a real port),
      // undefined, NaN, strings, floats, and out-of-range values.
      return Number.isInteger(n) && n >= 1 && n <= 65535;
    })
    .map((p) => {
      const port = Number(p.port);
      return {
        port,
        ok: true,
        latencyMs: MOCK_PORT_LATENCY_MS[port] ?? DEFAULT_MOCK_LATENCY_MS
      };
    });
}

// 2026-08-28 round-58.2 — convenience for the daemon: fetch the centre's
// configured port list once (X-Agent-Token auth, same as the real agent's
// collect-heartbeat.ps1). Returns [] on any failure so callers can fall
// back to an empty `ports[]` (pre-R58.2 behavior, no crash). Network
// errors are logged via console.warn — the daemon's loop continues.
export async function fetchConfiguredPorts({ centerUrl, agentToken, fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  if (!centerUrl || !agentToken) return [];
  const url = `${centerUrl.replace(/\/+$/, '')}/api/agent/ports`;
  try {
    const res = await fetchImpl(url, {
      headers: { 'X-Agent-Token': agentToken },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      console.warn(`[mock-ports] GET ${url} → HTTP ${res.status}`);
      return [];
    }
    const body = await res.json();
    if (!Array.isArray(body)) return [];
    return body;
  } catch (e) {
    console.warn(`[mock-ports] fetch failed: ${e.message}`);
    return [];
  }
}

// 2026-08-28 round-46: partner-port probe helpers restored (deleted in
// R45 along with the rest of the R35 surface). Mock agents now emit one
// `__partner_ports__:%` row per unique replication peer with a JSON
// partner_port_status — byte-for-byte matching what collect-replication.ps1
// ::Get-PartnerPortSnapshot produces. 复制日志监控 view shows the inbound
// replication history AND configured-port health together.

export function partnerPortNamingContext(agentId, peerHost) {
  const raw = `${agentId}|${peerHost}|partner_ports`.toLowerCase();
  // SHA-256 → first 4 bytes (8 hex chars), matches collect-replication.ps1's
  // Get-PartnerNamingContext so the synthetic NC is byte-identical between
  // real agent and mock for the same (agent, peer) tuple.
  const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 8);
  return `__partner_ports__:${hash}`;
}

function probeMockPort(host, port) {
  // Deterministic per-(host, port) probe. ~87% reachable with 2-15ms latency,
  // matching collect-replication.ps1's TcpClient.BeginConnect + Get-Random
  // jitter pattern.
  const h = crypto.createHash('sha256').update(`${host}|${port}`).digest();
  const reachable = h[0] % 8 !== 0;       // ~87.5% reachable (fail on 0)
  const latency = reachable ? 2 + (h[1] % 14) : null;
  return {
    port: Number(port),
    ok: reachable,
    latency
  };
}

// Per-peer override map (matches the real agent's R35 FZ1_PARTNER_OVERRIDES):
// any (agent, peer) tuple listed here forces a specific port to fail. Used
// to keep deterministic tests for the 端口检测 not running failure path.
export const FZ1_PARTNER_OVERRIDES = new Map([
  ['FZ1ADSRV1:50001', false]
]);

export function buildPartnerPortEntries(agentId, collectedAt, links = [], configuredPorts = [] = []) {
  if (typeof agentId !== 'string' || !agentId) {
    throw new TypeError('buildPartnerPortEntries: agentId required');
  }
  const ts = collectedAt instanceof Date
    ? collectedAt.toISOString()
    : String(collectedAt);
  const ports = (configuredPorts && configuredPorts.length)
    ? configuredPorts
    : [135, 445, 389, 636, 3268, 88, 50001, 50002, 50003];
  const seen = new Set();
  const out = [];
  for (const link of links) {
    const peer = link.destDc;
    if (!peer || seen.has(peer)) continue;
    seen.add(peer);
    const probes = ports.map((p) => {
      const key = `${agentId}:${p}`;
      let probe = probeMockPort(peer, p);
      if (FZ1_PARTNER_OVERRIDES.has(key)) {
        probe = { port: p, ok: !!FZ1_PARTNER_OVERRIDES.get(key), latency: null };
      }
      return probe;
    });
    const unreachableCount = probes.filter((p) => !p.ok).length;
    const status = unreachableCount === 0
      ? 0
      : (unreachableCount === probes.length ? 2 : 1);
    const payload = { ports: probes };
    const payloadJson = JSON.stringify(payload);
    out.push({
      SourceDc:         agentId,
      DestDc:           peer,
      SourceSite:       link.sourceSite ?? null,
      DestSite:         link.destSite ?? null,
      NamingContext:    partnerPortNamingContext(agentId, peer),
      LastSuccessTime:  status === 0 ? ts : null,
      LastAttemptTime:  ts,
      StatusCode:       status,
      ErrorMessage:     status === 2 ? 'all partner ports unreachable'
                     : status === 1 ? 'partial partner port reachability'
                     : null,
      UsersCount:       null,
      GroupsCount:      null,
      GposCount:        null,
      LockedCount:      null,
      PartnerPortStatus: payloadJson
    });
  }
  return out;
}

// Build a complete snapshot the way collect-replication.ps1 would emit it.
// Always appends a __dc_summary__ entry so the centre's
// GET /api/dcs/summary → DcCard UI has live counters even when there are
// no replication links (e.g. a brand-new DC that only did its first
// heartbeat). Without this the Server Overview renders — / 0 / — / —
// which they mistake for "the data path never executed".
//
// 2026-08-28 round-46: partnerPortEntries restored (R35 deletion undone for
// this view). Accepts partnerPortEntries[] — one entry per unique peer DC
// with JSON partner_port_status — emitted AFTER per-link entries and
// BEFORE history + summary.
//
// 2026-08-27 round-42 (复制日志监控): also accepts historyEntries — the
// per-attempt ad_replication_history rows Get-ADReplicationPartnerMetadata
// ._ResultHistory emits in the real PS1. When present, they're appended
// after the per-link entries (and before the summary). Without these
// rows the inline expansion in 复制状态概览 shows nothing and the
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