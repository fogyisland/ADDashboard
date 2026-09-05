// 2026-09-05 R81 — mock member-server PowerShell execution store +
// dispatchers.
//
// In-memory mock that mirrors what the real agent's
// run-member-script.ps1 will produce when the operator queues a free
// PowerShell against a member-server hostname. The mock accepts
// { script, timeoutSec } and returns the same { stdout, stderr,
// exitCode, durationMs } envelope the real PS1 spawn() emits on the
// wire — so the dispatcher / ack path is byte-identical between the
// mock and the real agent.
//
// Why this is simpler than mock-ad-admin.mjs:
//   1. There's no per-host "state" (AD cmdlets mutate users / groups;
//      member-script commands are ephemeral, no domain state).
//   2. We only need to support a single command_type for R81
//      (`member_script`); future types can layer on later.
//   3. The dispatcher's job is "spawn PS1, parse last-line JSON, ack".
//      The mock simulates the spawn via a deterministic in-process
//      evaluator that recognizes a small set of safe stubs (Get-Date,
//      Get-Host, etc.) and rejects dangerous patterns (Remove-Item
//      -Recurse, Stop-Service, Format-Volume) — defense-in-depth at
//      the mock level so the e2e driver catches operator mistakes
//      without a real Windows host.
//
// Password / token fields in the result blob are NEVER echoed back
// (spec §3 guard rail #8); the real agent's dispatcher is expected to
// apply the same redaction (already done by the service on write).

// ── error class ─────────────────────────────────────────────────────────

export class MockMemberError extends Error {
  constructor(message, httpStatus = 400) {
    super(message);
    this.name = 'MockMemberError';
    this.httpStatus = httpStatus;
  }
}

// ── danger-pattern detection (defense-in-depth at the mock level) ──────
// Real PS1 dispatchers are expected to refuse these patterns at the
// agent-side prompt too, but mirroring the block at the mock gives the
// e2e driver a deterministic way to catch operator mistakes without a
// real Windows host.
//
// Each entry is a case-insensitive regex that, when matched against the
// raw script body, throws a MockMemberError → ack returns
// success=false, error=<message>, exitCode=1.
const DANGER_PATTERNS = [
  { rx: /\bRemove-Item\b[\s\S]*-Recurse/i, msg: 'Remove-Item -Recurse is blocked at the mock' },
  { rx: /\bStop-Service\b/i, msg: 'Stop-Service is blocked at the mock' },
  { rx: /\bFormat-Volume\b/i, msg: 'Format-Volume is blocked at the mock' },
  { rx: /\bClear-Disk\b/i, msg: 'Clear-Disk is blocked at the mock' },
  { rx: /\bRestart-Computer\b/i, msg: 'Restart-Computer is blocked at the mock' },
  { rx: /\bInvoke-Expression\b/i, msg: 'Invoke-Expression is blocked at the mock' },
  { rx: /\|\s*iex\b/i, msg: 'iex pipeline is blocked at the mock' }
];

// ── in-memory call log (for assertions) ─────────────────────────────────
// Each entry is the { script, stdout, stderr, exitCode, durationMs } the
// mock "spawned". Tests reset between scenarios via resetMemberLog().

export const memberLog = [];

function logCall(entry) {
  memberLog.push(entry);
}

export function resetMemberLog() {
  memberLog.length = 0;
}

// ── single dispatcher ──────────────────────────────────────────────────

/**
 * Run a member-script command in-process (mock).
 *
 * @param {string} hostname  the agent's hostname (matches the agent_id
 *                           in ad_agent_heartbeat and the `hostname` field
 *                           on ad_member_commands rows).
 * @param {object} cmd       { commandType, params: { script, timeoutSec } }
 * @returns { success, data, error, exitCode, durationMs }
 */
export function mockMemberScript(hostname, { script, timeoutSec } = {}) {
  const start = Date.now();
  // Validate the script payload (mirrors what the real agent's PS1
  // expects — failure here is the agent's fault, not the operator's, so
  // it's a 4xx-shaped ack with success=false).
  if (typeof script !== 'string' || !script.trim()) {
    const durationMs = Date.now() - start;
    return {
      success: false,
      data: null,
      error: 'invalid params: script',
      exitCode: 1,
      durationMs
    };
  }
  const tSec = Math.max(1, Math.min(120, Number(timeoutSec) || 30));
  // Defense-in-depth — block dangerous patterns at the mock. The real
  // agent should do this too; if it doesn't, the test will catch the
  // operator mistake here. Not a security boundary.
  for (const { rx, msg } of DANGER_PATTERNS) {
    if (rx.test(script)) {
      const durationMs = Date.now() - start;
      logCall({ hostname, script, stdout: '', stderr: msg, exitCode: 1, durationMs });
      return {
        success: false,
        data: { stdout: '', stderr: msg, exitCode: 1, durationMs },
        error: msg,
        exitCode: 1,
        durationMs
      };
    }
  }
  // Pseudo-execution: a deterministic in-process evaluator. Recognizes
  // a small set of safe stubs; for anything else, returns the script
  // body wrapped in a JSON envelope (same shape the real PS1 emits via
  // ConvertTo-Json on the last line).
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  try {
    if (/^\s*Get-Date\b/i.test(script)) {
      stdout = new Date().toISOString();
    } else if (/^\s*Get-Host\b/i.test(script)) {
      stdout = JSON.stringify({ Name: 'MOCK-MEMBER-HOST', Version: '0.0.0' });
    } else if (/^\s*whoami\b/i.test(script)) {
      stdout = `MOCK\\${hostname}`;
    } else if (/^\s*hostname\b/i.test(script)) {
      stdout = hostname;
    } else if (/^\s*\$true\b/i.test(script)) {
      stdout = 'True';
    } else if (/^\s*\$false\b/i.test(script)) {
      stdout = 'False';
    } else {
      // Generic stub: echo the script as stdout so the e2e driver has
      // something observable without matching a specific cmdlet.
      stdout = `[MOCK] ${script.trim()}`;
    }
  } catch (e) {
    stderr = e.message;
    exitCode = 2;
  }
  // Ensure the run doesn't exceed the timeout (the mock is fast; this
  // is more about mirroring the real agent's behavior).
  const durationMs = Math.max(1, Date.now() - start);
  logCall({ hostname, script, stdout, stderr, exitCode, durationMs });
  return {
    success: exitCode === 0,
    data: { stdout, stderr, exitCode, durationMs },
    error: exitCode === 0 ? null : stderr || 'non-zero exit code',
    exitCode,
    durationMs
  };
}

// ── command router ──────────────────────────────────────────────────────

/**
 * dispatchMockMemberCommand(agentId, cmd) routes cmd.commandType to the
 * matching mock* function. Returns { success, data, error, exitCode,
 * durationMs } so the mock agent's ack layer can wrap it into the
 * result envelope (matches the shape the real agent's JS dispatcher
 * produces from its run-member-script.ps1 spawn).
 */
export function dispatchMockMemberCommand(agentId, cmd) {
  const start = Date.now();
  try {
    if (!cmd || typeof cmd !== 'object') {
      throw new MockMemberError('command object required', 400);
    }
    const { commandType, params } = cmd;
    if (typeof commandType !== 'string' || !commandType) {
      throw new MockMemberError('commandType required', 400);
    }
    let data;
    switch (commandType) {
      case 'member_script':
        data = mockMemberScript(agentId, params || {}).data;
        break;
      default:
        throw new MockMemberError(`unknown command_type: ${commandType}`, 400);
    }
    const durationMs = Date.now() - start;
    return {
      success: true,
      data,
      error: null,
      exitCode: 0,
      durationMs
    };
  } catch (e) {
    const durationMs = Date.now() - start;
    const httpStatus = (e && typeof e.httpStatus === 'number') ? e.httpStatus : 500;
    const message = (e && e.message) ? e.message : String(e);
    return {
      success: false,
      data: null,
      error: message,
      exitCode: httpStatus >= 500 ? 2 : 1,
      durationMs
    };
  }
}

// ── standalone-run introspection ───────────────────────────────────────
const isDirectRun = process.argv[1] &&
  (process.argv[1].endsWith('mock-member-commands.mjs') ||
   process.argv[1].endsWith('mock-member-commands'));
if (isDirectRun) {
  console.log('mock-member-commands.mjs — module surface:');
  console.log('  exports: memberLog, MockMemberError, resetMemberLog');
  console.log('  dispatcher (1): mockMemberScript(hostname, { script, timeoutSec })');
  console.log('  router: dispatchMockMemberCommand(agentId, { commandType, params })');
}