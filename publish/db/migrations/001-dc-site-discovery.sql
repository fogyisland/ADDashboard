-- AD Dashboard DC/Site Discovery migration (MySQL 8+)
-- Applies after 01-tables.sql + 02-seed-roles.sql.
-- MySQL 8 lacks `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so we use
-- stored procedure guards that swallow error 1060 (duplicate column).

DELIMITER $$

DROP PROCEDURE IF EXISTS migrate_001_add_column_if_missing$$
CREATE PROCEDURE migrate_001_add_column_if_missing(
  IN p_table VARCHAR(64),
  IN p_column VARCHAR(64),
  IN p_definition VARCHAR(255)
)
BEGIN
  DECLARE v_exists INT DEFAULT 0;
  SELECT COUNT(*) INTO v_exists
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = p_table
      AND COLUMN_NAME = p_column;
  IF v_exists = 0 THEN
    SET @sql = CONCAT('ALTER TABLE ', p_table, ' ADD COLUMN ', p_column, ' ', p_definition);
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$

DELIMITER ;

-- ad_sites: add description + timestamps
CALL migrate_001_add_column_if_missing('ad_sites', 'description', 'VARCHAR(256) NULL');
CALL migrate_001_add_column_if_missing('ad_sites', 'created_at',  'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP');
CALL migrate_001_add_column_if_missing('ad_sites', 'updated_at',  'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');

-- ad_dcs: agent-reported metadata + discovery tracking
CALL migrate_001_add_column_if_missing('ad_dcs', 'when_created',             'DATETIME NULL');
CALL migrate_001_add_column_if_missing('ad_dcs', 'is_gc',                    'TINYINT(1) NOT NULL DEFAULT 0');
CALL migrate_001_add_column_if_missing('ad_dcs', 'is_rid_master',            'TINYINT(1) NOT NULL DEFAULT 0');
CALL migrate_001_add_column_if_missing('ad_dcs', 'is_schema_master',         'TINYINT(1) NOT NULL DEFAULT 0');
CALL migrate_001_add_column_if_missing('ad_dcs', 'is_domain_naming_master',  'TINYINT(1) NOT NULL DEFAULT 0');
CALL migrate_001_add_column_if_missing('ad_dcs', 'is_infrastructure_master', 'TINYINT(1) NOT NULL DEFAULT 0');
CALL migrate_001_add_column_if_missing('ad_dcs', 'site_hint',                'VARCHAR(64) NULL');
CALL migrate_001_add_column_if_missing('ad_dcs', 'discovered_at',            'DATETIME NULL');
CALL migrate_001_add_column_if_missing('ad_dcs', 'discovered_by_agent_id',   'VARCHAR(64) NULL');

DROP PROCEDURE migrate_001_add_column_if_missing;

-- New system_config rows
INSERT IGNORE INTO system_config (config_key, config_value, description) VALUES
  ('discovery_interval_hours',    '4',  'Agent 上报本地 DC 元数据的时间间隔 (小时)'),
  ('site_matrix_refresh_seconds', '10', '站点复制矩阵页面自动刷新间隔 (秒)');
