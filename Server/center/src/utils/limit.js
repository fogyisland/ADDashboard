// center/src/utils/limit.js
// R161.10 (2026-10-26) — "行数上限" 的**唯一**整数闸门。
//
// ★ 为什么要有这个模块 (两个缺陷同源, 都是"整数没守住"):
//
//   (1) 占位符家族 (MySQL):
//       mysql2 走**预处理协议** (execute) 时, `LIMIT ?` / `OFFSET ?` 的绑定值
//       必须是**整数**。绑字符串 ("50") 或浮点 (12.7) ⇒ 服务端
//       mysqld_stmt_execute 直接拒执行 ⇒ "Incorrect arguments to
//       mysqld_stmt_execute" ⇒ 端点 500。
//       ★ R161.10 修的 `GET /api/admin/system-settings-v2/license/requests` 500
//         就是这一族 (那边是**占位符个数**对不上, 这边是**类型**不对)。
//
//   (2) 内联家族 (MSSQL):
//       MSSQL 的 `TOP` 只接受整数**字面量** ⇒ 函数形式的 builder 把上限内联进
//       SQL。内联出来是 `TOP 12.7` / `LIMIT 12.7` 时, 两边都是**语法错误**
//       (R93.4 的 `TOP (?)` 报 error 1060 是同一族的另一面)。
//
// ★ 语义 (与本仓既有的 `Math.max(1, Math.min(1000, Number(x) || 100))` 逐字等价,
//   额外保证产物一定是**正整数** —— 内联进 SQL 因此没有任何注入面):
//   非数 / NaN / undefined → fallback (默认 100)
//   0                     → fallback (0 是 falsy, 与既有写法一致)
//   负数                  → min (默认 1)
//   > max                 → max (默认 1000)
//   浮点                  → 截断 (12.7 → 12)
//
// ★ 用法: 一律在**值进入 SQL 之前**过这个闸门 ——
//   - MySQL 侧: 绑进 `LIMIT ?` / `OFFSET ?` 的参数;
//   - MSSQL 侧: 内联进 `TOP n` / `FETCH NEXT n` 的数字;
//   - 服务层:   任何来自 HTTP query / 上游的 limit 值 (在进 builder 之前)。
//
// ★ 为什么不做成 driver 层的兜底: driver 层不知道哪个参数是 limit, 猜错就会
//   把别的列的值也改掉 (R161.5 的教训: "禁止 driver 层兜底")。闸门放在
//   **值的来源处** (服务层 / builder), 责任单一, 可测。

/**
 * 把任意输入夹取成 1..max 的**正整数**。
 *
 * @param {unknown} limit 任意输入 (query 参数 / 字符串 / 数字 / null)
 * @param {object} [opts]
 * @param {number} [opts.min=1] 下界
 * @param {number} [opts.max=1000] 上界
 * @param {number} [opts.fallback=100] 非数 / 0 时的兜底值
 * @returns {number} [min, max] 区间的正整数
 */
export function clampRowLimit(limit, { min = 1, max = 1000, fallback = 100 } = {}) {
  const n = Number(limit);
  // NaN / Infinity ⇒ 兜底; 其余截断到整数 (12.7 → 12)
  const truncated = Number.isFinite(n) ? Math.trunc(n) : fallback;
  // 0 与既有写法一致 (0 || fallback) ⇒ 走兜底, 不是 min
  const v = truncated === 0 ? fallback : truncated;
  return Math.max(min, Math.min(max, v));
}
