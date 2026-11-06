-- 001_initial.sql (MSSQL)
-- R161.5 (2026-10-26) — MSSQL 版建表迁移 (MySQL 版的镜像).
--
-- 背景与 MySQL 版完全相同: ad_os_baseline 的建表迁移 001_initial.sql 在历史
-- bump 中丢失 ⇒ pkg_ad_os_baseline.metrics 从来没被建出来 ⇒ /api/os-baseline
-- 500. 详见 migrations/001_initial.sql (MySQL) 的完整说明.
--
-- MSSQL 侧的特点:
--   1) 没有 CREATE TABLE IF NOT EXISTS ⇒ 用 sys.tables 守卫 (sys.tables +
--      schema_id 双条件, 跟 ad_lockout_list 的 mssql 001 同款).
--   2) JSON 用 NVARCHAR(MAX) 存文本 + ISJSON CHECK 约束保形状 —— 跟
--      002/003/004 的 MSSQL 版同款 (它们继承的 ck_pkg_os_baseline_metrics_*
--      约束本来就在"丢失的 001"里).
--   3) MSSQL 驱动把整个文件当**一个 batch** 发送 (不像 mysql2 的
--      multipleStatements:false), 所以这里可以有多个 IF ... BEGIN ... END.
--
-- 列集与 1.0.9 manifest 的 database.metricSchema 逐字对齐 (19 个键),
-- 与 MySQL 版同构.

IF NOT EXISTS (
  SELECT 1 FROM sys.tables WHERE name = N'metrics' AND schema_id = SCHEMA_ID(N'pkg_ad_os_baseline')
)
BEGIN
  CREATE TABLE [pkg_ad_os_baseline].[metrics] (
    agent_id         VARCHAR(64)   NOT NULL,
    ts               DATETIME      NOT NULL,
    cpu_pct          FLOAT         NULL,
    memory_pct       FLOAT         NULL,
    disk_free        NVARCHAR(MAX) NULL,
    disk_total       NVARCHAR(MAX) NULL,
    services         NVARCHAR(MAX) NULL,
    events           NVARCHAR(MAX) NULL,
    bios_info        NVARCHAR(MAX) NULL,
    cpu_brand        NVARCHAR(128) NULL,
    mem_total_bytes  BIGINT        NULL,
    disks            NVARCHAR(MAX) NULL,
    c_used_pct       FLOAT         NULL,
    system_info      NVARCHAR(MAX) NULL,
    network_info     NVARCHAR(MAX) NULL,
    memory_modules   NVARCHAR(MAX) NULL,
    motherboard      NVARCHAR(MAX) NULL,
    cpu              NVARCHAR(MAX) NULL,
    ips              NVARCHAR(MAX) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'ck_pkg_os_baseline_metrics_disk_free_json')
BEGIN
  ALTER TABLE [pkg_ad_os_baseline].[metrics]
    ADD CONSTRAINT ck_pkg_os_baseline_metrics_disk_free_json
    CHECK (disk_free IS NULL OR ISJSON(disk_free) = 1);
END;

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'ck_pkg_os_baseline_metrics_disk_total_json')
BEGIN
  ALTER TABLE [pkg_ad_os_baseline].[metrics]
    ADD CONSTRAINT ck_pkg_os_baseline_metrics_disk_total_json
    CHECK (disk_total IS NULL OR ISJSON(disk_total) = 1);
END;

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'ck_pkg_os_baseline_metrics_services_json')
BEGIN
  ALTER TABLE [pkg_ad_os_baseline].[metrics]
    ADD CONSTRAINT ck_pkg_os_baseline_metrics_services_json
    CHECK (services IS NULL OR ISJSON(services) = 1);
END;

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'ck_pkg_os_baseline_metrics_events_json')
BEGIN
  ALTER TABLE [pkg_ad_os_baseline].[metrics]
    ADD CONSTRAINT ck_pkg_os_baseline_metrics_events_json
    CHECK (events IS NULL OR ISJSON(events) = 1);
END;

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'ck_pkg_os_baseline_metrics_bios_info_json')
BEGIN
  ALTER TABLE [pkg_ad_os_baseline].[metrics]
    ADD CONSTRAINT ck_pkg_os_baseline_metrics_bios_info_json
    CHECK (bios_info IS NULL OR ISJSON(bios_info) = 1);
END;

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'ck_pkg_os_baseline_metrics_disks_json')
BEGIN
  ALTER TABLE [pkg_ad_os_baseline].[metrics]
    ADD CONSTRAINT ck_pkg_os_baseline_metrics_disks_json
    CHECK (disks IS NULL OR ISJSON(disks) = 1);
END;

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'ck_pkg_os_baseline_metrics_system_info_json')
BEGIN
  ALTER TABLE [pkg_ad_os_baseline].[metrics]
    ADD CONSTRAINT ck_pkg_os_baseline_metrics_system_info_json
    CHECK (system_info IS NULL OR ISJSON(system_info) = 1);
END;

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'ck_pkg_os_baseline_metrics_network_info_json')
BEGIN
  ALTER TABLE [pkg_ad_os_baseline].[metrics]
    ADD CONSTRAINT ck_pkg_os_baseline_metrics_network_info_json
    CHECK (network_info IS NULL OR ISJSON(network_info) = 1);
END;

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'ck_pkg_os_baseline_metrics_memory_modules_json')
BEGIN
  ALTER TABLE [pkg_ad_os_baseline].[metrics]
    ADD CONSTRAINT ck_pkg_os_baseline_metrics_memory_modules_json
    CHECK (memory_modules IS NULL OR ISJSON(memory_modules) = 1);
END;

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'ck_pkg_os_baseline_metrics_motherboard_json')
BEGIN
  ALTER TABLE [pkg_ad_os_baseline].[metrics]
    ADD CONSTRAINT ck_pkg_os_baseline_metrics_motherboard_json
    CHECK (motherboard IS NULL OR ISJSON(motherboard) = 1);
END;

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'ck_pkg_os_baseline_metrics_cpu_json')
BEGIN
  ALTER TABLE [pkg_ad_os_baseline].[metrics]
    ADD CONSTRAINT ck_pkg_os_baseline_metrics_cpu_json
    CHECK (cpu IS NULL OR ISJSON(cpu) = 1);
END;

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'ck_pkg_os_baseline_metrics_ips_json')
BEGIN
  ALTER TABLE [pkg_ad_os_baseline].[metrics]
    ADD CONSTRAINT ck_pkg_os_baseline_metrics_ips_json
    CHECK (ips IS NULL OR ISJSON(ips) = 1);
END;
