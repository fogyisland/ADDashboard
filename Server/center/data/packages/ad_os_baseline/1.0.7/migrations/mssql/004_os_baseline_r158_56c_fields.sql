-- 004_os_baseline_r158_56c_fields.sql (MSSQL)
-- R158.56c (2026-10-08) — mirror of MySQL 004. 3 new JSON columns matching
-- the 1.0.6 PS1 wire shape that centre 1.0.6 manifest didn't know about:
--   motherboard  NVARCHAR(MAX)  (Win32_BaseBoard {manufacturer, product} object)
--   cpu          NVARCHAR(MAX)  (Win32_Processor {name, cores} object)
--   ips          NVARCHAR(MAX)  (array of IPv4 strings)
--
-- Each column ADD lives in its own IF block so MSSQL's per-statement name
-- resolution works. The ISJSON CHECK constraints live in separate IF blocks
-- (same pattern as 002/003 — see 003 comment for the sp_executesql / resolve
-- history). cpu_brand / network_info stay in the table for 1.0.3 / 1.0.4
-- legacy row back-compat; PS1 1.0.5+ no longer writes them but ingestRunV2
-- only requires metricSchema-declared keys, not exclusive ones.

-- motherboard
IF NOT EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID(N'[pkg_ad_os_baseline].[metrics]')
                 AND name = N'motherboard')
BEGIN
  ALTER TABLE [pkg_ad_os_baseline].[metrics] ADD motherboard NVARCHAR(MAX) NULL;
END;

-- cpu (object: {name, cores})
IF NOT EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID(N'[pkg_ad_os_baseline].[metrics]')
                 AND name = N'cpu')
BEGIN
  ALTER TABLE [pkg_ad_os_baseline].[metrics] ADD cpu NVARCHAR(MAX) NULL;
END;

-- ips (array of IPv4 strings)
IF NOT EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID(N'[pkg_ad_os_baseline].[metrics]')
                 AND name = N'ips')
BEGIN
  ALTER TABLE [pkg_ad_os_baseline].[metrics] ADD ips NVARCHAR(MAX) NULL;
END;

-- ISJSON CHECK on the 3 new JSON columns (mirror 002/003 pattern).
-- sp_executesql dynamic SQL so the CHECK expression compiles with deferred
-- name resolution and only resolves against the catalog when the inner
-- ALTER actually runs (by which time the column ADD above has committed).
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints
               WHERE name = N'ck_pkg_os_baseline_metrics_motherboard_json')
BEGIN
  EXEC sp_executesql N'ALTER TABLE [pkg_ad_os_baseline].[metrics]
    ADD CONSTRAINT ck_pkg_os_baseline_metrics_motherboard_json
    CHECK (motherboard IS NULL OR ISJSON(motherboard) = 1);';
END;

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints
               WHERE name = N'ck_pkg_os_baseline_metrics_cpu_json')
BEGIN
  EXEC sp_executesql N'ALTER TABLE [pkg_ad_os_baseline].[metrics]
    ADD CONSTRAINT ck_pkg_os_baseline_metrics_cpu_json
    CHECK (cpu IS NULL OR ISJSON(cpu) = 1);';
END;

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints
               WHERE name = N'ck_pkg_os_baseline_metrics_ips_json')
BEGIN
  EXEC sp_executesql N'ALTER TABLE [pkg_ad_os_baseline].[metrics]
    ADD CONSTRAINT ck_pkg_os_baseline_metrics_ips_json
    CHECK (ips IS NULL OR ISJSON(ips) = 1);';
END;
