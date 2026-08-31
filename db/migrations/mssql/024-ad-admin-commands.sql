-- 2026-08-31 R75 — MSSQL variant. JSON columns use NVARCHAR(MAX) +
-- ISJSON() check; BIGINT IDENTITY; DATETIME2; VARCHAR sizes aligned with
-- the MySQL variant for the spec-defined enum string column.

DROP TABLE IF EXISTS ad_admin_commands;

CREATE TABLE ad_admin_commands (
  id              BIGINT        IDENTITY(1,1) PRIMARY KEY,
  command_type    NVARCHAR(64)  NOT NULL,
  target_dc       NVARCHAR(128) NOT NULL,
  params_json     NVARCHAR(MAX) NOT NULL
                     CONSTRAINT ck_ad_admin_commands_params_json_isjson CHECK (ISJSON(params_json) = 1),
  status          NVARCHAR(16)  NOT NULL DEFAULT 'queued',
  operator_id     BIGINT        NULL,
  result_json     NVARCHAR(MAX) NULL
                     CONSTRAINT ck_ad_admin_commands_result_json_isjson CHECK (result_json IS NULL OR ISJSON(result_json) = 1),
  error_message   NVARCHAR(2000) NULL,
  duration_ms     INT           NULL,
  created_at      DATETIME2     NOT NULL,
  claimed_at      DATETIME2     NULL,
  completed_at    DATETIME2     NULL
);

CREATE INDEX ix_ad_admin_commands_target_status ON ad_admin_commands(target_dc, status);
CREATE INDEX ix_ad_admin_commands_status_created ON ad_admin_commands(status, created_at);
CREATE INDEX ix_ad_admin_commands_operator ON ad_admin_commands(operator_id, created_at);