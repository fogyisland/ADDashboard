// center/src/services/ad-account-change-retention.js
// R158.72 (2026-10-11) — ad_account_change 公共表 retention sweep.
//
// createAdAccountChangeRetentionLoop({ db, getSystemConfig, logger })
//   → { start, stop, tick, isRunning }
//
// 跟 createReportRetentionLoop / createEmailHistoryRetentionLoop 同 factory
// shape. Reads `ad_mgmt_retention_days` from system_config on every
// tick (default 30, <=0 disables). Tick cadence is 24h. Per tick:
//
//   1. Read ad_mgmt_retention_days (default 30).
//   2. Compute cutoff_date (DATE 比较列, 不传 timestamp) via db.sql helper.
//   3. Chunked DELETE on ad_account_change WHERE change_date < cutoff.
//      cap 5000 rows/tick, MAX_TICK_MS 10s 兜底.
//
// R158.107 (2026-10-16) — 改读 ad_mgmt_retention_days (8 service 统一单点).
//   删 ensureDefaultRow (audit-ad-mgmt-audit-retention lazy-insert 兜底,
//   重复 INSERT 收益=0). 旧 ad_account_change_retention_days 字段 ship 时
//   一次性 DELETE migration 移除.

const DEFAULT_RETENTION_DAYS = 30;
const TICK_INTERVAL_DEFAULT_SEC = 24 * 3600;
const CHUNKED_DELETE_LIMIT = 5000;
const MAX_TICK_MS = 10_000;
const RETENTION_KEY = 'ad_mgmt_retention_days';

export function createAdAccountChangeRetentionLoop({ db, getSystemConfig, logger }) {
  const log = logger?.child ? logger.child({ component: 'ad-account-change-retention' }) : null;
  const logInfo = (msg, meta) => {
    if (log) log.info(meta || {}, msg);
    else console.log(`[ad-account-change-retention] ${msg}`);
  };
  const logError = (err, msg) => {
    if (log) log.error({ err: err?.message }, msg);
    else console.error(`[ad-account-change-retention] ${msg}: ${err?.message || err}`);
  };

  let interval = null;
  let inFlight = null;
  let tickInFlight = false;
  let running = false;

  // R158.107 — ensureDefaultRow 删 (audit ad_mgmt_retention_days lazy-insert 兜底)

  async function runChunkedDelete(days) {
    // db.sql.adAccountChange.deleteOlderThan is dialect-keyed: { mysql, mssql }.
    // Caller picks via db.dialect.
    const stmt = db.sql.adAccountChange.deleteOlderThan?.[db.dialect];
    if (!stmt) {
      logError(new Error(`deleteOlderThan missing for dialect ${db.dialect}`), 'SQL helper missing');
      return 0;
    }
    let totalDeleted = 0;
    const tickStart = Date.now();
    while (Date.now() - tickStart < MAX_TICK_MS) {
      const result = await db.execute(stmt, [days]);
      const affected = result?.affectedRows
        ?? result?.rowsAffected?.[0]
        ?? result?.recordset?.[0]?.affected
        ?? 0;
      if (!affected) break;
      totalDeleted += affected;
      if (affected < CHUNKED_DELETE_LIMIT) break;
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
      // R158.107 — 删 ensureDefaultRow 调用
      let days = DEFAULT_RETENTION_DAYS;
      try {
        const cfg = await getSystemConfig();
        // R158.107 — 改读 ad_mgmt_retention_days
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
      const deleted = await runChunkedDelete(days);
      if (deleted > 0) {
        logInfo(`purged ${deleted} old ad_account_change rows older than ${days}d`);
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
    logInfo(`ad-account-change retention loop started, ${TICK_INTERVAL_DEFAULT_SEC}s cadence, ${CHUNKED_DELETE_LIMIT}/chunk`);
    interval = setInterval(() => {
      inFlight = tick().catch((e) => logError(e, 'tick failed'));
    }, TICK_INTERVAL_DEFAULT_SEC * 1000);
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