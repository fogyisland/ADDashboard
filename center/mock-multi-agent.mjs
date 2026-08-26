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

const CENTER_URL = process.env.CENTER_URL ?? 'http://127.0.0.1:8081';
const REPORT_URL = process.env.REPORT_URL ?? 'http://127.0.0.1:8082';
const AGENT_TOKEN = process.env.AGENT_TOKEN ?? '973d8e916d1e6ee3e08e43751515c2e71abac9f4ee3abc6e295a5a154894f5ecd12742a837a22b7ac43fbf0a34c5a1c6';
const ADMIN_URL = process.env.ADMIN_URL ?? 'http://127.0.0.1:8080';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';

const HEARTBEAT_PATH = '/api/agent/heartbeat';
const REPORT_PATH = '/api/agent/report';
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

async function postReplication({ agentId, collectedAt, source = 'collect-replication-mock', data }) {
  const body = {
    source,
    agentId,
    collectedAt: collectedAt.toISOString(),
    data,
    lockoutEvents: []
  };
  const res = await fetch(`${REPORT_URL}${REPORT_PATH}`, {
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
  return [
    {
      label: 'recent success (within 1h, all links OK)',
      agentId: 'MOCK-DC-FRESH',
      heartbeat: { when: 'now' },
      replication: {
        when: withinHour,
        links: [
          { destDc: 'PEER-DC-01', statusCode: 0 },
          { destDc: 'PEER-DC-02', statusCode: 0 }
        ]
      },
      localState: { when: withinHour }
    },
    {
      label: 'recent partial_failure (within 1h, one link failing)',
      agentId: 'MOCK-DC-PARTIAL',
      heartbeat: { when: 'now' },
      replication: {
        when: withinHour,
        links: [
          { destDc: 'PEER-DC-01', statusCode: 0 },
          { destDc: 'PEER-DC-02', statusCode: 2, errorMessage: 'RPC server unavailable (round-trip > 30s)' },
          { destDc: 'PEER-DC-03', statusCode: 0 }
        ]
      },
      localState: { when: withinHour }
    },
    {
      label: 'stale (replication 2h old, heartbeat fresh)',
      agentId: 'MOCK-DC-STALE',
      heartbeat: { when: 'now' },
      replication: {
        when: twoHoursAgo,
        links: [
          { destDc: 'PEER-DC-01', statusCode: 0 },
          { destDc: 'PEER-DC-02', statusCode: 0 }
        ]
      },
      // No localState — agent only has the 2h-old replication row, so the
      // 1-hour window is empty and the dashboard shows 'stale'.
      localState: null
    },
    {
      label: 'never-uploaded (heartbeat only, no replication rows)',
      agentId: 'MOCK-DC-QUIET',
      heartbeat: { when: 'now' },
      replication: null,
      // No localState — agent has NEVER produced any replication row, so
      // last_report_at stays NULL and the dashboard shows ⏸ 未上传.
      localState: null
    }
  ];
}

// ----- scenario execution -----

function buildReplicationData(agentId, collectedAt, links) {
  // Each link becomes a row in ad_replication_status. Mirror the round-13
  // INSERT shape (16 cols + partner_port_status) so the rows land without
  // shape errors; partnerPortStatus is null because we're not probing
  // partner ports in this scenario.
  const rows = [];
  for (const link of links) {
    rows.push({
      sourceDc: agentId,
      destDc: link.destDc,
      sourceSite: null,
      destSite: null,
      namingContext: link.namingContext ?? `CN=${agentId},CN=Partition`,
      lastSuccessTime: link.statusCode === 0 ? collectedAt.toISOString() : null,
      lastAttemptTime: collectedAt.toISOString(),
      lastFailureReason: link.statusCode === 0 ? null : (link.errorMessage ?? 'unknown'),
      failureCount: link.statusCode === 0 ? 0 : 1,
      statusCode: link.statusCode,
      errorMessage: link.statusCode === 0 ? null : (link.errorMessage ?? null),
      usersCount: null,
      groupsCount: null,
      gposCount: null,
      lockedCount: null,
      partnerPortStatus: null
    });
  }
  return rows;
}

async function runOne(scenario) {
  const { label, agentId, heartbeat, replication, localState } = scenario;
  console.log(`\n--- ${label} (agent=${agentId}) ---`);
  if (heartbeat) {
    const hb = await postHeartbeat({ agentId });
    console.log(`  heartbeat  → HTTP ${hb.status}`);
  }
  if (replication) {
    const collectedAt = floorSec(parseWhen(replication.when));
    if (!collectedAt) {
      console.log(`  replication → SKIP (when=never)`);
    } else {
      const data = buildReplicationData(agentId, collectedAt, replication.links ?? []);
      const rep = await postReplication({ agentId, collectedAt, data });
      console.log(`  replication → HTTP ${rep.status} (collected_at=${collectedAt.toISOString()}, rows=${data.length})`);
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
      const data = buildReplicationData(agentId, localCollectedAt, [
        { destDc: '__local_state__', namingContext: '__local_state__', statusCode: 0 }
      ]);
      const rep = await postReplication({ agentId, collectedAt: localCollectedAt, data, source: 'collect-local-state-mock' });
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
  console.log(`  MOCK-DC-FRESH   → success         (within 1h, all OK)`);
  console.log(`  MOCK-DC-PARTIAL → partial_failure (within 1h, one link failing)`);
  console.log(`  MOCK-DC-STALE   → stale           (replication 2h old)`);
  console.log(`  MOCK-DC-QUIET   → null / 未上传    (no replication ever)`);
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
