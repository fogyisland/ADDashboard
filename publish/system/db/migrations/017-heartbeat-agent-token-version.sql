-- verify: column ad_agent_heartbeat.agent_token_version

-- 017-heartbeat-agent-token-version.sql
-- 2026-08-21 UX redesign (agent-token auto-delivery): the heartbeat
-- upsert now persists the agent's last-seen agent_token_version, and the
-- response carries the new token + version when the server's version is
-- newer. This column is what the new GET /api/admin/agent-token/delivery
-- endpoint joins against to compute the "已推送到 X / N 台 Agent" counter.
--
-- Idempotent on rerun via the same information_schema guard pattern as
-- 015 / 016. INT NOT NULL DEFAULT 0 means pre-feature heartbeat rows
-- (which lack the column) match as version=0 on first read — and the
-- server's version is also 0 until the operator generates the first new
-- token. So pre-feature agents keep working unchanged.

DELIMITER $$

DROP PROCEDURE IF EXISTS migrate_017_add_column_if_missing$$
CREATE PROCEDURE migrate_017_add_column_if_missing(
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

CALL migrate_017_add_column_if_missing('ad_agent_heartbeat', 'agent_token_version',
  'INT NOT NULL DEFAULT 0');

DROP PROCEDURE migrate_017_add_column_if_missing;