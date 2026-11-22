// 2026-09-05 R81 — Real agent JS dispatcher for member-server commands.
//
// ★ R161.35 step 2 (2026-11-22) — REWRITTEN from "free-form script
//   runner" to "sealed action runner".
//
//   Before: the center sent `{ script: "<任意 PowerShell 全文>" }`; this
//   dispatcher spawned run-member-script.ps1 which did
//   `Invoke-Expression $body` as SYSTEM. There was no way to bound what the
//   script could do — the only gate was a 16-pattern deny-list in the
//   center, which is structurally unable to cover PowerShell's surface
//   (encoded commands, reflection, dynamic script blocks, persistence
//   tools that simply aren't in the list).
//
//   After: the center sends `{ scriptId, args }`. The dispatcher:
//     1. checks `scriptId` against the SEALED manifest (member-scripts.js)
//     2. validates `args` against that script's schema (unknown args are
//        REJECTED, not dropped)
//     3. verifies the on-disk .ps1's sha256 against the manifest digest
//        — this is the direct answer to "someone edited the PowerShell
//          file on this box", and it runs before powershell.exe exists
//     4. hands only the validated args to a fixed script that already
//        ships with the agent
//
//   The operator can now choose WHICH action and WHAT arguments. They
//   cannot send code. Adding a new action means writing a .ps1, sealing it,
//   and shipping — a deliberate gap that an attacker without the build
//   cannot cross.
//
// Contract:
//   dispatchMemberCommand({ commandType: 'member_action',
//                           params: { scriptId, args },
//                           powerShellPath?, scriptsDir?, timeoutMs?,
//                           spawnFn?, logger? })
//     → Promise<{ success, data, error, exitCode, durationMs }>
//
// - Always resolves — NEVER throws — so the heartbeat drainer can await it
//   without try/catch.
// - Password / token fields are never echoed by the shipped scripts, and
//   the dispatcher does not log the raw payload.

import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
// R161.35 step 2 (2026-11-22) — the sealed script manifest. This is what
// replaces the free-form Invoke-Expression path; see member-scripts.js.
import { MEMBER_SCRIPTS, validateArgs, resolveScriptFile } from '../member-scripts.js';

// ★ R161.35 step 2 — `member_script` (free-form PowerShell) is RETIRED.
//   The only command type now is `member_action`, whose payload is
//   { scriptId, args } — a name into the sealed manifest plus structured
//   parameters. There is no way to send code.
const SUPPORTED_TYPES = Object.freeze(new Set(['member_action']));
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_SEC = 30;

// Resolve the default scripts directory. agent/scripts/ lives next to
// agent/src/ — we derive it from this file's location using
// fileURLToPath so it works regardless of cwd.
const __filename = fileURLToPath(import.meta.url);
const DEFAULT_SCRIPTS_DIR = resolve(dirname(__filename), '..', '..', 'scripts');

/**
 * Resolve a member action: manifest membership → argument schema →
 * on-disk integrity.
 *
 * ★ The order matters. The integrity check is the answer to "what if
 *   someone modified the PowerShell file on this box?" — it must run
 *   BEFORE powershell.exe is ever spawned, and it must run on every
 *   command (not cached), because the threat is exactly a local edit that
 *   happens while the agent is running.
 *
 * Returns { ok: true, scriptPath, params, timeoutSec } or { ok: false, error }.
 */
function pickScript(commandType, params, scriptsDir) {
  if (typeof commandType !== 'string' || commandType.length === 0) {
    return { error: 'commandType required' };
  }
  if (!SUPPORTED_TYPES.has(commandType)) {
    return { error: `unsupported commandType: ${commandType}` };
  }
  const payload = params || {};
  const scriptId = payload.scriptId;
  if (typeof scriptId !== 'string' || scriptId.length === 0) {
    return { error: 'params.scriptId required' };
  }

  // 1) manifest membership + argument schema
  const v = validateArgs(scriptId, payload.args);
  if (!v.ok) return { error: v.error };

  // 2) on-disk integrity (sha256 vs the manifest sealed at build time)
  const resolved = resolveScriptFile(scriptId, scriptsDir);
  if (!resolved.ok) return { error: resolved.error };

  return {
    scriptPath: resolved.scriptPath,
    params: v.normalized,
    // The manifest's per-script timeout is authoritative; the caller may
    // only make it SHORTER, never longer.
    timeoutSec: resolved.entry.timeoutSec,
    scriptId,
  };
}

function writeParamsFile(params) {
  const dir = mkdtempSync(join(tmpdir(), 'addash-member-action-'));
  const file = join(dir, 'params.json');
  writeFileSync(file, JSON.stringify(params || {}), { encoding: 'utf8' });
  return { dir, file };
}

// Execute the picked PS1 script and resolve with a normalized result
// envelope. NEVER throw — any internal error becomes
// { success:false, error, exitCode:2 }.
//
// ★ R161.35 step 2 — the argument list no longer carries -CommandType or
//   -TimeoutSec. Each sealed script is bound to ONE action, so it knows
//   what to do; the timeout is enforced here (JS kill) and the script's
//   own internal budget. Passing a command type to a script that already IS
//   the command was redundant and was one more string to trust.
function executeScript({ scriptPath, paramsPath, timeoutSec, powerShellPath, spawnFn, logger }) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-ParamsPath', paramsPath
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
  const pick = pickScript(commandType, params, scriptsDir);
  if (pick.error) {
    // ★ A rejected action is a security event worth logging: an unknown
    //   scriptId, a schema violation, or a digest mismatch all land here.
    //   The center receives it in the result envelope and records it.
    logger?.warn?.({ commandType, scriptId: params?.scriptId, err: pick.error },
      'member action rejected');
    return {
      success: false,
      data: null,
      error: pick.error,
      exitCode: 1,
      durationMs: Date.now() - startedAt,
    };
  }

  const { scriptPath, params: normalizedParams, scriptId } = pick;

  // The manifest's per-script timeout is authoritative. A caller may only
  // shorten it; never lengthen.
  const requestedSec = Math.max(
    1,
    Math.floor(Number(timeoutMs) / 1_000) || DEFAULT_TIMEOUT_SEC
  );
  const timeoutSec = Math.max(1, Math.min(pick.timeoutSec, requestedSec));

  let paramsDir = null;
  let paramsPath = null;
  try {
    // Only the validated, normalized args are handed to the script — never
    // the raw payload. A field the schema does not name cannot reach PS.
    const tmp = writeParamsFile(normalizedParams);
    paramsDir = tmp.dir;
    paramsPath = tmp.file;

    const result = await executeScript({
      scriptPath,
      paramsPath,
      timeoutSec,
      powerShellPath,
      spawnFn: spawnFn || ((pp, args, opts) => spawn(pp, args, opts)),
      logger,
    });
    return result;
  } finally {
    // R161.35 (2026-11-22) — remove the WHOLE temp directory, not just
    // params.json.
    //
    // ★ The bug: writeParamsFile() creates a fresh mkdtempSync() directory
    //   per command, but the cleanup only unlink'd params.json. The
    //   directory itself was never removed ⇒ every member command left an
    //   empty `addash-member-script-XXXXXX` folder behind in %TEMP%.
    //   On an agent that runs every heartbeat (5s by default), that is a
    //   steady accumulation of junk directories on every member server.
    //
    // ★ Why it also matters for security: params.json holds the command's
    //   FULL script text (the free-form PowerShell). The file was
    //   unlink'd, but on any abnormal path — a kill between write and
    //   cleanup, a crash inside executeScript, or a process killed by the
    //   OS — the file survived with the full script readable by anything
    //   running as that user on the box. Removing the directory tree
    //   removes both the leak and the residue risk.
    //
    //   rmSync(recursive) is used because the directory may still hold
    //   params.json (the unlink above may have failed) — we want the
    //   whole tree gone either way. Failures are swallowed: cleanup must
    //   never mask the command's own result.
    if (paramsDir) {
      try {
        rmSync(paramsDir, { recursive: true, force: true });
      } catch (cleanupErr) {
        // Fall back to removing just the file if the tree removal failed.
        if (paramsPath) {
          try { unlinkSync(paramsPath); } catch { /* ignore */ }
        }
        logger?.warn?.({ err: cleanupErr?.message, dir: paramsDir },
          'member command temp dir cleanup failed (best-effort)');
      }
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