// R158 (2026-09-30) — pending-trigger queue for centre→agent package
// execution. Closes the partner-discover design gap that left trigger
// rows stuck in `package_runs` forever (see dashboard-r157-4-partner-
// discover-redesign.md + cron-scheduler.js header for the original
// intent).
//
// Mechanism (mirrors what cron-scheduler.fireTriggers writes):
//
//   1. cron-scheduler.fireTriggers() writes a `pending_trigger` row with
//      agent_id='__cron__' (synthetic). status='pending_trigger' is in
//      the INSERT column list (R158) so the row is queryable.
//
//   2. agents call POST /api/agent/heartbeat every ~60s. The centre
//      reads this queue and embeds the unconsumed triggers in the
//      heartbeat response (routes/agent.js — packagesTriggers field).
//      Agents pick the list up in heartbeat-callbacks.js and call
//      packageManager.runTriggersNow(triggers).
//
//   3. The agent's runTriggersNow → runOne emits a fresh package_runs
//      row via the existing 9-column INSERT (no status; status stays
//      NULL). The centre also writes a duplicate consumed-marker row
//      here (markTriggerConsumed) so the next heartbeat from the same
//      agent doesn't replay the same trigger.
//
// Why the consumed-marker row and not a DELETE or UPDATE? Three reasons:
//   - package_runs is an append-only audit log (no UPDATE patterns
//     anywhere in src/); introducing one would require schema/migration.
//   - The original trigger row still has its cron-script_version
//     ('cron-trigger' / 'admin-trigger:<actor>') which is useful for
//     forensic queries.
//   - Marking via a second row means dedup is the same pattern as
//     recentRunExists (M12 minute-floor) — no new state machine.
//
// Idempotency window: we filter started_at >= NOW() - 7 DAY so unconsumed
// triggers eventually roll off (matches pendingPartnerDiscovers in
// src/db/sql.js:150/:1493).

import { getDb } from '../db/index.js';

const CONSUMED_MARKER = 'consumed-trigger';
const DEFAULT_LIMIT = 5;
const DEFAULT_WINDOW_DAYS = 7;

/**
 * Claim pending triggers for one agent. Returns an array of
 * {packageName, startedAt, scriptVersion} rows.
 *
 * `limit` is bounded (default 5) to keep the heartbeat response small
 * even if cron-scheduler has piled up triggers.
 *
 * @param {object} opts
 * @param {string} opts.agentId
 * @param {number} [opts.limit=5]
 * @param {object} [opts.db=getDb()]
 */
export async function claimPendingTriggers({
  agentId,
  limit = DEFAULT_LIMIT,
  db = getDb()
}) {
  if (typeof agentId !== 'string' || agentId.length === 0) {
    // Defensive guard: previous bug called this as `claimPendingTriggers(db, {agentId, limit})`
    // which silently dropped agentId (the destructure only reads from the first arg) and
    // returned []. Surface the misuse loud so a future caller can't regress.
    if (typeof arguments[0] === 'string' || (arguments[0] && 'execute' in arguments[0] && !('agentId' in arguments[0]))) {
      throw new TypeError("claimPendingTriggers: pass an options object {agentId, limit, db}, not positional args. Got: " + JSON.stringify(Object.keys(arguments[0] || {})));
    }
    return [];
  }
  const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || DEFAULT_LIMIT, 50));
  const { sql, params } = buildClaimSql({ dialect: db.dialect, agentId, limit: safeLimit });
  const { rows } = await db.execute(sql, params);
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    packageName: r.package_name ?? r.name,
    startedAt: r.started_at instanceof Date ? r.started_at.toISOString() : r.started_at,
    scriptVersion: r.script_version ?? null,
    // R158.72.x.12 B' (2026-10-17) — widen wire shape 加 triggerOnce
    //   字段. trigger_once=1 走 agent 端 1 click 1 跑 0 启 setInterval
    //   (跟 R158.60.10 on-demand skip 1:1 平行). 跟 R158.72.x.5 ALTER
    //   jitter_at + R158.72.x.13 ALTER cron_expr wire widen 1:1 平行.
    triggerOnce: r.trigger_once === 1 || r.trigger_once === true
  }));
}

// R158.X.115 (2026-10-20) — 改为 export, 供外部直接导入验证占位符/params
//   一致性。这段 SQL 有 4 个 `?` 占位符而 params 只有在
//   每次加过滤时同步维护才不会错位; mssql v11 绑定顺序错位是本项目踩过的坑
//   (lesson 18), 而这类 bug 表现为"触发静默不 fire", 生产上极难定位。
//   生产代码无副作用 (纯 SQL 拼装函数, 0 状态), 仅为可测性放宽可见性。
export function buildClaimSql({ dialect, agentId, limit }) {
  // Dedup fingerprint: a trigger (cron row, agent_id='__cron__') is
  // "already consumed" if a row exists for THIS agent (real agent_id)
  // with the same package_name + same minute floor and status in the
  // completed/failed/consumed set. Same minute ⇒ same logical run
  // (matches recentRunExists / M12 minute-floor).
  if (dialect === 'mssql') {
    return {
      sql: `
        SELECT TOP ${parseInt(limit, 10)} t.package_name, t.started_at, t.script_version, t.trigger_once
        FROM package_runs t
        WHERE t.status = 'pending_trigger'
          AND t.agent_id = '__cron__'
          AND t.started_at >= DATEADD(DAY, -${DEFAULT_WINDOW_DAYS}, SYSUTCDATETIME())
          AND (t.target_agents IS NULL OR CHARINDEX(CAST(? AS NVARCHAR(64)), t.target_agents) > 0)
          -- R158.X.115 (2026-10-20) — 该 agent 已退役/暂停管控 → 不再 claim
          --   任何 cron 触发。放在 claim 侧 (而非 cron-scheduler 写侧) 是有意
          --   的, 3 个原因:
          --     1. target_agents 是 agentId 匹配 (CHARINDEX), 而 agentId 既有
          --        DC 名也有 member hostname (同一张 package_runs 表)。在写侧
          --        把 target_agents 从 NULL 填成"在线 DC 名单"会**误伤 member
          --        agent** —— member hostname 不在 DC 名单里, 从此收不到任何
          --        cron 触发。这是严重回归, 必须避免。
          --     2. 退役 DC 的 agent 已卸载, 根本不会来 claim (写侧堆积的
          --        pending_trigger 永远没人领, 但它们会随 retention 清理)。
          --        真正需要拦的是**暂停管控**: agent 还活着还在 claim, 但操作员
          --        明确说了"这台别管"。claim 侧正好命中这个场景。
          --     3. 退役/暂停状态随时可能变, claim 侧每轮实时判断, 不存在
          --        状态变了但写好的 trigger 名单没更新的问题。
          --   两个命名空间都查: 同名 hostname 可能既是 DC 又是 member。
          AND NOT EXISTS (SELECT 1 FROM ad_dcs dcd WHERE dcd.dc_name = CAST(? AS NVARCHAR(128)) AND (dcd.decommissioned_at IS NOT NULL OR dcd.monitoring_paused_at IS NOT NULL))
          AND NOT EXISTS (SELECT 1 FROM ad_member_servers ms WHERE ms.hostname = CAST(? AS NVARCHAR(128)) AND (ms.decommissioned_at IS NOT NULL OR ms.monitoring_paused_at IS NOT NULL))
          AND NOT EXISTS (
            SELECT 1 FROM package_runs c
            WHERE c.agent_id = CAST(? AS NVARCHAR(64))
              AND c.package_name = t.package_name
              AND c.started_at >= t.started_at
              AND c.started_at <  DATEADD(MINUTE, 1, t.started_at)
              AND c.status IN ('completed', 'failed', 'consumed', '${CONSUMED_MARKER}')
          )
        ORDER BY t.started_at ASC
      `.replace(/\s+/g, ' ').trim(),
      // 占位符顺序: target_agents CHARINDEX → ad_dcs dc_name → ad_member_servers
      // hostname → dedup 子查询 agentId。R158.X.115 插在中间 2 个, params 必须
      // 同步加 2 个 agentId, 否则绑定顺序错位 (lesson 18: mssql v11 绑定错位的
      // 前车之鉴)。
      params: [agentId, agentId, agentId, agentId]
    };
  }
  // MySQL — same shape, uses INTERVAL syntax.
  return {
    sql: `
      SELECT t.package_name, t.started_at, t.script_version, t.trigger_once
      FROM package_runs t
      WHERE t.status = 'pending_trigger'
        AND t.agent_id = '__cron__'
        AND t.started_at >= UTC_TIMESTAMP() - INTERVAL ${DEFAULT_WINDOW_DAYS} DAY
        AND (t.target_agents IS NULL OR LOCATE(?, t.target_agents) > 0)
        AND NOT EXISTS (SELECT 1 FROM ad_dcs dcd WHERE dcd.dc_name = ? AND (dcd.decommissioned_at IS NOT NULL OR dcd.monitoring_paused_at IS NOT NULL))
        AND NOT EXISTS (SELECT 1 FROM ad_member_servers ms WHERE ms.hostname = ? AND (ms.decommissioned_at IS NOT NULL OR ms.monitoring_paused_at IS NOT NULL))
        AND NOT EXISTS (
          SELECT 1 FROM package_runs c
          WHERE c.agent_id = ?
            AND c.package_name = t.package_name
            AND c.started_at >= t.started_at
            AND c.started_at <  t.started_at + INTERVAL 1 MINUTE
            AND c.status IN ('completed', 'failed', 'consumed', '${CONSUMED_MARKER}')
        )
      ORDER BY t.started_at ASC
      LIMIT ${parseInt(limit, 10)}
    `.replace(/\s+/g, ' ').trim(),
    // 占位符顺序跟 mssql 段 1:1 平行 (LOCATE → ad_dcs → ad_member_servers →
    // dedup), 同样 4 个 agentId。理由见 mssql 段 params 注释。
    params: [agentId, agentId, agentId, agentId]
  };
}

/**
 * Mark a trigger as consumed by writing a duplicate package_runs row
 * with status='consumed-trigger' and the agent's real id. Best-effort —
 * a failed write just means the trigger gets replayed on the next
 * heartbeat (dedup still works at postPackageReport via recentRunExists).
 *
 * The 10-column INSERT mirrors cron-scheduler.fireTriggers exactly
 * (same column order, same NVARCHAR casts on MSSQL, same UTC time fn).
 *
 * @param {object} opts
 * @param {string} opts.agentId
 * @param {string} opts.packageName
 * @param {Date|string} opts.startedAt
 * @param {object} [opts.db=getDb()]
 * @returns {Promise<{inserted: boolean, error?: string}>}
 */
export async function markTriggerConsumed({
  agentId,
  packageName,
  startedAt,
  db = getDb()
}) {
  if (typeof agentId !== 'string' || agentId.length === 0) return { inserted: false };
  if (typeof packageName !== 'string' || packageName.length === 0) return { inserted: false };
  // Normalise startedAt to a Date; copy the minute floor so the
  // consumed-marker fingerprint exactly matches the cron row.
  const src = startedAt instanceof Date ? startedAt : new Date(startedAt);
  if (isNaN(src.getTime())) return { inserted: false };
  const minuteFloor = new Date(
    src.getFullYear(), src.getMonth(), src.getDate(),
    src.getHours(), src.getMinutes(), 0, 0
  );
  const sql = db.dialect === 'mssql'
    ? `INSERT INTO package_runs (agent_id, package_name, started_at, finished_at, exit_code, stdout_preview, stderr_preview, error, script_version, status)
       VALUES (CAST(? AS NVARCHAR(64)), CAST(? AS NVARCHAR(128)), ?, SYSUTCDATETIME(), 0, NULL, NULL, NULL, ?, '${CONSUMED_MARKER}')`
    : `INSERT INTO package_runs (agent_id, package_name, started_at, finished_at, exit_code, stdout_preview, stderr_preview, error, script_version, status)
       VALUES (?, ?, ?, UTC_TIMESTAMP(), 0, NULL, NULL, NULL, ?, '${CONSUMED_MARKER}')`;
  try {
    await db.execute(sql, [agentId, packageName, minuteFloor, 'trigger-consumed']);
    return { inserted: true };
  } catch (e) {
    return { inserted: false, error: e?.message || String(e) };
  }
}
