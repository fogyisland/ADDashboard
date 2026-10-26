// center/src/db/sql/license-request.js
// R158.LA (2026-10-15) — ad_license_request 公共表 SQL helper.
// 5 段 base32 license 申请单落盘元数据。4 helper × 2 dialect (mysql + mssql).
// 跟 R158.87 system-registration.js 同 precedent:
//   insert / findById / markActivated — 走 `?` 占位符,
//   mssql driver wrapper rewrite N 参到单行. listByInstance 是**例外**
//   (R161.10): 行数上限是**整数内联**, 不是占位符 —— 详见文件头 R161.10 段.
//   License 流程元数据
//   永久保留 (HMAC 路径绑定, 删了 JSON 文件无法重 verify, 所以 metadata
//   也跟着留).
//
// R158.X.99.30 (2026-10-19) — 周期单位月→年, 列名 `months` 保留 (0 ALTER 列).
//   1:1 平行 R158.LA / R158.License-config precedent 锁. 语义: 1 年 = 366 天
//   (操作员 directive D5 闰年上限简化为 366). 前端范围 1-5 (默认 1), 后端
//   validator months_out_of_range:1-5 (license-validator.js:112-113). 推算
//   公式 走 route layer (system-settings-v2.js verify + activate 2 处,
//   yearsNum * 366 * 24 * 60 * 60 * 1000), 0 必 SQL 端 DATEDIFF 派生.
//
// ---------------------------------------------------------------------------
// R161.10 (2026-10-26) — ★★ 占位符个数必须等于绑定参数个数 (500 根因) ★★
//
// ★ 现场 (操作员 2026-10-26 报):
//   `GET /api/admin/system-settings-v2/license/requests` → 500。
//   中心端日志 (center.2026-10-26.1.log) 里对应条目:
//     "Incorrect arguments to mysqld_stmt_execute"
//     at Object.query (src/db/index.js:65) → mysql driver → pool.execute
//   (mysql2 走的是**预处理协议** —— 驱动层 `params.length === 0` 才退回
//    COM_QUERY; 这里 params.length = 1 ⇒ 走 execute ⇒ 预处理语句。)
//
// ★ 根因:
//   mysql 侧 listByInstance 的 SQL 里有**两个** `?`
//   (WHERE instance_id = ? 与 LIMIT ?), 而唯一调用点
//   (routes/system-settings-v2.js:467) 只绑了**一个**参数 [instanceId]
//   ⇒ 预处理语句的参数个数对不上 ⇒ mysqld_stmt_execute 直接拒执行。
//
// ★ 为什么潜伏了这么久:
//   这个 helper 从写下来到被调用**从没执行过** —— 与同文件 R93.4 修掉的
//   MSSQL `TOP (?)` 一模一样: "helper 从未被调用 ≠ helper 是对的"。
//   端点 2026-10-23 (R158.LA-hide-activated) 才第一次真的被点到, 当场炸。
//
// ★ 修法 (两边统一成**函数形式**, 整数内联):
//   mysql 侧也改成 (limit) => sql, 把行数上限当**整数**内联进 SQL,
//   产出的 SQL 里只剩 `instance_id = ?` **一个**占位符 —— 与 mssql 侧
//   结构完全一致, 调用点 0 分叉 (两边都是 limit => sql, 都只绑 1 个参数)。
//   ★ 为什么不用 `LIMIT ?` + 多绑一个参数:
//     (1) 会让调用点按方言分叉 (mssql 侧 TOP 内联, 只绑 1 个参数),
//         正是本项目 "1:1 平行" 纪律要消灭的东西;
//     (2) mysql2 的预处理协议对 `LIMIT ?` 还有第二个坑: 绑**字符串**
//         ("50") 会炸, 只能绑数字 —— 又是一个"看起来对、实际会炸"的坑。
//     内联成整数后, 这两个坑一起消失。
//
// ★ 顺带修掉一个潜伏的语法坑 (两边都有):
//   老的夹取写法 `Math.max(1, Math.min(1000, Number(limit) || 100))`,
//   Number('12.7') = 12.7 ⇒ 内联出来是 `LIMIT 12.7` / `TOP 12.7`
//   —— MySQL/MSSQL 都是语法错误。现在统一走 clampRowLimit(): 截断到整数。
// ---------------------------------------------------------------------------

/**
 * 行数上限的**整数化**闸门 (两边方言共用)。
 *
 * 语义与老 mssql 夹取逐字等价 (0 → 100, 负数 → 1, 非数 → 100, >1000 → 1000),
 * 额外保证产物一定是**正整数** —— 内联进 SQL 因此没有任何注入面。
 *
 * @param {unknown} limit 任意输入 (query 参数 / 字符串 / null)
 * @returns {number} 1..1000 的正整数
 */
export function clampRowLimit(limit) {
  const n = Number(limit);
  const v = Number.isFinite(n) ? Math.trunc(n) : 100;
  return Math.max(1, Math.min(1000, v || 100));
}

export const licenseRequest = {
  mysql: {
    insert: `INSERT INTO ad_license_request
             (request_id, company, mac_address, months, max_nodes, installed_at, signature, instance_id, kind, json_path)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    findById: `SELECT id, request_id, company, mac_address, months, max_nodes, installed_at, signature, instance_id, kind, json_path, verified_at, activated_at, license_id, created_at, updated_at
                FROM ad_license_request WHERE request_id = ?`,
    markActivated: `UPDATE ad_license_request
                    SET activated_at = CURRENT_TIMESTAMP(3), license_id = ?
                    WHERE request_id = ?`,
    // R161.10 — 改成函数形式, 行数上限整数内联 ⇒ SQL 里只剩 1 个 `?`
    // (与调用点绑定的 [instanceId] 一一对应)。详见文件头 R161.10 段。
    listByInstance: (limit) => `SELECT id, request_id, company, months, max_nodes, instance_id, kind, created_at, activated_at
                     FROM ad_license_request
                     WHERE instance_id = ? AND activated_at IS NULL
                     ORDER BY created_at DESC
                     LIMIT ${clampRowLimit(limit)}`
  },
  mssql: {
    insert: `INSERT INTO ad_license_request
             (request_id, company, mac_address, months, max_nodes, installed_at, signature, instance_id, kind, json_path)
             OUTPUT inserted.id
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    findById: `SELECT id, request_id, company, mac_address, months, max_nodes, installed_at, signature, instance_id, kind, json_path, verified_at, activated_at, license_id, created_at, updated_at
                FROM ad_license_request WHERE request_id = ?`,
    markActivated: `UPDATE ad_license_request
                    SET activated_at = SYSUTCDATETIME(), license_id = ?
                    WHERE request_id = ?`,
    // R158.LA-hide-activated (2026-10-23) — 加 `AND activated_at IS NULL`: 已激活的
//   申请单不返回。判在 SQL 里是单一口径 (lesson 159), 别改成 JS 侧 truthy 判断。
//
// ⚠ R93.4 起 mssql 侧必须走**函数形式**: MSSQL 的 `TOP` 只接受整数字面量,
//   走 sp_executesql 参数绑定 `TOP (?)` 会抛 error 1060
//   ("The number of rows provided for a TOP or FETCH clauses row count parameter
//   must be an integer")。历史上这个 helper 从没被调用过, 所以带着 `TOP (?)`
//   潜伏了很久 —— **helper 从未被调用 ≠ helper 是对的** (lesson 163 同源)。
//   1:1 平行 sql.js:3680 listRecent 的 R93.4 修法: 把整数内联。
//   ★ R161.10: mysql 侧也改成了函数形式 (同一个根因家族, 详见文件头 R161.10 段),
//   两边产出的 SQL 都恰好含 1 个 `?` (instance_id) —— 调用点 0 分叉。
listByInstance: (limit) => `SELECT TOP ${clampRowLimit(limit)} id, request_id, company, months, max_nodes, instance_id, kind, created_at, activated_at
                     FROM ad_license_request
                     WHERE instance_id = ? AND activated_at IS NULL
                     ORDER BY created_at DESC`
  }
};
