-- 2026-09-05 R81 — MSSQL variant. JSON columns use NVARCHAR(MAX) +
-- ISJSON() check; BIGINT IDENTITY; DATETIME2; VARCHAR sizes aligned with
-- the MySQL variant for the spec-defined enum string column. Mirrors
-- the structure of 024-ad-admin-commands.sql (the R75 DC-targeted
-- equivalent) but targets arbitrary member-server hostnames instead.

DROP TABLE IF EXISTS ad_member_commands;

CREATE TABLE ad_member_commands (
  id              BIGINT        IDENTITY(1,1) PRIMARY KEY,
  hostname        NVARCHAR(128) NOT NULL,
  command_type    NVARCHAR(64)  NOT NULL,
  params_json     NVARCHAR(MAX) NOT NULL
                     CONSTRAINT ck_ad_member_commands_params_json_isjson CHECK (ISJSON(params_json) = 1),
  status          NVARCHAR(16)  NOT NULL DEFAULT 'queued',
  operator_id     BIGINT        NULL,
  result_json     NVARCHAR(MAX) NULL
                     CONSTRAINT ck_ad_member_commands_result_json_isjson CHECK (result_json IS NULL OR ISJSON(result_json) = 1),
  error_message   NVARCHAR(2000) NULL,
  duration_ms     INT           NULL,
  created_at      DATETIME2     NOT NULL,
  claimed_at      DATETIME2     NULL,
  completed_at    DATETIME2     NULL
);

CREATE INDEX ix_member_commands_host_status ON ad_member_commands(hostname, status);
CREATE INDEX ix_member_commands_status_created ON ad_member_commands(status, created_at);
CREATE INDEX ix_member_commands_operator ON ad_member_commands(operator_id, created_at);
