-- AD Replication Dashboard schema (SQL Server 2019+)
SET QUOTED_IDENTIFIER ON;
GO

-- Replication status snapshot (latest per partner pair)
IF OBJECT_ID('ad_replication_status', 'U') IS NULL
CREATE TABLE ad_replication_status (
  id                BIGINT IDENTITY PRIMARY KEY,
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
CREATE INDEX ix_repl_collected ON ad_replication_status(collected_at);
CREATE INDEX ix_repl_dest ON ad_replication_status(dest_dc);
GO

-- History (append-only, retention managed by job)
IF OBJECT_ID('ad_replication_history', 'U') IS NULL
CREATE TABLE ad_replication_history (
  id                BIGINT IDENTITY PRIMARY KEY,
  collected_at      DATETIME2 NOT NULL,
  agent_id          NVARCHAR(64) NOT NULL,
  source_dc         NVARCHAR(128) NOT NULL,
  dest_dc           NVARCHAR(128) NOT NULL,
  naming_context    NVARCHAR(256) NOT NULL,
  last_success_time DATETIME2 NULL,
  status_code       INT NOT NULL,
  error_message     NVARCHAR(512) NULL
);
CREATE INDEX ix_hist_time ON ad_replication_history(collected_at);
GO

-- Agent heartbeat
IF OBJECT_ID('ad_agent_heartbeat', 'U') IS NULL
CREATE TABLE ad_agent_heartbeat (
  agent_id            NVARCHAR(64) PRIMARY KEY,
  last_heartbeat_at   DATETIME2 NULL,
  agent_version       NVARCHAR(32) NULL,
  last_report_at      DATETIME2 NULL,
  last_report_status  NVARCHAR(32) NULL,
  pending_queue_size  INT NOT NULL DEFAULT 0
);
GO

-- Sites
IF OBJECT_ID('ad_sites', 'U') IS NULL
CREATE TABLE ad_sites (
  site_id     INT IDENTITY PRIMARY KEY,
  site_name   NVARCHAR(64) UNIQUE NOT NULL,
  region_code NVARCHAR(32) NULL,
  is_hub      BIT NOT NULL DEFAULT 0
);
GO

-- DCs
IF OBJECT_ID('ad_dcs', 'U') IS NULL
CREATE TABLE ad_dcs (
  dc_name    NVARCHAR(128) PRIMARY KEY,
  site_id    INT NULL FOREIGN KEY REFERENCES ad_sites(site_id),
  ip_address NVARCHAR(64) NULL,
  os_version NVARCHAR(64) NULL,
  is_pdc     BIT NOT NULL DEFAULT 0
);
GO

-- System config (key-value)
IF OBJECT_ID('system_config', 'U') IS NULL
CREATE TABLE system_config (
  config_key   NVARCHAR(64) PRIMARY KEY,
  config_value NVARCHAR(MAX) NULL,
  description  NVARCHAR(256) NULL,
  updated_at   DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
  updated_by   NVARCHAR(64) NULL
);
GO

-- RBAC roles
IF OBJECT_ID('sys_roles', 'U') IS NULL
CREATE TABLE sys_roles (
  id          INT IDENTITY PRIMARY KEY,
  role_name   NVARCHAR(64) UNIQUE NOT NULL,
  permissions NVARCHAR(MAX) NOT NULL DEFAULT '[]'
);
GO

-- RBAC users
IF OBJECT_ID('sys_users', 'U') IS NULL
CREATE TABLE sys_users (
  id              INT IDENTITY PRIMARY KEY,
  username        NVARCHAR(64) UNIQUE NOT NULL,
  password_hash   NVARCHAR(256) NOT NULL,
  role_id         INT NOT NULL FOREIGN KEY REFERENCES sys_roles(id),
  status          BIT NOT NULL DEFAULT 1,
  last_login_at   DATETIME2 NULL,
  created_at      DATETIME2 NOT NULL DEFAULT GETUTCDATE()
);
GO

-- Audit log
IF OBJECT_ID('audit_logs', 'U') IS NULL
CREATE TABLE audit_logs (
  id         BIGINT IDENTITY PRIMARY KEY,
  user_id    INT NULL,
  action     NVARCHAR(64) NOT NULL,
  target     NVARCHAR(128) NULL,
  payload    NVARCHAR(MAX) NULL,
  created_at DATETIME2 NOT NULL DEFAULT GETUTCDATE()
);
CREATE INDEX ix_audit_time ON audit_logs(created_at);
GO
