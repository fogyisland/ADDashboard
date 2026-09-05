import { spawn } from 'node:child_process';
import { requestJson } from './reporter.js';

export function runDiscovery({ powerShellPath, psDiscoveryScriptPath, logger }) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(powerShellPath, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psDiscoveryScriptPath], { windowsHide: true });
    // 2026-08-24 round-9: defense-in-depth — explicit UTF-8 decode so even
    // if a future PS script forgets [Console]::OutputEncoding = UTF-8,
    // mojibake doesn't silently corrupt discovery payloads / error logs.
    // The PS-side fix at the top of collect-discovery.ps1 + collect-
    // replication.ps1 is the root cause fix; this is the safety net.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', c => stdout += c);
    child.stderr.on('data', c => stderr += c);
    child.on('error', (e) => {
      // 2026-08-24 round-9: don't swallow spawn failures silently. They
      // mean the agent can't run PS at all — without this log, the DC
      // list stays empty and the operator has no clue why.
      if (logger) logger.warn({ err: e.message }, 'discovery ps spawn failed; ad_dcs row not written');
      resolve(null);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        if (logger) logger.warn({
          err: `discovery ps exit ${code}`,
          stderr: stderr.trim().slice(0, 500),
          stdout: stdout.trim().slice(0, 200)
        }, 'discovery ps failed; ad_dcs row not written');
        return resolve(null);
      }
      try {
        const obj = JSON.parse(stdout.trim());
        resolve(obj);
      } catch (e) {
        if (logger) logger.warn({
          err: e.message,
          stderr: stderr.trim().slice(0, 500),
          stdout: stdout.trim().slice(0, 500)
        }, 'discovery ps stdout not parseable; ad_dcs row not written');
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
    body: { source: 'collect-discovery', ...payload },
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
  // 2026-08-25 round-12 report-now fan-out: expose `run` so the heartbeat
  // callback can invoke discovery on demand when the operator clicks 回报.
  // Same try/catch + logger pattern as the periodic tick so a synchronous
  // throw inside run() doesn't propagate to the heartbeat callback.
  // Caller's run() already includes its own success/failure logging (PS
  // spawn failure at agent.js:266-281) — this is just the safety net for
  // an unexpected JS throw outside the PS-spawn path.
  const runNow = async () => {
    if (stopped) return;
    try { await run(); }
    catch (e) { if (logger) logger.warn({ err: e.message, triggeredBy: 'report-now' }, 'discovery on-demand failed'); }
  };
  return {
    stop() { stopped = true; clearInterval(h); },
    run: runNow
  };
}
