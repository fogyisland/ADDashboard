// center/src/db/sql/system-registration.js
// R158.87 (2026-10-12) — ad_system_registration 公共表 SQL helper.
// License 查重 + 撤销. 2 helper × 2 dialect (findByHash / deactivate).
// 用 `?` 占位符, mssql driver wrapper rewrite.
//
// R158.LA-V1-delete (2026-10-15) — 删 getCurrent + activate (ADSPK V1 老格式专用).
//   V2 base32 (R158.LA) 走 ad-hoc INSERT, 0 改 SQL helper. 删后只剩 2 helper:
//     - findByHash   — base32 端点 (routes:504) 查重, 单一 active invariant
//     - deactivate   — base32 端点 (routes:509) 撤销, 跟 V1 1:1 平行
//
// R158.License-expiry (2026-10-15) — 加 1 helper findLatestActive (2 dialect).
//   派生 license display status (active/expiring_soon/expired/none).
//   走 `WHERE status='active' ORDER BY expires_at DESC NULLS LAST, id DESC LIMIT 1`
//   (mysql) / `TOP 1 ... ORDER BY ... DESC` (mssql) 取最新 1 行, 避免老 ADSPK row
//   跟新 base32 row 同时 active 时派生错乱 (Risk 5). 0 改老 row data.

export const systemRegistration = {
  mysql: {
    findByHash: `SELECT id, status, instance_id FROM ad_system_registration WHERE license_hash = ?`,
    deactivate: `UPDATE ad_system_registration
                 SET status = 'revoked', updated_at = CURRENT_TIMESTAMP(3)
                 WHERE status = 'active'`,
    // R158.License-expiry — 取最新 1 行 active license. _days_overdue_signed
    // = 已过天数 (正数 = 已过期 N 天, 负数 = 还有 N 天到期). Service 层取负
    // 算 days_remaining. expires_at NULL (永久 license) 排最前 (DESC NULLS LAST
    // 在 mysql 5.7+ 通过 ORDER BY 1/0 模拟 — 改用 `IS NULL` boolean 倒排).
    findLatestActive: `SELECT id, status, expires_at, instance_id, license_kind, license_request_id,
                              DATEDIFF(UTC_TIMESTAMP(), expires_at) AS _days_overdue_signed
                       FROM ad_system_registration
                       WHERE status = 'active'
                       ORDER BY (expires_at IS NULL) DESC, expires_at DESC, id DESC
                       LIMIT 1`,
    // R158.X.99-quota (2026-10-21) — 配额列**独立 helper**, 刻意不并进 findLatestActive.
    //   原因: max_nodes / max_nodes_allowed 由启动期 ALTER 加上去, 若 ALTER 失败
    //   (权限不足 / MySQL baseline 根本没这张表 / 表被锁), 并进主查询会让整个
    //   license-state 端点抛 SQL 错误 —— 连 trial banner 和登录拦截一起挂掉。
    //   配额是**可选增强**, 绝不能拖累 license 核心链路 (lesson: 可选功能独立失败域).
    //   WHERE 条件跟 findLatestActive 逐字一致, 保证取到的是同一行.
    findActiveQuota: `SELECT max_nodes, max_nodes_allowed
                      FROM ad_system_registration
                      WHERE status = 'active'
                      ORDER BY (expires_at IS NULL) DESC, expires_at DESC, id DESC
                      LIMIT 1`
  },
  mssql: {
    // R158.X.116.p.3 — 原为 CAST(? AS CHAR(64))。CHAR 在 MSSQL 里是**定长、
    //   空白填充、非 Unicode** 类型, 方言上错误 (CHAR 是 MySQL 的类型名);
    //   本项目其余 200+ 处 mssql CAST 一律 VARCHAR/NVARCHAR, 同类「64 字符
    //   主键查重」在 install-anchor.js:32 用的正是 NVARCHAR(64)。
    //   当前因 SHA-256 hexdigest 恰好 64 字符、不会截断而不致命, 但静默填充
    //   一旦 hash 长度规则变化就变成难查的查重失效 —— 属「现在碰巧没事」。
    findByHash: `SELECT id, status, instance_id FROM ad_system_registration WHERE license_hash = CAST(? AS NVARCHAR(64))`,
    deactivate: `UPDATE ad_system_registration
                 SET status = 'revoked', updated_at = SYSUTCDATETIME()
                 WHERE status = 'active'`,
    // R158.License-expiry — 取最新 1 行 active license. mssql 用 TOP 1 + CASE
    // 把 NULL 永久 license 排最前, 然后 expires_at DESC, id DESC. 跟 mysql 版
    // 语义 1:1 平行. DATEDIFF(day, SYSUTCDATETIME(), expires_at) 返 expires_at
    // 跟 now 的天数差 (负数 = 还没到期, 正数 = 已过 N 天). service 层取负.
    findLatestActive: `SELECT TOP 1 id, status, expires_at, instance_id, license_kind, license_request_id,
                              DATEDIFF(day, SYSUTCDATETIME(), expires_at) AS _days_overdue_signed
                       FROM ad_system_registration
                       WHERE status = 'active'
                       ORDER BY
                         CASE WHEN expires_at IS NULL THEN 0 ELSE 1 END ASC,
                         expires_at DESC,
                         id DESC`,
    // R158.X.99-quota — 配额列独立 helper, 理由跟 mysql 版逐字 1:1 平行 (见上).
    findActiveQuota: `SELECT TOP 1 max_nodes, max_nodes_allowed
                      FROM ad_system_registration
                      WHERE status = 'active'
                      ORDER BY
                        CASE WHEN expires_at IS NULL THEN 0 ELSE 1 END ASC,
                        expires_at DESC,
                        id DESC`
  }
};
