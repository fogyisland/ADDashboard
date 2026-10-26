-- 002_os_baseline_extra_fields.sql (MSSQL)
-- R147 MSSQL mirror — same 5 columns as the MySQL migration, plus ISJSON
-- CHECK constraints on the 2 new JSON columns (disk_free / disk_total etc.
-- already have theirs from 001_initial.sql — see ck_pkg_os_baseline_metrics_*
-- in that file).
--
-- Idempotency: per-column sys.columns guards. Pattern matches 001_initial.sql
-- which uses sys.tables guard for CREATE TABLE and sys.check_constraints
-- guard for ADD CONSTRAINT.
--
-- Pre-existing 1.0.2 rows will have NULL on the new columns until the agent
-- next runs the 1.0.3 PS1.

-- bios_info (JSON object: {manufacturer, name, version, release_date})
IF NOT EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID(N'[pkg_ad_os_baseline].[metrics]')
                 AND name = N'bios_info')
BEGIN
  ALTER TABLE [pkg_ad_os_baseline].[metrics] ADD bios_info NVARCHAR(MAX) NULL;
END;

-- cpu_brand (varchar — first Win32_Processor.Name)
IF NOT EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID(N'[pkg_ad_os_baseline].[metrics]')
                 AND name = N'cpu_brand')
BEGIN
  ALTER TABLE [pkg_ad_os_baseline].[metrics] ADD cpu_brand NVARCHAR(128) NULL;
END;

-- mem_total_bytes (Win32_ComputerSystem.TotalPhysicalMemory — UInt64)
IF NOT EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID(N'[pkg_ad_os_baseline].[metrics]')
                 AND name = N'mem_total_bytes')
BEGIN
  ALTER TABLE [pkg_ad_os_baseline].[metrics] ADD mem_total_bytes BIGINT NULL;
END;

-- disks (per-drive physical disk array)
IF NOT EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID(N'[pkg_ad_os_baseline].[metrics]')
                 AND name = N'disks')
BEGIN
  ALTER TABLE [pkg_ad_os_baseline].[metrics] ADD disks NVARCHAR(MAX) NULL;
END;

-- c_used_pct (derived from disks[] where letter='C:')
IF NOT EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID(N'[pkg_ad_os_baseline].[metrics]')
                 AND name = N'c_used_pct')
BEGIN
  ALTER TABLE [pkg_ad_os_baseline].[metrics] ADD c_used_pct FLOAT NULL;
END;

-- ISJSON CHECK on the 2 new JSON columns (mirror 001_initial.sql pattern)
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints
               WHERE name = N'ck_pkg_os_baseline_metrics_bios_info_json')
BEGIN
  ALTER TABLE [pkg_ad_os_baseline].[metrics]
    ADD CONSTRAINT ck_pkg_os_baseline_metrics_bios_info_json
    CHECK (bios_info IS NULL OR ISJSON(bios_info) = 1);
END;

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints
               WHERE name = N'ck_pkg_os_baseline_metrics_disks_json')
BEGIN
  ALTER TABLE [pkg_ad_os_baseline].[metrics]
    ADD CONSTRAINT ck_pkg_os_baseline_metrics_disks_json
    CHECK (disks IS NULL OR ISJSON(disks) = 1);
END;