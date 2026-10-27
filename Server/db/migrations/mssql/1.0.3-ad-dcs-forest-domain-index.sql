-- R161.17 (2026-10-27) — ad_dcs.forest_domain_id 的索引 (补齐**已有部署**) (MSSQL)
--
-- ★ verify 标记 (R161.17) —— 本文件**建索引**, 所以必须声明它建在哪张表的哪个索引上:
-- verify: index ad_dcs.idx_ad_dcs_forest_domain
--
-- 背景 (与 MySQL 侧同源, 见 mysql/1.0.3-ad-dcs-forest-domain-index.sql):
--   MSSQL 基线 (mssql/1.0.0-baseline.sql) 里**已经有**
--     IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_ad_dcs_forest_domain')
--     BEGIN CREATE NONCLUSTERED INDEX [idx_ad_dcs_forest_domain] ON [ad_dcs] ([forest_domain_id]); END;
--   但基线只在**建库**时跑一次 ⇒ 在那之前就建好的库永远补不上这个索引。
--   本文件把那一条 DDL 从"只存在于基线"变成"编号迁移", 让存量库也能收敛。
--
-- 幂等性: 与**探针同款**的守卫形态 ⇒ 重复执行不报错。
--   ★ 守卫必须**表限定** (JOIN sys.tables ON object_id), 不能只按索引名查 ——
--     SQL Server 的索引名只在**表内**唯一, 不同表可以有同名索引。若只按名字查:
--       (a) 别的表恰好有同名索引 ⇒ 本守卫判定"已存在" ⇒ **静默跳过建索引**;
--       (b) 而 verify 探针 (src/db/sql.js 的 probe.index) 是**表限定**的 ⇒
--           探针查不到 ⇒ 迁移永远停在 pending, 每次启动都重跑一次。
--     基线里那一节用的是库级写法 (mssql/1.0.0-baseline.sql:347), 本迁移
--     刻意用更严的表限定写法 —— 两者的差别只影响"有没有建出来", 不影响
--     建出来的东西, 且基线是**冻结**的 (改它不会让存量库收敛)。
--
-- DDL 前必须设锁等待上限:
--   SQL Server 的默认锁等待是 -1 (无限等)。索引被别的会话锁住时, 不设上限
--   ⇒ 迁移在启动路径上**无限期挂住**。10000 毫秒 = 10 秒, 抢不到锁就失败
--   重试, 而不是把服务拖死。SET LOCK_TIMEOUT 是**会话级**设置, 迁移用的
--   那条连接关掉就没了, 不会影响别的查询。

SET LOCK_TIMEOUT 10000;

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes i
    JOIN sys.tables t ON i.object_id = t.object_id
   WHERE t.name = 'ad_dcs' AND i.name = 'idx_ad_dcs_forest_domain'
)
BEGIN CREATE NONCLUSTERED INDEX [idx_ad_dcs_forest_domain] ON [ad_dcs] ([forest_domain_id]); END;
