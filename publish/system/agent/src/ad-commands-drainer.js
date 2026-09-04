// 2026-09-04 R78 — Real agent AD-commands drainer.
//
// Bridge the center's AD admin command queue to the local PowerShell
// dispatchers. Polls GET /api/agent/ad-commands?hostname=X on every
// heartbeat (NOT gated by reportRequested — the operator queues a
// command and expects it to run within the heartbeat cadence, not only
// when they click 回报). For each claimed row the agent invokes
// dispatchAdCommand (R75 dispatcher) and POSTs the result envelope
// back via /api/agent/ad-commands/:id/result.
//
// Why a separate module (vs. inlining in heartbeat-callbacks.js)?
//   - Pure function shape: hostname / token / centerUrl / http helpers /
//     dispatcher are all injected, so unit tests can mock the entire
//     wire with two fake HTTP functions and a fake dispatcher.
//   - Mirrors the mock-side pattern (center/mock-heartbeat-daemon.mjs
//     ::processAdCommands) so the R75 e2e driver and the real agent
//     exercise identical sequencing.
//   - Single point of error handling: if POST fails, log + return —
//     next heartbeat re-polls. The center's claim has already flipped
//     the row to 'running'; sweepTimeouts() (R75-T4) re-queues rows
//     older than 30s with status='timeout', so a transient failure
//     self-heals on the next sweep.
//
// Reference: agent/src/dispatchers/ad-admin.js (R75) — same contract
// as center/mock-ad-admin.mjs::dispatchMockAdCommand.
// Center endpoints:
//   GET  /api/agent/ad-commands?hostname=X&agentId=Y&limit=N
//        → { commands: [{ id, commandType, targetDc, params, ... }] }
//   POST /api/agent/ad-commands/:id/result
//        body { success, data, error, exitCode, durationMs }
//        → 200 { ok, commandId, status }
// The service's claimForAgent does the 2-step atomic claim internally;
// this drainer treats the response as already-claimed rows.

export async function drainAdCommands({
  hostname,
  token,
  centerUrl,
  httpGetJson,
  httpPostJson,
  dispatchAdCommand,
  logger,
  limit = 10,
  timeoutMs = 60_000,
} = {}) {
  if (!hostname) {
    return { processed: 0, succeeded: 0, failed: 0, error: 'hostname required' };
  }
  if (typeof httpGetJson !== 'function' || typeof httpPostJson !== 'function') {
    return { processed: 0, succeeded: 0, failed: 0, error: 'httpGetJson/httpPostJson required' };
  }
  if (typeof dispatchAdCommand !== 'function') {
    return { processed: 0, succeeded: 0, failed: 0, error: 'dispatchAdCommand required' };
  }

  // 1) Poll for queued/claimed commands targeted at this DC.
  let poll;
  try {
    poll = await httpGetJson({
      url: `${centerUrl}/api/agent/ad-commands?hostname=${encodeURIComponent(hostname)}&limit=${limit}`,
      headers: { 'X-Agent-Token': token },
      timeoutMs: 30_000,
    });
  } catch (e) {
    logger?.warn?.({ err: e.message, hostname }, 'ad-commands poll threw');
    return { processed: 0, succeeded: 0, failed: 0, error: e.message };
  }

  if (!poll.ok) {
    // 404 happens during centre boot when the route isn't mounted yet;
    // any other non-2xx is logged for ops visibility. Either way the
    // next heartbeat re-polls.
    if (poll.status !== 404) {
      logger?.warn?.({ status: poll.status, hostname }, 'ad-commands poll returned non-2xx');
    }
    return { processed: 0, succeeded: 0, failed: 0, status: poll.status ?? 0 };
  }

  const commands = Array.isArray(poll.data?.commands) ? poll.data.commands : [];
  if (commands.length === 0) {
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  logger?.info?.({ hostname, count: commands.length }, 'ad-commands drained from center');

  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  // 2) For each row: dispatch locally, then POST the result envelope.
  // We dispatch sequentially (not Promise.all) because each command may
  // take up to timeoutMs, and the dispatcher spawns its own PS1 process —
  // running 10 user-searches in parallel would fork-bomb a DC. The
  // mock-side runs sequentially for the same reason.
  for (const cmd of commands) {
    processed++;
    const commandId = cmd.id;
    const commandType = cmd.commandType;
    // dispatchAdCommand always resolves (NEVER throws) — it synthesizes
    // a {success:false, error, exitCode} envelope on any internal
    // failure. So no try/catch around the dispatch is needed.
    const result = await dispatchAdCommand({
      commandType,
      params: cmd.params ?? {},
      timeoutMs,
      logger,
    });
    if (result.success) succeeded++;
    else failed++;

    // 3) POST the result back to center. Failure to POST is logged but
    // does NOT throw — the row is already claimed on the center side
    // (status='running'); sweepTimeouts will eventually flip it to
    // 'timeout' if we never ack. The next heartbeat cycle would then
    // see a fresh 'queued' row from the operator's retry. We log at
    // warn so an operator scanning the agent log can see the disconnect.
    try {
      const ack = await httpPostJson({
        url: `${centerUrl}/api/agent/ad-commands/${commandId}/result`,
        headers: { 'X-Agent-Token': token },
        body: {
          success: !!result.success,
          data: result.data ?? null,
          error: result.error ?? null,
          exitCode: Number.isFinite(result.exitCode) ? result.exitCode : null,
          durationMs: Number.isFinite(result.durationMs) ? result.durationMs : null,
        },
        timeoutMs: 15_000,
      });
      if (ack.ok) {
        logger?.info?.({
          commandId,
          commandType,
          success: !!result.success,
          durationMs: result.durationMs,
        }, 'ad-command result posted');
      } else {
        logger?.warn?.({
          commandId,
          commandType,
          status: ack.status,
        }, 'ad-command result POST failed (next sweep will retry)');
      }
    } catch (e) {
      logger?.warn?.({ err: e.message, commandId }, 'ad-command result POST threw');
    }
  }

  return { processed, succeeded, failed };
}

// Exposed for the test harness so unit tests can exercise the
// contract without spinning up the full agent runtime.
export const __testing = { drainAdCommands };
