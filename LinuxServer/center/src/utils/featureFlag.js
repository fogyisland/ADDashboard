// R161.6 (2026-10-26) — feature flag 判定的**唯一实现** (后端侧)。
//
// ★ 为什么抽成公共函数 (R161.6 根因):
//   「读一行 flag → 判定开/关」这段逻辑在 3 个路由里各写了一遍 ——
//     routes/report-center.js  readFlag()
//     routes/mcp.js            isMcpEnabled()
//     routes/mcp-write.js      isWriteEnabled()
//   3 份**逐字相同**却各自独立演进过 (每加一个后端 gate 就抄一份),
//   而前端还有第 4 份 (stores/featureFlags.js isEnabled +
//   router.js isFeatureEnabled), 那份的语义跟后端**相反**:
//     后端: 缺行 ⇒ 放行   (readFlag: `if (!rows.length) return true;`)
//     前端: 缺 key ⇒ 关闭  (isEnabled: `v === '1' || ...`, undefined ⇒ false)
//   ⇒ 两层判定分裂 ⇒ 症状就是「开关明明开着, 首页就是不显示」。
//   ⇒ 语义只允许有**一处定义**。web 与 server 是两个构建产物, 不能跨目录
//     import, 所以两端各留一份**纯函数**副本 (web/src/lib/featureFlag.js),
//     并由 tests/feature-flag-semantics.test.js 锁死两端行为逐格一致。
//     ★ 改这份语义时**必须**同时改 web/src/lib/featureFlag.js。
//
// ★ 语义 (与 web/src/lib/featureFlag.js 逐字对齐):
//
//     缺行 / undefined / null  →  **放行** (未配置 ≠ 关闭)
//     '1' | 1 | true            →  放行
//     其它一切 ('0'/0/false/''/脏值) → 拦截
//
//   fail-open 的理由 (跟 report-center.js / mcp.js / mcp-write.js 原有注释同):
//     「关掉是 operator 的**显式动作** (在功能开关页点一下), 不是故障的副作用。」
//     DB 抖动 / 行还没 seed / 端点挂了, 都不该让功能凭空消失。
//   反过来, 显式写成非启用值 ('0') 一律拦截 —— 那是 operator 的明确意图。
//
// ★ 注意: 这里**不**把 'true'/'on'/'yes' 之类字符串当启用。
//   后端原有的判定是 `v === '1' || v === 1 || v === true`, 收紧或放宽都会
//   改变生产库既有行的行为 (UI 只写 '0'/'1', 但 rollout 那 2 行是
//   'full'/'100' —— 它们不是布尔开关, 走专有端点, 不经过本函数)。

/**
 * 单个 flag 取值 → 是否启用。
 *
 * @param {string|number|boolean|null|undefined} value 表里的 value 字段
 * @returns {boolean} true = 启用 (放行)
 */
export function isFlagValueEnabled(value) {
  // 缺行 / 未配置 = 不拦 (fail-open, 与后端 readFlag 原语义一致)
  if (value === undefined || value === null) return true;
  return value === '1' || value === 1 || value === true;
}

/**
 * 读一行 flag 并判定开关状态 (fail-open)。
 *
 * 行为:
 *   · 行不存在            → 放行
 *   · 读库抛错            → 放行 (并 warn, 不静默)
 *   · 值为 '1'/1/true     → 放行
 *   · 其它值              → 拦截
 *
 * @param {object} db        统一的 db 句柄 (需有 .execute / .sql)
 * @param {string} key       flag key
 * @param {object} [logger]  pino logger (可选)
 * @param {string} [label]   日志前缀 (默认 'feature-flag')
 * @returns {Promise<boolean>}
 */
export async function readFeatureFlag(db, key, logger, label = 'feature-flag') {
  try {
    const res = await db.execute(db.sql.featureFlags.getByKey, [key]);
    const rows = res?.rows || [];
    if (!rows.length) return true;               // 缺行 = 未配置 = 不拦
    return isFlagValueEnabled(rows[0].value);
  } catch (e) {
    logger?.warn?.({ err: e?.message, flag: key },
      `${label} feature flag read failed, fail-open`);
    return true;                                 // fail-open: DB 抖动不该误关功能
  }
}
