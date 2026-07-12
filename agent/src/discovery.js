import { spawn } from 'node:child_process';
import http from 'node:http';

export function runDiscovery({ powerShellPath, psDiscoveryScriptPath }) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(powerShellPath, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psDiscoveryScriptPath], { windowsHide: true });
    child.stdout.on('data', c => stdout += c);
    child.stderr.on('data', c => stderr += c);
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) return resolve(null);
      try {
        const obj = JSON.parse(stdout.trim());
        resolve(obj);
      } catch {
        resolve(null);
      }
    });
  });
}

export function postDiscovery({ centerUrl, agentToken, payload }) {
  return new Promise((resolve) => {
    const url = new URL(`${centerUrl}/api/agent/discover`);
    const body = JSON.stringify(payload);
    const req = http.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Agent-Token': agentToken
      },
      timeout: 30000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { return resolve({ ok: true, status: res.statusCode, data: JSON.parse(data) }); }
          catch { return resolve({ ok: true, status: res.statusCode, data: null }); }
        }
        try { return resolve({ ok: false, status: res.statusCode, data: JSON.parse(data) }); }
        catch { return resolve({ ok: false, status: res.statusCode }); }
      });
    });
    req.on('error', err => resolve({ ok: false, status: 0, error: err.message }));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(body);
    req.end();
  });
}

export function startDiscoveryScheduler({ intervalHours, run, logger }) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try { await run(); }
    catch (e) { if (logger) logger.warn({ err: e.message }, 'discovery cycle failed'); }
  };
  tick();
  const ms = Math.max(1, intervalHours) * 3_600_000;
  const h = setInterval(tick, ms);
  return { stop() { stopped = true; clearInterval(h); } };
}
