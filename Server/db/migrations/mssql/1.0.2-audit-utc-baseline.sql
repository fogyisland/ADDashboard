-- R161.16 (2026-10-27) — audit_logs 旧基准行的前像备份表 (MSSQL)
--
-- 背景 / 与 MySQL 版的差异:
--   MSSQL 基线里 audit_logs.created_at 是
--       DATETIME2 NOT NULL DEFAULT sysutcdatetime()
--   sysutcdatetime() **恒为 UTC**, 不存在"会话时区墙钟"这个缺陷 ⇒ MSSQL
--   部署上不需要回填。但备份表照样建: 服务层 (services/audit-utc-baseline.js)
--   的回填路径是双方言共用的, 表在两边都在 ⇒ 同一个服务在两个库上行为一致,
--   不会因为"某个方言少了一张表"而在切换方言时炸掉。
--
--   (MSSQL 侧刻意**不改** audit_logs 的列定义: 它的 DEFAULT 本来就是 UTC。)
--
-- 前像备份表的用途 (与 MySQL 版完全相同):
--   - 回填天然幂等 (平移语句永远按备份表里的目标值写);
--   - 回填可逆 (按 original_created_at 反着改回来);
--   - 偏移量与真源版本留痕。
--
-- 幂等性: IF OBJECT_ID(...) IS NULL 守卫 —— MSSQL 没有
-- "CREATE TABLE IF NOT EXISTS" 语法 (那是 MySQL/MariaDB 的), 所以用
-- 系统目录守卫, 跟同库其它迁移一个写法。

IF OBJECT_ID('[audit_logs_utc_baseline_backup]', 'U') IS NULL
BEGIN
    CREATE TABLE [audit_logs_utc_baseline_backup] (
        [audit_id] BIGINT NOT NULL,
        [original_created_at] DATETIME2 NOT NULL,
        [shifted_created_at] DATETIME2 NOT NULL,
        [offset_minutes] INT NOT NULL,
        [baseline_version] INT NOT NULL,
        CONSTRAINT [PK_audit_logs_utc_baseline_backup] PRIMARY KEY ([audit_id])
    );
END
