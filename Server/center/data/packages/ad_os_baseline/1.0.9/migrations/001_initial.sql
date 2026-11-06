-- 001_initial.sql (MySQL)
-- R161.5 (2026-10-26) — 重建 pkg_ad_os_baseline.metrics 的建表迁移.
--
-- 为什么需要这个文件 (历史丢失):
--   ad_os_baseline 的每个版本目录只携带**自己那一条**增量迁移
--   (1.0.3→002 / 1.0.4→003 / 1.0.7→004 / 1.0.8→004), 建表的 001_initial.sql
--   在某次 bump 时被丢掉了 —— 全树 (Server/ + LinuxServer/ + web/) 都**没有**
--   任何 001_initial.sql, 也没有任何文件 CREATE TABLE pkg_ad_os_baseline.
--   ⇒ pkg_ad_os_baseline.metrics **从来没有被建出来过**
--   ⇒ metricstore v2 无处可写
--   ⇒ GET /api/os-baseline 抛 "Table 'pkg_ad_os_baseline.metrics' doesn't
--      exist" ⇒ 500 (操作员 2026-10-26 报的 "OS 基线结果不对").
--
-- 本文件一次性建出**最终**列集 (001 基线列 + 002/003/004 的增量列),
-- 而不是"建基线列再 ALTER 补列". 原因:
--   1) MySQL 5.7 没有 ADD COLUMN IF NOT EXISTS (8.0.29+ 才有) ⇒ 增量迁移
--      里的 ADD COLUMN IF NOT EXISTS 在 5.7 上是 ER_PARSE_ERROR.
--   2) 包迁移文件**只能有一条语句** (mysql2 multipleStatements:false,
--      ddl-apply.js:applyMigrations 整个文件当一条语句执行) ⇒ 用不了基线里
--      那套 SET @s + PREPARE/EXECUTE/DEALLOCATE 的 INFORMATION_SCHEMA 守卫链.
--      ⇒ 5.7 上唯一安全的建列方式就是 CREATE TABLE 时一次给全.
--   3) 幂等由 pkg_ad_os_baseline.schema_migrations 表按 filename 保证
--      (不是 IF NOT EXISTS) —— 但 CREATE TABLE IF NOT EXISTS 本身也带上,
--      防止 operator 手动删了 schema_migrations 行后重跑炸掉.
--
-- 列集与 1.0.8 manifest 的 database.metricSchema 逐字对齐 (19 个键) ——
-- metricstore v2 的 ingestRunV2 按 metricSchema 的键名拼 INSERT, 少一列
-- 就是 "unknown column", 多一列就是死列.
--
-- 语法约束: 本文件**只有一条语句** (CREATE TABLE). 注释用 `--`,
-- 不要加第二条语句 (5.7 + multipleStatements:false 会直接拒绝).

CREATE TABLE IF NOT EXISTS pkg_ad_os_baseline.metrics (
  agent_id         VARCHAR(64)  NOT NULL,
  ts               DATETIME     NOT NULL,
  cpu_pct          DOUBLE       NULL,
  memory_pct       DOUBLE       NULL,
  disk_free        JSON         NULL,
  disk_total       JSON         NULL,
  services         JSON         NULL,
  events           JSON         NULL,
  bios_info        JSON         NULL,
  cpu_brand        VARCHAR(128) NULL,
  mem_total_bytes  BIGINT       NULL,
  disks            JSON         NULL,
  c_used_pct       DOUBLE       NULL,
  system_info      JSON         NULL,
  network_info     JSON         NULL,
  memory_modules   JSON         NULL,
  motherboard      JSON         NULL,
  cpu              JSON         NULL,
  ips              JSON         NULL
);
