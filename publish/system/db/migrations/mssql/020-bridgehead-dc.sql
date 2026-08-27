-- 020-bridgehead-dc.sql (MSSQL)
-- Mirror of db/migrations/020-bridgehead-dc.sql for SQL Server.
-- BIT NOT NULL DEFAULT 0 — same semantics as MySQL TINYINT(1).

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID(N'ad_dcs') AND name = N'is_bridgehead'
)
BEGIN
  ALTER TABLE ad_dcs ADD is_bridgehead BIT NOT NULL DEFAULT 0;
END;