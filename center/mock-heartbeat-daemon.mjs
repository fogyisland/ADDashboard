// mock-heartbeat-daemon.mjs — continuously-running mock agents that honor
// the centre's `reportRequested: true` signal in the heartbeat response.
//
// Why a daemon instead of mock-multi-agent.mjs (which is one-shot)?
// The one-shot runner posts heartbeat + replication + discovery once, then
// exits. When the operator clicks 回报 in the dashboard, the centre sets
// `report_requested_at = NOW()` and waits for the next heartbeat — but the
// one-shot mock isn't heartbeating anymore, so the flag never gets
// consumed and the 报告表 row never refreshes.
//
// This daemon does what the real AD agent does (see agent/src/heartbeat.js
// + agent/src/heartbeat-callbacks.js):
//   1. Heartbeat every HEARTBEAT_INTERVAL_MS
//   2. If response.reportRequested === true → immediately post a fresh
//      replication snapshot (collected_at = NOW()) so the centre's
//      ad_replication_status.MAX(collected_at) advances and the
//      operators' "最近报告" column updates.
//   3. Also tick a steady-state replication cadence (REPLICATION_TICK_MS)
//      so the data stays fresh even without operator action.
//
// Usage:
//   node mock-heartbeat-daemon.mjs                    # default 4-agent scenario
//   MOCK_AGENTS=json node mock-heartbeat-daemon.mjs   # custom scenario
//
// Each agent runs in its own loop; failures are logged and retried. The
// daemon runs until SIGINT/SIGTERM (Ctrl+C).

import { setTimeout as delay } from 'node:timers/promises';
import { buildSnapshot, buildPartnerPortEntries } from './mock-snapshot.mjs';
import { toCamelEntry } from '../agent/src/reporter.js';

const CENTER_URL = process.env.CENTER_URL ?? 'http://127.0.0.1:8081';
const REPORT_URL = process.env.REPORT_URL ?? 'http://127.0.0.1:8082';
const AGENT_TOKEN = process.env.AGENT_TOKEN ?? '973d8e916d1e6ee3e08e43751515c2e71abac9f4ee3abc6e295a5a154894f5ecd12742a837a22b7ac43fbf0a34c5a1c6';
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS ?? 5000);
const REPLICATION_TICK_MS  = Number(process.env.REPLICATION_TICK_MS  ?? 60000);

const HEARTBEAT_PATH = '/api/agent/heartbeat';
const REPORT_PATH    = '/api/agent/report';
const DISCOVER_PATH  = '/api/agent/discover';

// ----- scenario -----

// 2026-08-27 round-35: peer-host probe overrides — keyed by partner
// identifier (the same string used in link.destDc so the
// ${source}${sep}${dest} lookup in the matrix route matches). Each
// entry lists forced probe results for specific ports. The helper looks
// up an override by peer identifier when assembling the partner-port
// entry for a given peer; if the peer is listed, the forced result
// replaces the SHA-256-derived one.
//
// Scenario: FZ1 (the operator's known problematic DC) reports port 50001
// as unreachable when other agents probe it. From the matrix view's
// inbound perspective, this is what surfaces in /admin/site-replication-
// matrix/all for any primary DC that FZ1 replicates TO. Since FZ1
// replicates to FZ2 and HUB1, those primaries' inbound probes will show
// FZ1's port 50001 in red — matching the operator's "FZ1 partial failure"
// observation from round-19.
const FZ1_PARTNER_OVERRIDES = [
  {
    host: 'MOCK-FZADSRV1',
    portResults: [
      { port: 50001, reachable: false, latencyMs: null,
        error: 'ConnectionRefused (FZ1 operator scenario)' }
    ]
  }
];

function defaultScenario() {
  // 2026-08-26 round-19+: operator-defined topology. Each non-HUB site's
  // PDC reports its replication partners as [intra-site sibling, HUBADSRV1].
  // Sibling DCs mirror the PDC (their intra-site PDC + HUBADSRV1). The hub
  // site has 2 DCs: HUBADSRV1 reports links to every spoke PDC; HUBADSRV2
  // mirrors HUBADSRV1 plus reports its intra-site sibling.
  //
  // 2026-08-26 follow-up: MOCK- prefix added to every agent id so the mock
  // data cannot collide with REAL production DCs sharing those names. The
  // operator's ncadserv1 / fzadsrv1 / hubadsrv1 / xmadsrv1 are real DC
  // hostnames in their environment; without the prefix, a real DC at
  // ncadserv1 heartbeating would silently overwrite the mock's heartbeat
  // row (and vice versa). MOCK-<NAME> keeps the topology narrative (the
  // operator still sees the topology they're modeling) while making the
  // mock rows unambiguously fake.
  const HUB1 = 'MOCK-HUBADSRV1';
  const HUB2 = 'MOCK-HUBADSRV2';
  const NC1 = 'MOCK-NCADSRV1';
  const NC2 = 'MOCK-NCADSRV2';
  const FZ1 = 'MOCK-FZADSRV1';
  const FZ2 = 'MOCK-FZADSRV2';
  const XM1 = 'MOCK-XMADSRV1';
  const XM2 = 'MOCK-XMADSRV2';
  // peers[] here is the set of partner DCs the agent REPORTS (its sources).
  const dc = (agentId, opts = {}) => ({
    name: agentId,
    hostname: `${agentId.toLowerCase()}.mock.local`,
    ipAddress: opts.ip ?? '10.99.0.10',
    osVersion: 'Windows Server 2022 (mock)',
    siteHint: opts.siteHint ?? 'MOCK-SITE',
    isPdc: !!opts.isPdc,
    roles: opts.isPdc
      ? ['DomainController', 'PDCEmulator', 'RIDMaster', 'InfrastructureMaster']
      : ['DomainController']
  });
  return [
    // NC site — 2 DCs (NC1 is PDC). Per operator: NC1 -> [NC2, HUB1].
    { agentId: NC1, isPdc: true,  peers: [NC2, HUB1], failRate: 0.0,  ip: '10.99.0.10', siteHint: 'MOCK-NC' },
    { agentId: NC2, isPdc: false, peers: [NC1, HUB1], failRate: 0.05, ip: '10.99.0.14', siteHint: 'MOCK-NC' },
    // FZ site — 2 DCs (FZ1 occasionally failing). Pattern: FZ1 -> [FZ2, HUB1].
    // round-35: FZ1's port 50001 is wired to fail when OTHER agents probe
    // it (FZ2 + HUB1 in their peer lists). The matrix view's inbound cell
    // for any primary that FZ1 replicates TO will show 50001 in red —
    // matching the operator's "FZ1 partial failure" observation.
    { agentId: FZ1, isPdc: false, peers: [FZ2, HUB1], failRate: 0.34, ip: '10.99.0.11', siteHint: 'MOCK-FZ' },
    { agentId: FZ2, isPdc: false, peers: [FZ1, HUB1], failRate: 0.0,  ip: '10.99.0.15', siteHint: 'MOCK-FZ' },
    // XM site — 2 DCs (XM1 stale). Pattern: XM1 -> [XM2, HUB1].
    { agentId: XM1, isPdc: false, peers: [XM2, HUB1], failRate: 0.0,  ip: '10.99.0.12', siteHint: 'MOCK-XM', replicationTickMs: REPLICATION_TICK_MS * 4 },
    { agentId: XM2, isPdc: false, peers: [XM1, HUB1], failRate: 0.0,  ip: '10.99.0.16', siteHint: 'MOCK-XM' },
    // Hub site — 2 DCs. HUB1 reports outbound to all 3 spoke PDCs; HUB2
    // mirrors with HUB1 added (sibling link).
    { agentId: HUB1, isPdc: false, peers: [NC1, FZ1, XM1],                failRate: 0.0, ip: '10.99.0.13', siteHint: 'MOCK-HUB' },
    { agentId: HUB2, isPdc: false, peers: [HUB1, NC1, FZ1, XM1],          failRate: 0.0, ip: '10.99.0.17', siteHint: 'MOCK-HUB' }
  ];
}

function loadScenario() {
  if (process.env.MOCK_AGENTS) {
    try {
      const parsed = JSON.parse(process.env.MOCK_AGENTS);
      if (!Array.isArray(parsed)) throw new Error('MOCK_AGENTS must be a JSON array');
      return parsed;
    } catch (e) {
      console.error('bad MOCK_AGENTS JSON:', e.message);
      process.exit(2);
    }
  }
  return defaultScenario();
}

// ----- HTTP helpers -----

async function postJson(url, body, { timeoutMs = 5000 } = {}) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Token': AGENT_TOKEN, 'X-Agent-Id': body.agentId ?? '' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, ok: res.ok, data, text };
  } catch (e) {
    return { status: 0, ok: false, error: e.message };
  }
}

function buildHeartbeatBody(agentId) {
  return {
    source: 'collect-heartbeat-mock-daemon',
    agentId,
    agentVersion: '0.1.0-mock-daemon',
    agentType: 'ad',
    hostname: agentId,
    ports: [],
    pendingQueueSize: 0,
    // Self-declared column is ignored by the round-15 source-of-truth switch;
    // ad_replication_status.MAX(collected_at) drives the dashboard.
    lastReportAt: null,
    lastReportStatus: 'idle',
    agent_token_version: 1
  };
}

// 2026-08-27 round-24: replaced by buildSnapshot (from mock-snapshot.mjs) so
// the daemon drives the real agent/src/reporter.js postReport path.
// buildSnapshot appends a __dc_summary__ entry with deterministic
// per-DC counters (usersCount / groupsCount / gposCount) derived from the
// agentId hash, instead of the previous hardcoded 0/0/0.
//
// 2026-08-27 round-35: also append partner-port entries
// (__partner_ports__:% rows) — one per peer, covering the default probe
// port set (135, 445, 50001, 50002, 50003). Without these rows the matrix
// view's per-port badges render as "无探测" and operators see no port-level
// signal at all. The helper produces deterministic per-(agent, peer, port)
// outcomes via SHA-256; we don't add Math.random() here so test snapshots
// stay stable across runs.
//
// FZ1 partial-failure override: matches the operator's known scenario from
// round-19 ("FZ1 ports partially unreachable"). Forcing 50001 to fail
// deterministically (rather than relying on the ~12.5% hash threshold)
// gives the dashboard a visible failing-port badge they recognize from
// the production env without the daemon needing external state.
function buildReplicationSnapshot(agentId, peers, failRate, sourceSite, opts = {}) {
  const links = peers.map((destDc) => {
    const isFail = Math.random() < failRate;
    return {
      destDc,
      namingContext: `${agentId}->${destDc}`,
      statusCode: isFail ? 2 : 0,
      errorMessage: isFail ? 'RPC server unavailable (mock)' : null
    };
  });
  // 2026-08-27 round-35: pass peers (raw agentIds) verbatim — they MUST
  // match link.destDc exactly so the route's ${source}${sep}${dest}
  // lookup against latestPartnerPortPerPair finds the partner-port row.
  // In a real AD env, Get-PartnerPortSnapshot stores DestDc as the
  // partner's FQDN and the per-link entry uses the same FQDN. The mock
  // here uses the partner's agentId for both to keep the data shape
  // internally consistent (the centre doesn't care which format the
  // mock chose, only that source/dest match between the two row types).
  const collectedAt = new Date();
  const portOverrides = opts.portOverrides ?? FZ1_PARTNER_OVERRIDES;
  const partnerPortEntries = buildPartnerPortEntries({
    agentId,
    collectedAt,
    peers,
    sourceSite,
    portOverrides
  });
  return buildSnapshot({
    agentId,
    collectedAt,
    sourceSite,
    links,
    partnerPortEntries
  });
}

function buildDiscovery(agentId, isPdc, opts = {}) {
  return {
    name: agentId,
    hostname: `${agentId.toLowerCase()}.mock.local`,
    ipAddress: opts.ip ?? '10.99.0.10',
    osVersion: 'Windows Server 2022 (mock)',
    // Round-19 follow-up #2: pass per-site hint through from the scenario
    // spec so the operator sees MOCK-NC / MOCK-FZ / MOCK-XM / MOCK-HUB in
    // the dashboard's site grouping, instead of the generic MOCK-SITE.
    siteHint: opts.siteHint ?? 'MOCK-SITE',
    isPdc: !!isPdc,
    roles: isPdc
      ? ['DomainController', 'PDCEmulator', 'RIDMaster', 'InfrastructureMaster']
      : ['DomainController']
  };
}

// ----- per-agent loop -----

async function runAgent(spec, { stopFlag }) {
  const { agentId, peers = [], failRate = 0, isPdc = false, replicationTickMs = REPLICATION_TICK_MS } = spec;
  let lastReplicationAt = 0;
  let lastDiscoveryAt = 0;
  let heartbeatCount = 0;
  let reportNowCount = 0;

  // Initial discovery claim so the agent's row exists in ad_dcs.
  const disc = await postJson(`${REPORT_URL}${DISCOVER_PATH}`, {
    source: 'collect-discovery-mock-daemon',
    agentId,
    collectedAt: new Date().toISOString(),
    dc: buildDiscovery(agentId, isPdc, { ip: spec.ip, siteHint: spec.siteHint })
  });
  if (disc.ok) {
    lastDiscoveryAt = Date.now();
    console.log(`[${agentId}] discovery ok (HTTP ${disc.status})`);
  } else {
    console.warn(`[${agentId}] discovery failed: ${disc.error || disc.status}`);
  }

  while (!stopFlag.stopped) {
    const hbBody = buildHeartbeatBody(agentId);
    const hb = await postJson(`${CENTER_URL}${HEARTBEAT_PATH}`, hbBody);
    heartbeatCount++;
    if (!hb.ok) {
      console.warn(`[${agentId}] heartbeat failed (HTTP ${hb.status} / ${hb.error || 'unknown'})`);
    } else {
      const reportRequested = hb.data?.reportRequested === true;
      if (reportRequested) reportNowCount++;
      const now = Date.now();
      // Honor report-now signal: post fresh replication immediately.
      // Also tick on the steady-state cadence. The two paths share the
      // same postReplication() so the wire shape stays identical to the
      // real agent's collect-replication.ps1 output.
      if (reportRequested || (now - lastReplicationAt) >= replicationTickMs) {
        // 2026-08-27 round-24: buildSnapshot produces the same PascalCase
        // shape collect-replication.ps1 emits. The agent's reporter
        // (reporter.toCamelEntry) is what converts to the wire shape —
        // not the centre. Run it here before posting, the same way
        // collect-replication.ps1 → reporter.postReport does on the real
        // agent. Without this, rowParams in services/replication.js reads
        // row.sourceDc (undefined) → SQL bind error ("must not contain
        // undefined"), every report 500s.
        const snapshot = buildReplicationSnapshot(agentId, peers, failRate, spec.siteHint ?? 'MOCK-SITE');
        const rep = await postJson(`${REPORT_URL}${REPORT_PATH}`, {
          source: 'collect-replication-mock-daemon',
          agentId,
          collectedAt: snapshot.CollectedAt,
          data: snapshot.Entries.map(toCamelEntry)
        });
        if (rep.ok) {
          lastReplicationAt = now;
          console.log(
            `[${agentId}] replication ok (HTTP ${rep.status}` +
            `, rows=${snapshot.Entries.length}` +
            (reportRequested ? `, triggeredBy=report-now` : '') +
            `, collectedAt=${snapshot.CollectedAt})`
          );
        } else {
          console.warn(`[${agentId}] replication failed (HTTP ${rep.status} / ${rep.error || 'unknown'})`);
        }
      }
      // Discovery tick every 10 minutes (matches the real cadence) — keeps
      // the ad_dcs row from being garbage-collected if the centre ever
      // adds such a policy.
      if ((now - lastDiscoveryAt) >= 10 * 60_000) {
        const d = await postJson(`${REPORT_URL}${DISCOVER_PATH}`, {
          source: 'collect-discovery-mock-daemon',
          agentId,
          collectedAt: new Date().toISOString(),
          dc: buildDiscovery(agentId, isPdc, { ip: spec.ip, siteHint: spec.siteHint })
        });
        if (d.ok) lastDiscoveryAt = now;
      }
    }
    await delay(HEARTBEAT_INTERVAL_MS);
  }
  console.log(`[${agentId}] daemon exiting (heartbeats=${heartbeatCount}, reportNow=${reportNowCount})`);
}

// ----- main -----

const stopFlag = { stopped: false };
const agents = loadScenario();

console.log(`mock-heartbeat-daemon starting: ${agents.length} agent(s), heartbeat=${HEARTBEAT_INTERVAL_MS}ms, replication-tick=${REPLICATION_TICK_MS}ms`);
console.log(`  center=${CENTER_URL}  report=${REPORT_URL}`);

const tasks = agents.map((spec) =>
  runAgent(spec, { stopFlag }).catch((e) => {
    console.error(`[${spec.agentId}] crashed:`, e?.message || e);
  })
);

const shutdown = (sig) => {
  console.log(`\n${sig} received; stopping...`);
  stopFlag.stopped = true;
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

await Promise.all(tasks);
console.log('mock-heartbeat-daemon stopped.');