-- 2026-08-29 R66 — split installed_packages into scripts + policies.
-- Re-runnable: drops the new tables first if they exist (defensive — never
-- needed on a fresh DB but harmless because both CREATE statements are
-- idempotent for the migration runner). The JS data migration that follows
-- must run BEFORE the installed_packages DROP — see migration-applier for
-- the orchestration.

DROP TABLE IF EXISTS package_policies;
DROP TABLE IF EXISTS package_scripts;

CREATE TABLE package_scripts (
  id              BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name            VARCHAR(128) NOT NULL,
  version         VARCHAR(32)  NOT NULL,
  script_content  LONGTEXT     NOT NULL,
  script_sha256   CHAR(64)     NOT NULL,
  manifest_json   JSON         NOT NULL,
  source          VARCHAR(255) NOT NULL,
  created_at      DATETIME     NOT NULL,
  updated_at      DATETIME     NOT NULL,
  CONSTRAINT uq_package_scripts_name UNIQUE (name)
);

CREATE INDEX ix_package_scripts_updated_at ON package_scripts(updated_at);

CREATE TABLE package_policies (
  id              BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name            VARCHAR(128) NOT NULL,
  interval_sec    INT          NOT NULL,
  timeout_ms      INT          NOT NULL,
  enabled         TINYINT(1)   NOT NULL DEFAULT 1,
  params_json     JSON         NULL,
  scope           VARCHAR(64)  NOT NULL DEFAULT 'global',
  created_at      DATETIME     NOT NULL,
  updated_at      DATETIME     NOT NULL,
  CONSTRAINT fk_package_policies_name FOREIGN KEY (name)
    REFERENCES package_scripts(name) ON DELETE CASCADE,
  CONSTRAINT uq_package_policies_name UNIQUE (name)
);

CREATE INDEX ix_package_policies_enabled ON package_policies(enabled);
