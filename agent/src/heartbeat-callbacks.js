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
// NOTE on the COALESCE bug (T-fix follow-up): T6 picked Option A — the T2
// SQL uses COALESCE/ISNULL to preserve the column when the bound value is
// null. So the `report_requested_at: null` we emit here will NOT actually
// clear the column on the center side. The flag stays set → every subsequent
// heartbeat response carries reportRequested: true → send() calls
// scheduler._tick() on EVERY heartbeat (every 5s), not just once.
// _tick() is idempotent (scheduler dedupes concurrent runs), so this is
// wasteful (CPU + network) but not destructive. The fix lands in T-fix.

export function makeSendCallback({ postHeartbeat, applyAgentTokenDelivery, scheduler, logger, getPendingClear, setPendingClear }) {
  return async function send(payload) {
    const r = await postHeartbeat(payload);
    await applyAgentTokenDelivery({ result: r, payload, logger });

    // Strict === true: a truthy non-boolean (e.g. a stale string from a
    // version-mismatched center) must not trigger a re-tick.
    if (r && r.data && r.data.reportRequested === true) {
      try {
        await scheduler._tick();
        // Only arm the clear on a successful tick — a failed tick keeps
        // the flag set, so the next heartbeat retries.
        setPendingClear(true);
      } catch (e) {
        logger.warn({ err: e.message }, 'scheduler._tick() after reportRequested failed; flag stays set');
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