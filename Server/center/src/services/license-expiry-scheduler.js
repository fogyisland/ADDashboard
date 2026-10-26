// center/src/services/license-expiry-scheduler.js
// R158.License-expiry (2026-10-15) — 5min cadence cron 检测 license 状态切换 + 入队邮件.
//
// 跟 createReportLoop (report-scheduler.js) 1:1 平行 shape: { start, stop, tick, isRunning }.
// 状态切换检测:
//   - active → expiring_soon : 入队 1 封 license_expiring_soon 邮件
//   - * → expired            : 入队 1 封 license_expired 邮件
//   - 续约后 active 切回 (expiring_soon/expired → active) : 0 入队 (操作员没要求"已续约"通知)
//
// Catch-up dedup (R158.100.B+3 lesson 1:1 平行):
//   - first-tick-immediately (R158.87.4 教训): 进程启动后 first-tick-immediately 必 fire 1 次
//   - DB-level dedup: 查 license_email_outbox 窗内同 kind (subject LIKE) 已发数, n>0 skip
//   - 失败降级 best-effort: dedup 失败不阻塞 fire
//   - 5min cadence in-memory lastStatus 跨 tick 防止 5min 内重复
//
// 0 触碰 agent / R158.69 / R158.88 (R158.AdminEmail 锁定).

import { getLicenseState } from './license-state.js';
import { enqueueLicenseNotify } from './license-notify.js';

const TICK_INTERVAL_MS = 5 * 60 * 1000;  // 5min, 跟 report-scheduler 1:1 平行
const SUBJECT_PREFIX_EXPIRING = '[AD Center] License 即将到期';
const SUBJECT_PREFIX_EXPIRED = '[AD Center] License 已到期';
const CATCHUP_DEDUP_WINDOW_MS = 31 * 24 * 3600 * 1000;  // 31d, 防止重启后跨日误发

// 把 subject prefix 转成 SQL LIKE 模式. subject = "[AD Center] License 即将到期 ..." LIKE "License 即将到期%"
function _subjectLikePattern(prefix) {
  // 截掉 "[AD Center] " 前缀 (R158.AdminEmail subject 模板), 留 "License 即将到期%"
  const inner = prefix.replace(/^\[AD Center\]\s*/, '');
  return `${inner}%`;
}

// 算 "catch-up dedup 窗" — [now - 31d, now]. 重启后跨日重启 = 31d 窗够 dedup.
function _catchupWindow(now) {
  return {
    windowStartUtc: new Date(now.getTime() - CATCHUP_DEDUP_WINDOW_MS),
    windowEndUtc: now
  };
}

// 查 license_email_outbox 窗内同 subject prefix 已发数. n>0 = 已发过 1 次, catch-up 应 skip.
// 跟 R158.100.B+3 countByKindInWindow 1:1 平行, 但 license_email_outbox 0 kind 列, 用 subject LIKE 匹配.
async function _countSentInWindow(db, logger, subjectPrefix, windowStartUtc, windowEndUtc) {
  try {
    const sqlHelper = db.sql.licenseExpiryDedup.countBySubjectInWindow[db.dialect];
    const like = _subjectLikePattern(subjectPrefix);
    const { rows } = await db.query(sqlHelper, [like, windowStartUtc, windowEndUtc]);
    return Number(rows?.[0]?.n ?? 0);
  } catch (e) {
    logger?.error?.({ err: e?.message }, 'license-expiry countSentInWindow failed (best-effort dedup)');
    return -1;  // -1 = unknown, 降级到 fire 路径 (best-effort)
  }
}

export function createLicenseExpiryLoop({ db, logger }) {
  const logInfo = (msg, meta) => {
    if (logger?.info) logger.info(meta || {}, `[license-expiry] ${msg}`);
    else console.log(`[license-expiry] ${msg}`);
  };
  const logError = (err, msg) => {
    if (logger?.error) logger.error({ err: err?.message }, `[license-expiry] ${msg}`);
    else console.error(`[license-expiry] ${msg}: ${err?.message || err}`);
  };

  let interval = null;
  let inFlight = null;
  let tickInFlight = false;
  let running = false;
  // R158.100.B+3 (2026-10-14) — in-memory lastStatus 防止 5min cadence 跨 tick 重复 fire.
  //   跨重启失效, 但 catch-up DB-level dedup (above) 兜底, 跟 R158.100.B+3 L194-205 1:1 平行.
  let lastStatus = 'unknown';
  let lastFiredKindAt = new Map();  // Map<kind, Date> — last fire timestamp per kind (in-memory only)

  async function evaluateTick() {
    const state = await getLicenseState(db, logger);
    const now = new Date();

    // 状态切换检测 (跟 R158.100-fix / R158.100.B+3 lesson 8 1:1 平行, 必用状态对比):
    //   active → expiring_soon : 入队 1 封
    //   active/expiring_soon → expired : 入队 1 封
    //   续约后 (expiring_soon/expired → active) : 0 入队
    let shouldFireKind = null;
    if (state.status === 'expiring_soon' && lastStatus === 'active') {
      shouldFireKind = 'license_expiring_soon';
    } else if (state.status === 'expired' && lastStatus !== 'expired') {
      shouldFireKind = 'license_expired';
    }
    lastStatus = state.status;

    if (!shouldFireKind) return;

    // R158.100.B+3 — DB-level dedup via license_email_outbox 窗内同 kind 已发数.
    //   防止 in-memory lastFired 跨重启失效 → 重启后 first-tick-immediately 重复发.
    const subjectPrefix = shouldFireKind === 'license_expiring_soon'
      ? SUBJECT_PREFIX_EXPIRING
      : SUBJECT_PREFIX_EXPIRED;
    const { windowStartUtc, windowEndUtc } = _catchupWindow(now);
    const n = await _countSentInWindow(db, logger, subjectPrefix, windowStartUtc, windowEndUtc);
    if (n > 0) {
      logInfo(`catch-up skip ${shouldFireKind}: ${n} existing email(s) in window (R158.100.B+3)`);
      lastFiredKindAt.set(shouldFireKind, now);
      return;
    }

    // fire path (R158.AdminEmail 范式: fire-and-forget, 失败永不让 scheduler 500)
    lastFiredKindAt.set(shouldFireKind, now);
    logInfo(`firing ${shouldFireKind} (lastStatus=${lastStatus}, days_remaining=${state.days_remaining}, expires_at=${state.expires_at})`);
    try {
      void enqueueLicenseNotify({
        kind: shouldFireKind,
        payload: {
          days_remaining: state.days_remaining,
          expires_at: state.expires_at,
          instance_id: state.instance_id,
          license_id: state.license_id
        }
      });
    } catch (e) {
      logError(e, `enqueueLicenseNotify ${shouldFireKind} threw (R158.AdminEmail fail-closed)`);
    }
  }

  async function tick() {
    if (tickInFlight) {
      logError(new Error('previous tick still in flight'), 'tick skipped');
      return;
    }
    tickInFlight = true;
    try {
      await evaluateTick();
    } catch (e) {
      logError(e, 'evaluateTick threw');
    } finally {
      tickInFlight = false;
    }
  }

  function start() {
    if (running) return;
    running = true;
    logInfo(`license-expiry loop started, 5min cadence, firing first tick immediately (R158.87.4)`);
    interval = setInterval(() => {
      inFlight = tick().catch((e) => logError(e, 'tick failed'));
    }, TICK_INTERVAL_MS);
    // R158.87.4 (2026-10-12) — first-tick-immediately, mirror report-scheduler precedent.
    //   配合 evaluateTick 内 catch-up DB-level dedup, 进程启动后必 fire 1 次任何切换.
    inFlight = tick().catch((e) => logError(e, 'first tick failed'));
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
