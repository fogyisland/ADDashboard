-- verify: table ad_member_servers
-- verify: table ad_server_groups
-- verify: table ad_server_group_members
-- verify: table ad_member_server_packages
-- verify: table alert_rules
-- verify: table alert_rule_state
-- verify: table alert_events
-- verify: table alert_email_outbox

-- 014-member-servers.sql (MSSQL)
-- Mirror of db/migrations/014-member-servers.sql for SQL Server.
-- Uses DATETIME2 + SYSUTCDATETIME() per the canonical schema convention
-- (db/schema/mssql/01-tables.sql); brief's DATETIMEOFFSET was set aside to
-- keep timestamp semantics uniform across all main-schema tables — the
-- ad_* + alert_* code never relies on time-zone offsets.
-- VARCHAR (not NVARCHAR) for hostnames / ids / flags; NVARCHAR(MAX) for
-- the few TEXT-shaped columns (rule condition, event detail, email body
-- html/text). Each CREATE TABLE is wrapped in an IF OBJECT_ID guard for
-- idempotency.

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

IF OBJECT_ID('ad_member_server_packages', 'U') IS NULL
BEGIN
  CREATE TABLE ad_member_server_packages (
    hostname      VARCHAR(128) NOT NULL,
    package_name  VARCHAR(128) NOT NULL,
    enabled       BIT          NOT NULL CONSTRAINT df_msp_enabled DEFAULT 1,
    installed_at  DATETIME2    NOT NULL CONSTRAINT df_msp_installed DEFAULT SYSUTCDATETIME(),
    last_run_at   DATETIME2    NULL,
    CONSTRAINT pk_msp PRIMARY KEY (hostname, package_name),
    CONSTRAINT fk_msp_host FOREIGN KEY (hostname)     REFERENCES ad_member_servers(hostname) ON DELETE CASCADE,
    CONSTRAINT fk_msp_pkg  FOREIGN KEY (package_name) REFERENCES installed_packages(name)   ON DELETE CASCADE
  );
  CREATE INDEX ix_msp_pkg ON ad_member_server_packages (package_name);
END;

IF OBJECT_ID('alert_rules', 'U') IS NULL
BEGIN
  CREATE TABLE alert_rules (
    rule_id           INT IDENTITY(1,1) PRIMARY KEY,
    hostname          VARCHAR(128)   NOT NULL,
    name              VARCHAR(256)   NOT NULL,
    [condition]       NVARCHAR(MAX)  NOT NULL,
    for_minutes       INT            NOT NULL CONSTRAINT df_ar_for_minutes      DEFAULT 5,
    cooldown_minutes  INT            NOT NULL CONSTRAINT df_ar_cooldown         DEFAULT 30,
    recipients        NVARCHAR(MAX)  NULL,
    enabled           BIT            NOT NULL CONSTRAINT df_ar_enabled          DEFAULT 1,
    created_at        DATETIME2      NOT NULL CONSTRAINT df_ar_created          DEFAULT SYSUTCDATETIME(),
    updated_at        DATETIME2      NOT NULL CONSTRAINT df_ar_updated          DEFAULT SYSUTCDATETIME(),
    CONSTRAINT fk_ar_host FOREIGN KEY (hostname) REFERENCES ad_member_servers(hostname) ON DELETE CASCADE
  );
  CREATE INDEX ix_ar_host_enabled ON alert_rules (hostname, enabled);
END;

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
