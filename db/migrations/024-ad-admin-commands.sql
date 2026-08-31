-- 2026-08-31 R75 — AD user & group management command queue (center-staged,
-- agent-pull). Mirrors the existing file-push lifecycle (queued → claimed
-- by an agent → success/failed/timeout) but persists the row in MySQL
-- instead of the file-push filesystem. Operator queues via
-- POST /api/admin/ad-commands; agent polls GET /api/agent/ad-commands;
-- agent acks via POST /api/agent/ad-commands/:id/result. Rows persist
-- after completion (terminal status retained) for audit history.
--
-- Re-runnable: drops the new table first if it exists (matches migration
-- 023's defensive pattern — harmless because the .sql is idempotent for
-- the migration runner and the apply path is gated by the schema_migrations
-- status column).

DROP TABLE IF EXISTS ad_admin_commands;

CREATE TABLE ad_admin_commands (
  id              BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  command_type    VARCHAR(64)  NOT NULL,
  target_dc       VARCHAR(128) NOT NULL,
  params_json     JSON         NOT NULL,
  status          VARCHAR(16)  NOT NULL DEFAULT 'queued',
  operator_id     BIGINT       NULL,
  result_json     JSON         NULL,
  error_message   VARCHAR(2000) NULL,
  duration_ms     INT          NULL,
  created_at      DATETIME     NOT NULL,
  claimed_at      DATETIME     NULL,
  completed_at    DATETIME     NULL
);

CREATE INDEX ix_ad_admin_commands_target_status ON ad_admin_commands(target_dc, status);
CREATE INDEX ix_ad_admin_commands_status_created ON ad_admin_commands(status, created_at);
CREATE INDEX ix_ad_admin_commands_operator ON ad_admin_commands(operator_id, created_at);