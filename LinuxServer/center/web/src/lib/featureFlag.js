// R161.6 (2026-10-26) — feature flag 判定的**唯一实现** (前端侧)。
//
// ★ 与后端 src/utils/featureFlag.js **逐字对齐** (两份纯函数副本,
//   web 与 server 是两个构建产物, 不能跨目录 import)。
//   由 center/tests/feature-flag-semantics.test.js 锁死两端行为一致 ——
//   改这份语义时**必须**同时改 ../src/utils/featureFlag.js。
//
// ★ 语义 (后端 report-center.js / mcp.js / mcp-write.js 同款):
//
//     缺行 / undefined / null  →  **放行** (未配置 ≠ 关闭)
//     '1' | 1 | true            →  放行
//     其它一切 ('0'/0/false/''/脏值) → 拦截
//
// ★★ R161.6 改的就是第 1 条 —— 之前前端是 fail-**closed**
//   (缺 key ⇒ false ⇒ 入口被 v-if 过滤掉), 后端是 fail-**open**
//   (缺行 ⇒ 放行) ⇒ 两层口径分裂。现场症状:
//     操作员在功能开关页把 ad_management.enabled 打开, 首页「日常管理」
//     入口**不出现**, 但后端 API 照常可用。
//   根因链 (三层, 缺一不可):
//     ① 基线从来没 seed 过 report_center.* 这 4 把开关 (R161.6 已补);
//     ② 前端缺 key ⇒ 关闭, 与后端缺行 ⇒ 放行 相反 (本文件修);
//     ③ R159 的 init-state 闸门是 one-shot 且**无重试**, 一次
//        /api/init/status 抖动就永久关掉后台轮询 ⇒ flags store 整个会话
//        都是空的 (main.js 修)。
//   ⇒ 三层一起修, 只修一层都会留残症状。
//
//   fail-open 的理由: 「关掉是 operator 的**显式动作** (在开关页点一下),
//   不是故障的副作用。」 显式写 '0' 一律拦截 —— 那是明确的意图。

/**
 * 单个 flag 取值 → 是否启用。
 *
 * @param {string|number|boolean|null|undefined} value flags map 里的取值
 * @returns {boolean} true = 启用 (放行)
 */
export function isFlagValueEnabled(value) {
  // 缺 key / 未配置 = 不拦 (fail-open, 与后端 readFlag 原语义一致)
  if (value === undefined || value === null) return true;
  return value === '1' || value === 1 || value === true;
}

/**
 * 从 flags map 里取一个 key 判定开关状态。
 *
 * @param {Record<string, any>|null|undefined} flags flags map (可为空)
 * @param {string} key flag key
 * @returns {boolean} true = 启用 (放行)
 */
export function isFlagEnabled(flags, key) {
  if (!flags || typeof flags !== 'object') return true;   // 整个 map 都没拿到 ⇒ 未配置 ⇒ 放行
  return isFlagValueEnabled(flags[key]);
}

/**
 * 多把开关**全部**满足才放行 (router.js 的 meta.featureFlag 数组语义,
 * 跟后端 report-center.js gateFor() 的 required 数组同款)。
 *
 * @param {Record<string, any>|null|undefined} flags flags map
 * @param {string[]} keys 需要的 flag key 列表
 * @returns {boolean}
 */
export function areFlagsEnabled(flags, keys) {
  if (!Array.isArray(keys) || keys.length === 0) return true;
  return keys.every((key) => isFlagEnabled(flags, key));
}

/**
 * 路由守卫用的**三态**判定 (router.js isFeatureEnabled 直接调它)。
 *
 *   true  = 明确开启 → 放行
 *   false = 明确关闭 → 踢回首页
 *   null  = **未知** (整个 map 没拿到 / 该 key 根本没 seed) → 放行
 *
 * ★ 为什么"缺 key"算未知而不是关闭:
 *   缺 key = 该开关**未配置**, 不是 operator 关的它 ⇒ 放行。
 *   这跟后端 readFlag 的「缺行 = 未配置 = 不拦」是同一口径;
 *   旧实现 (map[key] === '1' → 缺 key ⇒ false) 跟后端相反, 是
 *   「开关开了首页却不显示」的另一半根因。
 *
 * @param {Record<string, any>|null|undefined} flags flags map
 * @param {string} key flag key
 * @returns {boolean|null}
 */
export function resolveFeatureFlag(flags, key) {
  if (!flags || typeof flags !== 'object') return null;                 // map 都没拿到
  if (Object.keys(flags).length === 0) return null;                     // 空 map = 未知
  if (!Object.prototype.hasOwnProperty.call(flags, key)) return null;   // 缺 key = 未配置
  return isFlagValueEnabled(flags[key]);
}
