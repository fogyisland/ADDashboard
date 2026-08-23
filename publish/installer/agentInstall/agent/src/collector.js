import { spawn } from 'node:child_process';

export function runCollector({ powerShellPath, psScriptPath, timeoutMs = 60000 }) {
  return new Promise((resolve) => {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psScriptPath];
    const child = spawn(powerShellPath, args, { windowsHide: true });
    let stdout = '', stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ ok: false, error: 'timeout', snapshot: null });
    }, timeoutMs);
    child.stdout.on('data', d => stdout += d.toString('utf8'));
    child.stderr.on('data', d => stderr += d.toString('utf8'));
    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: err.message, snapshot: null });
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        return resolve({ ok: false, error: stderr || `exit ${code}`, snapshot: null });
      }
      try {
        const snapshot = JSON.parse(stdout);
        resolve({ ok: true, snapshot });
      } catch (e) {
        resolve({ ok: false, error: `parse: ${e.message}`, snapshot: null });
      }
    });
  });
}