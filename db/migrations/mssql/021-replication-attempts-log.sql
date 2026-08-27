-- 021-replication-attempts-log.sql (MSSQL)
-- Mirror of db/migrations/021-replication-attempts-log.sql for SQL Server.
-- Adds last_attempt_time, attempt_duration_ms, objects_transferred to
-- ad_replication_history plus a composite index for the per-pair "last N"
-- query. Idempotent on rerun via sys.columns / sys.indexes guards.

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID(N'ad_replication_history') AND name = N'last_attempt_time'
)
BEGIN
  ALTER TABLE ad_replication_history ADD last_attempt_time DATETIME2 NULL;
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID(N'ad_replication_history') AND name = N'attempt_duration_ms'
)
BEGIN
  ALTER TABLE ad_replication_history ADD attempt_duration_ms INT NULL;
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID(N'ad_replication_history') AND name = N'objects_transferred'
)
BEGIN
  ALTER TABLE ad_replication_history ADD objects_transferred INT NULL;
END;

-- Composite index for the per-pair "last N attempts" query.
-- SQL Server has no CREATE INDEX IF NOT EXISTS, so guard on sys.indexes.
IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE object_id = OBJECT_ID(N'ad_replication_history') AND name = N'ix_hist_pair_time'
)
BEGIN
  CREATE INDEX ix_hist_pair_time
    ON ad_replication_history (source_dc, dest_dc, naming_context, collected_at);
END;