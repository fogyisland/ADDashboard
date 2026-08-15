-- verify: table orphan_schemas

-- Migration 013 (MSSQL) — orphan_schemas tracking table.
-- Records DROP SCHEMA failures from the package uninstaller so admin can
-- manually clean up. MSSQL doesn't support CREATE TABLE IF NOT EXISTS — use
-- the project's established IF OBJECT_ID guard pattern (same as 008, 012).
-- See docs/superpowers/specs/2026-08-09-self-contained-monitoring-package-design.md
-- §"orphan_schemas (new, main schema)".
IF OBJECT_ID('orphan_schemas', 'U') IS NULL
BEGIN
  CREATE TABLE orphan_schemas (
    name          NVARCHAR(128) NOT NULL PRIMARY KEY,
    last_seen_at  DATETIMEOFFSET NOT NULL,
    note          NVARCHAR(512) NULL
  );
END;