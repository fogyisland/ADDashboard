-- verify: columntype ad_replication_active_errors.status_code int
--
-- R161.31 (2026-11-07) — ad_replication_active_errors.status_code 加宽 TINYINT → INT (MySQL)
--
-- ★★ 为什么用 `columntype` 而不是 `column`:
--   `column` 探针只查列**在不在**, **不查列的类型**
--   (center/src/db/sql.js 的 probe.column:
--      SELECT 1 AS ok FROM information_schema.COLUMNS
--       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
--   —— 没有 DATA_TYPE 条件)。
--   而这个迁移改的**就是类型**, 列本来就存在 (TINYINT) ⇒ `column` 探针
--   **必然通过** ⇒ backfillMigrations() 会把本迁移**登记成 applied 而从不执行**
--   ⇒ 存量库的列**永远是 TINYINT** ⇒ 那个恒 0 行的 bug **原样留着**,
--     而且零告警 (这正是 R161.17 修掉的"编号迁移从来没被真正执行过"的
--     同一个坑换了个形状: 那次是"没标记 ⇒ 无条件登记", 这次是
--     "标记了但探针查不到类型差异 ⇒ 照样登记")。
--   ⇒ R161.31 给 verify 契约新增了 `columntype` 类型 (探针比对 DATA_TYPE),
--     类型变更类迁移**必须**用它。
--     (README 规则 0 的原话是"标记指向的产物, 就是这个迁移文件**建出来的东西**"
--      —— 类型变更没有"建出来"任何新东西, 列是旧的, 但它的**类型**是新的。)
--
-- ★★ 幂等性由 DDL 自身的守卫保证 (README 规则 2):
--   MySQL 5.7 没有 `ALTER TABLE ... MODIFY COLUMN IF EXISTS` 之类,
--   ⇒ 用 INFORMATION_SCHEMA 探当前 DATA_TYPE, 只有"不是 int"时才执行 ALTER。
--   ⇒ 本文件重复跑**不会**报错, 也不会重复改表 (改一次也是幂等的, 但少做
--     一次 ALTER 就少一次元数据锁窗口)。
--
-- ★★ 为什么要加宽 (真库证据):
--   实测生产库 (MySQL 5.7.44):
--     · ad_replication_active_errors.status_code 的列定义是 **tinyint(4)**
--       (TINYINT 有符号 ⇒ 值域 -128..127)
--     · ad_replication_status.status_code 的**实际值域**是 min=0 **max=1398**
--       (1398 = 命名空间绑定失败, 1722 = RPC 服务器不可用 —— Windows 错误码)
--   ⇒ 真实 status 值**装不进** TINYINT ⇒ 每次写 active_errors 都报
--     "Out of range value for column 'status_code' at row 1" ⇒
--     **ad_replication_active_errors 表恒为 0 行** ⇒
--     /admin/replication-errors 恒显示「无错误」, 与 /errors 口径分裂。
--   ⇒ 这个失败被 services/replication.js 的 catch 只 logger.warn 掉了
--     (静默), 所以潜伏了 4 天没人发现。
--   ⇒ 修法 = 把列加宽到 INT, 与 ad_replication_status.status_code
--     (以及 ad_replication_history.status_code) 的类型对齐。
--
-- ★ 为什么不是 SMALLINT:
--   ad_replication_status / ad_replication_history 两张表的 status_code
--   都是 **INT** ⇒ 三个表用同一个类型, 免得将来又出现"这个表装不下
--   那个表的码"的分叉。INT 也够: Windows 错误码最大 65535 (NTSTATUS),
--   远在 INT 范围内。

-- DDL 前必须 SET SESSION lock_wait_timeout:
--   MySQL 的元数据锁等待默认 31536000 秒 (一年)。列被别的会话锁住时,
--   不设这个值 ⇒ 迁移在启动路径上**挂死一年**。10 秒足够, 抢不到锁就失败
--   重试, 而不是把服务拖死。
SET SESSION lock_wait_timeout = 10;

-- 守卫: 只有当前类型不是 int 时才 ALTER。
--   ⚠ 用 DATA_TYPE 而不是 COLUMN_TYPE: MySQL 5.7 里 `int(11)` 与 `int` 的
--     COLUMN_TYPE 带显示宽度, 而 `INT` 声明宽度已废弃 (MySQL 8.0 移除)。
--     DATA_TYPE 是**基本类型名** ('int' / 'tinyint' / 'smallint' ...),
--     不带显示宽度 ⇒ 两个方言/版本之间可比。
--   ⚠ 还要看 IS_NULLABLE: 本列是 NOT NULL, ALTER 时必须带上 NOT NULL,
--     否则 MODIFY COLUMN 会把 NOT NULL 丢掉 (MySQL 的 MODIFY 是整列重定义,
--     不写就按列的**当前**定义来 —— 实际上 MySQL 会保留, 但显式写出来
--     免得以后有人改了列的默认值/注释时被 MODIFY 悄悄重置)。
SET @s = (SELECT IF(
  (SELECT DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'ad_replication_active_errors'
      AND COLUMN_NAME = 'status_code') <> 'int',
  'ALTER TABLE ad_replication_active_errors MODIFY COLUMN status_code INT NOT NULL',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
