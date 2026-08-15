-- verify: table role_permissions

-- AD Dashboard migration 002: replace JSON-encoded sys_roles.permissions with
-- the role_permissions relational table (third normal form).
--
-- Applies after 01-tables.sql + 02-seed-roles.sql.
-- Idempotent: skips backfill if role_permissions is already populated, and
-- drops the legacy column only if it still exists. Safe to run on a fresh DB
-- (which already has the new schema and no legacy column) and on an upgraded
-- DB (which still has the legacy column with JSON-encoded permission arrays).
--
-- MySQL 5.7+ compatible (no WITH RECURSIVE — that syntax was added in 8.0;
-- the WHILE loop iterates the JSON array indexes 0..19 instead).

-- Defensive: create role_permissions if the schema file wasn't applied (e.g.
-- someone is running this migration against an older 01-tables.sql).
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id    INT NOT NULL,
  permission VARCHAR(64) NOT NULL,
  PRIMARY KEY (role_id, permission),
  CONSTRAINT fk_role_permissions_role FOREIGN KEY (role_id) REFERENCES sys_roles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$

DROP PROCEDURE IF EXISTS migrate_002_permissions_table$$
CREATE PROCEDURE migrate_002_permissions_table()
BEGIN
  DECLARE has_legacy_col INT DEFAULT 0;
  DECLARE target_count INT DEFAULT 0;
  DECLARE i INT DEFAULT 0;
  DECLARE max_perms INT DEFAULT 20;

  SELECT COUNT(*) INTO has_legacy_col
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'sys_roles'
      AND COLUMN_NAME = 'permissions';

  SELECT COUNT(*) INTO target_count FROM role_permissions;

  IF has_legacy_col > 0 AND target_count = 0 THEN
    -- Unwrap the JSON array into role_permissions rows. WHILE loop walks the
    -- array indexes 0..max_perms-1 — generous cap, no real role has more than
    -- a handful of permissions. INSERT IGNORE keeps the loop safe to re-run if
    -- the procedure is interrupted mid-iteration.
    SET i = 0;
    WHILE i < max_perms DO
      INSERT IGNORE INTO role_permissions (role_id, permission)
        SELECT r.id, JSON_UNQUOTE(JSON_EXTRACT(r.permissions, CONCAT('$[', i, ']')))
        FROM sys_roles r
        WHERE r.permissions IS NOT NULL
          AND JSON_VALID(r.permissions) = 1
          AND JSON_LENGTH(r.permissions) > i;
      SET i = i + 1;
    END WHILE;
  END IF;

  IF has_legacy_col > 0 THEN
    ALTER TABLE sys_roles DROP COLUMN permissions;
  END IF;
END$$

DELIMITER ;

CALL migrate_002_permissions_table();
DROP PROCEDURE migrate_002_permissions_table;
