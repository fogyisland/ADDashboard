-- verify: table ad_member_servers
-- verify: table ad_server_groups
-- verify: table ad_server_group_members
-- verify: table ad_member_server_packages
-- verify: table alert_rules
-- verify: table alert_rule_state
-- verify: table alert_events
-- verify: table alert_email_outbox

-- 014-member-servers.sql
-- Adds the eight non-AD server management + alert engine tables defined in
-- docs/superpowers/specs/2026-08-09-non-ad-server-management-design.md §4.3-§4.6:
--   ad_member_servers, ad_server_groups, ad_server_group_members,
--   ad_member_server_packages, alert_rules, alert_rule_state,
--   alert_events, alert_email_outbox.
--
-- Idempotent on rerun via CREATE TABLE IF NOT EXISTS (MySQL 5.7+); the
-- MSSQL mirror uses the project's standard IF OBJECT_ID guard. No views,
-- no triggers, no procedures — pure DDL so the schema-applier can replay
-- safely during deployment upgrades.

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

CREATE TABLE IF NOT EXISTS ad_server_groups (
  group_id     INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  group_name   VARCHAR(128) NOT NULL,
  description  VARCHAR(256) NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_server_groups_name (group_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ad_server_group_members (
  group_id    INT NOT NULL,
  hostname    VARCHAR(128) NOT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (group_id, hostname),
  KEY ix_sgm_host (hostname),
  CONSTRAINT fk_sgm_group FOREIGN KEY (group_id)  REFERENCES ad_server_groups(group_id) ON DELETE CASCADE,
  CONSTRAINT fk_sgm_host  FOREIGN KEY (hostname) REFERENCES ad_member_servers(hostname) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ad_member_server_packages (
  hostname      VARCHAR(128) NOT NULL,
  package_name  VARCHAR(128) NOT NULL,
  enabled       TINYINT(1)   NOT NULL DEFAULT 1,
  installed_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_run_at   DATETIME     NULL,
  PRIMARY KEY (hostname, package_name),
  KEY ix_msp_pkg (package_name),
  CONSTRAINT fk_msp_host FOREIGN KEY (hostname)     REFERENCES ad_member_servers(hostname) ON DELETE CASCADE,
  CONSTRAINT fk_msp_pkg  FOREIGN KEY (package_name) REFERENCES installed_packages(name)   ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
