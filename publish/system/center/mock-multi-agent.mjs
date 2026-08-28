// mock-multi-agent.mjs — multi-agent scenario runner for the operator
// heartbeat dashboard. Lets you stage 3-4 mock agents on the same live
// center with controllable timestamps so the 1-hour threshold rule
// (success / partial_failure / stale / 未上传) is visible end-to-end
// against GET /api/admin/heartbeat-report/agents.
//
// Why a separate runner instead of extending mock-replication.mjs:
// the user's explicit ask is "构造多个 mock 模拟 agent 目前的代码回报
// 状态信息，在额外的内容中添加一个信号回报，在这里设置心跳时间，站
// 点复制时间，本地状态回报时间 都是支持设置". So each agent needs its
// own clock for three different signals:
//   - heartbeat time         (when ad_agent_heartbeat.last_heartbeat_at is set)
//   - site replication time  (when ad_replication_status.collected_at is set)
//   - local state report time (when port / package metrics are reported)
//
// Usage:
//   MOCK_AGENTS='[{"id":"dc-fresh", ...}]' node mock-multi-agent.mjs
// or just `node mock-multi-agent.mjs` to run the built-in 4-agent demo.
//
// Built-in demo stages:
//   dc-fresh      — heartbeat + replication within 1h, all links OK
//                   → last_report_status: success
//   dc-partial    — heartbeat + replication within 1h, mix of OK + fail
//                   → last_report_status: partial_failure
//   dc-stale      — heartbeat fresh but replication 2h old
//                   → last_report_status: stale (NOT null, NOT 未上传)
//   dc-quiet      — no replication ever (heartbeat fresh, ad_replication_status empty)
//                   → last_report_status: null (UI shows ⏸ 未上传)
//
// Each agent's timing is configurable through the JSON config so the
// operator can re-stage the scenario without touching code.

import { buildSnapshot, buildReplicationHistoryEntries, postSnapshot } from './mock-snapshot.mjs';

const CENTER_URL = process.env.CENTER_URL ?? 'http://127.0.0.1:8081';
const REPORT_URL = process.env.REPORT_URL ?? 'http://127.0.0.1:8082';
const AGENT_TOKEN = process.env.AGENT_TOKEN ?? '973d8e916d1e6ee3e08e43751515c2e71abac9f4ee3abc6e295a5a154894f5ecd12742a837a22b7ac43fbf0a34c5a1c6';
const ADMIN_URL = process.env.ADMIN_URL ?? 'http://127.0.0.1:8080';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';

const HEARTBEAT_PATH = '/api/agent/heartbeat';
const REPORT_PATH = '/api/agent/report';
const DISCOVER_PATH = '/api/agent/discover';
const AGENTS_LIST_PATH = '/api/admin/heartbeat-report/agents';

// ----- time helpers -----

// Parse a human-friendly timestamp spec into a Date:
//   'now'        → Date.now()
//   'now-5m'     → Date.now() - 5 min
//   'now-2h'     → Date.now() - 2 h
//   'never'      → null (caller skips this signal)
//   ISO string   → new Date(...)
function parseWhen(spec, fallback = null) {
  if (spec == null || spec === 'never') return fallback;
  if (spec === 'now') return new Date();
  const m = /^now-(\d+)([smhd])$/.exec(String(spec).trim());
  if (m) {
    const n = Number(m[1]);
    const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
    return new Date(Date.now() - n * unit);
  }
  const d = new Date(spec);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`bad time spec: ${spec}`);
  }
  return d;
}

// Round to seconds so MySQL DATETIME columns round-trip cleanly.
function floorSec(d) {
  if (!d) return null;
  return new Date(Math.floor(d.getTime() / 1000) * 1000);
}

// ----- HTTP helpers -----

async function postHeartbeat({ agentId, source = 'collect-heartbeat-mock' }) {
  const body = {
    source,
    agentId,
    agentVersion: '0.1.0-mock-multi',
    agentType: 'ad',
    hostname: agentId,
    ports: [],
    pendingQueueSize: 0,
    // Mirrors what the real agent's postHeartbeat() emits. lastReportAt
    // is null because we never use the self-declared heartbeat column
    // for the dashboard (round-15 derives last_report_at from
    // ad_replication_status.MAX(collected_at)).
    lastReportAt: null,
    lastReportStatus: 'idle',
    agent_token_version: 1
  };
  const res = await fetch(`${CENTER_URL}${HEARTBEAT_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Token': AGENT_TOKEN },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000)
  });
  return { status: res.status, text: await res.text() };
}

// 2026-08-27 round-24: postReplication is replaced by postSnapshot (from
// mock-snapshot.mjs) which routes through the real agent/src/reporter.js
// postReport path. See "scenario execution" below.

// 2026-08-26 round-15: post-discovery so the mock agent claims its DC row
// in ad_dcs. Without this, only heartbeats + replication land — the
// operator's DC list shows nothing for the mock, even though the agent
// is alive and reporting. The real agent's collect-discovery.ps1 makes
// this call; the mock mirrors that flow so the dashboard renders the
// DC the same way it does for a real DC.
//
// IMPORTANT: /api/agent/discover lives on the REPORT port (8082), not
// the heartbeat port (8081). server.js mounts the agentRouter three
// times — once per role — with `mount: 'report'` enabling /discover,
// `mount: 'heartbeat'` only enabling /heartbeat, and `mount: 'web'`
// enabling /config.json. The discover endpoint deliberately avoids the
// heartbeat port because discovery is heavy (it logs every call) and
// would drown the cheap /heartbeat path.
async function postDiscover({ agentId, dc, source = 'collect-discovery-mock' }) {
  const collectedAt = new Date().toISOString();
  const body = { source, agentId, collectedAt, dc };
  const res = await fetch(`${REPORT_URL}${DISCOVER_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Token': AGENT_TOKEN, 'X-Agent-Id': agentId },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000)
  });
  return { status: res.status, text: await res.text() };
}

// ----- default scenario -----

function defaultScenario() {
  const now = new Date();
  const withinHour = new Date(now.getTime() - 5 * 60_000);   // 5 min ago
  const twoHoursAgo = new Date(now.getTime() - 2 * 3_600_000); // 2h ago
  // 2026-08-26 round-15 hot-fix: stale / quiet scenarios must NOT post a
  // fresh localState row — that would silently bump MAX(collected_at) into
  // the 1-hour window and flip the agent back to "success" / "fresh".
  // The operator's mental model is "heartbeat time, replication time,
  // local-state time" as three INDEPENDENT clocks; the mock now respects
  // that. localState=null means "no local-state report was ever emitted";
  // localState.withinHour or .twoHoursAgo lets the operator exercise each
  // signal independently.
  // 2026-08-26 round-15: each scenario now declares a `discovery` block
  // so the mock agent claims its row in ad_dcs. Without discovery, the
  // operator's DC list shows nothing for the mock — only heartbeats and
  // replication land. Real agents run collect-discovery.ps1 on a
  // schedule; the mock mirrors that.
  const dc = (agentId, opts = {}) => ({
    name: agentId,
    hostname: `${agentId.toLowerCase()}.mock.local`,
    ipAddress: opts.ip ?? '10.99.0.10',
    osVersion: 'Windows Server 2022 (mock)',
    // 2026-08-26 round-15 follow-up: discovery.js reads dc.siteHint
    // (NOT dc.site). The real collect-discovery.ps1 emits siteHint in
    // camelCase; the mock must do the same so ad_dcs.site_hint lands
    // populated and the operator's DC list can JOIN ad_sites on it.
    siteHint: opts.siteHint ?? 'MOCK-SITE',
    isPdc: !!opts.isPdc,
    roles: opts.isPdc
      ? ['DomainController', 'PDCEmulator', 'RIDMaster', 'InfrastructureMaster']
      : ['DomainController']
  });
  // 2026-08-26 follow-up: agent IDs now use MOCK- prefix to avoid
  // collision with REAL production DCs at the same names. The operator's
  // ncadserv1 / fzadsrv1 / hubadsrv1 / xmadsrv1 are real DCs in their
  // environment; without the prefix a real DC at ncadserv1 would silently
  // overwrite the mock row in ad_agent_heartbeat. MOCK-<NAME> preserves
  // the topology narrative (the labels still mirror production naming) while
  // making the mock rows unambiguously fake.
  //
  // 2026-08-26 round-19+: operator-defined hub-spoke topology. Each non-HUB
  // site's PDC reports [intra-site sibling, HUBADSRV1]; siblings mirror the
  // PDC. The hub replicates to every spoke PDCs (HUB1) or hub1+spokes (HUB2).
  //
  // The operator also added a "+2" variant per site — second DC at each
  // site. 8 mocks total cover the hub-spoke topology with 2 DCs per site.
  const HUB1 = 'MOCK-HUBADSRV1';
  const HUB2 = 'MOCK-HUBADSRV2';
  const NC1 = 'MOCK-NCADSRV1';
  const NC2 = 'MOCK-NCADSRV2';
  const FZ1 = 'MOCK-FZADSRV1';
  const FZ2 = 'MOCK-FZADSRV2';
  const XM1 = 'MOCK-XMADSRV1';
  const XM2 = 'MOCK-XMADSRV2';
  // 2026-08-28 round-43: hub-spoke topology. Round-36.1's full-mesh
  // (every DC replicates to every other DC) was a dev convenience to keep
  // the matrix view from looking empty after round-35's inbound-only
  // filter, but it made the operator-facing 复制日志监控 / 复制状态概览
  // views look like "every DC has a mutual connection to every other DC"
  // — which is not how real AD replication looks. Real AD is sparse:
  // spokes only replicate to their intra-site sibling + cross-site hubs;
  // hubs replicate to every spoke + the other hub.
  //
  // 2026-08-28 round-44 (operator directive): realistic AD topology —
  // HUB1 connects to same-site sibling + each site's FIRST (PDC) DC,
  // HUB2 connects only to HUB1 (backup hub, single-direction redundancy).
  // Each spoke PDC replicates to intra-site sibling + HUB1 (reverse of
  // HUB1's outbound keeps partner agreement symmetric). Each spoke
  // non-PDC replicates only to the intra-site PDC.
  // Total edges: 14 directed rows / 7 unique bidirectional pairs
  //   {NC1,NC2} {NC1,HUB1} {FZ1,FZ2} {FZ1,HUB1} (FZ1→HUB1 fail)
  //   {XM1,XM2} {XM1,HUB1} {HUB1,HUB2}
  return [
    {
      label: 'NC site DC1 (PDC) — recent success (within 1h, sparse hub-spoke OK)',
      agentId: NC1,
      heartbeat: { when: 'now' },
      discovery: { dc: dc(NC1, { isPdc: true, ip: '10.99.0.10', siteHint: 'MOCK-NC' }) },
      replication: {
        when: withinHour,
        // 2026-08-28 R44 sparse hub-spoke: spoke PDC → intra-site sibling + HUB1 only
        links: [
          { destDc: NC2,  statusCode: 0 },
          { destDc: HUB1, statusCode: 0 }
        ]
      },
      localState: { when: withinHour }
    },
    {
      label: 'FZ site DC1 (PDC) — recent partial_failure (HUB1 link fails, round-19 regression)',
      agentId: FZ1,
      heartbeat: { when: 'now' },
      discovery: { dc: dc(FZ1, { ip: '10.99.0.11', siteHint: 'MOCK-FZ' }) },
      replication: {
        when: withinHour,
        // 2026-08-28 R44 sparse hub-spoke: spoke PDC → intra-site sibling + HUB1 only.
        // HUB1 fails to inject variability; FZ1's outbound list drops HUB2 entirely.
        links: [
          { destDc: FZ2,  statusCode: 0 },
          { destDc: HUB1, statusCode: 2, errorMessage: 'RPC server unavailable (round-trip > 30s)' }
        ]
      },
      localState: { when: withinHour }
    },
    {
      label: 'XM site DC1 (PDC) — stale (replication 2h old)',
      agentId: XM1,
      heartbeat: { when: 'now' },
      discovery: { dc: dc(XM1, { ip: '10.99.0.12', siteHint: 'MOCK-XM' }) },
      replication: {
        when: twoHoursAgo,
        // 2026-08-28 R44 sparse hub-spoke: spoke PDC → intra-site sibling + HUB1 only.
        // Reported 2h ago → staleness signal survives regression.
        links: [
          { destDc: XM2,  statusCode: 0 },
          { destDc: HUB1, statusCode: 0 }
        ]
      },
      localState: null
    },
    {
      label: 'Hub DC1 — outbound to HUB2 + each site\'s first (PDC) DC',
      agentId: HUB1,
      heartbeat: { when: 'now' },
      discovery: { dc: dc(HUB1, { ip: '10.99.0.13', siteHint: 'MOCK-HUB' }) },
      replication: {
        when: withinHour,
        // 2026-08-28 R44 sparse hub-spoke (operator directive):
        // HUB1 → same-site sibling + the FIRST DC of every other site (not siblings NC2/FZ2/XM2)
        links: [
          { destDc: HUB2, statusCode: 0 },
          { destDc: NC1, statusCode: 0 },
          { destDc: FZ1, statusCode: 0 },
          { destDc: XM1, statusCode: 0 }
        ]
      },
      localState: { when: withinHour }
    },
    {
      label: 'NC site DC2 (sibling) — recent success (within 1h, sparse hub-spoke OK)',
      agentId: NC2,
      heartbeat: { when: 'now' },
      discovery: { dc: dc(NC2, { ip: '10.99.0.14', siteHint: 'MOCK-NC' }) },
      replication: {
        when: withinHour,
        // 2026-08-28 R44 sparse hub-spoke: spoke non-PDC → intra-site PDC only
        links: [
          { destDc: NC1,  statusCode: 0 }
        ]
      },
      localState: { when: withinHour }
    },
    {
      label: 'FZ site DC2 (sibling) — recent success (within 1h, sparse hub-spoke OK)',
      agentId: FZ2,
      heartbeat: { when: 'now' },
      discovery: { dc: dc(FZ2, { ip: '10.99.0.15', siteHint: 'MOCK-FZ' }) },
      replication: {
        when: withinHour,
        // 2026-08-28 R44 sparse hub-spoke: spoke non-PDC → intra-site PDC only
        links: [
          { destDc: FZ1,  statusCode: 0 }
        ]
      },
      localState: { when: withinHour }
    },
    {
      label: 'XM site DC2 (sibling) — recent success (within 1h, sparse hub-spoke OK)',
      agentId: XM2,
      heartbeat: { when: 'now' },
      discovery: { dc: dc(XM2, { ip: '10.99.0.16', siteHint: 'MOCK-XM' }) },
      replication: {
        when: withinHour,
        // 2026-08-28 R44 sparse hub-spoke: spoke non-PDC → intra-site PDC only
        links: [
          { destDc: XM1,  statusCode: 0 }
        ]
      },
      localState: { when: withinHour }
    },
    {
      label: 'Hub DC2 — outbound to HUB1 only (operator directive: backup hub)',
      agentId: HUB2,
      heartbeat: { when: 'now' },
      discovery: { dc: dc(HUB2, { ip: '10.99.0.17', siteHint: 'MOCK-HUB' }) },
      replication: {
        when: withinHour,
        // 2026-08-28 R44 sparse hub-spoke: HUB2 → HUB1 only (no spoke replication).
        // Backup hub has single-direction redundancy with primary.
        links: [
          { destDc: HUB1, statusCode: 0 }
        ]
      },
      localState: { when: withinHour }
    }
  ];
}

// ----- scenario execution -----

// Build a snapshot in the EXACT PascalCase shape that collect-replication.ps1
// emits. mock-snapshot.mjs handles the toCamelEntry conversion via
// reporter.postReport, so this mock automatically picks up any future
// field additions in the agent's reporter (round-18 dropped LockedCount
// here, round-13 added PartnerPortStatus — those were the round-17/18
// drift points that bit us). buildSnapshot also appends a
// __dc_summary__ entry with deterministic per-DC counters so the
// Server Overview's DcCard never renders — / 0 for a healthy mock.
//
// 2026-08-28 round-45: partner-port entries removed (R35 port monitoring
// surface deleted end-to-end). The matrix view's status pill + inline
// error message now carries the failure signal directly from the
// replication link's statusCode/errorMessage — no per-port rows are
// emitted by mock or real agent.
function buildReplicationSnapshot(agentId, collectedAt, links, sourceSite, opts = {}) {
  // peer IDs here are the same string used in link.destDc — input to
  // buildReplicationHistoryEntries below.
  const peerIds = (links ?? []).map((l) => l.destDc);
  // 2026-08-27 round-42 (复制日志监控): also append per-attempt history
  // entries that land in ad_replication_history via the dedicated
  // insertHistoryEntries path on the route. The history helper uses a
  // synthetic `__history__:%` naming_context that the route forks off
  // into ad_replication_history ONLY (never ad_replication_status).
  const historyEntries = buildReplicationHistoryEntries({
    agentId,
    collectedAt,
    peers: peerIds,
    sourceSite,
    historyEnabled: opts.historyEnabled !== false,
    attemptsPerPair: opts.attemptsPerPair ?? 3
  });
  return buildSnapshot({
    agentId,
    collectedAt,
    sourceSite,
    links: links ?? [],
    historyEntries
  });
}

async function runOne(scenario) {
  const { label, agentId, heartbeat, discovery, replication, localState } = scenario;
  console.log(`\n--- ${label} (agent=${agentId}) ---`);
  if (heartbeat) {
    const hb = await postHeartbeat({ agentId });
    console.log(`  heartbeat  → HTTP ${hb.status}`);
  }
  // 2026-08-26 round-15: post-discovery so the agent claims its DC row
  // in ad_dcs. The real agent's collect-discovery.ps1 calls this on a
  // schedule; the mock mirrors that call.
  if (discovery?.dc) {
    const dc = await postDiscover({ agentId, dc: discovery.dc });
    console.log(`  discovery  → HTTP ${dc.status} (dc=${discovery.dc.name})`);
  } else {
    console.log(`  discovery  → SKIP (no dc block)`);
  }
  if (replication) {
    const collectedAt = floorSec(parseWhen(replication.when));
    if (!collectedAt) {
      console.log(`  replication → SKIP (when=never)`);
    } else {
      const sourceSite = discovery?.dc?.siteHint ?? null;
      const snapshot = buildReplicationSnapshot(agentId, collectedAt, replication.links ?? [], sourceSite);
      const rep = await postSnapshot({ centerUrl: REPORT_URL, agentToken: AGENT_TOKEN, snapshot });
      console.log(`  replication → HTTP ${rep.status} (collected_at=${collectedAt.toISOString()}, entries=${snapshot.Entries.length})`);
    }
  } else {
    console.log(`  replication → SKIP (no block — agent has never reported)`);
  }
  // localState currently sends the same replication row but with the
  // localState timestamp. In the real agent, this is the
  // pkg_ad_local_port_check.metrics row. For this mock we just emit a
  // one-link replication row keyed to localState so the operator can
  // verify "local state report time" stamps distinctly on the dashboard
  // (ad_replication_status.MAX(collected_at) gets bumped to localState
  // time, exercising the 1-hour rule with that clock).
  //
  // 2026-08-26 round-15: scenarios may pass `localState: null` to mean
  // "no local-state report was ever emitted" — that lets STALE / QUIET
  // stay in their target state instead of being silently bumped into
  // the 1-hour window by an unrelated localState row.
  if (localState) {
    const localCollectedAt = floorSec(parseWhen(localState.when));
    if (localCollectedAt) {
      const sourceSite = discovery?.dc?.siteHint ?? null;
      // 2026-08-27 round-35: the localState sentinel uses __local_state__
      // as a synthetic link — not a real partner. Bypass
      // buildReplicationSnapshot (which would route through the
      // heartbeat path with history entries) and emit a minimal snapshot
      // that only stamps collected_at for the localState clock. R45
      // also removed partner-port rows, so the previous concern about
      // __partner_ports__:__local_state__ leaking is now gone too.
      const snapshot = buildSnapshot({
        agentId,
        collectedAt: localCollectedAt,
        sourceSite,
        links: [{ destDc: '__local_state__', namingContext: '__local_state__', statusCode: 0 }]
      });
      const rep = await postSnapshot({ centerUrl: REPORT_URL, agentToken: AGENT_TOKEN, snapshot });
      console.log(`  localState → HTTP ${rep.status} (collected_at=${localCollectedAt.toISOString()})`);
    } else {
      console.log(`  localState → SKIP (when=never)`);
    }
  } else {
    console.log(`  localState → SKIP (no block — agent never emitted a local-state report)`);
  }
}

async function fetchAdminView() {
  if (!ADMIN_TOKEN) return null;
  const res = await fetch(`${ADMIN_URL}${AGENTS_LIST_PATH}`, {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    signal: AbortSignal.timeout(5000)
  });
  const json = await res.json();
  return json;
}

function summarizeView(view) {
  if (!view) return '  (set ADMIN_TOKEN to fetch /api/admin/heartbeat-report/agents after staging)';
  const lines = ['  agent              lastHeartbeat            lastReportAt            status              summary'];
  const fmt = (s, n) => String(s ?? '—').slice(0, n).padEnd(n);
  for (const a of view.agents ?? []) {
    lines.push(`  ${fmt(a.agentId, 18)} ${fmt(a.lastHeartbeatAt, 22)} ${fmt(a.lastReportAt, 22)} ${fmt(a.lastReportStatus, 18)} ${fmt(a.reportSummary ? `${a.reportSummary.successCount}/${a.reportSummary.failCount} of ${a.reportSummary.totalLinks}` : 'null', 16)}`);
  }
  return lines.join('\n');
}

async function main() {
  console.log(`mock-multi-agent starting`);
  console.log(`  heartbeat URL = ${CENTER_URL}`);
  console.log(`  report URL    = ${REPORT_URL}`);
  console.log(`  admin URL     = ${ADMIN_URL}`);
  console.log(`  token prefix  = ${AGENT_TOKEN.slice(0, 8)}...`);

  let scenarios;
  if (process.env.MOCK_AGENTS) {
    scenarios = JSON.parse(process.env.MOCK_AGENTS);
    console.log(`  scenario      = from MOCK_AGENTS env (${scenarios.length} agent(s))`);
  } else {
    scenarios = defaultScenario();
    console.log(`  scenario      = built-in 4-agent demo (success / partial / stale / never)`);
  }

  for (const sc of scenarios) {
    await runOne(sc);
  }

  // Give MySQL a moment to settle, then surface the admin view if we can.
  await new Promise(r => setTimeout(r, 500));
  console.log(`\n--- admin view ---`);
  let view = null;
  try {
    view = await fetchAdminView();
  } catch (e) {
    console.log(`  (admin fetch failed: ${e.message})`);
  }
  console.log(summarizeView(view));

  console.log(`\ndone. open the heartbeat view in the admin UI to verify the four states:`);
  console.log(`  ncadserv1   → success         (within 1h, all OK)`);
  console.log(`  fzadsrv1    → partial_failure (within 1h, one link failing)`);
  console.log(`  xmadsrv1    → stale           (replication 2h old)`);
  console.log(`  hubadsrv1   → null / 未上传    (no replication ever)`);
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
