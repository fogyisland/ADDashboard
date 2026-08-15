import { spawn } from 'node:child_process';
import { requestJson } from './reporter.js';

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
  return requestJson({
    method: 'POST',
    url: `${centerUrl}/api/agent/discover`,
    headers: { 'X-Agent-Token': agentToken },
    body: payload,
    timeoutMs: 30000
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
