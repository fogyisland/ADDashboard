-- verify: column ad_replication_status.partner_port_status

-- 016-partner-port-status.sql
-- Adds partner_port_status JSON column to ad_replication_status. Populated by
-- collect-replication.ps1 (Task 3) and consumed by ad_local_port_check
-- package (Task 2). Nullable so pre-feature rows remain valid.
--
-- Idempotent on rerun via the same information_schema guard pattern as 015.
-- Native JSON column so MySQL parses/validates the payload on write and lets
-- future work index individual partner-port fields if needed.

DELIMITER $$

DROP PROCEDURE IF EXISTS migrate_016_add_column_if_missing$$
CREATE PROCEDURE migrate_016_add_column_if_missing(
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

CALL migrate_016_add_column_if_missing('ad_replication_status', 'partner_port_status',
  'JSON NULL AFTER locked_count');

DROP PROCEDURE migrate_016_add_column_if_missing;