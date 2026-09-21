-- 001_initial.sql (MSSQL)
-- Mirror of migrations/001_initial.sql for SQL Server. NVARCHAR(MAX) is
-- MSSQL's storage type for JSON text; the ISJSON CHECK enforces shape
-- going forward. Idempotent on rerun via sys.tables + sys.columns guards
-- (matches the db/migrations/mssql/016-partner-port-status.sql pattern).
-- Pre-existing NULL rows in the columns are tolerated by the conditional
-- CHECK (IS NULL OR ISJSON = 1).

IF NOT EXISTS (
  SELECT 1 FROM sys.tables WHERE name = N'metrics' AND schema_id = SCHEMA_ID(N'pkg_ad_local_port_check')
)
BEGIN
  CREATE TABLE [pkg_ad_local_port_check].[metrics] (
    agent_id   VARCHAR(64)  NOT NULL,
    ts         DATETIME     NOT NULL,
    port_135   NVARCHAR(MAX) NULL,
    port_445   NVARCHAR(MAX) NULL,
    port_50001 NVARCHAR(MAX) NULL,
    port_50002 NVARCHAR(MAX) NULL,
    port_50003 NVARCHAR(MAX) NULL
  );
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.check_constraints WHERE name = N'ck_pkg_local_port_check_metrics_port_135_json'
)
BEGIN
  ALTER TABLE [pkg_ad_local_port_check].[metrics]
    ADD CONSTRAINT ck_pkg_local_port_check_metrics_port_135_json
    CHECK (port_135 IS NULL OR ISJSON(port_135) = 1);
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.check_constraints WHERE name = N'ck_pkg_local_port_check_metrics_port_445_json'
)
BEGIN
  ALTER TABLE [pkg_ad_local_port_check].[metrics]
    ADD CONSTRAINT ck_pkg_local_port_check_metrics_port_445_json
    CHECK (port_445 IS NULL OR ISJSON(port_445) = 1);
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.check_constraints WHERE name = N'ck_pkg_local_port_check_metrics_port_50001_json'
)
BEGIN
  ALTER TABLE [pkg_ad_local_port_check].[metrics]
    ADD CONSTRAINT ck_pkg_local_port_check_metrics_port_50001_json
    CHECK (port_50001 IS NULL OR ISJSON(port_50001) = 1);
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.check_constraints WHERE name = N'ck_pkg_local_port_check_metrics_port_50002_json'
)
BEGIN
  ALTER TABLE [pkg_ad_local_port_check].[metrics]
    ADD CONSTRAINT ck_pkg_local_port_check_metrics_port_50002_json
    CHECK (port_50002 IS NULL OR ISJSON(port_50002) = 1);
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.check_constraints WHERE name = N'ck_pkg_local_port_check_metrics_port_50003_json'
)
BEGIN
  ALTER TABLE [pkg_ad_local_port_check].[metrics]
    ADD CONSTRAINT ck_pkg_local_port_check_metrics_port_50003_json
    CHECK (port_50003 IS NULL OR ISJSON(port_50003) = 1);
END;