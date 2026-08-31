import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// 2026-08-31 R75 — Real agent JS dispatcher for AD user/group commands.
//
// Bridges queued `user_*` and `group_*` commands (queued in center,
// polled via /api/agent/ad-commands) to the matching PowerShell
// scripts under agent/scripts/. Mirrors the shape of
// center/mock-ad-admin.mjs::dispatchMockAdCommand so the center-side
// audit classifier + result handler don't care whether the executor
// was the mock store or a real DC.
//
// Contract:
//   dispatchAdCommand({ commandType, params, powerShellPath?, scriptsDir?,
//                       timeoutMs?, spawnFn?, nowFn? })
//     → Promise<{ success, data, error, exitCode, durationMs }>
//
// - `commandType` MUST start with "user_" or "group_". The prefix
//   decides which PS1 script is invoked (ad-admin-users.ps1 vs
//   ad-admin-groups.ps1).
// - `params` is the JSON object the PS1 reads via ConvertFrom-Json.
//   It is written to a unique temp file (-ParamsPath) and the file is
//   deleted on the way out (best-effort).
// - `spawnFn` is injectable for unit tests; defaults to node:child_process spawn.
// - On spawn / parse / non-zero-exit failures we synthesize a result
//   envelope with success:false — the center-side handler only ever
//   consumes a result envelope, not a thrown error.
//
// Password fields are NEVER copied into data on the way back. The PS1
// scripts don't echo them on stdout, and the dispatcher does not log
// `params` either (per spec §8 ruling #8 — passwords redacted
// everywhere downstream of the cmdlet call).

const USER_PREFIX = 'user_';
const GROUP_PREFIX = 'group_';
const DEFAULT_TIMEOUT_MS = 60_000;

// Resolve the default scripts directory. agent/scripts/ lives next to
// agent/src/ — we derive it from this file's location using
// fileURLToPath so it works regardless of cwd.
const __filename = fileURLToPath(import.meta.url);
const DEFAULT_SCRIPTS_DIR = resolve(dirname(__filename), '..', '..', 'scripts');

function pickScript(commandType, scriptsDir) {
  if (typeof commandType !== 'string' || commandType.length === 0) {
    return { error: 'commandType required' };
  }
  if (commandType.startsWith(USER_PREFIX)) {
    return { script: 'ad-admin-users.ps1' };
  }
  if (commandType.startsWith(GROUP_PREFIX)) {
    return { script: 'ad-admin-groups.ps1' };
  }
  return { error: `unsupported commandType prefix: ${commandType}` };
}

function writeParamsFile(params) {
  const dir = mkdtempSync(join(tmpdir(), 'addash-ad-admin-'));
  const file = join(dir, 'params.json');
  // Stringify with deterministic ordering? Keep it simple — JSON.stringify
  // default is fine because PS1 only consumes it back via ConvertFrom-Json.
  writeFileSync(file, JSON.stringify(params || {}), { encoding: 'utf8' });
  return { dir, file };
}

// Execute the picked PS1 script and resolve with a normalized result
// envelope. NEVER throw — any internal error becomes
// { success:false, error, exitCode:2 }.
function executeScript({ scriptPath, commandType, paramsPath, timeoutMs, powerShellPath, spawnFn, logger }) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-CommandType', commandType,
      '-ParamsPath', paramsPath,
    ];
    let child;
    try {
      child = spawnFn(powerShellPath, args, { windowsHide: true });
    } catch (err) {
      return resolve({
        success: false,
        data: null,
        error: `spawn failed: ${err && err.message ? err.message : String(err)}`,
        exitCode: 2,
        durationMs: Date.now() - startedAt,
      });
    }

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
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish({
        success: false,
        data: null,
        error: `timeout after ${timeoutMs}ms`,
        exitCode: 2,
        durationMs: Date.now() - startedAt,
      });
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

    child.on('error', (err) => {
      finish({
        success: false,
        data: null,
        error: `process error: ${err && err.message ? err.message : String(err)}`,
        exitCode: 2,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on('close', (code) => {
      const durationMs = Date.now() - startedAt;
      // The PS1 script emits the result envelope as a single JSON line
      // on stdout. Parse the last non-empty line.
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      const lastLine = lines.length > 0 ? lines[lines.length - 1] : '';
      if (lastLine) {
        try {
          const parsed = JSON.parse(lastLine);
          if (parsed && typeof parsed === 'object' && 'success' in parsed) {
            // Trust the PS1 envelope; just normalize exitCode.
            return finish({
              success: !!parsed.success,
              data: parsed.data ?? null,
              error: parsed.error ?? null,
              exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : (parsed.success ? 0 : 1),
              durationMs: typeof parsed.durationMs === 'number' ? parsed.durationMs : durationMs,
            });
          }
        } catch {
          // fall through to exit-code fallback
        }
      }
      // No parseable envelope — synthesize a failure from exit code.
      if (code === 0) {
        // Exited 0 but no JSON — that's still a failure, but not 5xx-grade.
        logger?.warn({ scriptPath, stdoutPreview: stdout.slice(0, 200) }, 'ad-admin script exited 0 without result envelope');
        return finish({
          success: false,
          data: null,
          error: `script produced no result envelope (exit 0)`,
          exitCode: 1,
          durationMs,
        });
      }
      return finish({
        success: false,
        data: null,
        error: `exit ${code}: ${(stderr || '').trim().slice(0, 500) || 'no stderr'}`,
        exitCode: typeof code === 'number' ? code : 1,
        durationMs,
      });
    });
  });
}

// Main exported entrypoint. Returns a normalized result envelope.
// Always resolves — NEVER throws — so callers (e.g. the ad-commands
// drainer in heartbeat loops) can safely await without try/catch.
export async function dispatchAdCommand({
  commandType,
  params,
  powerShellPath = 'powershell.exe',
  scriptsDir = DEFAULT_SCRIPTS_DIR,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnFn,
  logger,
} = {}) {
  const startedAt = Date.now();

  const pick = pickScript(commandType, scriptsDir);
  if (pick.error) {
    return {
      success: false,
      data: null,
      error: pick.error,
      exitCode: 1,
      durationMs: Date.now() - startedAt,
    };
  }

  const scriptPath = join(scriptsDir, pick.script);

  let paramsPath = null;
  let paramsDir = null;
  try {
    const tmp = writeParamsFile(params);
    paramsPath = tmp.file;
    paramsDir = tmp.dir;

    const result = await executeScript({
      scriptPath,
      commandType,
      paramsPath,
      timeoutMs,
      powerShellPath,
      spawnFn: spawnFn || ((pp, args, opts) => spawn(pp, args, opts)),
      logger,
    });
    return result;
  } finally {
    // Best-effort cleanup of the params blob. If the script is still
    // running we leave the dir in place — the OS will reap tmpdir on
    // reboot.
    if (paramsPath) {
      try { unlinkSync(paramsPath); } catch { /* ignore */ }
    }
  }
}

// Convenience helper — same contract as dispatchMockAdCommand in
// center/mock-ad-admin.mjs. Exists so center-side tests / smoke
// drivers can call a single canonical name regardless of mock vs real.
export const dispatchAdAdminCommand = dispatchAdCommand;

export const __testing = {
  pickScript,
  writeParamsFile,
  DEFAULT_SCRIPTS_DIR,
  DEFAULT_TIMEOUT_MS,
  USER_PREFIX,
  GROUP_PREFIX,
};