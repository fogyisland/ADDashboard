-- 011-audit-logs-indexes.sql
-- Speed up tab-category + per-user drill-down queries as the table grows.
-- No verify markers: indexes are not tables/columns per the marker grammar
-- (see center/src/init/verify-marker.js). bootstrapMigrations probes the
-- table itself, which already exists from migration 001, so this file is
-- not gated on its own marker.
--
-- MySQL has no `CREATE INDEX IF NOT EXISTS` at any version (unlike
-- `CREATE TABLE IF NOT EXISTS`) -- the clause is a MariaDB extension and
-- MySQL rejects it with a 1064 syntax error. So we reuse the dynamic-SQL
-- procedure guard from migration 001, checking information_schema.statistics
-- instead of .COLUMNS. This keeps the file idempotent on reruns and works
-- on the documented MySQL 5.7+ floor (docs/operations/deployment.md).
-- See: docs/superpowers/specs/2026-08-07-audit-log-redesign-design.md

DELIMITER $$

DROP PROCEDURE IF EXISTS migrate_011_add_index_if_missing$$
CREATE PROCEDURE migrate_011_add_index_if_missing(
  IN p_table VARCHAR(64),
  IN p_index VARCHAR(64),
  IN p_columns VARCHAR(255)
)
BEGIN
  DECLARE v_exists INT DEFAULT 0;
  SELECT COUNT(*) INTO v_exists
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = p_table
      AND INDEX_NAME = p_index;
  IF v_exists = 0 THEN
    SET @sql = CONCAT('CREATE INDEX ', p_index, ' ON ', p_table, ' (', p_columns, ')');
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$

DELIMITER ;

CALL migrate_011_add_index_if_missing('audit_logs', 'ix_audit_action_time', 'action, created_at');
CALL migrate_011_add_index_if_missing('audit_logs', 'ix_audit_user_time',   'user_id, created_at');

DROP PROCEDURE migrate_011_add_index_if_missing;
