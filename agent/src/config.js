import { readFileSync } from 'node:fs';

const REQUIRED = ['centerUrl', 'agentId', 'agentToken'];
const DEFAULTS = {
  logLevel: 'info',
  pollingIntervalMinutes: 15,
  heartbeatIntervalSeconds: 5,
  discoveryIntervalHours: 4,
  psDiscoveryScriptPath: 'C:\\addashboard\\Agent\\scripts\\collect-discovery.ps1',
  queueDbPath: 'C:\\addashboard\\Agent\\queue.db',
  agentDataDir: 'C:\\addashboard\\Agent\\data',
  powerShellPath: 'powershell.exe',
  psScriptPath: 'C:\\addashboard\\Agent\\scripts\\collect-replication.ps1',
  healthCheckIntervalMs: 600_000,
  // T16: agent type discriminator. 'ad' = DC-collector (legacy); 'non-ad'
  // = member-server heartbeat + self-register + per-host package fetch.
  // Default stays 'ad' so existing deployments keep working without a
  // config-file change.
  agentType: 'ad',
  // 2026-08-15 port-scanning bootstrap (spec §3):
  // centerHost: scan target (default = derive from centerUrl hostname).
  // scanOnBoot: trigger discovery if first fetchConfig fails on startup.
  // scanOnRuntimeFail: trigger discovery after N consecutive runtime failures.
  // scanFailureThreshold: runtime failures before scan triggers.
  centerHost: '',
  scanOnBoot: true,
  scanOnRuntimeFail: true,
  scanFailureThreshold: 5,
  // 2026-08-21 UX redesign (auto-delivery): the agent's last-seen
  // agent_token_version. Sent on every heartbeat; the centre replies with
  // a newer agentToken when its own version has been bumped. Default 0 =
  // fresh-install (matches a server that has never rotated; if the server
  // HAS rotated and the agent is on version 0, the next heartbeat will
  // immediately deliver the live token). Persistent so the agent doesn't
  // re-request the same credential after a restart.
  agentTokenVersion: 0
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