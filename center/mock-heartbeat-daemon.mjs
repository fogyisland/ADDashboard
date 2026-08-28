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
import { buildSnapshot, buildReplicationHistoryEntries, buildPartnerPortEntries } from './mock-snapshot.mjs';
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

// 2026-08-28 round-46: FZ1_PARTNER_OVERRIDES re-imported from mock-snapshot
// (R35 surface restored for the 复制日志监控 view's port-health column).
// mock-snapshot.mjs owns the canonical override map; the daemon does not
// redefine it. Real agent wires the same override via
// collect-replication.ps1::FZ1_PARTNER_OVERRIDES.

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
  //
  // 2026-08-28 round-43: hub-spoke topology. Round-36.1's full-mesh
  // (every DC replicates to every other DC) was a dev convenience to keep
  // the matrix view from looking empty after round-35's inbound-only
  // filter, but it made the operator-facing 复制日志监控 / 复制状态概览
  // views look like "every DC has a mutual connection to every other DC"
  // — which is not how real AD replication looks.
  //
  // 2026-08-28 round-44 (operator directive): sparse hub-spoke as the most
  // realistic AD topology. Each DC's outbound partner list mirrors what a real
  // repadmin /showrepl * report would surface on that DC:
  //   - HUB1 → same-site sibling HUB2 + the FIRST DC of every other site
  //            (NC1 / FZ1 / XM1 — the PDCs). NOT siblings NC2 / FZ2 / XM2.
  //   - HUB2 → only HUB1 (backup hub, single-direction redundancy).
  //   - Each spoke PDC → intra-site sibling + HUB1 (the reverse of HUB1's
  //     outbound keeps the partner agreement symmetric across the two DCs).
  //   - Each spoke non-PDC → only the intra-site PDC.
  //
  // Total edges: 14 directed rows / 7 unique bidirectional pairs
  //   {NC1,NC2} {NC1,HUB1} {FZ1,FZ2} {FZ1,HUB1} (FZ1→HUB1 fail)
  //   {XM1,XM2} {XM1,HUB1} {HUB1,HUB2}
  //
  // Shape: per-agent `links: [{destDc, statusCode, errorMessage?}]` instead of
  // the previous `peers: [...] + failRate` — explicit status code per link so
  // FZ1's partial-failure (1-of-1 specifically on HUB1) is deterministic.
  const HUB1 = 'MOCK-HUBADSRV1';
  const HUB2 = 'MOCK-HUBADSRV2';
  const NC1 = 'MOCK-NCADSRV1';
  const NC2 = 'MOCK-NCADSRV2';
  const FZ1 = 'MOCK-FZADSRV1';
  const FZ2 = 'MOCK-FZADSRV2';
  const XM1 = 'MOCK-XMADSRV1';
  const XM2 = 'MOCK-XMADSRV2';
  const ok   = (destDc)               => ({ destDc, statusCode: 0 });
  const fail = (destDc, errorMessage) => ({ destDc, statusCode: 2, errorMessage });
  return [
    // NC site — 2 DCs (NC1 is PDC).
    // NC1 → intra-site sibling + HUB1 (reverse of HUB1's outbound to NC1).
    { agentId: NC1, isPdc: true,  links: [ok(NC2), ok(HUB1)], ip: '10.99.0.10', siteHint: 'MOCK-NC' },
    // NC2 → only PDC (sibling intra-site).
    { agentId: NC2, isPdc: false, links: [ok(NC1)], ip: '10.99.0.14', siteHint: 'MOCK-NC' },
    // FZ site — 2 DCs (FZ1 partial-failure on HUB1 specifically — preserved
    // from round-19 as the operator's known problematic DC scenario).
    // FZ1 → intra-site sibling + HUB1 (FAIL — RPC unavailable).
    { agentId: FZ1, isPdc: false, links: [ok(FZ2), fail(HUB1, 'RPC server unavailable (round-trip > 30s)')], ip: '10.99.0.11', siteHint: 'MOCK-FZ' },
    { agentId: FZ2, isPdc: false, links: [ok(FZ1)], ip: '10.99.0.15', siteHint: 'MOCK-FZ' },
    // XM site — 2 DCs (XM1 stale: replicationTickMs ×4 so the row ages past 30-min floor during normal observation).
    { agentId: XM1, isPdc: false, links: [ok(XM2), ok(HUB1)], ip: '10.99.0.12', siteHint: 'MOCK-XM', replicationTickMs: REPLICATION_TICK_MS * 4 },
    { agentId: XM2, isPdc: false, links: [ok(XM1)], ip: '10.99.0.16', siteHint: 'MOCK-XM' },
    // Hub site — 2 DCs.
    // HUB1 → same-site sibling HUB2 + first DC of every other site (NC1, FZ1, XM1).
    { agentId: HUB1, isPdc: false, links: [ok(HUB2), ok(NC1), ok(FZ1), ok(XM1)], ip: '10.99.0.13', siteHint: 'MOCK-HUB' },
    // HUB2 → only HUB1 (operator directive: 备份 hub 仅与主 hub 同步).
    { agentId: HUB2, isPdc: false, links: [ok(HUB1)], ip: '10.99.0.17', siteHint: 'MOCK-HUB' }
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

// 2026-08-27 round-41: track the "next heartbeat should explicitly clear
// the server-side report_requested_at flag" latch in module scope. The
// heartbeat UPSERT path uses COALESCE(report_requested_at, ...) which
// silently PRESERVES the column when the agent omits the field — so an
// agent that never explicitly nulls it leaves the button stuck on
// "已请求回报" forever after one admin click. The real agent
// (agent/src/heartbeat-callbacks.js makePayload) arms this flag in the
// send-callback after a successful report-now fan-out, then the next
// payload carries `report_requested_at: null` (which routes through the
// centre's clearReportRequest UPDATE). Mock daemon now mirrors that
// one-shot semantic; otherwise every heartbeat forever re-triggers
// report-now because the centre keeps returning reportRequested: true.
function buildHeartbeatBody(agentId, pendingReportClear) {
  const body = {
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
  if (pendingReportClear) {
    // Explicit null = "I consumed the report-now request, clear the flag".
    // COALESCE in the heartbeat UPSERT would otherwise keep the column set
    // because the bind value is JavaScript null. Mirrors the real agent's
    // `p.report_requested_at = null` in heartbeat-callbacks.js makePayload.
    body.report_requested_at = null;
  }
  return body;
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
function buildReplicationSnapshot(agentId, links, sourceSite, opts = {}) {
  // 2026-08-28 round-43: scenario now ships explicit per-link statusCode
  // (no more random failRate coin-flip). Each entry already carries
  // {destDc, statusCode, errorMessage?}; we just stamp the namingContext
  // and forward verbatim.
  const fullLinks = links.map((l) => ({
    destDc: l.destDc,
    namingContext: `${agentId}->${l.destDc}`,
    statusCode: l.statusCode ?? 0,
    errorMessage: l.errorMessage ?? null
  }));
  // peers are derived from fullLinks (1:1 with destDc) — used as input
  // to buildReplicationHistoryEntries below.
  const peers = fullLinks.map((l) => l.destDc);
  const collectedAt = new Date();
  // 2026-08-27 round-42 (复制日志监控): append per-attempt history
  // entries that land in ad_replication_history via the dedicated
  // insertHistoryEntries path on the route. The history helper uses a
  // synthetic `__history__:%` naming_context that the route forks off
  // into ad_replication_history ONLY (never ad_replication_status), so
  // the matrix view's latest-per-pair queries stay uncorrupted by
  // back-dated attempt timestamps.
  //
  // 2026-08-28 round-46: buildPartnerPortEntries restored (R35 deletion
  // undone for the 复制日志监控 view). One row per unique peer DC with JSON
  // partner_port_status; ports = the configured system_ports list from
  // /api/agent/partner-ports (defaulted here to [135,445,389,636,3268,88,
  // 50001,50002,50003] if the agent didn't query the configured list).
  const partnerPortEntries = buildPartnerPortEntries(
    agentId, collectedAt, fullLinks,
    opts.configuredPorts ?? [135, 445, 389, 636, 3268, 88, 50001, 50002, 50003]
  );

  // 2026-08-28 round-46: historyEntries keep their R42 contract; the
  // partner-port entries ride alongside, sorted before history + summary.
  // from the replication link's statusCode/errorMessage.
  //
  // historyEnabled defaults true so the operator's dashboard populates
  // out of the box. The route no-ops insertHistoryEntries if the
  // centre's system_config.history_enabled flag is false, so this is
  // safe regardless of operator policy.
  const historyEntries = buildReplicationHistoryEntries({
    agentId,
    collectedAt,
    peers,
    sourceSite,
    historyEnabled: opts.historyEnabled !== false,
    attemptsPerPair: opts.attemptsPerPair ?? 3
  });
  return buildSnapshot({
    agentId,
    collectedAt,
    sourceSite,
    // Pass the enriched entries (namingContext + normalized statusCode/errorMessage
    // already stamped) so mock-snapshot.mjs::buildLinkEntries uses them verbatim
    // — the format `<agentId>-><destDc>` matches what previous mock cycles wrote,
    // keeping downstream GROUP BY (source_dc, dest_dc, naming_context) consistent
    // across old + new rows during the 30-min freshness crossover window.
    links: fullLinks,
    partnerPortEntries,
    historyEntries
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
  // 2026-08-28 round-43: destructure `links: [{destDc, statusCode, errorMessage?}]`
  // (replacing the round-36.1 `peers: [...] + failRate` shape). buildReplicationSnapshot
  // consumes the link shape directly so the centre's status code for each peer
  // reflects the operator's reality (FZ1 → HUB1 fails, every other peer OK)
  // rather than a random failRate coin-flip.
  const { agentId, links = [], isPdc = false, replicationTickMs = REPLICATION_TICK_MS } = spec;
  let lastReplicationAt = 0;
  let lastDiscoveryAt = 0;
  let heartbeatCount = 0;
  // round-41: one-shot latch — see comment in buildHeartbeatBody above.
  // Set to true the moment we honour a report-now, then buildHeartbeatBody
  // consumes it on the very next heartbeat by including
  // `report_requested_at: null`. Without this, the centre's UPSERT
  // COALESCE preserves the column forever and every subsequent heartbeat
  // re-triggers reportRequested: true.
  let pendingReportClear = false;
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
    const hbBody = buildHeartbeatBody(agentId, pendingReportClear);
    // round-41: consume the latch — we just emitted the explicit-null
    // payload. Clear it BEFORE the request so a synchronous restart of
    // the loop never re-emits null. The flag is module-scoped per
    // agent, so other mock agents in the same process are unaffected.
    const emitClearThisCycle = pendingReportClear;
    pendingReportClear = false;
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
        const snapshot = buildReplicationSnapshot(agentId, links, spec.siteHint ?? 'MOCK-SITE');
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
            `, collectedAt=${snapshot.CollectedAt}` +
            (emitClearThisCycle ? `, clearedReportRequest=true` : '') +
            `)`
          );
          // round-41: arm the one-shot clear so the next heartbeat body
          // carries `report_requested_at: null`. Mirrors the real agent's
          // setPendingClear(true) call in heartbeat-callbacks.js after a
          // successful report-now fan-out. Only fire on report-now
          // triggers — steady-state ticks must NOT keep emitting null,
          // which would clobber a freshly-set admin request via the
          // clearReportRequest path. (If an admin clicks 回报 *after* a
          // steady-state tick, the centre's response would still say
          // reportRequested: true, and we'd re-arm normally.)
          if (reportRequested) {
            pendingReportClear = true;
          }
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