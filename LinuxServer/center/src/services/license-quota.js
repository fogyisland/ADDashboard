// center/src/services/license-quota.js
// R158.X.99-quota (2026-10-21) — 授权节点配额派生 (1.2 倍宽限 policy).
//
// 操作员 2026-10-21 决策: 上限 = ceil(申请节点数 × 1.2). 申请 30 → 36, 100 → 120, 1 → 2.
// 语义 = "申请 30 个节点, 允许 20% 余量, 超过 36 个加不进来".
//
// 前置问题 (本轮解决的): max_nodes 在激活后丢失 —— ad_system_registration 无此列,
//   activate 端点 INSERT 不写它, license-codec 的 verifyLicenseCode 从不解密 payload.
//   本模块 0 改 codec, 0 改既有 license 流程; 只负责"拿到 max_nodes 之后怎么算配额".
//
// 宽限策略的 storage 决策: **实时算, 不存库**. 理由:
//   - 若把 ceil(max_nodes × 1.2) 存进 max_nodes_allowed 列, 将来调整宽限比例 (1.2 → 1.5)
//     需要重新激活 license 才能生效, 且要再改一次 schema.
//   - 实时算是纯函数, 改 POLICY 一处即全链路生效, 且 max_nodes 只存"申请意图"这一个语义,
//     不引入第二份可能跟申请单不一致的派生副本 (lesson: 派生值只存一处, 存两处必漂移).
//   - 代价是每次查询多一次 ceil() 运算 —— 可忽略, 不是热路径.
//
// 纯函数模块: 0 IO, 0 依赖 license-codec / license-state / db. 便于独立验证.

/** 宽限比例 (2026-10-21 操作员决策: 20% 余量). 改这里即全链路生效. */
export const NODE_HEADROOM_RATIO = 1.2;

/**
 * applyHeadroom — 申请节点数 → 实际允许上限.
 *
 * 向上取整 (ceil) 而非四舍五入: 余量只能多不能少. 申请 30 → 36 (恰), 申请 1 → 2
 * (若用 round, 1×1.2=1.2 → round=1, 等于没给余量, 违背 policy 语义).
 *
 * @param {unknown} maxNodes 申请单里的 max_nodes (可能来自 JSON / query string / DB)
 * @returns {number|null} 允许上限; null = 无限制 (max_nodes 缺失/非法/<=0)
 */
export function applyHeadroom(maxNodes) {
  const n = Number(maxNodes);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.ceil(n * NODE_HEADROOM_RATIO);
}

/**
 * buildQuota — 派生完整的节点配额视图 (给 license-state envelope / 前端展示).
 *
 * @param {unknown} maxNodes 申请节点数 (max_nodes 列或申请单字段)
 * @param {unknown} usedNodes 当前已接入 agent 数
 * @returns {{
 *   max_nodes: number|null, headroom_ratio: number, allowed_nodes: number|null,
 *   used_nodes: number, remaining_nodes: number|null, over_quota: boolean|null,
 *   enforced: boolean
 * }}
 *
 * `enforced` 语义: false = 无限额 (max_nodes 缺失, 存量老 license 无此列) 或
 *   usedNodes 拿不到 (统计失败). 这两种情况**一律不拦截** —— fail-open,
 *   理由跟 license-state 的 fail-closed 是反的: 统计失败不该把新 agent 全拒掉.
 *   但要能被界面看见 (lesson 71/72: 隐藏的降级必须可观测), 所以 exposed 而非静默.
 */
export function buildQuota(maxNodes, usedNodes) {
  const allowed = applyHeadroom(maxNodes);
  const used = Number(usedNodes);

  if (allowed === null) {
    return {
      max_nodes: null,
      headroom_ratio: NODE_HEADROOM_RATIO,
      allowed_nodes: null,
      used_nodes: Number.isFinite(used) ? used : null,
      remaining_nodes: null,
      over_quota: null,
      enforced: false
    };
  }
  if (!Number.isFinite(used)) {
    // 知道上限但统计不到用量 → 不判超额 (fail-open), 但界面要显示"用量未知".
    return {
      max_nodes: Number(maxNodes),
      headroom_ratio: NODE_HEADROOM_RATIO,
      allowed_nodes: allowed,
      used_nodes: null,
      remaining_nodes: null,
      over_quota: null,
      enforced: false
    };
  }
  const remaining = allowed - used;
  return {
    max_nodes: Number(maxNodes),
    headroom_ratio: NODE_HEADROOM_RATIO,
    allowed_nodes: allowed,
    used_nodes: used,
    remaining_nodes: remaining,
    over_quota: remaining < 0,
    enforced: true
  };
}