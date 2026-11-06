-- R161.17 (2026-10-27) — ad_dcs.forest_domain_id 的索引 (补齐**已有部署**) (MySQL)
--
-- ★ verify 标记 (R161.17) —— 本文件**建索引**, 所以必须声明它建在哪张表的哪个索引上:
-- verify: index ad_dcs.idx_ad_dcs_forest_domain
--
-- 背景:
--   R161.6 (2026-10-26) 把 idx_ad_dcs_forest_domain 加进了**基线**
--   (mysql/1.0.0-baseline.sql 的 "ad_dcs — forest_domain_id 索引" 一节)。
--   但基线是**冻结**的完整 schema —— 迁移引擎只在**建库**时跑它一次, 已有
--   的库**永远不会重跑基线** ⇒ 对那些在 R161.6 之前就建好的库, 这个索引
--   永远补不上。
--
--   实测 (真库, MySQL 5.7.44):
--     · 源库 ad_dcs **有**列 forest_domain_id, **没有**索引 idx_ad_dcs_forest_domain
--       ⇒ 该列上的过滤/归属查询只能全表扫 ad_dcs。
--     · 把当前基线 + 全部编号迁移装到一个全新库里, 再跟源库做 **schema 级
--       逐项对比** (表/视图清单、列定义、索引、外键、视图定义):
--       差异**只有这一条索引**, 其余全部逐项相等 (77 个表/视图、列定义 0 差异、
--       外键 0 差异、视图定义 0 差异)。
--   ⇒ 这条迁移就是把那**唯一**的差异补平的编号迁移。
--
-- 为什么不能"再跑一遍基线"了事:
--   基线只在建库路径 (init 向导 /db/apply → applyAll) 里跑。存量库要走的是
--   **编号迁移** (services/migrations.js 的 upgrade())。基线里后加的东西
--   对存量库一律无效 —— 这就是本文件存在的理由。
--
-- 幂等性: 守卫探针 (INFORMATION_SCHEMA.STATISTICS) 保证重复执行不报错。
--   MySQL 5.7 没有 CREATE INDEX IF NOT EXISTS ⇒ 用本文件其余 DDL 同款的
--   SET @s / PREPARE / EXECUTE 形态 (与基线里那一节逐字同款)。
--
-- ★ 迁移引擎的执行方式: services/migrations.js 的 applyMigration 走
--   db.transaction → tx.execute, **同一条连接** ⇒ SET @s 的会话状态在
--   PREPARE / EXECUTE 之间保持得住 (tx.execute 在没有绑定参数时走
--   COM_QUERY, PREPARE 协议不吃它)。
--
-- DDL 前必须 SET SESSION lock_wait_timeout:
--   MySQL 的元数据锁等待默认 31536000 秒 (一年)。索引被别的会话锁住时,
--   不设这个值 ⇒ 迁移在启动路径上**挂死一年**。10 秒足够, 抢不到锁就失败
--   重试, 而不是把服务拖死。

SET SESSION lock_wait_timeout = 10;

SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_dcs' AND INDEX_NAME = 'idx_ad_dcs_forest_domain') = 0,
  'CREATE INDEX idx_ad_dcs_forest_domain ON ad_dcs (forest_domain_id)',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
