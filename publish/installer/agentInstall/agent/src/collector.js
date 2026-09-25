import { spawn } from 'node:child_process';
// 2026-09-25 R93 — diagnostic logging for the PS-collect path. runCollector
// was completely silent: a stuck / failed / parse-error snapshot would only
// surface as the absence of a /api/agent/report call downstream. Each leg
// of the spawn lifecycle now logs at info / error so the operator can
// pinpoint where the gap is — script missing, script crashed, script
// timeout, malformed JSON.
import { createLogger } from './logger.js';

export function runCollector({ powerShellPath, psScriptPath, timeoutMs = 60000, level = 'info' }) {
  // Per-call logger so the operator's appsettings.json logLevel is
  // respected. Component tag lets them filter collector lines in
  // pino-pretty / NSSM logs (e.g. `component:collector`).
  const log = createLogger({ component: 'collector', level });
  const started = Date.now();
  log.info({ psScriptPath, timeoutMs }, 'collector: spawning powershell');
  return new Promise((resolve) => {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psScriptPath];
    const child = spawn(powerShellPath, args, { windowsHide: true });
    let stdout = '', stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      log.error({ timeoutMs, ms: Date.now() - started }, 'collector: timeout — child killed');
      resolve({ ok: false, error: 'timeout', snapshot: null });
    }, timeoutMs);
    child.stdout.on('data', d => stdout += d.toString('utf8'));
    child.stderr.on('data', d => stderr += d.toString('utf8'));
    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // spawn itself failed — most commonly powershell.exe not found,
      // or psScriptPath missing. Surface the exact error so the operator
      // can tell "script missing" from "PS not in PATH".
      log.error({ err: err.message, code: err.code, ms: Date.now() - started }, 'collector: spawn error');
      resolve({ ok: false, error: err.message, snapshot: null });
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        // Exit non-zero AND no stdout — PS script crashed before
        // emitting JSON. The first 500 chars of stderr are usually
        // enough to see the actual exception.
        const snippet = String(stderr || `exit ${code}`).slice(0, 500);
        log.error({ code, ms: Date.now() - started, stderr: snippet }, 'collector: script exit non-zero, no stdout');
        return resolve({ ok: false, error: stderr || `exit ${code}`, snapshot: null });
      }
      try {
        const snapshot = JSON.parse(stdout);
        log.info({
          ok: true,
          code,
          ms: Date.now() - started,
          entryCount: Array.isArray(snapshot?.Entries) ? snapshot.Entries.length : null,
        }, 'collector: snapshot ok');
        resolve({ ok: true, snapshot });
      } catch (e) {
        // The PS script emitted SOMETHING but it wasn't valid JSON. Most
        // common cause: a `Write-Host` line bled into stdout alongside
        // ConvertTo-Json. Show the first 500 chars so the operator sees
        // the rogue prefix.
        const snippet = String(stdout).slice(0, 500);
        log.error({ code, ms: Date.now() - started, err: e.message, stdoutPrefix: snippet }, 'collector: parse error');
        resolve({ ok: false, error: `parse: ${e.message}`, snapshot: null });
      }
    });
  });
}