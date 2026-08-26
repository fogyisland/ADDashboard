-- 2026-08-26: per-package operator-overridable execution interval.
-- Mirror of db/migrations/019-package-interval-override.sql for MSSQL.
-- See the MySQL file for rationale (manifest is immutable at install;
-- operator's runtime override must survive package upgrades).
--
-- Idempotency: query sys.columns before ALTER, same pattern as
-- db/migrations/mssql/018-report-requested.sql and
-- db/migrations/mssql/016-replication-partner-port-status.sql.
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('installed_packages')
    AND name = 'interval_override_sec'
)
BEGIN
  ALTER TABLE installed_packages
    ADD interval_override_sec INT NULL;
END
