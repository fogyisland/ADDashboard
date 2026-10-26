// R158.19 (2026-10-01) — package_runs retention sweep.
//
// Operator directive 2026-10-01: "数据包执行结果遵从一定的规则,例如10天删除,
// 这个在系统设置里面增加一个参数值,用于自己来进行设定". Per audit_retention_days
// precedent (services/audit.js), this is a system_config-driven retention
// sweep — operators tune policy via system_config.package_runs_retention_days
// (default 10) without restarting centre. The default 10-day window is the
// number operator named; 0 disables retention (purgeOlderThan treats <= 0
// as disabled).
//
// R158.107 (2026-10-16) — 改读 ad_mgmt_retention_days (操作员 directive
//   "后续所有数据保留周期都统一"), 0=return 跟 email / report / ad_account_change
//   1:1 平行范式. 旧 package_runs_retention_days 字段 ship 时一次性 DELETE
//   migration 移除 (ConfigView 同步删字段 + labels 行).
//
// Cadence is hard-coded at 1 hour — retention is coarse-grained background
// work and doesn't need a per-tick interval knob. Mirror
// createAuditRetentionLoop / createEventlogRetentionLoop shape (Global
// Constraint #8): start() schedules a setInterval with an inFlight guard;
// tick() reads ad_mgmt_retention_days from system_config and runs
// purgeOlderThan; stop() clears the interval and waits for the in-flight
// tick so a shutdown can't strand a half-written DELETE.
//
// Best-effort: a purge failure is warn-logged and swallowed so a transient
// DB hiccup doesn't take down the scheduler. Caller wires into server.js
// AFTER seedSmtpDefaultsIfMissing has written the default row.
import { getDb } from '../db/index.js';

const PACKAGE_RUNS_RETENTION_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
// R158.107 — default 跟 ad_mgmt_retention_days 1:1 平行 (30d).
// R158.X+UI.timeline.r (2026-10-19) — 操作员 directive "为所有包的执行
// 计划定义保存时间为 10 天". package_runs 单独默认 10d, 跟其他 7 service
// 1:1 平行 (email / report / ad_account_change / audit / eventlog /
// member-os-baseline / member-eventlog / file-push) 默认 30d **不同**.
// 0 改其他 7 service DEFAULT_* 常量, 0 改 R158.107 锁 "8 service 统一
// 单点" — package_runs 走 "单点" 但 default 10d, 其他 7 service 走
// "单点" + default 30d. 跟 R158.107 范式 1:1 平行 (单点读
// ad_mgmt_retention_days, default 走本常量), 0 必新加 KV.
// 操作员授权: R158.X.99.22.b 范式 1-click cleanup 老 30d 外 row.
const DEFAULT_PACKAGE_RUNS_RETENTION_DAYS = 10;

export async function purgeOlderThan(db, { cutoffIso }, log = null) {
  const sqlText = db.sql?.packageRuns?.purgeOlderThan;
  if (typeof sqlText !== 'string') {
    return { skipped: true, reason: 'packageRuns.purgeOlderThan SQL not registered', deleted: 0 };
  }
  try {
    const r = await db.execute(sqlText, [cutoffIso]);
    const deleted = Number(r?.affectedRows ?? r?.rowCount ?? 0);
    return { skipped: false, deleted, cutoff: cutoffIso.toISOString?.() ?? cutoffIso };
  } catch (e) {
    log?.warn?.({ err: e.message }, 'package_runs retention purge failed (best-effort)');
    return { skipped: true, reason: e.message, deleted: 0 };
  }
}

export function createPackageRunsRetentionLoop({ getSystemConfig, logger }) {
  let interval = null;
  let inFlight = null;

  async function tick() {
    let days;
    try {
      const cfg = (await getSystemConfig?.()) || {};
      // R158.107 — 改读 ad_mgmt_retention_days (8 service 统一单点)
      const raw = cfg.ad_mgmt_retention_days;
      // 跟 createEmailHistoryRetentionLoop / createReportRetentionLoop 1:1 平行:
      // missing → default, explicit 0 → return (禁用 sweep), non-numeric → warn + default.
      const parsed = Number(raw);
      if (raw == null || raw === '') {
        days = DEFAULT_PACKAGE_RUNS_RETENTION_DAYS;
      } else if (Number.isFinite(parsed) && parsed <= 0) {
        return { skipped: true, reason: 'ad_mgmt_retention_days <= 0 (retention disabled)' };
      } else if (Number.isFinite(parsed) && parsed > 0) {
        days = Math.floor(parsed);
        // R158.X.99.32 (2026-10-19) — defensive floor guard
        if (days < 1) { return { skipped: true, reason: 'ad_mgmt_retention_days < 1 (defensive floor)' }; }
      } else {
        logger?.warn?.({ ad_mgmt_retention_days: raw },
          'package_runs retention days is non-numeric, using default');
        days = DEFAULT_PACKAGE_RUNS_RETENTION_DAYS;
      }
    } catch (e) {
      logger?.warn?.({ err: e.message }, 'package_runs retention loop: getSystemConfig failed (best-effort)');
      return { skipped: true, reason: `getSystemConfig failed: ${e.message}` };
    }
    const cutoff = new Date(Date.now() - days * 86400_000);
    return await purgeOlderThan(getDb(), { cutoffIso: cutoff }, logger);
  }

  function start() {
    if (interval) return;
    interval = setInterval(() => {
      inFlight = tick().catch((e) =>
        logger?.warn?.({ err: e?.message || String(e) }, 'package_runs retention tick failed (best-effort)')
      );
    }, PACKAGE_RUNS_RETENTION_INTERVAL_MS);
  }

  async function stop() {
    if (interval) clearInterval(interval);
    interval = null;
    if (inFlight) await inFlight.catch(() => {});
    inFlight = null;
  }

  return {
    start,
    stop,
    tick,
    isRunning: () => interval !== null
  };
}
