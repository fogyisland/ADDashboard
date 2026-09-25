-- AD Replication Dashboard schema (MySQL 8.0+ / InnoDB)
-- Charset: utf8mb4 (full Unicode); collation: utf8mb4_unicode_ci.
-- Timezone is local (Asia/Shanghai) — handled at the connection / session level.
-- Session defaults expected (set by db.js on connect):
--   SET time_zone = '+08:00';
--
-- This file is the SINGLE source of truth for the fresh-install schema.
-- It absorbs every CREATE/ALTER from db/migrations/001-025 (excluding the
-- 023 JS data-migration sidecar — that's a code path, not DDL). An init
-- wizard that runs `applyAll()` on a brand-new DB only needs this file +
-- 02-seed-roles.sql; no migrations/ loop. Existing customers still apply
-- 001-025 incrementally — those files remain unchanged.
--
-- See docs/superpowers/specs/2026-09-09-r84-t1-schema-merge-design.md
-- for the merge rationale and per-table provenance.

-- ==================== ad_replication_status ====================
-- Base: original schema. Appended columns:
--   users_count, groups_count, gpos_count, locked_count  (m007)
--   partner_port_status                                  (m016)
CREATE TABLE IF NOT EXISTS ad_replication_status (
  id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
  collected_at         DATETIME NOT NULL,
  agent_id             VARCHAR(64) NOT NULL,
  source_dc            VARCHAR(128) NOT NULL,
  dest_dc              VARCHAR(128) NOT NULL,
  source_site          VARCHAR(64) NULL,
  dest_site            VARCHAR(64) NULL,
  naming_context       VARCHAR(256) NOT NULL,
  last_success_time    DATETIME NULL,
  last_attempt_time    DATETIME NULL,
  status_code          INT NOT NULL DEFAULT 0,
  error_message        VARCHAR(512) NULL,
  users_count          INT NULL,
  groups_count         INT NULL,
  gpos_count           INT NULL,
  locked_count         INT NULL,
  partner_port_status  JSON NULL,
  UNIQUE KEY uq_repl_partner (source_dc, dest_dc, naming_context),
  KEY ix_repl_collected (collected_at),
  KEY ix_repl_dest (dest_dc)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== ad_replication_history ====================
-- Base columns from original schema; per-attempt log fields added by m021:
--   last_attempt_time, attempt_duration_ms, objects_transferred
-- Plus the composite index ix_hist_pair_time used by the per-pair
-- "last N attempts" query (services/replication-log-all.js).
CREATE TABLE IF NOT EXISTS ad_replication_history (
  id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
  collected_at         DATETIME NOT NULL,
  agent_id             VARCHAR(64) NOT NULL,
  source_dc            VARCHAR(128) NOT NULL,
  dest_dc              VARCHAR(128) NOT NULL,
  naming_context       VARCHAR(256) NOT NULL,
  last_success_time    DATETIME NULL,
  last_attempt_time    DATETIME NULL,
  attempt_duration_ms  INT NULL,
  objects_transferred  INT NULL,
  status_code          INT NOT NULL,
  error_message        VARCHAR(512) NULL,
  KEY ix_hist_time (collected_at),
  KEY ix_hist_pair_time (source_dc, dest_dc, naming_context, collected_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== ad_agent_heartbeat ====================
-- Appended columns: agent_token_version (m017), report_requested_at (m018).
CREATE TABLE IF NOT EXISTS ad_agent_heartbeat (
  agent_id             VARCHAR(64) PRIMARY KEY,
  last_heartbeat_at    DATETIME NULL,
  agent_version        VARCHAR(32) NULL,
  last_report_at       DATETIME NULL,
  last_report_status   VARCHAR(32) NULL,
  pending_queue_size   INT NOT NULL DEFAULT 0,
  agent_token_version  INT NOT NULL DEFAULT 0,
  report_requested_at  DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== ad_sites ====================
-- Appended columns: description, created_at, updated_at (m001).
CREATE TABLE IF NOT EXISTS ad_sites (
  site_id      INT AUTO_INCREMENT PRIMARY KEY,
  site_name    VARCHAR(64) UNIQUE NOT NULL,
  region_code  VARCHAR(32) NULL,
  is_hub       TINYINT(1) NOT NULL DEFAULT 0,
  description  VARCHAR(256) NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== ad_dcs ====================
-- Appended columns:
--   when_created, is_gc, is_rid_master, is_schema_master,
--   is_domain_naming_master, is_infrastructure_master, site_hint,
--   discovered_at, discovered_by_agent_id (m001)
--   is_bridgehead (m020)
CREATE TABLE IF NOT EXISTS ad_dcs (
  dc_name                  VARCHAR(128) PRIMARY KEY,
  site_id                  INT NULL,
  ip_address               VARCHAR(64) NULL,
  os_version               VARCHAR(64) NULL,
  is_pdc                   TINYINT(1) NOT NULL DEFAULT 0,
  when_created             DATETIME NULL,
  is_gc                    TINYINT(1) NOT NULL DEFAULT 0,
  is_rid_master            TINYINT(1) NOT NULL DEFAULT 0,
  is_schema_master         TINYINT(1) NOT NULL DEFAULT 0,
  is_domain_naming_master  TINYINT(1) NOT NULL DEFAULT 0,
  is_infrastructure_master TINYINT(1) NOT NULL DEFAULT 0,
  is_bridgehead            TINYINT(1) NOT NULL DEFAULT 0,
  site_hint                VARCHAR(64) NULL,
  discovered_at            DATETIME NULL,
  discovered_by_agent_id   VARCHAR(64) NULL,
  KEY fk_dcs_site (site_id),
  CONSTRAINT fk_dcs_site FOREIGN KEY (site_id) REFERENCES ad_sites(site_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== system_config (key-value) ====================
CREATE TABLE IF NOT EXISTS system_config (
  config_key   VARCHAR(64) PRIMARY KEY,
  config_value TEXT NULL,
  description  VARCHAR(256) NULL,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by   VARCHAR(64) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== sys_roles ====================
CREATE TABLE IF NOT EXISTS sys_roles (
  id        INT AUTO_INCREMENT PRIMARY KEY,
  role_name VARCHAR(64) UNIQUE NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== role_permissions ====================
-- Replaces the legacy sys_roles.permissions TEXT column that stored
-- JSON-encoded arrays (m002 backfilled and dropped that column).
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id    INT NOT NULL,
  permission VARCHAR(64) NOT NULL,
  PRIMARY KEY (role_id, permission),
  CONSTRAINT fk_role_permissions_role FOREIGN KEY (role_id) REFERENCES sys_roles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== sys_users ====================
-- Appended column: token_version (m015) for JWT revocation.
CREATE TABLE IF NOT EXISTS sys_users (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  username       VARCHAR(64) UNIQUE NOT NULL,
  password_hash  VARCHAR(256) NOT NULL,
  role_id        INT NOT NULL,
  status         TINYINT(1) NOT NULL DEFAULT 1,
  last_login_at  DATETIME NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  token_version  INT NOT NULL DEFAULT 0,
  KEY fk_users_role (role_id),
  CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES sys_roles(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== audit_logs ====================
-- payload column was TEXT in the original schema; m010 changed it to JSON.
-- Indexes ix_audit_action_time + ix_audit_user_time added by m011.
CREATE TABLE IF NOT EXISTS audit_logs (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id    INT NULL,
  action     VARCHAR(64) NOT NULL,
  target     VARCHAR(128) NULL,
  payload    JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_audit_time (created_at),
  KEY ix_audit_action_time (action, created_at),
  KEY ix_audit_user_time (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== sys_config_audit (m005) ====================
-- Audit trail for system_config UPDATEs / ROLLBACKs.
CREATE TABLE IF NOT EXISTS sys_config_audit (
  id          INT PRIMARY KEY AUTO_INCREMENT,
  config_key  VARCHAR(64) NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  changed_by  INT NULL,
  changed_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  change_type ENUM('UPDATE','ROLLBACK') NOT NULL DEFAULT 'UPDATE',
  INDEX idx_changed_at (changed_at),
  INDEX idx_config_key (config_key),
  INDEX idx_changed_by (changed_by)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== system_ports (m003) ====================
-- Admin-curated port list — the center + agent probe these on each host.
CREATE TABLE IF NOT EXISTS system_ports (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  port       INT NOT NULL,
  label      VARCHAR(64) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  UNIQUE KEY uk_system_ports_port (port)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== ad_agent_port_status (m003) ====================
-- Latest per-port probe result per agent. PK is composite; intentionally
-- NO FK to ad_agent_heartbeat so probe results survive retention purges.
CREATE TABLE IF NOT EXISTS ad_agent_port_status (
  agent_id        VARCHAR(64) NOT NULL,
  port            INT NOT NULL,
  ok              TINYINT(1) NOT NULL,
  latency_ms      INT NULL,
  last_checked_at DATETIME(3) NOT NULL,
  PRIMARY KEY (agent_id, port)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== ad_lockout_events (m008) ====================
-- Windows Security event 4740 (user account locked out) — collected from
-- every DC; dedup on (dc_name, event_record_id).
CREATE TABLE IF NOT EXISTS ad_lockout_events (
  id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
  occurred_at           DATETIME NOT NULL,
  collected_at          DATETIME NOT NULL,
  agent_id              VARCHAR(64)  NOT NULL,
  dc_name               VARCHAR(128) NOT NULL,
  event_record_id       BIGINT       NOT NULL,
  target_user_name      VARCHAR(256) NOT NULL,
  subject_user_name     VARCHAR(256) NULL,
  subject_domain        VARCHAR(256) NULL,
  caller_computer_name  VARCHAR(256) NULL,
  UNIQUE KEY uq_lockout_dc_record (dc_name, event_record_id),
  KEY ix_lockout_target_time (target_user_name, occurred_at),
  KEY ix_lockout_caller_time  (caller_computer_name, occurred_at),
  KEY ix_lockout_dc_time      (dc_name, occurred_at),
  KEY ix_lockout_occurred     (occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== probe_state (m012) ====================
-- Center-internal port self-probe (1 Hz). Seeded with 3 port_role rows.
CREATE TABLE IF NOT EXISTS probe_state (
  port_role            VARCHAR(16) NOT NULL PRIMARY KEY,
  status               VARCHAR(16) NOT NULL,
  latency_ms           INT NULL,
  last_probe_at        DATETIME NULL,
  last_up_at           DATETIME NULL,
  consecutive_failures INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO probe_state (port_role, status, consecutive_failures) VALUES
  ('web',       'unknown', 0),
  ('heartbeat', 'unknown', 0),
  ('report',    'unknown', 0);

-- ==================== orphan_schemas (m013) ====================
-- Records DROP SCHEMA failures from package uninstaller so admin can
-- manually clean up. See the 2026-08-09 self-contained-package spec.
CREATE TABLE IF NOT EXISTS orphan_schemas (
  name          VARCHAR(128) NOT NULL PRIMARY KEY,
  last_seen_at  DATETIME     NOT NULL,
  note          VARCHAR(512) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== ad_member_servers (m014) ====================
-- Non-AD server registry; agent_type distinguishes between the legacy
-- DC-only agent (none shipped today) and the member-server agent
-- (default 'non-ad').
CREATE TABLE IF NOT EXISTS ad_member_servers (
  hostname        VARCHAR(128) NOT NULL,
  site_id         INT NULL,
  ip_address      VARCHAR(64)  NULL,
  os_version      VARCHAR(64)  NULL,
  agent_type      VARCHAR(16)  NOT NULL DEFAULT 'non-ad',
  enabled         TINYINT(1)   NOT NULL DEFAULT 1,
  last_seen_at    DATETIME     NULL,
  last_report_at  DATETIME     NULL,
  discovered_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  discovered_via  VARCHAR(32)  NOT NULL DEFAULT 'self-register',
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (hostname),
  KEY ix_member_servers_site (site_id),
  CONSTRAINT fk_member_servers_site FOREIGN KEY (site_id) REFERENCES ad_sites(site_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== ad_server_groups (m014) ====================
-- Operator-defined groups of member servers; referenced by alert rules
-- and bulk install/uninstall operations.
CREATE TABLE IF NOT EXISTS ad_server_groups (
  group_id     INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  group_name   VARCHAR(128) NOT NULL,
  description  VARCHAR(256) NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_server_groups_name (group_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== ad_server_group_members (m014) ====================
CREATE TABLE IF NOT EXISTS ad_server_group_members (
  group_id    INT NOT NULL,
  hostname    VARCHAR(128) NOT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (group_id, hostname),
  KEY ix_sgm_host (hostname),
  CONSTRAINT fk_sgm_group FOREIGN KEY (group_id)  REFERENCES ad_server_groups(group_id)  ON DELETE CASCADE,
  CONSTRAINT fk_sgm_host  FOREIGN KEY (hostname) REFERENCES ad_member_servers(hostname) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== package_scripts (m023) ====================
-- R66 split: script bytes + manifest (immutable per install) live here.
-- Defined BEFORE ad_member_server_packages because the latter has a FK
-- to package_scripts.name.
CREATE TABLE IF NOT EXISTS package_scripts (
  id              BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name            VARCHAR(128) NOT NULL,
  version         VARCHAR(32)  NOT NULL,
  script_content  LONGTEXT     NOT NULL,
  script_sha256   CHAR(64)     NOT NULL,
  manifest_json   JSON         NOT NULL,
  source          VARCHAR(255) NOT NULL,
  created_at      DATETIME     NOT NULL,
  updated_at      DATETIME     NOT NULL,
  UNIQUE KEY uq_package_scripts_name (name),
  KEY ix_package_scripts_updated_at (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== package_policies (m023) ====================
-- R66 split: operator-tunable runtime policy (interval / timeout /
-- enabled / scope / params) lives here, separate from the immutable
-- manifest in package_scripts.
CREATE TABLE IF NOT EXISTS package_policies (
  id           BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name         VARCHAR(128) NOT NULL,
  interval_sec INT          NOT NULL,
  timeout_ms   INT          NOT NULL,
  enabled      TINYINT(1)   NOT NULL DEFAULT 1,
  params_json  JSON         NULL,
  scope        VARCHAR(64)  NOT NULL DEFAULT 'global',
  created_at   DATETIME     NOT NULL,
  updated_at   DATETIME     NOT NULL,
  UNIQUE KEY uq_package_policies_name (name),
  KEY ix_package_policies_enabled (enabled),
  CONSTRAINT fk_package_policies_name FOREIGN KEY (name) REFERENCES package_scripts(name) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== ad_member_server_packages (m014) ====================
-- Which packages are installed on which member server. FK to
-- package_scripts.name (post-R66 split; the original m014 FK pointed at
-- installed_packages.name, dropped by the migration 023 JS sidecar).
CREATE TABLE IF NOT EXISTS ad_member_server_packages (
  hostname      VARCHAR(128) NOT NULL,
  package_name  VARCHAR(128) NOT NULL,
  enabled       TINYINT(1)   NOT NULL DEFAULT 1,
  installed_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_run_at   DATETIME     NULL,
  PRIMARY KEY (hostname, package_name),
  KEY ix_msp_pkg (package_name),
  CONSTRAINT fk_msp_host FOREIGN KEY (hostname) REFERENCES ad_member_servers(hostname) ON DELETE CASCADE,
  CONSTRAINT fk_msp_pkg  FOREIGN KEY (package_name) REFERENCES package_scripts(name) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== alert_rules (m014) ====================
-- Per-hostname alert rules with a serialized expression payload.
CREATE TABLE IF NOT EXISTS alert_rules (
  rule_id           INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  hostname          VARCHAR(128) NOT NULL,
  name              VARCHAR(256) NOT NULL,
  `condition`       TEXT         NOT NULL,
  for_minutes       INT          NOT NULL DEFAULT 5,
  cooldown_minutes  INT          NOT NULL DEFAULT 30,
  recipients        TEXT         NULL,
  enabled           TINYINT(1)   NOT NULL DEFAULT 1,
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_ar_host_enabled (hostname, enabled),
  CONSTRAINT fk_ar_host FOREIGN KEY (hostname) REFERENCES ad_member_servers(hostname) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== alert_rule_state (m014) ====================
-- Tracks per-rule evaluation state (normal / firing / suppressed).
CREATE TABLE IF NOT EXISTS alert_rule_state (
  rule_id            INT NOT NULL PRIMARY KEY,
  state              VARCHAR(16) NOT NULL DEFAULT 'normal',
  first_hit_at       DATETIME    NULL,
  last_evaluated_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_fired_at      DATETIME    NULL,
  last_recovered_at  DATETIME    NULL,
  suppressed_until   DATETIME    NULL,
  CONSTRAINT fk_ars_rule FOREIGN KEY (rule_id) REFERENCES alert_rules(rule_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== alert_events (m014) ====================
CREATE TABLE IF NOT EXISTS alert_events (
  id          BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  rule_id     INT NOT NULL,
  hostname    VARCHAR(128) NOT NULL,
  event       VARCHAR(32)  NOT NULL,
  detail      TEXT         NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ae_rule_created (rule_id, created_at),
  KEY idx_ae_host_created (hostname, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== alert_email_outbox (m014) ====================
-- Outbound SMTP retry queue driven by the alert engine.
CREATE TABLE IF NOT EXISTS alert_email_outbox (
  id              BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
  alert_event_id  BIGINT        NOT NULL,
  to_addrs        VARCHAR(1024) NOT NULL,
  cc_addrs        VARCHAR(1024) NULL,
  subject         VARCHAR(256)  NOT NULL,
  body_text       TEXT          NOT NULL,
  body_html       TEXT          NULL,
  attempt_count   INT           NOT NULL DEFAULT 0,
  next_attempt_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error      TEXT          NULL,
  sent_at         DATETIME      NULL,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_aoe_pending (sent_at, next_attempt_at),
  CONSTRAINT fk_aoe_event FOREIGN KEY (alert_event_id) REFERENCES alert_events(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== metric_gauge (m004) ====================
CREATE TABLE IF NOT EXISTS metric_gauge (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  agent_id        VARCHAR(64) NOT NULL,
  metric_id       VARCHAR(192) NOT NULL,
  ts              DATETIME NOT NULL,
  value           DOUBLE NOT NULL,
  unit            VARCHAR(16) NULL,
  threshold_warn  DOUBLE NULL,
  threshold_crit  DOUBLE NULL,
  UNIQUE KEY uq_gauge_agent_metric (agent_id, metric_id),
  KEY ix_gauge_metric_ts (metric_id, ts DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== metric_counter (m004) ====================
CREATE TABLE IF NOT EXISTS metric_counter (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  agent_id    VARCHAR(64) NOT NULL,
  metric_id   VARCHAR(192) NOT NULL,
  ts          DATETIME NOT NULL,
  value       BIGINT NOT NULL,
  delta       BIGINT NOT NULL DEFAULT 0,
  unit        VARCHAR(16) NULL,
  UNIQUE KEY uq_counter_agent_metric (agent_id, metric_id),
  KEY ix_counter_metric_ts (metric_id, ts DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== metric_timeseries (m004) ====================
CREATE TABLE IF NOT EXISTS metric_timeseries (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  agent_id    VARCHAR(64) NOT NULL,
  metric_id   VARCHAR(192) NOT NULL,
  ts          DATETIME NOT NULL,
  value       DOUBLE NOT NULL,
  tags_json   JSON NULL,
  unit        VARCHAR(16) NULL,
  KEY ix_ts_agent_metric_ts (agent_id, metric_id, ts DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== metric_status (m004) ====================
CREATE TABLE IF NOT EXISTS metric_status (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  agent_id    VARCHAR(64) NOT NULL,
  metric_id   VARCHAR(192) NOT NULL,
  ts          DATETIME NOT NULL,
  status      VARCHAR(64) NOT NULL,
  message     VARCHAR(512) NULL,
  UNIQUE KEY uq_status_agent_metric (agent_id, metric_id),
  KEY ix_status_metric_ts (metric_id, ts DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== package_runs (m004) ====================
-- Append-only audit log of package executions on agents.
CREATE TABLE IF NOT EXISTS package_runs (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  agent_id        VARCHAR(64) NOT NULL,
  package_name    VARCHAR(128) NOT NULL,
  started_at      DATETIME NOT NULL,
  finished_at     DATETIME NULL,
  exit_code       INT NULL,
  stdout_preview  VARCHAR(2048) NULL,
  stderr_preview  VARCHAR(2048) NULL,
  error           VARCHAR(512) NULL,
  KEY ix_run_agent_pkg (agent_id, package_name, started_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== ad_admin_commands (m024) ====================
-- R75 AD admin command queue (center-staged, agent-pull). Mirrors the
-- file-push lifecycle (queued -> success/failed/timeout) but stores the
-- payload in a DB row instead of the filesystem.
CREATE TABLE IF NOT EXISTS ad_admin_commands (
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
  completed_at    DATETIME     NULL,
  KEY ix_ad_admin_commands_target_status (target_dc, status),
  KEY ix_ad_admin_commands_status_created (status, created_at),
  KEY ix_ad_admin_commands_operator (operator_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== ad_member_commands (m025) ====================
-- R81 member-server PowerShell command queue. Mirrors R75
-- ad_admin_commands but targets arbitrary member-server hostnames
-- instead of DCs, and accepts arbitrary PS script content via
-- params_json.script.
CREATE TABLE IF NOT EXISTS ad_member_commands (
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
  completed_at    DATETIME     NULL,
  KEY ix_member_commands_host_status (hostname, status),
  KEY ix_member_commands_status_created (status, created_at),
  KEY ix_member_commands_operator (operator_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== schema_migrations (m009) ====================
-- Tracks applied SQL/JS migrations. Required by the schema-applier
-- (backfillMigrations marks fresh installs as applied_by='system-init').
-- Even on a fresh install this table must exist so the admin "Schema
-- Migrations" page and the boot-upper health checks can run.
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