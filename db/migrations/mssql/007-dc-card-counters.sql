-- verify: column ad_replication_status.users_count
-- verify: column ad_replication_status.groups_count
-- verify: column ad_replication_status.gpos_count
-- verify: column ad_replication_status.locked_count

-- 007-dc-card-counters.sql (MSSQL)
-- Add 4 summary counter columns to ad_replication_status. Guarded via
-- INFORMATION_SCHEMA so re-running is a no-op (older MSSQL versions
-- don't support ADD COLUMN IF NOT EXISTS).
IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_NAME = 'ad_replication_status' AND COLUMN_NAME = 'users_count'
)
ALTER TABLE ad_replication_status ADD users_count INT NULL;

IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_NAME = 'ad_replication_status' AND COLUMN_NAME = 'groups_count'
)
ALTER TABLE ad_replication_status ADD groups_count INT NULL;

IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_NAME = 'ad_replication_status' AND COLUMN_NAME = 'gpos_count'
)
ALTER TABLE ad_replication_status ADD gpos_count INT NULL;

IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_NAME = 'ad_replication_status' AND COLUMN_NAME = 'locked_count'
)
ALTER TABLE ad_replication_status ADD locked_count INT NULL;
