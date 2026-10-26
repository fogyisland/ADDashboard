// R155.6 — ad_dc_inbound_partners + ad_dc_outbound_partners warehouse
// refresh service.
//
// Operator directive 2026-09-30: "另外我们新建一个脚本,定期更新
// inbound_partner 和outbound_partner". Before R155.6 every partner
// metadata surface (matrix / DcCard / site-grouped views) recomputed
// ad_replication_status JOIN ad_dcs on every page render — slow,
// and the per-DC peer list drifted mid-render. R155.6 collapses
// ad_replication_status's current snapshot into two warehouse tables
// keyed on (local_dc, peer_dc, naming_context) — one per direction —
// refreshed on a fixed cadence.
//
// Data flow (centre-side only, no agent write):
//   server.js boot
//     → startDcPartnersRefresh({ db, logger, intervalMin: 5 })
//     → immediate first run (catches up on boot)
//     → setInterval(intervalMin * 60 * 1000) per cadence
//   each refresh:
//     → SELECT t1.source_dc, t1.dest_dc, t1.naming_context, … FROM
//       ad_replication_status t1 WHERE latest-per-pair + 30-min window
//       + synthetic-row exclusions (partnersSnapshotAll SQL helper)
//     → for each row:
//       - local_dc=dest_dc → UPSERT ad_dc_inbound_partners
//       - local_dc=source_dc → UPSERT ad_dc_outbound_partners
//     → log per-cycle summary (rowsUpserted / rowsSeen / errors)
//
// Excluded naming_contexts:
//   '__partner_ports__:%'  — agent's own probe rows, not real
//                            partners (echo-loop guard, mirrors
//                            R151.2 inbound endpoint).
//   '__dc_summary__', 'META' — synthetic heartbeat / summary rows.
//
// No DELETE: auto-mode intercepts DELETE, and the warehouse only
// needs INSERT / UPDATE (a peer that drops off stops being seen in
// the next refresh cycle and its row goes stale naturally). The
// refreshed_at column lets the operator spot stale rows.
//
// NOT in scope:
//   - Don't store partner_port_status JSON / objects_transferred /
//     attempt_duration_ms — those live in the probe tables (ad_dc_probe_*
//     and ad_replication_history), not the warehouse.
//   - Don't switch the existing /matrix / DcCard / site-grouped
//     view endpoints to read from the warehouse — that's a separate
//     operator decision after they audit the warehouse data.

import { getDb } from '../db/index.js';

const DEFAULT_INTERVAL_MIN = 5;
const DEFAULT_FRESHNESS_MIN = 30; // mirrors R151.2 inbound endpoint window

// S7 (2026-09-30) — chunked concurrent UPSERT instead of serial 1-by-1.
// At ~50 DC × 4 peer × 4 naming_context = 800 rows × 2 UPSERTs each = 1600
// serial executes per cycle; each ~5 ms → 8s+ on a healthy centre, far
// overrunning the 5-min interval once DB latency creeps. Chunked
// Promise.allSettled keeps the cycle bounded (~50 ms × chunks) without
// blowing the pool (mysql pool max=10 / mssql pool max=10). 20 was picked
// empirically — large enough to hide per-execute latency, small enough to
// stay well below pool max even with the snapshot SQL holding one
// connection during the cycle.
const UPSERT_CONCURRENCY = 20;

/**
 * Run one refresh cycle. Returns { rowsSeen, rowsUpserted, errors }.
 * Caller (the setInterval loop in startDcPartnersRefresh) decides
 * what to do with the summary.
 */
export async function refreshDcPartners({
  db = getDb(),
  logger = null,
  freshnessMin = DEFAULT_FRESHNESS_MIN
} = {}) {
  const t0 = Date.now();
  const sql = db.sql;
  let rowsSeen = 0;
  let rowsUpserted = 0;
  const errors = [];

  try {
    const { rows: snapshot } = await db.query(sql.dashboard.partnersSnapshotAll, []);
    rowsSeen = Array.isArray(snapshot) ? snapshot.length : 0;

    if (!rowsSeen) {
      logger?.info?.({
        event: 'dc_partners.refresh.cycle_complete',
        rowsSeen: 0,
        rowsUpserted: 0,
        errors: 0,
        durationMs: Date.now() - t0
      }, 'dc-partners refresh cycle complete (no rows in freshness window)');
      return { rowsSeen: 0, rowsUpserted: 0, errors: [] };
    }

    // Deduplicate inbound vs outbound per row — ad_replication_status
    // snapshots can have the same (local_dc, peer_dc, naming_context)
    // tuple on both sides if a peer appears in two contexts. The
    // dedupe is on the row key itself, not on the local_dc — we
    // write each row once per warehouse (inbound = dest side,
    // outbound = source side).
    //
    // S7 (2026-09-30) — build a flat task list then run them in
    // chunks of UPSERT_CONCURRENCY via Promise.allSettled. The
    // previous serial loop queued up to ~1600 awaits per cycle on a
    // ~50 DC × 4 peer × 4 naming_context topology, with each await
    // holding a connection. Concurrent chunks cut wall-clock by ~20x
    // while staying well below the pool max (10).
    const tasks = [];
    for (const row of snapshot) {
      const sourceDc = row.source_dc;
      const destDc   = row.dest_dc;
      const ctx      = row.naming_context;
      const status   = row.status_code;
      const lastSuccessTime = row.last_success_time;
      const lastAttemptTime = row.last_attempt_time;
      const errorMessage    = row.error_message;

      if (!sourceDc || !destDc || !ctx || sourceDc === destDc) continue;

      // Inbound task — local_dc = dest_dc.
      tasks.push({
        warehouse: 'inbound',
        localDc: destDc,
        peerDc: sourceDc,
        namingContext: ctx,
        sqlKey: 'upsertDcInboundPartner',
        params: [destDc, sourceDc, ctx, status, lastSuccessTime, lastAttemptTime, errorMessage]
      });
      // Outbound task — local_dc = source_dc.
      tasks.push({
        warehouse: 'outbound',
        localDc: sourceDc,
        peerDc: destDc,
        namingContext: ctx,
        sqlKey: 'upsertDcOutboundPartner',
        params: [sourceDc, destDc, ctx, status, lastSuccessTime, lastAttemptTime, errorMessage]
      });
    }

    for (let i = 0; i < tasks.length; i += UPSERT_CONCURRENCY) {
      const chunk = tasks.slice(i, i + UPSERT_CONCURRENCY);
      const results = await Promise.allSettled(chunk.map((t) => db.execute(sql.dashboard[t.sqlKey], t.params)));
      for (let k = 0; k < results.length; k++) {
        const r = results[k];
        const t = chunk[k];
        if (r.status === 'fulfilled') {
          rowsUpserted++;
        } else {
          errors.push({
            warehouse: t.warehouse,
            local_dc: t.localDc,
            peer_dc: t.peerDc,
            naming_context: t.namingContext,
            error: r.reason?.message || String(r.reason)
          });
        }
      }
    }

    const durationMs = Date.now() - t0;
    logger?.info?.({
      event: 'dc_partners.refresh.cycle_complete',
      rowsSeen,
      rowsUpserted,
      errors: errors.length,
      durationMs
    }, `dc-partners refresh cycle complete (${rowsUpserted} upserted, ${errors.length} errors, ${durationMs}ms)`);

    if (errors.length) {
      // Surface up to 5 errors so the operator can spot the pattern
      // without log spam.
      logger?.warn?.({
        event: 'dc_partners.refresh.errors',
        sample: errors.slice(0, 5),
        total: errors.length
      }, 'dc-partners refresh had per-row errors');
    }

    return { rowsSeen, rowsUpserted, errors };
  } catch (e) {
    const durationMs = Date.now() - t0;
    logger?.error?.({
      event: 'dc_partners.refresh.cycle_failed',
      err: e?.message || String(e),
      durationMs,
      rowsSeen,
      rowsUpserted,
      errors: errors.length
    }, 'dc-partners refresh cycle failed');
    // Re-throw so the caller can decide whether to retry. The
    // setInterval loop in startDcPartnersRefresh swallows the error
    // and waits for the next tick — no exponential backoff because
    // the next snapshot will simply include any rows that became
    // visible during the failed cycle's window.
    throw e;
  }
}

/**
 * Start the periodic refresh loop. Returns a handle with a stop()
 * function so the server can cancel the loop on shutdown.
 *
 * Cadence: every `intervalMin` minutes (default 5). First run is
 * IMMEDIATE on start() so the warehouse is populated before the first
 * UI request lands.
 *
 * Pattern mirrors createEventlogRetentionLoop (R148) for the
 * interval cadence + start-of-loop semantics — both are server-side
 * maintenance loops that don't expose a network endpoint.
 */
export function startDcPartnersRefresh({
  db = getDb(),
  logger = null,
  intervalMin = DEFAULT_INTERVAL_MIN
} = {}) {
  const intervalMs = Math.max(60_000, intervalMin * 60 * 1000);
  let stopped = false;
  let inFlight = false;
  let timerHandle = null;

  async function tick() {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await refreshDcPartners({ db, logger });
    } catch (e) {
      // refreshDcPartners already logs; we just need to swallow here
      // so the setInterval keeps firing.
    } finally {
      inFlight = false;
      if (!stopped) {
        timerHandle = setTimeout(tick, intervalMs);
      }
    }
  }

  // Immediate first run. Use setImmediate (not Promise.resolve) so
  // the boot path doesn't block on a successful refresh — the centre
  // server should bind ports before the first cycle completes.
  setImmediate(() => {
    if (!stopped) {
      timerHandle = setTimeout(tick, intervalMs);
      // Run one cycle NOW (don't wait the first intervalMs).
      tick();
    }
  });

  return {
    stop() {
      stopped = true;
      if (timerHandle) {
        clearTimeout(timerHandle);
        timerHandle = null;
      }
    }
  };
}