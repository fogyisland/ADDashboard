// mock-heartbeat.mjs — minimal mock agent: posts heartbeats to center every
// 5s using the same X-Agent-Token as the real agent. Lets #427 + post-restart
// verification run end-to-end without requiring the real agent process.
//
// NOT a long-running replacement for the real agent — just a stopgap so the
// runAllNow / package ingestion paths can be exercised against a live center.

const CENTER_URL = process.env.CENTER_URL ?? 'http://127.0.0.1:8081';
// Token must match `system_config.agent_token_current` in the DB (the
// authoritative source for agent auth). appsettings.json's `agentToken` is
// only used at install/init; the running center reads from DB.
const AGENT_TOKEN = process.env.AGENT_TOKEN ?? '973d8e916d1e6ee3e08e43751515c2e71abac9f4ee3abc6e295a5a154894f5ecd12742a837a22b7ac43fbf0a34c5a1c6';
const AGENT_ID = process.env.AGENT_ID ?? 'MOCK-AGENT-001';
const HOSTNAME = process.env.HOSTNAME ?? process.env.COMPUTERNAME ?? 'DESKTOP-MOCK';
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 5000);

let stopped = false;
let beatCount = 0;

async function sendHeartbeat() {
  beatCount += 1;
  const body = {
    source: 'heartbeat',
    agentId: AGENT_ID,
    agentVersion: '0.1.0-mock',
    agentType: 'non-ad',
    hostname: HOSTNAME,
    ports: [],
    pendingQueueSize: 0,
    lastReportAt: null,
    lastReportStatus: 'idle',
    agent_token_version: 1
    // Intentionally omit `report_requested_at` so the route hits the UPSERT
    // path (which bumps last_heartbeat_at) instead of the clearReportRequest
    // path (which only clears the flag and leaves the heartbeat untouched).
  };
  try {
    const res = await fetch(`${CENTER_URL}/api/agent/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Token': AGENT_TOKEN
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000)
    });
    const text = await res.text();
    const ts = new Date().toISOString();
    console.log(`[${ts}] heartbeat #${beatCount} → HTTP ${res.status} body=${text.slice(0, 200)}`);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] heartbeat #${beatCount} ERROR: ${e.message}`);
  }
}

async function main() {
  console.log(`mock-heartbeat starting`);
  console.log(`  center = ${CENTER_URL}`);
  console.log(`  agentId = ${AGENT_ID}`);
  console.log(`  token = ${AGENT_TOKEN.slice(0, 8)}...`);
  console.log(`  interval = ${INTERVAL_MS}ms`);
  await sendHeartbeat();
  const timer = setInterval(async () => {
    if (stopped) return;
    await sendHeartbeat();
  }, INTERVAL_MS);
  process.on('SIGINT', () => {
    console.log('SIGINT, stopping...');
    stopped = true;
    clearInterval(timer);
    process.exit(0);
  });
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });