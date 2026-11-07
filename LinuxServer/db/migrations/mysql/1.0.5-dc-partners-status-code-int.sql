-- verify: columntype ad_dc_inbound_partners.status_code int
-- verify: columntype ad_dc_outbound_partners.status_code int
--
-- R161.31 (2026-11-07) — dc_partners 两张表的 status_code 加宽 TINYINT → INT (MySQL)
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
--   · ad_dc_inbound_partners.status_code  的列定义是 **tinyint(4)** (上限 127)
--   · ad_dc_outbound_partners.status_code 的列定义是 **tinyint(4)** (上限 127)
--   · 两张表当前行数都是 **0**
--   · 唯一数据源 ad_replication_status.status_code 的实际值域是
--     min=0 **max=1398** —— 1398 是真实的 Windows 错误码
--     (1398 = 命名空间绑定失败, 1722 = RPC 服务器不可用)
--   ⇒ 真的插一行 status_code=1398 进去, 驱动报:
--       ER_WARN_DATA_OUT_OF_RANGE
--       Out of range value for column 'status_code' at row 1
--
-- ★★ 丢行是怎么发生的 (完整链路):
--   center/src/services/dc-partners-refresh.js:111
--     const status = row.status_code;          ← 从 ad_replication_status 复制
--   :121-133  把同一个 status 原样塞进 inbound / outbound 两个 upsert 的参数
--   :141      const results = await Promise.allSettled(...)   ← 逐个 upsert
--   :143-157  失败的行被 push 进 errors[]，只 logger.warn
--   ⇒ 真实错误码 1398 的那一行**必然写失败**, 而失败只被 warn 掉
--     ⇒ **静默丢行**: ad_dc_*_partners 表里看不到那条出错的 DC 关系。
--   ⇒ 两张表恒为 0 行就是这个 bug 的**症状** (本仓库里它们从来没成功写进过
--     一行真实数据 —— 唯一在跑的样本恰好带了 1398)。
--
-- ★★ 为什么 MSSQL 侧不需要这个迁移 (但基线仍要改):
--   MSSQL 基线里这两张表的 status_code 本来就是 **INT**
--   (db/migrations/mssql/1.0.0-baseline.sql 的 [ad_dc_inbound_partners] /
--    [ad_dc_outbound_partners]) ⇒ 同一个 bug 在 MSSQL 上**不会复现**。
--   ⇒ 但两个方言的 schema **分叉** (MySQL=127 上限, MSSQL=INT) ⇒ 同一份
--     agent 报同一对 DC, 两边能存下的值域不同 ⇒ 跨库对比 / 数据搬迁 /
--     统一报表口径时会撞上。
--   ⇒ MySQL 侧加宽到 INT, 两个方言**收敛到同一个最终 schema**
--     (README 规则 4)。
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
--   ⚠ MODIFY COLUMN 不写 DEFAULT 会把默认值清掉。MySQL 侧这两列的基线
--     定义是 `DEFAULT 0` ⇒ ALTER 时必须把 DEFAULT 0 一并带上, 否则
--     迁移后列的默认值从 0 变成"无默认值" ⇒ 将来不带 status_code 的
--     INSERT 会失败 (MySQL 5.7 的非严格模式会静默塞 0, 严格模式报错)。
SET @s = (SELECT IF(
  (SELECT DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'ad_dc_inbound_partners'
      AND COLUMN_NAME = 'status_code') <> 'int',
  'ALTER TABLE ad_dc_inbound_partners MODIFY COLUMN status_code INT NOT NULL DEFAULT 0',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = (SELECT IF(
  (SELECT DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'ad_dc_outbound_partners'
      AND COLUMN_NAME = 'status_code') <> 'int',
  'ALTER TABLE ad_dc_outbound_partners MODIFY COLUMN status_code INT NOT NULL DEFAULT 0',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
