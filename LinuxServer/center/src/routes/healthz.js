import { Router } from 'express';
import { getDb } from '../db/index.js';

// R120 fix-up — healthz factory now takes { logger } so the catch can emit
// a debug-level event. Healthz is polled every 1s by NSSM and external probes,
// so we MUST stay at debug level: a warn/info log per failed healthcheck would
// flood logs at 60×N DCs/min. The 503 status response itself IS the operator
// signal (NSSM restart cadence is gated on consecutive 503s, not on logs).
//
// The previous pattern (no logger call) was allowed by the audit as a
// "Health-probe silent-on-failure convention" allowlist entry — but
// operator-facing observability wins over log-suppression concerns when
// there's a free debug-level escape hatch. Run-all-dimensions re-scan
// should remove this allowlist entry.
//
// S14 (2026-09-30) — strip DB query from /healthz. Healthz was doing
// db.healthcheck() + db.query(lastHeartbeat) per request. With NSSM +
// browser-based devtools / monitor polls + page-load health pings, /healthz
// alone was generating ~1-3 req/s × 2 DB round-trips = 2-6 req/s against
// the pool — on top of the agent heartbeat fan-out. The native stack
// from the 4 GB OOM showed libuv timer-wheel symbols (uv_timer_set_repeat)
// clustered inside V8's Mark-Compact, indicating the heap pressure was
// coming from the event-loop / timer queue that healthz polling feeds
// (every timer-driven request creates a Promise.then + res.on('finish')
// chain that holds its closure alive). The simpler fix: /healthz now
// only checks db.healthcheck() (1 round-trip). lastHeartbeat moved to
// /api/dashboard/last-heartbeat which is dashboard-only and doesn't fire
// on the polling cadence.
export function healthzRouter({ logger }) {
  const r = Router();
  r.get('/healthz', async (_req, res) => {
    try {
      const db = getDb();
      await db.healthcheck();
      res.json({
        status: 'ok',
        db: 'ok',
        dialect: db.dialect
      });
    } catch (e) {
      // debug level — never floods because healthz is rarely failing in
      // steady state; if it IS failing continuously, the operator has
      // bigger problems than this log line.
      logger?.debug?.({ event: 'healthz.degraded', err: e.message }, 'healthz degraded');
      res.status(503).json({ status: 'degraded', error: e.message });
    }
  });
  return r;
}
