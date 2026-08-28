-- verify: columns ad_replication_history.last_attempt_time, attempt_duration_ms, objects_transferred
-- verify: index ad_replication_history.ix_hist_pair_time

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
-- Idempotent on rerun via information_schema.COLUMNS / STATISTICS guards.
-- Pre-feature rows stay valid: the new columns are NULL-able.
--
-- This migration does NOT flip history_enabled from 0 to 1; that change
-- is applied at runtime via a separate system_config UPSERT so an
-- existing operator who explicitly disabled history can stay disabled.
--
-- IMPORTANT (round-50): the previous version of this file used a
-- MySQL DELIMITER block + stored procedure to add each column. That
-- pattern collided with `center/src/init/schema-applier.js`'s
-- `splitSqlStatements()` — the splitter only treats `;` as a
-- statement terminator when followed by `\n`/`\r`/`;`/EOF, so the
-- inline `PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;`
-- inside the procedure body got bundled into a single mega-statement
-- and MySQL rejected it with `near 'EXECUTE stmt; DEALLOCATE PREPARE
-- stmt'`. The fix is to drop the procedure entirely and emit each
-- statement on its own line, where the splitter handles `;` followed
-- by `\n` correctly.

-- ----- Column 1: last_attempt_time -----
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'ad_replication_history'
    AND COLUMN_NAME = 'last_attempt_time'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE ad_replication_history ADD COLUMN last_attempt_time DATETIME NULL AFTER last_success_time',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ----- Column 2: attempt_duration_ms -----
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'ad_replication_history'
    AND COLUMN_NAME = 'attempt_duration_ms'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE ad_replication_history ADD COLUMN attempt_duration_ms INT NULL AFTER last_attempt_time',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ----- Column 3: objects_transferred -----
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'ad_replication_history'
    AND COLUMN_NAME = 'objects_transferred'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE ad_replication_history ADD COLUMN objects_transferred INT NULL AFTER attempt_duration_ms',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ----- Composite index for the per-pair "last N attempts" query -----
-- The view (services/replication-log-all.js) issues:
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
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
