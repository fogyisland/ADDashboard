-- 009-schema-migrations.sql
-- Track which SQL migrations have been applied to the current DB.
-- Server-side tracking enables the admin "Schema Migrations" page to:
--   - list applied vs pending files in db/migrations/<dialect>/
--   - apply a single pending migration on demand
--   - dry-run (parse + show statements without executing)
--   - reset a failed migration so it can be retried
-- Re-runnable via CREATE TABLE IF NOT EXISTS. See also: docs/superpowers/specs/2026-08-06-schema-admin-design.md
CREATE TABLE IF NOT EXISTS schema_migrations (
  version        VARCHAR(32)  NOT NULL PRIMARY KEY,
  description    VARCHAR(255) NOT NULL,
  type           VARCHAR(16)  NOT NULL DEFAULT 'sql',
  script         VARCHAR(255) NOT NULL,
  checksum       CHAR(64)     NOT NULL,
  applied_at     DATETIME     NOT NULL,
  applied_by     VARCHAR(64)  NULL,
  execution_ms   INT          NULL,
  status         VARCHAR(16)  NOT NULL DEFAULT 'applied',
  error_message  TEXT         NULL,
  KEY ix_schema_migrations_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
