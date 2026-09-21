-- 2026-08-26: per-package operator-overridable execution interval.
--
-- Why a separate column instead of editing manifest.agent.intervalSec?
-- The manifest is a packaged artifact (immutable after install per the v2
-- contract — installer/registry re-installs overwrite the column to whatever
-- the manifest declares). The operator's "throttle this package to 5
-- minutes because I don't need minute-level fidelity on member-server CPU"
-- decision is a runtime operational override that must survive package
-- upgrades and re-imports. Storing it on its own column, with NULL meaning
-- "fall back to manifest.agent.intervalSec", preserves both intents.
--
-- Range matches the manifest schema's intervalSec constraint (5..86400 =
-- 5 seconds..1 day). Out-of-range values are rejected by the admin route,
-- not by the column — keeps the column simple INT NULL and lets the route
-- own the operator-facing error message.
--
-- R85 hardening (2026-09-21): the original 019 was a bare ALTER TABLE
-- installed_packages ADD COLUMN. After migration 023 (R66) the
-- `installed_packages` table no longer exists on any center that picked up
-- the V1 package split — fresh installs go through db/schema/01-tables.sql
-- directly (which never carried `installed_packages`), and live centers
-- running >= R66 had it dropped by the 023 JS sidecar. A bare ALTER would
-- fail every upgrade and leave a permanent `status='failed'` row in
-- schema_migrations. The MSSQL sibling at db/migrations/mssql/019-*.sql
-- was already guarded; this MySQL file now mirrors that intent with the
-- same INFOSCHEMA + dynamic-SQL pattern used by 016. The procedure is a
-- no-op when (a) the table is missing or (b) the column already exists,
-- so re-running 019 against either side of the R66 split is safe.
DELIMITER $$

DROP PROCEDURE IF EXISTS migrate_019_add_column_if_missing$$
CREATE PROCEDURE migrate_019_add_column_if_missing(
  IN p_table VARCHAR(64), IN p_column VARCHAR(64), IN p_definition VARCHAR(255)
)
BEGIN
  DECLARE v_table_exists INT DEFAULT 0;
  DECLARE v_column_exists INT DEFAULT 0;
  -- Guard #1: table missing (R66 dropped installed_packages on V1 centers;
  -- fresh installs never had it). Silently skip — the V0 column does not
  -- exist in the V1 schema, so nothing to ALTER. Recording the migration
  -- as `applied` is the correct outcome either way.
  SELECT COUNT(*) INTO v_table_exists FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = p_table;
  IF v_table_exists = 1 THEN
    -- Guard #2: column already added by a prior run. Skip without ALTER —
    -- MySQL 8 has no ADD COLUMN IF NOT EXISTS natively, so re-running
    -- this procedure is safe via this two-step INFORMATION_SCHEMA check.
    SELECT COUNT(*) INTO v_column_exists FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = p_table AND COLUMN_NAME = p_column;
    IF v_column_exists = 0 THEN
      SET @sql = CONCAT('ALTER TABLE ', p_table, ' ADD COLUMN ', p_column, ' ', p_definition);
      PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
    END IF;
  END IF;
END$$

DELIMITER ;

CALL migrate_019_add_column_if_missing('installed_packages', 'interval_override_sec',
  'INT NULL AFTER params_json');

DROP PROCEDURE migrate_019_add_column_if_missing;
