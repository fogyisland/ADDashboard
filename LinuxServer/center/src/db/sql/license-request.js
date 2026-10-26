// center/src/db/sql/license-request.js
// R158.LA (2026-10-15) — ad_license_request 公共表 SQL helper.
// 5 段 base32 license 申请单落盘元数据。4 helper × 2 dialect (mysql + mssql).
// 跟 R158.87 system-registration.js 同 precedent:
//   insert / findById / markActivated / listByInstance — 走 `?` 占位符,
//   mssql driver wrapper rewrite N 参到单行. License 流程元数据
//   永久保留 (HMAC 路径绑定, 删了 JSON 文件无法重 verify, 所以 metadata
//   也跟着留).
//
// R158.X.99.30 (2026-10-19) — 周期单位月→年, 列名 `months` 保留 (0 ALTER 列).
//   1:1 平行 R158.LA / R158.License-config precedent 锁. 语义: 1 年 = 366 天
//   (操作员 directive D5 闰年上限简化为 366). 前端范围 1-5 (默认 1), 后端
//   validator months_out_of_range:1-5 (license-validator.js:112-113). 推算
//   公式 走 route layer (system-settings-v2.js verify + activate 2 处,
//   yearsNum * 366 * 24 * 60 * 60 * 1000), 0 必 SQL 端 DATEDIFF 派生.

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
    listByInstance: `SELECT id, request_id, company, months, max_nodes, instance_id, kind, created_at, activated_at
                     FROM ad_license_request
                     WHERE instance_id = ? AND activated_at IS NULL
                     ORDER BY created_at DESC
                     LIMIT ?`
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
//   MySQL 侧保留 `LIMIT ?`, mysql2 接受参数绑定。
listByInstance: (limit) => `SELECT TOP ${Math.max(1, Math.min(1000, Number(limit) || 100))} id, request_id, company, months, max_nodes, instance_id, kind, created_at, activated_at
                     FROM ad_license_request
                     WHERE instance_id = ? AND activated_at IS NULL
                     ORDER BY created_at DESC`
  }
};
