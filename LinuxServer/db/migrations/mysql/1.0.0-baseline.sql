-- AD Replication Dashboard schema (MySQL 5.7+ / InnoDB)
-- ★ R161.6 (2026-10-26) — 头部原写 "MySQL 8.0+", 与**真库**不符:
--   操作员的真库是 MySQL **5.7.44**, 向导界面也写的是 "MySQL 5.7+"。
--   本文件必须按 5.7 的能力写 (没有窗口函数 / CTE / ADD COLUMN IF NOT EXISTS),
--   写成 8.0 会让人以为可以用 8.0 语法 —— 5.7 上直接 ER_PARSE_ERROR。
-- Charset: utf8mb4 (full Unicode); collation: utf8mb4_unicode_ci.
-- Timezone is UTC ('Z') — handled at the connection level via mysql2 pool
-- `timezone: 'Z'` option in center/src/db/drivers/mysql.js (round-15 follow-up
-- 2026-08-26). Do NOT switch to '+08:00' here — storage is UTC-naive strings
-- (UTC_TIMESTAMP(3)) and mysql2 with 'Z' returns the same UTC instant; '+08:00'
-- would shift the parsed Date by -8h. See R158 round-15 follow-up.
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
--   partner_port_status  (m016)
--
-- R110.A: counter columns (users_count, groups_count, gpos_count, locked_count)
-- that previously piggybacked on this table via the __dc_summary__ self-loop
-- are moved to a dedicated public ad_dc_overview table. Existing installs keep
-- the m007 columns (no DROP here — separate migration); new code does not
-- write them.
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

-- ==================== ad_replication_probe_history ====================
-- R158.15 (2026-10-01) -- ad_replication_status_probe package append-only history.
-- Public-table contract (manifest.database block absent). Each
-- (source_dc, dest_dc, naming_context) triple gets one row per 15-min probe.
-- Separate from ad_replication_history (legacy collect-replication.ps1
-- pipeline) so the two histories don't mix.
CREATE TABLE IF NOT EXISTS ad_replication_probe_history (
  id                  BIGINT       NOT NULL AUTO_INCREMENT,
  collected_at        DATETIME(3)  NOT NULL,
  agent_id            VARCHAR(64)  NOT NULL,
  source_dc           VARCHAR(128) NOT NULL,
  dest_dc             VARCHAR(128) NOT NULL,
  naming_context      VARCHAR(256) NOT NULL,
  attempt_at          DATETIME(3)  NOT NULL,
  result              VARCHAR(16)  NOT NULL,
  status_code         TINYINT      NOT NULL,
  duration_ms         INT          NULL,
  objects_transferred INT          NULL,
  error_code          INT          NULL,
  error_message       VARCHAR(512) NULL,
  PRIMARY KEY (id),
  KEY ix_probe_pair_time (source_dc, dest_dc, naming_context, attempt_at),
  KEY ix_probe_attempt_at (attempt_at),
  KEY ix_probe_collected_at (collected_at),
  KEY ix_probe_agent (agent_id)
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

-- ==================== ad_dc_overview (R110.A) ====================
-- Dedicated public table for AD 服务器公开 counters + partner_port_status.
-- Replaces the __dc_summary__ self-loop piggyback on ad_replication_status.
-- Schema is public (no pkg_ prefix) because the operator wants this as
-- a "公共表" — queryable from any SQL context without per-package scoping.
-- The ad_dc_overview v2 package omits its `database` block so this table
-- is the SINGLE source of truth; no migrations/ folder needed (R108.1
-- bootstrap-vs-migrations split lesson).
--
-- ⚠ 位置约束 (R161.2): 本块的内联外键 fk_dc_overview_site 参照 ad_sites,
--   而 MySQL 的 InnoDB 要求**被引用表已经存在**才允许建外键 ⇒ 本块必须排在
--   ad_sites 建表之后。基线是按文件顺序逐条执行的, 排到前面会让全新库报
--   errno 150 "Cannot add foreign key constraint"; 老库不受影响
--   (bootstrapMigrations 见到 schema_migrations 表存在就短路) ⇒ 只有新装会炸,
--   故障现场还落在完全不相干的表上, 极难定位。
--   守卫: Server/scripts/audit/check-fk-order.mjs (复用生产 splitSqlStatements)
CREATE TABLE IF NOT EXISTS ad_dc_overview (
  id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
  collected_at         DATETIME NOT NULL,
  agent_id             VARCHAR(64) NOT NULL,
  dc_name              VARCHAR(128) NOT NULL,
  site_id              INT NULL,
  users_count          INT NULL,
  groups_count         INT NULL,
  gpos_count           INT NULL,
  partner_port_status  JSON NULL,
  UNIQUE KEY uq_dc_overview_dc (dc_name),
  KEY ix_dc_overview_collected (collected_at),
  KEY ix_dc_overview_site (site_id),
  CONSTRAINT fk_dc_overview_site FOREIGN KEY (site_id) REFERENCES ad_sites(site_id)
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
  -- R158.72.x.13 (2026-10-17) — cron 范式第三种调度形态。
  --   NULL + interval_sec 非 0 = agent 端 setInterval 自跑;
  --   非 NULL + interval_sec = 0 = 中心端 cron 为唯一 fire 源;
  --   interval_sec = 0 + NULL = on-demand (command 包, 不自跑只等派发)。
  --   MySQL 侧此前整列缺失, 导致 /admin/packages-schedule 页查询失败,
  --   且 4 个 cron 范式包无处落库。类型与 MSSQL 侧 NVARCHAR(128) 对齐。
  cron_expr    VARCHAR(128) NULL,
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

-- R158.X.116.d (2026-10-22) — 移除 alert_rules / alert_rule_state /
--   alert_events / alert_email_outbox (m014 引入) 4 张死表。MSSQL 侧早已
--   清理干净, MySQL baseline 没跟上。
--   死的依据 (双方言一致, 非方言差异):
--     · src/ 全域零 SQL 引用 (db.sql 里连 alertRules / alertEvents key 都没有)
--     · 告警链路已改道: email.js listPending() 扫 4 张表
--       (system_alert_outbox / report_email_outbox / ad_notify_outbox /
--       license_email_outbox); email-queue.js 的 UNION ALL 也只查前两张
--     · R158.61 把报表邮件拆出 report_email_outbox; R158.68 再把告警邮件
--       拆出 system_alert_outbox, alert_email_outbox 随之作废
--     · system-alert-engine.js 只用 systemAlerts.* / systemAlertOutbox.*
--     · 实测生产库 4 张表均不存在
--   连带移除的过时注释: routes/member-servers.js:335 (FK cascade 那行提到
--   alert_rules, 但真表已不存在)。该行将在代码侧另行更新。

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

-- ==================== ad_eventlog_events (R112) ====================
-- Public per-event log from the 4 Windows Event Log channels: System,
-- Application, AD Web Services, DFSR. The agent emits {warning, error}
-- rows from each channel; the centre rolls up into ad_eventlog_summary
-- so the public EventlogView page can render without full-table scans.
-- 24-hour retention: a centre-side cron prunes both tables hourly.
-- Schema is public (no pkg_ prefix) — operator wants this viewable from
-- the login screen without auth.
CREATE TABLE IF NOT EXISTS ad_eventlog_events (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  collected_at    DATETIME    NOT NULL,
  agent_id        VARCHAR(64) NOT NULL,
  dc_name         VARCHAR(128) NOT NULL,
  channel         VARCHAR(32) NOT NULL,
  severity        VARCHAR(16) NOT NULL,
  event_id        INT         NOT NULL,
  record_id       BIGINT      NOT NULL,
  message         TEXT        NOT NULL,
  ts              DATETIME    NOT NULL,
  KEY ix_eventlog_collected (collected_at),
  KEY ix_eventlog_dc_channel (dc_name, channel, ts),
  KEY ix_eventlog_severity (severity, ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== ad_eventlog_summary (R112) ====================
-- Per-DC + per-channel warning/error counts. Latest row per (dc_name,
-- channel) is the source for the public EventlogView headline numbers.
-- Refreshed by the runner post-hook for ad_eventlog_collector (R107.1
-- + R110.A post-hook pattern). Retention is unified via the cron on
-- ad_eventlog_events — events stay 24h, summary gets pruned alongside.
CREATE TABLE IF NOT EXISTS ad_eventlog_summary (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  collected_at    DATETIME    NOT NULL,
  agent_id        VARCHAR(64) NOT NULL,
  dc_name         VARCHAR(128) NOT NULL,
  channel         VARCHAR(32) NOT NULL,
  warning_count   INT         NOT NULL DEFAULT 0,
  error_count     INT         NOT NULL DEFAULT 0,
  UNIQUE KEY uq_eventlog_summary_dc_channel_collected (dc_name, channel, collected_at),
  KEY ix_eventlog_summary_collected (collected_at),
  KEY ix_eventlog_summary_dc (dc_name)
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

-- ==================== ad_remote_port_probe (R114) ====================
-- Centre-side active probe results. The port-probe scheduler
-- (center/src/services/port-probe-scheduler.js) writes one row per
-- (probe_at, dc_name, port) every cycle; the dashboard joins this
-- against system_ports to show centre→agent connectivity from THIS
-- centre server's vantage point (not the loopback agent probe R113
-- shipped). The UNIQUE KEY supports an idempotent upsert keyed on
-- (dc, port, probe_at) so a cycle re-run for the same probe_at slot
-- just overwrites. Indexes support the dashboard's "latest per (dc,
-- port)" join pattern.
CREATE TABLE IF NOT EXISTS ad_remote_port_probe (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  probe_at      DATETIME NOT NULL,
  dc_name       VARCHAR(128) NOT NULL,
  port          INT NOT NULL,
  ok            TINYINT(1) NOT NULL,
  latency_ms    INT NULL,
  error         VARCHAR(64) NULL,
  UNIQUE KEY uq_remote_probe_dc_port_at (dc_name, port, probe_at),
  KEY ix_remote_probe_dc (dc_name),
  KEY ix_remote_probe_at (probe_at),
  KEY ix_remote_probe_ok (ok)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== system_settings (R114) ====================
-- Generic runtime-configurable KV store. Replaces a long history of
-- "config knob X must restart centre to take effect" pain points —
-- any code path that reads a knob on each cycle (the R114 port-probe
-- without a restart. Composite PK on (setting_key) is the natural index
-- for the GET path; the (key, value) shape is intentionally generic so
-- future knobs reuse this table without a schema change. The R114 admin
-- endpoint enforces [5000, 3_600_000] ms on r114_probe_interval_ms; other
-- keys added later will define their own range checks at the write site.
CREATE TABLE IF NOT EXISTS system_settings (
  setting_key    VARCHAR(128) NOT NULL PRIMARY KEY,
  setting_value  VARCHAR(1024) NOT NULL,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== ad_users_snapshot (R158.35) ====================
-- LDAP user snapshot for /api/admin/ad-users?dc=X. Per-domain rows, UPSERT by
-- (domain_name, sam), orphan DELETE at end of each sync run. Public table
-- (no pkg_ prefix — operator wants AD inventory readable outside any
-- package context). No FK to ad_dcs: snapshot rows may outlive the DC row.
CREATE TABLE IF NOT EXISTS ad_users_snapshot (
  -- R158.X.116.c (2026-10-22) — dc_name 改名为 domain_name 并做 PK 第一键。
  --   依据: 真库 MSSQL 结构 (ad_users_snapshot 建表即 domain_name, 无 dc_name 列,
  --   PK (domain_name, sam), 索引 idx_users_forest_dc(forest_id, domain_name));
  --   代码侧 upsert/SELECT 全部用 domain_name (sql.js:3336 注释: "ON DUPLICATE KEY
  --   refreshes every column EXCEPT the PK (domain_name, sam)")。MySQL 侧此前
  --   dc_name 建表 + PK, domain_name 由后段 ALTER 补上, 两列并存且 PK 落在错的
  --   列上 → 多域同名用户互相覆盖。删 dc_name, 与真库 + MSSQL baseline 三方对齐。
  domain_name            VARCHAR(128)  NOT NULL,
  sam                    VARCHAR(256)  NOT NULL,
  display_name           VARCHAR(512)  NULL,
  distinguished_name     VARCHAR(1024) NOT NULL,
  ou_dn                  VARCHAR(1024) NULL,
  enabled                TINYINT(1)    NULL,
  locked_out             TINYINT(1)    NULL,
  last_logon             DATETIME      NULL,
  when_created           DATETIME      NULL,
  password_last_set      DATETIME      NULL,
  user_account_control   INT           NULL,
  description            VARCHAR(1024) NULL,
  manager_dn             VARCHAR(1024) NULL,  -- R158.36 (2026-10-03)
  manager_sam            VARCHAR(256)  NULL,  -- R158.36 (2026-10-03)
  snapshot_at            DATETIME      NOT NULL,
  snapshot_run_id        BIGINT        NOT NULL,
  forest_id              BIGINT        NULL,   -- R158.38 (2026-10-03) 中心 binding 来源 forest; 老行 NULL
  domain_id              BIGINT        NULL,   -- R158.38 (2026-10-03) 中心 binding 来源 domain; 老行 NULL
  PRIMARY KEY (domain_name, sam),
  KEY ix_users_snapshot_at    (snapshot_at),
  KEY ix_users_enabled_locked (enabled, locked_out),
  -- R161.3: 长 DN 前缀索引 (191 字符 × utf8mb4 4B = 766B ≤ 3072)。
  --   实测 (MySQL 5.7, 2000 行表, EXPLAIN): `ou_dn = ?` 走 type=ref / rows=1
  --   (37 字符与 197 字符 DN 都是); 删掉本索引后同一条查询退化成 type=ALL /
  --   rows=1833 ⇒ 本索引**确实**服务完整值等值, 不能删。
  --   MSSQL 侧建不出等价索引 (NVARCHAR(1024)=2050B > 1700B 且无前缀索引),
  --   那边只能不要 —— 引擎能力差异导致的必然分歧, 见 mssql 基线同名注释。
  KEY ix_users_ou_dn          (ou_dn(191)),
  KEY ix_users_manager_sam    (manager_sam),  -- R158.36
  KEY idx_users_forest_dc     (forest_id, domain_name)  -- R158.38; 跟 MSSQL 同名同列
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== ad_groups_snapshot (R158.35) ====================
-- LDAP group snapshot for /api/admin/ad-groups?dc=X.
-- R158.X.116.c (2026-10-22) — dc_name 改名为 domain_name 并做 PK 第一键,
--   与真库 MSSQL + 代码 (sql.js MERGE ON (domain_name, name)) 三方对齐。
CREATE TABLE IF NOT EXISTS ad_groups_snapshot (
  domain_name          VARCHAR(128)  NOT NULL,
  name                 VARCHAR(256)  NOT NULL,
  sam_account_name     VARCHAR(256)  NULL,
  distinguished_name   VARCHAR(1024) NOT NULL,
  group_type           INT           NULL,
  group_scope          VARCHAR(16)   NULL,
  description          VARCHAR(2048) NULL,
  member_count         INT           NULL,
  snapshot_at          DATETIME      NOT NULL,
  snapshot_run_id      BIGINT        NOT NULL,
  forest_id            BIGINT        NULL,   -- R158.38
  domain_id            BIGINT        NULL,   -- R158.38
  PRIMARY KEY (domain_name, name),
  KEY ix_groups_snapshot_at (snapshot_at),
  KEY idx_groups_forest_dc (forest_id, domain_name)  -- R158.38; 跟 MSSQL 同名同列
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== ad_ous_snapshot (R158.35) ====================
-- LDAP OU tree snapshot for /api/admin/ad-ous?dc=X. Frontend reconstructs
-- the tree from parent_dn.
-- R158.X.116.c (2026-10-22) — dc_name 改名为 domain_name 并做 PK 第一键。
-- R161.3 (2026-10-25) — 代理主键 + DB 生成哈希唯一键.
--   旧定义 PRIMARY KEY (domain_name, distinguished_name) = (128*4+2) + (1024*4+2)
--   = 4612 字节 > InnoDB 上限 3072 ⇒ 全新库建表当场 errno 1071
--   "Specified key was too long; max key length is 3072 bytes".
--   上限按**声明宽度**算, 与库里有多少行无关 ⇒ 0 行也炸。
--   改法 (应用层零改动):
--     - 代理主键 id 承担"行标识", 唯一性交给 (domain_name, distinguished_name_hash)
--     - distinguished_name_hash 由 DB 侧生成 (SHA-256 ⇒ 32 字节), 应用不写它
--     - 应用 INSERT 全是显式列清单 (sql.js upsertOu) ⇒ id / 生成列不参与 INSERT
--     - ON DUPLICATE KEY UPDATE 命中该唯一键 ⇒ 原地更新, 不新增行
--     - 唯一性是**精确**的 (整串 DN 的哈希), 不是前缀近似 ⇒ 无截断、无误判
--   为什么不截断 DN 列宽: DN 上限 1023 字符 (AD), 收窄会丢数据; 而且 MSSQL 侧
--   MERGE 源用 CAST(? AS NVARCHAR(1024)), 收窄目标列会触发 T-SQL 8152 截断错。
CREATE TABLE IF NOT EXISTS ad_ous_snapshot (
  id                  BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
  domain_name         VARCHAR(128)  NOT NULL,
  distinguished_name  VARCHAR(1024) NOT NULL,
  name                VARCHAR(256)  NOT NULL,
  description         VARCHAR(2048) NULL,
  when_created        DATETIME      NULL,
  when_changed        DATETIME      NULL,
  parent_dn           VARCHAR(1024) NULL,
  snapshot_at         DATETIME      NOT NULL,
  snapshot_run_id     BIGINT        NOT NULL,
  forest_id           BIGINT        NULL,   -- R158.38
  domain_id           BIGINT        NULL,   -- R158.38
  distinguished_name_hash BINARY(32)
    GENERATED ALWAYS AS (UNHEX(SHA2(distinguished_name, 256))) STORED,
  UNIQUE KEY uq_ous_dn (domain_name, distinguished_name_hash),
  -- parent_dn 是长 DN (声明 1024) ⇒ 整列进索引 = 4098 字节 > 3072.
  -- MySQL 支持**前缀索引**: (191) ⇒ 766 字节, 且 ou_dn 的等值查询
  -- (routes/admin.js 的 OU 子树过滤) 依然能走索引 + recheck 精确比较.
  -- MSSQL 无前缀索引 ⇒ 那一侧只能删掉这个索引 (见 mssql 基线同名注释)。
  -- 注: parent_dn 本身从不出现在任何 WHERE 谓词里 (OU 树是前端拿全量结果
  -- 在浏览器里按 parent_dn 重建的), 所以本索引实际用不上; 保留它是为了让
  -- 双方言索引集合的差异只来自"引擎能力"这一个原因, 便于对账。
  KEY ix_ous_parent_dn   (parent_dn(191)),
  KEY ix_ous_snapshot_at (snapshot_at),
  KEY idx_ous_forest_dc  (forest_id, domain_name)  -- R158.38; 跟 MSSQL 同名同列
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== ad_directory_sync_runs (R158.35) ====================
-- One row per LDAP sync attempt (manual trigger + cron tick). Used by
-- /api/admin/directory-sync/runs and nextRunEstimate calculation.
CREATE TABLE IF NOT EXISTS ad_directory_sync_runs (
  id              BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
  dc_name         VARCHAR(128)  NOT NULL,
  started_at      DATETIME      NOT NULL,
  finished_at     DATETIME      NULL,
  status          VARCHAR(16)   NOT NULL DEFAULT 'running',
  user_count      INT           NULL,
  group_count     INT           NULL,
  ou_count        INT           NULL,
  error_message   VARCHAR(2000) NULL,
  triggered_by    VARCHAR(16)   NOT NULL DEFAULT 'manual',
  forest_id      BIGINT        NULL,   -- R158.38 (2026-10-03) — 来自 binding 的 forest, NULL = 老 R158.35 row / fallback 路径
  domain_id      BIGINT        NULL,   -- R158.38 — 来自 binding 的 domain, NULL = 同上
  KEY ix_sync_runs_started    (started_at),
  KEY ix_sync_runs_dc_status  (dc_name, status),
  KEY ix_sync_runs_forest_started (forest_id, started_at)  -- R158.38
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- R158.37 — AD Forest Registry. 后台多森林管理的物理表.
-- bind_password = AES-256-GCM 密文 (ad-credential-vault.js 加解密); is_default 为 BIT (0/1) — 该默认 forest 贯穿事务内: 先清零再置 1. 升级路径: system_config 的 ad_bind_* 保留为 fallback, R158.38 切到新的 ad_forest.
CREATE TABLE IF NOT EXISTS ad_forest (
  id              BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  forest_name     VARCHAR(128) NOT NULL UNIQUE,
  root_dn         VARCHAR(512) NOT NULL,
  ad_url          VARCHAR(512) NOT NULL,
  bind_dn         VARCHAR(512) NOT NULL,
  bind_password   VARBINARY(1024) NOT NULL,
  description     VARCHAR(512) NULL,
  is_default      TINYINT(1)   NOT NULL DEFAULT 0,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ad_forest_domain (
  id                BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  forest_id         BIGINT       NOT NULL,
  domain_dn         VARCHAR(512) NOT NULL,
  domain_name       VARCHAR(128) NOT NULL,
  role              VARCHAR(32)  NOT NULL,   -- 'root' | 'child' | 'external_trust'
  trust_direction   VARCHAR(16)  NULL,       -- 'bidirectional' | 'inbound' | 'outbound'
  dc_hostname       VARCHAR(256) NULL,
  is_pdc            TINYINT(1)   NOT NULL DEFAULT 0,
  sync_enabled      TINYINT(1)   NOT NULL DEFAULT 1,    -- R158.39 (2026-10-03) per-domain LDAP auto-sync switch
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_forest_domain (forest_id, domain_dn),
  KEY ix_forest_domain_forest (forest_id),
  CONSTRAINT fk_forest_domain_forest FOREIGN KEY (forest_id) REFERENCES ad_forest (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ad_forest_dc_assignment (
  id              BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  forest_id       BIGINT       NOT NULL,
  domain_id       BIGINT       NOT NULL,
  dc_hostname     VARCHAR(256) NOT NULL,
  site_id         BIGINT       NULL,
  assigned_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_forest_dc_hostname (dc_hostname),
  KEY ix_forest_dc_forest (forest_id),
  KEY ix_forest_dc_domain (domain_id),
  CONSTRAINT fk_forest_dc_forest FOREIGN KEY (forest_id) REFERENCES ad_forest (id) ON DELETE CASCADE,
  CONSTRAINT fk_forest_dc_domain FOREIGN KEY (domain_id) REFERENCES ad_forest_domain (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ad_forest_setting (
  id              BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  forest_id       BIGINT       NOT NULL,
  setting_key     VARCHAR(128) NOT NULL,
  setting_value   VARCHAR(2048) NULL,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_forest_setting (forest_id, setting_key),
  KEY ix_forest_setting_forest (forest_id),
  CONSTRAINT fk_forest_setting_forest FOREIGN KEY (forest_id) REFERENCES ad_forest (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- R158.38.3 (2026-10-03) — 域级同步设置表 ad_forest_domain_setting.
-- operator: 在森林里某森林要有某森林域级的同步设置。 — 粒 (子域 /
-- 信任域) 也都要能挂自己的设置 (pwd_min_length / sync_interval / etc.).
-- 独立表 (决策 B), 不复用 ad_forest_setting:
--   1. FK 干净 (有 FK → ad_forest_domain ON DELETE CASCADE).
--   2. UNIQUE 干净 ((domain_id, setting_key) 单表约束).
-- 升级路径: IF NOT EXISTS 包裹, 老环境直接跳过。
-- 鍗囩骇璺緞: IF NOT EXISTS 鍖呰９, 鑰佺幆澧冪洿鎺ヨ烦杩?
CREATE TABLE IF NOT EXISTS ad_forest_domain_setting (
  id              BIGINT        NOT NULL AUTO_INCREMENT PRIMARY KEY,
  domain_id       BIGINT        NOT NULL,
  setting_key     VARCHAR(128)  NOT NULL,
  setting_value   VARCHAR(2048) NULL,
  updated_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_forest_domain_setting (domain_id, setting_key),
  KEY ix_forest_domain_setting_domain (domain_id),
  CONSTRAINT fk_forest_domain_setting_domain FOREIGN KEY (domain_id) REFERENCES ad_forest_domain (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- R158.38.2 (2026-10-03) — 不再把 ad_centre_binding 单行表 作为 中心 LDAP sync
-- 直接读 ad_forest.is_default=1 那行 + 遍历 ad_forest_domain。 绑定语义 — 完全留给 R158.39 (DC→domain 绑定表, AD 域控清单页).
-- 鐩存帴璇?ad_forest.is_default=1 妫灄 + 閬嶅巻 ad_forest_domain. 銆岀粦瀹氥€嶈涔?-- 瀹屽叏鐣欑粰 R158.39 (DC鈫攄omain 缁戝畾鍦?AD 鍩熸帶娓呭崟椤?.

-- ============================================================================
-- R158.51 baseline freeze (2026-10-08) — additional DDL for migrations
-- 029 / 032 / 040 / 045 / 054 / 055 / 056 / 034-038 / 041-044 not absorbed
-- into db/schema/01-tables.sql. After this file is created, 001-056
-- incremental migrations are DELETED; future DDL changes go through a new
-- 1.0.x-baseline.sql version.
-- ============================================================================

-- ==================== ad_admin_commands.task_id (m054) ====================
-- R161.4 (2026-10-25) — 幂等守卫 (实测驱动, 非风格偏好)。
--   MySQL 5.7/8.0 **没有** ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
--   (那是 MariaDB 语法, 真库实测 errno 1064 ER_PARSE_ERROR), 所以 DDL 层面
--   写不出幂等语句 —— 只能查系统表再决定要不要执行。
--   模式与本文件既有块完全一致 (INFORMATION_SCHEMA 探针 + PREPARE/EXECUTE),
--   见 db/migrations/README.md authoring rule #3。
--   语义: 目标对象已存在 ⇒ 目标状态已达成 ⇒ 跳过 (与 CREATE TABLE IF NOT EXISTS 同义)。
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_admin_commands' AND COLUMN_NAME = 'task_id') = 0,
  'ALTER TABLE ad_admin_commands ADD COLUMN task_id VARCHAR(64) NULL',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_admin_commands' AND INDEX_NAME = 'ux_ad_admin_commands_task_id') = 0,
  'CREATE UNIQUE INDEX ux_ad_admin_commands_task_id ON ad_admin_commands(task_id)',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_admin_commands' AND INDEX_NAME = 'ix_ad_admin_commands_dc_task') = 0,
  'CREATE INDEX ix_ad_admin_commands_dc_task ON ad_admin_commands(target_dc, task_id)',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ==================== ad_agent_heartbeat.client_settings_version (m040) =====
-- R161.4 (2026-10-25) — 幂等守卫, 模式同上一块 (INFORMATION_SCHEMA + PREPARE/EXECUTE)。
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_agent_heartbeat' AND COLUMN_NAME = 'client_settings_version') = 0,
  'ALTER TABLE ad_agent_heartbeat ADD COLUMN client_settings_version INT NOT NULL DEFAULT 0 AFTER agent_token_version',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ==================== ad_agent_heartbeat.heartbeat_interval_seconds (m045) =
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_agent_heartbeat' AND COLUMN_NAME = 'heartbeat_interval_seconds') = 0,
  'ALTER TABLE ad_agent_heartbeat ADD COLUMN heartbeat_interval_seconds INT NULL DEFAULT NULL AFTER client_settings_version',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ==================== ad_agent_heartbeat.last_upgrade_event (m056) =========
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_agent_heartbeat' AND COLUMN_NAME = 'last_upgrade_event') = 0,
  'ALTER TABLE ad_agent_heartbeat ADD COLUMN last_upgrade_event JSON NULL',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ==================== ad_lockout_events.display_name (m029 + m046) ==========
-- R161.4 (2026-10-25) — 这一对 ADD + CHANGE 是**同一个改名动作的两半**,
--   所以守卫必须是**成对的双条件**, 不能各管各的:
--     ADD   : 旧名 target_user_description 不存在 **且** 新名 target_user_display_name 也不存在
--     CHANGE: 旧名存在 **且** 新名不存在
--   只判"目标列不存在"是不够的 —— 重跑时旧名已被上一轮改名掉(不存在了),
--   若 ADD 照加, 库里就会多出一个 target_user_description 冗余列, 而 CHANGE
--   又因新名已存在报 1060。加了"新名也不存在"这一条, 重跑时两块都变 no-op。
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_lockout_events' AND COLUMN_NAME = 'target_user_description') = 0
  AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_lockout_events' AND COLUMN_NAME = 'target_user_display_name') = 0,
  'ALTER TABLE ad_lockout_events ADD COLUMN target_user_description VARCHAR(512) NULL AFTER target_user_name',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
-- R161.3 (2026-10-25): RENAME COLUMN 是 MySQL 8.0-only (5.7 报 errno 1064)。
--   5.7 的等价写法是 CHANGE COLUMN, 且必须把完整列定义重写一遍 (含类型/可空/
--   DEFAULT) —— 这里跟上面 ADD COLUMN 的定义保持逐字一致。
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_lockout_events' AND COLUMN_NAME = 'target_user_description') = 1
  AND (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_lockout_events' AND COLUMN_NAME = 'target_user_display_name') = 0,
  'ALTER TABLE ad_lockout_events CHANGE COLUMN target_user_description target_user_display_name VARCHAR(512) NULL',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ==================== package_runs.script_version (m032) ===================
-- R161.4 (2026-10-25) — 幂等守卫 (见上方 R161.4 说明块)。
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'package_runs' AND COLUMN_NAME = 'script_version') = 0,
  'ALTER TABLE package_runs ADD COLUMN script_version VARCHAR(32) NULL',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ==================== package_runs R158.47.3/R158.72.x/R158.X.99.20 cols ============
-- 1:1 mirrors the MSSQL baseline 14-col declaration (db/migrations/mssql/1.0.0-baseline.sql:1815-1831).
-- MySQL 8 has no ADD COLUMN IF NOT EXISTS; dynamic SQL guard via INFORMATION_SCHEMA.COLUMNS +
-- PREPARE/EXECUTE makes the block idempotent across fresh install, existing install, and
-- bootstrap re-run. Pattern follows db/migrations/README.md authoring rule #3.
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'package_runs' AND COLUMN_NAME = 'status') = 0,
  'ALTER TABLE package_runs ADD COLUMN status VARCHAR(32) NULL AFTER script_version',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'package_runs' AND COLUMN_NAME = 'jitter_at') = 0,
  'ALTER TABLE package_runs ADD COLUMN jitter_at DATETIME NULL AFTER status',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'package_runs' AND COLUMN_NAME = 'trigger_once') = 0,
  'ALTER TABLE package_runs ADD COLUMN trigger_once TINYINT(1) NULL AFTER jitter_at',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'package_runs' AND COLUMN_NAME = 'cron_expr') = 0,
  'ALTER TABLE package_runs ADD COLUMN cron_expr VARCHAR(64) NULL AFTER trigger_once',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'package_runs' AND COLUMN_NAME = 'target_agents') = 0,
  'ALTER TABLE package_runs ADD COLUMN target_agents TEXT NULL AFTER cron_expr',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ==================== ad_admin_members (m055) ==============================
CREATE TABLE IF NOT EXISTS ad_admin_members (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  domain_dn       VARCHAR(1024) NOT NULL,
  group_name      VARCHAR(64)   NOT NULL,
  member_sam      VARCHAR(256)  NOT NULL,
  member_dn       VARCHAR(1024) NULL,
  member_enabled  TINYINT(1)    NULL,
  collected_at    DATETIME      NOT NULL,
  dc_name         VARCHAR(128)  NOT NULL,
  run_id          BIGINT        NULL,
  -- R161.3 (2026-10-25) — 唯一键改用 DB 生成哈希列.
  --   旧定义 UNIQUE KEY uq_admin_member (domain_dn(255), group_name, member_sam)
  --   用**前缀** unique ⇒ 唯一性只到前 255 个字符, 后面被截断的差异看不见
  --   (同前缀的两行会被判成重复)。而且 MSSQL 侧根本没有前缀索引, 两边言
  --   语义对不齐。改成哈希唯一键后:
  --     - 唯一性精确 (整串 domain_dn 的 SHA-256)
  --     - 两边言同构 (MSSQL 用 PERSISTED 计算列, 见 mssql 基线)
  --     - 应用层零改动 (INSERT 显式列清单, 不写生成列)
  domain_dn_hash BINARY(32)
    GENERATED ALWAYS AS (UNHEX(SHA2(domain_dn, 256))) STORED,
  UNIQUE KEY uq_admin_member (domain_dn_hash, group_name, member_sam),
  -- ix_admin_members_domain_dn 已删 (R161.3): 整列进索引 = 4098 字节 > 3072,
  -- 而它对查询没用 —— 唯一用到 domain_dn 的地方是 adminMembers.summary() 的
  -- 相关子查询 `m2.domain_dn = m.domain_dn AND m2.group_name = m.group_name`,
  -- 而 group_name 那一侧本来就有 ix_admin_members_group 覆盖 (group_name 只有
  -- 'Domain Admins' / 'Enterprise Admins' 两个值, 过滤性远高于 domain_dn)。
  KEY ix_admin_members_group      (group_name),
  KEY ix_admin_members_collected  (collected_at),
  KEY ix_admin_members_run        (run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- R158.X.116.d (2026-10-22) — 移除 ad_dc_probe_outbound (m034 引入)。
--   表已由 migration 038 DROP (R156.5 操作员 directive「复制伙伴端口主动探测
--   不需要哦去掉」), 但本 baseline 仍留着建表语句 —— 新装会建出一张永远
--   没写入的空表。死的依据:
--     · 写路径 SQL helper 已删 (sql.js 两侧)
--     · 服务层 helper 已删 (partner-port-probe.js 的 upsertOutboundProbe[s])
--     · runner 门控已删 (runner.js); 且即便未删也永不为真 ——
--       package_scripts 里该包名 0 行 (实测 2026-10-22, 同族活包
--       ad_dc_probe_inbound 1 行 v1.0.2), 上方 packageScripts.get 前置门
--       直接 continue
--     · 读取端点已删 (dashboard.js 的 partner-port-health/probe-outbound)
--   探针包脚本已归档 .backups/packages-ad_dc_probe_outbound-20261022/。

-- ==================== ad_dc_partners_warehouse (m035) =====================
CREATE TABLE IF NOT EXISTS ad_dc_inbound_partners (
  id                  BIGINT        NOT NULL AUTO_INCREMENT,
  local_dc            VARCHAR(128)  NOT NULL,
  peer_dc             VARCHAR(128)  NOT NULL,
  naming_context      VARCHAR(128)  NOT NULL,
  status_code         TINYINT       NOT NULL DEFAULT 0,
  last_success_time   DATETIME(3)   NULL,
  last_attempt_time   DATETIME(3)   NOT NULL,
  error_message       VARCHAR(2048) NULL,
  refreshed_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                   ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_inbound_partner (local_dc, peer_dc, naming_context),
  KEY ix_inbound_partner_local_dc (local_dc),
  KEY ix_inbound_partner_peer_dc (peer_dc),
  KEY ix_inbound_partner_naming_context (naming_context),
  KEY ix_inbound_partner_refreshed_at (refreshed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ad_dc_outbound_partners (
  id                  BIGINT        NOT NULL AUTO_INCREMENT,
  local_dc            VARCHAR(128)  NOT NULL,
  peer_dc             VARCHAR(128)  NOT NULL,
  naming_context      VARCHAR(128)  NOT NULL,
  status_code         TINYINT       NOT NULL DEFAULT 0,
  last_success_time   DATETIME(3)   NULL,
  last_attempt_time   DATETIME(3)   NOT NULL,
  error_message       VARCHAR(2048) NULL,
  refreshed_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                   ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_outbound_partner (local_dc, peer_dc, naming_context),
  KEY ix_outbound_partner_local_dc (local_dc),
  KEY ix_outbound_partner_peer_dc (peer_dc),
  KEY ix_outbound_partner_naming_context (naming_context),
  KEY ix_outbound_partner_refreshed_at (refreshed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== ad_partner_inbound (m036)
CREATE TABLE IF NOT EXISTS ad_partner_inbound (
  id              BIGINT       NOT NULL AUTO_INCREMENT,
  collected_at    DATETIME(3)  NOT NULL,
  agent_id        VARCHAR(64)  NOT NULL,
  source_dc       VARCHAR(128) NOT NULL,
  dest_dc         VARCHAR(128) NOT NULL,
  discovered_at   DATETIME(3)  NOT NULL,
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_partner_inbound_pair (source_dc, dest_dc)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- R161.4 (2026-10-25) — 幂等守卫 (INFORMATION_SCHEMA.STATISTICS 探针)。
--   语义: 同名索引已存在 ⇒ 目标状态已达成 ⇒ 跳过 (MySQL 无 CREATE INDEX IF NOT EXISTS)。
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_partner_inbound' AND INDEX_NAME = 'ix_partner_inbound_collected_at') = 0,
  'CREATE INDEX ix_partner_inbound_collected_at ON ad_partner_inbound (collected_at)',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_partner_inbound' AND INDEX_NAME = 'ix_partner_inbound_dest_dc') = 0,
  'CREATE INDEX ix_partner_inbound_dest_dc ON ad_partner_inbound (dest_dc)',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_partner_inbound' AND INDEX_NAME = 'ix_partner_inbound_agent_id') = 0,
  'CREATE INDEX ix_partner_inbound_agent_id ON ad_partner_inbound (agent_id)',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- R158.X.116.e (2026-10-22) — 删 ad_partner_outbound 建表 (原 m037)。
--   R158.10 (2026-10-01) 是**刻意保留结构**以备回滚:
--     upsertPartnerOutbound SQL helper 两方言均已删, BUILTIN 条目
--     ad_partner_outbound_discover 已下线, cron row 不再 UPSERT。
--   实测 2026-10-22 真库确认: 表根本不存在 (MSSQL baseline 也从未建过),
--   即"保留以备回滚"从未真正落地 —— 这是纸面上的回滚能力, 不是现实。
--   反向能力仍在: 表结构完整记录在本文件 git 历史里, 重建只需 9 行 DDL。
--   死代码路径见 src/services/partner-discover.js:99-101 的 else 分支
--   (该分支因 BUILTIN 条目已移除而不可达, 属防御性死分支)。

-- ==================== replication_inbound view DROP + probe_outbound DROP (m038)
DROP VIEW IF EXISTS replication_inbound;
DROP TABLE IF EXISTS ad_dc_probe_outbound;

-- ==================== v_partner_inbound view (m041 final version = m044) ===
DROP VIEW IF EXISTS v_partner_inbound;
CREATE VIEW v_partner_inbound AS
SELECT
  i.dest_dc        AS target_dc,
  i.source_dc      AS peer_dc,
  i.collected_at   AS collected_at,
  i.discovered_at  AS discovered_at,
  i.agent_id       AS reporter_agent_id,
  d.site_id        AS target_site_id,
  d.is_bridgehead  AS target_is_bridgehead,
  s.site_name      AS target_site_name,
  pd.site_id       AS peer_site_id,
  ps.site_name     AS peer_site_name,
  ps.is_hub        AS peer_site_is_hub,
  (SELECT CASE
       WHEN MAX(CASE WHEN h.status_code = 2 THEN 1 ELSE 0 END) = 1 THEN 'error'
       WHEN MAX(CASE WHEN h.status_code = 0 THEN 1 ELSE 0 END) = 1 THEN 'success'
       ELSE 'partial' END
   FROM ad_replication_probe_history h
   WHERE h.source_dc = i.dest_dc AND h.dest_dc = i.source_dc
     AND h.attempt_at >= UTC_TIMESTAMP() - INTERVAL 15 MINUTE
  ) AS probe_state,
  (SELECT MAX(h.attempt_at) FROM ad_replication_probe_history h
   WHERE h.source_dc = i.dest_dc AND h.dest_dc = i.source_dc
     AND h.attempt_at >= UTC_TIMESTAMP() - INTERVAL 15 MINUTE
  ) AS probe_attempt_at,
  -- R161.3 (2026-10-25): 这两个标量子查询原来写成
  --   (SELECT h.xxx FROM ad_replication_probe_history h
  --     INNER JOIN (SELECT source_dc, dest_dc, MAX(attempt_at) AS mx
  --                 FROM ad_replication_probe_history
  --                 WHERE source_dc = i.dest_dc AND dest_dc = i.source_dc ...
  --                 GROUP BY source_dc, dest_dc) m ON ...)   ← 相关派生表
  --   派生表里引用了外层的 i.dest_dc / i.source_dc ⇒ 这是 LATERAL 语义,
  --   MySQL 8.0.14+ 才支持, 5.7 直接 errno 1054 "Unknown column 'i.dest_dc'"。
  --   改写成跟 MSSQL 基线**逐字等价**的标量子查询 (TOP 1 ... ORDER BY
  --   status_code DESC, attempt_at DESC  ⇔ LIMIT 1 + 同样的 ORDER BY),
  --   5.7 与 8.0 都能建, 语义也与生产 (MSSQL) 一致。
  (SELECT h.duration_ms FROM ad_replication_probe_history h
   WHERE h.source_dc = i.dest_dc AND h.dest_dc = i.source_dc
     AND h.attempt_at >= UTC_TIMESTAMP() - INTERVAL 15 MINUTE
   ORDER BY h.status_code DESC, h.attempt_at DESC LIMIT 1
  ) AS probe_duration_ms,
  (SELECT h.error_message FROM ad_replication_probe_history h
   WHERE h.source_dc = i.dest_dc AND h.dest_dc = i.source_dc
     AND h.attempt_at >= UTC_TIMESTAMP() - INTERVAL 15 MINUTE
   ORDER BY h.status_code DESC, h.attempt_at DESC LIMIT 1
  ) AS probe_error_message
FROM ad_partner_inbound i
INNER JOIN ad_dcs d     ON d.dc_name = i.dest_dc
LEFT  JOIN ad_sites s   ON s.site_id = d.site_id
LEFT  JOIN ad_dcs pd    ON pd.dc_name = i.source_dc
LEFT  JOIN ad_sites ps  ON ps.site_id = pd.site_id
WHERE i.source_dc <> i.dest_dc
  AND i.collected_at >= UTC_TIMESTAMP() - INTERVAL 30 DAY;


-- ==================== seed data (db/schema/02-seed-roles.sql) ==============
-- Seed default roles (idempotent via INSERT IGNORE)
INSERT IGNORE INTO sys_roles (role_name) VALUES
  ('admin'),
  ('operator'),
  ('viewer');

-- Seed default role permissions (one row per granted permission).
-- Subqueries resolve role_id from the just-inserted role_name rows above.
INSERT IGNORE INTO role_permissions (role_id, permission) VALUES
  ((SELECT id FROM sys_roles WHERE role_name = 'admin'),    '*'),
  ((SELECT id FROM sys_roles WHERE role_name = 'operator'), 'read:dash'),
  ((SELECT id FROM sys_roles WHERE role_name = 'operator'), 'execute:sync'),
  ((SELECT id FROM sys_roles WHERE role_name = 'viewer'),   'read:dash');

-- Seed default system config (idempotent via INSERT IGNORE)
-- These defaults are read at runtime before any user interaction, so a
-- fresh install has working defaults even before runtime seed functions
-- (seedSmtpDefaultsIfMissing, seedAgentTokenIfMissing, seedJwtSecretIfMissing,
--  seedListenPortIfMissing) fire. Runtime seeds still run idempotently on
-- startup; the SQL seed here just makes the row present from t=0 and is
-- the documented source of truth for baseline defaults.
-- ⚠ 2026-10-23 移除 'ad_agent_token' seed。
--   该键已废弃: services/config.js:245 把它列入 AGENT_TOKEN_BLOCKED_KEYS,
--   写入走 PUT /api/admin/config 会被拒 (400), 提示改用 /api/admin/agent-token/rotate。
--   运行时真源是 'agent_token_current' (services/config.js:579 getAgentConfig 读
--   all.agent_token), 由 I3 dual-key rotation 流程维护, 不该由 baseline seed 出来。
--   留着它会让新装机的 ConfigView 显示一行"可配置"但实际改了不生效的项 ——
--   正是 #167 I1 Option B 要消除的 dead-UI surface。
INSERT IGNORE INTO system_config (config_key, config_value, description) VALUES
  ('polling_interval_minutes', '15',   'Agent collection interval in minutes'),
  ('latency_threshold_minutes','180',  'Replication latency warning threshold'),
  ('history_enabled',          '0',    'Append to ad_replication_history (0/1)'),
('heartbeat_interval_seconds','30',  'Agent 心跳间隔 (秒), 越短越快感知离线, 默认 30'),
  -- Agent-side runtime defaults read by getAgentConfig() (services/config.js).
  -- Each has a code-side || fallback but seeding them in the DB makes the
  -- values visible/auditable via ConfigView and ensures the agent gets a
  -- stable config even if getAgentConfig's fallback chain regresses.
('discovery_interval_hours', '4',    'Agent 站点/域控拓扑发现周期 (小时)'),
('heartbeat_port',           '8081', 'Agent 心跳接收端口 (DB 改后 5 min 内 agent 自动刷新)'),
('report_port',              '8082', 'Agent replication snapshot 上报端口'),
('heartbeat_stale_seconds',  '15',   '心跳 stale 阈值 (秒),超过即判定 agent 离线'),
  -- UI-side: SiteReplicationMatrixView polls the dashboard at this cadence.
  -- Frontend falls back to 10s if the row is absent.
('site_matrix_refresh_seconds','10', '站点复制矩阵自动刷新间隔 (秒)'),
  -- I4 retention loop reads audit_retention_days on every tick (services/audit.js).
  -- Default 90 days; set to 0 to disable retention entirely.
('audit_retention_days',     '90',   '审计日志保留天数 (默认 90, 设 0 禁用清理)'),
  -- email tick 不发 SMTP. 启用改 '1'. 修改后下一次 alert eval (10s 周期) 才生效。
('email_enabled',            '0',    '邮件总开关 (0/1). 0=关闭: 不入 outbox + 不发 SMTP; 1=启用'),
  -- Client + agent access domain. Empty = fall back to server IP. ConfigView
  -- uses this for both the operator-facing "Agent 连接地址" display and
  -- client-app access URLs. See services/network.js getPrimaryIPv4() for
  -- the IP fallback path; admin.js GET /api/admin/config returns serverIp
  -- alongside the config so the frontend can render the resolved URL.
('access_domain',            '',     '客户端与 Agent 访问域名;留空则用服务器 IP');

-- ============================================================================
-- MySQL/MSSQL parity block (R158.X.99 dbparity audit)
-- 24 tables that the application writes to but which were absent from this
-- baseline. Column set mirrors db/migrations/mssql/1.0.0-baseline.sql.
-- Type mapping: NVARCHAR(n)->VARCHAR(n), NVARCHAR(MAX)->LONGTEXT,
--   DATETIME2->DATETIME(3), BIT->TINYINT(1), IDENTITY(1,1)->AUTO_INCREMENT,
--   sysutcdatetime()->CURRENT_TIMESTAMP(3).
-- MSSQL filtered indexes (WHERE sent_at IS NULL) have no MySQL equivalent and
-- are emitted as plain composite indexes.
-- ============================================================================

-- ==================== ad_feature_flags ====================
CREATE TABLE IF NOT EXISTS ad_feature_flags (
  `key` VARCHAR(64) NOT NULL,
  `value` VARCHAR(255) NULL,
  description VARCHAR(255) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_by VARCHAR(64) NULL,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== ad_system_registration ====================
CREATE TABLE IF NOT EXISTS ad_system_registration (
  id INT NOT NULL AUTO_INCREMENT,
  license_key VARCHAR(255) NOT NULL,
  license_hash VARCHAR(64) NOT NULL,
  activated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME NULL,
  instance_id VARCHAR(64) NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'active',
  notes LONGTEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  license_kind VARCHAR(16) NULL,
  license_request_id BIGINT NULL,
  request_json_path VARCHAR(512) NULL,
  -- R158.X.99-quota (2026-10-21) 节点配额, 与 MSSQL 同构。
  -- max_nodes = 申请单原始意图; max_nodes_allowed = ceil(max_nodes × 1.2)
  -- 的派生上限, activate 时算一次写死。存量老行恒 NULL = 不限额 = 原有行为。
  max_nodes INT NULL,
  max_nodes_allowed INT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY UQ_ad_system_registration_hash (license_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== report_fired_history (R158.X.116.b 补建) ====================
-- report-scheduler.js hydrateLastFiredFromDb (启动) + persistLastFiredToDb
-- (fire 后) 靠这张表跨重启记住每个 kind 的 last_fired, 是 R158.X.99.15
-- "catch-up 重启重复 fire" 的持久化载体。MySQL 分支的
-- INSERT ... ON DUPLICATE KEY UPDATE 依赖 PK(kind), MySQL 侧连表都没有 →
-- 该分支是死路, 且 hydrate 恒返空 = 每次 center 重启所有 enabled 报表
-- 必触发一次 catch-up 重复 fire。列定义与 MSSQL 对齐。
CREATE TABLE IF NOT EXISTS report_fired_history (
  kind VARCHAR(16) NOT NULL,
  last_fired_minute_key VARCHAR(32) NOT NULL,
  last_fired_at DATETIME(3) NOT NULL,
  PRIMARY KEY (kind),
  KEY ix_report_fired_history_last_fired_at (last_fired_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== ad_license_request (R158.X.116.b 补建) ====================
-- system-settings-v2.js 的 license 申请单端点 (insert/findById/markActivated/
-- listByInstance) 两方言都写这张表, 但 MySQL baseline 从未建过 →
-- insert 被 try/catch 兜住只 warn (元数据不落库), 另 3 个 helper 恒返空.
-- 列定义与 MSSQL 1.0.0-baseline.sql 的 ad_license_request 逐列对齐。
CREATE TABLE IF NOT EXISTS ad_license_request (
  id BIGINT NOT NULL AUTO_INCREMENT,
  request_id VARCHAR(128) NOT NULL,
  company VARCHAR(128) NOT NULL,
  mac_address VARCHAR(64) NOT NULL,
  months INT NOT NULL,
  max_nodes INT NOT NULL,
  installed_at VARCHAR(32) NULL,
  signature VARCHAR(64) NULL,
  instance_id VARCHAR(64) NOT NULL,
  kind VARCHAR(16) NOT NULL DEFAULT 'base32',
  json_path VARCHAR(512) NOT NULL,
  verified_at DATETIME(3) NULL,
  activated_at DATETIME(3) NULL,
  license_id BIGINT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_license_request_request_id (request_id),
  KEY ix_license_request_instance (instance_id, created_at DESC),
  KEY ix_license_request_kind (kind, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== report_email_outbox ====================
CREATE TABLE IF NOT EXISTS report_email_outbox (
  id BIGINT NOT NULL AUTO_INCREMENT,
  report_id BIGINT NOT NULL,
  kind VARCHAR(20) NOT NULL,
  to_addrs LONGTEXT NOT NULL,
  cc_addrs LONGTEXT NULL,
  subject VARCHAR(500) NOT NULL,
  body_text LONGTEXT NOT NULL,
  body_html LONGTEXT NULL,
  attempt_count INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  last_error LONGTEXT NULL,
  sent_at DATETIME NULL,
  next_attempt_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_reo_pending (next_attempt_at /* mssql filtered: WHERE sent_at IS NULL -> plain index */),
  KEY idx_reo_kind (kind, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== system_alerts ====================
CREATE TABLE IF NOT EXISTS system_alerts (
  id BIGINT NOT NULL AUTO_INCREMENT,
  kind VARCHAR(40) NOT NULL,
  scope_type VARCHAR(20) NOT NULL DEFAULT 'host',
  scope_ref VARCHAR(255) NULL,
  state VARCHAR(20) NOT NULL DEFAULT 'firing',
  threshold LONGTEXT NULL,
  detail LONGTEXT NULL,
  fired_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  recovered_at DATETIME NULL,
  acked_at DATETIME NULL,
  acked_by VARCHAR(64) NULL,
  last_notified_at DATETIME NULL,
  notify_count INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY ix_sa_kind_state (kind, state, fired_at DESC),
  KEY ix_sa_scope (scope_type, scope_ref, kind /* mssql filtered: WHERE state='firing' -> plain index */),
  KEY ix_sa_fired (fired_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== ad_account_change ====================
CREATE TABLE IF NOT EXISTS ad_account_change (
  sam VARCHAR(256) NOT NULL,
  display_name VARCHAR(255) NULL,
  action VARCHAR(16) NOT NULL,
  created_at DATETIME NULL,
  modified_at DATETIME NULL,
  change_date DATE NOT NULL,
  domain_dn VARCHAR(1024) NULL,
  dc_name VARCHAR(128) NOT NULL,
  collected_at DATETIME NOT NULL,
  operator_user VARCHAR(128) NULL,
  PRIMARY KEY (sam, action, change_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== ad_agent_upgrade_rollout ====================
CREATE TABLE IF NOT EXISTS ad_agent_upgrade_rollout (
  id BIGINT NOT NULL AUTO_INCREMENT,
  target_version VARCHAR(32) NOT NULL,
  from_version VARCHAR(32) NULL,
  strategy VARCHAR(16) NOT NULL,
  canary_ratio INT NULL,
  `status` VARCHAR(16) NOT NULL,
  created_by VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  activated_at DATETIME NULL,
  completed_at DATETIME NULL,
  aborted_at DATETIME NULL,
  notes VARCHAR(500) NULL,
  PRIMARY KEY (id),
  KEY ix_rollout_status_activated (`status`, activated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== ad_computers_snapshot ====================
CREATE TABLE IF NOT EXISTS ad_computers_snapshot (
  domain_name VARCHAR(128) NOT NULL,
  sam_account_name VARCHAR(256) NOT NULL,
  cn VARCHAR(256) NULL,
  name VARCHAR(256) NULL,
  distinguished_name VARCHAR(1024) NOT NULL,
  ou_dn VARCHAR(1024) NULL,
  enabled TINYINT(1) NULL,
  is_server TINYINT(1) NULL,
  operating_system VARCHAR(512) NULL,
  operating_system_version VARCHAR(128) NULL,
  dns_host_name VARCHAR(256) NULL,
  last_logon DATETIME NULL,
  when_created DATETIME NULL,
  when_changed DATETIME NULL,
  description VARCHAR(1024) NULL,
  managed_by_dn VARCHAR(256) NULL,
  managed_by_sam VARCHAR(256) NULL,
  snapshot_at DATETIME NOT NULL,
  snapshot_run_id BIGINT NOT NULL,
  forest_id BIGINT NULL,
  domain_id BIGINT NULL,
  PRIMARY KEY (domain_name, sam_account_name),
  KEY idx_computers_forest_dc (forest_id, domain_name),
  -- R161.3: 长 DN 前缀索引, 理由同 ad_users_snapshot.ix_users_ou_dn
  --   (实测 type=ref / rows=1; 删掉退化成 type=ALL / rows=1852)。
  KEY ix_computers_ou_dn (ou_dn(191)),
  KEY ix_computers_enabled (enabled),
  KEY ix_computers_is_server (is_server),
  KEY ix_computers_snapshot_at (snapshot_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== ad_failed_logon_events ====================
CREATE TABLE IF NOT EXISTS ad_failed_logon_events (
  id BIGINT NOT NULL AUTO_INCREMENT,
  occurred_at DATETIME NOT NULL,
  collected_at DATETIME NOT NULL,
  agent_id VARCHAR(256) NOT NULL,
  dc_name VARCHAR(256) NOT NULL,
  event_record_id BIGINT NOT NULL,
  target_user_name VARCHAR(256) NULL,
  target_user_display_name VARCHAR(256) NULL,
  target_domain_name VARCHAR(256) NULL,
  target_sid VARCHAR(256) NULL,
  subject_user_name VARCHAR(256) NULL,
  subject_domain_name VARCHAR(256) NULL,
  caller_computer_name VARCHAR(256) NULL,
  ip_address VARCHAR(64) NULL,
  ip_port VARCHAR(16) NULL,
  logon_type INT NULL,
  logon_process_name VARCHAR(64) NULL,
  auth_package_name VARCHAR(64) NULL,
  failure_reason VARCHAR(64) NULL,
  `status` VARCHAR(64) NULL,
  workstation_name VARCHAR(256) NULL,
  error_code INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_failed_logon_dc_record (dc_name, event_record_id),
  KEY ix_failed_logon_occurred_at (occurred_at),
  KEY ix_failed_logon_target_time (target_user_name, occurred_at),
  KEY ix_failed_logon_dc_time (dc_name, occurred_at),
  KEY ix_failed_logon_ip_time (ip_address, occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== ad_member_admin_groups ====================
CREATE TABLE IF NOT EXISTS ad_member_admin_groups (
  id BIGINT NOT NULL AUTO_INCREMENT,
  hostname VARCHAR(128) NOT NULL,
  group_name VARCHAR(64) NOT NULL,
  member_sid VARCHAR(128) NOT NULL,
  member_name VARCHAR(256) NULL,
  member_class VARCHAR(16) NULL,
  principal_source VARCHAR(16) NULL,
  is_enabled TINYINT(1) NULL,
  display_name VARCHAR(256) NULL,
  collected_at DATETIME NOT NULL,
  run_id BIGINT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_member_admin_group (hostname, group_name, member_sid),
  KEY idx_member_admin_hostname (hostname),
  KEY idx_member_admin_collected_at (collected_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== ad_member_heartbeat ====================
CREATE TABLE IF NOT EXISTS ad_member_heartbeat (
  hostname VARCHAR(128) NOT NULL,
  agent_id VARCHAR(64) NOT NULL,
  agent_type VARCHAR(16) NOT NULL DEFAULT 'non-ad',
  agent_version VARCHAR(32) NULL,
  last_heartbeat_at DATETIME NULL,
  last_report_at DATETIME NULL,
  last_report_status VARCHAR(32) NULL,
  pending_queue_size INT NOT NULL DEFAULT 0,
  heartbeat_interval_seconds INT NULL,
  report_requested_at DATETIME NULL,
  client_settings_version INT NOT NULL DEFAULT 0,
  agent_token_version INT NOT NULL DEFAULT 0,
  last_upgrade_event VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (hostname),
  KEY ix_ad_member_heartbeat_last_hb (last_heartbeat_at),
  CONSTRAINT fk_ad_member_heartbeat_host FOREIGN KEY (hostname) REFERENCES ad_member_servers(hostname) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== ad_member_server_ports ====================
CREATE TABLE IF NOT EXISTS ad_member_server_ports (
  hostname VARCHAR(128) NOT NULL,
  port INT NOT NULL,
  service_type VARCHAR(32) NOT NULL,
  note VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  probe_status VARCHAR(16) NULL,
  probe_latency_ms INT NULL,
  probe_at DATETIME NULL,
  PRIMARY KEY (hostname, port),
  CONSTRAINT fk_ad_member_server_ports_host FOREIGN KEY (hostname) REFERENCES ad_member_servers(hostname) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== ad_member_eventlog_events ====================
CREATE TABLE IF NOT EXISTS ad_member_eventlog_events (
  collected_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  agent_id VARCHAR(64) NOT NULL,
  hostname VARCHAR(128) NOT NULL,
  channel VARCHAR(32) NOT NULL,
  severity VARCHAR(16) NOT NULL,
  event_id INT NOT NULL,
  record_id BIGINT NOT NULL,
  message VARCHAR(4000) NULL,
  ts DATETIME NOT NULL,
  audit_failure TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (hostname, channel, record_id),
  KEY ix_ad_member_eventlog_events_host_channel_ts (hostname, channel, ts DESC),
  KEY ix_ad_member_eventlog_events_collected_at (collected_at),
  CONSTRAINT fk_ad_member_eventlog_events_host FOREIGN KEY (hostname) REFERENCES ad_member_servers(hostname) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== ad_member_eventlog_summary ====================
CREATE TABLE IF NOT EXISTS ad_member_eventlog_summary (
  collected_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  agent_id VARCHAR(64) NOT NULL,
  hostname VARCHAR(128) NOT NULL,
  channel VARCHAR(32) NOT NULL,
  warning_count INT NOT NULL DEFAULT 0,
  error_count INT NOT NULL DEFAULT 0,
  audit_failure_count INT NOT NULL DEFAULT 0,
  dropped_count INT NOT NULL DEFAULT 0,
  PRIMARY KEY (hostname, channel, collected_at),
  KEY ix_ad_member_eventlog_summary_collected_at (collected_at),
  KEY ix_ad_member_eventlog_summary_host_collected (hostname, collected_at DESC),
  CONSTRAINT fk_ad_member_eventlog_summary_host FOREIGN KEY (hostname) REFERENCES ad_member_servers(hostname) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== ad_member_os_baseline ====================
CREATE TABLE IF NOT EXISTS ad_member_os_baseline (
  collected_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  agent_id VARCHAR(64) NOT NULL,
  hostname VARCHAR(128) NOT NULL,
  cpu_pct FLOAT NULL,
  memory_pct FLOAT NULL,
  c_used_pct FLOAT NULL,
  disk_free_bytes BIGINT NULL,
  services_count INT NOT NULL DEFAULT 0,
  disk_free LONGTEXT NULL,
  disk_total LONGTEXT NULL,
  disks LONGTEXT NULL,
  services LONGTEXT NULL,
  events LONGTEXT NULL,
  bios_info LONGTEXT NULL,
  cpu_brand VARCHAR(128) NULL,
  mem_total_bytes BIGINT NULL,
  system_info LONGTEXT NULL,
  network_info LONGTEXT NULL,
  memory_modules LONGTEXT NULL,
  motherboard LONGTEXT NULL,
  cpu LONGTEXT NULL,
  ips LONGTEXT NULL,
  PRIMARY KEY (hostname, collected_at),
  KEY ix_ad_member_os_baseline_host_collected (hostname, collected_at DESC),
  KEY ix_ad_member_os_baseline_collected_at (collected_at),
  CONSTRAINT fk_ad_member_os_baseline_host FOREIGN KEY (hostname) REFERENCES ad_member_servers(hostname) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== ad_member_os_baseline_latest ====================
CREATE TABLE IF NOT EXISTS ad_member_os_baseline_latest (
  collected_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  agent_id VARCHAR(64) NOT NULL,
  hostname VARCHAR(128) NOT NULL,
  cpu_pct FLOAT NULL,
  memory_pct FLOAT NULL,
  c_used_pct FLOAT NULL,
  disk_free_bytes BIGINT NULL,
  services_count INT NOT NULL DEFAULT 0,
  disk_free LONGTEXT NULL,
  disk_total LONGTEXT NULL,
  disks LONGTEXT NULL,
  services LONGTEXT NULL,
  events LONGTEXT NULL,
  bios_info LONGTEXT NULL,
  cpu_brand VARCHAR(128) NULL,
  mem_total_bytes BIGINT NULL,
  system_info LONGTEXT NULL,
  network_info LONGTEXT NULL,
  memory_modules LONGTEXT NULL,
  motherboard LONGTEXT NULL,
  cpu LONGTEXT NULL,
  ips LONGTEXT NULL,
  PRIMARY KEY (hostname),
  KEY ix_ad_member_os_baseline_latest_collected_at (collected_at),
  CONSTRAINT fk_ad_member_os_baseline_latest_host FOREIGN KEY (hostname) REFERENCES ad_member_servers(hostname) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== ad_notify_outbox ====================
CREATE TABLE IF NOT EXISTS ad_notify_outbox (
  id INT NOT NULL AUTO_INCREMENT,
  ad_command_id INT NULL,
  to_addrs VARCHAR(1024) NOT NULL,
  cc_addrs VARCHAR(1024) NULL,
  subject VARCHAR(512) NOT NULL,
  body_text LONGTEXT NOT NULL,
  body_html LONGTEXT NOT NULL,
  attempt_count INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  last_error VARCHAR(2048) NULL,
  sent_at DATETIME NULL,
  next_attempt_at DATETIME NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_ad_notify_outbox_pending (next_attempt_at, id /* mssql filtered: WHERE sent_at IS NULL -> plain index */),
  KEY idx_ad_notify_outbox_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== ad_replication_active_errors ====================
CREATE TABLE IF NOT EXISTS ad_replication_active_errors (
  id INT NOT NULL AUTO_INCREMENT,
  source_dc VARCHAR(128) NOT NULL,
  dest_dc VARCHAR(128) NOT NULL,
  naming_context VARCHAR(128) NOT NULL,
  status_code TINYINT NOT NULL,
  last_attempt_time DATETIME NOT NULL,
  first_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_reported_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  reported_count INT NOT NULL DEFAULT 1,
  last_error_message VARCHAR(2048) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_active_error (source_dc, dest_dc, naming_context),
  KEY ix_active_error_attempt (last_attempt_time DESC),
  KEY ix_active_error_pair (source_dc, dest_dc, naming_context)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== ad_user_group_memberships ====================
-- R161.3 (2026-10-25) — 代理主键 + DB 生成哈希唯一键.
--   旧定义 PRIMARY KEY (domain_name, user_sam, group_dn) = 514 + 1026 + 4098
--   = 5638 字节 > 3072 ⇒ errno 1071. 改法同 ad_ous_snapshot (应用层零改动)。
--   idx_ugm_group 去掉了 group_dn: group_dn **只写不读** (应用里没有任何按
--   group_dn 过滤的查询 —— listGroupsForUser 按 (domain_name, user_sam),
--   listMembersForGroup 按 (domain_name, group_name)), 而 deleteOrphans
--   按 user_sam 删, 正好由 (user_sam, domain_name) 的最左前缀覆盖。
CREATE TABLE IF NOT EXISTS ad_user_group_memberships (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  domain_name VARCHAR(128) NOT NULL,
  user_sam VARCHAR(256) NOT NULL,
  group_dn VARCHAR(1024) NOT NULL,
  group_name VARCHAR(256) NOT NULL,
  snapshot_at DATETIME NOT NULL,
  snapshot_run_id BIGINT NOT NULL,
  group_dn_hash BINARY(32)
    GENERATED ALWAYS AS (UNHEX(SHA2(group_dn, 256))) STORED,
  UNIQUE KEY uq_ugm (domain_name, user_sam, group_dn_hash),
  KEY idx_ugm_user (group_name, domain_name, user_sam),
  KEY idx_ugm_group (user_sam, domain_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== daily_reports ====================
CREATE TABLE IF NOT EXISTS daily_reports (
  id BIGINT NOT NULL AUTO_INCREMENT,
  kind VARCHAR(16) NOT NULL,
  period_start DATETIME NOT NULL,
  period_end DATETIME NOT NULL,
  generated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  to_addrs VARCHAR(1024) NOT NULL,
  cc_addrs VARCHAR(1024) NULL,
  subject VARCHAR(256) NOT NULL,
  body_text LONGTEXT NOT NULL,
  body_html LONGTEXT NULL,
  outbox_id BIGINT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
  last_error LONGTEXT NULL,
  html_size INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_dr_kind_generated (`status`, subject, kind, generated_at DESC),
  KEY idx_dr_period (kind, `status`, period_end DESC),
  CONSTRAINT fk_dro_outbox FOREIGN KEY (outbox_id) REFERENCES report_email_outbox(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== license_email_outbox ====================
CREATE TABLE IF NOT EXISTS license_email_outbox (
  id INT NOT NULL AUTO_INCREMENT,
  license_id INT NULL,
  to_addrs VARCHAR(1024) NOT NULL,
  cc_addrs VARCHAR(1024) NULL,
  subject VARCHAR(512) NOT NULL,
  body_text LONGTEXT NOT NULL,
  body_html LONGTEXT NOT NULL,
  attempt_count INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  last_error VARCHAR(2048) NULL,
  sent_at DATETIME NULL,
  next_attempt_at DATETIME NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== package_scripts_history ====================
CREATE TABLE IF NOT EXISTS package_scripts_history (
  id BIGINT NOT NULL AUTO_INCREMENT,
  name VARCHAR(128) NOT NULL,
  version VARCHAR(32) NOT NULL,
  script_sha256 VARCHAR(64) NOT NULL,
  manifest_json LONGTEXT NOT NULL,
  source VARCHAR(255) NOT NULL,
  published_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_package_scripts_history (name, version, script_sha256),
  KEY ix_package_scripts_history_name_pub (name, published_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== report_subscriptions ====================
CREATE TABLE IF NOT EXISTS report_subscriptions (
  id INT NOT NULL AUTO_INCREMENT,
  kind VARCHAR(16) NOT NULL,
  to_addrs VARCHAR(1024) NOT NULL,
  cc_addrs VARCHAR(1024) NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_by VARCHAR(64) NULL,
  PRIMARY KEY (id),
  -- R161.3 (2026-10-25): 旧索引 (to_addrs, cc_addrs, kind, enabled) = 4098+4098+66+1
  -- = 8263 字节 > 3072 ⇒ errno 1071. 而且列序对真实查询完全无用 ——
  -- 唯一的查询是 db/sql/reports.js 的 `WHERE kind = ? AND enabled = 1`,
  -- 收件人地址 (to_addrs/cc_addrs) 从不参与过滤 ⇒ 改成 (kind, enabled) 才既
  -- 合法又对得上查询形状。
  KEY idx_rs_kind_enabled (kind, enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== system_alert_outbox ====================
CREATE TABLE IF NOT EXISTS system_alert_outbox (
  id BIGINT NOT NULL AUTO_INCREMENT,
  alert_id BIGINT NOT NULL,
  to_addrs LONGTEXT NOT NULL,
  cc_addrs LONGTEXT NULL,
  subject VARCHAR(500) NOT NULL,
  body_text LONGTEXT NOT NULL,
  body_html LONGTEXT NULL,
  attempt_count INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  last_error LONGTEXT NULL,
  sent_at DATETIME NULL,
  next_attempt_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_sao_pending (next_attempt_at /* mssql filtered: WHERE sent_at IS NULL -> plain index */),
  CONSTRAINT fk_sao_alert FOREIGN KEY (alert_id) REFERENCES system_alerts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================== system_alert_suppressions ====================
CREATE TABLE IF NOT EXISTS system_alert_suppressions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  kind VARCHAR(40) NOT NULL,
  scope_ref VARCHAR(255) NOT NULL,
  reason VARCHAR(500) NULL,
  set_by VARCHAR(64) NOT NULL,
  set_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sas_kind_scope (kind, scope_ref),
  KEY ix_sas_set_at (set_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- ============================================================================
-- MySQL/MSSQL parity block — column back-fill for 13 existing tables
-- 24 columns that center/src writes but this baseline did not declare.
-- Column types mirror db/migrations/mssql/1.0.0-baseline.sql.
-- MySQL 8 has no ADD COLUMN IF NOT EXISTS; each ALTER is guarded by an
-- INFORMATION_SCHEMA.COLUMNS lookup + PREPARE/EXECUTE so the block is
-- idempotent across fresh install, existing install and bootstrap re-run
-- (same pattern as the package_runs block above).
-- ============================================================================

-- ad_admin_commands — 1 column(s)
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_admin_commands' AND COLUMN_NAME = 'task_id') = 0,
  'ALTER TABLE ad_admin_commands ADD COLUMN task_id VARCHAR(64) NULL AFTER completed_at',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ad_admin_members — 1 column(s)
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_admin_members' AND COLUMN_NAME = 'display_name') = 0,
  'ALTER TABLE ad_admin_members ADD COLUMN display_name VARCHAR(255) NULL AFTER run_id',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ad_agent_heartbeat — 4 column(s)
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_agent_heartbeat' AND COLUMN_NAME = 'client_settings_version') = 0,
  'ALTER TABLE ad_agent_heartbeat ADD COLUMN client_settings_version INT NOT NULL DEFAULT 0 AFTER report_requested_at',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_agent_heartbeat' AND COLUMN_NAME = 'heartbeat_interval_seconds') = 0,
  'ALTER TABLE ad_agent_heartbeat ADD COLUMN heartbeat_interval_seconds INT NULL AFTER client_settings_version',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_agent_heartbeat' AND COLUMN_NAME = 'last_upgrade_event') = 0,
  'ALTER TABLE ad_agent_heartbeat ADD COLUMN last_upgrade_event LONGTEXT NULL AFTER heartbeat_interval_seconds',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_agent_heartbeat' AND COLUMN_NAME = 'health_score') = 0,
  'ALTER TABLE ad_agent_heartbeat ADD COLUMN health_score INT NULL AFTER last_upgrade_event',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ad_dc_overview — 2 column(s)
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_dc_overview' AND COLUMN_NAME = 'computers_count') = 0,
  'ALTER TABLE ad_dc_overview ADD COLUMN computers_count INT NULL AFTER partner_port_status',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_dc_overview' AND COLUMN_NAME = 'servers_count') = 0,
  'ALTER TABLE ad_dc_overview ADD COLUMN servers_count INT NULL AFTER computers_count',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ad_dcs — 3 column(s)
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_dcs' AND COLUMN_NAME = 'forest_domain_id') = 0,
  'ALTER TABLE ad_dcs ADD COLUMN forest_domain_id BIGINT NULL AFTER discovered_by_agent_id',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- R161.6 (2026-10-26) — ad_dcs.forest_domain_id 的索引 (MySQL 侧缺失)。
--   MSSQL 基线有 `CREATE NONCLUSTERED INDEX [idx_ad_dcs_forest_domain]
--   ON [ad_dcs] ([forest_domain_id])` (mssql/1.0.0-baseline.sql:327-328),
--   MySQL 基线只有**列**没有**索引** ⇒ 双方言在同一查询上的执行计划不同
--   (MySQL 侧只能全表扫 ad_dcs)。forest_domain_id 是多森林注册/归属查询
--   (ad_forest_dc_assignment ↔ ad_dcs 归属关系) 的过滤列。
--   放在列守卫**之后** —— 索引依赖列, 列不存在时建索引会直接失败。
--   守卫形态与本文件其余 DDL 同款 (INFORMATION_SCHEMA + PREPARE/EXECUTE)。
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_dcs' AND INDEX_NAME = 'idx_ad_dcs_forest_domain') = 0,
  'CREATE INDEX idx_ad_dcs_forest_domain ON ad_dcs (forest_domain_id)',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ad_directory_sync_runs — 1 column(s)
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_directory_sync_runs' AND COLUMN_NAME = 'computer_count') = 0,
  'ALTER TABLE ad_directory_sync_runs ADD COLUMN computer_count INT NULL AFTER domain_id',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ad_eventlog_events — 1 column(s)
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_eventlog_events' AND COLUMN_NAME = 'audit_failure') = 0,
  'ALTER TABLE ad_eventlog_events ADD COLUMN audit_failure TINYINT(1) NOT NULL DEFAULT 0 AFTER ts',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ad_eventlog_summary — 2 column(s)
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_eventlog_summary' AND COLUMN_NAME = 'audit_failure_count') = 0,
  'ALTER TABLE ad_eventlog_summary ADD COLUMN audit_failure_count INT NOT NULL DEFAULT 0 AFTER error_count',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_eventlog_summary' AND COLUMN_NAME = 'dropped_count') = 0,
  'ALTER TABLE ad_eventlog_summary ADD COLUMN dropped_count INT NULL AFTER audit_failure_count',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ad_groups_snapshot — 2 column(s)
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_groups_snapshot' AND COLUMN_NAME = 'domain_name') = 0,
  'ALTER TABLE ad_groups_snapshot ADD COLUMN domain_name VARCHAR(128) NOT NULL',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_groups_snapshot' AND COLUMN_NAME = 'ou_dn') = 0,
  'ALTER TABLE ad_groups_snapshot ADD COLUMN ou_dn VARCHAR(1024) NULL AFTER domain_id',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ad_lockout_events — 1 column(s)
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_lockout_events' AND COLUMN_NAME = 'target_user_display_name') = 0,
  'ALTER TABLE ad_lockout_events ADD COLUMN target_user_display_name VARCHAR(512) NULL AFTER caller_computer_name',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ad_member_servers — 3 column(s)
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_member_servers' AND COLUMN_NAME = 'install_root') = 0,
  'ALTER TABLE ad_member_servers ADD COLUMN install_root VARCHAR(512) NULL AFTER updated_at',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ad_ous_snapshot — 1 column(s)
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_ous_snapshot' AND COLUMN_NAME = 'domain_name') = 0,
  'ALTER TABLE ad_ous_snapshot ADD COLUMN domain_name VARCHAR(128) NOT NULL',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ad_users_snapshot — 1 column(s)
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_users_snapshot' AND COLUMN_NAME = 'domain_name') = 0,
  'ALTER TABLE ad_users_snapshot ADD COLUMN domain_name VARCHAR(128) NOT NULL',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
-- ============================================================================
-- MySQL/MSSQL parity block — R158.X.115 host lifecycle columns.
-- decommissioned_at    非空 = 已退役 (终态, 不可逆)
-- monitoring_paused_at 非空 = 暂停管控 (临时态, 手动恢复, 无自动到期)
-- Mirrors the MSSQL block appended above; guarded by INFORMATION_SCHEMA
-- because MySQL 8 has no ADD COLUMN IF NOT EXISTS.
-- ============================================================================
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_dcs' AND COLUMN_NAME = 'decommissioned_at') = 0,
  'ALTER TABLE ad_dcs ADD COLUMN decommissioned_at DATETIME NULL',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_dcs' AND COLUMN_NAME = 'monitoring_paused_at') = 0,
  'ALTER TABLE ad_dcs ADD COLUMN monitoring_paused_at DATETIME NULL',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
-- R161.3 (2026-10-25): 这里的 `FROM STATISTICS` 少了 `INFORMATION_SCHEMA.` 前缀
--   —— STATISTICS 不是表, 而是 INFORMATION_SCHEMA 里的视图。5.7 把它当当前库的
--   表名解析 ⇒ errno 1146 "Table 'db.statistics' doesn't exist"。
--   致命之处不在于这句自己报错, 而在于**它失败后 @s 保留了上一轮的旧值**:
--   上一个 @s 是 "ALTER TABLE ad_dcs ADD COLUMN monitoring_paused_at ...",
--   于是下一句 PREPARE 把那条 ALTER 重新预备了一遍, EXECUTE 撞上已存在的列
--   ⇒ errno 1060 "Duplicate column name 'monitoring_paused_at'"。
--   表面症状(重复列)与真因(元数据查询写错表名)完全对不上号, 极易误修。
--   MySQL 5.7 的正确写法是 INFORMATION_SCHEMA.STATISTICS; 8.0 才支持
--   `FROM STATISTICS` (8.0 把 INFORMATION_SCHEMA 的表提升成了可直连的视图)。
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'ad_dcs' AND INDEX_NAME = 'ix_ad_dcs_lifecycle') = 0,
  'CREATE INDEX ix_ad_dcs_lifecycle ON ad_dcs (decommissioned_at, monitoring_paused_at)',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_member_servers' AND COLUMN_NAME = 'decommissioned_at') = 0,
  'ALTER TABLE ad_member_servers ADD COLUMN decommissioned_at DATETIME NULL',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_member_servers' AND COLUMN_NAME = 'monitoring_paused_at') = 0,
  'ALTER TABLE ad_member_servers ADD COLUMN monitoring_paused_at DATETIME NULL',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'ad_member_servers' AND INDEX_NAME = 'ix_ad_member_servers_lifecycle') = 0,
  'CREATE INDEX ix_ad_member_servers_lifecycle ON ad_member_servers (decommissioned_at, monitoring_paused_at)',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ============================================================================
-- MySQL/MSSQL parity block — ad_dcs.forest_domain_id + ad_member_servers.install_root
-- Both columns exist in db/migrations/mssql/1.0.0-baseline.sql but were never
-- added to the MySQL baseline. Referenced by center/src write paths.
-- ============================================================================
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_member_servers' AND COLUMN_NAME = 'install_root') = 0,
  'ALTER TABLE ad_member_servers ADD COLUMN install_root VARCHAR(512) NULL AFTER updated_at',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;



-- ============================================================================
-- MySQL/MSSQL parity block — R158.X.99-quota 节点配额列
-- ad_system_registration.max_nodes / max_nodes_allowed 是授权申请单的节点数
-- 落地处。缺失时 activate 端点写入失败, 申请节点数在激活后丢失, 无法做
-- 配额控制 (见 src/services/license-quota.js)。列已在上方建表块声明, 这里的
-- 守卫 ALTER 只为存量库 (baseline 发布前就已建库) 兜底, 新建库直接跳过。
-- MySQL 8 无 ADD COLUMN IF NOT EXISTS, 故用 INFORMATION_SCHEMA 守卫 +
-- PREPARE/EXECUTE (与本文件其余 ALTER 同款)。
-- ============================================================================
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_system_registration' AND COLUMN_NAME = 'max_nodes') = 0,
  'ALTER TABLE ad_system_registration ADD COLUMN max_nodes INT NULL AFTER request_json_path',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ad_system_registration' AND COLUMN_NAME = 'max_nodes_allowed') = 0,
  'ALTER TABLE ad_system_registration ADD COLUMN max_nodes_allowed INT NULL AFTER max_nodes',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ============================================================================
-- R158.X.99.31 (2026-10-19) — 1.0.0 baseline seed block
--
-- 5) package_policies — 14 条种子 (1:1 with BUILTIN_PACKAGES)
--
-- ⚠ R161.6 (2026-10-26) — **本段的注释此前是错的, 现更正。**
--   旧注释写的是 "MySQL 侧缺失这 14 条 ⇒ 全新安装会得到一个没有任何调度
--   策略的库" —— 暗示本段能把那 14 条**种进去**。实际做不到, 而且**两种
--   方言都做不到**:
--
--   · package_policies.name 有外键 → package_scripts(name) ON DELETE CASCADE
--     (本文件上方建表块), 而 package_scripts 在新装库上是**空表** ——
--     内置包清单是中心端 services/builtin-packages.js 启动时同步进来的,
--     基线不插它 (插了反而会让 seeder 的 packageScripts.get() 前置门
--     跳过 installScript ⇒ script_content 永远传不上去, 那是 P0)。
--   · MySQL 侧现写法是 `INSERT IGNORE`: 外键违例被**降级成 warning 并跳过
--     该行** ⇒ 全新库上这 14 条**必然 0 行**, 而且是**静默**的 ——
--     只有 `SHOW WARNINGS` 才看得见 (R161.6 实测: 警告码 1452)。
--   · MSSQL 侧 (R161.3) 用 `IF NOT EXISTS (...) AND EXISTS (SELECT 1 FROM
--     package_scripts WHERE [name] = ...)` 显式守卫 (MSSQL 没有 IGNORE,
--     不加守卫就是 Msg 547 ⇒ 初始化向导 500) ⇒ 同样是 0 行, 但不依赖
--     IGNORE 的降级副作用。
--   ⇒ **两方言净状态一致 (新装库 package_policies = 0 行)**, 不存在方言
--     分歧。真正补齐这 14 行的时机是**首次正常模式启动**: seeder 的
--     installScript() 先 packageScripts.upsert 再 packagePolicies.upsert
--     (center/src/packages/script-service.js:228 / :244) —— 顺序保证了外键
--     被满足, 策略行必然落库。
--
--   ⚠ 千万不要为了"让这 14 条真的落库"而去预插 package_scripts ——
--     那会让 seeder 的前置门 packageScripts.get() 命中已有行而跳过
--     installScript ⇒ script_content 永远上传不了 (P0)。真源只有 manifest。
--
-- cron_expr 列: R158.72.x.13 ALTER 于 2026-10-17 加入, 已在上方建表块声明。
--
-- 注意: 这些是**初始快照**, 不是运行时真源。services/builtin-packages.js 的
-- seedBuiltinPackages() 在每次启动时按磁盘 manifest 重算 interval_sec /
-- timeout_ms / cron_expr / scope, 并在 policyChanged 时覆盖本 seed。
-- 因此改动调度策略时以 manifest 为准, 这里的值只决定全新库首次启动前的
-- 可观测状态 —— 与 MSSQL baseline 的关系同理。
-- ============================================================================
-- 5a) Self-interval 范式 (10 包, interval_sec 非 0, agent 端 setInterval)
INSERT IGNORE INTO package_policies (name, interval_sec, timeout_ms, enabled, params_json, scope, cron_expr, created_at, updated_at) VALUES
  ('ad_dc_overview', 900, 60000, 1, NULL, 'agent_type:ad', NULL, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));
INSERT IGNORE INTO package_policies (name, interval_sec, timeout_ms, enabled, params_json, scope, cron_expr, created_at, updated_at) VALUES
  ('ad_lockout_summary', 900, 60000, 1, NULL, 'agent_type:ad', NULL, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));
INSERT IGNORE INTO package_policies (name, interval_sec, timeout_ms, enabled, params_json, scope, cron_expr, created_at, updated_at) VALUES
  ('ad_lockout_list', 900, 60000, 1, NULL, 'agent_type:ad', NULL, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));
INSERT IGNORE INTO package_policies (name, interval_sec, timeout_ms, enabled, params_json, scope, cron_expr, created_at, updated_at) VALUES
  ('ad_dc_probe_inbound', 900, 60000, 1, NULL, 'agent_type:ad', NULL, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));
INSERT IGNORE INTO package_policies (name, interval_sec, timeout_ms, enabled, params_json, scope, cron_expr, created_at, updated_at) VALUES
  ('ad_replication_status_probe', 600, 60000, 1, NULL, 'agent_type:ad', NULL, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));
INSERT IGNORE INTO package_policies (name, interval_sec, timeout_ms, enabled, params_json, scope, cron_expr, created_at, updated_at) VALUES
  ('ad_failed_logon_collector', 900, 120000, 1, NULL, 'agent_type:ad', NULL, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));
INSERT IGNORE INTO package_policies (name, interval_sec, timeout_ms, enabled, params_json, scope, cron_expr, created_at, updated_at) VALUES
  ('ad_os_baseline', 900, 20000, 1, NULL, 'agent_type:ad', NULL, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));
INSERT IGNORE INTO package_policies (name, interval_sec, timeout_ms, enabled, params_json, scope, cron_expr, created_at, updated_at) VALUES
  ('member_eventlog_collector', 7200, 60000, 1, NULL, 'agent_type:non-ad', NULL, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));
INSERT IGNORE INTO package_policies (name, interval_sec, timeout_ms, enabled, params_json, scope, cron_expr, created_at, updated_at) VALUES
  ('member_admin_groups', 86400, 60000, 1, NULL, 'agent_type:non-ad', NULL, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));
INSERT IGNORE INTO package_policies (name, interval_sec, timeout_ms, enabled, params_json, scope, cron_expr, created_at, updated_at) VALUES
  ('member_os_baseline_collector', 900, 20000, 1, NULL, 'agent_type:non-ad', NULL, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));
-- 5b) Cron 范式 (4 包, interval_sec=0, 中心端 cron 为唯一 fire 源)
INSERT IGNORE INTO package_policies (name, interval_sec, timeout_ms, enabled, params_json, scope, cron_expr, created_at, updated_at) VALUES
  ('ad_eventlog_collector', 0, 60000, 1, NULL, 'agent_type:ad', '0 */2 * * *', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));
INSERT IGNORE INTO package_policies (name, interval_sec, timeout_ms, enabled, params_json, scope, cron_expr, created_at, updated_at) VALUES
  ('ad_partner_inbound_discover', 0, 60000, 1, NULL, 'agent_type:ad', '0 2 * * *', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));
INSERT IGNORE INTO package_policies (name, interval_sec, timeout_ms, enabled, params_json, scope, cron_expr, created_at, updated_at) VALUES
  ('ad_admin_members', 0, 120000, 1, NULL, 'agent_type:ad', '0 2 * * *', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));
INSERT IGNORE INTO package_policies (name, interval_sec, timeout_ms, enabled, params_json, scope, cron_expr, created_at, updated_at) VALUES
  ('ad_account_change', 0, 180000, 1, NULL, 'agent_type:ad', '0 2 * * *', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));

-- ============================================================================
-- MySQL/MSSQL parity block — package_policies.cron_expr (存量库兜底)
-- R158.72.x.13 (2026-10-17) 加入的 cron 范式列。MSSQL baseline 自始有, MySQL
-- 侧整列缺失, 后果有二: (1) /admin/packages-schedule 页查询 cron_expr 失败;
-- (2) 4 个 cron 范式包 (ad_eventlog_collector / ad_partner_inbound_discover /
-- ad_admin_members / ad_account_change) 无处落库, interval_sec 只能记 0,
-- 中心端找不到计划就不 fire。
--
-- 上方 CREATE TABLE 块已声明该列, 这里是**存量库兜底** —— baseline 发布前就
-- 已建库的部署, CREATE TABLE IF NOT EXISTS 不会给它补列。MySQL 8 无
-- ADD COLUMN IF NOT EXISTS, 故用 INFORMATION_SCHEMA 守卫 + PREPARE/EXECUTE
-- (与本文件其余 ALTER 同款)。
-- ============================================================================
SET @s = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'package_policies' AND COLUMN_NAME = 'cron_expr') = 0,
  'ALTER TABLE package_policies ADD COLUMN cron_expr VARCHAR(128) NULL AFTER scope',
  'SELECT 1'));
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ============================================================================
-- R158.X.99 dbparity audit — system_config seed 补齐
--
-- MSSQL baseline seed 38 个键, MySQL 侧原本只有 16 个。缺失的 28 个在此补齐, 值取自 MSSQL 同名 seed
-- (db/migrations/mssql/1.0.0-baseline.sql 的 seed 段), 两侧因此收敛到同一套默认配置。
--
-- 两类处理:
--   1. 纯配置项 (17 个) — 直接沿用 MSSQL 的默认值
--      (告警阈值 / 保留天数 / 通知模板 / 重试参数等)。
--   2. 环境相关项 (11 个) — **seed 为空字符串**, 不抄 MSSQL 里的
--      真实地址/凭据。baseline 是所有新装环境的模板, 把某台机器的收件邮箱
--      和 LDAP 绑定密码固化进去, 会让每个新部署都默认往那几个地址发告警、
--      并继承一份不该外流的凭据。这些键由部署方在 system-settings 页自行填写。
--
-- 注: 这些行只在键不存在时插入 (INSERT IGNORE), 不会覆盖存量库已配置的值。
-- ============================================================================
INSERT IGNORE INTO system_config (config_key, config_value, description) VALUES
  ('admin_email', '', 'License / 通用通知发件人邮箱'),
  ('ad_sync_interval_minutes', '60', 'AD 同步周期 (分钟)'),
  ('ad_mgmt_retention_days', '30', 'AD 管理日志保留天数'),
  ('ad_notify_enabled', '0', 'AD 操作通知邮件总开关 (0/1)'),
  ('ad_notify_to', '', 'AD 操作通知主送邮箱'),
  ('ad_notify_cc', '', 'AD 操作通知抄送邮箱 (逗号分隔)'),
  ('ad_notify_subject_template', '[AD 操作通知] {{result_label}} — {{sam}}{{target}} — {{target_dc}}', 'AD 操作通知邮件主题模板'),
  -- \n 在 MySQL 字符串字面量里是真转义 (MSSQL 侧必须用 CHAR(10), 那边 \n 不转义)。
  -- {{kind_label}} 不是 {{command_type}}: placeholders 字典 (ad-notify.js:120-134)
  -- 13 个键里没有 command_type, renderTemplate 对未知键返 '' , 会在正文里留空段。
  ('ad_notify_body_template', '操作员 {{operator}} 在 {{time}} 于 {{target_dc}} 执行 AD 操作 {{kind_label}}\n目标: {{sam}}{{target}}\n结果: {{result_label}}\nTask ID: {{task_id}}\n耗时: {{duration_ms}}ms\n错误: {{error}}', 'AD 操作通知邮件正文模板'),
  ('ad_ldap_url', '', 'AD LDAP URL, 例如 ldap://dc01.contoso.com'),
  ('ad_base_dn', '', 'AD 基础 DN, 例如 DC=contoso,DC=com'),
  ('ad_bind_dn', '', 'AD 绑定 DN (服务账号)'),
  ('ad_bind_password', '', 'AD 绑定密码 (服务账号)'),
  ('file_push_retention_days', '7', 'file-push task 保留天数 (failed/delivered)'),
  ('file_push_claim_ttl_minutes', '60', 'file-push claim TTL (minutes) — 超时 auto-fail'),
  ('report_daily_cc', '', '日报默认抄送邮箱'),
  -- R158.X.99 (2026-10-23) — 补齐 seedReportsDefaultsIfMissing (services/config.js:370-381)
  --   的其余 9 个键, 值逐字取自代码。enabled 默认 '0' = 默认关闭, 必须与 cron 一起
  --   seed, 否则「表达式在但永远不发」(report-scheduler.js:293 !== '1' 直接 return)。
  ('report_daily_enabled', '0', '日报总开关 (0/1), 0=不发送'),
  ('report_daily_cron', '0 9 * * *', '日报发送时刻 (5 字段 cron, CST 墙钟: 分 时 日 月 周)'),
  ('report_daily_to', '', '日报主送邮箱, 留空回退 alert_default_to'),
  ('report_weekly_enabled', '0', '周报总开关 (0/1), 0=不发送'),
  ('report_weekly_cron', '0 9 * * MON', '周报发送时刻 (5 字段 cron, CST 墙钟: 分 时 日 月 周)'),
  ('report_weekly_to', '', '周报主送邮箱, 留空回退 alert_default_to'),
  ('report_weekly_cc', '', '周报抄送邮箱 (逗号分隔)'),
  ('report_loop_interval_seconds', '300', '报表调度循环周期 (秒, 5min)'),
  ('report_retention_days', '30', '报表历史保留天数 (0=禁用清理; R158.107 起实际清理由 8 个 retention service 负责)'),
  ('system_alert_heartbeat_offline_minutes', '15', 'Agent 心跳离线告警阈值 (分钟)'),
  ('system_alert_replication_failure_count', '30', '复制连续失败次数告警阈值'),
  ('system_alert_port_latency_ms', '100', '端口延迟告警阈值 (毫秒)'),
  ('system_alert_disk_free_kb', '10485760', '磁盘可用空间告警阈值 (KB, 10 GB)'),
  ('system_alert_failed_logon_24h', '5000', '24h 失败登录告警阈值'),
  ('system_alert_eval_interval_seconds', '600', '系统告警评估周期 (秒, 10 min)'),
  ('system_alert_to', '', '系统告警主送邮箱 (逗号分隔)'),
  ('alert_default_cc', '', '告警默认抄送邮箱 (逗号分隔)'),
  ('alert_default_to', '', '告警默认主送邮箱 (留空走 system_alert_to)'),
  ('alert_email_initial_backoff_seconds', '30', '告警邮件重试初始退避 (秒)'),
  ('alert_email_max_attempts', '5', '告警邮件最大重试次数'),
  ('alert_eval_interval_seconds', '60', '告警规则评估周期 (秒)'),
  ('jwt_secret_previous_ttl_days', '30', 'jwt_secret_previous 保留天数 (旋转后失效)');

-- ============================================================================
-- R158.X.99 dbparity audit — ad_feature_flags seed
--
-- 本表此前建了但零种子行, 靠代码 fallback 兜底:
--   readRolloutGate()            (routes/rollout.js:44-57)
--   computeUpgradeEnvelope()     (routes/agent-upgrade.js:86)
-- 两处对缺失/非法值都退到同一组默认 (strategy='full'、canaryRatio=100), 行为上
-- 无 bug, 显式 seed 让默认值在 DB 里可见可审计, 且改这两个键的效果与改
-- fallback 常量等价 (代码读的就是这两行)。
--
-- R158.X.116.g (2026-10-23) — ⚠ 这两行**不在** /admin/system-settings 的
--   功能开关页里显示 (前端 HIDDEN_KEYS 过滤, 见 FeatureFlagsView.vue)。
--   放进那张表比不显示更危险, 两条实测理由:
--     1. 语义错配: 该页 isEnabled() 只认 '1'/1/true, 而这里是 'full'/'100',
--        永远显示"禁用"。而 full + 100 是**最宽松**的组合 (全量放行升级),
--        界面在说反话 —— operator 会据此判断"升级是关着的", 实际是全开。
--     2. 写路径危险: 该页 Toggle 只能写 '0'/'1', 而 strategy 合法值是
--        full|canary|paused。写 '0' 会 fallthrough 回 'full', 看似"禁用"
--        实则完全没生效, 还把配置写脏。
--   正确操作入口: rollout 专有端点 POST /api/admin/rollout (+ /pause
--   + /resume), 熔断即 strategy='paused'。行保留在 DB 里不动 ——
--   代码读的仍是这两行, 删行不会改变行为, 只会退回 fallback 常量。
--
-- 幂等: 只在键不存在时插入, 不覆盖操作员已改过的值。
-- ============================================================================
INSERT IGNORE INTO ad_feature_flags (`key`, `value`, `description`) VALUES
  ('agent_upgrade_rollout_strategy', 'full', 'Agent 升级发布策略: full=全量放行 / canary=按比例灰度 / paused=熔断停发。缺行或非法值按 full 处理');
INSERT IGNORE INTO ad_feature_flags (`key`, `value`, `description`) VALUES
  ('agent_upgrade_canary_ratio', '100', 'canary 策略下的灰度比例 (0-100), 按 (上报版本+目标版本) 稳定哈希取桶判定。缺行按 100 处理');

-- ============================================================================
-- R158.X.116.j (2026-10-23) — ad_feature_flags seed: 只剩 1 个真实开关。
--
-- ⚠ 本段在同一天内被推翻重写过一次, 留档以免有人照着旧结论再补一遍:
--   R158.X.116.h 当天先补了 5 个 sidebar gate key (域和森林 / 复制矩阵 /
--   包管理 / 成员服务器 / 日常管理), 理由是"存量库有、新装机没有"的分裂。
--   同日 operator directive 改为「这些功能不需要开关, 入口要常留给后续
--   开发」→ AppLayout.vue 的 5 处 nav-group v-if 已删掉 flag 判断,
--   入口改为常显。因此其中 4 个 key 失去唯一的消费点, 一并撤掉;
--   member_eventlog.enabled / member_os_baseline.enabled 本来就无消费点
--   (全仓 grep 无命中), 从来没补进来。
--
-- 保留的唯一真实开关:
--   ad_management.enabled — 双重消费, 两处缺一不可:
--     ① web/src/components/AppLayout.vue:167 「日常管理」按钮 v-if
--     ② web/src/router.js /daily-ops 的 meta.featureFlag
--        (beforeEach 守卫, 关掉后直接敲 URL 也进不去)
--   这是"可插拔的运维能力", 不是系统的结构性组成 —— 所以留开关合理。
--
-- 反过来, 域和森林 / 复制矩阵 / 包管理 / 成员服务器 是系统的**结构性
-- 组成**, 给它们配开关等于暗示"可以拆掉", 而实际上没有任何替代入口。
--
-- 存量库里那几行 DB 数据**保留不删** (migrate-config-seed.mjs 回填的),
-- 删行不改变行为 (已无消费点), 只丢审计痕迹。
--
-- 幂等: INSERT IGNORE 不覆盖操作员已改过的值。
-- ============================================================================
INSERT IGNORE INTO ad_feature_flags (`key`, `value`, `description`) VALUES
  ('ad_management.enabled', '1', '活动目录日常管理 (ADUC 等) 总开关 — 同时控制「日常管理」入口按钮与 /daily-ops 路由准入');

-- ============================================================================
-- R158.X.116.k (2026-10-23) — MCP 2 个开关 (操作员 directive:
--   「增加 MCP 功能开关, 关闭后入口不显示且链接也进不去」
--    +「增加 MCP 写开关, 关闭后写入口关闭, 但保留读入口」)
--
-- 两者都是**真开关** (跟上一段撤掉的那 5 个不同): MCP 是可以整体停用的
-- 外部集成面, 关掉即"这套集成不存在", 不是系统结构性组成。
--
-- mcp.enabled          — 关 = MCP 整体停用, 3 层同时关:
--     ① AdminLayout sidebar「MCP 集成」entry 消失 (featureFlag 字段过滤)
--     ② /admin/mcp-token* 3 条路由进不去 (router.js meta.featureFlag)
--     ③ 后端 POST/GET/DELETE /mcp 返 503 (routes/mcp.js isMcpEnabled gate),
--        手里已有的 mcp_ token 一并失效 —— 这是只藏 UI 做不到的部分
--     /mcp/healthz 保持公开且如实报 enabled=false (探针要知道是被人关的,
--     不是挂了), 跟 mcp-write.js 1:1 平行。
--
-- mcp_write.enabled    — 关 = 只关写通道, 读通道照常:
--     ① McpTokenView 的「写入集成」tab 消失 (只读集成 + IP 白名单保留)
--     ② /admin/mcp-token/write 进不去 (meta.featureFlag 数组同时要求
--        mcp.enabled + mcp_write.enabled —— 数组而非单值, 因为 vue-router
--        的 to.meta 父子 merge 是"子级覆盖父级", 单值会顶掉父级 gate)
--     ③ 后端 /mcp-write 返 503 (routes/mcp-write.js gate), mcpw_ token 失效
--     ⚠ 5 个写 tool 覆盖的是**危险操作** (改密码 / 建用户 / 建组 / 解锁 /
--       启禁用), 所以这一层后端闸门不是可选项 —— 只藏 tab 的话, 任何持有
--       mcpw_ token 的人都能绕过 UI 直接调。
--
-- fail-open: 两处后端 gate 查询失败一律放行 (一次 DB 抖动不该锁死运维通道;
-- 关掉是 operator 的显式动作, 不是故障的副作用)。1:1 平行
-- R158.X.116.i 的前端 route guard 与 license gate。
--
-- 幂等: INSERT IGNORE 不覆盖操作员已改过的值。
-- ============================================================================
INSERT IGNORE INTO ad_feature_flags (`key`, `value`, `description`) VALUES
  ('mcp.enabled',       '1', 'MCP 集成总开关 — 关闭后 sidebar 入口消失、/admin/mcp-token* 进不去、后端 /mcp 返 503 (已有 mcp_ token 失效)'),
  ('mcp_write.enabled', '1', 'MCP 写入通道开关 — 关闭后「写入集成」tab 消失、/admin/mcp-token/write 进不去、后端 /mcp-write 返 503 (已有 mcpw_ token 失效); 读通道不受影响');

-- ============================================================================
-- R161.6 (2026-10-26) — 报表中心 4 把开关 seed (操作员 directive:
--   「这是我们要的功能开关。现有功能开关不够。」
--    +「确认下 seed 的结果是否正确」)
--
-- ★ 为什么现在才补: 这 4 个 key **一直有消费点**, 但基线**从来没 seed 过** ——
--   R158.X.116.n (2026-10-23) 加了后端 gate (routes/report-center.js:55-59)
--   和前端 meta.featureFlag (web/src/router.js:318,321,328,330,332) +
--   AdminLayout sidebar entry (AdminLayout.vue:314-317) +
--   总览页 3 张卡片 (ReportCenterOverviewView.vue:61,69,77),
--   唯独漏了基线里的 seed 行。后果是**全新装机报表中心 100% 不可达**:
--     · 前端 fail-closed (stores/featureFlags.js isEnabled) —— 缺 key ⇒ false
--       ⇒ sidebar 4 个条目被过滤掉、总览页 visibleCards 过滤后为空;
--     · 前端路由守卫 (router.js isFeatureEnabled) —— map 非空时缺 key ⇒ false
--       ⇒ beforeEach 直接 return { path: '/' }, 4 条报表路由全部弹回首页;
--     · 后端 fail-open (report-center.js:66 `if (!rows.length) return true;`)
--       —— 缺行 = 未配置 = **不拦** ⇒ API 反而完全可用。
--   ⇒ 前端"入口消失" + 后端"接口照常" = 两层判定分裂, 正是本文件
--     R158.X.116.k 注释警告的那个坑, 只是成因是"seed 缺行"不是"值矛盾"。
--   ⇒ 存量库不受影响 (行还在), 所以只在"新装"这一形态上暴露, 极易漏测。
--
-- ★ 语义 (与 mcp / mcp_write 两把开关 1:1 对齐, 三层同时生效):
--   report_center.enabled              — 总闸:
--     ① AdminLayout sidebar「报表中心」group 整个消失
--     ② /report-center* 4 条路由进不去 (meta.featureFlag)
--     ③ 后端 /api/report-center/* 返 503 disabled_by_feature_flag
--   report_center.lockout.enabled      — 锁定账户 子开关
--   report_center.failed_logon.enabled — 密码错误 子开关
--   report_center.account_change.enabled — 账户变更 子开关
--   后端**总闸与子闸都查, 不做隐式蕴含** (report-center.js:76-89 gateFor),
--   前端数组语义 = 全部满足才放行 (router.js:640-648) —— 两边同口径。
--   dc-options 例外: 语义是「总闸开 且 至少一把子闸开」
--   (report-center.js:94-103 dcOptionsGate), 因为 3 个子页面共用它。
--
-- fail-open: 缺行 = 未配置 = 不拦 (后端 readFlag / 前端 isEnabled 均同口径,
--   见 R161.6 同步修的前端语义)。关掉是 operator 的显式动作, 不是故障的副作用。
--
-- 幂等: INSERT IGNORE 不覆盖操作员已改过的值。
-- ============================================================================
INSERT IGNORE INTO ad_feature_flags (`key`, `value`, `description`) VALUES
  ('report_center.enabled', '1', '报表中心总开关 — 关闭后「报表中心」sidebar 入口消失、/report-center* 路由进不去、后端 /api/report-center/* 返 503 (已有报表数据不受影响)'),
  ('report_center.lockout.enabled', '1', '报表中心·锁定账户 子开关 — 关闭后「锁定账户」报表入口消失、该子路由进不去、对应后端端点返 503 (跟总闸 report_center.enabled 同时满足才放行)'),
  ('report_center.failed_logon.enabled', '1', '报表中心·密码错误 子开关 — 关闭后「密码错误」报表入口消失、该子路由进不去、对应后端端点返 503 (跟总闸 report_center.enabled 同时满足才放行)'),
  ('report_center.account_change.enabled', '1', '报表中心·账户变更 子开关 — 关闭后「账户变更」报表入口消失、该子路由进不去、对应后端端点返 503 (跟总闸 report_center.enabled 同时满足才放行)');
