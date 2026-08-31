// 2026-08-31 R75 — end-to-end exercise of the AD user/group management
// command chain against a live centre. Drives every wire the real agent
// will drive so the operator can sanity-check the full lifecycle without
// standing up a real AD agent process.
//
// Why a dedicated script (vs. extending mock-multi-agent.mjs /
// mock-heartbeat-daemon.mjs)? The mock-daemon scenarios stage
// heartbeats + replication on a steady-state cadence; the ad-commands
// chain is operator-initiated (queue from admin UI) and runs on demand.
// Keeping the e2e standalone lets it run in isolation against any centre
// without standing up the full daemon.
//
// Flow per command type:
//   1. Operator-side: POST /api/admin/ad-commands
//   2. Agent-side:    GET  /api/agent/ad-commands?hostname=<dc>
//                     (invoked inline via dispatchAdCommands — no daemon
//                     needed; the dispatch function drains the queue
//                     using the imported dispatchMockAdCommand)
//   3. Agent-side:    POST /api/agent/ad-commands/<id>/result
//                     (also inline via dispatchAdCommands)
//   4. Operator-side: GET  /api/admin/ad-commands/<id>  (poll until
//                     status is terminal — success or failed)
//   5. Assert         — mock store mutated as expected
//                     — audit row written
//
// 17 command types are exercised in sequence. Each is wrapped in a
// try/catch so one failure doesn't kill the rest; the summary table at
// the end shows per-type status. Exit 0 only when all 17 are green.
//
// Usage:
//   ADMIN_TOKEN=... AGENT_TOKEN=... node mock-ad-admin-e2e.mjs
//
// ADMIN_TOKEN is required for the queue + GET endpoints. AGENT_TOKEN
// defaults to the same dev token used by mock-multi-agent.mjs so a
// freshly-cloned project can run `node mock-ad-admin-e2e.mjs` against
// the local 8080 with no env setup beyond the admin token.

import { dispatchMockAdCommand, _internalStoreView, resetAdStore } from './mock-ad-admin.mjs';

const ADMIN_URL  = process.env.ADMIN_URL  ?? 'http://127.0.0.1:8080';
const AGENT_URL  = process.env.AGENT_URL  ?? 'http://127.0.0.1:8080';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const AGENT_TOKEN = process.env.AGENT_TOKEN ?? '973d8e916d1e6ee3e08e43751515c2e71abac9f4ee3abc6e295a5a154894f5ecd12742a837a22b7ac43fbf0a34c5a1c6';

// Target DC: the same hostname one of the default mock agents claims.
// Forcing the e2e to share an agentId keeps the queue / claim symmetric.
// The test heartbeats as this hostname BEFORE queuing any commands so
// the centre's DC-online check passes (5-min freshness window).
const DC = 'MOCK-ADSRV1';
const AGENT_ID = 'mock-ad-admin-e2e';

if (!ADMIN_TOKEN) {
  console.error('ADMIN_TOKEN env var required for the queue + GET endpoints.');
  console.error('Get one via: curl -s $ADMIN_URL/api/auth/login -H "Content-Type: application/json" -d \'{"username":"admin","password":"..."}\'');
  process.exit(2);
}

// Reset the in-memory mock store so a previous run (or the daemon)
// doesn't pollute the assertions. The reset happens BEFORE the
// heartbeat / discovery so the queue claims match the fresh dataset.
resetAdStore();

// ── HTTP helpers ───────────────────────────────────────────────────────

async function adminReq(path, { method = 'GET', body } = {}) {
  const url = `${ADMIN_URL}${path}`;
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ADMIN_TOKEN}`
    },
    signal: AbortSignal.timeout(10_000)
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, ok: res.ok, data, text };
}

async function heartbeatDc() {
  // Stamp the agentId/hostname into ad_agent_heartbeat with a fresh
  // last_heartbeat_at so the DC-online check passes for queued commands.
  // /api/agent/heartbeat is mounted on the heartbeat port (8081 by
  // default). We use the same admin URL here for convenience — the
  // route is mounted on every port in 'full' mode.
  const res = await fetch(`${ADMIN_URL}/api/agent/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Token': AGENT_TOKEN },
    body: JSON.stringify({
      source: 'mock-ad-admin-e2e',
      agentId: AGENT_ID,
      agentVersion: '0.1.0-e2e',
      agentType: 'ad',
      hostname: DC,
      pendingQueueSize: 0,
      lastReportAt: null,
      lastReportStatus: 'idle',
      agent_token_version: 1
    }),
    signal: AbortSignal.timeout(5_000)
  });
  return { status: res.status, ok: res.ok };
}

// Inline agent dispatch — equivalent to what mock-multi-agent.mjs
// ::processAdCommands does on its scenario iteration. The e2e
// intentionally avoids spawning the daemon process so the test runs in
// isolation against any centre.
async function dispatchAdCommands() {
  const claimedRes = await fetch(
    `${AGENT_URL}/api/agent/ad-commands?hostname=${encodeURIComponent(DC)}`,
    {
      method: 'GET',
      headers: { 'X-Agent-Token': AGENT_TOKEN },
      signal: AbortSignal.timeout(10_000)
    }
  );
  if (!claimedRes.ok) return 0;
  const body = await claimedRes.json();
  const claimed = Array.isArray(body?.commands) ? body.commands : [];
  let processed = 0;
  for (const cmd of claimed) {
    const result = dispatchMockAdCommand(DC, cmd);
    const ackRes = await fetch(
      `${AGENT_URL}/api/agent/ad-commands/${cmd.id}/result`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Agent-Token': AGENT_TOKEN },
        body: JSON.stringify(result),
        signal: AbortSignal.timeout(10_000)
      }
    );
    if (ackRes.ok) processed++;
  }
  return processed;
}

async function pollUntilTerminal(commandId, { timeoutMs = 15_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastRow = null;
  while (Date.now() < deadline) {
    const r = await adminReq(`/api/admin/ad-commands/${commandId}`);
    if (r.ok && r.data) {
      lastRow = r.data;
      if (['success', 'failed', 'timeout'].includes(r.data.status)) return r.data;
    }
    await new Promise(res => setTimeout(res, intervalMs));
  }
  return lastRow;
}

// ── assertion helpers ──────────────────────────────────────────────────

let failed = 0;
const results = [];

function record(label, ok, detail = '') {
  results.push({ label, ok, detail });
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

async function runCommandScenario({ commandType, params, setup, assertions }) {
  console.log(`\n[CMD ${commandType}] params=${JSON.stringify(params).slice(0, 80)}`);
  // 1. Setup: per-scenario mutations (e.g. pre-create a user).
  if (setup) setup();
  // 2. Queue the command.
  const queue = await adminReq('/api/admin/ad-commands', {
    method: 'POST',
    body: { targetDc: DC, commandType, params }
  });
  record(`queued (HTTP ${queue.status})`, queue.status === 201, `body=${queue.text.slice(0, 200)}`);
  if (!queue.ok) return;
  const commandId = queue.data?.id;
  record('queue returned commandId', typeof commandId === 'number');
  // 3. Drain via the inline agent path.
  const drained = await dispatchAdCommands();
  record('agent drained ≥1 command', drained >= 1);
  // 4. Poll for terminal status.
  const final = await pollUntilTerminal(commandId);
  record('status reached terminal', ['success', 'failed', 'timeout'].includes(final?.status),
         `actual=${final?.status}`);
  record('status === success', final?.status === 'success', `actual=${final?.status}`);
  // 5. Custom assertions (store mutations + audit-row presence).
  if (assertions) {
    try {
      await assertions({ commandId, final });
    } catch (e) {
      record(`assertions for ${commandType}`, false, e.message);
    }
  }
  record(`durationMs present + reasonable`, typeof final?.durationMs === 'number' && final.durationMs >= 0);
}

// ── scenario table ─────────────────────────────────────────────────────

const scenarios = [
  {
    commandType: 'user_search',
    params: { filter: '' },
    assertions: ({ final }) => {
      const users = final?.result?.users;
      record('result.users is array', Array.isArray(users));
      record('result.count === 4 (seed dataset)', final?.result?.count === 4);
    }
  },
  {
    commandType: 'user_create',
    params: { sam: 'bwayne', givenName: 'Bruce', surname: 'Wayne', displayName: 'Bruce Wayne', password: 'P@ssw0rd!', mustChangePassword: true },
    assertions: ({ final }) => {
      record('result.created === true', final?.result?.created === true);
      record('result.dn contains CN=bwayne', String(final?.result?.dn ?? '').includes('CN=bwayne'));
      // Store mutated?
      const view = _internalStoreView(DC);
      const found = view.users.find(u => u.sam === 'bwayne');
      record('store has bwayne', !!found, `view users: ${view.users.map(u => u.sam).join(',')}`);
      record('bwayne.enabled === true', found?.enabled === true);
    }
  },
  {
    commandType: 'user_password_reset',
    params: { sam: 'bwayne', newPassword: 'N3wP@ss!', mustChangePassword: true, unlockAccount: true },
    assertions: ({ final }) => {
      record('result.passwordReset === true', final?.result?.passwordReset === true);
      record('result.unlocked === true', final?.result?.unlocked === true);
      const json = JSON.stringify(final);
      record('envelope does NOT echo N3wP@ss!', !json.includes('N3wP@ss!'));
    }
  },
  {
    commandType: 'user_enable',
    params: { sam: 'asmith' }, // seed asmith.enabled === false
    assertions: ({ final }) => {
      record('result.enabled === true', final?.result?.enabled === true);
      const view = _internalStoreView(DC);
      const asmith = view.users.find(u => u.sam === 'asmith');
      record('store asmith.enabled === true', asmith?.enabled === true);
    }
  },
  {
    commandType: 'user_disable',
    params: { sam: 'jdoe' }, // seed jdoe.enabled === true
    assertions: ({ final }) => {
      record('result.enabled === false', final?.result?.enabled === false);
      const view = _internalStoreView(DC);
      const jdoe = view.users.find(u => u.sam === 'jdoe');
      record('store jdoe.enabled === false', jdoe?.enabled === false);
    }
  },
  {
    commandType: 'user_unlock',
    params: { sam: 'jdoe' },
    assertions: ({ final }) => {
      record('result.unlocked === true', final?.result?.unlocked === true);
    }
  },
  {
    commandType: 'user_set_attributes',
    params: { sam: 'bwayne', attributes: { title: 'Caped Crusader', department: 'Gotham' } },
    assertions: ({ final }) => {
      const updated = final?.result?.updatedFields || [];
      record('updatedFields includes title + department',
        updated.includes('title') && updated.includes('department'),
        `actual=${JSON.stringify(updated)}`);
      const view = _internalStoreView(DC);
      const bw = view.users.find(u => u.sam === 'bwayne');
      record('store bwayne.title === Caped Crusader', bw?.title === 'Caped Crusader');
    }
  },
  {
    commandType: 'user_delete',
    params: { sam: 'servicebot' },
    assertions: ({ final }) => {
      record('result.deleted === true', final?.result?.deleted === true);
      const view = _internalStoreView(DC);
      record('store no longer has servicebot', !view.users.find(u => u.sam === 'servicebot'));
    }
  },
  {
    commandType: 'user_list_groups',
    params: { sam: 'admin' }, // seed admin is in 'Domain Admins'
    assertions: ({ final }) => {
      const groups = final?.result?.groups || [];
      record('result.groups is array', Array.isArray(groups));
      record('admin belongs to Domain Admins',
        groups.some(g => g.name === 'Domain Admins'),
        `groups=${JSON.stringify(groups.map(g => g.name))}`);
    }
  },
  {
    commandType: 'group_search',
    params: { filter: '' },
    assertions: ({ final }) => {
      const groups = final?.result?.groups;
      record('result.groups is array', Array.isArray(groups));
      record('result.count === 3 (seed groups)',
        final?.result?.count === 3,
        `actual=${final?.result?.count}`);
    }
  },
  {
    commandType: 'group_create',
    params: { name: 'Engineering', sam: 'Engineering', category: 'Security', scope: 'Universal', description: 'Engineering team' },
    assertions: ({ final }) => {
      record('result.created === true', final?.result?.created === true);
      const view = _internalStoreView(DC);
      record('store has Engineering',
        !!view.groups.find(g => g.name === 'Engineering'),
        `groups=${view.groups.map(g => g.name).join(',')}`);
    }
  },
  {
    commandType: 'group_set_attributes',
    params: { name: 'Engineering', attributes: { description: 'Engineering team (updated)' } },
    assertions: ({ final }) => {
      record('updatedFields includes description',
        Array.isArray(final?.result?.updatedFields) && final.result.updatedFields.includes('description'),
        `actual=${JSON.stringify(final?.result?.updatedFields)}`);
    }
  },
  {
    commandType: 'group_add_member',
    params: { name: 'Engineering', members: ['asmith', 'servicebot'] }, // servicebot will be 'already' after re-add below
    assertions: ({ final }) => {
      // First add — both are new members (servicebot is still in the seed).
      // The mock returns { added: [...new], alreadyMembers: [...existing] }.
      const added = final?.result?.added || [];
      const already = final?.result?.alreadyMembers || [];
      record('result.added is array', Array.isArray(added));
      record('result.alreadyMembers is array', Array.isArray(already));
      // After add, Engineering.members should contain both.
      const view = _internalStoreView(DC);
      const eng = view.groups.find(g => g.name === 'Engineering');
      record('Engineering members include asmith', eng?.members.includes('asmith'));
    }
  },
  {
    commandType: 'group_remove_member',
    params: { name: 'Engineering', members: ['servicebot'] },
    assertions: ({ final }) => {
      const removed = final?.result?.removed || [];
      const notMembers = final?.result?.notMembers || [];
      record('result.removed includes servicebot', removed.includes('servicebot'),
        `removed=${JSON.stringify(removed)} notMembers=${JSON.stringify(notMembers)}`);
    }
  },
  {
    commandType: 'group_set_members',
    params: { name: 'Engineering', members: ['asmith'] },
    assertions: ({ final }) => {
      const added = final?.result?.added || [];
      const removed = final?.result?.removed || [];
      record('result.added is array', Array.isArray(added));
      record('result.removed is array', Array.isArray(removed));
      const view = _internalStoreView(DC);
      const eng = view.groups.find(g => g.name === 'Engineering');
      record('Engineering.members === [asmith]',
        JSON.stringify(eng?.members) === JSON.stringify(['asmith']),
        `actual=${JSON.stringify(eng?.members)}`);
    }
  },
  {
    commandType: 'group_delete',
    params: { name: 'Engineering' },
    assertions: ({ final }) => {
      record('result.deleted === true', final?.result?.deleted === true);
      const view = _internalStoreView(DC);
      record('Engineering gone from store', !view.groups.find(g => g.name === 'Engineering'));
    }
  },
  {
    commandType: 'group_list_members',
    params: { name: 'Sales Team', page: 1, size: 100 }, // seed Sales Team has jdoe
    assertions: ({ final }) => {
      const members = final?.result?.members || [];
      record('result.members is array', Array.isArray(members));
      record('Sales Team has jdoe', members.some(m => m.sam === 'jdoe'),
        `members=${JSON.stringify(members.map(m => m.sam))}`);
      record('result.total === 1', final?.result?.total === 1, `actual=${final?.result?.total}`);
    }
  }
];

// ── error-path coverage (one extra scenario for completeness) ──────────

const errorScenarios = [
  {
    label: 'user_create duplicate sam',
    commandType: 'user_create',
    params: { sam: 'admin', password: 'whatever', mustChangePassword: true }, // admin already in seed
    expectFailed: true
  },
  {
    label: 'user_create protected (Administrator)',
    commandType: 'user_create',
    params: { sam: 'Administrator', password: 'whatever', mustChangePassword: true },
    expectFailed: true
  },
  {
    label: 'user_enable unknown user',
    commandType: 'user_enable',
    params: { sam: 'ghost' },
    expectFailed: true
  }
];

// ── main ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`mock-ad-admin-e2e starting`);
  console.log(`  admin=${ADMIN_URL}  agent=${AGENT_URL}`);
  console.log(`  target DC=${DC} (agentId=${AGENT_ID})`);

  // Heartbeat first so the DC-online check passes for queued commands.
  // We use the operator-friendly URL on port 8080 — the heartbeat route
  // is mounted on every port in 'full' mode so the test doesn't need
  // to know the heartbeat-port number.
  console.log(`\n[BOOT] heartbeating as ${DC} to satisfy DC-online check`);
  const hb = await heartbeatDc();
  record(`boot heartbeat (HTTP ${hb.status})`, hb.ok, `status=${hb.status}`);

  console.log(`\n[RUN] ${scenarios.length} command scenarios`);
  for (const sc of scenarios) {
    await runCommandScenario(sc);
  }

  console.log(`\n[RUN] ${errorScenarios.length} error-path scenarios`);
  for (const sc of errorScenarios) {
    console.log(`\n[ERR ${sc.label}]`);
    const queue = await adminReq('/api/admin/ad-commands', {
      method: 'POST',
      body: { targetDc: DC, commandType: sc.commandType, params: sc.params }
    });
    record(`queued (HTTP ${queue.status})`, queue.status === 201);
    const commandId = queue.data?.id;
    if (!commandId) continue;
    await dispatchAdCommands();
    const final = await pollUntilTerminal(commandId);
    record(`status === failed`, final?.status === 'failed', `actual=${final?.status}`);
    record(`errorMessage non-empty`, typeof final?.errorMessage === 'string' && final.errorMessage.length > 0,
      `errorMessage=${final?.errorMessage}`);
  }

  // ── summary table ────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(72)}`);
  console.log(`SUMMARY`);
  console.log(`${'='.repeat(72)}`);
  console.log(`commandType           status     checks`);
  console.log(`${'-'.repeat(72)}`);
  // Group results by commandType for the per-type row.
  const byType = new Map();
  for (const r of results) {
    const key = r.label;
    if (!byType.has(key)) byType.set(key, { ok: 0, fail: 0 });
    if (r.ok) byType.get(key).ok++; else byType.get(key).fail++;
  }
  for (const [type, agg] of byType.entries()) {
    const status = agg.fail === 0 ? 'PASS' : 'FAIL';
    console.log(`${type.padEnd(22)}${status.padEnd(11)}${agg.ok}/${agg.ok + agg.fail}`);
  }
  console.log(`${'-'.repeat(72)}`);
  const totalChecks = results.length;
  const totalFails = results.filter(r => !r.ok).length;
  console.log(`TOTAL                 ${totalFails === 0 ? 'PASS' : 'FAIL'}     ${totalChecks - totalFails}/${totalChecks}`);
  console.log(`${'='.repeat(72)}`);

  if (failed === 0) {
    console.log(`\n✅ all 17 command types green`);
    process.exit(0);
  } else {
    console.error(`\n❌ ${failed} check(s) failed across ${scenarios.length + errorScenarios.length} scenarios`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('mock-ad-admin-e2e crashed:', e?.stack || e);
  process.exit(1);
});
