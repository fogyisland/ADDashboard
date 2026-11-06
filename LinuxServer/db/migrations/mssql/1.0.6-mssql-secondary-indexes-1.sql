-- verify: index ad_admin_commands.ix_ad_admin_commands_target_status
-- verify: index ad_admin_commands.ix_ad_admin_commands_status_created
-- verify: index ad_admin_commands.ix_ad_admin_commands_operator
-- verify: index ad_admin_commands.ix_ad_admin_commands_dc_task
-- verify: index ad_admin_members.ix_admin_members_collected
-- verify: index ad_admin_members.ix_admin_members_group
-- verify: index ad_admin_members.ix_admin_members_run
-- verify: index ad_agent_upgrade_rollout.ix_rollout_status_activated
-- verify: index ad_computers_snapshot.idx_computers_forest_dc
-- verify: index ad_computers_snapshot.ix_computers_enabled
-- verify: index ad_computers_snapshot.ix_computers_is_server
-- verify: index ad_computers_snapshot.ix_computers_snapshot_at
-- verify: index ad_dc_overview.ix_dc_overview_collected
-- verify: index ad_dc_overview.ix_dc_overview_site
-- verify: index ad_directory_sync_runs.ix_sync_runs_started
-- verify: index ad_directory_sync_runs.ix_sync_runs_dc_status
-- verify: index ad_directory_sync_runs.idx_runs_forest_started
-- verify: index ad_eventlog_events.ix_eventlog_collected
-- verify: index ad_eventlog_events.ix_eventlog_dc_channel
-- verify: index ad_eventlog_events.ix_eventlog_severity
-- verify: index ad_eventlog_summary.ix_eventlog_summary_collected
-- verify: index ad_eventlog_summary.ix_eventlog_summary_dc
-- verify: index ad_failed_logon_events.ix_failed_logon_occurred_at
-- verify: index ad_failed_logon_events.ix_failed_logon_target_time
-- verify: index ad_failed_logon_events.ix_failed_logon_dc_time
-- verify: index ad_failed_logon_events.ix_failed_logon_ip_time
-- verify: index ad_forest_dc_assignment.ix_forest_dc_forest
-- verify: index ad_forest_dc_assignment.ix_forest_dc_domain
-- verify: index ad_forest_domain.ix_forest_domain_forest
-- verify: index ad_forest_domain_setting.ix_forest_domain_setting_domain
-- verify: index ad_forest_setting.ix_forest_setting_forest
-- verify: index ad_groups_snapshot.ix_groups_snapshot_at
-- verify: index ad_groups_snapshot.idx_groups_forest_dc
-- verify: index ad_license_request.ix_license_request_instance
-- verify: index ad_license_request.ix_license_request_kind
-- verify: index ad_lockout_events.ix_lockout_target_time
-- verify: index ad_lockout_events.ix_lockout_caller_time
-- verify: index ad_lockout_events.ix_lockout_dc_time
-- verify: index ad_lockout_events.ix_lockout_occurred
-- verify: index ad_member_admin_groups.idx_member_admin_hostname
--
-- R161.18 (2026-10-28) — 补齐缺失的**非唯一**二级索引 (第 1/3 批)
-- 非唯一索引 = 纯性能; 无数据风险。
SET LOCK_TIMEOUT 10000;
SET QUOTED_IDENTIFIER ON;
-- 非唯一索引 = 纯性能, 建索引不会因为数据重复而失败 ⇒ 零数据风险。
-- 本文件是第 1/3 批 (拆文件的原因: init/verify-marker.js
-- 只扫文件前 50 行的 verify 标记, 一批塞不下 40 个以上的标记)。

-- ad_admin_commands.ix_ad_admin_commands_target_status  [[target_dc], [status]]  键 288 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_admin_commands]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'target_dc'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'status'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_admin_commands' AND i.name = 'ix_ad_admin_commands_target_status'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_ad_admin_commands_target_status] ON [ad_admin_commands] ([target_dc], [status]);
END;

-- ad_admin_commands.ix_ad_admin_commands_status_created  [[status], [created_at]]  键 40 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_admin_commands]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'status'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'created_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_admin_commands' AND i.name = 'ix_ad_admin_commands_status_created'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_ad_admin_commands_status_created] ON [ad_admin_commands] ([status], [created_at]);
END;

-- ad_admin_commands.ix_ad_admin_commands_operator  [[operator_id], [created_at]]  键 16 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_admin_commands]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'operator_id'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'created_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_admin_commands' AND i.name = 'ix_ad_admin_commands_operator'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_ad_admin_commands_operator] ON [ad_admin_commands] ([operator_id], [created_at]);
END;

-- ad_admin_commands.ix_ad_admin_commands_dc_task  [[target_dc], [task_id]]  键 384 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_admin_commands]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'target_dc'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'task_id'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_admin_commands' AND i.name = 'ix_ad_admin_commands_dc_task'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_ad_admin_commands_dc_task] ON [ad_admin_commands] ([target_dc], [task_id]);
END;

-- ad_admin_members.ix_admin_members_collected  [[collected_at]]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_admin_members]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'collected_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_admin_members' AND i.name = 'ix_admin_members_collected'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_admin_members_collected] ON [ad_admin_members] ([collected_at]);
END;

-- ad_admin_members.ix_admin_members_group  [[group_name]]  键 128 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_admin_members]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'group_name'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_admin_members' AND i.name = 'ix_admin_members_group'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_admin_members_group] ON [ad_admin_members] ([group_name]);
END;

-- ad_admin_members.ix_admin_members_run  [[run_id]]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_admin_members]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'run_id'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_admin_members' AND i.name = 'ix_admin_members_run'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_admin_members_run] ON [ad_admin_members] ([run_id]);
END;

-- ad_agent_upgrade_rollout.ix_rollout_status_activated  [[status], [activated_at]]  键 40 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_agent_upgrade_rollout]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'status'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'activated_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_agent_upgrade_rollout' AND i.name = 'ix_rollout_status_activated'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_rollout_status_activated] ON [ad_agent_upgrade_rollout] ([status], [activated_at]);
END;

-- ad_computers_snapshot.idx_computers_forest_dc  [[forest_id], [domain_name]]  键 264 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_computers_snapshot]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'forest_id'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'domain_name'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_computers_snapshot' AND i.name = 'idx_computers_forest_dc'
)
BEGIN
  CREATE NONCLUSTERED INDEX [idx_computers_forest_dc] ON [ad_computers_snapshot] ([forest_id], [domain_name]);
END;

-- ad_computers_snapshot.ix_computers_enabled  [[enabled]]  键 1 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_computers_snapshot]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'enabled'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_computers_snapshot' AND i.name = 'ix_computers_enabled'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_computers_enabled] ON [ad_computers_snapshot] ([enabled]);
END;

-- ad_computers_snapshot.ix_computers_is_server  [[is_server]]  键 1 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_computers_snapshot]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'is_server'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_computers_snapshot' AND i.name = 'ix_computers_is_server'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_computers_is_server] ON [ad_computers_snapshot] ([is_server]);
END;

-- ad_computers_snapshot.ix_computers_snapshot_at  [[snapshot_at]]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_computers_snapshot]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'snapshot_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_computers_snapshot' AND i.name = 'ix_computers_snapshot_at'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_computers_snapshot_at] ON [ad_computers_snapshot] ([snapshot_at]);
END;

-- ad_dc_overview.ix_dc_overview_collected  [[collected_at]]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_dc_overview]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'collected_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_dc_overview' AND i.name = 'ix_dc_overview_collected'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_dc_overview_collected] ON [ad_dc_overview] ([collected_at]);
END;

-- ad_dc_overview.ix_dc_overview_site  [[site_id]]  键 4 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_dc_overview]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'site_id'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_dc_overview' AND i.name = 'ix_dc_overview_site'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_dc_overview_site] ON [ad_dc_overview] ([site_id]);
END;

-- ad_directory_sync_runs.ix_sync_runs_started  [[started_at]]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_directory_sync_runs]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'started_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_directory_sync_runs' AND i.name = 'ix_sync_runs_started'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_sync_runs_started] ON [ad_directory_sync_runs] ([started_at]);
END;

-- ad_directory_sync_runs.ix_sync_runs_dc_status  [[dc_name], [status]]  键 288 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_directory_sync_runs]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'dc_name'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'status'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_directory_sync_runs' AND i.name = 'ix_sync_runs_dc_status'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_sync_runs_dc_status] ON [ad_directory_sync_runs] ([dc_name], [status]);
END;

-- ad_directory_sync_runs.idx_runs_forest_started  [[forest_id], [started_at]]  键 16 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_directory_sync_runs]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'forest_id'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'started_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_directory_sync_runs' AND i.name = 'idx_runs_forest_started'
)
BEGIN
  CREATE NONCLUSTERED INDEX [idx_runs_forest_started] ON [ad_directory_sync_runs] ([forest_id], [started_at]);
END;

-- ad_eventlog_events.ix_eventlog_collected  [[collected_at]]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_eventlog_events]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'collected_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_eventlog_events' AND i.name = 'ix_eventlog_collected'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_eventlog_collected] ON [ad_eventlog_events] ([collected_at]);
END;

-- ad_eventlog_events.ix_eventlog_dc_channel  [[dc_name], [channel], [ts]]  键 168 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_eventlog_events]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 3
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'dc_name'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'channel'
         AND MAX(CASE WHEN ic.key_ordinal = 3 THEN c.name END) = 'ts'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_eventlog_events' AND i.name = 'ix_eventlog_dc_channel'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_eventlog_dc_channel] ON [ad_eventlog_events] ([dc_name], [channel], [ts]);
END;

-- ad_eventlog_events.ix_eventlog_severity  [[severity], [ts]]  键 24 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_eventlog_events]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'severity'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'ts'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_eventlog_events' AND i.name = 'ix_eventlog_severity'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_eventlog_severity] ON [ad_eventlog_events] ([severity], [ts]);
END;

-- ad_eventlog_summary.ix_eventlog_summary_collected  [[collected_at]]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_eventlog_summary]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'collected_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_eventlog_summary' AND i.name = 'ix_eventlog_summary_collected'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_eventlog_summary_collected] ON [ad_eventlog_summary] ([collected_at]);
END;

-- ad_eventlog_summary.ix_eventlog_summary_dc  [[dc_name]]  键 128 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_eventlog_summary]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'dc_name'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_eventlog_summary' AND i.name = 'ix_eventlog_summary_dc'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_eventlog_summary_dc] ON [ad_eventlog_summary] ([dc_name]);
END;

-- ad_failed_logon_events.ix_failed_logon_occurred_at  [[occurred_at]]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_failed_logon_events]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'occurred_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_failed_logon_events' AND i.name = 'ix_failed_logon_occurred_at'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_failed_logon_occurred_at] ON [ad_failed_logon_events] ([occurred_at]);
END;

-- ad_failed_logon_events.ix_failed_logon_target_time  [[target_user_name], [occurred_at]]  键 520 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_failed_logon_events]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'target_user_name'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'occurred_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_failed_logon_events' AND i.name = 'ix_failed_logon_target_time'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_failed_logon_target_time] ON [ad_failed_logon_events] ([target_user_name], [occurred_at]);
END;

-- ad_failed_logon_events.ix_failed_logon_dc_time  [[dc_name], [occurred_at]]  键 520 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_failed_logon_events]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'dc_name'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'occurred_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_failed_logon_events' AND i.name = 'ix_failed_logon_dc_time'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_failed_logon_dc_time] ON [ad_failed_logon_events] ([dc_name], [occurred_at]);
END;

-- ad_failed_logon_events.ix_failed_logon_ip_time  [[ip_address], [occurred_at]]  键 136 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_failed_logon_events]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'ip_address'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'occurred_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_failed_logon_events' AND i.name = 'ix_failed_logon_ip_time'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_failed_logon_ip_time] ON [ad_failed_logon_events] ([ip_address], [occurred_at]);
END;

-- ad_forest_dc_assignment.ix_forest_dc_forest  [[forest_id]]  键 4 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_forest_dc_assignment]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'forest_id'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_forest_dc_assignment' AND i.name = 'ix_forest_dc_forest'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_forest_dc_forest] ON [ad_forest_dc_assignment] ([forest_id]);
END;

-- ad_forest_dc_assignment.ix_forest_dc_domain  [[domain_id]]  键 4 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_forest_dc_assignment]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'domain_id'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_forest_dc_assignment' AND i.name = 'ix_forest_dc_domain'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_forest_dc_domain] ON [ad_forest_dc_assignment] ([domain_id]);
END;

-- ad_forest_domain.ix_forest_domain_forest  [[forest_id]]  键 4 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_forest_domain]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'forest_id'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_forest_domain' AND i.name = 'ix_forest_domain_forest'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_forest_domain_forest] ON [ad_forest_domain] ([forest_id]);
END;

-- ad_forest_domain_setting.ix_forest_domain_setting_domain  [[domain_id]]  键 4 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_forest_domain_setting]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'domain_id'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_forest_domain_setting' AND i.name = 'ix_forest_domain_setting_domain'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_forest_domain_setting_domain] ON [ad_forest_domain_setting] ([domain_id]);
END;

-- ad_forest_setting.ix_forest_setting_forest  [[forest_id]]  键 4 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_forest_setting]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'forest_id'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_forest_setting' AND i.name = 'ix_forest_setting_forest'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_forest_setting_forest] ON [ad_forest_setting] ([forest_id]);
END;

-- ad_groups_snapshot.ix_groups_snapshot_at  [[snapshot_at]]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_groups_snapshot]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'snapshot_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_groups_snapshot' AND i.name = 'ix_groups_snapshot_at'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_groups_snapshot_at] ON [ad_groups_snapshot] ([snapshot_at]);
END;

-- ad_groups_snapshot.idx_groups_forest_dc  [[forest_id], [domain_name]]  键 264 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_groups_snapshot]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'forest_id'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'domain_name'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_groups_snapshot' AND i.name = 'idx_groups_forest_dc'
)
BEGIN
  CREATE NONCLUSTERED INDEX [idx_groups_forest_dc] ON [ad_groups_snapshot] ([forest_id], [domain_name]);
END;

-- ad_license_request.ix_license_request_instance  [[instance_id], [created_at] DESC]  键 72 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_license_request]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'instance_id'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'created_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_license_request' AND i.name = 'ix_license_request_instance'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_license_request_instance] ON [ad_license_request] ([instance_id], [created_at] DESC);
END;

-- ad_license_request.ix_license_request_kind  [[kind], [created_at] DESC]  键 24 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_license_request]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'kind'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'created_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_license_request' AND i.name = 'ix_license_request_kind'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_license_request_kind] ON [ad_license_request] ([kind], [created_at] DESC);
END;

-- ad_lockout_events.ix_lockout_target_time  [[target_user_name], [occurred_at]]  键 264 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_lockout_events]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'target_user_name'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'occurred_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_lockout_events' AND i.name = 'ix_lockout_target_time'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_lockout_target_time] ON [ad_lockout_events] ([target_user_name], [occurred_at]);
END;

-- ad_lockout_events.ix_lockout_caller_time  [[caller_computer_name], [occurred_at]]  键 264 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_lockout_events]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'caller_computer_name'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'occurred_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_lockout_events' AND i.name = 'ix_lockout_caller_time'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_lockout_caller_time] ON [ad_lockout_events] ([caller_computer_name], [occurred_at]);
END;

-- ad_lockout_events.ix_lockout_dc_time  [[dc_name], [occurred_at]]  键 136 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_lockout_events]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'dc_name'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'occurred_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_lockout_events' AND i.name = 'ix_lockout_dc_time'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_lockout_dc_time] ON [ad_lockout_events] ([dc_name], [occurred_at]);
END;

-- ad_lockout_events.ix_lockout_occurred  [[occurred_at]]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_lockout_events]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'occurred_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_lockout_events' AND i.name = 'ix_lockout_occurred'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_lockout_occurred] ON [ad_lockout_events] ([occurred_at]);
END;

-- ad_member_admin_groups.idx_member_admin_hostname  [[hostname]]  键 256 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_member_admin_groups]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'hostname'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_member_admin_groups' AND i.name = 'idx_member_admin_hostname'
)
BEGIN
  CREATE NONCLUSTERED INDEX [idx_member_admin_hostname] ON [ad_member_admin_groups] ([hostname]);
END;
