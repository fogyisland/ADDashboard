-- AD Replication Dashboard schema (MySQL 8.0+ / InnoDB)
-- Charset: utf8mb4 (full Unicode); collation: utf8mb4_unicode_ci.
-- Timezone is local (Asia/Shanghai) — handled at the connection / session level.
-- Session defaults expected (set by db.js on connect):
--   SET time_zone = '+08:00';

-- Replication status snapshot (latest per partner pair)
CREATE TABLE IF NOT EXISTS ad_replication_status (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  collected_at      DATETIME NOT NULL,
  agent_id          VARCHAR(64) NOT NULL,
  source_dc         VARCHAR(128) NOT NULL,
  dest_dc           VARCHAR(128) NOT NULL,
  source_site       VARCHAR(64) NULL,
  dest_site         VARCHAR(64) NULL,
  naming_context    VARCHAR(256) NOT NULL,
  last_success_time DATETIME NULL,
  last_attempt_time DATETIME NULL,
  status_code       INT NOT NULL DEFAULT 0,
  error_message     VARCHAR(512) NULL,
  UNIQUE KEY uq_repl_partner (source_dc, dest_dc, naming_context),
  KEY ix_repl_collected (collected_at),
  KEY ix_repl_dest (dest_dc)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- History (append-only, retention managed by job)
CREATE TABLE IF NOT EXISTS ad_replication_history (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  collected_at      DATETIME NOT NULL,
  agent_id          VARCHAR(64) NOT NULL,
  source_dc         VARCHAR(128) NOT NULL,
  dest_dc           VARCHAR(128) NOT NULL,
  naming_context    VARCHAR(256) NOT NULL,
  last_success_time DATETIME NULL,
  status_code       INT NOT NULL,
  error_message     VARCHAR(512) NULL,
  KEY ix_hist_time (collected_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Agent heartbeat
CREATE TABLE IF NOT EXISTS ad_agent_heartbeat (
  agent_id            VARCHAR(64) PRIMARY KEY,
  last_heartbeat_at   DATETIME NULL,
  agent_version       VARCHAR(32) NULL,
  last_report_at      DATETIME NULL,
  last_report_status  VARCHAR(32) NULL,
  pending_queue_size  INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Sites
CREATE TABLE IF NOT EXISTS ad_sites (
  site_id     INT AUTO_INCREMENT PRIMARY KEY,
  site_name   VARCHAR(64) UNIQUE NOT NULL,
  region_code VARCHAR(32) NULL,
  is_hub      TINYINT(1) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- DCs
CREATE TABLE IF NOT EXISTS ad_dcs (
  dc_name    VARCHAR(128) PRIMARY KEY,
  site_id    INT NULL,
  ip_address VARCHAR(64) NULL,
  os_version VARCHAR(64) NULL,
  is_pdc     TINYINT(1) NOT NULL DEFAULT 0,
  CONSTRAINT fk_dcs_site FOREIGN KEY (site_id) REFERENCES ad_sites(site_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- System config (key-value)
CREATE TABLE IF NOT EXISTS system_config (
  config_key   VARCHAR(64) PRIMARY KEY,
  config_value TEXT NULL,
  description  VARCHAR(256) NULL,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by   VARCHAR(64) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- RBAC roles
CREATE TABLE IF NOT EXISTS sys_roles (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  role_name   VARCHAR(64) UNIQUE NOT NULL,
  permissions TEXT NOT NULL DEFAULT '[]'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- RBAC users
CREATE TABLE IF NOT EXISTS sys_users (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  username        VARCHAR(64) UNIQUE NOT NULL,
  password_hash   VARCHAR(256) NOT NULL,
  role_id         INT NOT NULL,
  status          TINYINT(1) NOT NULL DEFAULT 1,
  last_login_at   DATETIME NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES sys_roles(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Audit log
CREATE TABLE IF NOT EXISTS audit_logs (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id    INT NULL,
  action     VARCHAR(64) NOT NULL,
  target     VARCHAR(128) NULL,
  payload    TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_audit_time (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;