// 2026-08-24 round-12: heartbeat send/payload callbacks that consume the
// center's reportRequested flag and arm a one-shot clear on the next
// heartbeat. Factored out of agent.js so they can be unit-tested in
// isolation without spinning up the full agent runtime.
//
// Module isolation: this module owns NO state. The pendingReportRequestClear
// flag lives in agent.js scope (closure-captured `let`) and is passed in via
// `getPendingClear` / `setPendingClear` so the caller controls lifecycle and
// the unit tests can substitute their own backing store.
//
// T-fix landed (2026-08-25): the centre now splits `undefined` (preserve via
// UPSERT COALESCE) from explicit `null` (clearReportRequest UPDATE), so the
// one-shot `setPendingClear(false)` arming below actually wipes the column
// on the next heartbeat — subsequent responses carry reportRequested: false
// and _tick() stops firing.
//
// 2026-08-25: scheduler._tick() is now deduped via an in-flight promise
// (see scheduler.js). Concurrent invocations share the same in-progress
// promise and don't stack parallel collect() runs.
//
// 2026-08-25 round-12 report-now fan-out: when reportRequested=true, the
// operator clicked 回报 to push every category of data at once. Fan out
// in parallel to three collectors:
//   - scheduler._tick()           → replication partners + status  (ad_replication_status)
//   - discovery.run()             → DC inventory upsert           (ad_dcs)
//   - packageManager.runAllNow()  → all installed packages        (pkg_*_*.metrics)
// Each collector owns its own table + log line; this module just orchestrates
// the parallel fan-out. Promise.allSettled (not Promise.all) so one
// collector failing doesn't block the other two. The clear flag arms once
// all three have settled — center's "I saw your request" semantic —
// regardless of individual outcomes. Per-collector failure is logged at
// the collector level (runOne / postDiscovery / scheduler already log
// their own failures); we add a top-level summary log here for
// observability of the fan-out as a whole.

export function makeSendCallback({
  postHeartbeat,
  applyAgentTokenDelivery,
  scheduler,
  logger,
  getPendingClear,
  setPendingClear,
  // 2026-08-25: optional callbacks. Non-AD runtime / tests can omit them;
  // falsy values short-circuit to Promise.resolve() so allSettled still
  // resolves cleanly. Each callback is responsible for its own internal
  // error handling (the agent.js wiring wraps discovery.run with
  // try/catch; runAllNow uses Promise.allSettled internally).
  runDiscovery,
  runPackages
}) {
  return async function send(payload) {
    const r = await postHeartbeat(payload);
    await applyAgentTokenDelivery({ result: r, payload, logger });

    // Strict === true: a truthy non-boolean (e.g. a stale string from a
    // version-mismatched center) must not trigger a re-tick.
    if (r && r.data && r.data.reportRequested === true) {
      const fanOutStartedAt = new Date();
      try {
        const settled = await Promise.allSettled([
          scheduler._tick(),
          // Falsy → no-op. Keeps non-AD / test wiring compact without
          // branching on agentType here.
          runDiscovery ? runDiscovery() : Promise.resolve(),
          runPackages ? runPackages() : Promise.resolve()
        ]);
        // 2026-08-25 round-12: log the fan-out summary. The collector-level
        // logs (package.run, runDiscovery stderr, scheduler WARN) already
        // capture per-collector detail; this top-level line is the one an
        // operator greps when asking "did the click actually do anything".
        const finishedAt = new Date();
        const summary = settled.map((s, i) => ({
          collector: ['replication', 'discovery', 'packages'][i],
          status: s.status,
          error: s.status === 'rejected' ? String(s.reason?.message || s.reason) : null
        }));
        logger.info({
          event: 'report-now.fanOut',
          startedAt: fanOutStartedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs: finishedAt - fanOutStartedAt,
          summary
        }, 'report-now fan-out complete');
        // All three settled (success OR failure) → arm the clear. Per the
        // user spec: each collector independently writes to its own table;
        // the clear-flag semantic is "operator's request was processed",
        // not "all data landed cleanly". A 503 from /api/agent/discover
        // should NOT cause the agent to hammer the center with another
        // full fan-out — the collector already logged the failure for the
        // operator's dashboard.
        setPendingClear(true);
      } catch (e) {
        // Promise.allSettled never rejects, so this catch only fires for
        // a sync throw from the outer setup (e.g., scheduler._tick is
        // missing). Preserve the existing "fail = leave flag set, retry
        // next heartbeat" semantics from T-fix.
        logger.warn({ err: e.message }, 'report-now fan-out threw; flag stays set');
      }
    }
  };
}

export function makePayload({ getPendingClear, setPendingClear }) {
  return function payload(basePayload) {
    const p = { ...basePayload };
    if (getPendingClear()) {
      p.report_requested_at = null;
      // One-shot: emit once, then reset so we don't keep sending null on
      // every heartbeat (the field would otherwise loop forever given the
      // COALESCE bug noted above).
      setPendingClear(false);
    }
    return p;
  };
}