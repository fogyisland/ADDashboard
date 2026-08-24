import { spawnSync } from 'node:child_process';
import net from 'node:net';

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

async function checkCenter(centerUrl, agentToken, heartbeatPort = undefined) {
  // 2026-08-24 round-9: replaced the previous `postHeartbeat({ agentId:
  // '__healthcheck__' })` probe with a plain TCP probe. The synthetic
  // heartbeat was writing a row to ad_agent_heartbeat every
  // healthCheckIntervalMs (default 600_000 = 10 min), which the heartbeat
  // monitor surfaced as an "offline agent" — the dashboard's stale
  // threshold is 60s but the synthetic probe cadence is 10min, so this
  // row always displayed 掉线 and confused operators. The real 5s
  // heartbeat already proves center reachability; a separate
  // upserting probe is redundant and misleading.
  try {
    const url = new URL(centerUrl);
    // Prefer the explicit heartbeatPort when provided (the agent
    // discovers it from /api/agent/ports at boot); fall back to
    // centerUrl's port; default to 80 if neither is set (e.g.,
    // http://center.example with no port).
    let port;
    if (heartbeatPort) {
      port = Number(heartbeatPort);
    } else if (url.port) {
      port = Number(url.port);
    } else {
      port = 80;
    }
    const r = await tcpProbe(url.hostname, port, 2000);
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
export async function runHealthChecks({ centerUrl, agentToken, hostname, heartbeatPort = undefined, ports = [] }) {
  const adModule = checkAdModule();
  const domain = checkDomain();
  const center = await checkCenter(centerUrl, agentToken, heartbeatPort);

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
