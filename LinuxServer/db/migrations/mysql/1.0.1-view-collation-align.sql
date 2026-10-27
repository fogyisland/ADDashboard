-- ============================================================================
-- R161.14 (2026-10-27) — v_partner_inbound.probe_state 的 collation 对齐
--
-- 背景
-- ----
-- v_partner_inbound 视图里的 probe_state 列是**字面量派生**的:
--
--     (SELECT CASE WHEN ... THEN 'error' WHEN ... THEN 'success'
--                  ELSE 'partial' END
--      FROM ad_replication_probe_history h WHERE ...) AS probe_state
--
-- MySQL 会把**建视图那条连接**的 collation 冻结进视图定义里 (字面量的
-- collation 就是连接的 collation)。老版本驱动写的是 charset:'utf8mb4',
-- 而 mysql2 的 Charsets.UTF8MB4 = 45 = utf8mb4_**general_ci** ⇒ 建出来的
-- probe_state 列就是 utf8mb4_general_ci。
--
-- 而基线里 75 张表全是 `DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
-- ⇒ 2026-10-27 的真库完备性扫描结果是:
--     表级非 unicode_ci: 0 张
--     列级非 unicode_ci: 1 个  →  v_partner_inbound.probe_state
-- 全库唯一的 collation 不一致点。
--
-- 后果 (为什么 R161.12 修完连接反而埋雷)
-- --------------------------------------
-- R161.12 把连接 collation 统一成 utf8mb4_unicode_ci 之后, 视图列那一侧
-- 仍是 general_ci, 而字面量那一侧跟随连接 = unicode_ci。两边 coercion 级别
-- 相同 (都是 COERCIBLE) 且 collation 不同 ⇒ 无法聚合 ⇒ 1267/1271:
--     WHERE probe_state = 'success'          → ER_CANT_AGGREGATE_2COLLATIONS
--     ... UNION ALL SELECT 'success'         → ER_CANT_AGGREGATE_NCOLLATIONS
-- 今天还没有线上查询踩到 (应用只 SELECT 这一列, 比较都在 JS 里做), 但这是
-- 一颗明摆着的雷: 任何人写一句带 probe_state 过滤的 SQL 就会 500。
--
-- 修法
-- ----
-- 重建视图, 给 probe_state 套**显式** COLLATE utf8mb4_unicode_ci:
-- 显式 COLLATE 的 coercibility = EXPLICIT (最高级) ⇒
--   (a) 建视图时无论连接是什么 collation, 这一列都是 unicode_ci;
--   (b) 以后查询时无论连接是什么 collation, 这一列都赢, 永远不再撞 1267。
--
-- 用 CREATE OR REPLACE 而不是 DROP + CREATE:
--   - 原子替换, 没有"视图不存在"的中间窗口 (拓扑接口正在读它);
--   - 视图不存在时直接建出来 ⇒ 幂等, 重跑安全。
--
-- 视图主体与 db/migrations/mysql/1.0.0-baseline.sql 里的**逐字等价**
-- (只有 CREATE OR REPLACE 与 COLLATE 两处差别)。两者漂移由
-- center/tests/view-collation-contract.test.js 锁死 —— 改了基线忘了改这里,
-- 测试立刻变红。
--
-- MSSQL 侧不需要这一步 (见 db/migrations/mssql/1.0.1-view-collation-align.sql):
-- SQL Server 的强制转换规则里"列"永远赢"字面量", 而且列的 collation 是
-- **库级**的 —— 硬编码一个 COLLATE 名会直接打断客户库里自定义的排序规则。
--
-- ★ 顺带查清并**有意不自动修**的另一件事: 库默认 collation
--   真库的 information_schema.SCHEMATA.DEFAULT_COLLATION_NAME =
--   utf8mb4_**general_ci**, 而应用自己建库时写的是
--     CREATE DATABASE ... CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
--   (center/src/db/drivers/mysql.js:312 / center/src/init/schema-applier.js:449)
--   ⇒ 这个库不是应用建的, 库默认才留在 general_ci。
--   为什么**不**顺手改成 unicode_ci:
--     (1) 改不动 —— .sql 迁移拿不到库名, 动态库名只能靠服务端 PREPARE,
--         而 **MySQL 5.7 不允许把 ALTER DATABASE 放进 PREPARE**
--         (实测: PREPARE FROM 'SELECT 1' / 'CREATE TABLE ...' / 'DROP TABLE ...'
--          都 OK, 只有 'ALTER DATABASE ...' 报 ER_UNSUPPORTED_PS 1295);
--         不带库名的裸 ALTER DATABASE 当然可以跑, 但迁移里写不出库名。
--     (2) 不该做 —— 改一个**已存在**的库默认排序规则, 属于擅自改客户库的
--         配置。应用建库时用自己的默认值 (unicode_ci) 是在自己的地盘上做主;
--         面对一个不是自己建的库, 越界。
--   想手动对齐的话 (可选, 做完就不必再管):
--     ALTER DATABASE `<你的库名>` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
--   影响范围只有"该库里**以后新建**的、没显式写 COLLATE 的对象";
--   已有表/列/视图一个都不动。
-- ============================================================================

-- MDL (metadata lock) 护栏: CREATE OR REPLACE VIEW 要拿 v_partner_inbound
-- 及其 4 张基表的元数据锁。若有别的会话正拿着长事务读这个视图, 默认
-- lock_wait_timeout = 31536000 (一年) ⇒ **启动流程会被挂死一年**。
-- 改成 10 秒 ⇒ 抢不到锁就报 ER_LOCK_WAIT_TIMEOUT (1205) 快速失败,
-- 迁移被记成 'failed' 但**不挡启动** (server.js 的启动迁移失败不阻断服务),
-- 操作员改天再跑即可。宁可失败也不要挂死。
SET SESSION lock_wait_timeout = 10;

CREATE OR REPLACE VIEW v_partner_inbound AS
SELECT
  i.dest_dc        AS target_dc,
  i.source_dc      AS peer_dc,
  i.collected_at   AS collected_at,
  i.discovered_at  AS discovered_at,
  i.agent_id       AS reporter_agent_id,
  d.site_id        AS target_site_id,
  d.is_bridgehead  AS target_is_bridgehead,
  s.site_name      AS target_site_name,
  pd.site_id       AS peer_site_id,
  ps.site_name     AS peer_site_name,
  ps.is_hub        AS peer_site_is_hub,
  (SELECT CASE
       WHEN MAX(CASE WHEN h.status_code = 2 THEN 1 ELSE 0 END) = 1 THEN 'error'
       WHEN MAX(CASE WHEN h.status_code = 0 THEN 1 ELSE 0 END) = 1 THEN 'success'
       ELSE 'partial' END
   FROM ad_replication_probe_history h
   WHERE h.source_dc = i.dest_dc AND h.dest_dc = i.source_dc
     AND h.attempt_at >= UTC_TIMESTAMP() - INTERVAL 15 MINUTE
  ) COLLATE utf8mb4_unicode_ci AS probe_state,
  (SELECT MAX(h.attempt_at) FROM ad_replication_probe_history h
   WHERE h.source_dc = i.dest_dc AND h.dest_dc = i.source_dc
     AND h.attempt_at >= UTC_TIMESTAMP() - INTERVAL 15 MINUTE
  ) AS probe_attempt_at,
  (SELECT h.duration_ms FROM ad_replication_probe_history h
   WHERE h.source_dc = i.dest_dc AND h.dest_dc = i.source_dc
     AND h.attempt_at >= UTC_TIMESTAMP() - INTERVAL 15 MINUTE
   ORDER BY h.status_code DESC, h.attempt_at DESC LIMIT 1
  ) AS probe_duration_ms,
  (SELECT h.error_message FROM ad_replication_probe_history h
   WHERE h.source_dc = i.dest_dc AND h.dest_dc = i.source_dc
     AND h.attempt_at >= UTC_TIMESTAMP() - INTERVAL 15 MINUTE
   ORDER BY h.status_code DESC, h.attempt_at DESC LIMIT 1
  ) AS probe_error_message
FROM ad_partner_inbound i
INNER JOIN ad_dcs d     ON d.dc_name = i.dest_dc
LEFT  JOIN ad_sites s   ON s.site_id = d.site_id
LEFT  JOIN ad_dcs pd    ON pd.dc_name = i.source_dc
LEFT  JOIN ad_sites ps  ON ps.site_id = pd.site_id
WHERE i.source_dc <> i.dest_dc
  AND i.collected_at >= UTC_TIMESTAMP() - INTERVAL 30 DAY;
