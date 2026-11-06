// center/src/services/file-push-retention.js
// R158.69.9 (2026-10-11) — file-push stale claim auto-fail + retention.
//
// createFilePushRetentionLoop({ db, getSystemConfig, logger })
//   → { start, stop, tick, isRunning }
//
// 跟 createAdAccountChangeRetentionLoop / createReportRetentionLoop 同 factory
// shape. 两阶段 sweep, 5min cadence (其他 retention 是 24h, file-push 需更短
// 因为 stale claim 越久越难 recover — agent 已下线 / 升级 / 死):
//
//   1. sweepStaleClaims: claimedAt > claimTtlMs (default 60min) 的 target
//      auto-fail. 跟 ad_account_change retention 不同, 这里不 DELETE row,
//      只翻 targetStatus.claimed → failed + errorMessage='claim TTL exceeded'.
//      task-level status roll-up 跟 ackTask() 同样的 allDelivered/allFailed/
//      claimed 逻辑. flushIndex 一次写盘.
//   2. purgeOldTasks: status='failed'/'delivered' AND deliveredAt/uploadedAt
//      > retentionDays (default 7d, operator R158.69.9 决策) → 从 _cache
//      删 + unlink .bin 文件. flushIndex 一次写盘.
//
// 0 schema migrations; lazy INSERT file_push_retention_days + claim_ttl on
// first tick (R158.68.1 inline mode).

import { loadIndex, flushIndex, filePathFor } from './file-push.js';
import { promises as fs } from 'node:fs';

const TICK_INTERVAL_DEFAULT_SEC = 5 * 60;  // 5min cadence (短, 不让 stale 累积)
const DEFAULT_CLAIM_TTL_MIN = 60;          // 60 min default
const DEFAULT_RETENTION_DAYS = 7;           // operator R158.69.9 决策
const RETENTION_KEY = 'file_push_retention_days';
const CLAIM_TTL_KEY = 'file_push_claim_ttl_minutes';

export function createFilePushRetentionLoop({ db, getSystemConfig, logger }) {
  const log = logger?.child ? logger.child({ component: 'file-push-retention' }) : null;
  const logInfo = (msg, meta) => {
    if (log) log.info(meta || {}, msg);
    else console.log(`[file-push-retention] ${msg}`);
  };
  const logError = (err, msg) => {
    if (log) log.error({ err: err?.message }, msg);
    else console.error(`[file-push-retention] ${msg}: ${err?.message || err}`);
  };

  let interval = null;
  let inFlight = null;
  let tickInFlight = false;
  let running = false;

  // Lazy-insert default rows on first tick. 跟 ad-account-change-retention
  // 同 idiom (R158.72): mssql IF NOT EXISTS guard, mysql INSERT IGNORE.
  // R158.51 baseline freeze 不 ship 1.0.x SQL migration.
  async function ensureDefaultRows() {
    const defaults = [
      { key: RETENTION_KEY, value: DEFAULT_RETENTION_DAYS, desc: 'file-push task 保留天数 (failed/delivered)' },
      { key: CLAIM_TTL_KEY, value: DEFAULT_CLAIM_TTL_MIN, desc: 'file-push claim TTL (minutes) — 超时 auto-fail' }
    ];
    for (const { key, value, desc } of defaults) {
      const sql = db.dialect === 'mssql'
        ? `IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = '${key}')
             INSERT INTO system_config (config_key, config_value, description, updated_at)
             VALUES ('${key}', '${value}', '${desc}', SYSUTCDATETIME())`
        : `INSERT IGNORE INTO system_config (config_key, config_value, description, updated_at)
             VALUES ('${key}', '${value}', '${desc}', UTC_TIMESTAMP(3))`;
      try {
        await db.execute(sql, []);
      } catch (e) {
        logError(e, `ensureDefaultRow ${key} failed (continuing)`);
      }
    }
  }

  // Stage 1: stale claim auto-fail. claimedAt > claimTtl → failed.
  async function sweepStaleClaims(claimTtlMs) {
    const cache = await loadIndex();
    const now = Date.now();
    let touched = 0;
    for (const t of cache.values()) {
      let taskTouched = false;
      for (const tgt of t.targetStatus) {
        if (tgt.status !== 'claimed') continue;
        if (!tgt.claimedAt) continue;
        const ageMs = now - new Date(tgt.claimedAt).getTime();
        if (ageMs < claimTtlMs) continue;
        tgt.status = 'failed';
        tgt.deliveredAt = new Date(now).toISOString();
        tgt.errorMessage = `claim TTL exceeded (${Math.round(ageMs / 60000)}min)`;
        taskTouched = true;
        touched++;
      }
      if (taskTouched) {
        // roll-up 跟 ackTask() line 294-298 同逻辑
        const allDelivered = t.targetStatus.every(x => x.status === 'delivered');
        const allFailed = t.targetStatus.every(x => x.status === 'failed');
        if (allDelivered) t.status = 'delivered';
        else if (allFailed) t.status = 'failed';
        else t.status = 'claimed';
      }
    }
    if (touched > 0) await flushIndex();
    return touched;
  }

  // Stage 2: purge old tasks. status ∈ failed/delivered + ts > retention.
  // 跟 ad_account_change retention 不同: 这里直接操作 in-memory cache (非 SQL
  // 表) + unlink .bin file.
  async function purgeOldTasks(retentionDays) {
    const cache = await loadIndex();
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    let purged = 0;
    for (const [id, t] of cache.entries()) {
      if (t.status !== 'failed' && t.status !== 'delivered') continue;
      // 用 targetStatus[0].deliveredAt 优先 (最贴近"完成时间"), 否则 uploadedAt
      const ts = t.targetStatus[0]?.deliveredAt || t.uploadedAt;
      if (!ts) continue;
      if (new Date(ts).getTime() > cutoffMs) continue;
      cache.delete(id);
      purged++;
      // 删 .bin 文件 — swallow err (可能 operator 已经手删过 / 磁盘 transient)
      try { await fs.unlink(filePathFor(id)); } catch {}
    }
    if (purged > 0) await flushIndex();
    return purged;
  }

  async function tick() {
    if (tickInFlight) {
      logError(new Error('previous tick still in flight'), 'tick skipped');
      return;
    }
    tickInFlight = true;
    try {
      await ensureDefaultRows();
      let claimTtlMin = DEFAULT_CLAIM_TTL_MIN;
      let retentionDays = DEFAULT_RETENTION_DAYS;
      try {
        const cfg = await getSystemConfig();
        const ttlParsed = Number(cfg?.[CLAIM_TTL_KEY]);
        if (Number.isFinite(ttlParsed) && ttlParsed > 0) { claimTtlMin = Math.floor(ttlParsed); /* R158.X.99.32 (2026-10-19) — defensive floor guard */ if (claimTtlMin < 1) { return { skipped: true, reason: 'file_push claim_ttl < 1 (defensive floor)' }; } }
        const retParsed = Number(cfg?.[RETENTION_KEY]);
        if (Number.isFinite(retParsed) && retParsed > 0) { retentionDays = Math.floor(retParsed); /* R158.X.99.32 (2026-10-19) — defensive floor guard */ if (retentionDays < 1) { return { skipped: true, reason: 'file_push retention < 1 (defensive floor)' }; } }
      } catch (e) {
        logError(e, 'getSystemConfig failed; using defaults');
      }
      // Stage 1: stale claim auto-fail. retentionDays <= 0 也跑 stage 1
      // (只是 disable purge, claim TTL 仍生效).
      const claimTtlMs = claimTtlMin * 60 * 1000;
      const failed = await sweepStaleClaims(claimTtlMs);
      if (failed > 0) logInfo(`auto-failed ${failed} stale claims (TTL ${claimTtlMin}min)`);
      // Stage 2: purge old (operator-disable 走 return)
      if (retentionDays <= 0) return;
      const purged = await purgeOldTasks(retentionDays);
      if (purged > 0) logInfo(`purged ${purged} old tasks (>${retentionDays}d, status ∈ failed/delivered)`);
    } catch (e) {
      logError(e, 'tick failed');
    } finally {
      tickInFlight = false;
    }
  }

  function start() {
    if (running) return;
    running = true;
    logInfo(`file-push retention loop started, ${TICK_INTERVAL_DEFAULT_SEC}s cadence, ${DEFAULT_CLAIM_TTL_MIN}min claim TTL, ${DEFAULT_RETENTION_DAYS}d retention`);
    interval = setInterval(() => {
      inFlight = tick().catch((e) => logError(e, 'tick failed'));
    }, TICK_INTERVAL_DEFAULT_SEC * 1000);
    // 启动时立刻跑一次 (clear 启动前累积的 stale claims)
    inFlight = tick().catch((e) => logError(e, 'initial tick failed'));
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