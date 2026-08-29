-- 2026-08-29 R66 — MSSQL variant. JSON columns use NVARCHAR(MAX) +
-- ISJSON() check; BIGINT IDENTITY; TINYINT replaced with BIT; index
-- creation explicit.

DROP TABLE IF EXISTS package_policies;
DROP TABLE IF EXISTS package_scripts;

CREATE TABLE package_scripts (
  id              BIGINT       IDENTITY(1,1) PRIMARY KEY,
  name            NVARCHAR(128) NOT NULL,
  version         NVARCHAR(32)  NOT NULL,
  script_content  NVARCHAR(MAX) NOT NULL,
  script_sha256   CHAR(64)      NOT NULL,
  manifest_json   NVARCHAR(MAX) NOT NULL
                     CONSTRAINT ck_package_scripts_manifest_json_isjson CHECK (ISJSON(manifest_json) = 1),
  source          NVARCHAR(255) NOT NULL,
  created_at      DATETIME2     NOT NULL,
  updated_at      DATETIME2     NOT NULL,
  CONSTRAINT uq_package_scripts_name UNIQUE (name)
);

CREATE INDEX ix_package_scripts_updated_at ON package_scripts(updated_at);

CREATE TABLE package_policies (
  id              BIGINT       IDENTITY(1,1) PRIMARY KEY,
  name            NVARCHAR(128) NOT NULL,
  interval_sec    INT           NOT NULL,
  timeout_ms      INT           NOT NULL,
  enabled         BIT           NOT NULL DEFAULT 1,
  params_json     NVARCHAR(MAX) NULL,
  scope           NVARCHAR(64)  NOT NULL DEFAULT 'global',
  created_at      DATETIME2     NOT NULL,
  updated_at      DATETIME2     NOT NULL,
  CONSTRAINT fk_package_policies_name FOREIGN KEY (name)
    REFERENCES package_scripts(name) ON DELETE CASCADE,
  CONSTRAINT uq_package_policies_name UNIQUE (name)
);

CREATE INDEX ix_package_policies_enabled ON package_policies(enabled);
