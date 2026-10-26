// R158.46.30 (2026-10-06) — AD 管理日志 (audit_logs WHERE action IN ad_management)
// retention sweep. Operator directive 2026-10-06:
//
//   "管理记录默认保留30天，但是支持在系统设置中修改，多一个字段AD管理日志保存时间"
//
// Per audit_retention_days / package_runs_retention_days precedent (audit.js,
// package-runs-retention.js), this is a system_config-driven retention sweep.
// Operators tune policy via system_config.ad_mgmt_retention_days (default 30)
// without restarting centre. The default 30-day window is the number operator
// named; 0 disables retention (purgeOlderThan treats <= 0 as disabled).
//
// R158.107 (2026-10-16) — ad_mgmt_retention_days 升级为中心端统一的 retention
//   single source of truth. 8 个 retention service (audit / package_runs /
//   email_history / report / ad_account_change / eventlog / member_eventlog /
//   member_os_baseline / failed_logon) 全部改读此 key. file-push 保持独立
//   file_push_retention_days (任务数据 + 5min cadence + claim TTL 双参数,
//   跟日志数据语义不同). 0 = 永久保留 (return 禁用 sweep, 跟 email / report /
//   ad_account_change 现状一致). 操作员 directive "后续所有数据保留周期都
//   统一的系统配置中的 AD管理日志保存时间 ad_mgmt_retention_days".
//
// **Scope**: only audit_logs rows whose action ∈ ad_management category
// (audit-classifier.js CATEGORY_ACTIONS reverse map). Other categories
// (changes / system / ops) are untouched — operator explicitly asked for
// "AD 管理日志", which on the UI maps to /admin/ad-management-log (the
// AdManagementLogView that lists ad_management actions + ad_command
// lifecycle rows). Lifecycle rows (ad_command_claimed / succeeded /
// failed / timeout) are part of the same category so they get swept
// together; that's intentional — lifecycle + 写动作 都在同一块 UI 呈现.
//
// **Cadence**: hard-coded 1 hour — retention is coarse-grained background
// work and doesn't need a per-tick interval knob. Mirror
// createAuditRetentionLoop / createPackageRunsRetentionLoop shape (Global
// Constraint #8): start() schedules a setInterval with an inFlight guard;
// tick() reads ad_mgmt_retention_days from system_config and runs
// purgeOlderThan; stop() clears the interval and waits for the in-flight
// tick so a shutdown can't strand a half-written DELETE.
//
// **Best-effort**: a purge failure is warn-logged and swallowed so a
// transient DB hiccup doesn't take down the scheduler. Caller wires into
// server.js AFTER seedSmtpDefaultsIfMissing has written the default row.
//
// **Dialect**: builds the DELETE SQL in JS so it can splice the action
// list (same shape as audit.js buildWhere() — `action IN (?,?,...)`) and
// binds the cutoff Date as the second param. mssql driver coerces JS
// Date → DATETIME2 automatically; mysql driver coerces → DATETIME. The
// action list comes from CATEGORY_ACTIONS.get('ad_management') at boot
// time — it's a frozen compile-time constant (audit-classifier.js
// ACTION_CATEGORY map), so SQL injection is impossible and we can safely
// inline it as comma-quoted identifiers.
import { getDb } from '../db/index.js';
import { CATEGORY_ACTIONS } from './audit-classifier.js';

const AD_MGMT_RETENTION_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_AD_MGMT_RETENTION_DAYS = 30;
const CATEGORY = 'ad_management';

function buildPurgeSql(actionList) {
  // `actionList` is a frozen compile-time constant (audit-classifier.js
  // ACTION_CATEGORY reverse map) — safe to inline as quoted identifiers.
  // Mirrors buildWhere() in audit.js for the `IN (...)` shape.
  const inList = actionList.map((a) => `'${a.replace(/'/g, "''")}'`).join(',');
  return `DELETE FROM audit_logs WHERE action IN (${inList}) AND created_at < ?`;
}

export async function purgeOlderThan(db, { cutoffIso }, log = null) {
  const list = CATEGORY_ACTIONS.get(CATEGORY);
  if (!list || list.size === 0) {
    return { skipped: true, reason: `CATEGORY_ACTIONS has no '${CATEGORY}' actions`, deleted: 0 };
  }
  const actions = [...list];
  const sqlText = buildPurgeSql(actions);
  try {
    const r = await db.execute(sqlText, [cutoffIso]);
    const deleted = Number(r?.affectedRows ?? r?.rowCount ?? 0);
    return { skipped: false, deleted, cutoff: cutoffIso.toISOString?.() ?? cutoffIso, actionCount: actions.length };
  } catch (e) {
    log?.warn?.({ err: e.message }, 'ad_management audit retention purge failed (best-effort)');
    return { skipped: true, reason: e.message, deleted: 0 };
  }
}

export function createAdMgmtAuditRetentionLoop({ getSystemConfig, logger }) {
  let interval = null;
  let inFlight = null;

  async function tick() {
    let days;
    try {
      const cfg = (await getSystemConfig?.()) || {};
      const raw = cfg.ad_mgmt_retention_days;
      // R158.107 (2026-10-16) — 跟 createEmailHistoryRetentionLoop /
      // createReportRetentionLoop 1:1 平行 0=return 范式: missing → default,
      // explicit 0 → return (禁用 sweep, 跟其它 5 个 service 一致),
      // non-numeric → warn + default.
      const parsed = Number(raw);
      if (raw == null || raw === '') {
        days = DEFAULT_AD_MGMT_RETENTION_DAYS;
      } else if (Number.isFinite(parsed) && parsed <= 0) {
        return { skipped: true, reason: 'ad_mgmt_retention_days <= 0 (retention disabled)' };
      } else if (Number.isFinite(parsed) && parsed > 0) {
        days = Math.floor(parsed);
        // R158.X.99.32 (2026-10-19) — defensive floor guard
        if (days < 1) { return { skipped: true, reason: 'ad_mgmt_retention_days < 1 (defensive floor)' }; }
      } else {
        logger?.warn?.({ ad_mgmt_retention_days: raw },
          'ad_mgmt retention days is non-numeric, using default');
        days = DEFAULT_AD_MGMT_RETENTION_DAYS;
      }
    } catch (e) {
      logger?.warn?.({ err: e.message }, 'ad_mgmt retention loop: getSystemConfig failed (best-effort)');
      return { skipped: true, reason: `getSystemConfig failed: ${e.message}` };
    }
    const cutoff = new Date(Date.now() - days * 86400_000);
    return await purgeOlderThan(getDb(), { cutoffIso: cutoff }, logger);
  }

  function start() {
    if (interval) return;
    interval = setInterval(() => {
      inFlight = tick().catch((e) =>
        logger?.warn?.({ err: e?.message || String(e) }, 'ad_mgmt retention tick failed (best-effort)')
      );
    }, AD_MGMT_RETENTION_INTERVAL_MS);
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
