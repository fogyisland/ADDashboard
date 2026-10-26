// R158.X.115 (2026-10-20) — 主机生命周期状态机 service。
//
// 「服务器下线」(退役) + 「暂停管控」的功能核心。两个动作、三个端点、
// DC 与 member server 对称。
//
// ---------------------------------------------------------------------------
// 为什么退役是状态而不是删除
// ---------------------------------------------------------------------------
// 现有 DELETE 端点不是解法:
//   · agent 每 30min 重发 self-register (noadagent/agent.js:679) → 删掉的行
//     会自己回来, "删了也回来"
//   · DELETE 是物理删除, FK CASCADE 清掉历史审计数据 → 不可追溯
//   · heartbeat_offline 无法区分「退役」与「临时离线/返修」
//
// 退役 = 在目录表上打一个时间戳标记, 行留在原地, 历史数据全保留, 仅从
// 告警与在线视图排除。
//
// ---------------------------------------------------------------------------
// 状态机 (互斥, 退役优先)
// ---------------------------------------------------------------------------
//   在线        → 暂停       monitoring_paused_at = NOW()
//   暂停        → 恢复       monitoring_paused_at = NULL
//   在线/暂停   → 退役       decommissioned_at = NOW(), monitoring_paused_at = NULL
//   已退役      → 恢复/暂停  **拒绝** (409, 终态不可逆)
//
// ---------------------------------------------------------------------------
// 退役前操作员须先完成 (UI 会提示, 这里也做服务端校验提示)
// ---------------------------------------------------------------------------
// DC:        在 AD 里降级 (FSMO 角色转移 + dcpromo) → 卸载 agent
// Member:    卸载 agent
//
// 顺序很重要: 先卸载 agent 再点退役。反过来做的话 agent 还会持续上报,
// 虽然 UPSERT 保护 (见 sql/host-status.js) 不会破坏退役标记, 但会一直往
// 历史表写新数据制造噪音。
//
// ---------------------------------------------------------------------------
// 告警状态闭合
// ---------------------------------------------------------------------------
// 暂停/退役时, 该主机当前 firing 的 system_alerts 批量标 recovered
// (markRecoveredByScope) —— 数据保留在表里可查, 只是状态闭合, 不留悬挂
// 告警。这跟"真的恢复了"语义略有差异, 但对操作员而言效果一致: 这台机器
// 不该再出现在当前告警列表里。

import { getDb } from '../db/index.js';
import { writeAudit } from './audit.js';

// 生命周期动作的 audit action 名。加进 audit-classifier 的长期保留白名单,
// 否则 audit_retention_days (默认 90 天) 会把退役线索冲掉 —— 退役是不可逆
// 操作, 审计要求应该高于其它 admin 写操作。
const AUDIT_ACTIONS = {
  decommissionMember: 'decommission_member_server',
  resumeMember: 'resume_member_monitoring',
  pauseMember: 'pause_member_monitoring',
  decommissionDc: 'decommission_dc',
  resumeDc: 'resume_dc_monitoring',
  pauseDc: 'pause_dc_monitoring'
};

// 状态变更的错误码 → HTTP status。集中在一处, 路由层照此映射。
export class HostStatusError extends Error {
  constructor(code, status, message, host = null) {
    super(message || code);
    this.code = code;
    this.status = status;
    // host 让路由层能在拒绝日志里带上是哪台机器, 0 额外查询。
    this.host = host;
  }
}

// kind: 'member' | 'dc'。DC 用 dc_name 列 (setLifecycleDc), member 用
// hostname 列 (setLifecycleMember) —— 两者的参数顺序一致:
//   [decommissioned_at, monitoring_paused_at, hostKey]
function sqlFor(db, kind, query) {
  const key = kind === 'dc' ? query.dc : query.member;
  const sql = db.sql.hostStatus?.[key];
  if (!sql) throw new HostStatusError('sql_helper_missing', 500, `hostStatus.${key} not found`);
  return typeof sql === 'function' ? sql() : sql;
}

async function readStatus(db, kind, host) {
  const sql = kind === 'dc'
    ? db.sql.hostStatus.getStatusDc
    : db.sql.hostStatus.getStatusMember;
  const { rows } = await db.query(sql, [host]);
  return rows[0] || null;
}

function assertNotDecommissioned(row, host) {
  if (row?.decommissioned_at) {
    throw new HostStatusError(
      'already_decommissioned', 409,
      `${host} 已退役 (${new Date(row.decommissioned_at).toISOString()}), 退役是终态不可逆`,
      host
    );
  }
}

async function auditAction({ action, host, kind, reason, userId, extra }, logger) {
  await writeAudit({
    userId: userId ?? null,
    action,
    target: kind === 'dc' ? 'ad_dcs' : 'member_servers',
    payload: {
      host,
      kind,
      reason: reason || null,
      ...(extra || {})
    }
  }, logger);
}

/**
 * 退役 (下线) — 终态, 不可逆。
 * 已暂停的机器退役时强制清零 monitoring_paused_at (避免 UI 显示混乱)。
 */
export async function decommissionHost({ kind, host, reason, userId }, logger) {
  const db = getDb();
  const row = await readStatus(db, kind, host);
  if (!row) {
    throw new HostStatusError(
      kind === 'dc' ? 'dc_not_found' : 'member_not_found', 404, `${host} 不存在`, host
    );
  }
  assertNotDecommissioned(row, host);

  // 退役: decommissioned_at = NOW, monitoring_paused_at = NULL (清掉暂停态)
  await db.execute(sqlFor(db, kind, { dc: 'setLifecycleDc', member: 'setLifecycleMember' }),
    [new Date(), null, host]);

  // 告警状态闭合: 这台机器当前 firing 的告警批量标 recovered。
  await db.execute(db.sql.systemAlerts.markRecoveredByScope, [host]);

  await auditAction({
    action: kind === 'dc' ? AUDIT_ACTIONS.decommissionDc : AUDIT_ACTIONS.decommissionMember,
    host, kind, reason, userId,
    extra: { wasPausedAt: row.monitoring_paused_at ?? null }
  }, logger);

  return { ok: true, host, kind, decommissionedAt: new Date().toISOString(), alertsClosed: true };
}

/**
 * 暂停管控 — 临时态。机器退出告警与在线视图, 但随时可恢复。
 * 不做自动到期 (operator directive 2026-10-20: 纯手动恢复)。
 */
export async function pauseHost({ kind, host, reason, userId }, logger) {
  const db = getDb();
  const row = await readStatus(db, kind, host);
  if (!row) {
    throw new HostStatusError(
      kind === 'dc' ? 'dc_not_found' : 'member_not_found', 404, `${host} 不存在`, host
    );
  }
  assertNotDecommissioned(row, host);
  if (row.monitoring_paused_at) {
    throw new HostStatusError('already_paused', 409, `${host} 已处于暂停管控状态`, host);
  }

  await db.execute(sqlFor(db, kind, { dc: 'setLifecycleDc', member: 'setLifecycleMember' }),
    [null, new Date(), host]);

  // 暂停期同样闭合 firing 告警 (操作员暂停的动机往往就是"它一直在报警")。
  await db.execute(db.sql.systemAlerts.markRecoveredByScope, [host]);

  await auditAction({
    action: kind === 'dc' ? AUDIT_ACTIONS.pauseDc : AUDIT_ACTIONS.pauseMember,
    host, kind, reason, userId
  }, logger);

  return { ok: true, host, kind, monitoringPausedAt: new Date().toISOString(), alertsClosed: true };
}

/**
 * 恢复管控 — 仅对暂停态有效。已退役的机器不可恢复 (终态)。
 */
export async function resumeHost({ kind, host, reason, userId }, logger) {
  const db = getDb();
  const row = await readStatus(db, kind, host);
  if (!row) {
    throw new HostStatusError(
      kind === 'dc' ? 'dc_not_found' : 'member_not_found', 404, `${host} 不存在`, host
    );
  }
  assertNotDecommissioned(row, host);
  if (!row.monitoring_paused_at) {
    throw new HostStatusError('not_paused', 409, `${host} 当前不处于暂停管控状态`, host);
  }

  await db.execute(sqlFor(db, kind, { dc: 'setLifecycleDc', member: 'setLifecycleMember' }),
    [null, null, host]);

  await auditAction({
    action: kind === 'dc' ? AUDIT_ACTIONS.resumeDc : AUDIT_ACTIONS.resumeMember,
    host, kind, reason, userId
  }, logger);

  return { ok: true, host, kind, resumed: true };
}

/**
 * 下线前影响预览 — 告诉操作员这台机器退役后哪些历史数据会保留。
 * 纯读, 不写任何东西。UI 弹窗用它展示 "将保留 X 条历史"。
 */
export async function previewLifecycle({ kind, host }, logger) {
  const db = getDb();
  const row = await readStatus(db, kind, host);
  if (!row) {
    throw new HostStatusError(
      kind === 'dc' ? 'dc_not_found' : 'member_not_found', 404, `${host} 不存在`, host
    );
  }

  const counts = {};
  // 双方言语法一致的 COUNT(*) 一律用同一份 SQL; 真的需要方言差异的才分支。
  const countQueries = kind === 'dc'
    ? [
        ['replicationLinks', `SELECT COUNT(*) AS n FROM ad_replication_status WHERE source_dc = ? OR dest_dc = ?`, [host, host]],
        ['dcOverview', `SELECT COUNT(*) AS n FROM ad_dc_overview WHERE dc_name = ?`, [host]],
        ['packageRuns', `SELECT COUNT(*) AS n FROM package_runs WHERE agent_id = ?`, [host]],
        ['agentHeartbeat', `SELECT COUNT(*) AS n FROM ad_agent_heartbeat WHERE agent_id = ?`, [host]],
        ['firingAlerts', `SELECT COUNT(*) AS n FROM system_alerts WHERE scope_type = 'host' AND scope_ref = ? AND state = 'firing'`, [host]]
      ]
    : [
        ['packageRuns', `SELECT COUNT(*) AS n FROM package_runs WHERE agent_id = ?`, [host]],
        ['memberHeartbeat', `SELECT COUNT(*) AS n FROM ad_member_heartbeat WHERE hostname = ?`, [host]],
        ['eventlogEvents', `SELECT COUNT(*) AS n FROM ad_member_eventlog_events WHERE hostname = ?`, [host]],
        ['osBaseline', `SELECT COUNT(*) AS n FROM ad_member_os_baseline WHERE hostname = ?`, [host]],
        ['adminGroups', `SELECT COUNT(*) AS n FROM ad_member_admin_groups WHERE hostname = ?`, [host]],
        ['ports', `SELECT COUNT(*) AS n FROM ad_member_server_ports WHERE hostname = ?`, [host]],
        ['packageBinds', `SELECT COUNT(*) AS n FROM ad_member_server_packages WHERE hostname = ?`, [host]],
        ['groupMemberships', `SELECT COUNT(*) AS n FROM ad_server_group_members WHERE hostname = ?`, [host]],
        ['firingAlerts', `SELECT COUNT(*) AS n FROM system_alerts WHERE scope_type = 'host' AND scope_ref = ? AND state = 'firing'`, [host]]
      ];

  // 历史表不是每个部署都建全 (例如 ad_member_eventlog_events 只在 MSSQL
  // 侧有过 DDL)。查不存在的表不能拖垮整个预览 —— 逐条 try, 失败记 null,
  // UI 渲染成 "—"。这是**只读**路径, 吞异常是安全的。
  for (const [key, sql, params] of countQueries) {
    try {
      const { rows } = await db.query(sql, params);
      counts[key] = Number(rows[0]?.n || 0);
    } catch (e) {
      logger?.debug?.({ err: e.message, table: key }, 'lifecycle preview count skipped');
      counts[key] = null;
    }
  }

  return {
    host,
    kind,
    currentStatus: {
      decommissionedAt: row.decommissioned_at ?? null,
      monitoringPausedAt: row.monitoring_paused_at ?? null
    },
    // 历史数据**全部保留** (退役 0 物理删除), 这里只是让操作员知道保留什么。
    historicalDataRetained: counts,
    preflightSteps: kind === 'dc'
      ? [
          '在 Active Directory 中转移 FSMO 角色 (PDC / RID Master / Schema Master / Domain Naming Master / Infrastructure Master)',
          '用 dcpromo / ntdsutil 将该 DC 降级并从域中移除 (降级后它会从复制伙伴中消失)',
          '卸载该主机上的 AD Dashboard Agent (停止并删除 Windows 服务)',
          '确认主机已关机 / 重装后再回本页面点击「确认下线」'
        ]
      : [
          '卸载该主机上的 AD Dashboard Agent (停止并删除 Windows 服务)',
          '确认主机已关机 / 重装后再回本页面点击「确认下线」'
        ]
  };
}

/**
 * 在线 DC 名单 — 供下发/调度路径用 (cron-scheduler targetDcs / 拓扑图选择器)。
 *
 * 直接复用 sql.replication.knownDcNames (R158.X.115 已给它加了退役过滤), 不另写
 * 一份 SQL —— 调度下发名单跟拓扑可见性必须同源, 否则会出现"拓扑上看不到的 DC
 * 却被下发任务"的诡异现象。partner-discover 也用同一个 helper (判定 ad_partner_*
 * 的合法伙伴), 三者口径统一 = 单点真相。
 *
 * @returns {Promise<string[]>} 在线 DC 的 dc_name 数组 (已退役/暂停的已排除)
 */
export async function listOnlineDcNames(db = getDb()) {
  const { rows } = await db.query(db.sql.replication.knownDcNames);
  return rows.map(r => r.dc_name || r.DC_NAME).filter(Boolean);
}

/**
 * 校验某个下发目标是否仍在线。退役/暂停的主机不能作为下发目标 ——
 * 退役意味着 agent 已卸载 (推了也没人接), 暂停意味着操作员明确不想再管它。
 *
 * 供 file-push.createTask 在建任务前逐目标检查。
 *
 * @returns {Promise<boolean>} true = 在线可下发
 */
export async function isHostOnline(kind, host, db = getDb()) {
  const sql = kind === 'dc'
    ? db.sql.hostStatus.getStatusDc
    : db.sql.hostStatus.getStatusMember;
  const { rows } = await db.query(sql, [host]);
  const row = rows[0];
  // 查不到行 = 该主机不在目录表里 → 同样不可下发 (跟"退役"一样推不到)。
  if (!row) return false;
  return !row.decommissioned_at && !row.monitoring_paused_at;
}

/**
 * 批量版 — 返回**不可下发**的目标名 (退役/暂停/不在目录表里)。
 * file-push.createTask 用这个, 避免 N+1 查询。
 *
 * 实现: 一次 IN 查回这些主机的状态, 在内存里判定。比逐个 isHostOnline 快
 * O(N) → O(1) 次 round trip。目标数通常是个位数, 但 file-push 支持多选, 保持
 * 单次查询更干净。
 *
 * @param {'dc'|'member'} kind
 * @param {string[]} hosts
 * @returns {Promise<string[]>} 不可下发的目标 (保持入参顺序)
 */
export async function findOffManagementHosts(kind, hosts, db = getDb()) {
  const list = (hosts || []).map(h => String(h).trim()).filter(Boolean);
  if (list.length === 0) return [];

  const col = kind === 'dc' ? 'dc_name' : 'hostname';
  const table = kind === 'dc' ? 'ad_dcs' : 'ad_member_servers';
  const placeholders = list.map(() => '?').join(', ');
  // 单次查询拿回状态列。查不到行 = 该主机不在目录表里 → 同样不可下发
  // (agent 从没注册过, 推了也没人接)。MSQSL driver 大小写映射不一致,
  // 两个 key 都试, 跟 host-status.js 其他地方的 `r.x || r.X` 惯例一致。
  const { rows } = await db.query(
    `SELECT ${col}, decommissioned_at, monitoring_paused_at
       FROM ${table}
      WHERE ${col} IN (${placeholders})`,
    list
  );
  const byHost = new Map(
    rows.map(r => [
      r[col] || r[col.toUpperCase()],
      { dec: r.decommissioned_at, paused: r.monitoring_paused_at }
    ])
  );

  return list.filter((h) => {
    const st = byHost.get(h);
    if (!st) return true;              // 不在目录表里 → 不可下发
    return !!st.dec || !!st.paused;    // 已退役 / 已暂停 → 不可下发
  });
}

export { AUDIT_ACTIONS };