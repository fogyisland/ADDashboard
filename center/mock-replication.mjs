// mock-replication.mjs — POST /api/agent/report with a mock replication
// snapshot. Round-24 refactor: instead of hand-rolling the camelCase
// data[] shape (which silently drifted from the real collect-replication.ps1
// each time the agent added/removed a field), this now produces the EXACT
// PascalCase shape that PS1 emits and lets agent/src/reporter.js's
// postReport() handle the camelCase conversion. Future reporter changes
// are picked up automatically.

import { buildSnapshot, postSnapshot } from './mock-snapshot.mjs';

const CENTER_URL = process.env.CENTER_URL ?? 'http://127.0.0.1:8082';
const AGENT_TOKEN = process.env.AGENT_TOKEN ?? '973d8e916d1e6ee3e08e43751515c2e71abac9f9ee3abc6e295a5a154894f5ecd12742a837a22b7ac43fbf0a34c5a1c6';
const AGENT_ID = process.env.AGENT_ID ?? 'MOCK-AGENT-001';

// Round-13 ad_replication_status row shape (16 columns + partner_port_status):
//   source_dc, dest_dc, naming_context, status_code, last_success_time,
//   last_attempt_time, last_failure_reason, failure_count,
//   users_count, groups_count, gpos_count, locked_count,
//   partner_port_status (JSON), ...
// PascalCase shape mirrors collect-replication.ps1's ConvertTo-Json -Depth 6
// output exactly. reporter.toCamelEntry handles field-name conversion.
const okPortSummary = JSON.stringify({
  port_135: { reachable: true, latencyMs: 1 },
  port_445: { reachable: true, latencyMs: 2 },
  port_50001: { reachable: true, latencyMs: 4 },
  port_50002: { reachable: false, latencyMs: null, error: 'timeout' },
  port_50003: { reachable: true, latencyMs: 3 }
});

const collectedAt = new Date().toISOString();

const snapshot = buildSnapshot({
  agentId: AGENT_ID,
  collectedAt,
  sourceSite: 'MOCK-SITE',
  links: [
    {
      destDc: 'MOCK-DC-02',
      namingContext: '__partner_ports__:MOCK-DC-02',
      statusCode: 0,
      partnerPortStatus: okPortSummary
    },
    {
      destDc: 'MOCK-DC-03',
      namingContext: '__partner_ports__:MOCK-DC-03',
      statusCode: 1,
      errorMessage: 'port_50002 unreachable',
      partnerPortStatus: okPortSummary
    }
  ]
});

// 2026-08-26 round-18: lockout data moved to its own packages
// (ad_lockout_summary + ad_lockout_list). The replication snapshot no
// longer carries lockoutEvents or LockedCount — those arrive via the
// package ingest path on a 15-minute cadence. mock-snapshot.mjs already
// emits LockedCount: null on __dc_summary__.

const res = await postSnapshot({
  centerUrl: CENTER_URL,
  agentToken: AGENT_TOKEN,
  snapshot
});

console.log(`HTTP ${res.status}`);
console.log(JSON.stringify(res.data ?? res, null, 2));