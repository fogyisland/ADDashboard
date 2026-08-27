-- 020-bridgehead-dc.sql
-- 2026-08-27 round-28.5: add ad_dcs.is_bridgehead so operators can mark
-- one DC per site as the inter-site replication bridgehead. The all-sites
-- replication matrix view selects the bridgehead as the "primary" DC;
-- if no bridgehead is marked for a site, the view falls back to the
-- lexically-first dc_name.
--
-- PDC is a FSMO role (not a marker) so we deliberately do NOT use is_pdc
-- for this purpose — bridgehead is an operator-chosen designation.
--
-- Idempotent on rerun via the same information_schema guard pattern as 016.
-- Default 0 (not bridgehead) — pre-feature rows stay valid and the view
---- falls back to lex-first ordering.

DELIMITER $$

DROP PROCEDURE IF EXISTS migrate_020_add_column_if_missing$$
CREATE PROCEDURE migrate_020_add_column_if_missing(
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

CALL migrate_020_add_column_if_missing('ad_dcs', 'is_bridgehead',
  'TINYINT(1) NOT NULL DEFAULT 0 AFTER is_infrastructure_master');

DROP PROCEDURE migrate_020_add_column_if_missing;