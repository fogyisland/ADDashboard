-- verify: columntype ad_replication_probe_history.status_code int
--
-- R161.31 (2026-11-07) — ad_replication_probe_history.status_code 加宽 TINYINT → INT (MySQL)
--
-- ★★ 为什么用 `columntype` 而不是 `column`:
--   `column` 探针只查列**在不在**, **不查列的类型**
--   (center/src/db/sql.js 的 probe.column:
--      SELECT 1 AS ok FROM information_schema.COLUMNS
--       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
--   —— 没有 DATA_TYPE 条件)。
--   而这个迁移改的**就是类型**, 列本来就存在 (TINYINT) ⇒ `column` 探针
--   **必然通过** ⇒ backfillMigrations() 会把本迁移**登记成 applied 而从不执行**
--   ⇒ 存量库的列**永远是 TINYINT** ⇒ 下面这个丢行 bug **原样留着**, 而且零告警。
--   ⇒ R161.31 给 verify 契约新增了 `columntype` 类型 (探针比对 DATA_TYPE),
--     类型变更类迁移**必须**用它。
--
-- ★★ 真库证据 (实测生产库 MySQL 5.7.44):
--   · ad_replication_probe_history.status_code 的列定义是 **tinyint(4)**
--     (TINYINT 有符号 ⇒ 值域 -128..127)
--   · 该表当前行数是 **0**
--   ⇒ 真的插一行 status_code=1398 进去, 驱动报:
--       ER_WARN_DATA_OUT_OF_RANGE
--       Out of range value for column 'status_code' at row 1
--
-- ★★ 丢行是怎么发生的 (完整链路):
--   center/src/services/replication-status-probe.js:40-42
--     status_code: Number.isFinite(p.status_code)
--       ? Number(p.status_code)
--       : (Number.isFinite(p.statusCode) ? Number(p.statusCode) : 2)
--   ⇒ 这是一个**无钳位的 passthrough** —— agent 上报什么整数就存什么整数,
--     没有上下界检查。
--   ⇒ 中心端把这份 status_code 原样写进 ad_replication_probe_history
--     ⇒ 一旦 agent 报出 > 127 的 Windows 错误码 (1398 / 1722 ...),
--       这一行**必然写失败**。
--   ⇒ 当前的 status_code 生产者只发 {0,1,2} 这个枚举 (0=成功, 1=?, 2=错误),
--     所以这条路径**目前还没炸** —— 但它**离炸只差一个整数**:
--     agent 端只要把真实的 NTSTATUS 错误码透传上来, 中心端就会开始丢行。
--   ⇒ 这跟 ad_replication_active_errors / ad_dc_*_partners 是**同一个族**
--     的缺陷 (同一个列类型太窄), 但这条是**唯一一条还没有具体样本的**
--     —— 属于"防患于未然"那部分。
--
-- ★★ 幂等性由 DDL 自身的守卫保证 (README 规则 2):
--   MySQL 5.7 没有 `ALTER TABLE ... MODIFY COLUMN IF EXISTS` 之类,
--   ⇒ 用 INFORMATION_SCHEMA 探当前 DATA_TYPE, 只有"不是 int"时才执行 ALTER。
--   ⇒ 本文件重复跑**不会**报错, 也不会重复改表 (少做一次 ALTER 就少一次
--     元数据锁窗口)。
--
-- ★ 为什么不是 SMALLINT:
--   ad_replication_status / ad_replication_history 两张表的 status_code
--   都是 **INT** ⇒ 统一用 INT, 免得将来又出现"这个表装不下那个表的码"
--   的分叉。INT 也够: Windows 错误码最大 65535 (NTSTATUS), 远在 INT 范围内。

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
--   ⚠ 本列没有 DEFAULT (基线里就是 `status_code TINYINT NOT NULL`,
--     没有 DEFAULT 子句) ⇒ ALTER 时也不加, 否则会凭空给存量行填 0。
SET @s = (SELECT IF(
  (SELECT DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'ad_replication_probe_history'
      AND COLUMN_NAME = 'status_code') <> 'int',
  'ALTER TABLE ad_replication_probe_history MODIFY COLUMN status_code INT NOT NULL',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
