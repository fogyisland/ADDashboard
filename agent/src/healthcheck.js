import { spawnSync } from 'node:child_process';
import net from 'node:net';
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

// TCP-connect probe with a hard timeout. Resolves with {port, ok, latencyMs}
// regardless of outcome -- never throws. A successful TCP handshake = ok:true.
export function tcpProbe(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = new net.Socket();
    let done = false;
    const finish = (ok, latencyMs) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve({ port, ok, latencyMs });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true, Date.now() - start));
    sock.once('timeout', () => finish(false, timeoutMs));
    sock.once('error', () => finish(false, Date.now() - start));
    try {
      sock.connect(port, host);
    } catch {
      finish(false, 0);
    }
  });
}

// Note: the plan's interface block listed a `logger` parameter but the impl
// snippet does not use it. We follow the impl snippet — logger is intentionally
// omitted; errors here are swallowed silently.
export async function runHealthChecks({ centerUrl, agentToken, hostname, ports = [] }) {
  const adModule = checkAdModule();
  const domain = checkDomain();
  const center = await checkCenter(centerUrl, agentToken);

  // Probe all ports concurrently; bounded at 2s wall time regardless of count.
  const probes = await Promise.all(
    (ports || []).map(p => tcpProbe('127.0.0.1', Number(p), 2000))
  );

  return {
    ok: adModule && domain && center,
    checks: { adModule, domain, center, hostname },
    ports: probes
  };
}
