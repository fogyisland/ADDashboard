-- AD Replication Dashboard schema (SQL Server 2014+)
-- All string columns use NVARCHAR for full Unicode.
-- Timestamps use SYSUTCDATETIME() at the database level.
-- Each CREATE TABLE is wrapped in an IF OBJECT_ID check for idempotency.

-- Replication status snapshot (latest per partner pair)
IF OBJECT_ID('ad_replication_status', 'U') IS NULL
BEGIN
  CREATE TABLE ad_replication_status (
    id                BIGINT IDENTITY(1,1) PRIMARY KEY,
    collected_at      DATETIME2 NOT NULL,
    agent_id          NVARCHAR(64) NOT NULL,
    source_dc         NVARCHAR(128) NOT NULL,
    dest_dc           NVARCHAR(128) NOT NULL,
    source_site       NVARCHAR(64) NULL,
    dest_site         NVARCHAR(64) NULL,
    naming_context    NVARCHAR(256) NOT NULL,
    last_success_time DATETIME2 NULL,
    last_attempt_time DATETIME2 NULL,
    status_code       INT NOT NULL DEFAULT 0,
    error_message     NVARCHAR(512) NULL,
    CONSTRAINT uq_repl_partner UNIQUE (source_dc, dest_dc, naming_context)
  );
  CREATE INDEX ix_repl_collected ON ad_replication_status (collected_at);
  CREATE INDEX ix_repl_dest ON ad_replication_status (dest_dc);
END;

-- History (append-only, retention managed by job)
IF OBJECT_ID('ad_replication_history', 'U') IS NULL
BEGIN
  CREATE TABLE ad_replication_history (
    id                BIGINT IDENTITY(1,1) PRIMARY KEY,
    collected_at      DATETIME2 NOT NULL,
    agent_id          NVARCHAR(64) NOT NULL,
    source_dc         NVARCHAR(128) NOT NULL,
    dest_dc           NVARCHAR(128) NOT NULL,
    naming_context    NVARCHAR(256) NOT NULL,
    last_success_time DATETIME2 NULL,
    status_code       INT NOT NULL,
    error_message     NVARCHAR(512) NULL
  );
  CREATE INDEX ix_hist_time ON ad_replication_history (collected_at);
END;

-- Agent heartbeat
IF OBJECT_ID('ad_agent_heartbeat', 'U') IS NULL
BEGIN
  CREATE TABLE ad_agent_heartbeat (
    agent_id            NVARCHAR(64) PRIMARY KEY,
    last_heartbeat_at   DATETIME2 NULL,
    agent_version       NVARCHAR(32) NULL,
    last_report_at      DATETIME2 NULL,
    last_report_status  NVARCHAR(32) NULL,
    pending_queue_size  INT NOT NULL DEFAULT 0
  );
END;

-- Sites
-- (description + created_at + updated_at folded in from migration 001)
IF OBJECT_ID('ad_sites', 'U') IS NULL
BEGIN
  CREATE TABLE ad_sites (
    site_id     INT IDENTITY(1,1) PRIMARY KEY,
    site_name   NVARCHAR(64) NOT NULL,
    region_code NVARCHAR(32) NULL,
    is_hub      BIT NOT NULL DEFAULT 0,
    description NVARCHAR(256) NULL,
    created_at  DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_at  DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT uq_ad_sites_site_name UNIQUE (site_name)
  );
END;

-- DCs
-- (when_created, is_gc, is_rid_master, is_schema_master, is_domain_naming_master,
--  is_infrastructure_master, site_hint, discovered_at, discovered_by_agent_id
--  folded in from migration 001)
IF OBJECT_ID('ad_dcs', 'U') IS NULL
BEGIN
  CREATE TABLE ad_dcs (
    dc_name                 NVARCHAR(128) PRIMARY KEY,
    site_id                 INT NULL,
    ip_address              NVARCHAR(64) NULL,
    os_version              NVARCHAR(64) NULL,
    is_pdc                  BIT NOT NULL DEFAULT 0,
    when_created            DATETIME2 NULL,
    is_gc                   BIT NOT NULL DEFAULT 0,
    is_rid_master           BIT NOT NULL DEFAULT 0,
    is_schema_master        BIT NOT NULL DEFAULT 0,
    is_domain_naming_master BIT NOT NULL DEFAULT 0,
    is_infrastructure_master BIT NOT NULL DEFAULT 0,
    site_hint               NVARCHAR(64) NULL,
    discovered_at           DATETIME2 NULL,
    discovered_by_agent_id  NVARCHAR(64) NULL,
    CONSTRAINT fk_dcs_site FOREIGN KEY (site_id) REFERENCES ad_sites(site_id)
  );
END;

-- System config (key-value)
IF OBJECT_ID('system_config', 'U') IS NULL
BEGIN
  CREATE TABLE system_config (
    config_key   NVARCHAR(64) PRIMARY KEY,
    config_value NVARCHAR(MAX) NULL,
    description  NVARCHAR(256) NULL,
    updated_at   DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    updated_by   NVARCHAR(64) NULL
  );
END;

-- RBAC roles
IF OBJECT_ID('sys_roles', 'U') IS NULL
BEGIN
  CREATE TABLE sys_roles (
    id          INT IDENTITY(1,1) PRIMARY KEY,
    role_name   NVARCHAR(64) NOT NULL,
    permissions NVARCHAR(MAX) NOT NULL,
    CONSTRAINT uq_sys_roles_role_name UNIQUE (role_name)
  );
END;

-- RBAC users
IF OBJECT_ID('sys_users', 'U') IS NULL
BEGIN
  CREATE TABLE sys_users (
    id              INT IDENTITY(1,1) PRIMARY KEY,
    username        NVARCHAR(64) NOT NULL,
    password_hash   NVARCHAR(256) NOT NULL,
    role_id         INT NOT NULL,
    status          BIT NOT NULL DEFAULT 1,
    last_login_at   DATETIME2 NULL,
    created_at      DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT uq_sys_users_username UNIQUE (username),
    CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES sys_roles(id)
  );
END;

-- Audit log
IF OBJECT_ID('audit_logs', 'U') IS NULL
BEGIN
  CREATE TABLE audit_logs (
    id         BIGINT IDENTITY(1,1) PRIMARY KEY,
    user_id    INT NULL,
    action     NVARCHAR(64) NOT NULL,
    target     NVARCHAR(128) NULL,
    payload    NVARCHAR(MAX) NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
  );
  CREATE INDEX ix_audit_time ON audit_logs (created_at);
END;
