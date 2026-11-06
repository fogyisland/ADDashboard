-- 001_initial.sql (MSSQL)
-- Mirror of migrations/001_initial.sql for SQL Server. INT NULL is
-- identical across MySQL and MSSQL. Idempotent on rerun via sys.tables
-- guard (matches db/migrations/mssql/016-partner-port-status.sql pattern).

IF NOT EXISTS (
  SELECT 1 FROM sys.tables WHERE name = N'metrics' AND schema_id = SCHEMA_ID(N'pkg_ad_lockout_summary')
)
BEGIN
  CREATE TABLE [pkg_ad_lockout_summary].[metrics] (
    agent_id     VARCHAR(64) NOT NULL,
    ts           DATETIME    NOT NULL,
    locked_count INT         NULL,
    error_code   INT         NULL
  );
END;
