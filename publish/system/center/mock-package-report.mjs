// mock-package-report.mjs — posts one /api/agent/packages/report batch with
// mock metric payloads for all 3 v2 built-ins. Uses the underscored names
// that package_scripts + package_policies rows are keyed by (the
// manifest's display name uses dashes but the row name uses underscores).

const CENTER_URL = process.env.CENTER_URL ?? 'http://127.0.0.1:8080';
const AGENT_TOKEN = process.env.AGENT_TOKEN ?? '973d8e916d1e6ee3e08e43751515c2e71abac9f4ee3abc6e295a5a154894f5ecd12742a837a22b7ac43fbf0a34c5a1c6';
const AGENT_ID = process.env.AGENT_ID ?? 'MOCK-AGENT-001';
const SOURCE = process.env.SOURCE ?? 'mock-script';

const now = new Date().toISOString();

const runs = [
  {
    packageName: 'ad_os_baseline',
    startedAt: now,
    finishedAt: now,
    exitCode: 0,
    metrics: {
      cpu_pct: 35.2,
      memory_pct: 58.7,
      disk_free: JSON.stringify({ C: 80, D: 100 }),
      disk_total: JSON.stringify({ C: 200, D: 500 }),
      services: JSON.stringify({ spooler: 'Running', w32time: 'Running' }),
      events: JSON.stringify({ System: 12, Application: 3 })
    }
  },
  {
    packageName: 'ad_local_port_check',
    startedAt: now,
    finishedAt: now,
    exitCode: 0,
    metrics: {
      port_135: JSON.stringify({ reachable: true, latencyMs: 1, error: null }),
      port_445: JSON.stringify({ reachable: true, latencyMs: 2, error: null }),
      port_50001: JSON.stringify({ reachable: true, latencyMs: 4, error: null }),
      port_50002: JSON.stringify({ reachable: false, latencyMs: null, error: 'timeout' }),
      port_50003: JSON.stringify({ reachable: true, latencyMs: 3, error: null })
    }
  },
  {
    packageName: 'ad_domain_consistency',
    startedAt: now,
    finishedAt: now,
    exitCode: 0,
    metrics: {
      user_count: 1248,
      user_hash: 'a'.repeat(64),
      group_count: 312,
      group_hash: 'b'.repeat(64),
      gpo_count: 47,
      gpo_hash: 'c'.repeat(64),
      error_code: 0
    }
  }
];

const body = { source: SOURCE, runs };

const res = await fetch(`${CENTER_URL}/api/agent/packages/report`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Agent-Token': AGENT_TOKEN,
    'X-Agent-Id': AGENT_ID
  },
  body: JSON.stringify(body)
});

const text = await res.text();
console.log(`HTTP ${res.status}`);
console.log(text);