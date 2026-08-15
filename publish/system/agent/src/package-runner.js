import { spawn as defaultSpawn } from 'node:child_process';
import { basename, dirname } from 'node:path';

// Runs a package's PowerShell collect script with the JSON config piped on
// stdin. The script's expected output is zero or more lines of text followed
// by a final line containing JSON `{"metrics":{...}}` — anything before the
// JSON line is treated as free-form log output and discarded.
//
// `spawnFn` is injectable so tests can stub the child process without
// requiring PowerShell on PATH.
export function runPackageScript({
  scriptPath,
  params,
  timeoutMs = 30000,
  logger,
  spawnFn,
  powerShellPath = 'powershell.exe'
}) {
  const spawn = spawnFn || defaultSpawn;
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(powerShellPath, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
    ], { windowsHide: true });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      logger?.warn({ scriptPath, timeoutMs }, 'package script timeout');
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish({
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(Date.now()).toISOString(),
        exitCode: -1,
        metrics: null,
        error: `timeout after ${timeoutMs}ms`,
        stdoutPreview: stdout.slice(0, 2048),
        stderrPreview: stderr.slice(0, 2048),
      });
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    // Pipe config on stdin: { name, params }. The PS script reads via
    // [Console]::In.ReadToEnd() and parses with ConvertFrom-Json.
    try {
      const name = basename(dirname(scriptPath));
      child.stdin.write(JSON.stringify({ name, params: params || {} }));
      child.stdin.end();
    } catch {
      // stdin may already be closed if the process errored before we wrote
    }

    child.on('error', (err) => {
      finish({
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(Date.now()).toISOString(),
        exitCode: -1,
        metrics: null,
        error: err.message,
        stdoutPreview: stdout.slice(0, 2048),
        stderrPreview: stderr.slice(0, 2048),
      });
    });

    child.on('exit', (code) => {
      // Parse last non-empty line of stdout as JSON
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      const lastLine = lines[lines.length - 1] || '';
      let metrics = null;
      let parseError = null;
      if (lastLine) {
        try {
          const parsed = JSON.parse(lastLine);
          metrics = parsed && typeof parsed === 'object' ? (parsed.metrics ?? null) : null;
        } catch (e) {
          parseError = `stdout does not end with valid JSON: ${lastLine.slice(0, 200)}`;
        }
      } else {
        parseError = 'no stdout produced';
      }

      let error = null;
      if (parseError) error = parseError;
      else if (code !== 0) error = `exit ${code}: ${stderr.slice(0, 200)}`;

      finish({
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(Date.now()).toISOString(),
        exitCode: code,
        metrics,
        stdoutPreview: stdout.slice(0, 2048),
        stderrPreview: stderr.slice(0, 2048),
        error,
      });
    });
  });
}
