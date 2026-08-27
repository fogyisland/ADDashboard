-- 021-replication-attempts-log.sql
-- 2026-08-27 round-42 (复制日志监控): turn ad_replication_history into a
-- per-attempt log with enough fields to render a "latest 10 connection
-- details" panel. Before this migration, history_enabled=0 and the table
-- had only `last_success_time / status_code / error_message` — no notion of
-- attempt duration, objects transferred, or per-attempt timestamp. The
-- 复制日志监控 view (ReplicationLogMonitorView) needs:
--   1. last_attempt_time — distinct from last_success_time so a row can
--      be ordered by attempt time, not success time.
--   2. attempt_duration_ms — how long the agent's Get-ADReplicationPartner
--      call took. Useful when "the link keeps failing" needs root-causing
--      to network slowness vs auth issue.
--   3. objects_transferred — on success, how many objects the partner
--      reported. On failure, NULL (the AD module returns nothing useful).
--   4. Composite index (source_dc, dest_dc, naming_context, collected_at)
--      — the per-pair "last N attempts" query needs index-range-scan,
--      not full-table-scan. Pre-feature ix_hist_time(collected_at) is
--      kept (audit/retention jobs still scan by collected_at).
--
-- Idempotent on rerun via information_schema.COLUMNS / STATISTICS guard
-- pattern (same approach as migration 016/020). Pre-feature rows stay
-- valid: the new columns are NULL-able.
--
-- This migration does NOT flip history_enabled from 0 to 1; that change
-- is applied at runtime via a separate system_config UPSERT so an
-- existing operator who explicitly disabled history can stay disabled.

DELIMITER $$

DROP PROCEDURE IF EXISTS migrate_021_add_column_if_missing$$
CREATE PROCEDURE migrate_021_add_column_if_missing(
  IN p_table VARCHAR(64), IN p_column VARCHAR(64), IN p_definition VARCHAR(255)
)
BEGIN
  DECLARE v_exists INT DEFAULT 0;
  SELECT COUNT(*) INTO v_exists FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = p_table AND COLUMN_NAME = p_column;
  IF v_exists = 0 THEN
    SET @sql = CONCAT('ALTER TABLE ', p_table, ' ADD COLUMN ', p_column, ' ', p_definition);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END$$

DELIMITER ;

CALL migrate_021_add_column_if_missing('ad_replication_history', 'last_attempt_time',
  'DATETIME NULL AFTER last_success_time');
CALL migrate_021_add_column_if_missing('ad_replication_history', 'attempt_duration_ms',
  'INT NULL AFTER last_attempt_time');
CALL migrate_021_add_column_if_missing('ad_replication_history', 'objects_transferred',
  'INT NULL AFTER attempt_duration_ms');

DROP PROCEDURE migrate_021_add_column_if_missing;

-- Composite index for the per-pair "last N attempts" query. The view
-- (services/replication-log-all.js) issues:
--   SELECT ... FROM ad_replication_history
--   WHERE source_dc = ? AND dest_dc = ? AND naming_context = ?
--   ORDER BY collected_at DESC LIMIT 10
-- Without this index MySQL scans ix_hist_time (collected_at) and filters
-- 90% of rows in memory. With it MySQL walks the index in reverse and
-- stops at LIMIT.
--
-- Guard: skip the CREATE INDEX if it already exists.
SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'ad_replication_history'
    AND INDEX_NAME   = 'ix_hist_pair_time'
);
SET @sql := IF(@idx_exists = 0,
  'CREATE INDEX ix_hist_pair_time ON ad_replication_history (source_dc, dest_dc, naming_context, collected_at)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;