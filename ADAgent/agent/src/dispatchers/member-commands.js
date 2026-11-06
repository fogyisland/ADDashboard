// 2026-09-05 R81 — Real agent JS dispatcher for member-server
// PowerShell commands.
//
// Bridges queued `member_script` commands (queued in center, polled
// via /api/agent/member-commands) to the matching PowerShell script
// agent/scripts/run-member-script.ps1. Mirrors the shape of
// center/mock-member-commands.mjs::dispatchMockMemberCommand so the
// center-side audit classifier + result handler don't care whether
// the executor was the mock store or a real member-server agent.
//
// Contract (matches ad-admin.js dispatchAdCommand):
//   dispatchMemberCommand({ commandType, params, powerShellPath?,
//                           scriptsDir?, timeoutMs?, spawnFn?, nowFn? })
//     → Promise<{ success, data, error, exitCode, durationMs }>
//
// - `commandType` MUST be 'member_script' for R81. Future types can
//   layer on by extending pickScript() below.
// - `params` is the JSON object the PS1 reads via ConvertFrom-Json.
//   It is written to a unique temp file (-ParamsPath) and the file is
//   deleted on the way out (best-effort).
// - `spawnFn` is injectable for unit tests; defaults to node:child_process spawn.
// - On spawn / parse / non-zero-exit failures we synthesize a result
//   envelope with success:false — the center-side handler only ever
//   consumes a result envelope, not a thrown error.
//
// Password / token fields are NEVER copied into data on the way back.
// The PS1 doesn't echo them on stdout, and the dispatcher does not log
// `params` either (spec §3 guard rail #8 — passwords redacted
// everywhere downstream of the cmdlet call).

import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SUPPORTED_TYPES = Object.freeze(new Set(['member_script']));
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_SEC = 30;

// Resolve the default scripts directory. agent/scripts/ lives next to
// agent/src/ — we derive it from this file's location using
// fileURLToPath so it works regardless of cwd.
const __filename = fileURLToPath(import.meta.url);
const DEFAULT_SCRIPTS_DIR = resolve(dirname(__filename), '..', '..', 'scripts');

function pickScript(commandType, scriptsDir) {
  if (typeof commandType !== 'string' || commandType.length === 0) {
    return { error: 'commandType required' };
  }
  if (!SUPPORTED_TYPES.has(commandType)) {
    return { error: `unsupported commandType: ${commandType}` };
  }
  return { script: 'run-member-script.ps1' };
}

function writeParamsFile(params) {
  const dir = mkdtempSync(join(tmpdir(), 'addash-member-script-'));
  const file = join(dir, 'params.json');
  writeFileSync(file, JSON.stringify(params || {}), { encoding: 'utf8' });
  return { dir, file };
}

// Execute the picked PS1 script and resolve with a normalized result
// envelope. NEVER throw — any internal error becomes
// { success:false, error, exitCode:2 }.
function executeScript({ scriptPath, commandType, paramsPath, timeoutSec, powerShellPath, spawnFn, logger }) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-CommandType', commandType,
      '-ParamsPath', paramsPath,
      '-TimeoutSec', String(timeoutSec)
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

    // Convert the sec budget into a ms envelope for the JS-side
    // safety net. PS1 has its own Wait-Job timeout; this is defense
    // in depth for the case where PS1 never returns (e.g. hung
    // background job).
    const timeoutMs = Math.max(1_000, timeoutSec * 1_000 + 5_000);
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish({
        success: false,
        data: null,
        error: `timeout after ${timeoutMs}ms (PS1 may have hung)`,
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
      if (code === 0) {
        logger?.warn({ scriptPath, stdoutPreview: stdout.slice(0, 200) }, 'member script exited 0 without result envelope');
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
// Always resolves — NEVER throws — so callers (e.g. the
// member-commands drainer in heartbeat loops) can safely await without
// try/catch.
export async function dispatchMemberCommand({
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

  // Convert the ms budget the drainer passes into a sec budget the
  // PS1 reads. The PS1 enforces the actual cap; we clamp here too so
  // a caller passing timeoutMs=0 doesn't break the script.
  const timeoutSec = Math.max(
    1,
    Math.min(120, Math.floor(timeoutMs / 1_000) || DEFAULT_TIMEOUT_SEC)
  );

  let paramsPath = null;
  try {
    const tmp = writeParamsFile(params);
    paramsPath = tmp.file;

    const result = await executeScript({
      scriptPath,
      commandType,
      paramsPath,
      timeoutSec,
      powerShellPath,
      spawnFn: spawnFn || ((pp, args, opts) => spawn(pp, args, opts)),
      logger,
    });
    return result;
  } finally {
    if (paramsPath) {
      try { unlinkSync(paramsPath); } catch { /* ignore */ }
    }
  }
}

// Convenience alias — mirrors the dispatchAdAdminCommand pattern in
// ad-admin.js so a future smoke driver can call one canonical name
// regardless of command family.
export const dispatchMemberScript = dispatchMemberCommand;

export const __testing = {
  pickScript,
  writeParamsFile,
  DEFAULT_SCRIPTS_DIR,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TIMEOUT_SEC,
  SUPPORTED_TYPES,
};