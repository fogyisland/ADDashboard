-- 001_initial.sql (MSSQL)
-- Mirror of migrations/001_initial.sql for SQL Server. NVARCHAR(MAX) is
-- MSSQL's storage type for JSON text; the ISJSON CHECK enforces shape
-- going forward. Idempotent on rerun via sys.tables + sys.check_constraints
-- guards (matches db/migrations/mssql/016-partner-port-status.sql pattern).

IF NOT EXISTS (
  SELECT 1 FROM sys.tables WHERE name = N'metrics' AND schema_id = SCHEMA_ID(N'pkg_ad_lockout_list')
)
BEGIN
  CREATE TABLE [pkg_ad_lockout_list].[metrics] (
    agent_id    VARCHAR(64)  NOT NULL,
    ts          DATETIME     NOT NULL,
    events      NVARCHAR(MAX) NULL,
    event_count INT          NULL,
    error_code  INT          NULL
  );
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.check_constraints WHERE name = N'ck_pkg_lockout_list_metrics_events_json'
)
BEGIN
  ALTER TABLE [pkg_ad_lockout_list].[metrics]
    ADD CONSTRAINT ck_pkg_lockout_list_metrics_events_json
    CHECK (events IS NULL OR ISJSON(events) = 1);
END;
