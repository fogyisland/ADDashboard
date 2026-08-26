// mock-replication.mjs — POST /api/agent/report with a mock replication
// snapshot. Includes:
//   - 1 __dc_summary__ row (the per-DC 5-counter summary)
//   - 3 __partner_ports__:<host> rows (round-13 partner-port probes)
//   - 1 fake lockout event for Security 4740

const CENTER_URL = process.env.CENTER_URL ?? 'http://127.0.0.1:8082';
const AGENT_TOKEN = process.env.AGENT_TOKEN ?? '973d8e916d1e6ee3e08e43751515c2e71abac9f4ee3abc6e295a5a154894f5ecd12742a837a22b7ac43fbf0a34c5a1c6';
const AGENT_ID = process.env.AGENT_ID ?? 'MOCK-AGENT-001';
const SOURCE = process.env.SOURCE ?? 'collect-replication-mock';

const collectedAt = new Date().toISOString();

// Round-13 ad_replication_status row shape (16 columns + partner_port_status):
//   source_dc, dest_dc, naming_context, status_code, last_success_time,
//   last_attempt_time, last_failure_reason, failure_count,
//   users_count, groups_count, gpos_count, locked_count,
//   partner_port_status (JSON), ...
// We mirror whatever the real collect-replication.ps1 emits.
const okPortSummary = JSON.stringify({
  port_135: { reachable: true, latencyMs: 1 },
  port_445: { reachable: true, latencyMs: 2 },
  port_50001: { reachable: true, latencyMs: 4 },
  port_50002: { reachable: false, latencyMs: null, error: 'timeout' },
  port_50003: { reachable: true, latencyMs: 3 }
});
const okPortStatus = 0;
const failPortStatus = 1;

const data = [
  {
    sourceDc: AGENT_ID,
    destDc: 'MOCK-DC-02',
    namingContext: '__partner_ports__:MOCK-DC-02',
    statusCode: okPortStatus,
    lastSuccessTime: collectedAt,
    lastAttemptTime: collectedAt,
    lastFailureReason: null,
    failureCount: 0,
    usersCount: null,
    groupsCount: null,
    gposCount: null,
    lockedCount: null,
    partnerPortStatus: okPortSummary
  },
  {
    sourceDc: AGENT_ID,
    destDc: 'MOCK-DC-03',
    namingContext: '__partner_ports__:MOCK-DC-03',
    statusCode: failPortStatus,
    lastSuccessTime: null,
    lastAttemptTime: collectedAt,
    lastFailureReason: 'port_50002 unreachable',
    failureCount: 3,
    usersCount: null,
    groupsCount: null,
    gposCount: null,
    lockedCount: null,
    partnerPortStatus: okPortSummary
  },
  {
    sourceDc: AGENT_ID,
    destDc: '__dc_summary__',
    namingContext: '__dc_summary__',
    statusCode: 0,
    lastSuccessTime: collectedAt,
    lastAttemptTime: collectedAt,
    lastFailureReason: null,
    failureCount: 0,
    usersCount: 1248,
    groupsCount: 312,
    gposCount: 47,
    lockedCount: 1,
    partnerPortStatus: null
  }
];

const lockoutEvents = [
  {
    occurredAt: new Date(Date.now() - 60_000).toISOString(),
    eventRecordId: 9001,
    targetUserName: 'alice',
    subjectUserName: 'admin01',
    subjectDomain: 'FAKE',
    callerComputerName: 'workstation-7'
  }
];

const body = { source: SOURCE, agentId: AGENT_ID, collectedAt, data, lockoutEvents };

const res = await fetch(`${CENTER_URL}/api/agent/report`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Agent-Token': AGENT_TOKEN, 'X-Agent-Id': AGENT_ID },
  body: JSON.stringify(body)
});

console.log(`HTTP ${res.status}`);
console.log(await res.text());