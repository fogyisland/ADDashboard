-- ============================================================================
-- R158.42 schema baseline (current DB state as authoritative schema)
-- dumped: 2026-10-19T06:47:27Z by scripts/r158.42-dump-schema.mjs
-- dialect: mssql
-- source: 10.170.140.23:1433 / dashboard / dbo
-- ============================================================================
-- This file is the new starting point of the dashboard centre DB schema.
-- All previous 001-053 migrations have been deleted; their cumulative
-- effect is captured here. Forward evolution uses semver (1.0.1 / 1.1.0 /
-- 2.0.0) — see scripts/r158.42-rebase-schema.mjs for the bookkeeping.
-- ============================================================================

-- --------------------------------------------------------------------------
-- Table: [ad_account_change]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_account_change]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_account_change] (
    [sam] NVARCHAR(256) NOT NULL,
    [display_name] NVARCHAR(255) NULL,
    [action] VARCHAR(16) NOT NULL,
    [created_at] DATETIME2 NULL,
    [modified_at] DATETIME2 NULL,
    [change_date] DATE NOT NULL,
    [domain_dn] NVARCHAR(1024) NULL,
    [dc_name] NVARCHAR(128) NOT NULL,
    [collected_at] DATETIME2 NOT NULL,
    [operator_user] NVARCHAR(128) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'pk_ad_account_change')
BEGIN ALTER TABLE [ad_account_change] ADD CONSTRAINT [pk_ad_account_change] PRIMARY KEY ([sam], [action], [change_date]); END;

-- (no secondary indexes on [ad_account_change])

-- (no FOREIGN KEYS on [ad_account_change])

-- --------------------------------------------------------------------------
-- Table: [ad_admin_commands]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_admin_commands]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_admin_commands] (
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [command_type] NVARCHAR(64) NOT NULL,
    [target_dc] NVARCHAR(128) NOT NULL,
    [params_json] NVARCHAR(MAX) NOT NULL,
    [status] NVARCHAR(16) NOT NULL DEFAULT 'queued',
    [operator_id] BIGINT NULL,
    [result_json] NVARCHAR(MAX) NULL,
    [error_message] NVARCHAR(2000) NULL,
    [duration_ms] INT NULL,
    [created_at] DATETIME2 NOT NULL,
    [claimed_at] DATETIME2 NULL,
    [completed_at] DATETIME2 NULL,
    [task_id] NVARCHAR(64) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__ad_admin__3213E83FC9DB99E4')
BEGIN ALTER TABLE [ad_admin_commands] ADD CONSTRAINT [PK__ad_admin__3213E83FC9DB99E4] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_ad_admin_commands_target_status')
BEGIN CREATE NONCLUSTERED INDEX [ix_ad_admin_commands_target_status] ON [ad_admin_commands] ([target_dc], [status]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_ad_admin_commands_status_created')
BEGIN CREATE NONCLUSTERED INDEX [ix_ad_admin_commands_status_created] ON [ad_admin_commands] ([status], [created_at]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_ad_admin_commands_operator')
BEGIN CREATE NONCLUSTERED INDEX [ix_ad_admin_commands_operator] ON [ad_admin_commands] ([operator_id], [created_at]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ux_ad_admin_commands_task_id')
BEGIN CREATE UNIQUE NONCLUSTERED INDEX [ux_ad_admin_commands_task_id] ON [ad_admin_commands] ([task_id]) WHERE ([task_id] IS NOT NULL); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_ad_admin_commands_dc_task')
BEGIN CREATE NONCLUSTERED INDEX [ix_ad_admin_commands_dc_task] ON [ad_admin_commands] ([target_dc], [task_id]); END;

-- (no FOREIGN KEYS on [ad_admin_commands])

-- --------------------------------------------------------------------------
-- Table: [ad_admin_members]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_admin_members]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_admin_members] (
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [domain_dn] NVARCHAR(1024) NOT NULL,
    [group_name] NVARCHAR(64) NOT NULL,
    [member_sam] NVARCHAR(256) NOT NULL,
    [member_dn] NVARCHAR(1024) NULL,
    [member_enabled] BIT NULL,
    [collected_at] DATETIME2 NOT NULL,
    [dc_name] NVARCHAR(128) NOT NULL,
    [run_id] BIGINT NULL,
    [display_name] NVARCHAR(255) NULL,
    -- R161.3 (2026-10-25) — 唯一键改用 PERSISTED 计算列哈希.
    --   旧 uq_admin_member ([domain_dn], [group_name], [member_sam]) =
    --   2050 + 130 + 514 = 2694 字节 > 1700 (非聚集索引键上限) ⇒ 建不出来。
    --   改用 domain_dn 的 SHA-256: 32 字节, 唯一性精确 (整串 DN),
    --   两边言同构 (MySQL 侧是 GENERATED ... STORED 列), 应用层零改动。
    [domain_dn_hash] AS CONVERT(BINARY(32), HASHBYTES('SHA2_256', [domain_dn])) PERSISTED
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__ad_admin_members__id')
BEGIN ALTER TABLE [ad_admin_members] ADD CONSTRAINT [PK__ad_admin_members__id] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_admin_member')
BEGIN CREATE UNIQUE NONCLUSTERED INDEX [uq_admin_member] ON [ad_admin_members] ([domain_dn_hash], [group_name], [member_sam]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_admin_members_collected')
BEGIN CREATE NONCLUSTERED INDEX [ix_admin_members_collected] ON [ad_admin_members] ([collected_at]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_admin_members_group')
BEGIN CREATE NONCLUSTERED INDEX [ix_admin_members_group] ON [ad_admin_members] ([group_name]); END;
-- ix_admin_members_domain_dn 已删 (R161.3): domain_dn = NVARCHAR(1024) = 2050 字节
--   > 1700 (非聚集索引键上限), 而 MSSQL **没有前缀索引** ⇒ 这条索引在 MSSQL 上
--   物理建不出来。MySQL 侧同样删掉 (那边原本是整列进索引 = 4098 字节 > 3072,
--   本来就是非法 DDL)。唯一用到 domain_dn 的地方是 adminMembers.summary() 的
--   相关子查询 `m2.domain_dn = m.domain_dn AND m2.group_name = m.group_name`,
--   而 group_name 那一侧有 ix_admin_members_group 覆盖 (group_name 只有
--   'Domain Admins' / 'Enterprise Admins' 两个值, 过滤性远高于 domain_dn)。
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_admin_members_run')
BEGIN CREATE NONCLUSTERED INDEX [ix_admin_members_run] ON [ad_admin_members] ([run_id]); END;

-- (no FOREIGN KEYS on [ad_admin_members])

-- --------------------------------------------------------------------------
-- Table: [ad_agent_heartbeat]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_agent_heartbeat]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_agent_heartbeat] (
    [agent_id] NVARCHAR(64) NOT NULL,
    [last_heartbeat_at] DATETIME2 NULL,
    [agent_version] NVARCHAR(32) NULL,
    [last_report_at] DATETIME2 NULL,
    [last_report_status] NVARCHAR(32) NULL,
    [pending_queue_size] INT NOT NULL DEFAULT (0),
    [agent_token_version] INT NOT NULL DEFAULT (0),
    [report_requested_at] DATETIME2 NULL,
    [client_settings_version] INT NOT NULL DEFAULT (0),
    [heartbeat_interval_seconds] INT NULL,
    [last_upgrade_event] NVARCHAR(MAX) NULL,
    [health_score] INT NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__ad_agent__2C05379E690ABD13')
BEGIN ALTER TABLE [ad_agent_heartbeat] ADD CONSTRAINT [PK__ad_agent__2C05379E690ABD13] PRIMARY KEY ([agent_id]); END;

-- (no secondary indexes on [ad_agent_heartbeat])

-- (no FOREIGN KEYS on [ad_agent_heartbeat])

-- --------------------------------------------------------------------------
-- Table: [ad_agent_port_status]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_agent_port_status]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_agent_port_status] (
    [agent_id] VARCHAR(64) NOT NULL,
    [port] INT NOT NULL,
    [ok] BIT NOT NULL,
    [latency_ms] INT NULL,
    [last_checked_at] DATETIME2 NOT NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'pk_aps')
BEGIN ALTER TABLE [ad_agent_port_status] ADD CONSTRAINT [pk_aps] PRIMARY KEY ([agent_id], [port]); END;

-- (no secondary indexes on [ad_agent_port_status])

-- (no FOREIGN KEYS on [ad_agent_port_status])

-- --------------------------------------------------------------------------
-- Table: [ad_agent_upgrade_rollout]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_agent_upgrade_rollout]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_agent_upgrade_rollout] (
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [target_version] NVARCHAR(32) NOT NULL,
    [from_version] NVARCHAR(32) NULL,
    [strategy] NVARCHAR(16) NOT NULL,
    [canary_ratio] INT NULL,
    [status] NVARCHAR(16) NOT NULL,
    [created_by] NVARCHAR(64) NOT NULL,
    [created_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime(),
    [activated_at] DATETIME2 NULL,
    [completed_at] DATETIME2 NULL,
    [aborted_at] DATETIME2 NULL,
    [notes] NVARCHAR(500) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__ad_agent__3213E83FF553F52C')
BEGIN ALTER TABLE [ad_agent_upgrade_rollout] ADD CONSTRAINT [PK__ad_agent__3213E83FF553F52C] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_rollout_status_activated')
BEGIN CREATE NONCLUSTERED INDEX [ix_rollout_status_activated] ON [ad_agent_upgrade_rollout] ([status], [activated_at]); END;

-- (no FOREIGN KEYS on [ad_agent_upgrade_rollout])

-- --------------------------------------------------------------------------
-- Table: [ad_computers_snapshot]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_computers_snapshot]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_computers_snapshot] (
    [domain_name] NVARCHAR(128) NOT NULL,
    [sam_account_name] NVARCHAR(256) NOT NULL,
    [cn] NVARCHAR(256) NULL,
    [name] NVARCHAR(256) NULL,
    [distinguished_name] NVARCHAR(1024) NOT NULL,
    [ou_dn] NVARCHAR(1024) NULL,
    [enabled] BIT NULL,
    [is_server] BIT NULL,
    [operating_system] NVARCHAR(512) NULL,
    [operating_system_version] NVARCHAR(128) NULL,
    [dns_host_name] NVARCHAR(256) NULL,
    [last_logon] DATETIME2 NULL,
    [when_created] DATETIME2 NULL,
    [when_changed] DATETIME2 NULL,
    [description] NVARCHAR(1024) NULL,
    [managed_by_dn] NVARCHAR(256) NULL,
    [managed_by_sam] NVARCHAR(256) NULL,
    [snapshot_at] DATETIME2 NOT NULL,
    [snapshot_run_id] BIGINT NOT NULL,
    [forest_id] BIGINT NULL,
    [domain_id] BIGINT NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'pk_ad_computers_snapshot')
BEGIN ALTER TABLE [ad_computers_snapshot] ADD CONSTRAINT [pk_ad_computers_snapshot] PRIMARY KEY ([domain_name], [sam_account_name]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_computers_forest_dc')
BEGIN CREATE NONCLUSTERED INDEX [idx_computers_forest_dc] ON [ad_computers_snapshot] ([forest_id], [domain_name]); END;
-- ix_computers_ou_dn 在 MSSQL 上**建不出来** (R161.3): ou_dn = NVARCHAR(1024)
--   = 2050 字节 > 1700 (非聚集索引键上限), 而 SQL Server **没有前缀索引**,
--   也没有"只索引列的前 N 个字符"这种机制 ⇒ 只能不要这个索引。
--   ⚠ 修正 (R161.3 实测): 早先这里写的是"MySQL 前缀索引只服务 col LIKE
--   'prefix%', 服务不了 ou_dn = <完整DN>" —— **实测为假**。MySQL 5.7 实测
--   (2000 行表, EXPLAIN):
--       ou_dn = ? (37 字符 DN)   → type=ref  key=ix_computers_ou_dn  rows=1
--       ou_dn = ? (197 字符 DN)  → type=ref  key=ix_computers_ou_dn  rows=1
--       删掉该索引后            → type=ALL  key=null               rows=1852
--   即 MySQL 的前缀索引**确实**服务完整值等值 (短于前缀长度的值走 ref; 超过
--   前缀长度的值仍走 ref + 回表逐行过滤)。所以 **MySQL 侧保留** ou_dn(191)
--   前缀索引, 双方言在此处是**引擎能力差异导致的必然分歧**, 不是疏漏。
--   MSSQL 侧退化为扫描: ou_dn 只出现在 admin.js / mcp.js 的 OU 下钻里,
--   谓词是 `ou_dn = ? OR (',' + ou_dn + ',') LIKE ? ESCAPE '\'`, 其中 OR 的
--   另一支在列上套了表达式 ⇒ 不可 sargable (这一点两边言都一样)。
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_computers_enabled')
BEGIN CREATE NONCLUSTERED INDEX [ix_computers_enabled] ON [ad_computers_snapshot] ([enabled]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_computers_is_server')
BEGIN CREATE NONCLUSTERED INDEX [ix_computers_is_server] ON [ad_computers_snapshot] ([is_server]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_computers_snapshot_at')
BEGIN CREATE NONCLUSTERED INDEX [ix_computers_snapshot_at] ON [ad_computers_snapshot] ([snapshot_at]); END;

-- (no FOREIGN KEYS on [ad_computers_snapshot])

-- --------------------------------------------------------------------------
-- Table: [ad_dc_overview]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_dc_overview]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_dc_overview] (
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [collected_at] DATETIME2 NOT NULL,
    [agent_id] NVARCHAR(64) NOT NULL,
    [dc_name] NVARCHAR(128) NOT NULL,
    [site_id] INT NULL,
    [users_count] INT NULL,
    [groups_count] INT NULL,
    [gpos_count] INT NULL,
    [partner_port_status] NVARCHAR(MAX) NULL,
    [computers_count] INT NULL,
    [servers_count] INT NULL
    -- R158.X.116.b (2026-10-22) 删掉 4 列: is_pdc / is_hub /
    --   last_heartbeat_at / snapshot_at。全部是 collect 链路不写的死列,
    --   真源分别在 ad_dcs.is_pdc / ad_sites.is_hub / ad_agent_heartbeat
    --   (代码走 LEFT JOIN 取, sql.js:452-455/3960-3963), snapshot_at 全项目零引用。
    --   留着 last_heartbeat_at 更糟: sql.js 里的 COALESCE(h.x, d.x) fallback
    --   引用它, 而 MySQL 从未建该列 → MySQL 部署 ER_BAD_FIELD_ERROR。fallback
    --   已一并删除, 这 4 列现在无人读。
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__ad_dc_ov__3213E83FF4CDCEBA')
BEGIN ALTER TABLE [ad_dc_overview] ADD CONSTRAINT [PK__ad_dc_ov__3213E83FF4CDCEBA] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_dc_overview_dc')
BEGIN CREATE UNIQUE NONCLUSTERED INDEX [uq_dc_overview_dc] ON [ad_dc_overview] ([dc_name]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_dc_overview_collected')
BEGIN CREATE NONCLUSTERED INDEX [ix_dc_overview_collected] ON [ad_dc_overview] ([collected_at]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_dc_overview_site')
BEGIN CREATE NONCLUSTERED INDEX [ix_dc_overview_site] ON [ad_dc_overview] ([site_id]); END;

-- fk_dc_overview_site: 延后到文末 "Foreign keys (deferred)" 段 (R161.6)
--   R161.6 (2026-10-26) — **补齐方言对等**。此前 MySQL 侧有内联外键
--   fk_dc_overview_site (ad_dc_overview.site_id -> ad_sites.site_id),
--   MSSQL 侧**完全没有**这条外键 —— 全库 23 条外键里就差这一条
--   (逐名比对两份 baseline 的 CONSTRAINT 清单得出)。
--   ⇒ 同一个写入在两种方言上行为不同: MySQL 会拒掉悬空 site_id,
--     MSSQL 会照收 ⇒ 跨方言的库结构不可比。
--   安全性论证 (为什么补上不会炸存量库):
--     · 写路径 center/src/services/dc-overview.js:60-95 里 site_id 的来源
--       优先级是 ad_dcs.site_id (中心侧目录, canonical) -> agent 上报的
--       payload.siteId -> NULL;
--     · ad_dcs.site_id 自己就有外键 fk_dcs_site -> ad_sites(site_id),
--       所以 canonical 路径给出的 site_id **必然**存在于 ad_sites;
--     · agent 侧 packages/ad_dc_overview/*/collect.ps1 明确
--       `site_id = $null` (注释: "site_id resolution happens at the centre
--       side from agent_id via the existing ad_dcs table — agent does not
--       carry site_id mapping") ⇒ payload 路径实际永远是 NULL。
--     ⇒ 悬空 site_id 不可达 ⇒ 新装库 0 风险; 存量库若真有悬空行,
--       ADD CONSTRAINT 会报 Msg 547 明确报错 (而不是静默写坏数据)。
--   类型匹配: ad_sites.[site_id] INT IDENTITY(1,1) NOT NULL (PK)
--              ad_dc_overview.[site_id] INT NULL  —— INT → INT, 子列可空, 合法。

-- --------------------------------------------------------------------------
-- Table: [ad_dcs]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_dcs]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_dcs] (
    [dc_name] NVARCHAR(128) NOT NULL,
    [site_id] INT NULL,
    [ip_address] NVARCHAR(64) NULL,
    [os_version] NVARCHAR(64) NULL,
    [is_pdc] BIT NOT NULL DEFAULT (0),
    [when_created] DATETIME2 NULL,
    [is_gc] BIT NOT NULL DEFAULT (0),
    [is_rid_master] BIT NOT NULL DEFAULT (0),
    [is_schema_master] BIT NOT NULL DEFAULT (0),
    [is_domain_naming_master] BIT NOT NULL DEFAULT (0),
    [is_infrastructure_master] BIT NOT NULL DEFAULT (0),
    [is_bridgehead] BIT NOT NULL DEFAULT (0),
    [site_hint] NVARCHAR(64) NULL,
    [discovered_at] DATETIME2 NULL,
    [discovered_by_agent_id] NVARCHAR(64) NULL,
    [forest_domain_id] BIGINT NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__ad_dcs__11E0288310C7602A')
BEGIN ALTER TABLE [ad_dcs] ADD CONSTRAINT [PK__ad_dcs__11E0288310C7602A] PRIMARY KEY ([dc_name]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_ad_dcs_forest_domain')
BEGIN CREATE NONCLUSTERED INDEX [idx_ad_dcs_forest_domain] ON [ad_dcs] ([forest_domain_id]); END;

-- fk_dcs_site: 延后到文末 "Foreign keys (deferred)" 段 (R161.3)

-- --------------------------------------------------------------------------
-- Table: [ad_directory_sync_runs]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_directory_sync_runs]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_directory_sync_runs] (
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [dc_name] NVARCHAR(128) NOT NULL,
    [started_at] DATETIME2 NOT NULL,
    [finished_at] DATETIME2 NULL,
    [status] NVARCHAR(16) NOT NULL DEFAULT 'running',
    [user_count] INT NULL,
    [group_count] INT NULL,
    [ou_count] INT NULL,
    [error_message] NVARCHAR(2000) NULL,
    [triggered_by] NVARCHAR(16) NOT NULL DEFAULT 'manual',
    [forest_id] BIGINT NULL,
    [domain_id] BIGINT NULL,
    [computer_count] INT NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__ad_direc__3213E83FED185C0D')
BEGIN ALTER TABLE [ad_directory_sync_runs] ADD CONSTRAINT [PK__ad_direc__3213E83FED185C0D] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_sync_runs_started')
BEGIN CREATE NONCLUSTERED INDEX [ix_sync_runs_started] ON [ad_directory_sync_runs] ([started_at]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_sync_runs_dc_status')
BEGIN CREATE NONCLUSTERED INDEX [ix_sync_runs_dc_status] ON [ad_directory_sync_runs] ([dc_name], [status]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_runs_forest_started')
BEGIN CREATE NONCLUSTERED INDEX [idx_runs_forest_started] ON [ad_directory_sync_runs] ([forest_id], [started_at]); END;

-- (no FOREIGN KEYS on [ad_directory_sync_runs])

-- --------------------------------------------------------------------------
-- Table: [ad_eventlog_events]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_eventlog_events]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_eventlog_events] (
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [collected_at] DATETIME2 NOT NULL,
    [agent_id] VARCHAR(64) NOT NULL,
    [dc_name] VARCHAR(128) NOT NULL,
    [channel] VARCHAR(32) NOT NULL,
    [severity] VARCHAR(16) NOT NULL,
    [event_id] INT NOT NULL,
    [record_id] BIGINT NOT NULL,
    [message] NVARCHAR(MAX) NOT NULL,
    [ts] DATETIME2 NOT NULL,
    [audit_failure] BIT NOT NULL DEFAULT (0)
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__ad_event__3213E83FFB961EC2')
BEGIN ALTER TABLE [ad_eventlog_events] ADD CONSTRAINT [PK__ad_event__3213E83FFB961EC2] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_eventlog_collected')
BEGIN CREATE NONCLUSTERED INDEX [ix_eventlog_collected] ON [ad_eventlog_events] ([collected_at]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_eventlog_dc_channel')
BEGIN CREATE NONCLUSTERED INDEX [ix_eventlog_dc_channel] ON [ad_eventlog_events] ([dc_name], [channel], [ts]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_eventlog_severity')
BEGIN CREATE NONCLUSTERED INDEX [ix_eventlog_severity] ON [ad_eventlog_events] ([severity], [ts]); END;

-- (no FOREIGN KEYS on [ad_eventlog_events])

-- --------------------------------------------------------------------------
-- Table: [ad_eventlog_summary]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_eventlog_summary]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_eventlog_summary] (
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [collected_at] DATETIME2 NOT NULL,
    [agent_id] VARCHAR(64) NOT NULL,
    [dc_name] VARCHAR(128) NOT NULL,
    [channel] VARCHAR(32) NOT NULL,
    [warning_count] INT NOT NULL DEFAULT (0),
    [error_count] INT NOT NULL DEFAULT (0),
    [audit_failure_count] INT NOT NULL DEFAULT (0),
    [dropped_count] INT NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__ad_event__3213E83F618CCC53')
BEGIN ALTER TABLE [ad_eventlog_summary] ADD CONSTRAINT [PK__ad_event__3213E83F618CCC53] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_eventlog_summary_dc_channel_collected')
BEGIN CREATE UNIQUE NONCLUSTERED INDEX [uq_eventlog_summary_dc_channel_collected] ON [ad_eventlog_summary] ([dc_name], [channel], [collected_at]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_eventlog_summary_collected')
BEGIN CREATE NONCLUSTERED INDEX [ix_eventlog_summary_collected] ON [ad_eventlog_summary] ([collected_at]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_eventlog_summary_dc')
BEGIN CREATE NONCLUSTERED INDEX [ix_eventlog_summary_dc] ON [ad_eventlog_summary] ([dc_name]); END;

-- (no FOREIGN KEYS on [ad_eventlog_summary])

-- --------------------------------------------------------------------------
-- Table: [ad_failed_logon_events]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_failed_logon_events]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_failed_logon_events] (
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [occurred_at] DATETIME2 NOT NULL,
    [collected_at] DATETIME2 NOT NULL,
    [agent_id] NVARCHAR(256) NOT NULL,
    [dc_name] NVARCHAR(256) NOT NULL,
    [event_record_id] BIGINT NOT NULL,
    [target_user_name] NVARCHAR(256) NULL,
    [target_user_display_name] NVARCHAR(256) NULL,
    [target_domain_name] NVARCHAR(256) NULL,
    [target_sid] NVARCHAR(256) NULL,
    [subject_user_name] NVARCHAR(256) NULL,
    [subject_domain_name] NVARCHAR(256) NULL,
    [caller_computer_name] NVARCHAR(256) NULL,
    [ip_address] NVARCHAR(64) NULL,
    [ip_port] NVARCHAR(16) NULL,
    [logon_type] INT NULL,
    [logon_process_name] NVARCHAR(64) NULL,
    [auth_package_name] NVARCHAR(64) NULL,
    [failure_reason] NVARCHAR(64) NULL,
    [status] NVARCHAR(64) NULL,
    [workstation_name] NVARCHAR(256) NULL,
    [error_code] INT NOT NULL DEFAULT (0)
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__ad_failed_logon_events__id')
BEGIN ALTER TABLE [ad_failed_logon_events] ADD CONSTRAINT [PK__ad_failed_logon_events__id] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_failed_logon_dc_record')
BEGIN CREATE UNIQUE NONCLUSTERED INDEX [uq_failed_logon_dc_record] ON [ad_failed_logon_events] ([dc_name], [event_record_id]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_failed_logon_occurred_at')
BEGIN CREATE NONCLUSTERED INDEX [ix_failed_logon_occurred_at] ON [ad_failed_logon_events] ([occurred_at]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_failed_logon_target_time')
BEGIN CREATE NONCLUSTERED INDEX [ix_failed_logon_target_time] ON [ad_failed_logon_events] ([target_user_name], [occurred_at]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_failed_logon_dc_time')
BEGIN CREATE NONCLUSTERED INDEX [ix_failed_logon_dc_time] ON [ad_failed_logon_events] ([dc_name], [occurred_at]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_failed_logon_ip_time')
BEGIN CREATE NONCLUSTERED INDEX [ix_failed_logon_ip_time] ON [ad_failed_logon_events] ([ip_address], [occurred_at]); END;

-- (no FOREIGN KEYS on [ad_failed_logon_events])

-- --------------------------------------------------------------------------
-- Table: [ad_feature_flags]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_feature_flags]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_feature_flags] (
    [key] VARCHAR(64) NOT NULL,
    [value] VARCHAR(255) NULL,
    [description] VARCHAR(255) NULL,
    [updated_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime(),
    [updated_by] VARCHAR(64) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK_ad_feature_flags')
BEGIN ALTER TABLE [ad_feature_flags] ADD CONSTRAINT [PK_ad_feature_flags] PRIMARY KEY ([key]); END;

-- (no secondary indexes on [ad_feature_flags])

-- (no FOREIGN KEYS on [ad_feature_flags])

-- --------------------------------------------------------------------------
-- Table: [ad_forest]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_forest]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_forest] (
    [id] INT IDENTITY(1,1) NOT NULL,
    [forest_name] NVARCHAR(128) NOT NULL,
    [root_dn] NVARCHAR(512) NOT NULL,
    [ad_url] NVARCHAR(512) NOT NULL,
    [bind_dn] NVARCHAR(512) NOT NULL,
    [bind_password] VARBINARY(1024) NOT NULL,   -- R161.6: AES-256-GCM 密文 Buffer (与 MySQL 侧 VARBINARY 对齐)
    [description] NVARCHAR(512) NULL,
    [is_default] BIT NOT NULL DEFAULT (0),
    [created_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime(),
    [updated_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime()
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'pk_ad_forest')
BEGIN ALTER TABLE [ad_forest] ADD CONSTRAINT [pk_ad_forest] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_ad_forest_name')
BEGIN CREATE UNIQUE NONCLUSTERED INDEX [uq_ad_forest_name] ON [ad_forest] ([forest_name]); END;

-- R161.6 (2026-10-26) — bind_password 类型对齐 (MySQL 侧是 VARBINARY(1024))。
--   bind_password 存的是 ad-credential-vault.js 的 AES-256-GCM 密文 **Buffer**
--   (service 层把 base64 密文解回 Buffer 再写库), MySQL 侧列类型是
--   VARBINARY(1024) —— 但 MSSQL 侧一直声明成 VARCHAR(1024) ⇒ 双方言列类型
--   不一致, 且 VARBINARY 参数写进 VARCHAR 列会被 SQL Server 拒绝
--   (4133: Implicit conversion from data type varbinary to varchar is not allowed)。
--   新建库: 上面 CREATE TABLE 里已直接声明 VARBINARY(1024)。
--   存量库: 下面这段守卫把列改型 (只在列**还是** varchar 时才动, 已是
--     varbinary 的直接跳过)。改型是安全的 —— 老路径下这条 INSERT 一直
--     抛异常 (驱动把 Buffer 当 NVarChar 绑 ⇒ tedious 'Invalid string.')，
--     所以 MSSQL 侧的 ad_forest 表从来没能插进过带密码的行, 列里没有
--     需要保留的密文。
IF EXISTS (SELECT 1 FROM sys.columns
           WHERE object_id = OBJECT_ID('[ad_forest]')
             AND name = 'bind_password'
             AND system_type_id = TYPE_ID('varchar'))
BEGIN
  ALTER TABLE [ad_forest] ALTER COLUMN [bind_password] VARBINARY(1024) NOT NULL;
END;

-- (no FOREIGN KEYS on [ad_forest])

-- --------------------------------------------------------------------------
-- Table: [ad_forest_dc_assignment]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_forest_dc_assignment]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_forest_dc_assignment] (
    [id] INT IDENTITY(1,1) NOT NULL,
    [forest_id] INT NOT NULL,
    [domain_id] INT NOT NULL,
    [dc_hostname] NVARCHAR(256) NOT NULL,
    [site_id] INT NULL,
    [assigned_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime()
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'pk_ad_forest_dc_assignment')
BEGIN ALTER TABLE [ad_forest_dc_assignment] ADD CONSTRAINT [pk_ad_forest_dc_assignment] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_forest_dc_hostname')
BEGIN CREATE UNIQUE NONCLUSTERED INDEX [uq_forest_dc_hostname] ON [ad_forest_dc_assignment] ([dc_hostname]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_forest_dc_forest')
BEGIN CREATE NONCLUSTERED INDEX [ix_forest_dc_forest] ON [ad_forest_dc_assignment] ([forest_id]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_forest_dc_domain')
BEGIN CREATE NONCLUSTERED INDEX [ix_forest_dc_domain] ON [ad_forest_dc_assignment] ([domain_id]); END;

-- fk_forest_dc_domain: 延后到文末 "Foreign keys (deferred)" 段 (R161.3)
-- fk_forest_dc_forest: 延后到文末 "Foreign keys (deferred)" 段 (R161.3)

-- --------------------------------------------------------------------------
-- Table: [ad_forest_domain]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_forest_domain]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_forest_domain] (
    [id] INT IDENTITY(1,1) NOT NULL,
    [forest_id] INT NOT NULL,
    [domain_dn] NVARCHAR(512) NOT NULL,
    [domain_name] NVARCHAR(128) NOT NULL,
    [role] NVARCHAR(32) NOT NULL,
    [trust_direction] NVARCHAR(16) NULL,
    [dc_hostname] NVARCHAR(256) NULL,
    [is_pdc] BIT NOT NULL DEFAULT (0),
    [created_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime(),
    [sync_enabled] BIT NOT NULL DEFAULT (1)
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'pk_ad_forest_domain')
BEGIN ALTER TABLE [ad_forest_domain] ADD CONSTRAINT [pk_ad_forest_domain] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_forest_domain')
BEGIN CREATE UNIQUE NONCLUSTERED INDEX [uq_forest_domain] ON [ad_forest_domain] ([forest_id], [domain_dn]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_forest_domain_forest')
BEGIN CREATE NONCLUSTERED INDEX [ix_forest_domain_forest] ON [ad_forest_domain] ([forest_id]); END;

-- fk_forest_domain_forest: 延后到文末 "Foreign keys (deferred)" 段 (R161.3)

-- --------------------------------------------------------------------------
-- Table: [ad_forest_domain_setting]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_forest_domain_setting]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_forest_domain_setting] (
    [id] INT IDENTITY(1,1) NOT NULL,
    [domain_id] INT NOT NULL,
    [setting_key] NVARCHAR(128) NOT NULL,
    [setting_value] NVARCHAR(2048) NULL,
    [updated_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime()
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'pk_ad_forest_domain_setting')
BEGIN ALTER TABLE [ad_forest_domain_setting] ADD CONSTRAINT [pk_ad_forest_domain_setting] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_forest_domain_setting')
BEGIN CREATE UNIQUE NONCLUSTERED INDEX [uq_forest_domain_setting] ON [ad_forest_domain_setting] ([domain_id], [setting_key]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_forest_domain_setting_domain')
BEGIN CREATE NONCLUSTERED INDEX [ix_forest_domain_setting_domain] ON [ad_forest_domain_setting] ([domain_id]); END;

-- fk_forest_domain_setting_domain: 延后到文末 "Foreign keys (deferred)" 段 (R161.3)

-- --------------------------------------------------------------------------
-- Table: [ad_forest_setting]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_forest_setting]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_forest_setting] (
    [id] INT IDENTITY(1,1) NOT NULL,
    [forest_id] INT NOT NULL,
    [setting_key] NVARCHAR(128) NOT NULL,
    [setting_value] NVARCHAR(2048) NULL,
    [updated_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime()
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'pk_ad_forest_setting')
BEGIN ALTER TABLE [ad_forest_setting] ADD CONSTRAINT [pk_ad_forest_setting] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_forest_setting')
BEGIN CREATE UNIQUE NONCLUSTERED INDEX [uq_forest_setting] ON [ad_forest_setting] ([forest_id], [setting_key]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_forest_setting_forest')
BEGIN CREATE NONCLUSTERED INDEX [ix_forest_setting_forest] ON [ad_forest_setting] ([forest_id]); END;

-- fk_forest_setting_forest: 延后到文末 "Foreign keys (deferred)" 段 (R161.3)

-- --------------------------------------------------------------------------
-- Table: [ad_groups_snapshot]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_groups_snapshot]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_groups_snapshot] (
    [domain_name] NVARCHAR(128) NOT NULL,
    [name] NVARCHAR(256) NOT NULL,
    [sam_account_name] NVARCHAR(256) NULL,
    [distinguished_name] NVARCHAR(1024) NOT NULL,
    [group_type] INT NULL,
    [group_scope] NVARCHAR(16) NULL,
    [description] NVARCHAR(2048) NULL,
    [member_count] INT NULL,
    [snapshot_at] DATETIME2 NOT NULL,
    [snapshot_run_id] BIGINT NOT NULL,
    [forest_id] BIGINT NULL,
    [domain_id] BIGINT NULL,
    [ou_dn] NVARCHAR(1024) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'pk_ad_groups_snapshot')
BEGIN ALTER TABLE [ad_groups_snapshot] ADD CONSTRAINT [pk_ad_groups_snapshot] PRIMARY KEY ([domain_name], [name]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_groups_snapshot_at')
BEGIN CREATE NONCLUSTERED INDEX [ix_groups_snapshot_at] ON [ad_groups_snapshot] ([snapshot_at]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_groups_forest_dc')
BEGIN CREATE NONCLUSTERED INDEX [idx_groups_forest_dc] ON [ad_groups_snapshot] ([forest_id], [domain_name]); END;

-- (no FOREIGN KEYS on [ad_groups_snapshot])

-- --------------------------------------------------------------------------
-- Table: [ad_license_request]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_license_request]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_license_request] (
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [request_id] VARCHAR(128) NOT NULL,
    [company] VARCHAR(128) NOT NULL,
    [mac_address] VARCHAR(64) NOT NULL,
    [months] INT NOT NULL,
    [max_nodes] INT NOT NULL,
    [installed_at] VARCHAR(32) NULL,
    [signature] VARCHAR(64) NULL,
    [instance_id] VARCHAR(64) NOT NULL,
    [kind] VARCHAR(16) NOT NULL DEFAULT 'base32',
    [json_path] VARCHAR(512) NOT NULL,
    [verified_at] DATETIME2 NULL,
    [activated_at] DATETIME2 NULL,
    [license_id] BIGINT NULL,
    [created_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime(),
    [updated_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime()
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__ad_licen__3213E83FED59C669')
BEGIN ALTER TABLE [ad_license_request] ADD CONSTRAINT [PK__ad_licen__3213E83FED59C669] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ__ad_licen__18D3B90EF52BA2CE')
BEGIN CREATE UNIQUE NONCLUSTERED INDEX [UQ__ad_licen__18D3B90EF52BA2CE] ON [ad_license_request] ([request_id]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_license_request_instance')
BEGIN CREATE NONCLUSTERED INDEX [ix_license_request_instance] ON [ad_license_request] ([instance_id], [created_at] DESC); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_license_request_kind')
BEGIN CREATE NONCLUSTERED INDEX [ix_license_request_kind] ON [ad_license_request] ([kind], [created_at] DESC); END;

-- (no FOREIGN KEYS on [ad_license_request])

-- --------------------------------------------------------------------------
-- Table: [ad_lockout_events]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_lockout_events]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_lockout_events] (
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [occurred_at] DATETIME2 NOT NULL,
    [collected_at] DATETIME2 NOT NULL,
    [agent_id] VARCHAR(64) NOT NULL,
    [dc_name] VARCHAR(128) NOT NULL,
    [event_record_id] BIGINT NOT NULL,
    [target_user_name] VARCHAR(256) NOT NULL,
    [subject_user_name] VARCHAR(256) NULL,
    [subject_domain] VARCHAR(256) NULL,
    [caller_computer_name] VARCHAR(256) NULL,
    [target_user_display_name] VARCHAR(512) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__ad_locko__3213E83F74BE5E0E')
BEGIN ALTER TABLE [ad_lockout_events] ADD CONSTRAINT [PK__ad_locko__3213E83F74BE5E0E] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_lockout_dc_record')
BEGIN CREATE UNIQUE NONCLUSTERED INDEX [uq_lockout_dc_record] ON [ad_lockout_events] ([dc_name], [event_record_id]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_lockout_target_time')
BEGIN CREATE NONCLUSTERED INDEX [ix_lockout_target_time] ON [ad_lockout_events] ([target_user_name], [occurred_at]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_lockout_caller_time')
BEGIN CREATE NONCLUSTERED INDEX [ix_lockout_caller_time] ON [ad_lockout_events] ([caller_computer_name], [occurred_at]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_lockout_dc_time')
BEGIN CREATE NONCLUSTERED INDEX [ix_lockout_dc_time] ON [ad_lockout_events] ([dc_name], [occurred_at]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_lockout_occurred')
BEGIN CREATE NONCLUSTERED INDEX [ix_lockout_occurred] ON [ad_lockout_events] ([occurred_at]); END;

-- (no FOREIGN KEYS on [ad_lockout_events])

-- --------------------------------------------------------------------------
-- Table: [ad_member_admin_groups]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_member_admin_groups]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_member_admin_groups] (
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [hostname] NVARCHAR(128) NOT NULL,
    [group_name] NVARCHAR(64) NOT NULL,
    [member_sid] NVARCHAR(128) NOT NULL,
    [member_name] NVARCHAR(256) NULL,
    [member_class] NVARCHAR(16) NULL,
    [principal_source] NVARCHAR(16) NULL,
    [is_enabled] BIT NULL,
    [display_name] NVARCHAR(256) NULL,
    [collected_at] DATETIME2 NOT NULL,
    [run_id] BIGINT NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'pk_member_admin_groups')
BEGIN ALTER TABLE [ad_member_admin_groups] ADD CONSTRAINT [pk_member_admin_groups] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_member_admin_group')
BEGIN CREATE UNIQUE NONCLUSTERED INDEX [uq_member_admin_group] ON [ad_member_admin_groups] ([hostname], [group_name], [member_sid]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_member_admin_hostname')
BEGIN CREATE NONCLUSTERED INDEX [idx_member_admin_hostname] ON [ad_member_admin_groups] ([hostname]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_member_admin_collected_at')
BEGIN CREATE NONCLUSTERED INDEX [idx_member_admin_collected_at] ON [ad_member_admin_groups] ([collected_at]); END;

-- (no FOREIGN KEYS on [ad_member_admin_groups])

-- --------------------------------------------------------------------------
-- Table: [ad_member_commands]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_member_commands]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_member_commands] (
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [hostname] NVARCHAR(128) NOT NULL,
    [command_type] NVARCHAR(64) NOT NULL,
    [params_json] NVARCHAR(MAX) NOT NULL,
    [status] NVARCHAR(16) NOT NULL DEFAULT 'queued',
    [operator_id] BIGINT NULL,
    [result_json] NVARCHAR(MAX) NULL,
    [error_message] NVARCHAR(2000) NULL,
    [duration_ms] INT NULL,
    [created_at] DATETIME2 NOT NULL,
    [claimed_at] DATETIME2 NULL,
    [completed_at] DATETIME2 NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__ad_membe__3213E83F2DA322C1')
BEGIN ALTER TABLE [ad_member_commands] ADD CONSTRAINT [PK__ad_membe__3213E83F2DA322C1] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_member_commands_host_status')
BEGIN CREATE NONCLUSTERED INDEX [ix_member_commands_host_status] ON [ad_member_commands] ([hostname], [status]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_member_commands_status_created')
BEGIN CREATE NONCLUSTERED INDEX [ix_member_commands_status_created] ON [ad_member_commands] ([status], [created_at]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_member_commands_operator')
BEGIN CREATE NONCLUSTERED INDEX [ix_member_commands_operator] ON [ad_member_commands] ([operator_id], [created_at]); END;

-- (no FOREIGN KEYS on [ad_member_commands])

-- --------------------------------------------------------------------------
-- Table: [ad_member_eventlog_events]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_member_eventlog_events]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_member_eventlog_events] (
    [collected_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime(),
    [agent_id] VARCHAR(64) NOT NULL,
    [hostname] VARCHAR(128) NOT NULL,
    [channel] VARCHAR(32) NOT NULL,
    [severity] VARCHAR(16) NOT NULL,
    [event_id] INT NOT NULL,
    [record_id] BIGINT NOT NULL,
    [message] NVARCHAR(4000) NULL,
    [ts] DATETIME2 NOT NULL,
    [audit_failure] BIT NOT NULL DEFAULT (0)
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'pk_ad_member_eventlog_events')
BEGIN ALTER TABLE [ad_member_eventlog_events] ADD CONSTRAINT [pk_ad_member_eventlog_events] PRIMARY KEY ([hostname], [channel], [record_id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_ad_member_eventlog_events_host_channel_ts')
BEGIN CREATE NONCLUSTERED INDEX [ix_ad_member_eventlog_events_host_channel_ts] ON [ad_member_eventlog_events] ([hostname], [channel], [ts] DESC); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_ad_member_eventlog_events_collected_at')
BEGIN CREATE NONCLUSTERED INDEX [ix_ad_member_eventlog_events_collected_at] ON [ad_member_eventlog_events] ([collected_at]); END;

-- fk_ad_member_eventlog_events_host: 延后到文末 "Foreign keys (deferred)" 段 (R161.3)

-- --------------------------------------------------------------------------
-- Table: [ad_member_eventlog_summary]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_member_eventlog_summary]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_member_eventlog_summary] (
    [collected_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime(),
    [agent_id] VARCHAR(64) NOT NULL,
    [hostname] VARCHAR(128) NOT NULL,
    [channel] VARCHAR(32) NOT NULL,
    [warning_count] INT NOT NULL DEFAULT (0),
    [error_count] INT NOT NULL DEFAULT (0),
    [audit_failure_count] INT NOT NULL DEFAULT (0),
    [dropped_count] INT NOT NULL DEFAULT (0)
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'pk_ad_member_eventlog_summary')
BEGIN ALTER TABLE [ad_member_eventlog_summary] ADD CONSTRAINT [pk_ad_member_eventlog_summary] PRIMARY KEY ([hostname], [channel], [collected_at]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_ad_member_eventlog_summary_collected_at')
BEGIN CREATE NONCLUSTERED INDEX [ix_ad_member_eventlog_summary_collected_at] ON [ad_member_eventlog_summary] ([collected_at]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_ad_member_eventlog_summary_host_collected')
BEGIN CREATE NONCLUSTERED INDEX [ix_ad_member_eventlog_summary_host_collected] ON [ad_member_eventlog_summary] ([hostname], [collected_at] DESC); END;

-- fk_ad_member_eventlog_summary_host: 延后到文末 "Foreign keys (deferred)" 段 (R161.3)

-- --------------------------------------------------------------------------
-- Table: [ad_member_heartbeat]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_member_heartbeat]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_member_heartbeat] (
    [hostname] VARCHAR(128) NOT NULL,
    [agent_id] VARCHAR(64) NOT NULL,
    [agent_type] VARCHAR(16) NOT NULL DEFAULT 'non-ad',
    [agent_version] VARCHAR(32) NULL,
    [last_heartbeat_at] DATETIME2 NULL,
    [last_report_at] DATETIME2 NULL,
    [last_report_status] VARCHAR(32) NULL,
    [pending_queue_size] INT NOT NULL DEFAULT (0),
    [heartbeat_interval_seconds] INT NULL,
    [report_requested_at] DATETIME2 NULL,
    [client_settings_version] INT NOT NULL DEFAULT (0),
    [agent_token_version] INT NOT NULL DEFAULT (0),
    [last_upgrade_event] VARCHAR(64) NULL,
    [created_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime(),
    [updated_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime()
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'pk_ad_member_heartbeat')
BEGIN ALTER TABLE [ad_member_heartbeat] ADD CONSTRAINT [pk_ad_member_heartbeat] PRIMARY KEY ([hostname]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_ad_member_heartbeat_last_hb')
BEGIN CREATE NONCLUSTERED INDEX [ix_ad_member_heartbeat_last_hb] ON [ad_member_heartbeat] ([last_heartbeat_at]); END;

-- fk_ad_member_heartbeat_host: 延后到文末 "Foreign keys (deferred)" 段 (R161.3)

-- --------------------------------------------------------------------------
-- Table: [ad_member_os_baseline]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_member_os_baseline]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_member_os_baseline] (
    [collected_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime(),
    [agent_id] VARCHAR(64) NOT NULL,
    [hostname] VARCHAR(128) NOT NULL,
    [cpu_pct] FLOAT NULL,
    [memory_pct] FLOAT NULL,
    [c_used_pct] FLOAT NULL,
    [disk_free_bytes] BIGINT NULL,
    [services_count] INT NOT NULL DEFAULT (0),
    [disk_free] NVARCHAR(MAX) NULL,
    [disk_total] NVARCHAR(MAX) NULL,
    [disks] NVARCHAR(MAX) NULL,
    [services] NVARCHAR(MAX) NULL,
    [events] NVARCHAR(MAX) NULL,
    [bios_info] NVARCHAR(MAX) NULL,
    [cpu_brand] NVARCHAR(128) NULL,
    [mem_total_bytes] BIGINT NULL,
    [system_info] NVARCHAR(MAX) NULL,
    [network_info] NVARCHAR(MAX) NULL,
    [memory_modules] NVARCHAR(MAX) NULL,
    [motherboard] NVARCHAR(MAX) NULL,
    [cpu] NVARCHAR(MAX) NULL,
    [ips] NVARCHAR(MAX) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'pk_ad_member_os_baseline')
BEGIN ALTER TABLE [ad_member_os_baseline] ADD CONSTRAINT [pk_ad_member_os_baseline] PRIMARY KEY ([hostname], [collected_at]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_ad_member_os_baseline_host_collected')
BEGIN CREATE NONCLUSTERED INDEX [ix_ad_member_os_baseline_host_collected] ON [ad_member_os_baseline] ([hostname], [collected_at] DESC); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_ad_member_os_baseline_collected_at')
BEGIN CREATE NONCLUSTERED INDEX [ix_ad_member_os_baseline_collected_at] ON [ad_member_os_baseline] ([collected_at]); END;

-- fk_ad_member_os_baseline_host: 延后到文末 "Foreign keys (deferred)" 段 (R161.3)

-- --------------------------------------------------------------------------
-- Table: [ad_member_os_baseline_latest]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_member_os_baseline_latest]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_member_os_baseline_latest] (
    [collected_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime(),
    [agent_id] VARCHAR(64) NOT NULL,
    [hostname] VARCHAR(128) NOT NULL,
    [cpu_pct] FLOAT NULL,
    [memory_pct] FLOAT NULL,
    [c_used_pct] FLOAT NULL,
    [disk_free_bytes] BIGINT NULL,
    [services_count] INT NOT NULL DEFAULT (0),
    [disk_free] NVARCHAR(MAX) NULL,
    [disk_total] NVARCHAR(MAX) NULL,
    [disks] NVARCHAR(MAX) NULL,
    [services] NVARCHAR(MAX) NULL,
    [events] NVARCHAR(MAX) NULL,
    [bios_info] NVARCHAR(MAX) NULL,
    [cpu_brand] NVARCHAR(128) NULL,
    [mem_total_bytes] BIGINT NULL,
    [system_info] NVARCHAR(MAX) NULL,
    [network_info] NVARCHAR(MAX) NULL,
    [memory_modules] NVARCHAR(MAX) NULL,
    [motherboard] NVARCHAR(MAX) NULL,
    [cpu] NVARCHAR(MAX) NULL,
    [ips] NVARCHAR(MAX) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'pk_ad_member_os_baseline_latest')
BEGIN ALTER TABLE [ad_member_os_baseline_latest] ADD CONSTRAINT [pk_ad_member_os_baseline_latest] PRIMARY KEY ([hostname]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_ad_member_os_baseline_latest_collected_at')
BEGIN CREATE NONCLUSTERED INDEX [ix_ad_member_os_baseline_latest_collected_at] ON [ad_member_os_baseline_latest] ([collected_at]); END;

-- fk_ad_member_os_baseline_latest_host: 延后到文末 "Foreign keys (deferred)" 段 (R161.3)

-- --------------------------------------------------------------------------
-- Table: [ad_member_server_packages]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_member_server_packages]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_member_server_packages] (
    [hostname] VARCHAR(128) NOT NULL,
    [package_name] NVARCHAR(128) NOT NULL,
    [enabled] BIT NOT NULL DEFAULT (1),
    [installed_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime(),
    [last_run_at] DATETIME2 NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'pk_msp')
BEGIN ALTER TABLE [ad_member_server_packages] ADD CONSTRAINT [pk_msp] PRIMARY KEY ([hostname], [package_name]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_msp_pkg')
BEGIN CREATE NONCLUSTERED INDEX [ix_msp_pkg] ON [ad_member_server_packages] ([package_name]); END;

-- fk_msp_host: 延后到文末 "Foreign keys (deferred)" 段 (R161.3)
-- fk_msp_pkg: 延后到文末 "Foreign keys (deferred)" 段 (R161.3)

-- --------------------------------------------------------------------------
-- Table: [ad_member_server_ports]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_member_server_ports]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_member_server_ports] (
    [hostname] VARCHAR(128) NOT NULL,
    [port] INT NOT NULL,
    [service_type] VARCHAR(32) NOT NULL,
    [note] NVARCHAR(255) NULL,
    [created_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime(),
    [updated_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime(),
    [probe_status] NVARCHAR(16) NULL,
    [probe_latency_ms] INT NULL,
    [probe_at] DATETIME2 NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'pk_ad_member_server_ports')
BEGIN ALTER TABLE [ad_member_server_ports] ADD CONSTRAINT [pk_ad_member_server_ports] PRIMARY KEY ([hostname], [port]); END;

-- (no secondary indexes on [ad_member_server_ports])

-- fk_ad_member_server_ports_host: 延后到文末 "Foreign keys (deferred)" 段 (R161.3)

-- --------------------------------------------------------------------------
-- Table: [ad_member_servers]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_member_servers]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_member_servers] (
    [hostname] VARCHAR(128) NOT NULL,
    [site_id] INT NULL,
    [ip_address] VARCHAR(64) NULL,
    [os_version] VARCHAR(64) NULL,
    [agent_type] VARCHAR(16) NOT NULL DEFAULT 'non-ad',
    [enabled] BIT NOT NULL DEFAULT (1),
    [last_seen_at] DATETIME2 NULL,
    [last_report_at] DATETIME2 NULL,
    [discovered_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime(),
    [discovered_via] VARCHAR(32) NOT NULL DEFAULT 'self-register',
    [created_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime(),
    [updated_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime(),
    [install_root] NVARCHAR(512) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__ad_membe__DA92E4327D56B84D')
BEGIN ALTER TABLE [ad_member_servers] ADD CONSTRAINT [PK__ad_membe__DA92E4327D56B84D] PRIMARY KEY ([hostname]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_member_servers_site')
BEGIN CREATE NONCLUSTERED INDEX [ix_member_servers_site] ON [ad_member_servers] ([site_id]); END;

-- fk_member_servers_site: 延后到文末 "Foreign keys (deferred)" 段 (R161.3)

-- --------------------------------------------------------------------------
-- Table: [ad_notify_outbox]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_notify_outbox]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_notify_outbox] (
    [id] INT IDENTITY(1,1) NOT NULL,
    [ad_command_id] INT NULL,
    [to_addrs] NVARCHAR(1024) NOT NULL,
    [cc_addrs] NVARCHAR(1024) NULL,
    [subject] NVARCHAR(512) NOT NULL,
    [body_text] NVARCHAR(MAX) NOT NULL,
    [body_html] NVARCHAR(MAX) NOT NULL,
    [attempt_count] INT NOT NULL DEFAULT (0),
    [max_attempts] INT NOT NULL DEFAULT (5),
    [last_error] NVARCHAR(2048) NULL,
    [sent_at] DATETIME2 NULL,
    [next_attempt_at] DATETIME2 NOT NULL,
    [created_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime()
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__ad_notif__3213E83FBD7199C3')
BEGIN ALTER TABLE [ad_notify_outbox] ADD CONSTRAINT [PK__ad_notif__3213E83FBD7199C3] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_ad_notify_outbox_pending')
BEGIN CREATE NONCLUSTERED INDEX [idx_ad_notify_outbox_pending] ON [ad_notify_outbox] ([next_attempt_at], [id]) WHERE ([sent_at] IS NULL); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_ad_notify_outbox_created')
BEGIN CREATE NONCLUSTERED INDEX [idx_ad_notify_outbox_created] ON [ad_notify_outbox] ([created_at]); END;

-- (no FOREIGN KEYS on [ad_notify_outbox])

-- --------------------------------------------------------------------------
-- Table: [ad_ous_snapshot]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_ous_snapshot]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_ous_snapshot] (
    -- R161.3 (2026-10-25) — 代理主键 + PERSISTED 计算列哈希唯一键.
    --   旧 PK (domain_name, distinguished_name) = 258 + 2050 = 2308 字节,
    --   超过 SQL Server 聚集主键上限 900 字节 ⇒ 全新库建表当场失败
    --   (Msg 1919 "maximum key length is 900 bytes")。
    --   SQL Server **没有前缀索引**, 所以长 DN 没法"截短"进键 ⇒ 只能:
    --     - 主键换成代理列 id (8 字节)
    --     - 唯一性交给 (domain_name, distinguished_name_hash), hash 是 DB 侧
    --       计算列 (SHA2_256 ⇒ 32 字节), 应用不写它
    --   应用层零改动: MERGE 的 ON 子句仍按自然列匹配 (sql.js upsertOu),
    --   INSERT 列表是显式列清单 ⇒ id / 计算列都不参与。
    --   注: SQL Server 的 HASHBYTES 走 UTF-16 编码, 与 MySQL 侧 SHA2 的
    --   UTF-8 字节流**不同** ⇒ 两边言的哈希值不可互相比较 (本项目也不需要);
    --   各自方言内部唯一性语义完全一致。
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [domain_name] NVARCHAR(128) NOT NULL,
    [distinguished_name] NVARCHAR(1024) NOT NULL,
    [name] NVARCHAR(256) NOT NULL,
    [description] NVARCHAR(2048) NULL,
    [when_created] DATETIME2 NULL,
    [when_changed] DATETIME2 NULL,
    [parent_dn] NVARCHAR(1024) NULL,
    [snapshot_at] DATETIME2 NOT NULL,
    [snapshot_run_id] BIGINT NOT NULL,
    [forest_id] BIGINT NULL,
    [domain_id] BIGINT NULL,
    [distinguished_name_hash] AS CONVERT(BINARY(32), HASHBYTES('SHA2_256', [distinguished_name])) PERSISTED
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'pk_ad_ous_snapshot')
BEGIN ALTER TABLE [ad_ous_snapshot] ADD CONSTRAINT [pk_ad_ous_snapshot] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_ous_dn')
BEGIN CREATE UNIQUE NONCLUSTERED INDEX [uq_ous_dn] ON [ad_ous_snapshot] ([domain_name], [distinguished_name_hash]); END;

-- ix_ous_parent_dn 在 MSSQL 上**建不出来** (R161.3): parent_dn 是
--   NVARCHAR(1024) = 2050 字节 > 1700 (非聚集索引键上限), SQL Server
--   **没有前缀索引** ⇒ 这个索引在 MSSQL 上物理建不出来。MySQL 侧保留
--   (parent_dn(191)) 前缀索引 —— 与 ix_users_ou_dn / ix_computers_ou_dn
--   同属**引擎能力差异导致的必然分歧** (MySQL 支持前缀索引, SQL Server 不支持)。
--   本索引在 MySQL 侧其实也用不上 (parent_dn 从不出现在任何 WHERE 谓词里 ——
--   OU 树是前端拿全量结果在浏览器里按 parent_dn 重建的), 但保留它无害,
--   且删掉会让双方言索引集合再多一处无谓差异, 故两边言都按"引擎能力"处理。
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_ous_snapshot_at')
BEGIN CREATE NONCLUSTERED INDEX [ix_ous_snapshot_at] ON [ad_ous_snapshot] ([snapshot_at]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_ous_forest_dc')
BEGIN CREATE NONCLUSTERED INDEX [idx_ous_forest_dc] ON [ad_ous_snapshot] ([forest_id], [domain_name]); END;

-- (no FOREIGN KEYS on [ad_ous_snapshot])

-- --------------------------------------------------------------------------
-- Table: [ad_dc_inbound_partners]
-- --------------------------------------------------------------------------
-- R158.X.116.b (2026-10-22) — 补建. server.js:1426 声明 "migrations 035
--   (mysql + mssql) creates both tables", dc-partners-refresh.js 每 5 分钟
--   调 upsertDcInboundPartner/upsertDcOutboundPartner 写入本表, 但 MSSQL
--   baseline 从未建过 → 异常被 allSettled 吞掉只计数, 表现为静默失败.
--   唯一键 (local_dc, peer_dc, naming_context) 与 MERGE 的 ON 子句一致
--   (sql.js:4825).
IF OBJECT_ID('[ad_dc_inbound_partners]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_dc_inbound_partners] (
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [local_dc] NVARCHAR(128) NOT NULL,
    [peer_dc] NVARCHAR(128) NOT NULL,
    [naming_context] NVARCHAR(128) NOT NULL,
    [status_code] INT NOT NULL DEFAULT 0,
    [last_success_time] DATETIME2 NULL,
    [last_attempt_time] DATETIME2 NOT NULL,
    [error_message] NVARCHAR(2048) NULL,
    -- MySQL 侧是 `ON UPDATE CURRENT_TIMESTAMP(3)` (行被碰即刷新);
    -- MSSQL 无等价语义且无查询读本列, 退化为插入时刻。MERGE 两侧都不写该列。
    [refreshed_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime()
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'pk_dc_inbound_partners')
BEGIN ALTER TABLE [ad_dc_inbound_partners] ADD CONSTRAINT [pk_dc_inbound_partners] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_inbound_partner')
BEGIN CREATE UNIQUE NONCLUSTERED INDEX [uq_inbound_partner] ON [ad_dc_inbound_partners] ([local_dc], [peer_dc], [naming_context]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_inbound_partner_local_dc')
BEGIN CREATE NONCLUSTERED INDEX [ix_inbound_partner_local_dc] ON [ad_dc_inbound_partners] ([local_dc]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_inbound_partner_peer_dc')
BEGIN CREATE NONCLUSTERED INDEX [ix_inbound_partner_peer_dc] ON [ad_dc_inbound_partners] ([peer_dc]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_inbound_partner_naming_context')
BEGIN CREATE NONCLUSTERED INDEX [ix_inbound_partner_naming_context] ON [ad_dc_inbound_partners] ([naming_context]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_inbound_partner_refreshed_at')
BEGIN CREATE NONCLUSTERED INDEX [ix_inbound_partner_refreshed_at] ON [ad_dc_inbound_partners] ([refreshed_at]); END;

-- (no FOREIGN KEYS on [ad_dc_inbound_partners])

-- --------------------------------------------------------------------------
-- Table: [ad_dc_outbound_partners]
-- --------------------------------------------------------------------------
--   同 ad_dc_inbound_partners (m035 的 outbound 侧), 唯一键对应 MERGE
--   的 ON 子句 (sql.js:4846).
IF OBJECT_ID('[ad_dc_outbound_partners]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_dc_outbound_partners] (
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [local_dc] NVARCHAR(128) NOT NULL,
    [peer_dc] NVARCHAR(128) NOT NULL,
    [naming_context] NVARCHAR(128) NOT NULL,
    [status_code] INT NOT NULL DEFAULT 0,
    [last_success_time] DATETIME2 NULL,
    [last_attempt_time] DATETIME2 NOT NULL,
    [error_message] NVARCHAR(2048) NULL,
    [refreshed_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime()
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'pk_dc_outbound_partners')
BEGIN ALTER TABLE [ad_dc_outbound_partners] ADD CONSTRAINT [pk_dc_outbound_partners] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_outbound_partner')
BEGIN CREATE UNIQUE NONCLUSTERED INDEX [uq_outbound_partner] ON [ad_dc_outbound_partners] ([local_dc], [peer_dc], [naming_context]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_outbound_partner_local_dc')
BEGIN CREATE NONCLUSTERED INDEX [ix_outbound_partner_local_dc] ON [ad_dc_outbound_partners] ([local_dc]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_outbound_partner_peer_dc')
BEGIN CREATE NONCLUSTERED INDEX [ix_outbound_partner_peer_dc] ON [ad_dc_outbound_partners] ([peer_dc]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_outbound_partner_naming_context')
BEGIN CREATE NONCLUSTERED INDEX [ix_outbound_partner_naming_context] ON [ad_dc_outbound_partners] ([naming_context]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_outbound_partner_refreshed_at')
BEGIN CREATE NONCLUSTERED INDEX [ix_outbound_partner_refreshed_at] ON [ad_dc_outbound_partners] ([refreshed_at]); END;

-- (no FOREIGN KEYS on [ad_dc_outbound_partners])

-- --------------------------------------------------------------------------
-- Table: [ad_partner_inbound]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_partner_inbound]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_partner_inbound] (
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [collected_at] DATETIME2 NOT NULL,
    [agent_id] NVARCHAR(64) NOT NULL,
    [source_dc] NVARCHAR(128) NOT NULL,
    [dest_dc] NVARCHAR(128) NOT NULL,
    [discovered_at] DATETIME2 NOT NULL,
    [updated_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime()
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'pk_partner_inbound')
BEGIN ALTER TABLE [ad_partner_inbound] ADD CONSTRAINT [pk_partner_inbound] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_partner_inbound_pair')
BEGIN CREATE UNIQUE NONCLUSTERED INDEX [uq_partner_inbound_pair] ON [ad_partner_inbound] ([source_dc], [dest_dc]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_partner_inbound_collected_at')
BEGIN CREATE NONCLUSTERED INDEX [ix_partner_inbound_collected_at] ON [ad_partner_inbound] ([collected_at]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_partner_inbound_dest_dc')
BEGIN CREATE NONCLUSTERED INDEX [ix_partner_inbound_dest_dc] ON [ad_partner_inbound] ([dest_dc]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_partner_inbound_agent_id')
BEGIN CREATE NONCLUSTERED INDEX [ix_partner_inbound_agent_id] ON [ad_partner_inbound] ([agent_id]); END;

-- (no FOREIGN KEYS on [ad_partner_inbound])

-- --------------------------------------------------------------------------
-- Table: [ad_remote_port_probe]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_remote_port_probe]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_remote_port_probe] (
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [probe_at] DATETIME2 NOT NULL,
    [dc_name] NVARCHAR(128) NOT NULL,
    [port] INT NOT NULL,
    [ok] BIT NOT NULL,
    [latency_ms] INT NULL,
    [error] NVARCHAR(64) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__ad_remot__3213E83FC884E80F')
BEGIN ALTER TABLE [ad_remote_port_probe] ADD CONSTRAINT [PK__ad_remot__3213E83FC884E80F] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_remote_probe_dc_port_at')
BEGIN CREATE UNIQUE NONCLUSTERED INDEX [uq_remote_probe_dc_port_at] ON [ad_remote_port_probe] ([dc_name], [port], [probe_at]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_remote_probe_dc')
BEGIN CREATE NONCLUSTERED INDEX [ix_remote_probe_dc] ON [ad_remote_port_probe] ([dc_name]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_remote_probe_at')
BEGIN CREATE NONCLUSTERED INDEX [ix_remote_probe_at] ON [ad_remote_port_probe] ([probe_at]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_remote_probe_ok')
BEGIN CREATE NONCLUSTERED INDEX [ix_remote_probe_ok] ON [ad_remote_port_probe] ([ok]); END;

-- (no FOREIGN KEYS on [ad_remote_port_probe])

-- --------------------------------------------------------------------------
-- Table: [ad_replication_active_errors]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_replication_active_errors]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_replication_active_errors] (
    [id] INT IDENTITY(1,1) NOT NULL,
    [source_dc] VARCHAR(128) NOT NULL,
    [dest_dc] VARCHAR(128) NOT NULL,
    [naming_context] VARCHAR(128) NOT NULL,
    [status_code] TINYINT NOT NULL,
    [last_attempt_time] DATETIME2 NOT NULL,
    [first_seen_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime(),
    [last_reported_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime(),
    [reported_count] INT NOT NULL DEFAULT (1),
    [last_error_message] NVARCHAR(2048) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'pk_ad_replication_active_errors')
BEGIN ALTER TABLE [ad_replication_active_errors] ADD CONSTRAINT [pk_ad_replication_active_errors] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_active_error')
BEGIN CREATE UNIQUE NONCLUSTERED INDEX [uq_active_error] ON [ad_replication_active_errors] ([source_dc], [dest_dc], [naming_context]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_active_error_attempt')
BEGIN CREATE NONCLUSTERED INDEX [ix_active_error_attempt] ON [ad_replication_active_errors] ([last_attempt_time] DESC); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_active_error_pair')
BEGIN CREATE NONCLUSTERED INDEX [ix_active_error_pair] ON [ad_replication_active_errors] ([source_dc], [dest_dc], [naming_context]); END;

-- (no FOREIGN KEYS on [ad_replication_active_errors])

-- --------------------------------------------------------------------------
-- Table: [ad_replication_history]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_replication_history]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_replication_history] (
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [collected_at] DATETIME2 NOT NULL,
    [agent_id] NVARCHAR(64) NOT NULL,
    [source_dc] NVARCHAR(128) NOT NULL,
    [dest_dc] NVARCHAR(128) NOT NULL,
    [naming_context] NVARCHAR(256) NOT NULL,
    [last_success_time] DATETIME2 NULL,
    [last_attempt_time] DATETIME2 NULL,
    [attempt_duration_ms] INT NULL,
    [objects_transferred] INT NULL,
    [status_code] INT NOT NULL,
    [error_message] NVARCHAR(512) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__ad_repli__3213E83F1A815EB0')
BEGIN ALTER TABLE [ad_replication_history] ADD CONSTRAINT [PK__ad_repli__3213E83F1A815EB0] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_hist_time')
BEGIN CREATE NONCLUSTERED INDEX [ix_hist_time] ON [ad_replication_history] ([collected_at]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_hist_pair_time')
BEGIN CREATE NONCLUSTERED INDEX [ix_hist_pair_time] ON [ad_replication_history] ([source_dc], [dest_dc], [naming_context], [collected_at]); END;

-- (no FOREIGN KEYS on [ad_replication_history])

-- --------------------------------------------------------------------------
-- Table: [ad_replication_probe_history]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_replication_probe_history]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_replication_probe_history] (
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [collected_at] DATETIME2 NOT NULL,
    [agent_id] NVARCHAR(64) NOT NULL,
    [source_dc] NVARCHAR(128) NOT NULL,
    [dest_dc] NVARCHAR(128) NOT NULL,
    [naming_context] NVARCHAR(256) NOT NULL,
    [attempt_at] DATETIME2 NOT NULL,
    [result] NVARCHAR(16) NOT NULL,
    [status_code] TINYINT NOT NULL,
    [duration_ms] INT NULL,
    [objects_transferred] INT NULL,
    [error_code] INT NULL,
    [error_message] NVARCHAR(512) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'pk_ad_replication_probe_history')
BEGIN ALTER TABLE [ad_replication_probe_history] ADD CONSTRAINT [pk_ad_replication_probe_history] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_probe_pair_time')
BEGIN CREATE NONCLUSTERED INDEX [ix_probe_pair_time] ON [ad_replication_probe_history] ([source_dc], [dest_dc], [naming_context], [attempt_at]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_probe_attempt_at')
BEGIN CREATE NONCLUSTERED INDEX [ix_probe_attempt_at] ON [ad_replication_probe_history] ([attempt_at]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_probe_collected_at')
BEGIN CREATE NONCLUSTERED INDEX [ix_probe_collected_at] ON [ad_replication_probe_history] ([collected_at]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_probe_agent')
BEGIN CREATE NONCLUSTERED INDEX [ix_probe_agent] ON [ad_replication_probe_history] ([agent_id]); END;

-- (no FOREIGN KEYS on [ad_replication_probe_history])

-- --------------------------------------------------------------------------
-- Table: [ad_replication_status]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_replication_status]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_replication_status] (
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [collected_at] DATETIME2 NOT NULL,
    [agent_id] NVARCHAR(64) NOT NULL,
    [source_dc] NVARCHAR(128) NOT NULL,
    [dest_dc] NVARCHAR(128) NOT NULL,
    [source_site] NVARCHAR(64) NULL,
    [dest_site] NVARCHAR(64) NULL,
    [naming_context] NVARCHAR(256) NOT NULL,
    [last_success_time] DATETIME2 NULL,
    [last_attempt_time] DATETIME2 NULL,
    [status_code] INT NOT NULL DEFAULT (0),
    [error_message] NVARCHAR(512) NULL,
    [partner_port_status] NVARCHAR(MAX) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__ad_repli__3213E83FD3ACC991')
BEGIN ALTER TABLE [ad_replication_status] ADD CONSTRAINT [PK__ad_repli__3213E83FD3ACC991] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_repl_partner')
BEGIN CREATE UNIQUE NONCLUSTERED INDEX [uq_repl_partner] ON [ad_replication_status] ([source_dc], [dest_dc], [naming_context]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_repl_collected')
BEGIN CREATE NONCLUSTERED INDEX [ix_repl_collected] ON [ad_replication_status] ([collected_at]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_repl_dest')
BEGIN CREATE NONCLUSTERED INDEX [ix_repl_dest] ON [ad_replication_status] ([dest_dc]); END;

-- (no FOREIGN KEYS on [ad_replication_status])

-- --------------------------------------------------------------------------
-- Table: [ad_server_group_members]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_server_group_members]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_server_group_members] (
    [group_id] INT NOT NULL,
    [hostname] VARCHAR(128) NOT NULL,
    [created_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime()
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'pk_sgm')
BEGIN ALTER TABLE [ad_server_group_members] ADD CONSTRAINT [pk_sgm] PRIMARY KEY ([group_id], [hostname]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_sgm_host')
BEGIN CREATE NONCLUSTERED INDEX [ix_sgm_host] ON [ad_server_group_members] ([hostname]); END;

-- fk_sgm_host: 延后到文末 "Foreign keys (deferred)" 段 (R161.3)
-- fk_sgm_group: 延后到文末 "Foreign keys (deferred)" 段 (R161.3)

-- --------------------------------------------------------------------------
-- Table: [ad_server_groups]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_server_groups]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_server_groups] (
    [group_id] INT IDENTITY(1,1) NOT NULL,
    [group_name] VARCHAR(128) NOT NULL,
    [description] VARCHAR(256) NULL,
    [created_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime(),
    [updated_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime()
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__ad_serve__D57795A0246064A7')
BEGIN ALTER TABLE [ad_server_groups] ADD CONSTRAINT [PK__ad_serve__D57795A0246064A7] PRIMARY KEY ([group_id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_server_groups_name')
BEGIN CREATE UNIQUE NONCLUSTERED INDEX [uq_server_groups_name] ON [ad_server_groups] ([group_name]); END;

-- (no FOREIGN KEYS on [ad_server_groups])

-- --------------------------------------------------------------------------
-- Table: [ad_sites]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_sites]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_sites] (
    [site_id] INT IDENTITY(1,1) NOT NULL,
    [site_name] NVARCHAR(64) NOT NULL,
    [region_code] NVARCHAR(32) NULL,
    [is_hub] BIT NOT NULL DEFAULT (0),
    [description] NVARCHAR(256) NULL,
    [created_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime(),
    [updated_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime()
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__ad_sites__B22FDBCAA253E7CA')
BEGIN ALTER TABLE [ad_sites] ADD CONSTRAINT [PK__ad_sites__B22FDBCAA253E7CA] PRIMARY KEY ([site_id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_ad_sites_site_name')
BEGIN CREATE UNIQUE NONCLUSTERED INDEX [uq_ad_sites_site_name] ON [ad_sites] ([site_name]); END;

-- (no FOREIGN KEYS on [ad_sites])

-- --------------------------------------------------------------------------
-- Table: [ad_system_registration]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_system_registration]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_system_registration] (
    [id] INT IDENTITY(1,1) NOT NULL,
    [license_key] VARCHAR(255) NOT NULL,
    [license_hash] VARCHAR(64) NOT NULL,
    [activated_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime(),
    [expires_at] DATETIME2 NULL,
    [instance_id] VARCHAR(64) NOT NULL,
    [status] VARCHAR(16) NOT NULL DEFAULT 'active',
    [notes] NVARCHAR(MAX) NULL,
    [created_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime(),
    [updated_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime(),
    [license_kind] VARCHAR(16) NULL,
    [license_request_id] BIGINT NULL,
    [request_json_path] VARCHAR(512) NULL,
    -- R158.X.99-quota (2026-10-21) 节点配额。max_nodes = 申请单原始意图
    -- (原样存, 含审计价值); max_nodes_allowed = ceil(max_nodes × 1.2) 的
    -- 派生上限, activate 时算一次写死 —— 宽限比例日后若调整, 已激活的
    -- license 不应跟着变, 否则改个常量就悄悄改了存量客户授权。
    -- 存量老行两列恒 NULL = 不限额 = 原有行为; 0 回填等于替厂商猜授权意图。
    [max_nodes] INT NULL,
    [max_nodes_allowed] INT NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK_ad_system_registration')
BEGIN ALTER TABLE [ad_system_registration] ADD CONSTRAINT [PK_ad_system_registration] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_ad_system_registration_hash')
BEGIN CREATE UNIQUE NONCLUSTERED INDEX [UQ_ad_system_registration_hash] ON [ad_system_registration] ([license_hash]); END;

-- (no FOREIGN KEYS on [ad_system_registration])

-- --------------------------------------------------------------------------
-- Table: [ad_user_group_memberships]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_user_group_memberships]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_user_group_memberships] (
    -- R161.3 (2026-10-25) — 代理主键 + PERSISTED 计算列哈希唯一键.
    --   旧 PK (domain_name, user_sam, group_dn) = 258 + 514 + 2050 = 2822 字节
    --   > 聚集主键上限 900 ⇒ Msg 1919。改法同 ad_ous_snapshot (应用层零改动)。
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [domain_name] NVARCHAR(128) NOT NULL,
    [user_sam] NVARCHAR(256) NOT NULL,
    [group_dn] NVARCHAR(1024) NOT NULL,
    [group_name] NVARCHAR(256) NOT NULL,
    [snapshot_at] DATETIME2 NOT NULL,
    [snapshot_run_id] BIGINT NOT NULL,
    [group_dn_hash] AS CONVERT(BINARY(32), HASHBYTES('SHA2_256', [group_dn])) PERSISTED
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK_ad_user_group_memberships')
BEGIN ALTER TABLE [ad_user_group_memberships] ADD CONSTRAINT [PK_ad_user_group_memberships] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_ugm')
BEGIN CREATE UNIQUE NONCLUSTERED INDEX [uq_ugm] ON [ad_user_group_memberships] ([domain_name], [user_sam], [group_dn_hash]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_ugm_user')
BEGIN CREATE NONCLUSTERED INDEX [idx_ugm_user] ON [ad_user_group_memberships] ([group_name], [domain_name], [user_sam]); END;
-- idx_ugm_group 去掉了 group_dn (R161.3): 带上它是 514+258+2050 = 2822 字节
--   > 1700 上限; 而 group_dn **只写不读** —— 应用里没有任何按 group_dn 过滤的
--   查询 (listGroupsForUser 按 domain_name+user_sam, listMembersForGroup 按
--   domain_name+group_name), deleteOrphans 按 user_sam 删, 正好由本索引的
--   最左前缀 (user_sam, domain_name) 覆盖。MySQL 侧同步改成同样两列。
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_ugm_group')
BEGIN CREATE NONCLUSTERED INDEX [idx_ugm_group] ON [ad_user_group_memberships] ([user_sam], [domain_name]); END;

-- (no FOREIGN KEYS on [ad_user_group_memberships])

-- --------------------------------------------------------------------------
-- Table: [ad_users_snapshot]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[ad_users_snapshot]', 'U') IS NULL
BEGIN
  CREATE TABLE [ad_users_snapshot] (
    [domain_name] NVARCHAR(128) NOT NULL,
    [sam] NVARCHAR(256) NOT NULL,
    [display_name] NVARCHAR(512) NULL,
    [distinguished_name] NVARCHAR(1024) NOT NULL,
    [ou_dn] NVARCHAR(1024) NULL,
    [enabled] BIT NULL,
    [locked_out] BIT NULL,
    [last_logon] DATETIME2 NULL,
    [when_created] DATETIME2 NULL,
    [password_last_set] DATETIME2 NULL,
    [user_account_control] INT NULL,
    [snapshot_at] DATETIME2 NOT NULL,
    [snapshot_run_id] BIGINT NOT NULL,
    [forest_id] BIGINT NULL,
    [domain_id] BIGINT NULL,
    [manager_dn] NVARCHAR(256) NULL,
    [manager_sam] NVARCHAR(256) NULL,
    [description] NVARCHAR(1024) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'pk_ad_users_snapshot')
BEGIN ALTER TABLE [ad_users_snapshot] ADD CONSTRAINT [pk_ad_users_snapshot] PRIMARY KEY ([domain_name], [sam]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_users_snapshot_at')
BEGIN CREATE NONCLUSTERED INDEX [ix_users_snapshot_at] ON [ad_users_snapshot] ([snapshot_at]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_users_enabled_locked')
BEGIN CREATE NONCLUSTERED INDEX [ix_users_enabled_locked] ON [ad_users_snapshot] ([enabled], [locked_out]); END;
-- ix_users_ou_dn 在 MSSQL 上**建不出来** (R161.3): ou_dn = NVARCHAR(1024)
--   = 2050 字节 > 1700 (非聚集索引键上限), SQL Server 没有前缀索引。
--   ⚠ 修正 (R161.3 实测): 早先这里写的是"MySQL 前缀索引服务不了完整值
--   等值 ⇒ 双方言都删" —— **实测为假** (MySQL 5.7 EXPLAIN: 完整值等值
--   type=ref / rows=1; 删掉索引后 type=ALL / rows=1833)。所以 **MySQL 侧
--   保留** ou_dn(191) 前缀索引, 双方言在此处是引擎能力差异导致的必然分歧。
--   详细实测数字见 ix_computers_ou_dn 上方的注释块。
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_users_forest_dc')
BEGIN CREATE NONCLUSTERED INDEX [idx_users_forest_dc] ON [ad_users_snapshot] ([forest_id], [domain_name]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_ad_users_snapshot_manager_sam')
BEGIN CREATE NONCLUSTERED INDEX [ix_ad_users_snapshot_manager_sam] ON [ad_users_snapshot] ([manager_sam]); END;

-- (no FOREIGN KEYS on [ad_users_snapshot])

-- --------------------------------------------------------------------------
-- Table: [audit_logs]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[audit_logs]', 'U') IS NULL
BEGIN
  CREATE TABLE [audit_logs] (
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [user_id] INT NULL,
    [action] NVARCHAR(64) NOT NULL,
    [target] NVARCHAR(128) NULL,
    [payload] NVARCHAR(MAX) NULL,
    [created_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime()
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__audit_lo__3213E83F503546E0')
BEGIN ALTER TABLE [audit_logs] ADD CONSTRAINT [PK__audit_lo__3213E83F503546E0] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_audit_time')
BEGIN CREATE NONCLUSTERED INDEX [ix_audit_time] ON [audit_logs] ([created_at]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_audit_action_time')
BEGIN CREATE NONCLUSTERED INDEX [ix_audit_action_time] ON [audit_logs] ([action], [created_at]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_audit_user_time')
BEGIN CREATE NONCLUSTERED INDEX [ix_audit_user_time] ON [audit_logs] ([user_id], [created_at]); END;

-- (no FOREIGN KEYS on [audit_logs])

-- (no secondary indexes on [audit_logs_ad_mgmt_backup_20261006125413115])

-- (no FOREIGN KEYS on [audit_logs_ad_mgmt_backup_20261006125413115])

-- (no FOREIGN KEYS on [audit_logs_ad_mgmt_backup_20261006125549869])

-- (no FOREIGN KEYS on [audit_logs_ad_mgmt_backup_20261006125611009])

-- (no FOREIGN KEYS on [audit_logs_ad_mgmt_backup_20261006125737180])

-- (no FOREIGN KEYS on [audit_logs_ad_mgmt_backup_20261006132114862])

-- --------------------------------------------------------------------------
-- Table: [daily_reports]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[daily_reports]', 'U') IS NULL
BEGIN
  CREATE TABLE [daily_reports] (
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [kind] VARCHAR(16) NOT NULL,
    [period_start] DATETIME2 NOT NULL,
    [period_end] DATETIME2 NOT NULL,
    [generated_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime(),
    [to_addrs] VARCHAR(1024) NOT NULL,
    [cc_addrs] VARCHAR(1024) NULL,
    [subject] VARCHAR(256) NOT NULL,
    [body_text] NVARCHAR(MAX) NOT NULL,
    [body_html] NVARCHAR(MAX) NULL,
    [outbox_id] BIGINT NULL,
    [status] VARCHAR(16) NOT NULL DEFAULT 'pending',
    [last_error] NVARCHAR(MAX) NULL,
    [html_size] INT NOT NULL DEFAULT (0)
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK_daily_reports')
BEGIN ALTER TABLE [daily_reports] ADD CONSTRAINT [PK_daily_reports] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_dr_kind_generated')
BEGIN CREATE NONCLUSTERED INDEX [idx_dr_kind_generated] ON [daily_reports] ([status], [subject], [kind], [generated_at] DESC); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_dr_period')
BEGIN CREATE NONCLUSTERED INDEX [idx_dr_period] ON [daily_reports] ([kind], [status], [period_end] DESC); END;

-- fk_dro_outbox: 延后到文末 "Foreign keys (deferred)" 段 (R161.3)

-- --------------------------------------------------------------------------
-- Table: [license_email_outbox]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[license_email_outbox]', 'U') IS NULL
BEGIN
  CREATE TABLE [license_email_outbox] (
    [id] INT IDENTITY(1,1) NOT NULL,
    [license_id] INT NULL,
    [to_addrs] NVARCHAR(1024) NOT NULL,
    [cc_addrs] NVARCHAR(1024) NULL,
    [subject] NVARCHAR(512) NOT NULL,
    [body_text] NVARCHAR(MAX) NOT NULL,
    [body_html] NVARCHAR(MAX) NOT NULL,
    [attempt_count] INT NOT NULL DEFAULT (0),
    [max_attempts] INT NOT NULL DEFAULT (5),
    [last_error] NVARCHAR(2048) NULL,
    [sent_at] DATETIME2 NULL,
    [next_attempt_at] DATETIME2 NOT NULL,
    [created_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime()
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__license___3213E83F5B379321')
BEGIN ALTER TABLE [license_email_outbox] ADD CONSTRAINT [PK__license___3213E83F5B379321] PRIMARY KEY ([id]); END;

-- (no secondary indexes on [license_email_outbox])

-- (no FOREIGN KEYS on [license_email_outbox])

-- --------------------------------------------------------------------------
-- Table: [metric_counter]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[metric_counter]', 'U') IS NULL
BEGIN
  CREATE TABLE [metric_counter] (
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [agent_id] NVARCHAR(64) NOT NULL,
    [metric_id] NVARCHAR(192) NOT NULL,
    [ts] DATETIMEOFFSET NOT NULL,
    [value] BIGINT NOT NULL,
    [delta] BIGINT NOT NULL DEFAULT (0),
    [unit] NVARCHAR(16) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__metric_c__3213E83F3AC92949')
BEGIN ALTER TABLE [metric_counter] ADD CONSTRAINT [PK__metric_c__3213E83F3AC92949] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_counter_agent_metric')
BEGIN CREATE UNIQUE NONCLUSTERED INDEX [uq_counter_agent_metric] ON [metric_counter] ([agent_id], [metric_id]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_counter_metric_ts')
BEGIN CREATE NONCLUSTERED INDEX [ix_counter_metric_ts] ON [metric_counter] ([metric_id], [ts] DESC); END;

-- (no FOREIGN KEYS on [metric_counter])

-- --------------------------------------------------------------------------
-- Table: [metric_gauge]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[metric_gauge]', 'U') IS NULL
BEGIN
  CREATE TABLE [metric_gauge] (
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [agent_id] NVARCHAR(64) NOT NULL,
    [metric_id] NVARCHAR(192) NOT NULL,
    [ts] DATETIMEOFFSET NOT NULL,
    [value] FLOAT NOT NULL,
    [unit] NVARCHAR(16) NULL,
    [threshold_warn] FLOAT NULL,
    [threshold_crit] FLOAT NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__metric_g__3213E83FA21BBEA8')
BEGIN ALTER TABLE [metric_gauge] ADD CONSTRAINT [PK__metric_g__3213E83FA21BBEA8] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_gauge_agent_metric')
BEGIN CREATE UNIQUE NONCLUSTERED INDEX [uq_gauge_agent_metric] ON [metric_gauge] ([agent_id], [metric_id]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_gauge_metric_ts')
BEGIN CREATE NONCLUSTERED INDEX [ix_gauge_metric_ts] ON [metric_gauge] ([metric_id], [ts] DESC); END;

-- (no FOREIGN KEYS on [metric_gauge])

-- --------------------------------------------------------------------------
-- Table: [metric_status]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[metric_status]', 'U') IS NULL
BEGIN
  CREATE TABLE [metric_status] (
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [agent_id] NVARCHAR(64) NOT NULL,
    [metric_id] NVARCHAR(192) NOT NULL,
    [ts] DATETIMEOFFSET NOT NULL,
    [status] NVARCHAR(64) NOT NULL,
    [message] NVARCHAR(512) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__metric_s__3213E83F9D4F1367')
BEGIN ALTER TABLE [metric_status] ADD CONSTRAINT [PK__metric_s__3213E83F9D4F1367] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_status_agent_metric')
BEGIN CREATE UNIQUE NONCLUSTERED INDEX [uq_status_agent_metric] ON [metric_status] ([agent_id], [metric_id]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_status_metric_ts')
BEGIN CREATE NONCLUSTERED INDEX [ix_status_metric_ts] ON [metric_status] ([metric_id], [ts] DESC); END;

-- (no FOREIGN KEYS on [metric_status])

-- --------------------------------------------------------------------------
-- Table: [metric_timeseries]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[metric_timeseries]', 'U') IS NULL
BEGIN
  CREATE TABLE [metric_timeseries] (
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [agent_id] NVARCHAR(64) NOT NULL,
    [metric_id] NVARCHAR(192) NOT NULL,
    [ts] DATETIMEOFFSET NOT NULL,
    [value] FLOAT NOT NULL,
    [tags_json] NVARCHAR(MAX) NULL,
    [unit] NVARCHAR(16) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__metric_t__3213E83F361A8C92')
BEGIN ALTER TABLE [metric_timeseries] ADD CONSTRAINT [PK__metric_t__3213E83F361A8C92] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_ts_agent_metric_ts')
BEGIN CREATE NONCLUSTERED INDEX [ix_ts_agent_metric_ts] ON [metric_timeseries] ([agent_id], [metric_id], [ts] DESC); END;

-- (no FOREIGN KEYS on [metric_timeseries])

-- --------------------------------------------------------------------------
-- Table: [orphan_schemas]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[orphan_schemas]', 'U') IS NULL
BEGIN
  CREATE TABLE [orphan_schemas] (
    [name] NVARCHAR(128) NOT NULL,
    [last_seen_at] DATETIMEOFFSET NOT NULL,
    [note] NVARCHAR(512) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__orphan_s__72E12F1AF6A6695A')
BEGIN ALTER TABLE [orphan_schemas] ADD CONSTRAINT [PK__orphan_s__72E12F1AF6A6695A] PRIMARY KEY ([name]); END;

-- (no secondary indexes on [orphan_schemas])

-- (no FOREIGN KEYS on [orphan_schemas])

-- --------------------------------------------------------------------------
-- Table: [package_policies]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[package_policies]', 'U') IS NULL
BEGIN
  CREATE TABLE [package_policies] (
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [name] NVARCHAR(128) NOT NULL,
    [interval_sec] INT NOT NULL,
    [timeout_ms] INT NOT NULL,
    [enabled] BIT NOT NULL DEFAULT (1),
    [params_json] NVARCHAR(MAX) NULL,
    [scope] NVARCHAR(64) NOT NULL DEFAULT 'global',
    [created_at] DATETIME2 NOT NULL,
    [updated_at] DATETIME2 NOT NULL,
    [cron_expr] VARCHAR(64) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__package___3213E83F5887F406')
BEGIN ALTER TABLE [package_policies] ADD CONSTRAINT [PK__package___3213E83F5887F406] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_package_policies_name')
BEGIN CREATE UNIQUE NONCLUSTERED INDEX [uq_package_policies_name] ON [package_policies] ([name]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_package_policies_enabled')
BEGIN CREATE NONCLUSTERED INDEX [ix_package_policies_enabled] ON [package_policies] ([enabled]); END;

-- fk_package_policies_name: 延后到文末 "Foreign keys (deferred)" 段 (R161.3)

-- --------------------------------------------------------------------------
-- Table: [package_runs]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[package_runs]', 'U') IS NULL
BEGIN
  CREATE TABLE [package_runs] (
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [agent_id] NVARCHAR(64) NOT NULL,
    [package_name] NVARCHAR(128) NOT NULL,
    [started_at] DATETIMEOFFSET NOT NULL,
    [finished_at] DATETIMEOFFSET NULL,
    [exit_code] INT NULL,
    [stdout_preview] NVARCHAR(2048) NULL,
    [stderr_preview] NVARCHAR(2048) NULL,
    [error] NVARCHAR(512) NULL,
    [script_version] VARCHAR(32) NULL,
    [status] NVARCHAR(32) NULL,
    [jitter_at] DATETIME NULL,
    [trigger_once] BIT NULL,
    [cron_expr] VARCHAR(64) NULL,
    [target_agents] NVARCHAR(MAX) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__package___3213E83FF2DC6E04')
BEGIN ALTER TABLE [package_runs] ADD CONSTRAINT [PK__package___3213E83FF2DC6E04] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_run_agent_pkg')
BEGIN CREATE NONCLUSTERED INDEX [ix_run_agent_pkg] ON [package_runs] ([agent_id], [package_name], [started_at] DESC); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_package_runs_status_started_at')
BEGIN CREATE NONCLUSTERED INDEX [IX_package_runs_status_started_at] ON [package_runs] ([status], [started_at] DESC) WHERE ([status]='pending_trigger'); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_pr_started_covering')
BEGIN CREATE NONCLUSTERED INDEX [IX_pr_started_covering] ON [package_runs] ([package_name], [exit_code], [status], [agent_id], [started_at]); END;

-- (no FOREIGN KEYS on [package_runs])

-- --------------------------------------------------------------------------
-- Table: [package_scripts]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[package_scripts]', 'U') IS NULL
BEGIN
  CREATE TABLE [package_scripts] (
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [name] NVARCHAR(128) NOT NULL,
    [version] NVARCHAR(32) NOT NULL,
    [script_content] NVARCHAR(MAX) NOT NULL,
    [script_sha256] VARCHAR(64) NOT NULL,
    [manifest_json] NVARCHAR(MAX) NOT NULL,
    [source] NVARCHAR(255) NOT NULL,
    [created_at] DATETIME2 NOT NULL,
    [updated_at] DATETIME2 NOT NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__package___3213E83FF2D15E11')
BEGIN ALTER TABLE [package_scripts] ADD CONSTRAINT [PK__package___3213E83FF2D15E11] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_package_scripts_name')
BEGIN CREATE UNIQUE NONCLUSTERED INDEX [uq_package_scripts_name] ON [package_scripts] ([name]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_package_scripts_updated_at')
BEGIN CREATE NONCLUSTERED INDEX [ix_package_scripts_updated_at] ON [package_scripts] ([updated_at]); END;

-- (no FOREIGN KEYS on [package_scripts])

-- --------------------------------------------------------------------------
-- Table: [package_scripts_history]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[package_scripts_history]', 'U') IS NULL
BEGIN
  CREATE TABLE [package_scripts_history] (
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [name] NVARCHAR(128) NOT NULL,
    [version] NVARCHAR(32) NOT NULL,
    [script_sha256] VARCHAR(64) NOT NULL,
    [manifest_json] NVARCHAR(MAX) NOT NULL,
    [source] NVARCHAR(255) NOT NULL,
    [published_at] DATETIME2 NOT NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__package___3213E83FFD427D53')
BEGIN ALTER TABLE [package_scripts_history] ADD CONSTRAINT [PK__package___3213E83FFD427D53] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_package_scripts_history')
BEGIN CREATE UNIQUE NONCLUSTERED INDEX [uq_package_scripts_history] ON [package_scripts_history] ([name], [version], [script_sha256]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_package_scripts_history_name_pub')
BEGIN CREATE NONCLUSTERED INDEX [ix_package_scripts_history_name_pub] ON [package_scripts_history] ([name], [published_at] DESC); END;

-- (no FOREIGN KEYS on [package_scripts_history])

-- --------------------------------------------------------------------------
-- Table: [probe_state]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[probe_state]', 'U') IS NULL
BEGIN
  CREATE TABLE [probe_state] (
    [port_role] VARCHAR(16) NOT NULL,
    [status] VARCHAR(16) NOT NULL,
    [latency_ms] INT NULL,
    [last_probe_at] DATETIME2 NULL,
    [last_up_at] DATETIME2 NULL,
    [consecutive_failures] INT NOT NULL DEFAULT (0)
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__probe_st__90BA9B5BCE29B2D6')
BEGIN ALTER TABLE [probe_state] ADD CONSTRAINT [PK__probe_st__90BA9B5BCE29B2D6] PRIMARY KEY ([port_role]); END;

-- (no secondary indexes on [probe_state])

-- (no FOREIGN KEYS on [probe_state])

-- (no secondary indexes on [r158_x_99_17_c_aac_backup])

-- (no FOREIGN KEYS on [r158_x_99_17_c_aac_backup])

-- --------------------------------------------------------------------------
-- Table: [report_email_outbox]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[report_email_outbox]', 'U') IS NULL
BEGIN
  CREATE TABLE [report_email_outbox] (
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [report_id] BIGINT NOT NULL,
    [kind] VARCHAR(20) NOT NULL,
    [to_addrs] NVARCHAR(MAX) NOT NULL,
    [cc_addrs] NVARCHAR(MAX) NULL,
    [subject] NVARCHAR(500) NOT NULL,
    [body_text] NVARCHAR(MAX) NOT NULL,
    [body_html] NVARCHAR(MAX) NULL,
    [attempt_count] INT NOT NULL DEFAULT (0),
    [max_attempts] INT NOT NULL DEFAULT (5),
    [last_error] NVARCHAR(MAX) NULL,
    [sent_at] DATETIME2 NULL,
    [next_attempt_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime(),
    [created_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime()
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__report_e__3213E83FC3EE0E95')
BEGIN ALTER TABLE [report_email_outbox] ADD CONSTRAINT [PK__report_e__3213E83FC3EE0E95] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_reo_pending')
BEGIN CREATE NONCLUSTERED INDEX [idx_reo_pending] ON [report_email_outbox] ([next_attempt_at]) WHERE ([sent_at] IS NULL); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_reo_kind')
BEGIN CREATE NONCLUSTERED INDEX [idx_reo_kind] ON [report_email_outbox] ([kind], [created_at] DESC); END;

-- (no FOREIGN KEYS on [report_email_outbox])

-- --------------------------------------------------------------------------
-- Table: [report_fired_history]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[report_fired_history]', 'U') IS NULL
BEGIN
  CREATE TABLE [report_fired_history] (
    [kind] VARCHAR(16) NOT NULL,
    [last_fired_minute_key] VARCHAR(32) NOT NULL,
    [last_fired_at] DATETIME2 NOT NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK_report_fired_history')
BEGIN ALTER TABLE [report_fired_history] ADD CONSTRAINT [PK_report_fired_history] PRIMARY KEY ([kind]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_report_fired_history_last_fired_at')
BEGIN CREATE NONCLUSTERED INDEX [IX_report_fired_history_last_fired_at] ON [report_fired_history] ([last_fired_at] DESC); END;

-- (no FOREIGN KEYS on [report_fired_history])

-- --------------------------------------------------------------------------
-- Table: [report_subscriptions]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[report_subscriptions]', 'U') IS NULL
BEGIN
  CREATE TABLE [report_subscriptions] (
    [id] INT IDENTITY(1,1) NOT NULL,
    [kind] VARCHAR(16) NOT NULL,
    [to_addrs] VARCHAR(1024) NOT NULL,
    [cc_addrs] VARCHAR(1024) NULL,
    [enabled] BIT NOT NULL DEFAULT (1),
    [created_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime(),
    [created_by] NVARCHAR(64) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK_report_subscriptions')
BEGIN ALTER TABLE [report_subscriptions] ADD CONSTRAINT [PK_report_subscriptions] PRIMARY KEY ([id]); END;

-- idx_rs_kind_enabled 改列序 (R161.3): 旧定义
--   ([to_addrs], [cc_addrs], [kind], [enabled]) = 1024 + 1024 + 16 + 1 = 2065 字节
--   > 1700 (非聚集索引键上限) ⇒ 建不出来。
--   实际访问路径只有 reportSchedule.getByKind:
--   `WHERE kind = ? AND enabled = 1 ORDER BY id ASC` —— 只需要 (kind, enabled)。
--   MySQL 侧同步改成 (kind, enabled)。
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_rs_kind_enabled')
BEGIN CREATE NONCLUSTERED INDEX [idx_rs_kind_enabled] ON [report_subscriptions] ([kind], [enabled]); END;

-- (no FOREIGN KEYS on [report_subscriptions])

-- --------------------------------------------------------------------------
-- Table: [role_permissions]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[role_permissions]', 'U') IS NULL
BEGIN
  CREATE TABLE [role_permissions] (
    [role_id] INT NOT NULL,
    [permission] NVARCHAR(64) NOT NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'pk_role_permissions')
BEGIN ALTER TABLE [role_permissions] ADD CONSTRAINT [pk_role_permissions] PRIMARY KEY ([role_id], [permission]); END;

-- (no secondary indexes on [role_permissions])

-- fk_role_permissions_role: 延后到文末 "Foreign keys (deferred)" 段 (R161.3)

-- --------------------------------------------------------------------------
-- Table: [schema_migrations]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[schema_migrations]', 'U') IS NULL
BEGIN
  CREATE TABLE [schema_migrations] (
    [version] VARCHAR(32) NOT NULL,
    [description] VARCHAR(255) NOT NULL,
    [type] VARCHAR(16) NOT NULL DEFAULT 'sql',
    [script] VARCHAR(255) NOT NULL,
    [checksum] VARCHAR(64) NOT NULL,
    [applied_at] DATETIME2 NOT NULL,
    [applied_by] VARCHAR(64) NULL,
    [execution_ms] INT NULL,
    [status] VARCHAR(16) NOT NULL DEFAULT 'applied',
    [error_message] NVARCHAR(MAX) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__schema_m__79B5C94C28C8A925')
BEGIN ALTER TABLE [schema_migrations] ADD CONSTRAINT [PK__schema_m__79B5C94C28C8A925] PRIMARY KEY ([version]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_schema_migrations_status')
BEGIN CREATE NONCLUSTERED INDEX [ix_schema_migrations_status] ON [schema_migrations] ([status]); END;

-- (no FOREIGN KEYS on [schema_migrations])

-- --------------------------------------------------------------------------
-- R158.X.116.d (2026-10-22) — 移除 [ship_archive_scripts]
--   孤儿快照表, 不该在部署模板里。依据:
--     · src/ 全目录零引用 (连 "archive" 子串都没有) —— 没有任何 SELECT/INSERT
--     · 与 package_scripts 列结构对不齐 (name 255 vs 128、manifest_json NULL
--       vs NOT NULL、source 64 NULL vs 255 NOT NULL、id INT vs BIGINT)
--       → 不是它的自动归档产物 (此前误判为"归档表", 已纠正)
--     · 真正的历史机制是 package_scripts_history (script-service.js:88-107),
--       双方言都有, 与本表无关
--     · 项目已按 directive "只要不是最近数据 那么删除" 归档清理
--       (test/secfix/cleanup-orphan-tables.mjs), 11 行数据存档于
--       .backups/db-archive-20261021/ship_archive_scripts.sql
--   MySQL baseline 从未有过这张表, 故本次只删 MSSQL 侧, 两侧就此一致。

-- --------------------------------------------------------------------------
-- Table: [sys_config_audit]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[sys_config_audit]', 'U') IS NULL
BEGIN
  CREATE TABLE [sys_config_audit] (
    [id] INT IDENTITY(1,1) NOT NULL,
    [config_key] NVARCHAR(64) NOT NULL,
    [old_value] NVARCHAR(MAX) NULL,
    [new_value] NVARCHAR(MAX) NULL,
    [changed_by] INT NULL,
    [changed_at] DATETIMEOFFSET NOT NULL DEFAULT sysdatetimeoffset(),
    [change_type] VARCHAR(16) NOT NULL DEFAULT 'UPDATE'
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__sys_conf__3213E83F054FA982')
BEGIN ALTER TABLE [sys_config_audit] ADD CONSTRAINT [PK__sys_conf__3213E83F054FA982] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_changed_at')
BEGIN CREATE NONCLUSTERED INDEX [idx_changed_at] ON [sys_config_audit] ([changed_at] DESC); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_config_key')
BEGIN CREATE NONCLUSTERED INDEX [idx_config_key] ON [sys_config_audit] ([config_key]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_changed_by')
BEGIN CREATE NONCLUSTERED INDEX [idx_changed_by] ON [sys_config_audit] ([changed_by]); END;

-- (no FOREIGN KEYS on [sys_config_audit])

-- --------------------------------------------------------------------------
-- Table: [sys_roles]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[sys_roles]', 'U') IS NULL
BEGIN
  CREATE TABLE [sys_roles] (
    [id] INT IDENTITY(1,1) NOT NULL,
    [role_name] NVARCHAR(64) NOT NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__sys_role__3213E83F2E063FF3')
BEGIN ALTER TABLE [sys_roles] ADD CONSTRAINT [PK__sys_role__3213E83F2E063FF3] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_sys_roles_role_name')
BEGIN CREATE UNIQUE NONCLUSTERED INDEX [uq_sys_roles_role_name] ON [sys_roles] ([role_name]); END;

-- (no FOREIGN KEYS on [sys_roles])

-- --------------------------------------------------------------------------
-- Table: [sys_users]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[sys_users]', 'U') IS NULL
BEGIN
  CREATE TABLE [sys_users] (
    [id] INT IDENTITY(1,1) NOT NULL,
    [username] NVARCHAR(64) NOT NULL,
    [password_hash] NVARCHAR(256) NOT NULL,
    [role_id] INT NOT NULL,
    [status] BIT NOT NULL DEFAULT (1),
    [last_login_at] DATETIME2 NULL,
    [created_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime(),
    [token_version] INT NOT NULL DEFAULT (0)
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__sys_user__3213E83FF25E093C')
BEGIN ALTER TABLE [sys_users] ADD CONSTRAINT [PK__sys_user__3213E83FF25E093C] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_sys_users_username')
BEGIN CREATE UNIQUE NONCLUSTERED INDEX [uq_sys_users_username] ON [sys_users] ([username]); END;

-- fk_users_role: 延后到文末 "Foreign keys (deferred)" 段 (R161.3)

-- --------------------------------------------------------------------------
-- Table: [system_alert_outbox]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[system_alert_outbox]', 'U') IS NULL
BEGIN
  CREATE TABLE [system_alert_outbox] (
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [alert_id] BIGINT NOT NULL,
    [to_addrs] NVARCHAR(MAX) NOT NULL,
    [cc_addrs] NVARCHAR(MAX) NULL,
    [subject] NVARCHAR(500) NOT NULL,
    [body_text] NVARCHAR(MAX) NOT NULL,
    [body_html] NVARCHAR(MAX) NULL,
    [attempt_count] INT NOT NULL DEFAULT (0),
    [max_attempts] INT NOT NULL DEFAULT (5),
    [last_error] NVARCHAR(MAX) NULL,
    [sent_at] DATETIME2 NULL,
    [next_attempt_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime()
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__system_a__3213E83F1962A10B')
BEGIN ALTER TABLE [system_alert_outbox] ADD CONSTRAINT [PK__system_a__3213E83F1962A10B] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_sao_pending')
BEGIN CREATE NONCLUSTERED INDEX [idx_sao_pending] ON [system_alert_outbox] ([next_attempt_at]) WHERE ([sent_at] IS NULL); END;

-- fk_sao_alert: 延后到文末 "Foreign keys (deferred)" 段 (R161.3)

-- --------------------------------------------------------------------------
-- Table: [system_alert_suppressions]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[system_alert_suppressions]', 'U') IS NULL
BEGIN
  CREATE TABLE [system_alert_suppressions] (
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [kind] VARCHAR(40) NOT NULL,
    [scope_ref] NVARCHAR(255) NOT NULL,
    [reason] NVARCHAR(500) NULL,
    [set_by] NVARCHAR(64) NOT NULL,
    [set_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime(),
    [expires_at] DATETIME2 NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__system_a__3213E83FDE40A836')
BEGIN ALTER TABLE [system_alert_suppressions] ADD CONSTRAINT [PK__system_a__3213E83FDE40A836] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uq_sas_kind_scope')
BEGIN CREATE UNIQUE NONCLUSTERED INDEX [uq_sas_kind_scope] ON [system_alert_suppressions] ([kind], [scope_ref]); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_sas_set_at')
BEGIN CREATE NONCLUSTERED INDEX [ix_sas_set_at] ON [system_alert_suppressions] ([set_at] DESC); END;

-- (no FOREIGN KEYS on [system_alert_suppressions])

-- --------------------------------------------------------------------------
-- Table: [system_alerts]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[system_alerts]', 'U') IS NULL
BEGIN
  CREATE TABLE [system_alerts] (
    [id] BIGINT IDENTITY(1,1) NOT NULL,
    [kind] VARCHAR(40) NOT NULL,
    [scope_type] VARCHAR(20) NOT NULL DEFAULT 'host',
    [scope_ref] NVARCHAR(255) NULL,
    [state] VARCHAR(20) NOT NULL DEFAULT 'firing',
    [threshold] NVARCHAR(MAX) NULL,
    [detail] NVARCHAR(MAX) NULL,
    [fired_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime(),
    [recovered_at] DATETIME2 NULL,
    [acked_at] DATETIME2 NULL,
    [acked_by] NVARCHAR(64) NULL,
    [last_notified_at] DATETIME2 NULL,
    [notify_count] INT NOT NULL DEFAULT (0)
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__system_a__3213E83F323ED5FD')
BEGIN ALTER TABLE [system_alerts] ADD CONSTRAINT [PK__system_a__3213E83F323ED5FD] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_sa_kind_state')
BEGIN CREATE NONCLUSTERED INDEX [ix_sa_kind_state] ON [system_alerts] ([kind], [state], [fired_at] DESC); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_sa_scope')
BEGIN CREATE NONCLUSTERED INDEX [ix_sa_scope] ON [system_alerts] ([scope_type], [scope_ref], [kind]) WHERE ([state]='firing'); END;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_sa_fired')
BEGIN CREATE NONCLUSTERED INDEX [ix_sa_fired] ON [system_alerts] ([fired_at] DESC); END;

-- (no FOREIGN KEYS on [system_alerts])

-- (no secondary indexes on [system_alerts_backup_r158x3_20261016])

-- (no FOREIGN KEYS on [system_alerts_backup_r158x3_20261016])

-- (no secondary indexes on [system_alerts_backup_r158x5_20261016])

-- (no FOREIGN KEYS on [system_alerts_backup_r158x5_20261016])

-- --------------------------------------------------------------------------
-- Table: [system_config]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[system_config]', 'U') IS NULL
BEGIN
  CREATE TABLE [system_config] (
    [config_key] NVARCHAR(64) NOT NULL,
    [config_value] NVARCHAR(MAX) NULL,
    [description] NVARCHAR(256) NULL,
    [updated_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime(),
    [updated_by] NVARCHAR(64) NULL
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__system_c__BDF6033C4D18051F')
BEGIN ALTER TABLE [system_config] ADD CONSTRAINT [PK__system_c__BDF6033C4D18051F] PRIMARY KEY ([config_key]); END;

-- (no secondary indexes on [system_config])

-- (no FOREIGN KEYS on [system_config])

-- --------------------------------------------------------------------------
-- Table: [system_ports]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[system_ports]', 'U') IS NULL
BEGIN
  CREATE TABLE [system_ports] (
    [id] INT IDENTITY(1,1) NOT NULL,
    [port] INT NOT NULL,
    [label] NVARCHAR(64) NOT NULL,
    [sort_order] INT NOT NULL DEFAULT (0)
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__system_p__3213E83FEFE0D14A')
BEGIN ALTER TABLE [system_ports] ADD CONSTRAINT [PK__system_p__3213E83FEFE0D14A] PRIMARY KEY ([id]); END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'uk_system_ports_port')
BEGIN CREATE UNIQUE NONCLUSTERED INDEX [uk_system_ports_port] ON [system_ports] ([port]); END;

-- (no FOREIGN KEYS on [system_ports])

-- --------------------------------------------------------------------------
-- Table: [system_settings]
-- --------------------------------------------------------------------------
IF OBJECT_ID('[system_settings]', 'U') IS NULL
BEGIN
  CREATE TABLE [system_settings] (
    [setting_key] VARCHAR(128) NOT NULL,
    [setting_value] VARCHAR(1024) NOT NULL,
    [updated_at] DATETIME2 NOT NULL DEFAULT sysutcdatetime()
  );
END;

IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'PK__system_s__0DFAC42684D1EE11')
BEGIN ALTER TABLE [system_settings] ADD CONSTRAINT [PK__system_s__0DFAC42684D1EE11] PRIMARY KEY ([setting_key]); END;

-- (no secondary indexes on [system_settings])

-- (no FOREIGN KEYS on [system_settings])

-- ============================================================================
-- R161.3 (2026-10-25) — 外键集中段 (deferred foreign keys)
--
-- 为什么挪到这里:
--   MSSQL 的 ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY 要求**被参照表
--   已经存在**, 而基线是**逐条 db.execute** 执行的 (不是一批), 所以外键所在
--   语句必须排在参照表 CREATE TABLE 之后。原来 22 条外键里有 16 条排在了
--   参照表前面 (ad_sites / ad_member_servers / package_scripts /
--   ad_server_groups / report_email_outbox / sys_roles / system_alerts),
--   新装时逐条报 Msg 1750 (表不存在) ⇒ 初始化向导 500。
--   MySQL 侧没有这个问题: InnoDB 允许 CREATE TABLE 时先写外键, 参照表
--   稍后再建 (表是空表, 补建后约束自动生效)。
--
-- 放在这里 = 所有表都建完之后再建外键, 于是**永远不可能再出现前向引用**,
--   新增表也不需要再手工调整外键位置。
--
-- 幂等: 每条都带 IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys ...) 守卫。
-- ============================================================================
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'fk_dcs_site')
BEGIN ALTER TABLE [ad_dcs] ADD CONSTRAINT [fk_dcs_site] FOREIGN KEY ([site_id]) REFERENCES [dbo].[ad_sites] ([site_id]); END;
-- R161.6 (2026-10-26) — 补齐 fk_dc_overview_site, 与 MySQL 侧内联外键对等。
--   排在 ad_sites 建表之后 (本段位于文末, 天然满足), 参照列 site_id 是
--   ad_sites 的 PK, 子列 ad_dc_overview.[site_id] 为 INT NULL —— 类型匹配。
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'fk_dc_overview_site')
BEGIN ALTER TABLE [ad_dc_overview] ADD CONSTRAINT [fk_dc_overview_site] FOREIGN KEY ([site_id]) REFERENCES [dbo].[ad_sites] ([site_id]); END;
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'fk_forest_dc_domain')
BEGIN ALTER TABLE [ad_forest_dc_assignment] ADD CONSTRAINT [fk_forest_dc_domain] FOREIGN KEY ([domain_id]) REFERENCES [dbo].[ad_forest_domain] ([id]); END;
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'fk_forest_dc_forest')
BEGIN ALTER TABLE [ad_forest_dc_assignment] ADD CONSTRAINT [fk_forest_dc_forest] FOREIGN KEY ([forest_id]) REFERENCES [dbo].[ad_forest] ([id]) ON DELETE CASCADE; END;
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'fk_forest_domain_forest')
BEGIN ALTER TABLE [ad_forest_domain] ADD CONSTRAINT [fk_forest_domain_forest] FOREIGN KEY ([forest_id]) REFERENCES [dbo].[ad_forest] ([id]) ON DELETE CASCADE; END;
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'fk_forest_domain_setting_domain')
BEGIN ALTER TABLE [ad_forest_domain_setting] ADD CONSTRAINT [fk_forest_domain_setting_domain] FOREIGN KEY ([domain_id]) REFERENCES [dbo].[ad_forest_domain] ([id]) ON DELETE CASCADE; END;
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'fk_forest_setting_forest')
BEGIN ALTER TABLE [ad_forest_setting] ADD CONSTRAINT [fk_forest_setting_forest] FOREIGN KEY ([forest_id]) REFERENCES [dbo].[ad_forest] ([id]) ON DELETE CASCADE; END;
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'fk_ad_member_eventlog_events_host')
BEGIN ALTER TABLE [ad_member_eventlog_events] ADD CONSTRAINT [fk_ad_member_eventlog_events_host] FOREIGN KEY ([hostname]) REFERENCES [dbo].[ad_member_servers] ([hostname]) ON DELETE CASCADE; END;
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'fk_ad_member_eventlog_summary_host')
BEGIN ALTER TABLE [ad_member_eventlog_summary] ADD CONSTRAINT [fk_ad_member_eventlog_summary_host] FOREIGN KEY ([hostname]) REFERENCES [dbo].[ad_member_servers] ([hostname]) ON DELETE CASCADE; END;
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'fk_ad_member_heartbeat_host')
BEGIN ALTER TABLE [ad_member_heartbeat] ADD CONSTRAINT [fk_ad_member_heartbeat_host] FOREIGN KEY ([hostname]) REFERENCES [dbo].[ad_member_servers] ([hostname]) ON DELETE CASCADE; END;
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'fk_ad_member_os_baseline_host')
BEGIN ALTER TABLE [ad_member_os_baseline] ADD CONSTRAINT [fk_ad_member_os_baseline_host] FOREIGN KEY ([hostname]) REFERENCES [dbo].[ad_member_servers] ([hostname]) ON DELETE CASCADE; END;
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'fk_ad_member_os_baseline_latest_host')
BEGIN ALTER TABLE [ad_member_os_baseline_latest] ADD CONSTRAINT [fk_ad_member_os_baseline_latest_host] FOREIGN KEY ([hostname]) REFERENCES [dbo].[ad_member_servers] ([hostname]) ON DELETE CASCADE; END;
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'fk_msp_host')
BEGIN ALTER TABLE [ad_member_server_packages] ADD CONSTRAINT [fk_msp_host] FOREIGN KEY ([hostname]) REFERENCES [dbo].[ad_member_servers] ([hostname]) ON DELETE CASCADE; END;
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'fk_msp_pkg')
BEGIN ALTER TABLE [ad_member_server_packages] ADD CONSTRAINT [fk_msp_pkg] FOREIGN KEY ([package_name]) REFERENCES [dbo].[package_scripts] ([name]) ON DELETE CASCADE; END;
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'fk_ad_member_server_ports_host')
BEGIN ALTER TABLE [ad_member_server_ports] ADD CONSTRAINT [fk_ad_member_server_ports_host] FOREIGN KEY ([hostname]) REFERENCES [dbo].[ad_member_servers] ([hostname]) ON DELETE CASCADE; END;
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'fk_member_servers_site')
BEGIN ALTER TABLE [ad_member_servers] ADD CONSTRAINT [fk_member_servers_site] FOREIGN KEY ([site_id]) REFERENCES [dbo].[ad_sites] ([site_id]) ON DELETE SET NULL; END;
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'fk_sgm_host')
BEGIN ALTER TABLE [ad_server_group_members] ADD CONSTRAINT [fk_sgm_host] FOREIGN KEY ([hostname]) REFERENCES [dbo].[ad_member_servers] ([hostname]) ON DELETE CASCADE; END;
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'fk_sgm_group')
BEGIN ALTER TABLE [ad_server_group_members] ADD CONSTRAINT [fk_sgm_group] FOREIGN KEY ([group_id]) REFERENCES [dbo].[ad_server_groups] ([group_id]) ON DELETE CASCADE; END;
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'fk_dro_outbox')
BEGIN ALTER TABLE [daily_reports] ADD CONSTRAINT [fk_dro_outbox] FOREIGN KEY ([outbox_id]) REFERENCES [dbo].[report_email_outbox] ([id]) ON DELETE SET NULL; END;
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'fk_package_policies_name')
BEGIN ALTER TABLE [package_policies] ADD CONSTRAINT [fk_package_policies_name] FOREIGN KEY ([name]) REFERENCES [dbo].[package_scripts] ([name]) ON DELETE CASCADE; END;
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'fk_role_permissions_role')
BEGIN ALTER TABLE [role_permissions] ADD CONSTRAINT [fk_role_permissions_role] FOREIGN KEY ([role_id]) REFERENCES [dbo].[sys_roles] ([id]) ON DELETE CASCADE; END;
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'fk_users_role')
BEGIN ALTER TABLE [sys_users] ADD CONSTRAINT [fk_users_role] FOREIGN KEY ([role_id]) REFERENCES [dbo].[sys_roles] ([id]); END;
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'fk_sao_alert')
BEGIN ALTER TABLE [system_alert_outbox] ADD CONSTRAINT [fk_sao_alert] FOREIGN KEY ([alert_id]) REFERENCES [dbo].[system_alerts] ([id]) ON DELETE CASCADE; END;
-- --------------------------------------------------------------------------
-- View: [v_partner_inbound]
-- --------------------------------------------------------------------------
-- R161.3 (2026-10-25) — CREATE VIEW 必须是**批次的第一条语句**, 否则 Msg 156
--   "CREATE VIEW must be the first statement in a query batch"。
--   旧写法 `IF OBJECT_ID(...) IS NULL` 换行接 `CREATE VIEW` 会被生产切分器
--   (splitSqlStatements) 合成**同一条**语句 ⇒ 整条发过去必然 Msg 156。
--   改成"先 DROP 再 CREATE"两条独立语句: 切分器按 `;` 切开, 每条各自成批,
--   CREATE VIEW 单独成批 ⇒ 合法; 而且 DROP 让重跑基线也能重建视图
--   (旧的 "IF NOT EXISTS 就跳过" 语义会让基线里的视图定义永远更新不了)。
IF OBJECT_ID('[v_partner_inbound]', 'V') IS NOT NULL
  DROP VIEW [v_partner_inbound];
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
  
  CASE
    WHEN EXISTS (SELECT 1 FROM ad_replication_probe_history h
                 WHERE h.source_dc = i.dest_dc AND h.dest_dc = i.source_dc
                   AND h.status_code = 2
                   AND h.attempt_at >= DATEADD(MINUTE, -15, SYSUTCDATETIME())) THEN 'error'
    WHEN EXISTS (SELECT 1 FROM ad_replication_probe_history h
                 WHERE h.source_dc = i.dest_dc AND h.dest_dc = i.source_dc
                   AND h.status_code = 0
                   AND h.attempt_at >= DATEADD(MINUTE, -15, SYSUTCDATETIME())) THEN 'success'
    WHEN EXISTS (SELECT 1 FROM ad_replication_probe_history h
                 WHERE h.source_dc = i.dest_dc AND h.dest_dc = i.source_dc
                   AND h.attempt_at >= DATEADD(MINUTE, -15, SYSUTCDATETIME())) THEN 'partial'
    ELSE 'none'
  END AS probe_state,
  (SELECT MAX(h.attempt_at) FROM ad_replication_probe_history h
   WHERE h.source_dc = i.dest_dc AND h.dest_dc = i.source_dc
     AND h.attempt_at >= DATEADD(MINUTE, -15, SYSUTCDATETIME())
  ) AS probe_attempt_at,
  (SELECT TOP 1 h.duration_ms FROM ad_replication_probe_history h
   WHERE h.source_dc = i.dest_dc AND h.dest_dc = i.source_dc
     AND h.attempt_at >= DATEADD(MINUTE, -15, SYSUTCDATETIME())
   ORDER BY h.status_code DESC, h.attempt_at DESC
  ) AS probe_duration_ms,
  (SELECT TOP 1 h.error_message FROM ad_replication_probe_history h
   WHERE h.source_dc = i.dest_dc AND h.dest_dc = i.source_dc
     AND h.attempt_at >= DATEADD(MINUTE, -15, SYSUTCDATETIME())
   ORDER BY h.status_code DESC, h.attempt_at DESC
  ) AS probe_error_message
FROM ad_partner_inbound i
INNER JOIN ad_dcs d     ON d.dc_name = i.dest_dc
LEFT  JOIN ad_sites s   ON s.site_id = d.site_id
LEFT  JOIN ad_dcs pd    ON pd.dc_name = i.source_dc
LEFT  JOIN ad_sites ps  ON ps.site_id = pd.site_id
WHERE i.source_dc <> i.dest_dc
  AND i.collected_at >= DATEADD(DAY, -30, SYSUTCDATETIME())
GO
-- ============================================================================
-- R158.X.99.31 (2026-10-19) — 1.0.0 baseline seed block (begin)
-- Source-of-truth values read from live production DB on 2026-10-19
-- (server 10.170.140.23:1433 / dashboard / dbo).
-- Idempotent: every INSERT is wrapped in IF NOT EXISTS, so re-running
-- the baseline on an already-initialised DB is a no-op. Matches the
-- R158.51 single-file-baseline design (center/src/init/schema-applier.js:241-244).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) sys_roles — 3 rows
-- ---------------------------------------------------------------------------
-- R161.3 (2026-10-25) — sys_roles.id 是 IDENTITY 列, 显式给 id 必须先
--   SET IDENTITY_INSERT ... ON, 否则 Msg 544 "Cannot insert explicit value
--   for identity column in table 'sys_roles' when IDENTITY_INSERT is set to OFF"。
--   id 必须显式给: 下一段 role_permissions 种子按 role_id = 1/2/3 引用,
--   靠 IDENTITY 自动分配的话, 在"表已存在且角色 id 已被占用"的库上会对不上。
--   SET IDENTITY_INSERT 是**会话级**开关, ON 之后必须成对 OFF。
IF NOT EXISTS (SELECT 1 FROM sys_roles WHERE role_name = 'admin')
BEGIN
  SET IDENTITY_INSERT [sys_roles] ON;
  INSERT INTO sys_roles ([id], [role_name]) VALUES (1, 'admin');
  SET IDENTITY_INSERT [sys_roles] OFF;
END;
IF NOT EXISTS (SELECT 1 FROM sys_roles WHERE role_name = 'operator')
BEGIN
  SET IDENTITY_INSERT [sys_roles] ON;
  INSERT INTO sys_roles ([id], [role_name]) VALUES (2, 'operator');
  SET IDENTITY_INSERT [sys_roles] OFF;
END;
IF NOT EXISTS (SELECT 1 FROM sys_roles WHERE role_name = 'viewer')
BEGIN
  SET IDENTITY_INSERT [sys_roles] ON;
  INSERT INTO sys_roles ([id], [role_name]) VALUES (3, 'viewer');
  SET IDENTITY_INSERT [sys_roles] OFF;
END;
GO

-- ---------------------------------------------------------------------------
-- 2) role_permissions — 4 rows
-- ---------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM role_permissions WHERE role_id = 1 AND permission = '*')
  INSERT INTO role_permissions ([role_id], [permission]) VALUES (1, '*');
IF NOT EXISTS (SELECT 1 FROM role_permissions WHERE role_id = 2 AND permission = 'execute:sync')
  INSERT INTO role_permissions ([role_id], [permission]) VALUES (2, 'execute:sync');
IF NOT EXISTS (SELECT 1 FROM role_permissions WHERE role_id = 2 AND permission = 'read:dash')
  INSERT INTO role_permissions ([role_id], [permission]) VALUES (2, 'read:dash');
IF NOT EXISTS (SELECT 1 FROM role_permissions WHERE role_id = 3 AND permission = 'read:dash')
  INSERT INTO role_permissions ([role_id], [permission]) VALUES (3, 'read:dash');
GO

-- ---------------------------------------------------------------------------
-- 3) system_config — 40 rows (install-time-not-generated subset)
-- ---------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'access_domain')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('access_domain', '', '客户端与 Agent 访问域名;留空则用服务器 IP');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'admin_email')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('admin_email', '', 'License / 通用通知发件人邮箱');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'email_enabled')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('email_enabled', '0', '邮件总开关 (0/1). 0=关闭: 不入 outbox + 不发 SMTP; 1=启用');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'audit_retention_days')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('audit_retention_days', '90', '审计日志保留天数 (默认 90, 设 0 禁用清理)');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'polling_interval_minutes')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('polling_interval_minutes', '15', 'Agent collection interval in minutes');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'discovery_interval_hours')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('discovery_interval_hours', '4', 'Agent 站点/域控拓扑发现周期 (小时)');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'heartbeat_interval_seconds')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('heartbeat_interval_seconds', '30', 'Agent 心跳间隔 (秒), 越短越快感知离线, 默认 30');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'heartbeat_stale_seconds')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('heartbeat_stale_seconds', '15', '心跳 stale 阈值 (秒),超过即判定 agent 离线');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'heartbeat_port')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('heartbeat_port', '8081', 'Agent 心跳接收端口 (DB 改后 5 min 内 agent 自动刷新)');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'latency_threshold_minutes')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('latency_threshold_minutes', '180', 'Replication latency warning threshold');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'history_enabled')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('history_enabled', '0', 'Append to ad_replication_history (0/1)');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'ad_sync_interval_minutes')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('ad_sync_interval_minutes', '60', 'AD 同步周期 (分钟)');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'ad_mgmt_retention_days')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('ad_mgmt_retention_days', '30', 'AD 管理日志保留天数');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'ad_notify_enabled')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('ad_notify_enabled', '0', 'AD 操作通知邮件总开关 (0/1)');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'ad_notify_to')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('ad_notify_to', '', 'AD 操作通知主送邮箱');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'ad_notify_cc')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('ad_notify_cc', '', 'AD 操作通知抄送邮箱 (逗号分隔)');
-- R158.X.99 (2026-10-23) — 两个模板对齐代码兜底 (services/config.js:412-419 +
--   services/ad-notify.js:135-143)。改前的 seed 值有两处实际缺陷:
--   1) subject 少了尾部 "— {{target_dc}}";
--   2) body 用 {{command_type}}, 但 placeholders 字典 (ad-notify.js:120-134)
--      只有 13 个键, **没有 command_type** —— renderTemplate (:49-55) 对未知键
--      返回 '' , 于是正文渲染成「... 执行  — 结果: ...」(中间空一段)。
--      正确键名是 {{kind_label}}。
--   换行用 CHAR(10): MSSQL 字符串字面量**不把 \n 当转义**, 写 '\n' 会得到
--   字面反斜杠+n。MySQL 侧同修, 那边 '\n' 是真转义 (见 mysql baseline)。
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'ad_notify_subject_template')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('ad_notify_subject_template', '[AD 操作通知] {{result_label}} — {{sam}}{{target}} — {{target_dc}}', 'AD 操作通知邮件主题模板');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'ad_notify_body_template')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('ad_notify_body_template',
      '操作员 {{operator}} 在 {{time}} 于 {{target_dc}} 执行 AD 操作 {{kind_label}}' + CHAR(10) +
      '目标: {{sam}}{{target}}' + CHAR(10) +
      '结果: {{result_label}}' + CHAR(10) +
      'Task ID: {{task_id}}' + CHAR(10) +
      '耗时: {{duration_ms}}ms' + CHAR(10) +
      '错误: {{error}}',
      'AD 操作通知邮件正文模板');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'ad_ldap_url')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('ad_ldap_url', '', 'AD LDAP URL, 例如 ldap://dc01.contoso.com');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'ad_base_dn')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('ad_base_dn', '', 'AD 基础 DN, 例如 DC=contoso,DC=com');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'ad_bind_dn')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('ad_bind_dn', '', 'AD 绑定 DN (服务账号)');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'ad_bind_password')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('ad_bind_password', '', 'AD 绑定密码 (服务账号)');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'file_push_retention_days')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('file_push_retention_days', '7', 'file-push task 保留天数 (failed/delivered)');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'file_push_claim_ttl_minutes')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('file_push_claim_ttl_minutes', '60', 'file-push claim TTL (minutes) — 超时 auto-fail');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'report_daily_cc')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('report_daily_cc', '', '日报默认抄送邮箱');
-- R158.X.99 (2026-10-23) — 补齐 seedReportsDefaultsIfMissing (services/config.js:370-381)
--   的其余 9 个键。此前 baseline 只有 report_daily_cc 一个。
--   值**逐字取自代码**, 不另设默认 —— 两侧漂移就会让「改代码默认值」这条路径失效。
--   enabled 默认 '0' = 默认关闭: 这两个键必须一起 seed, 否则只补 cron 会出现
--   「表达式在但永远不发」(report-scheduler.js:293 `!== '1'` 直接 return)。
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'report_daily_enabled')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('report_daily_enabled', '0', '日报总开关 (0/1), 0=不发送');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'report_daily_cron')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('report_daily_cron', '0 9 * * *', '日报发送时刻 (5 字段 cron, CST 墙钟: 分 时 日 月 周)');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'report_daily_to')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('report_daily_to', '', '日报主送邮箱, 留空回退 alert_default_to');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'report_weekly_enabled')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('report_weekly_enabled', '0', '周报总开关 (0/1), 0=不发送');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'report_weekly_cron')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('report_weekly_cron', '0 9 * * MON', '周报发送时刻 (5 字段 cron, CST 墙钟: 分 时 日 月 周)');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'report_weekly_to')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('report_weekly_to', '', '周报主送邮箱, 留空回退 alert_default_to');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'report_weekly_cc')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('report_weekly_cc', '', '周报抄送邮箱 (逗号分隔)');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'report_loop_interval_seconds')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('report_loop_interval_seconds', '300', '报表调度循环周期 (秒, 5min)');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'report_retention_days')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('report_retention_days', '30', '报表历史保留天数 (0=禁用清理; R158.107 起实际清理由 8 个 retention service 负责)');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'system_alert_heartbeat_offline_minutes')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('system_alert_heartbeat_offline_minutes', '15', 'Agent 心跳离线告警阈值 (分钟)');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'system_alert_replication_failure_count')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('system_alert_replication_failure_count', '30', '复制连续失败次数告警阈值');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'system_alert_port_latency_ms')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('system_alert_port_latency_ms', '100', '端口延迟告警阈值 (毫秒)');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'system_alert_disk_free_kb')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('system_alert_disk_free_kb', '10485760', '磁盘可用空间告警阈值 (KB, 10 GB)');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'system_alert_failed_logon_24h')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('system_alert_failed_logon_24h', '5000', '24h 失败登录告警阈值');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'system_alert_eval_interval_seconds')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('system_alert_eval_interval_seconds', '600', '系统告警评估周期 (秒, 10 min)');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'system_alert_to')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('system_alert_to', '', '系统告警主送邮箱 (逗号分隔)');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'alert_default_cc')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('alert_default_cc', '', '告警默认抄送邮箱 (逗号分隔)');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'alert_default_to')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('alert_default_to', '', '告警默认主送邮箱 (留空走 system_alert_to)');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'alert_email_initial_backoff_seconds')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('alert_email_initial_backoff_seconds', '30', '告警邮件重试初始退避 (秒)');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'alert_email_max_attempts')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('alert_email_max_attempts', '5', '告警邮件最大重试次数');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'alert_eval_interval_seconds')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('alert_eval_interval_seconds', '60', '告警规则评估周期 (秒)');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'jwt_secret_previous_ttl_days')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('jwt_secret_previous_ttl_days', '30', 'jwt_secret_previous 保留天数 (旋转后失效)');
-- R158.X.99 dbparity (2026-10-23) — 补 2 个 MySQL baseline 早已有、MSSQL 侧漏掉的配置项。
--   两者的代码兜底都在 (config.js:581 `Number(all.report_port) || 8082`;
--   前端 SiteReplicationMatrixView 缺行时 fallback 10s), 但 seed 让默认值在
--   ConfigView 里从 t=0 就可见可审计, 且不依赖 fallback 链不回归。
--   MySQL 对应行见 mysql/1.0.0-baseline.sql:1082 / :1086。
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'report_port')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('report_port', '8082', 'Agent replication snapshot 上报端口');
IF NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = 'site_matrix_refresh_seconds')
  INSERT INTO system_config ([config_key], [config_value], [description]) VALUES
    ('site_matrix_refresh_seconds', '10', '站点复制矩阵自动刷新间隔 (秒)');
-- ⚠ 刻意**不**补 'ad_agent_token': MySQL baseline:1071 仍在 seed 它, 但本项目
--   已废弃该键 (services/config.js:245 AGENT_TOKEN_BLOCKED_KEYS — 写入返 400)。
--   运行时真源是 'agent_token_current', 由 /api/admin/agent-token/rotate 维护。
--   在 MSSQL baseline 里补一个"生下来就被禁写"的行只会误导操作员。
GO

-- ---------------------------------------------------------------------------
-- 3b) probe_state — 3 rows (web / heartbeat / report)
-- ---------------------------------------------------------------------------
-- R158.X.99 dbparity (2026-10-23) — MySQL baseline:295-298 早已 seed 这 3 行,
--   MSSQL 侧此前只建表不 seed。services/probe.js 的 upsertRow (MERGE) 会在首个
--   tick 自愈, 所以存量库无感; 但新装机在首个 tick 之前端口健康度是空的。
--   status='unknown' 是 NOT NULL 列的合法初值 (与 MySQL 侧一致), 不是 'healthy' ——
--   seeded 就宣称 healthy 会把"还没探过"误报成"探过且正常"。
--   生产库实测 3 行均 healthy 是探针跑出来的, 不是 seed 出来的。
IF NOT EXISTS (SELECT 1 FROM probe_state WHERE port_role = 'web')
  INSERT INTO probe_state ([port_role], [status], [latency_ms], [last_probe_at], [last_up_at], [consecutive_failures]) VALUES
    ('web', 'unknown', NULL, NULL, NULL, 0);
IF NOT EXISTS (SELECT 1 FROM probe_state WHERE port_role = 'heartbeat')
  INSERT INTO probe_state ([port_role], [status], [latency_ms], [last_probe_at], [last_up_at], [consecutive_failures]) VALUES
    ('heartbeat', 'unknown', NULL, NULL, NULL, 0);
IF NOT EXISTS (SELECT 1 FROM probe_state WHERE port_role = 'report')
  INSERT INTO probe_state ([port_role], [status], [latency_ms], [last_probe_at], [last_up_at], [consecutive_failures]) VALUES
    ('report', 'unknown', NULL, NULL, NULL, 0);
GO

-- ---------------------------------------------------------------------------
-- R161.3 (2026-10-25) — 每条种子都加了 `AND EXISTS (SELECT 1 FROM package_scripts
--   WHERE [name] = ...)` 守卫: package_policies.name 有外键指向 package_scripts.name,
--   而 package_scripts 在新装库上是空表 (内置包清单由中心端 builtin-packages.js
--   启动时同步进来)。MySQL 侧靠 INSERT IGNORE 静默丢弃这些行, MSSQL 没有 IGNORE,
--   不加守卫就是 Msg 547 外键冲突 ⇒ 初始化向导 500。加守卫后两边言效果一致:
--   新装库 0 行 (等清单同步后由 builtin-packages 补齐), 已有清单的库正常入库。
-- 4) package_policies — 14 条种子 (1:1 with BUILTIN_PACKAGES)
--    R161.6 (2026-10-26) — 措辞更正: 是"14 条种子语句", 不是"库里 14 行"。
--    新装库上 package_scripts 是空表 ⇒ 守卫不成立 ⇒ 实际落库 0 行
--    (与 MySQL 侧 INSERT IGNORE 被外键违例静默跳过的净结果一致)。
-- cron_expr column: R158.72.x.13 ALTER added 2026-10-17. The
-- IF COL_LENGTH guard below makes the seed idempotent against
-- pre/post cron_expr-ADD states.
-- ---------------------------------------------------------------------------
-- 4a) Self-interval 范式 (10 包, interval_sec 非 0, agent 端 setInterval)
IF NOT EXISTS (SELECT 1 FROM package_policies WHERE [name] = 'ad_dc_overview')
   AND EXISTS (SELECT 1 FROM package_scripts WHERE [name] = 'ad_dc_overview')
  INSERT INTO package_policies ([name], [interval_sec], [timeout_ms], [enabled], [params_json], [scope], [cron_expr], [created_at], [updated_at]) VALUES
    ('ad_dc_overview', 900, 60000, 1, NULL, 'agent_type:ad', NULL, SYSUTCDATETIME(), SYSUTCDATETIME());
IF NOT EXISTS (SELECT 1 FROM package_policies WHERE [name] = 'ad_lockout_summary')
   AND EXISTS (SELECT 1 FROM package_scripts WHERE [name] = 'ad_lockout_summary')
  INSERT INTO package_policies ([name], [interval_sec], [timeout_ms], [enabled], [params_json], [scope], [cron_expr], [created_at], [updated_at]) VALUES
    ('ad_lockout_summary', 900, 60000, 1, NULL, 'agent_type:ad', NULL, SYSUTCDATETIME(), SYSUTCDATETIME());
IF NOT EXISTS (SELECT 1 FROM package_policies WHERE [name] = 'ad_lockout_list')
   AND EXISTS (SELECT 1 FROM package_scripts WHERE [name] = 'ad_lockout_list')
  INSERT INTO package_policies ([name], [interval_sec], [timeout_ms], [enabled], [params_json], [scope], [cron_expr], [created_at], [updated_at]) VALUES
    ('ad_lockout_list', 900, 60000, 1, NULL, 'agent_type:ad', NULL, SYSUTCDATETIME(), SYSUTCDATETIME());
IF NOT EXISTS (SELECT 1 FROM package_policies WHERE [name] = 'ad_dc_probe_inbound')
   AND EXISTS (SELECT 1 FROM package_scripts WHERE [name] = 'ad_dc_probe_inbound')
  INSERT INTO package_policies ([name], [interval_sec], [timeout_ms], [enabled], [params_json], [scope], [cron_expr], [created_at], [updated_at]) VALUES
    ('ad_dc_probe_inbound', 900, 60000, 1, NULL, 'agent_type:ad', NULL, SYSUTCDATETIME(), SYSUTCDATETIME());
IF NOT EXISTS (SELECT 1 FROM package_policies WHERE [name] = 'ad_replication_status_probe')
   AND EXISTS (SELECT 1 FROM package_scripts WHERE [name] = 'ad_replication_status_probe')
  INSERT INTO package_policies ([name], [interval_sec], [timeout_ms], [enabled], [params_json], [scope], [cron_expr], [created_at], [updated_at]) VALUES
    ('ad_replication_status_probe', 600, 60000, 1, NULL, 'agent_type:ad', NULL, SYSUTCDATETIME(), SYSUTCDATETIME());
IF NOT EXISTS (SELECT 1 FROM package_policies WHERE [name] = 'ad_failed_logon_collector')
   AND EXISTS (SELECT 1 FROM package_scripts WHERE [name] = 'ad_failed_logon_collector')
  INSERT INTO package_policies ([name], [interval_sec], [timeout_ms], [enabled], [params_json], [scope], [cron_expr], [created_at], [updated_at]) VALUES
    ('ad_failed_logon_collector', 900, 120000, 1, NULL, 'agent_type:ad', NULL, SYSUTCDATETIME(), SYSUTCDATETIME());
IF NOT EXISTS (SELECT 1 FROM package_policies WHERE [name] = 'ad_os_baseline')
   AND EXISTS (SELECT 1 FROM package_scripts WHERE [name] = 'ad_os_baseline')
  INSERT INTO package_policies ([name], [interval_sec], [timeout_ms], [enabled], [params_json], [scope], [cron_expr], [created_at], [updated_at]) VALUES
    ('ad_os_baseline', 900, 20000, 1, NULL, 'agent_type:ad', NULL, SYSUTCDATETIME(), SYSUTCDATETIME());
IF NOT EXISTS (SELECT 1 FROM package_policies WHERE [name] = 'member_eventlog_collector')
   AND EXISTS (SELECT 1 FROM package_scripts WHERE [name] = 'member_eventlog_collector')
  INSERT INTO package_policies ([name], [interval_sec], [timeout_ms], [enabled], [params_json], [scope], [cron_expr], [created_at], [updated_at]) VALUES
    ('member_eventlog_collector', 7200, 60000, 1, NULL, 'agent_type:non-ad', NULL, SYSUTCDATETIME(), SYSUTCDATETIME());
IF NOT EXISTS (SELECT 1 FROM package_policies WHERE [name] = 'member_admin_groups')
   AND EXISTS (SELECT 1 FROM package_scripts WHERE [name] = 'member_admin_groups')
  INSERT INTO package_policies ([name], [interval_sec], [timeout_ms], [enabled], [params_json], [scope], [cron_expr], [created_at], [updated_at]) VALUES
    ('member_admin_groups', 86400, 60000, 1, NULL, 'agent_type:non-ad', NULL, SYSUTCDATETIME(), SYSUTCDATETIME());
IF NOT EXISTS (SELECT 1 FROM package_policies WHERE [name] = 'member_os_baseline_collector')
   AND EXISTS (SELECT 1 FROM package_scripts WHERE [name] = 'member_os_baseline_collector')
  INSERT INTO package_policies ([name], [interval_sec], [timeout_ms], [enabled], [params_json], [scope], [cron_expr], [created_at], [updated_at]) VALUES
    ('member_os_baseline_collector', 900, 20000, 1, NULL, 'agent_type:non-ad', NULL, SYSUTCDATETIME(), SYSUTCDATETIME());
-- 4b) Cron 范式 (4 包, interval_sec=0, 中心端 cron 唯一 fire 源)
IF NOT EXISTS (SELECT 1 FROM package_policies WHERE [name] = 'ad_eventlog_collector')
   AND EXISTS (SELECT 1 FROM package_scripts WHERE [name] = 'ad_eventlog_collector')
  INSERT INTO package_policies ([name], [interval_sec], [timeout_ms], [enabled], [params_json], [scope], [cron_expr], [created_at], [updated_at]) VALUES
    ('ad_eventlog_collector', 0, 60000, 1, NULL, 'agent_type:ad', '0 */2 * * *', SYSUTCDATETIME(), SYSUTCDATETIME());
IF NOT EXISTS (SELECT 1 FROM package_policies WHERE [name] = 'ad_partner_inbound_discover')
   AND EXISTS (SELECT 1 FROM package_scripts WHERE [name] = 'ad_partner_inbound_discover')
  INSERT INTO package_policies ([name], [interval_sec], [timeout_ms], [enabled], [params_json], [scope], [cron_expr], [created_at], [updated_at]) VALUES
    ('ad_partner_inbound_discover', 0, 60000, 1, NULL, 'agent_type:ad', '0 2 * * *', SYSUTCDATETIME(), SYSUTCDATETIME());
IF NOT EXISTS (SELECT 1 FROM package_policies WHERE [name] = 'ad_admin_members')
   AND EXISTS (SELECT 1 FROM package_scripts WHERE [name] = 'ad_admin_members')
  INSERT INTO package_policies ([name], [interval_sec], [timeout_ms], [enabled], [params_json], [scope], [cron_expr], [created_at], [updated_at]) VALUES
    ('ad_admin_members', 0, 120000, 1, NULL, 'agent_type:ad', '0 2 * * *', SYSUTCDATETIME(), SYSUTCDATETIME());
IF NOT EXISTS (SELECT 1 FROM package_policies WHERE [name] = 'ad_account_change')
   AND EXISTS (SELECT 1 FROM package_scripts WHERE [name] = 'ad_account_change')
  INSERT INTO package_policies ([name], [interval_sec], [timeout_ms], [enabled], [params_json], [scope], [cron_expr], [created_at], [updated_at]) VALUES
    ('ad_account_change', 0, 180000, 1, NULL, 'agent_type:ad', '0 2 * * *', SYSUTCDATETIME(), SYSUTCDATETIME());
GO

-- ============================================================================
-- R158.X.99.31 (2026-10-19) — 1.0.0 baseline seed block (end)
-- ============================================================================

-- ============================================================================
-- R158.X.115 (2026-10-20) — host lifecycle columns.
-- decommissioned_at    非空 = 已退役 (终态, 不可逆)
-- monitoring_paused_at 非空 = 暂停管控 (临时态, 手动恢复, 无自动到期)
-- Read/written by center/src/services/host-status.js on every alert,
-- heartbeat and online-view query; both are nullable timestamps.
-- ============================================================================
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[ad_dcs]') AND name = 'decommissioned_at')
BEGIN ALTER TABLE [ad_dcs] ADD [decommissioned_at] DATETIME2 NULL; END;

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[ad_dcs]') AND name = 'monitoring_paused_at')
BEGIN ALTER TABLE [ad_dcs] ADD [monitoring_paused_at] DATETIME2 NULL; END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_ad_dcs_lifecycle')
BEGIN CREATE NONCLUSTERED INDEX [ix_ad_dcs_lifecycle] ON [ad_dcs] ([decommissioned_at], [monitoring_paused_at]); END;

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[ad_member_servers]') AND name = 'decommissioned_at')
BEGIN ALTER TABLE [ad_member_servers] ADD [decommissioned_at] DATETIME2 NULL; END;

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[ad_member_servers]') AND name = 'monitoring_paused_at')
BEGIN ALTER TABLE [ad_member_servers] ADD [monitoring_paused_at] DATETIME2 NULL; END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_ad_member_servers_lifecycle')
BEGIN CREATE NONCLUSTERED INDEX [ix_ad_member_servers_lifecycle] ON [ad_member_servers] ([decommissioned_at], [monitoring_paused_at]); END;

-- ---------------------------------------------------------------------------
-- R158.X.99-quota (2026-10-21) — ad_system_registration node-quota columns
--
-- ad_system_registration.max_nodes / max_nodes_allowed are where an issued
-- licence's node count lands. Without them the activate endpoint cannot write
-- the requested figure, so the authorisation intent is lost after activation
-- and no quota can be enforced (see src/services/license-quota.js).
--
-- Both columns are declared in the CREATE TABLE block above; these guarded
-- ALTERs exist only for deployments whose database was created BEFORE this
-- baseline revision shipped. Fresh installs skip them.
--   max_nodes          — the vendor's original intent, stored verbatim
--   max_nodes_allowed  — ceil(max_nodes × 1.2), computed once at activate time
--                        and frozen, so a later change to the grace ratio does
--                        not silently rewrite existing customers' grants.
-- Pre-R158.LA rows stay NULL in both = unlimited = prior behaviour. Backfilling
-- 0 would be guessing the vendor's intent, which is worse than not knowing.
-- ---------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[ad_system_registration]') AND name = 'max_nodes')
BEGIN ALTER TABLE [ad_system_registration] ADD [max_nodes] INT NULL; END;

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[ad_system_registration]') AND name = 'max_nodes_allowed')
BEGIN ALTER TABLE [ad_system_registration] ADD [max_nodes_allowed] INT NULL; END;


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
--   本段原注释写的是"显式 seed 之后默认值在 UI 与 DB 里都可见" —— 已不成立:
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
IF NOT EXISTS (SELECT 1 FROM ad_feature_flags WHERE [key] = 'agent_upgrade_rollout_strategy')
  INSERT INTO ad_feature_flags ([key], [value], [description]) VALUES
    ('agent_upgrade_rollout_strategy', 'full', 'Agent 升级发布策略: full=全量放行 / canary=按比例灰度 / paused=熔断停发。缺行或非法值按 full 处理');
IF NOT EXISTS (SELECT 1 FROM ad_feature_flags WHERE [key] = 'agent_upgrade_canary_ratio')
  INSERT INTO ad_feature_flags ([key], [value], [description]) VALUES
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
-- 幂等: 只在键不存在时插入, 不覆盖操作员已改过的值。
-- ============================================================================
IF NOT EXISTS (SELECT 1 FROM ad_feature_flags WHERE [key] = 'ad_management.enabled')
  INSERT INTO ad_feature_flags ([key], [value], [description]) VALUES
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
-- 幂等: 只在键不存在时插入, 不覆盖操作员已改过的值。
-- ============================================================================
IF NOT EXISTS (SELECT 1 FROM ad_feature_flags WHERE [key] = 'mcp.enabled')
  INSERT INTO ad_feature_flags ([key], [value], [description]) VALUES
    ('mcp.enabled', '1', 'MCP 集成总开关 — 关闭后 sidebar 入口消失、/admin/mcp-token* 进不去、后端 /mcp 返 503 (已有 mcp_ token 失效)');
IF NOT EXISTS (SELECT 1 FROM ad_feature_flags WHERE [key] = 'mcp_write.enabled')
  INSERT INTO ad_feature_flags ([key], [value], [description]) VALUES
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
-- 幂等: IF NOT EXISTS 守卫, 不覆盖操作员已改过的值。
-- ============================================================================
IF NOT EXISTS (SELECT 1 FROM ad_feature_flags WHERE [key] = 'report_center.enabled')
  INSERT INTO ad_feature_flags ([key], [value], [description]) VALUES
    ('report_center.enabled', '1', '报表中心总开关 — 关闭后「报表中心」sidebar 入口消失、/report-center* 路由进不去、后端 /api/report-center/* 返 503 (已有报表数据不受影响)');
IF NOT EXISTS (SELECT 1 FROM ad_feature_flags WHERE [key] = 'report_center.lockout.enabled')
  INSERT INTO ad_feature_flags ([key], [value], [description]) VALUES
    ('report_center.lockout.enabled', '1', '报表中心·锁定账户 子开关 — 关闭后「锁定账户」报表入口消失、该子路由进不去、对应后端端点返 503 (跟总闸 report_center.enabled 同时满足才放行)');
IF NOT EXISTS (SELECT 1 FROM ad_feature_flags WHERE [key] = 'report_center.failed_logon.enabled')
  INSERT INTO ad_feature_flags ([key], [value], [description]) VALUES
    ('report_center.failed_logon.enabled', '1', '报表中心·密码错误 子开关 — 关闭后「密码错误」报表入口消失、该子路由进不去、对应后端端点返 503 (跟总闸 report_center.enabled 同时满足才放行)');
IF NOT EXISTS (SELECT 1 FROM ad_feature_flags WHERE [key] = 'report_center.account_change.enabled')
  INSERT INTO ad_feature_flags ([key], [value], [description]) VALUES
    ('report_center.account_change.enabled', '1', '报表中心·账户变更 子开关 — 关闭后「账户变更」报表入口消失、该子路由进不去、对应后端端点返 503 (跟总闸 report_center.enabled 同时满足才放行)');
GO
