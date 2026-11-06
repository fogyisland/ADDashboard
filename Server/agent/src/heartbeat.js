// startHeartbeat fires `send(payload())` on an interval and immediately on start.
// Errors thrown by `send` are swallowed silently — the scheduler's tick has its
// own logging, and this heartbeat is intentionally fire-and-forget.
//
// R158.X.99 (2026-10-21) — 2 real defects fixed:
//
// (1) restart() was missing. settings-delivery.js calls heartbeat.restart()
//     when the centre pushes a new heartbeatIntervalSeconds, but the handle
//     returned here only had stop(). The TypeError was swallowed by
//     applySettingsDelivery's try/catch, which returned restarted:false —
//     so the new interval got persisted to appsettings.json while the
//     running heartbeat kept the old cadence, failing again on every tick.
//     Latent since R158.13 (2026-10-01).
//
// (2) Tick overlap. setInterval does not await an async tick. If send()
//     takes longer than intervalMs (60s default, but reporter timeoutMs can
//     exceed that), concurrent heartbeats race the centre's token rotation.
//     An inFlight gate caps this at one in-flight send; a skipped tick is
//     not replayed, since a heartbeat is a state report and not a queue.
//
// restart() clears the old timer, starts the new one, and fires once
// immediately — a centre-side interval reduction should take effect at once
// rather than after the remainder of the old period.
export function startHeartbeat({ intervalMs, payload, send }) {
  let stopped = false;
  let inFlight = false;

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await send(payload());
    } catch {
      /* swallowed intentionally */
    } finally {
      inFlight = false;
    }
  };

  let current = intervalMs;
  let h = setInterval(tick, current);
  tick();

  return {
    stop() {
      stopped = true;
      clearInterval(h);
    },
    // Rejects invalid intervals instead of applying them: setInterval(fn, NaN)
    // degrades to a 1ms poll in Node and would hammer the centre.
    restart({ intervalMs: next } = {}) {
      if (stopped) return false;
      const n = Number(next);
      if (!Number.isFinite(n) || n <= 0) return false;
      current = n;
      clearInterval(h);
      h = setInterval(tick, current);
      tick();
      return true;
    },
    currentIntervalMs() {
      return current;
    }
  };
}