import { spawnSync } from 'node:child_process';
import { postHeartbeat } from './reporter.js';

function checkAdModule() {
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', 'Get-Module -ListAvailable ActiveDirectory | Select-Object -First 1'],
    { encoding: 'utf8' }
  );
  return r.status === 0 && /ActiveDirectory/.test(r.stdout || '');
}

function checkDomain() {
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `try { [System.DirectoryServices.ActiveDirectory.Domain]::GetComputerDomain() | Out-Null; 'OK' } catch { 'FAIL' }`],
    { encoding: 'utf8' }
  );
  return /OK/.test(r.stdout || '');
}

async function checkCenter(centerUrl, agentToken) {
  try {
    const r = await postHeartbeat({ centerUrl, agentToken, payload: { agentId: '__healthcheck__' } });
    return r.ok;
  } catch {
    return false;
  }
}

// Note: the plan's interface block listed a `logger` parameter but the impl
// snippet does not use it. We follow the impl snippet — logger is intentionally
// omitted; errors here are swallowed silently.
export async function runHealthChecks({ centerUrl, agentToken, hostname }) {
  const adModule = checkAdModule();
  const domain = checkDomain();
  const center = await checkCenter(centerUrl, agentToken);
  return { ok: adModule && domain && center, checks: { adModule, domain, center, hostname } };
}