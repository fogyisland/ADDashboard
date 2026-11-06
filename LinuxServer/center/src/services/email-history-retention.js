// center/src/services/email-history-retention.js
// R158.69 (2026-10-10) — Email outbox retention sweep (跨 system_alert_outbox +
// report_email_outbox 两表). 跟 createReportRetentionLoop 同 factory shape.
//
// createEmailHistoryRetentionLoop({ db, getIntervalSeconds, getSystemConfig, logger })
//   → { start, stop, tick, isRunning }
//
// Reads `ad_mgmt_retention_days` from system_config on every tick
// (default 30; <= 0 disables the sweep). Tick cadence is 24h. Per tick:
//
//   1. Read ad_mgmt_retention_days (default 30).
//   2. Compute cutoff = now - days.
//   3. Chunked DELETE on system_alert_outbox WHERE sent_at < cutoff, capped at
//      5000 rows / tick (R45.13 pattern). Loop until affected === 0 OR a single
//      tick exceeds MAX_TICK_MS (10s) to keep NSSM shutdown clean.
//   4. Same for report_email_outbox + ad_notify_outbox (R158.100.C).
//
// R158.107 (2026-10-16) — 改读 ad_mgmt_retention_days (8 service 统一单点).
//   删 ensureDefaultRow (audit-ad-mgmt-audit-retention 已有 lazy-insert
//   ad_mgmt_retention_days=30 兜底, 重复 INSERT 收益=0). 旧
//   email_history_retention_days 字段 ship 时一次性 DELETE migration 移除.

const DEFAULT_RETENTION_DAYS = 30;
const TICK_INTERVAL_DEFAULT_SEC = 24 * 3600;
const CHUNKED_DELETE_LIMIT = 5000;
const MAX_TICK_MS = 10_000;
const RETENTION_KEY = 'ad_mgmt_retention_days';

export function createEmailHistoryRetentionLoop({ db, getIntervalSeconds, getSystemConfig, logger }) {
  const log = logger?.child ? logger.child({ component: 'email-history-retention' }) : null;
  const logInfo = (msg, meta) => {
    if (log) log.info(meta || {}, msg);
    else console.log(`[email-history-retention] ${msg}`);
  };
  const logError = (err, msg) => {
    if (log) log.error({ err: err?.message }, msg);
    else console.error(`[email-history-retention] ${msg}: ${err?.message || err}`);
  };

  let interval = null;
  let inFlight = null;
  let tickInFlight = false;
  let running = false;

  // R158.107 — ensureDefaultRow 删 (audit ad_mgmt_retention_days lazy-insert
  // 兜底, 重复 INSERT 收益=0). 若 production 上 ad_mgmt_retention_days row
  // 缺, audit loop 第一次 tick 会自动 seed, 这里读 cfg 走 default 30d 即可.

  // Chunked DELETE for one outbox table. R158.100.C (2026-10-14) — 改
  //   接受 sqlHelper object (而非 helperKey), 让 ad_notify_outbox 走
  //   db.sql.adNotifyOutbox.purgeAdNotifyOlderThan (跟 emailHistory
  //   1:1 平行形态). R158.100.C 跟 R158.100.B 1:1 平行 SQL helper 命名.
  //   ⚠ 0 加 [db.dialect]: sql.js 全部 64 个 domain 都是**摊平**注册
  //   (`emailHistory: emailHistory.mysql`, buildSql 已选定), 二级下标必 undefined.
  //   Result shape varies by dialect:
  //   mysql: result.affectedRows
  //   mssql: result.rowsAffected[0] (tedious returns rowsAffected as [int])
  //
  // We pass `days` (int) to the helper, not a Date — the SQL uses
  // `DATEADD(DAY, -?, SYSUTCDATETIME())` / `DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY)`
  // so an INT day count is what the placeholder needs.
  async function runChunkedDelete(sqlHelper, tableLabel, days) {
    let totalDeleted = 0;
    const tickStart = Date.now();
    while (Date.now() - tickStart < MAX_TICK_MS) {
      const sql = sqlHelper(days);
      const result = await db.execute(sql, [days]);
      const affected = result?.affectedRows
        ?? result?.rowsAffected?.[0]
        ?? result?.recordset?.[0]?.affected
        ?? 0;
      if (!affected) break;
      totalDeleted += affected;
      if (affected < CHUNKED_DELETE_LIMIT) break;       // last partial chunk
    }
    if (totalDeleted > 0) logInfo(`purged ${totalDeleted} old ${tableLabel} rows`);
    return totalDeleted;
  }

  async function tick() {
    if (tickInFlight) {
      logError(new Error('previous tick still in flight'), 'tick skipped');
      return;
    }
    tickInFlight = true;
    try {
      // R158.107 — 删 ensureDefaultRow 调用, audit loop 兜底
      let days = DEFAULT_RETENTION_DAYS;
      try {
        const cfg = await getSystemConfig();
        const raw = cfg?.[RETENTION_KEY];
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
      logInfo(`retention sweep starting, cutoff=${cutoff.toISOString()} (days=${days})`);
      // Both tables use the same days value; each helper takes an int day count.
      // R158.100.C (2026-10-14) — 3 表 sweep, capacity 跟 emailLoop UNION 1:1.
      //   ⚠ db.sql.emailHistory / .adNotifyOutbox 在 sql.js:3052/:3043 注册的是
      //   **摊平**形态 (`emailHistory: emailHistory.mysql` —— buildSql 已按
      //   dialect 选定), 所以 0 走 `[db.dialect]` 二级下标: 那等于拿 query
      //   字符串当对象再取属性 → undefined → runChunkedDelete 抛 TypeError,
      //   3 张 outbox 永久只增不减 (两个方言都中招, 含生产 mssql).
      //   任何 1 张表 sweep 失败不破其它 2 张 (R158.60.7 错误隔离).
      await runChunkedDelete(
        db.sql.emailHistory.purgeAlertOlderThan,
        'system_alert_outbox',
        days
      );
      await runChunkedDelete(
        db.sql.emailHistory.purgeReportOlderThan,
        'report_email_outbox',
        days
      );
      // R158.100.C — 3rd table sweep (ad_notify_outbox), 跟 1:1 alert/report 平行.
      try {
        await runChunkedDelete(
          db.sql.adNotifyOutbox.purgeAdNotifyOlderThan,
          'ad_notify_outbox',
          days
        );
      } catch (e) {
        // 单表失败隔离 (R158.60.7). 继续, 不破其它 2 表 sweep.
        logError(e, 'ad_notify_outbox sweep failed (continuing)');
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
      logInfo(`email history retention loop started, ${intervalSec}s cadence, ${CHUNKED_DELETE_LIMIT}/chunk, key=${RETENTION_KEY}`);
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