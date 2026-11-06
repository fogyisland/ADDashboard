// center/src/db/sql/install-anchor.js
// R158.Trial-anchor (2026-10-22) — 安装锚点行 (system_config) 的 SQL helper.
//
// 2 helper × 2 dialect (getAnchor / insertAnchorIfAbsent).
//
// 为什么单独建文件而不是塞进 feature-flags.js: 锚点行的**写入语义与普通配置
// 相反**。system-settings 页的普通配置是 "admin 改什么就存什么"; 锚点行是
// "只在不存在时写一次, 存在就绝不覆盖" —— 覆盖等于把篡改痕迹洗掉。
// 放到同一个 helper 里, 后来的人很容易照抄 feature-flags 的 upsertValue
// (那是 MATCHED THEN UPDATE), 一改就把防篡改性去掉了。
//
// insertAnchorIfAbsent 用 **WHEN NOT MATCHED THEN INSERT** 且 **无
// WHEN MATCHED 分支** —— 与 feature-flags.upsertValue 的 MATCHED THEN UPDATE
// 结构上就不一样, 语义差异在 SQL 层面可见。
//
// CAST 说明: MSSQL 侧的 MERGE 源表必须显式 CAST, 否则 mssql@11 driver 对
// 嵌套 MERGE 的自动类型推断会静默抛错 (见 drivers/mssql.js:25-27 注释)。
// 该 PRECEDENT 来自 feature-flags.upsertValue, 不要"简化"掉 CAST。

export const installAnchorSql = {
  mysql: {
    getAnchor: `SELECT config_key, config_value, updated_at FROM system_config WHERE config_key = ?`,
    // ON DUPLICATE KEY UPDATE config_key = config_key = no-op: 命中已有行时
    // 什么都不改, 同时把"并发下两个进程同时建锚"从
    // "第二个抛 duplicate key" 变成静默收敛。MySQL 8 已弃用 VALUES() 形式,
    // 但此处 no-op 不带任何值, 无需别名写法。
    insertAnchorIfAbsent: `INSERT INTO system_config (config_key, config_value, description, updated_by)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE config_key = config_key`
  },
  mssql: {
    getAnchor: `SELECT [config_key], [config_value], [updated_at] FROM system_config WHERE [config_key] = CAST(? AS NVARCHAR(64))`,
    // 无 WHEN MATCHED 分支 = 已有行时彻底 no-op, 不会碰 config_value。
    insertAnchorIfAbsent: `MERGE INTO system_config AS t
      USING (SELECT CAST(? AS NVARCHAR(64)) AS config_key,
                    CAST(? AS NVARCHAR(MAX)) AS config_value,
                    CAST(? AS NVARCHAR(256)) AS description,
                    CAST(? AS NVARCHAR(64)) AS updated_by) AS s
      ON t.[config_key] = s.config_key
      WHEN NOT MATCHED THEN INSERT ([config_key], [config_value], [description], [updated_by])
      VALUES (s.config_key, s.config_value, s.description, s.updated_by);`
  }
};