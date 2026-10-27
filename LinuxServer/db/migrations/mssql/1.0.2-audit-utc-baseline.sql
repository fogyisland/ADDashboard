-- R161.16 (2026-10-27) — audit_logs 旧基准行的前像备份表 (MSSQL)
--
-- ★ verify 标记 (R161.17) —— 本文件**建表**, 所以必须声明它建的表叫什么:
--   init 向导的 backfillMigrations 在往 schema_migrations 登记 'applied'
--   之前, 会先探针验证这张表是不是真的在库里; 探针不过 ⇒ **不登记** ⇒
--   启动迁移 (upgrade) 会真的把这个文件跑一遍, 把表建出来。
--   没有这个标记 ⇒ backfill 会**无条件**把本文件登记成 applied 而**从不执行**
--   ⇒ 全新安装出来的库永远缺这张表 (R161.17 的现场)。
-- verify: table audit_logs_utc_baseline_backup
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
