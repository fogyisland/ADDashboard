-- 2026-08-24 round-12: heartbeat "report now" feature.
-- Mirror of db/migrations/018-report-requested.sql for MSSQL. MSSQL has
-- no ALTER TABLE IF NOT EXISTS for columns; query sys.columns first so
-- this migration is idempotent on re-run (matches the round-11 pattern
-- at db/migrations/mssql/016-replication-partner-port-status.sql).
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('ad_agent_heartbeat')
    AND name = 'report_requested_at'
)
BEGIN
  ALTER TABLE ad_agent_heartbeat
    ADD report_requested_at DATETIME2 NULL;
END
