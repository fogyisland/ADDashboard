-- verify: column sys_users.token_version

-- 015-user-token-version.sql
-- Adds token_version column to sys_users for I1 JWT revocation.
-- Idempotent on rerun (information_schema guard). DEFAULT 0 lets pre-migration
-- JWTs (which lack the claim) keep matching DB rows until an operator bumps
-- a user's token_version to 1.

DELIMITER $$

DROP PROCEDURE IF EXISTS migrate_015_add_column_if_missing$$
CREATE PROCEDURE migrate_015_add_column_if_missing(
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

CALL migrate_015_add_column_if_missing('sys_users', 'token_version',
  'INT NOT NULL DEFAULT 0');

DROP PROCEDURE migrate_015_add_column_if_missing;