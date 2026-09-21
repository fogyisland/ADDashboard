-- 001_initial.sql (MSSQL)
-- Mirror of migrations/001_initial.sql for SQL Server. All columns are
-- scalar int / varchar so no JSON CHECK constraints are needed (unlike
-- ad_local_port_check which carries JSON payloads). Idempotent on rerun
-- via sys.tables + sys.columns guards (matches the
-- db/migrations/mssql/016-partner-port-status.sql pattern).
-- DATETIME2(3) matches other MSSQL package conventions for ms precision.

IF NOT EXISTS (
  SELECT 1 FROM sys.tables WHERE name = N'metrics' AND schema_id = SCHEMA_ID(N'pkg_ad_domain_consistency')
)
BEGIN
  CREATE TABLE [pkg_ad_domain_consistency].[metrics] (
    agent_id    VARCHAR(64) NOT NULL,
    ts          DATETIME2(3) NOT NULL,
    user_count  INT         NULL,
    user_hash   VARCHAR(64) NULL,
    group_count INT         NULL,
    group_hash  VARCHAR(64) NULL,
    gpo_count   INT         NULL,
    gpo_hash    VARCHAR(64) NULL,
    error_code  INT         NULL,
    CONSTRAINT pk_pkg_ad_domain_consistency_metrics PRIMARY KEY (agent_id, ts)
  );
END;