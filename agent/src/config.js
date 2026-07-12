import { readFileSync } from 'node:fs';

const REQUIRED = ['centerUrl', 'agentId', 'agentToken'];
const DEFAULTS = {
  logLevel: 'info',
  pollingIntervalMinutes: 15,
  heartbeatIntervalSeconds: 5,
  discoveryIntervalHours: 4,
  psDiscoveryScriptPath: 'C:\\Program Files\\ADDashboard\\Agent\\scripts\\collect-discovery.ps1',
  queueDbPath: 'C:\\ProgramData\\ADDashboard\\Agent\\queue.db',
  powerShellPath: 'powershell.exe',
  psScriptPath: 'C:\\Program Files\\ADDashboard\\Agent\\scripts\\collect-replication.ps1',
  healthCheckIntervalMs: 600_000
};

export function loadConfig(path) {
  const raw = readFileSync(path, 'utf8');
  const cfg = JSON.parse(raw);
  const missing = REQUIRED.filter(
    (k) => cfg[k] === undefined || cfg[k] === null || cfg[k] === ''
  );
  if (missing.length > 0) {
    throw new Error(`agent config missing required key(s): ${missing.join(', ')}`);
  }
  return { ...DEFAULTS, ...cfg };
}