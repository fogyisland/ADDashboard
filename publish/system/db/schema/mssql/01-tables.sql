-- AD Replication Dashboard schema (SQL Server 2014+)
-- All string columns use NVARCHAR for full Unicode (except where MSSQL
-- convention uses VARCHAR for ASCII-only data — agent_id, hostname,
-- port_role, etc.).
-- Timestamps use SYSUTCDATETIME() at the database level.
-- Each CREATE TABLE is wrapped in an IF OBJECT_ID check for idempotency.
--
-- This file is the SINGLE source of truth for the fresh-install schema on
-- SQL Server. It absorbs every CREATE/ALTER from db/migrations/mssql/001-025
-- (excluding the 023 JS data-migration sidecar — that's a code path, not
-- DDL). An init wizard that runs `applyAll()` on a brand-new DB only needs
-- this file + 02-seed-roles.sql; no migrations/ loop. Existing customers
-- still apply 001-025 incrementally — those files remain unchanged.

-- ==================== ad_replication_status ====================
-- Base columns + m007 (users_count / groups_count / gpos_count /
-- locked_count) + m016 (partner_port_status as NVARCHAR(MAX) + ISJSON CHECK).
IF OBJECT_ID('ad_replication_status', 'U') IS NULL
BEGIN
  CREATE TABLE ad_replication_status (
    id                   BIGINT IDENTITY(1,1) PRIMARY KEY,
    collected_at         DATETIME2 NOT NULL,
    agent_id             NVARCHAR(64) NOT NULL,
    source_dc            NVARCHAR(128) NOT NULL,
    dest_dc              NVARCHAR(128) NOT NULL,
    source_site          NVARCHAR(64) NULL,
    dest_site            NVARCHAR(64) NULL,
    naming_context       NVARCHAR(256) NOT NULL,
    last_success_time    DATETIME2 NULL,
    last_attempt_time    DATETIME2 NULL,
    status_code          INT NOT NULL DEFAULT 0,
    error_message        NVARCHAR(512) NULL,
    users_count          INT NULL,
    groups_count         INT NULL,
    gpos_count           INT NULL,
    locked_count         INT NULL,
    partner_port_status  NVARCHAR(MAX) NULL,
    CONSTRAINT uq_repl_partner UNIQUE (source_dc, dest_dc, naming_context),
    CONSTRAINT ck_replication_status_partner_port_json
      CHECK (partner_port_status IS NULL OR ISJSON(partner_port_status) = 1)
  );
  CREATE INDEX ix_repl_collected ON ad_replication_status (collected_at);
  CREATE INDEX ix_repl_dest      ON ad_replication_status (dest_dc);
END;

-- ==================== ad_replication_history ====================
-- Base columns + m021 (last_attempt_time / attempt_duration_ms /
-- objects_transferred + ix_hist_pair_time composite index for the per-pair
-- "last N attempts" query).
IF OBJECT_ID('ad_replication_history', 'U') IS NULL
BEGIN
  CREATE TABLE ad_replication_history (
    id                   BIGINT IDENTITY(1,1) PRIMARY KEY,
    collected_at         DATETIME2 NOT NULL,
    agent_id             NVARCHAR(64) NOT NULL,
    source_dc            NVARCHAR(128) NOT NULL,
    dest_dc              NVARCHAR(128) NOT NULL,
    naming_context       NVARCHAR(256) NOT NULL,
    last_success_time    DATETIME2 NULL,
    last_attempt_time    DATETIME2 NULL,
    attempt_duration_ms  INT NULL,
    objects_transferred  INT NULL,
    status_code          INT NOT NULL,
    error_message        NVARCHAR(512) NULL
  );
  CREATE INDEX ix_hist_time ON ad_replication_history (collected_at);
  CREATE INDEX ix_hist_pair_time
    ON ad_replication_history (source_dc, dest_dc, naming_context, collected_at);
END;

-- ==================== ad_agent_heartbeat ====================
-- Base columns + m017 (agent_token_version) + m018 (report_requested_at).
IF OBJECT_ID('ad_agent_heartbeat', 'U') IS NULL
BEGIN
  CREATE TABLE ad_agent_heartbeat (
    agent_id             NVARCHAR(64) PRIMARY KEY,
    last_heartbeat_at    DATETIME2 NULL,
    agent_version        NVARCHAR(32) NULL,
    last_report_at       DATETIME2 NULL,
    last_report_status   NVARCHAR(32) NULL,
    pending_queue_size   INT NOT NULL CONSTRAINT df_heartbeat_queue DEFAULT 0,
    agent_token_version  INT NOT NULL CONSTRAINT df_heartbeat_token_version DEFAULT 0,
    report_requested_at  DATETIME2 NULL
  );
END;

-- ==================== ad_sites (m001: description + timestamps) ====================
IF OBJECT_ID('ad_sites', 'U') IS NULL
BEGIN
  CREATE TABLE ad_sites (
    site_id      INT IDENTITY(1,1) PRIMARY KEY,
    site_name    NVARCHAR(64) NOT NULL,
    region_code  NVARCHAR(32) NULL,
    is_hub       BIT NOT NULL CONSTRAINT df_sites_is_hub DEFAULT 0,
    description  NVARCHAR(256) NULL,
    created_at   DATETIME2 NOT NULL CONSTRAINT df_sites_created DEFAULT SYSUTCDATETIME(),
    updated_at   DATETIME2 NOT NULL CONSTRAINT df_sites_updated DEFAULT SYSUTCDATETIME(),
    CONSTRAINT uq_ad_sites_site_name UNIQUE (site_name)
  );
END;

-- ==================== ad_dcs (m001: agent metadata + discovery, m020: is_bridgehead) ====================
IF OBJECT_ID('ad_dcs', 'U') IS NULL
BEGIN
  CREATE TABLE ad_dcs (
    dc_name                  NVARCHAR(128) PRIMARY KEY,
    site_id                  INT NULL,
    ip_address               NVARCHAR(64) NULL,
    os_version               NVARCHAR(64) NULL,
    is_pdc                   BIT NOT NULL CONSTRAINT df_dcs_is_pdc DEFAULT 0,
    when_created             DATETIME2 NULL,
    is_gc                    BIT NOT NULL CONSTRAINT df_dcs_is_gc DEFAULT 0,
    is_rid_master            BIT NOT NULL CONSTRAINT df_dcs_is_rid_master DEFAULT 0,
    is_schema_master         BIT NOT NULL CONSTRAINT df_dcs_is_schema_master DEFAULT 0,
    is_domain_naming_master  BIT NOT NULL CONSTRAINT df_dcs_is_dn_master DEFAULT 0,
    is_infrastructure_master BIT NOT NULL CONSTRAINT df_dcs_is_im DEFAULT 0,
    is_bridgehead            BIT NOT NULL CONSTRAINT df_dcs_is_bridgehead DEFAULT 0,
    site_hint                NVARCHAR(64) NULL,
    discovered_at            DATETIME2 NULL,
    discovered_by_agent_id   NVARCHAR(64) NULL,
    CONSTRAINT fk_dcs_site FOREIGN KEY (site_id) REFERENCES ad_sites(site_id)
  );
END;

-- ==================== system_config (key-value) ====================
IF OBJECT_ID('system_config', 'U') IS NULL
BEGIN
  CREATE TABLE system_config (
    config_key   NVARCHAR(64) PRIMARY KEY,
    config_value NVARCHAR(MAX) NULL,
    description  NVARCHAR(256) NULL,
    updated_at   DATETIME2 NOT NULL CONSTRAINT df_system_config_updated DEFAULT SYSUTCDATETIME(),
    updated_by   NVARCHAR(64) NULL
  );
END;

-- ==================== sys_roles ====================
IF OBJECT_ID('sys_roles', 'U') IS NULL
BEGIN
  CREATE TABLE sys_roles (
    id        INT IDENTITY(1,1) PRIMARY KEY,
    role_name NVARCHAR(64) NOT NULL,
    CONSTRAINT uq_sys_roles_role_name UNIQUE (role_name)
  );
END;

-- ==================== role_permissions (m002) ====================
-- Replaces the legacy sys_roles.permissions NVARCHAR(MAX) column.
IF OBJECT_ID('role_permissions', 'U') IS NULL
BEGIN
  CREATE TABLE role_permissions (
    role_id    INT NOT NULL,
    permission NVARCHAR(64) NOT NULL,
    CONSTRAINT pk_role_permissions PRIMARY KEY (role_id, permission),
    CONSTRAINT fk_role_permissions_role FOREIGN KEY (role_id) REFERENCES sys_roles(id) ON DELETE CASCADE
  );
END;

-- ==================== sys_users (m015: token_version) ====================
IF OBJECT_ID('sys_users', 'U') IS NULL
BEGIN
  CREATE TABLE sys_users (
    id             INT IDENTITY(1,1) PRIMARY KEY,
    username       NVARCHAR(64) NOT NULL,
    password_hash  NVARCHAR(256) NOT NULL,
    role_id        INT NOT NULL,
    status         BIT NOT NULL CONSTRAINT df_users_status DEFAULT 1,
    last_login_at  DATETIME2 NULL,
    created_at     DATETIME2 NOT NULL CONSTRAINT df_users_created DEFAULT SYSUTCDATETIME(),
    token_version  INT NOT NULL CONSTRAINT df_users_token_version DEFAULT 0,
    CONSTRAINT uq_sys_users_username UNIQUE (username),
    CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES sys_roles(id)
  );
END;

-- ==================== audit_logs (m010: JSON via ISJSON CHECK, m011: extra indexes) ====================
IF OBJECT_ID('audit_logs', 'U') IS NULL
BEGIN
  CREATE TABLE audit_logs (
    id         BIGINT IDENTITY(1,1) PRIMARY KEY,
    user_id    INT NULL,
    action     NVARCHAR(64) NOT NULL,
    target     NVARCHAR(128) NULL,
    payload    NVARCHAR(MAX) NULL,
    created_at DATETIME2 NOT NULL CONSTRAINT df_audit_logs_created DEFAULT SYSUTCDATETIME(),
    CONSTRAINT ck_audit_logs_payload_json
      CHECK (payload IS NULL OR ISJSON(payload) = 1)
  );
  CREATE INDEX ix_audit_time        ON audit_logs (created_at);
  CREATE INDEX ix_audit_action_time ON audit_logs (action, created_at);
  CREATE INDEX ix_audit_user_time   ON audit_logs (user_id, created_at);
END;

-- ==================== sys_config_audit (m005) ====================
IF OBJECT_ID('sys_config_audit', 'U') IS NULL
BEGIN
  CREATE TABLE sys_config_audit (
    id          INT IDENTITY(1,1) PRIMARY KEY,
    config_key  NVARCHAR(64) NOT NULL,
    old_value   NVARCHAR(MAX) NULL,
    new_value   NVARCHAR(MAX) NULL,
    changed_by  INT NULL,
    changed_at  DATETIMEOFFSET NOT NULL CONSTRAINT df_sys_config_audit_changed DEFAULT SYSDATETIMEOFFSET(),
    change_type VARCHAR(16) NOT NULL CONSTRAINT df_sys_config_audit_type DEFAULT 'UPDATE'
      CHECK (change_type IN ('UPDATE','ROLLBACK'))
  );
  CREATE INDEX idx_changed_at ON sys_config_audit (changed_at DESC);
  CREATE INDEX idx_config_key ON sys_config_audit (config_key);
  CREATE INDEX idx_changed_by ON sys_config_audit (changed_by);
END;

-- ==================== system_ports (m003) ====================
IF OBJECT_ID('dbo.system_ports', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.system_ports (
    id         INT IDENTITY(1,1) PRIMARY KEY,
    port       INT NOT NULL,
    label      NVARCHAR(64) NOT NULL,
    sort_order INT NOT NULL CONSTRAINT df_system_ports_sort DEFAULT 0,
    CONSTRAINT uk_system_ports_port UNIQUE (port)
  );
END;

-- ==================== ad_agent_port_status (m003) ====================
IF OBJECT_ID('dbo.ad_agent_port_status', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.ad_agent_port_status (
    agent_id        VARCHAR(64) NOT NULL,
    port            INT NOT NULL,
    ok              BIT NOT NULL,
    latency_ms      INT NULL,
    last_checked_at DATETIME2(3) NOT NULL,
    CONSTRAINT pk_aps PRIMARY KEY (agent_id, port)
    -- intentionally NO FK to ad_agent_heartbeat (see MySQL note)
  );
END;

-- ==================== ad_lockout_events (m008) ====================
IF OBJECT_ID('ad_lockout_events', 'U') IS NULL
BEGIN
  CREATE TABLE ad_lockout_events (
    id                    BIGINT IDENTITY(1,1) PRIMARY KEY,
    occurred_at           DATETIME2 NOT NULL,
    collected_at          DATETIME2 NOT NULL,
    agent_id              VARCHAR(64)  NOT NULL,
    dc_name               VARCHAR(128) NOT NULL,
    event_record_id       BIGINT       NOT NULL,
    target_user_name      VARCHAR(256) NOT NULL,
    subject_user_name     VARCHAR(256) NULL,
    subject_domain        VARCHAR(256) NULL,
    caller_computer_name  VARCHAR(256) NULL,
    CONSTRAINT uq_lockout_dc_record UNIQUE (dc_name, event_record_id)
  );
  CREATE INDEX ix_lockout_target_time ON ad_lockout_events (target_user_name, occurred_at);
  CREATE INDEX ix_lockout_caller_time  ON ad_lockout_events (caller_computer_name, occurred_at);
  CREATE INDEX ix_lockout_dc_time      ON ad_lockout_events (dc_name, occurred_at);
  CREATE INDEX ix_lockout_occurred     ON ad_lockout_events (occurred_at);
END;

-- ==================== probe_state (m012) ====================
IF OBJECT_ID('probe_state', 'U') IS NULL
BEGIN
  CREATE TABLE probe_state (
    port_role            VARCHAR(16) NOT NULL PRIMARY KEY,
    status               VARCHAR(16) NOT NULL,
    latency_ms           INT NULL,
    last_probe_at        DATETIME2 NULL,
    last_up_at           DATETIME2 NULL,
    consecutive_failures INT NOT NULL CONSTRAINT df_probe_state_failures DEFAULT 0,
    CONSTRAINT ck_probe_role   CHECK (port_role IN ('web','heartbeat','report')),
    CONSTRAINT ck_probe_status CHECK (status IN ('healthy','degraded','unknown'))
  );
  INSERT INTO probe_state (port_role, status, consecutive_failures) VALUES
    ('web',       'unknown', 0),
    ('heartbeat', 'unknown', 0),
    ('report',    'unknown', 0);
END;

-- ==================== orphan_schemas (m013) ====================
IF OBJECT_ID('orphan_schemas', 'U') IS NULL
BEGIN
  CREATE TABLE orphan_schemas (
    name          NVARCHAR(128) NOT NULL PRIMARY KEY,
    last_seen_at  DATETIMEOFFSET NOT NULL,
    note          NVARCHAR(512) NULL
  );
END;

-- ==================== ad_member_servers (m014) ====================
IF OBJECT_ID('ad_member_servers', 'U') IS NULL
BEGIN
  CREATE TABLE ad_member_servers (
    hostname        VARCHAR(128) NOT NULL PRIMARY KEY,
    site_id         INT NULL,
    ip_address      VARCHAR(64)  NULL,
    os_version      VARCHAR(64)  NULL,
    agent_type      VARCHAR(16)  NOT NULL CONSTRAINT df_member_servers_agent_type DEFAULT 'non-ad',
    enabled         BIT          NOT NULL CONSTRAINT df_member_servers_enabled DEFAULT 1,
    last_seen_at    DATETIME2    NULL,
    last_report_at  DATETIME2    NULL,
    discovered_at   DATETIME2    NOT NULL CONSTRAINT df_member_servers_disc DEFAULT SYSUTCDATETIME(),
    discovered_via  VARCHAR(32)  NOT NULL CONSTRAINT df_member_servers_via DEFAULT 'self-register',
    created_at      DATETIME2    NOT NULL CONSTRAINT df_member_servers_created DEFAULT SYSUTCDATETIME(),
    updated_at      DATETIME2    NOT NULL CONSTRAINT df_member_servers_updated DEFAULT SYSUTCDATETIME(),
    CONSTRAINT fk_member_servers_site FOREIGN KEY (site_id) REFERENCES ad_sites(site_id) ON DELETE SET NULL
  );
  CREATE INDEX ix_member_servers_site ON ad_member_servers (site_id);
END;

-- ==================== ad_server_groups (m014) ====================
IF OBJECT_ID('ad_server_groups', 'U') IS NULL
BEGIN
  CREATE TABLE ad_server_groups (
    group_id     INT IDENTITY(1,1) PRIMARY KEY,
    group_name   VARCHAR(128) NOT NULL,
    description  VARCHAR(256) NULL,
    created_at   DATETIME2    NOT NULL CONSTRAINT df_server_groups_created DEFAULT SYSUTCDATETIME(),
    updated_at   DATETIME2    NOT NULL CONSTRAINT df_server_groups_updated DEFAULT SYSUTCDATETIME(),
    CONSTRAINT uq_server_groups_name UNIQUE (group_name)
  );
END;

-- ==================== ad_server_group_members (m014) ====================
IF OBJECT_ID('ad_server_group_members', 'U') IS NULL
BEGIN
  CREATE TABLE ad_server_group_members (
    group_id    INT          NOT NULL,
    hostname    VARCHAR(128) NOT NULL,
    created_at  DATETIME2    NOT NULL CONSTRAINT df_sgm_created DEFAULT SYSUTCDATETIME(),
    CONSTRAINT pk_sgm PRIMARY KEY (group_id, hostname),
    CONSTRAINT fk_sgm_group FOREIGN KEY (group_id)  REFERENCES ad_server_groups(group_id)  ON DELETE CASCADE,
    CONSTRAINT fk_sgm_host  FOREIGN KEY (hostname) REFERENCES ad_member_servers(hostname) ON DELETE CASCADE
  );
  CREATE INDEX ix_sgm_host ON ad_server_group_members (hostname);
END;

-- ==================== package_scripts (m023, defined before ad_member_server_packages) ====================
IF OBJECT_ID('package_scripts', 'U') IS NULL
BEGIN
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
  CREATE INDEX ix_package_scripts_updated_at ON package_scripts (updated_at);
END;

-- ==================== package_policies (m023) ====================
IF OBJECT_ID('package_policies', 'U') IS NULL
BEGIN
  CREATE TABLE package_policies (
    id           BIGINT       IDENTITY(1,1) PRIMARY KEY,
    name         NVARCHAR(128) NOT NULL,
    interval_sec INT           NOT NULL,
    timeout_ms   INT           NOT NULL,
    enabled      BIT           NOT NULL CONSTRAINT df_package_policies_enabled DEFAULT 1,
    params_json  NVARCHAR(MAX) NULL,
    scope        NVARCHAR(64)  NOT NULL CONSTRAINT df_package_policies_scope DEFAULT 'global',
    created_at   DATETIME2     NOT NULL,
    updated_at   DATETIME2     NOT NULL,
    CONSTRAINT fk_package_policies_name FOREIGN KEY (name) REFERENCES package_scripts(name) ON DELETE CASCADE,
    CONSTRAINT uq_package_policies_name UNIQUE (name)
  );
  CREATE INDEX ix_package_policies_enabled ON package_policies (enabled);
END;

-- ==================== ad_member_server_packages (m014) ====================
-- FK points at package_scripts.name (post-R66 split).
IF OBJECT_ID('ad_member_server_packages', 'U') IS NULL
BEGIN
  CREATE TABLE ad_member_server_packages (
    hostname      VARCHAR(128)  NOT NULL,
    package_name  NVARCHAR(128) NOT NULL,
    enabled       BIT           NOT NULL CONSTRAINT df_msp_enabled DEFAULT 1,
    installed_at  DATETIME2     NOT NULL CONSTRAINT df_msp_installed DEFAULT SYSUTCDATETIME(),
    last_run_at   DATETIME2     NULL,
    CONSTRAINT pk_msp PRIMARY KEY (hostname, package_name),
    CONSTRAINT fk_msp_host FOREIGN KEY (hostname)     REFERENCES ad_member_servers(hostname) ON DELETE CASCADE,
    CONSTRAINT fk_msp_pkg  FOREIGN KEY (package_name) REFERENCES package_scripts(name)       ON DELETE CASCADE
  );
  CREATE INDEX ix_msp_pkg ON ad_member_server_packages (package_name);
END;

-- ==================== alert_rules (m014) ====================
IF OBJECT_ID('alert_rules', 'U') IS NULL
BEGIN
  CREATE TABLE alert_rules (
    rule_id           INT IDENTITY(1,1) PRIMARY KEY,
    hostname          VARCHAR(128)   NOT NULL,
    name              VARCHAR(256)   NOT NULL,
    [condition]       NVARCHAR(MAX)  NOT NULL,
    for_minutes       INT            NOT NULL CONSTRAINT df_ar_for_minutes DEFAULT 5,
    cooldown_minutes  INT            NOT NULL CONSTRAINT df_ar_cooldown   DEFAULT 30,
    recipients        NVARCHAR(MAX)  NULL,
    enabled           BIT            NOT NULL CONSTRAINT df_ar_enabled    DEFAULT 1,
    created_at        DATETIME2      NOT NULL CONSTRAINT df_ar_created    DEFAULT SYSUTCDATETIME(),
    updated_at        DATETIME2      NOT NULL CONSTRAINT df_ar_updated    DEFAULT SYSUTCDATETIME(),
    CONSTRAINT fk_ar_host FOREIGN KEY (hostname) REFERENCES ad_member_servers(hostname) ON DELETE CASCADE
  );
  CREATE INDEX ix_ar_host_enabled ON alert_rules (hostname, enabled);
END;

-- ==================== alert_rule_state (m014) ====================
IF OBJECT_ID('alert_rule_state', 'U') IS NULL
BEGIN
  CREATE TABLE alert_rule_state (
    rule_id            INT       PRIMARY KEY,
    state              VARCHAR(16) NOT NULL CONSTRAINT df_ars_state DEFAULT 'normal',
    first_hit_at       DATETIME2 NULL,
    last_evaluated_at  DATETIME2 NOT NULL CONSTRAINT df_ars_last_eval DEFAULT SYSUTCDATETIME(),
    last_fired_at      DATETIME2 NULL,
    last_recovered_at  DATETIME2 NULL,
    suppressed_until   DATETIME2 NULL,
    CONSTRAINT fk_ars_rule FOREIGN KEY (rule_id) REFERENCES alert_rules(rule_id) ON DELETE CASCADE
  );
END;

-- ==================== alert_events (m014) ====================
IF OBJECT_ID('alert_events', 'U') IS NULL
BEGIN
  CREATE TABLE alert_events (
    id          BIGINT IDENTITY(1,1) PRIMARY KEY,
    rule_id     INT          NOT NULL,
    hostname    VARCHAR(128) NOT NULL,
    event       VARCHAR(32)  NOT NULL,
    detail      NVARCHAR(MAX) NULL,
    created_at  DATETIME2    NOT NULL CONSTRAINT df_ae_created DEFAULT SYSUTCDATETIME()
  );
  CREATE INDEX idx_ae_rule_created ON alert_events (rule_id, created_at);
  CREATE INDEX idx_ae_host_created ON alert_events (hostname, created_at);
END;

-- ==================== alert_email_outbox (m014) ====================
IF OBJECT_ID('alert_email_outbox', 'U') IS NULL
BEGIN
  CREATE TABLE alert_email_outbox (
    id              BIGINT        IDENTITY(1,1) PRIMARY KEY,
    alert_event_id  BIGINT        NOT NULL,
    to_addrs        VARCHAR(1024) NOT NULL,
    cc_addrs        VARCHAR(1024) NULL,
    subject         VARCHAR(256)  NOT NULL,
    body_text       NVARCHAR(MAX) NOT NULL,
    body_html       NVARCHAR(MAX) NULL,
    attempt_count   INT           NOT NULL CONSTRAINT df_aoe_attempt_count DEFAULT 0,
    next_attempt_at DATETIME2     NOT NULL CONSTRAINT df_aoe_next_attempt   DEFAULT SYSUTCDATETIME(),
    last_error      NVARCHAR(MAX) NULL,
    sent_at         DATETIME2     NULL,
    created_at      DATETIME2     NOT NULL CONSTRAINT df_aoe_created         DEFAULT SYSUTCDATETIME(),
    CONSTRAINT fk_aoe_event FOREIGN KEY (alert_event_id) REFERENCES alert_events(id) ON DELETE CASCADE
  );
  CREATE INDEX idx_aoe_pending ON alert_email_outbox (sent_at, next_attempt_at);
END;

-- ==================== metric_gauge (m004) ====================
IF OBJECT_ID('dbo.metric_gauge', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.metric_gauge (
    id              BIGINT IDENTITY(1,1) PRIMARY KEY,
    agent_id        NVARCHAR(64) NOT NULL,
    metric_id       NVARCHAR(192) NOT NULL,
    ts              DATETIMEOFFSET NOT NULL,
    value           FLOAT NOT NULL,
    unit            NVARCHAR(16) NULL,
    threshold_warn  FLOAT NULL,
    threshold_crit  FLOAT NULL,
    CONSTRAINT uq_gauge_agent_metric UNIQUE (agent_id, metric_id)
  );
  CREATE INDEX ix_gauge_metric_ts ON dbo.metric_gauge (metric_id, ts DESC);
END;

-- ==================== metric_counter (m004) ====================
IF OBJECT_ID('dbo.metric_counter', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.metric_counter (
    id          BIGINT IDENTITY(1,1) PRIMARY KEY,
    agent_id    NVARCHAR(64) NOT NULL,
    metric_id   NVARCHAR(192) NOT NULL,
    ts          DATETIMEOFFSET NOT NULL,
    value       BIGINT NOT NULL,
    delta       BIGINT NOT NULL CONSTRAINT df_metric_counter_delta DEFAULT 0,
    unit        NVARCHAR(16) NULL,
    CONSTRAINT uq_counter_agent_metric UNIQUE (agent_id, metric_id)
  );
  CREATE INDEX ix_counter_metric_ts ON dbo.metric_counter (metric_id, ts DESC);
END;

-- ==================== metric_timeseries (m004) ====================
IF OBJECT_ID('dbo.metric_timeseries', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.metric_timeseries (
    id          BIGINT IDENTITY(1,1) PRIMARY KEY,
    agent_id    NVARCHAR(64) NOT NULL,
    metric_id   NVARCHAR(192) NOT NULL,
    ts          DATETIMEOFFSET NOT NULL,
    value       FLOAT NOT NULL,
    tags_json   NVARCHAR(MAX) NULL,
    unit        NVARCHAR(16) NULL
  );
  CREATE INDEX ix_ts_agent_metric_ts ON dbo.metric_timeseries (agent_id, metric_id, ts DESC);
END;

-- ==================== metric_status (m004) ====================
IF OBJECT_ID('dbo.metric_status', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.metric_status (
    id          BIGINT IDENTITY(1,1) PRIMARY KEY,
    agent_id    NVARCHAR(64) NOT NULL,
    metric_id   NVARCHAR(192) NOT NULL,
    ts          DATETIMEOFFSET NOT NULL,
    status      NVARCHAR(64) NOT NULL,
    message     NVARCHAR(512) NULL,
    CONSTRAINT uq_status_agent_metric UNIQUE (agent_id, metric_id)
  );
  CREATE INDEX ix_status_metric_ts ON dbo.metric_status (metric_id, ts DESC);
END;

-- ==================== package_runs (m004) ====================
IF OBJECT_ID('dbo.package_runs', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.package_runs (
    id              BIGINT IDENTITY(1,1) PRIMARY KEY,
    agent_id        NVARCHAR(64) NOT NULL,
    package_name    NVARCHAR(128) NOT NULL,
    started_at      DATETIMEOFFSET NOT NULL,
    finished_at     DATETIMEOFFSET NULL,
    exit_code       INT NULL,
    stdout_preview  NVARCHAR(2048) NULL,
    stderr_preview  NVARCHAR(2048) NULL,
    error           NVARCHAR(512) NULL
  );
  CREATE INDEX ix_run_agent_pkg ON dbo.package_runs (agent_id, package_name, started_at DESC);
END;

-- ==================== ad_admin_commands (m024) ====================
IF OBJECT_ID('ad_admin_commands', 'U') IS NULL
BEGIN
  CREATE TABLE ad_admin_commands (
    id              BIGINT        IDENTITY(1,1) PRIMARY KEY,
    command_type    NVARCHAR(64)  NOT NULL,
    target_dc       NVARCHAR(128) NOT NULL,
    params_json     NVARCHAR(MAX) NOT NULL
                       CONSTRAINT ck_ad_admin_commands_params_json_isjson CHECK (ISJSON(params_json) = 1),
    status          NVARCHAR(16)  NOT NULL CONSTRAINT df_ad_admin_commands_status DEFAULT 'queued',
    operator_id     BIGINT        NULL,
    result_json     NVARCHAR(MAX) NULL
                       CONSTRAINT ck_ad_admin_commands_result_json_isjson CHECK (result_json IS NULL OR ISJSON(result_json) = 1),
    error_message   NVARCHAR(2000) NULL,
    duration_ms     INT           NULL,
    created_at      DATETIME2     NOT NULL,
    claimed_at      DATETIME2     NULL,
    completed_at    DATETIME2     NULL
  );
  CREATE INDEX ix_ad_admin_commands_target_status ON ad_admin_commands (target_dc, status);
  CREATE INDEX ix_ad_admin_commands_status_created ON ad_admin_commands (status, created_at);
  CREATE INDEX ix_ad_admin_commands_operator      ON ad_admin_commands (operator_id, created_at);
END;

-- ==================== ad_member_commands (m025) ====================
IF OBJECT_ID('ad_member_commands', 'U') IS NULL
BEGIN
  CREATE TABLE ad_member_commands (
    id              BIGINT        IDENTITY(1,1) PRIMARY KEY,
    hostname        NVARCHAR(128) NOT NULL,
    command_type    NVARCHAR(64)  NOT NULL,
    params_json     NVARCHAR(MAX) NOT NULL
                       CONSTRAINT ck_ad_member_commands_params_json_isjson CHECK (ISJSON(params_json) = 1),
    status          NVARCHAR(16)  NOT NULL CONSTRAINT df_ad_member_commands_status DEFAULT 'queued',
    operator_id     BIGINT        NULL,
    result_json     NVARCHAR(MAX) NULL
                       CONSTRAINT ck_ad_member_commands_result_json_isjson CHECK (result_json IS NULL OR ISJSON(result_json) = 1),
    error_message   NVARCHAR(2000) NULL,
    duration_ms     INT           NULL,
    created_at      DATETIME2     NOT NULL,
    claimed_at      DATETIME2     NULL,
    completed_at    DATETIME2     NULL
  );
  CREATE INDEX ix_member_commands_host_status   ON ad_member_commands (hostname, status);
  CREATE INDEX ix_member_commands_status_created ON ad_member_commands (status, created_at);
  CREATE INDEX ix_member_commands_operator      ON ad_member_commands (operator_id, created_at);
END;

-- ==================== schema_migrations (m009) ====================
-- Tracks applied SQL/JS migrations. Required by the schema-applier.
IF OBJECT_ID('schema_migrations', 'U') IS NULL
BEGIN
  CREATE TABLE schema_migrations (
    version        VARCHAR(32)  NOT NULL PRIMARY KEY,
    description    VARCHAR(255) NOT NULL,
    type           VARCHAR(16)  NOT NULL CONSTRAINT df_schema_migrations_type DEFAULT ('sql'),
    script         VARCHAR(255) NOT NULL,
    checksum       CHAR(64)     NOT NULL,
    applied_at     DATETIME2    NOT NULL,
    applied_by     VARCHAR(64)  NULL,
    execution_ms   INT          NULL,
    status         VARCHAR(16)  NOT NULL CONSTRAINT df_schema_migrations_status DEFAULT ('applied'),
    error_message  NVARCHAR(MAX) NULL
  );
  CREATE INDEX ix_schema_migrations_status ON schema_migrations (status);
END;