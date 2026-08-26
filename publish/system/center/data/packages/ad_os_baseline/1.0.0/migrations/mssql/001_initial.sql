-- 001_initial.sql (MSSQL)
-- Mirror of migrations/001_initial.sql for SQL Server. NVARCHAR(MAX) is
-- MSSQL's storage type for JSON text; the ISJSON CHECK enforces shape
-- going forward. Idempotent on rerun via sys.tables + sys.columns guards
-- (matches the db/migrations/mssql/016-partner-port-status.sql pattern).
-- Pre-existing NULL rows in the columns are tolerated by the conditional
-- CHECK (IS NULL OR ISJSON = 1).
--
-- Task 430: this file did not exist pre-fix — ad_os_baseline was the only
-- built-in with no MSSQL mirror, which blocked Task #428 (MSSQL end-to-end
-- verification). Created to align with ad_local_port_check and
-- ad_domain_consistency.

IF NOT EXISTS (
  SELECT 1 FROM sys.tables WHERE name = N'metrics' AND schema_id = SCHEMA_ID(N'pkg_ad_os_baseline')
)
BEGIN
  CREATE TABLE [pkg_ad_os_baseline].[metrics] (
    agent_id   VARCHAR(64)  NOT NULL,
    ts         DATETIME     NOT NULL,
    cpu_pct    DOUBLE PRECISION NULL,
    memory_pct DOUBLE PRECISION NULL,
    disk_free  NVARCHAR(MAX) NULL,
    disk_total NVARCHAR(MAX) NULL,
    services   NVARCHAR(MAX) NULL,
    events     NVARCHAR(MAX) NULL
  );
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.check_constraints WHERE name = N'ck_pkg_os_baseline_metrics_disk_free_json'
)
BEGIN
  ALTER TABLE [pkg_ad_os_baseline].[metrics]
    ADD CONSTRAINT ck_pkg_os_baseline_metrics_disk_free_json
    CHECK (disk_free IS NULL OR ISJSON(disk_free) = 1);
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.check_constraints WHERE name = N'ck_pkg_os_baseline_metrics_disk_total_json'
)
BEGIN
  ALTER TABLE [pkg_ad_os_baseline].[metrics]
    ADD CONSTRAINT ck_pkg_os_baseline_metrics_disk_total_json
    CHECK (disk_total IS NULL OR ISJSON(disk_total) = 1);
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.check_constraints WHERE name = N'ck_pkg_os_baseline_metrics_services_json'
)
BEGIN
  ALTER TABLE [pkg_ad_os_baseline].[metrics]
    ADD CONSTRAINT ck_pkg_os_baseline_metrics_services_json
    CHECK (services IS NULL OR ISJSON(services) = 1);
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.check_constraints WHERE name = N'ck_pkg_os_baseline_metrics_events_json'
)
BEGIN
  ALTER TABLE [pkg_ad_os_baseline].[metrics]
    ADD CONSTRAINT ck_pkg_os_baseline_metrics_events_json
    CHECK (events IS NULL OR ISJSON(events) = 1);
END;