// 2026-09-05 R81 — Real agent member-commands drainer.
//
// Mirrors agent/src/ad-commands-drainer.js (R78). Polls
// GET /api/agent/member-commands?hostname=X on every heartbeat (NOT
// gated by reportRequested — the operator queues a command and expects
// it to run within the heartbeat cadence). For each claimed row the
// agent invokes dispatchMemberCommand (R81 dispatcher) and POSTs the
// result envelope back via /api/agent/member-commands/:id/result.
//
// Pure function shape: hostname / token / centerUrl / http helpers /
// dispatcher are all injected so unit tests can mock the wire without
// spinning up a live agent. Same contract as the mock side
// (center/mock-heartbeat-daemon.mjs::processMemberCommands).
//
// Center endpoints:
//   GET  /api/agent/member-commands?hostname=X&limit=N
//        → { commands: [{ id, hostname, commandType, params, ... }] }
//   POST /api/agent/member-commands/:id/result
//        body { success, data, error, exitCode, durationMs }
//        → 200 { ok, commandId, status }
// The service's claimForAgent does the 2-step atomic claim internally;
// this drainer treats the response as already-claimed rows.

export async function drainMemberCommands({
  hostname,
  token,
  centerUrl,
  httpGetJson,
  httpPostJson,
  dispatchMemberCommand,
  logger,
  limit = 10,
  timeoutMs = 30_000,
} = {}) {
  if (!hostname) {
    return { processed: 0, succeeded: 0, failed: 0, error: 'hostname required' };
  }
  if (typeof httpGetJson !== 'function' || typeof httpPostJson !== 'function') {
    return { processed: 0, succeeded: 0, failed: 0, error: 'httpGetJson/httpPostJson required' };
  }
  if (typeof dispatchMemberCommand !== 'function') {
    return { processed: 0, succeeded: 0, failed: 0, error: 'dispatchMemberCommand required' };
  }

  // 1) Poll for queued/claimed commands targeted at this hostname.
  let poll;
  try {
    poll = await httpGetJson({
      url: `${centerUrl}/api/agent/member-commands?hostname=${encodeURIComponent(hostname)}&limit=${limit}`,
      headers: { 'X-Agent-Token': token },
      timeoutMs: 30_000,
    });
  } catch (e) {
    logger?.warn?.({ err: e.message, hostname }, 'member-commands poll threw');
    return { processed: 0, succeeded: 0, failed: 0, error: e.message };
  }

  if (!poll.ok) {
    if (poll.status !== 404) {
      logger?.warn?.({ status: poll.status, hostname }, 'member-commands poll returned non-2xx');
    }
    return { processed: 0, succeeded: 0, failed: 0, status: poll.status ?? 0 };
  }

  const commands = Array.isArray(poll.data?.commands) ? poll.data.commands : [];
  if (commands.length === 0) {
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  logger?.info?.({ hostname, count: commands.length }, 'member-commands drained from center');

  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  // 2) For each row: dispatch locally, then POST the result envelope.
  // Sequential — the dispatcher spawns a PS1 process per row, and the
  // PS1 has a 5-60s timeout. Running 10 in parallel would fork-bomb
  // the member server. Same rationale as ad-commands-drainer.
  for (const cmd of commands) {
    processed++;
    const commandId = cmd.id;
    const commandType = cmd.commandType;
    // dispatchMemberCommand always resolves (NEVER throws) — synthesizes
    // {success:false, error, exitCode} on any internal failure.
    const result = await dispatchMemberCommand({
      commandType,
      params: cmd.params ?? {},
      timeoutMs,
      logger,
    });
    if (result.success) succeeded++;
    else failed++;

    // 3) POST the result back to center. Failure is logged at warn —
    // does NOT throw because the row is already claimed on the center
    // side (status='running'). sweepTimeouts will eventually flip it
    // to 'timeout' if we never ack; the next operator retry would
    // then queue a fresh row.
    try {
      const ack = await httpPostJson({
        url: `${centerUrl}/api/agent/member-commands/${commandId}/result`,
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
        }, 'member-command result posted');
      } else {
        logger?.warn?.({
          commandId,
          commandType,
          status: ack.status,
        }, 'member-command result POST failed (next sweep will retry)');
      }
    } catch (e) {
      logger?.warn?.({ err: e.message, commandId }, 'member-command result POST threw');
    }
  }

  return { processed, succeeded, failed };
}

export const __testing = { drainMemberCommands };