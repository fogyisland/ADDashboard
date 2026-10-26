-- 003_os_baseline_r158_30_fields.sql (MSSQL)
-- R158.30 MSSQL mirror — 3 new JSON columns matching the MySQL migration.
--
-- History:
--   Attempt 1: column ADD + ISJSON CHECK in same IF NOT EXISTS block.
--     sqlcmd error "Invalid column name 'system_info'" — batch-level
--     name resolution rejected the CHECK expression before the column
--     DDL refreshed the catalog.
--   Attempt 2: column ADD in one IF block, ISJSON CHECK in a separate
--     IF block (R147 002 pattern). Still rejected — apparently MSSQL
--     resolve_name() still pulls column visibility per-statement but
--     ALTER TABLE ADD CONSTRAINT validates its CHECK expression against
--     the catalog snapshot taken at parse time, not at commit time.
--   Attempt 3 (this file): wrap each ADD CONSTRAINT in sp_executesql
--     dynamic SQL. sp_executesql compiles its parameterised SQL with
--     DEFERRED name resolution, so the column reference is only
--     resolved when the inner ALTER actually executes — after the
--     column DDL has committed. This is the same pattern MSSQL's own
--     upgrade scripts use to add CHECK constraints to columns added in
--     the same migration.

-- system_info (JSON object: {manufacturer, model})
IF NOT EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID(N'[pkg_ad_os_baseline].[metrics]')
                 AND name = N'system_info')
BEGIN
  ALTER TABLE [pkg_ad_os_baseline].[metrics] ADD system_info NVARCHAR(MAX) NULL;
END;

-- network_info (JSON object: {ipv4: [string, ...]})
IF NOT EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID(N'[pkg_ad_os_baseline].[metrics]')
                 AND name = N'network_info')
BEGIN
  ALTER TABLE [pkg_ad_os_baseline].[metrics] ADD network_info NVARCHAR(MAX) NULL;
END;

-- memory_modules (JSON array of memory modules)
IF NOT EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID(N'[pkg_ad_os_baseline].[metrics]')
                 AND name = N'memory_modules')
BEGIN
  ALTER TABLE [pkg_ad_os_baseline].[metrics] ADD memory_modules NVARCHAR(MAX) NULL;
END;

-- ISJSON CHECK on the 3 new JSON columns.
-- Each constraint lives inside sp_executesql so the CHECK expression
-- compiles with deferred name resolution and only resolves against the
-- catalog when the inner ALTER TABLE actually runs (by which time the
-- matching column ADD above has committed).
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints
               WHERE name = N'ck_pkg_os_baseline_metrics_system_info_json')
BEGIN
  EXEC sp_executesql N'ALTER TABLE [pkg_ad_os_baseline].[metrics]
    ADD CONSTRAINT ck_pkg_os_baseline_metrics_system_info_json
    CHECK (system_info IS NULL OR ISJSON(system_info) = 1);';
END;

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints
               WHERE name = N'ck_pkg_os_baseline_metrics_network_info_json')
BEGIN
  EXEC sp_executesql N'ALTER TABLE [pkg_ad_os_baseline].[metrics]
    ADD CONSTRAINT ck_pkg_os_baseline_metrics_network_info_json
    CHECK (network_info IS NULL OR ISJSON(network_info) = 1);';
END;

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints
               WHERE name = N'ck_pkg_os_baseline_metrics_memory_modules_json')
BEGIN
  EXEC sp_executesql N'ALTER TABLE [pkg_ad_os_baseline].[metrics]
    ADD CONSTRAINT ck_pkg_os_baseline_metrics_memory_modules_json
    CHECK (memory_modules IS NULL OR ISJSON(memory_modules) = 1);';
END;
