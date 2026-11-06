// R114 — scheduler bootstrap: lifecycle wrapper for the centre-side port
// probe scheduler.
//
// Spec: docs/superpowers/specs/2026-09-26-r114-centre-remote-port-probe-design.md §3
//
// Why this exists:
//   server.js used to instantiate schedulers inline (probeLoop, alertLoop,
//   emailLoop, auditRetentionLoop, eventlogRetentionLoop) — each with its
//   own stop() in the shutdown handler. R114 adds one more (portProbe), and
//   the inline list is getting long. This module centralises "start all
//   schedulers" + "stop all schedulers" so server.js stays focused on
//   Express lifecycle (build, listen, SIGTERM).
//
// startSchedulers() returns a `{ schedulers: { portProbe, ... } }` shape
// keyed by name so the shutdown handler can stop them individually if
// needed (e.g. one of them throws on stop and we want the others to still
// stop). stopSchedulers() iterates the same shape in reverse registration
// order — newest first so older schedulers stay running while newer ones
// drain.
//
// Re-entrancy: each underlying scheduler owns its own re-entrancy guard
// (the port-probe-scheduler has a `running` boolean; the loops created by
// probe.js / system-alert-engine.js / email.js / audit.js / eventlog.js have
// their own in-flight guards). This wrapper does NOT add a wrapper-level
// guard — the underlying schedulers are independent units.

import { startPortProbeScheduler } from '../services/port-probe-scheduler.js';

/**
 * Start all R114+ schedulers.
 *
 * @param {object} opts
 * @param {object} opts.db — drizzle-style db wrapper (must expose .execute + .sql.systemSettings)
 * @param {object} opts.log — pino-compatible logger
 * @returns {{
 *   schedulers: Record<string, { stop: () => void|Promise<void> }>
 * }}
 */
export function startSchedulers({ db, log } = {}) {
  const schedulers = {};

  // R114 — centre-side port probe. tcpProbe default in scheduler.js uses
  // Node's net.Socket; tests pass an injected stub via startPortProbeScheduler.
  schedulers.portProbe = startPortProbeScheduler({ db, log });

  // Fire-and-forget; the scheduler's own start() returns synchronously and
  // kicks off a 5s-delayed first cycle. We do NOT await it — same shape
  // as the inline `probeLoop.start()` / `alertLoop.start()` in server.js.
  for (const [name, s] of Object.entries(schedulers)) {
    if (typeof s.start === 'function') {
      try {
        s.start();
      } catch (e) {
        log?.error?.({ event: 'scheduler.start.fail', name, err: e.message }, 'scheduler start failed');
      }
    }
  }

  return { schedulers };
}

/**
 * Stop all schedulers created by startSchedulers. Reverses registration
 * order so the newest scheduler drains first. Errors are caught per
 * scheduler so one failure doesn't strand the others.
 *
 * @param {object} opts
 * @param {Record<string, { stop: () => void|Promise<void> }>} opts.schedulers
 * @param {object} opts.log
 */
export async function stopSchedulers({ schedulers, log } = {}) {
  if (!schedulers || typeof schedulers !== 'object') return;
  const names = Object.keys(schedulers).reverse();
  for (const name of names) {
    const s = schedulers[name];
    if (!s || typeof s.stop !== 'function') continue;
    try {
      await s.stop();
    } catch (e) {
      log?.warn?.({ event: 'scheduler.stop.fail', name, err: e.message }, 'scheduler stop failed (continuing)');
    }
  }
}
