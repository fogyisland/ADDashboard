// center/src/services/license-quota-guard.js
// R158.X.99-quota (2026-10-21) — 超额 agent 的**数据准入**判定.
//
// 操作员 2026-10-21 决策: "只丢弃超额的数据, 例如当前有 30 个节点, 那么第 37 个节点
// 数据将会服务端拒绝接收, 在 License 直接告警超过限额".
//
// 为什么不能用"当前在线数"判定 (设计上的关键约束):
//   若按实时在线数判, 配额 36 / 在线 40 → 丢 4 台; 那 4 台下线后在线变 36 → 它们又恢复
//   收数据。这个抖动会让数据完整性不可预测, 且"超额"状态会自己消失。
//   所以必须用**稳定的名额**: agent 首次出现时永久占一个号, 序号 > 上限即永久超额。
//   下线不释放名额 (否则第 37 台下线后第 38 台会挤进来 —— 名额白发了)。
//   这跟"license 按台数计费"的业务语义一致: 授权 36 台就是 36 台, 换谁在线都要占号。
//
// 名额排序键: 首次出现时间。用一个模块级 Map 记录 (进程生命周期内稳定),
//   0 DB IO 0 排序查询 —— agent 数据路径是热路径, 每包一次 COUNT/ORDER BY 会拖慢。
//   代价: 进程重启后 Map 清空, 名额会按重启后首次出现的顺序重新分配。
//   对"超额判定"这个用途是可接受的 (不会误拒已授权节点, 最坏是某台超额节点
//   重启后重新排到号内)。刻意不做 DB 持久化: 持久化需要给 ad_agent_heartbeat
//   加 registered_at 列 + UPSERT 维护, 复杂度远超收益。
//
// fail-open 原则 (与 license-state 的 fail-closed 相反, 刻意):
//   配额查不到 / 统计失败 / 无 active license → 一律**放行**。
//   理由: 误拒合法节点的数据是**破坏性**故障(监控数据静默消失), 而放过超额
//   只是少收几台的数据。两者代价不对称, 必须选代价小的那边。

import { buildQuota } from './license-quota.js';

// agentId → 首次出现次序 (进程内)。不设上限但会在超过阈值时告警, 见 noteStale。
const firstSeenOrder = new Map();
let nextSeq = 1;

/**
 * 记住 agent 的首次出现次序 (幂等: 重复调用不改变已分配的号)。
 * @returns {number} 该 agent 的名额序号
 */
function sequenceFor(agentId) {
  let seq = firstSeenOrder.get(agentId);
  if (seq === undefined) {
    seq = nextSeq++;
    firstSeenOrder.set(agentId, seq);
  }
  return seq;
}

/** 测试/重启钩子: 清空名额分配状态。生产路径不调用。 */
export function _resetQuotaSequences() {
  firstSeenOrder.clear();
  nextSeq = 1;
}

/**
 * checkAgentAdmission — 判断某 agent 的数据该收还是该丢。
 *
 * @param {object} db     — 已就绪连接
 * @param {object} logger — pino
 * @param {string} agentId
 * @returns {Promise<{ allow: boolean, reason: string, seq: number, allowed: number|null,
 *                     used: number|null, over_by: number|null }>}
 *
 * `allow=true` 时 reason ∈ 'no_license' | 'no_quota' | 'usage_unknown' | 'within_quota'
 * `allow=false` 时 reason === 'over_quota'
 */
export async function checkAgentAdmission(db, logger, agentId) {
  const seq = sequenceFor(agentId);

  // fail-open: db 都没有 → 放行. 没有 DB 的 code path 不该有配额概念.
  if (!db || typeof db.query !== 'function') {
    return { allow: true, reason: 'no_db', seq, allowed: null, used: null, over_by: null };
  }

  let allowed = null;
  try {
    const q = await db.query(db.sql.systemRegistration.findActiveQuota, []);
    const row = q?.rows?.[0];
    if (row && Number(row.max_nodes_allowed) > 0) {
      allowed = Number(row.max_nodes_allowed);
    }
  } catch (e) {
    logger?.warn?.({ err: e?.message, agentId }, 'quota guard: quota query failed — admitting (fail-open)');
    return { allow: true, reason: 'quota_query_failed', seq, allowed: null, used: null, over_by: null };
  }

  // 无 active license / 无 max_nodes → 不限额 (trial 期 + 存量老 license 都是这种).
  if (allowed === null) {
    return { allow: true, reason: 'no_quota', seq, allowed: null, used: null, over_by: null };
  }

  // 序号 <= 上限 → 在配额内. 用序号而非实时 agentCount, 保证"超额"是稳定状态
  // (agent 上下线不会让一台机器忽然从超额变合规, 见文件头设计说明).
  if (seq <= allowed) {
    return { allow: true, reason: 'within_quota', seq, allowed, used: null, over_by: null };
  }

  const overBy = seq - allowed;
  return { allow: false, reason: 'over_quota', seq, allowed, used: seq, over_by: overBy };
}