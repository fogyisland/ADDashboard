// center/src/services/report-retention.js
// R158.61 (2026-10-10) — Daily / weekly report history retention.
//
// createReportRetentionLoop({ db, getIntervalSeconds, getSystemConfig, logger })
//   → { start, stop, tick, isRunning }
//
// Same factory shape as createEmailDeliveryLoop / createReportLoop. Reads
// `ad_mgmt_retention_days` from system_config on every tick (default 30;
// <= 0 disables the sweep). Tick cadence is 24h. Per tick:
//
//   1. Read ad_mgmt_retention_days (default 30).
//   2. Compute cutoff = now - days.
//   3. Chunked DELETE on daily_reports WHERE period_end < cutoff, capped
//      at 5000 rows / tick (R45.13 pattern — center's other retention
//      loops use the same cap). Loop until affected === 0 OR a single
//      tick exceeds MAX_TICK_MS (10s) to keep NSSM shutdown clean.
//
// `daily_reports` is append-only from a user perspective, so this loop
// is the only writer that does DELETE on it. `report_subscriptions` is
// not touched (operator-managed, no retention).
//
// R158.107 (2026-10-16) — 改读 ad_mgmt_retention_days (8 service 统一单点).
//   旧 report_retention_days 字段 ship 时一次性 DELETE migration 移除.

const DEFAULT_RETENTION_DAYS = 30;
const TICK_INTERVAL_DEFAULT_SEC = 24 * 3600;
const CHUNKED_DELETE_LIMIT = 5000;
const MAX_TICK_MS = 10_000;

export function createReportRetentionLoop({ db, getIntervalSeconds, getSystemConfig, logger }) {
  const log = logger?.child ? logger.child({ component: 'report-retention' }) : null;
  const logInfo = (msg, meta) => {
    if (log) log.info(meta || {}, msg);
    else console.log(`[report-retention] ${msg}`);
  };
  const logError = (err, msg) => {
    if (log) log.error({ err: err?.message }, msg);
    else console.error(`[report-retention] ${msg}: ${err?.message || err}`);
  };

  let interval = null;
  let inFlight = null;
  let tickInFlight = false;
  let running = false;

  async function runChunkedDelete(cutoffDate) {
    // daily_reports has an idx_dr_period (period_end ASC) so the
    // DELETE ORDER BY period_end ASC is index-served on mssql and mysql.
    // The SQL helper is a single-statement capped DELETE — see
    // sql/reports.js reportRun.deleteOlderThan. The result shape varies:
    //   mysql: result.affectedRows
    //   mssql: result.rowsAffected[0] (tedious returns rowsAffected as [int])
    let totalDeleted = 0;
    const tickStart = Date.now();
    while (Date.now() - tickStart < MAX_TICK_MS) {
      const result = await db.execute(db.sql.reportRun.deleteOlderThan[db.dialect], [cutoffDate]);
      const affected = result?.affectedRows
        ?? result?.rowsAffected?.[0]
        ?? result?.recordset?.[0]?.affected
        ?? 0;
      if (!affected) break;
      totalDeleted += affected;
      if (affected < CHUNKED_DELETE_LIMIT) break;       // last partial chunk
      // Full chunk — there might be more. Loop again with the same cutoff.
    }
    return totalDeleted;
  }

  async function tick() {
    if (tickInFlight) {
      logError(new Error('previous tick still in flight'), 'tick skipped');
      return;
    }
    tickInFlight = true;
    try {
      let days = DEFAULT_RETENTION_DAYS;
      try {
        const cfg = await getSystemConfig();
        // R158.107 — 改读 ad_mgmt_retention_days (8 service 统一单点)
        const raw = cfg?.ad_mgmt_retention_days;
        const parsed = Number(raw);
        if (Number.isFinite(parsed) && parsed > 0) { days = Math.floor(parsed); /* R158.X.99.32 (2026-10-19) — defensive floor guard */ if (days < 1) { return { skipped: true, reason: 'ad_mgmt_retention_days < 1 (defensive floor)' }; } }
        else if (Number.isFinite(parsed) && parsed <= 0) {
          // operator disabled retention explicitly
          return;
        }
      } catch (e) {
        logError(e, 'getSystemConfig failed; using default 30d');
      }
      const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
      const deleted = await runChunkedDelete(cutoff);
      if (deleted > 0) {
        logInfo(`purged ${deleted} old report rows older than ${cutoff.toISOString()}`);
      }
    } catch (e) {
      logError(e, 'tick failed');
    } finally {
      tickInFlight = false;
    }
  }

  function start() {
    if (running) return;
    running = true;
    Promise.resolve(getIntervalSeconds()).then((raw) => {
      if (!running) return;
      const intervalSec = Math.max(10, Number(raw) || TICK_INTERVAL_DEFAULT_SEC);
      logInfo(`report retention loop started, ${intervalSec}s cadence, ${CHUNKED_DELETE_LIMIT}/chunk`);
      interval = setInterval(() => {
        inFlight = tick().catch((e) => logError(e, 'tick failed'));
      }, intervalSec * 1000);
    }).catch((e) => logError(e, 'start failed'));
  }

  async function stop() {
    running = false;
    if (interval) clearInterval(interval);
    interval = null;
    if (inFlight) await inFlight.catch(() => {});
    inFlight = null;
  }

  return { start, stop, tick, isRunning: () => running };
}
