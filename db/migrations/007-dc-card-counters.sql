-- 007-dc-card-counters.sql
-- Add 4 summary counter columns to ad_replication_status for the per-DC
-- card overview. Populated by a self-loop entry with naming_context =
-- '__dc_summary__' emitted by collect-replication.ps1. Nullable so
-- pre-feature rows remain valid.
ALTER TABLE ad_replication_status
  ADD COLUMN users_count  INT NULL AFTER error_message,
  ADD COLUMN groups_count INT NULL AFTER users_count,
  ADD COLUMN gpos_count   INT NULL AFTER groups_count,
  ADD COLUMN locked_count INT NULL AFTER gpos_count;
