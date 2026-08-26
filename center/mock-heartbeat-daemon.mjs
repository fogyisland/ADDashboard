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

const CENTER_URL = process.env.CENTER_URL ?? 'http://127.0.0.1:8081';
const REPORT_URL = process.env.REPORT_URL ?? 'http://127.0.0.1:8082';
const AGENT_TOKEN = process.env.AGENT_TOKEN ?? '973d8e916d1e6ee3e08e43751515c2e71abac9f4ee3abc6e295a5a154894f5ecd12742a837a22b7ac43fbf0a34c5a1c6';
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS ?? 5000);
const REPLICATION_TICK_MS  = Number(process.env.REPLICATION_TICK_MS  ?? 60000);

const HEARTBEAT_PATH = '/api/agent/heartbeat';
const REPORT_PATH    = '/api/agent/report';
const DISCOVER_PATH  = '/api/agent/discover';

// ----- scenario -----

function defaultScenario() {
  const peers = ['PEER-DC-01', 'PEER-DC-02', 'PEER-DC-03'];
  const dc = (agentId, opts = {}) => ({
    name: agentId,
    hostname: `${agentId.toLowerCase()}.mock.local`,
    ipAddress: opts.ip ?? '10.99.0.10',
    osVersion: 'Windows Server 2022 (mock)',
    siteHint: 'MOCK-SITE',
    isPdc: !!opts.isPdc,
    roles: opts.isPdc
      ? ['DomainController', 'PDCEmulator', 'RIDMaster', 'InfrastructureMaster']
      : ['DomainController']
  });
  return [
    { agentId: 'MOCK-DC-FRESH',   isPdc: true,  peers, failRate: 0.0 },
    { agentId: 'MOCK-DC-PARTIAL', isPdc: false, peers, failRate: 0.34 },
    { agentId: 'MOCK-DC-QUIET',   isPdc: false, peers: [], failRate: 0.0 },
    { agentId: 'MOCK-DC-STALE',   isPdc: false, peers, failRate: 0.0, replicationTickMs: REPLICATION_TICK_MS * 4 }
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

function buildReplicationData(agentId, peers, failRate) {
  const collectedAt = new Date();
  const rows = peers.map((destDc) => {
    const isFail = Math.random() < failRate;
    return {
      sourceDc: agentId,
      destDc,
      sourceSite: 'MOCK-SITE',
      destSite:   'MOCK-SITE',
      namingContext: `${agentId}->${destDc}`,
      statusCode: isFail ? 2 : 0,
      errorMessage: isFail ? 'RPC server unavailable (mock)' : null,
      lastSuccessTime: isFail ? null : collectedAt.toISOString(),
      lastAttemptTime: collectedAt.toISOString(),
      usersCount: null, groupsCount: null, gposCount: null,
      partnerPortStatus: null
    };
  });
  // Always include __dc_summary__ so the per-agent self-loop entry shows up.
  rows.push({
    sourceDc: agentId,
    destDc: agentId,
    sourceSite: 'MOCK-SITE',
    destSite:   'MOCK-SITE',
    namingContext: '__dc_summary__',
    statusCode: 0,
    errorMessage: null,
    lastSuccessTime: collectedAt.toISOString(),
    lastAttemptTime: collectedAt.toISOString(),
    usersCount: 0, groupsCount: 0, gposCount: 0,
    partnerPortStatus: null
  });
  return { collectedAt, rows };
}

function buildDiscovery(agentId, isPdc) {
  return {
    name: agentId,
    hostname: `${agentId.toLowerCase()}.mock.local`,
    ipAddress: '10.99.0.10',
    osVersion: 'Windows Server 2022 (mock)',
    siteHint: 'MOCK-SITE',
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
    dc: buildDiscovery(agentId, isPdc)
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
        const { collectedAt, rows } = buildReplicationData(agentId, peers, failRate);
        const rep = await postJson(`${REPORT_URL}${REPORT_PATH}`, {
          source: 'collect-replication-mock-daemon',
          agentId,
          collectedAt: collectedAt.toISOString(),
          data: rows
        });
        if (rep.ok) {
          lastReplicationAt = now;
          console.log(
            `[${agentId}] replication ok (HTTP ${rep.status}` +
            `, rows=${rows.length}` +
            (reportRequested ? `, triggeredBy=report-now` : '') +
            `, collectedAt=${collectedAt.toISOString()})`
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
          dc: buildDiscovery(agentId, isPdc)
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