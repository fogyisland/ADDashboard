-- verify: table orphan_schemas

-- Migration 013 — orphan_schemas tracking table.
-- Used by the package installer/uninstaller when DROP SCHEMA fails after a
-- successful uninstall: the schema name is recorded here so admin can
-- manually clean up. Pure CREATE TABLE IF NOT EXISTS — no procedures, no
-- DELIMITER. Safe for the schema-applier.
--
-- Schema name format: `pkg_<name>` (e.g. `pkg_diskspace`). PK on `name`
-- keeps upserts idempotent (INSERT ... ON DUPLICATE KEY UPDATE on the
-- mysql side, MERGE on mssql). `last_seen_at` tracks the most recent
-- failure so the admin view can sort by recency. `note` is free-form
-- (e.g. "FK violation on metric_status.id") for diagnostic context.
--
-- See docs/superpowers/specs/2026-08-09-self-contained-monitoring-package-design.md
-- §"orphan_schemas (new, main schema)".
CREATE TABLE IF NOT EXISTS orphan_schemas (
  name          VARCHAR(128) NOT NULL PRIMARY KEY,
  last_seen_at  DATETIME     NOT NULL,
  note          VARCHAR(512) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;