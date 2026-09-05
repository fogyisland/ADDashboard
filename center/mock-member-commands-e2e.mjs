// 2026-09-05 R81 — end-to-end exercise of the member-server PowerShell
// command chain against a live centre. Drives every wire the real agent
// will drive so the operator can sanity-check the full lifecycle without
// standing up a real Windows agent.
//
// Mirrors the structure of mock-ad-admin-e2e.mjs (R75) but for the
// member-script surface: queue → agent claim → dispatch → ack →
// pollUntilTerminal → assert audit + result blob.
//
// Scenarios covered:
//   1. Get-Date happy path — script runs, returns ISO date, success
//   2. Get-Host — script returns a mock host payload
//   3. whoami — returns MOCK\<hostname>
//   4. danger pattern (Remove-Item -Recurse) — fails with explicit error
//   5. script-size cap — POST 33KB → 400 with 'exceeds' message
//   6. timeoutSec out-of-range — POST 1s → 400
//   7. offline hostname — POST 503 with lastHeartbeatAt
//   8. list + single endpoints — read-back of the queued history
//
// Usage:
//   ADMIN_TOKEN=... AGENT_TOKEN=... node mock-member-commands-e2e.mjs

import { dispatchMockMemberCommand, memberLog, resetMemberLog } from './mock-member-commands.mjs';

const ADMIN_URL  = process.env.ADMIN_URL  ?? 'http://127.0.0.1:8080';
const AGENT_URL  = process.env.AGENT_URL  ?? 'http://127.0.0.1:8080';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const AGENT_TOKEN = process.env.AGENT_TOKEN ?? '973d8e916d1e6ee3e08e43751515c2e71abac9f4ee3abc6e295a5a154894f5ecd12742a837a22b7ac43fbf0a34c5a1c6';

const HOST = 'MOCK-MEMBER-E2E-1';
const AGENT_ID = 'mock-member-commands-e2e';

if (!ADMIN_TOKEN) {
  console.error('ADMIN_TOKEN env var required for the queue + GET endpoints.');
  console.error('Get one via: curl -s $ADMIN_URL/api/auth/login -H "Content-Type: application/json" -d \'{"username":"admin","password":"..."}\'');
  process.exit(2);
}

resetMemberLog();

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

async function heartbeatHost() {
  // Stamp the hostname into ad_agent_heartbeat so the centre's
  // hostname-online check passes for queued commands (5-min freshness
  // window). The agentId IS the hostname for member-server agents.
  const res = await fetch(`${ADMIN_URL}/api/agent/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Token': AGENT_TOKEN },
    body: JSON.stringify({
      source: 'mock-member-commands-e2e',
      agentId: AGENT_ID,
      agentVersion: '0.1.0-e2e',
      agentType: 'member',
      hostname: HOST,
      pendingQueueSize: 0,
      lastReportAt: null,
      lastReportStatus: 'idle',
      agent_token_version: 1
    }),
    signal: AbortSignal.timeout(5_000)
  });
  return { status: res.status, ok: res.ok };
}

// Inline agent dispatch — drains the queue using dispatchMockMemberCommand.
async function dispatchMemberCommands() {
  const claimedRes = await fetch(
    `${AGENT_URL}/api/agent/member-commands?hostname=${encodeURIComponent(HOST)}`,
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
    const result = dispatchMockMemberCommand(HOST, cmd);
    const ackRes = await fetch(
      `${AGENT_URL}/api/agent/member-commands/${cmd.id}/result`,
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
    const r = await adminReq(`/api/admin/member-commands/${commandId}`);
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

// ── scenario table ─────────────────────────────────────────────────────

async function runScenario({ label, params, expectStatus, expectQueueStatus, assertions }) {
  console.log(`\n[SCENARIO ${label}] params=${JSON.stringify(params).slice(0, 80)}`);
  const queue = await adminReq('/api/admin/member-commands', {
    method: 'POST',
    body: { hostname: HOST, params }
  });
  record(`queue returned ${expectQueueStatus}`, queue.status === expectQueueStatus, `body=${queue.text.slice(0, 200)}`);
  if (!queue.ok) {
    if (assertions) assertions({ final: null, queue });
    return;
  }
  const commandId = queue.data?.id;
  record('queue returned commandId', typeof commandId === 'number');
  const drained = await dispatchMemberCommands();
  record('agent drained ≥1 command', drained >= 1, `drained=${drained}`);
  const final = await pollUntilTerminal(commandId);
  record(`status reached ${expectStatus}`, final?.status === expectStatus, `actual=${final?.status}`);
  if (assertions) {
    try {
      await assertions({ commandId, final, queue });
    } catch (e) {
      record(`assertions for ${label}`, false, e.message);
    }
  }
}

// ── main ───────────────────────────────────────────────────────────────

async function main() {
  console.log('mock-member-commands-e2e.mjs — member-server PowerShell queue E2E');
  console.log(`  ADMIN_URL  = ${ADMIN_URL}`);
  console.log(`  HOST       = ${HOST}`);

  // Stamp the hostname as live so queue-online checks pass.
  const hb = await heartbeatHost();
  console.log(`  heartbeat  → HTTP ${hb.status}`);

  // 1. Get-Date happy path.
  await runScenario({
    label: 'Get-Date happy path',
    params: { script: 'Get-Date', timeoutSec: 10 },
    expectQueueStatus: 201,
    expectStatus: 'success',
    assertions: ({ final }) => {
      record('result.exitCode === 0', final?.result?.exitCode === 0);
      record('result.stdout is ISO date string',
        typeof final?.result?.stdout === 'string' &&
        /^\d{4}-\d{2}-\d{2}T/.test(final.result.stdout),
        `stdout=${final?.result?.stdout}`);
      record('result.durationMs is positive number', typeof final?.durationMs === 'number' && final.durationMs >= 0);
    }
  });

  // 2. Get-Host — returns the mock host payload.
  await runScenario({
    label: 'Get-Host returns mock host',
    params: { script: 'Get-Host', timeoutSec: 10 },
    expectQueueStatus: 201,
    expectStatus: 'success',
    assertions: ({ final }) => {
      const stdout = String(final?.result?.stdout ?? '');
      record('stdout includes MOCK-MEMBER-HOST', stdout.includes('MOCK-MEMBER-HOST'),
        `stdout=${stdout}`);
    }
  });

  // 3. whoami — returns MOCK\<hostname>.
  await runScenario({
    label: 'whoami returns MOCK\\hostname',
    params: { script: 'whoami', timeoutSec: 10 },
    expectQueueStatus: 201,
    expectStatus: 'success',
    assertions: ({ final }) => {
      record('stdout is MOCK\\MOCK-MEMBER-E2E-1',
        String(final?.result?.stdout ?? '').includes('MOCK-MEMBER-E2E-1'));
    }
  });

  // 4. Danger pattern (Remove-Item -Recurse) — fails with explicit error.
  await runScenario({
    label: 'danger pattern blocks Remove-Item -Recurse',
    params: { script: 'Remove-Item C:\\temp -Recurse', timeoutSec: 10 },
    expectQueueStatus: 201,
    expectStatus: 'failed',
    assertions: ({ final }) => {
      record('result.exitCode !== 0', final?.result?.exitCode !== 0);
      record('error message mentions blocked', /blocked/.test(String(final?.errorMessage ?? '')),
        `errorMessage=${final?.errorMessage}`);
    }
  });

  // 5. Script-size cap — POST 33KB → 400.
  await runScenario({
    label: 'script size cap (33KB → 400)',
    params: { script: 'x'.repeat(33 * 1024), timeoutSec: 10 },
    expectQueueStatus: 400,
    expectStatus: 'queued', // never reached
    assertions: ({ queue }) => {
      record('400 error mentions exceeds', /exceeds/.test(String(queue?.data?.error ?? '')));
    }
  });

  // 6. TimeoutSec out of range — POST 1s → 400.
  await runScenario({
    label: 'timeoutSec out of range (1s → 400)',
    params: { script: 'Get-Date', timeoutSec: 1 },
    expectQueueStatus: 400,
    expectStatus: 'queued',
    assertions: ({ queue }) => {
      record('400 error mentions timeoutSec', /timeoutSec/.test(String(queue?.data?.error ?? '')));
    }
  });

  // 7. Offline hostname — POST to OFFLINE → 503.
  console.log(`\n[SCENARIO offline hostname → 503]`);
  const offRes = await adminReq('/api/admin/member-commands?force=true', {
    method: 'POST',
    body: { hostname: 'OFFLINE-NO-AGENT', params: { script: 'Get-Date' } }
  });
  // Force=true bypasses the online check, so this should be 201.
  record('?force=true against offline host still queues', offRes.status === 201,
    `body=${offRes.text.slice(0, 200)}`);
  // Now without ?force=true → 503.
  const offRes2 = await adminReq('/api/admin/member-commands', {
    method: 'POST',
    body: { hostname: 'OFFLINE-NO-AGENT', params: { script: 'Get-Date' } }
  });
  record('no-force against offline host returns 503', offRes2.status === 503,
    `body=${offRes2.text.slice(0, 200)}`);
  record('503 body has lastHeartbeatAt field',
    offRes2.data && Object.prototype.hasOwnProperty.call(offRes2.data, 'lastHeartbeatAt'));

  // 8. List endpoint returns the queued history.
  console.log(`\n[SCENARIO list endpoint]`);
  const list = await adminReq(`/api/admin/member-commands?hostname=${encodeURIComponent(HOST)}`);
  record('list returned 200', list.status === 200);
  record('list.total >= 3 (3 happy paths)', list.data?.total >= 3, `total=${list.data?.total}`);
  record('list rows for our host', Array.isArray(list.data?.rows) && list.data.rows.length >= 3);

  // 9. Host picker — /hosts returns the heartbeating agent.
  console.log(`\n[SCENARIO hosts list endpoint]`);
  const hosts = await adminReq('/api/admin/member-commands/hosts');
  record('hosts returned 200', hosts.status === 200);
  record('hosts is array', Array.isArray(hosts.data?.hosts));
  record('hosts includes our MOCK-MEMBER-E2E-1',
    Array.isArray(hosts.data?.hosts) && hosts.data.hosts.some(h => h.hostname === 'MOCK-MEMBER-E2E-1'),
    `hosts=${JSON.stringify(hosts.data?.hosts?.map(h => h.hostname))}`);

  // ── summary ─────────────────────────────────────────────────────────
  console.log(`\n--- summary ---`);
  console.log(`  memberLog entries: ${memberLog.length}`);
  const passed = results.filter(r => r.ok).length;
  console.log(`  ${passed} / ${results.length} assertions passed`);
  if (failed > 0) {
    console.error(`\nFAIL: ${failed} assertion(s) failed.`);
    process.exit(1);
  }
  console.log('\nPASS');
  process.exit(0);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});