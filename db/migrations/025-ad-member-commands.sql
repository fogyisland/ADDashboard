-- 2026-09-05 R81 — 成员服务器 PowerShell 命令执行 (center-staged,
-- agent-pull). Mirrors the R75 ad_admin_commands lifecycle (queued →
-- claimed by an agent → success/failed/timeout) but targets ANY
-- member-server hostname (not a DC), and accepts arbitrary PowerShell
-- script content via params_json.script.
--
-- Operator queues via POST /api/admin/member-commands; agent polls
-- GET /api/agent/member-commands?hostname=X; agent acks via
-- POST /api/agent/member-commands/:id/result. Rows persist after
-- completion (terminal status retained) for audit history.
--
-- Re-runnable: drops the new table first if it exists (matches migration
-- 024's defensive pattern — harmless because the .sql is idempotent for
-- the migration runner and the apply path is gated by the schema_migrations
-- status column).

DROP TABLE IF EXISTS ad_member_commands;

CREATE TABLE ad_member_commands (
  id              BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  hostname        VARCHAR(128) NOT NULL,
  command_type    VARCHAR(64)  NOT NULL,
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

CREATE INDEX ix_member_commands_host_status ON ad_member_commands(hostname, status);
CREATE INDEX ix_member_commands_status_created ON ad_member_commands(status, created_at);
CREATE INDEX ix_member_commands_operator ON ad_member_commands(operator_id, created_at);
