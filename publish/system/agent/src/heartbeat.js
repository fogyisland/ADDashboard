// startHeartbeat fires `send(payload())` on an interval and immediately on start.
// Errors thrown by `send` are swallowed silently — the scheduler's tick has its
// own logging, and this heartbeat is intentionally fire-and-forget.
export function startHeartbeat({ intervalMs, payload, send }) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try { await send(payload()); } catch { /* swallowed intentionally */ }
  };
  const h = setInterval(tick, intervalMs);
  // Fire immediately. tick() returns a promise; we don't await — fire-and-forget.
  tick();
  return {
    stop() {
      stopped = true;
      clearInterval(h);
    }
  };
}