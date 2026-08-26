// mock-discover.mjs — POST /api/agent/discover with a mock DC payload so the
// center upserts the DC into ad_dcs and runs any discovery-side effects.

const CENTER_URL = process.env.CENTER_URL ?? 'http://127.0.0.1:8082';
const AGENT_TOKEN = process.env.AGENT_TOKEN ?? '973d8e916d1e6ee3e08e43751515c2e71abac9f4ee3abc6e295a5a154894f5ecd12742a837a22b7ac43fbf0a34c5a1c6';
const AGENT_ID = process.env.AGENT_ID ?? 'MOCK-AGENT-001';
const SOURCE = process.env.SOURCE ?? 'mock-script';

const collectedAt = new Date().toISOString();

const dc = {
  name: 'MOCK-DC-01',
  hostname: 'mock-dc-01.fake.local',
  ipAddress: '10.0.0.10',
  osVersion: 'Windows Server 2022 (mock)',
  site: 'MOCK-SITE',
  isPdc: true,
  roles: ['DomainController', 'PDCEmulator', 'RIDMaster', 'InfrastructureMaster']
};

const body = { source: SOURCE, agentId: AGENT_ID, collectedAt, dc };

const res = await fetch(`${CENTER_URL}/api/agent/discover`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Agent-Token': AGENT_TOKEN, 'X-Agent-Id': AGENT_ID },
  body: JSON.stringify(body)
});

console.log(`HTTP ${res.status}`);
console.log(await res.text());