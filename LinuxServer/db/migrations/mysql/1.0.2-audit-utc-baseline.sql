-- R161.16 (2026-10-27) — audit_logs 旧基准行的前像备份表 (MySQL)
--
-- ★ verify 标记 (R161.17) —— 本文件**建表**, 所以必须声明它建的表叫什么:
--   init 向导的 backfillMigrations 在往 schema_migrations 登记 'applied'
--   之前, 会先探针验证这张表是不是真的在库里; 探针不过 ⇒ **不登记** ⇒
--   启动迁移 (upgrade) 会真的把这个文件跑一遍, 把表建出来。
--   没有这个标记 ⇒ backfill 会**无条件**把本文件登记成 applied 而**从不执行**
--   ⇒ 全新安装出来的库永远缺这张表 (R161.17 的现场: 新装库与源库的唯一差异
--   就是这张表; 而 services/audit-utc-baseline.js 的自愈回填在缺表时直接
--   放弃 ⇒ R161.16 的审计时间修复在全新安装的部署上从来没生效过)。
-- verify: table audit_logs_utc_baseline_backup
--
-- 背景:
--   audit_logs.created_at 在 MySQL 基线里是
--       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
--   MySQL 的 CURRENT_TIMESTAMP 取的是**会话时区**的墙钟。MSSQL 基线用的是
--   sysutcdatetime() ⇒ 恒为 UTC。R161.10 之前中心端没钉会话时区, 于是
--   MySQL 部署上"钉之前"写下的那些行存的是**服务器本地墙钟** (本机 = CST,
--   +480 分钟), 而前端统一把 naive DATETIME 当 UTC 解读 ⇒ 那批行整体晚 8 小时。
--
--   这张表是**前像备份表**: 回填 (services/audit-utc-baseline.js) 在平移
--   created_at 之前, 先把「原值 + 目标值」写进来。于是:
--     - 回填天然幂等 (平移语句永远按备份表里的目标值写, 跑第二遍不二次平移);
--     - 回填可逆 (按备份表的 original_created_at 反着改回来即可);
--     - 偏移量与分界点都留痕 (offset_minutes / baseline_version)。
--
-- 偏移**不写死在这里** —— 它取决于部署所在机器的本地时区, 不是产品常量。
-- 实际偏移由 services/audit-utc-baseline.js 从库里量出来, 落在
-- system_config.config_key='audit_utc_baseline' 这个单一真源里。
--
-- DDL 前必须 SET SESSION lock_wait_timeout:
--   MySQL 的元数据锁等待超时默认是 31536000 秒 (一年)。备份表被别的会话
--   锁住时, 不设这个值 ⇒ 迁移在启动路径上**挂死一年**。10 秒足够, 抢不到
--   锁就失败重试, 而不是把服务拖死。
--
-- 幂等性: CREATE TABLE IF NOT EXISTS —— 重复执行不会报错, 也不会动已有数据。

SET SESSION lock_wait_timeout = 10;

CREATE TABLE IF NOT EXISTS audit_logs_utc_baseline_backup (
  audit_id BIGINT NOT NULL,
  original_created_at DATETIME NOT NULL,
  shifted_created_at DATETIME NOT NULL,
  offset_minutes INT NOT NULL,
  baseline_version INT NOT NULL,
  PRIMARY KEY (audit_id),
  KEY ix_backup_offset (offset_minutes)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
