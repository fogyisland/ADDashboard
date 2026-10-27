-- verify: index ad_replication_status.ix_repl_collected
-- verify: index ad_replication_status.ix_repl_dest
-- verify: index ad_server_group_members.ix_sgm_host
-- verify: index ad_user_group_memberships.idx_ugm_user
-- verify: index ad_user_group_memberships.idx_ugm_group
-- verify: index ad_users_snapshot.ix_users_snapshot_at
-- verify: index ad_users_snapshot.ix_users_enabled_locked
-- verify: index ad_users_snapshot.idx_users_forest_dc
-- verify: index ad_users_snapshot.ix_ad_users_snapshot_manager_sam
-- verify: index audit_logs.ix_audit_time
-- verify: index audit_logs.ix_audit_action_time
-- verify: index audit_logs.ix_audit_user_time
-- verify: index daily_reports.idx_dr_kind_generated
-- verify: index daily_reports.idx_dr_period
-- verify: index metric_counter.ix_counter_metric_ts
-- verify: index metric_gauge.ix_gauge_metric_ts
-- verify: index metric_status.ix_status_metric_ts
-- verify: index metric_timeseries.ix_ts_agent_metric_ts
-- verify: index package_policies.ix_package_policies_enabled
-- verify: index package_runs.ix_run_agent_pkg
-- verify: index package_runs.IX_package_runs_status_started_at
-- verify: index package_runs.IX_pr_started_covering
-- verify: index package_scripts.ix_package_scripts_updated_at
-- verify: index package_scripts_history.ix_package_scripts_history_name_pub
-- verify: index report_email_outbox.idx_reo_pending
-- verify: index report_email_outbox.idx_reo_kind
-- verify: index report_fired_history.IX_report_fired_history_last_fired_at
-- verify: index report_subscriptions.idx_rs_kind_enabled
-- verify: index schema_migrations.ix_schema_migrations_status
-- verify: index sys_config_audit.idx_changed_at
-- verify: index sys_config_audit.idx_config_key
-- verify: index sys_config_audit.idx_changed_by
-- verify: index system_alert_outbox.idx_sao_pending
-- verify: index system_alert_suppressions.ix_sas_set_at
-- verify: index system_alerts.ix_sa_kind_state
-- verify: index system_alerts.ix_sa_scope
-- verify: index system_alerts.ix_sa_fired
-- verify: index ad_dcs.ix_ad_dcs_lifecycle
-- verify: index ad_member_servers.ix_ad_member_servers_lifecycle
--
-- R161.18 (2026-10-28) — 补齐缺失的**非唯一**二级索引 (第 3/3 批)
-- 非唯一索引 = 纯性能; 无数据风险。
SET LOCK_TIMEOUT 10000;
SET QUOTED_IDENTIFIER ON;
-- 非唯一索引 = 纯性能, 建索引不会因为数据重复而失败 ⇒ 零数据风险。
-- 本文件是第 3/3 批 (拆文件的原因: init/verify-marker.js
-- 只扫文件前 50 行的 verify 标记, 一批塞不下 40 个以上的标记)。

-- ad_replication_status.ix_repl_collected  [[collected_at]]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_replication_status]')
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
  WHERE t.name = 'ad_replication_status' AND i.name = 'ix_repl_collected'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_repl_collected] ON [ad_replication_status] ([collected_at]);
END;

-- ad_replication_status.ix_repl_dest  [[dest_dc]]  键 256 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_replication_status]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'dest_dc'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_replication_status' AND i.name = 'ix_repl_dest'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_repl_dest] ON [ad_replication_status] ([dest_dc]);
END;

-- ad_server_group_members.ix_sgm_host  [[hostname]]  键 128 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_server_group_members]')
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
  WHERE t.name = 'ad_server_group_members' AND i.name = 'ix_sgm_host'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_sgm_host] ON [ad_server_group_members] ([hostname]);
END;

-- ad_user_group_memberships.idx_ugm_user  [[group_name], [domain_name], [user_sam]]  键 1280 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_user_group_memberships]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 3
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'group_name'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'domain_name'
         AND MAX(CASE WHEN ic.key_ordinal = 3 THEN c.name END) = 'user_sam'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_user_group_memberships' AND i.name = 'idx_ugm_user'
)
BEGIN
  CREATE NONCLUSTERED INDEX [idx_ugm_user] ON [ad_user_group_memberships] ([group_name], [domain_name], [user_sam]);
END;

-- ad_user_group_memberships.idx_ugm_group  [[user_sam], [domain_name]]  键 768 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_user_group_memberships]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'user_sam'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'domain_name'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_user_group_memberships' AND i.name = 'idx_ugm_group'
)
BEGIN
  CREATE NONCLUSTERED INDEX [idx_ugm_group] ON [ad_user_group_memberships] ([user_sam], [domain_name]);
END;

-- ad_users_snapshot.ix_users_snapshot_at  [[snapshot_at]]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_users_snapshot]')
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
  WHERE t.name = 'ad_users_snapshot' AND i.name = 'ix_users_snapshot_at'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_users_snapshot_at] ON [ad_users_snapshot] ([snapshot_at]);
END;

-- ad_users_snapshot.ix_users_enabled_locked  [[enabled], [locked_out]]  键 2 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_users_snapshot]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'enabled'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'locked_out'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_users_snapshot' AND i.name = 'ix_users_enabled_locked'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_users_enabled_locked] ON [ad_users_snapshot] ([enabled], [locked_out]);
END;

-- ad_users_snapshot.idx_users_forest_dc  [[forest_id], [domain_name]]  键 264 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_users_snapshot]')
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
  WHERE t.name = 'ad_users_snapshot' AND i.name = 'idx_users_forest_dc'
)
BEGIN
  CREATE NONCLUSTERED INDEX [idx_users_forest_dc] ON [ad_users_snapshot] ([forest_id], [domain_name]);
END;

-- ad_users_snapshot.ix_ad_users_snapshot_manager_sam  [[manager_sam]]  键 512 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_users_snapshot]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'manager_sam'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_users_snapshot' AND i.name = 'ix_ad_users_snapshot_manager_sam'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_ad_users_snapshot_manager_sam] ON [ad_users_snapshot] ([manager_sam]);
END;

-- audit_logs.ix_audit_time  [[created_at]]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[audit_logs]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'created_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'audit_logs' AND i.name = 'ix_audit_time'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_audit_time] ON [audit_logs] ([created_at]);
END;

-- audit_logs.ix_audit_action_time  [[action], [created_at]]  键 136 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[audit_logs]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'action'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'created_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'audit_logs' AND i.name = 'ix_audit_action_time'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_audit_action_time] ON [audit_logs] ([action], [created_at]);
END;

-- audit_logs.ix_audit_user_time  [[user_id], [created_at]]  键 12 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[audit_logs]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'user_id'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'created_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'audit_logs' AND i.name = 'ix_audit_user_time'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_audit_user_time] ON [audit_logs] ([user_id], [created_at]);
END;

-- daily_reports.idx_dr_kind_generated  [[status], [subject], [kind], [generated_at] DESC]  键 296 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[daily_reports]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 4
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'status'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'subject'
         AND MAX(CASE WHEN ic.key_ordinal = 3 THEN c.name END) = 'kind'
         AND MAX(CASE WHEN ic.key_ordinal = 4 THEN c.name END) = 'generated_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'daily_reports' AND i.name = 'idx_dr_kind_generated'
)
BEGIN
  CREATE NONCLUSTERED INDEX [idx_dr_kind_generated] ON [daily_reports] ([status], [subject], [kind], [generated_at] DESC);
END;

-- daily_reports.idx_dr_period  [[kind], [status], [period_end] DESC]  键 40 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[daily_reports]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 3
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'kind'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'status'
         AND MAX(CASE WHEN ic.key_ordinal = 3 THEN c.name END) = 'period_end'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'daily_reports' AND i.name = 'idx_dr_period'
)
BEGIN
  CREATE NONCLUSTERED INDEX [idx_dr_period] ON [daily_reports] ([kind], [status], [period_end] DESC);
END;

-- metric_counter.ix_counter_metric_ts  [[metric_id], [ts] DESC]  键 392 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[metric_counter]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'metric_id'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'ts'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'metric_counter' AND i.name = 'ix_counter_metric_ts'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_counter_metric_ts] ON [metric_counter] ([metric_id], [ts] DESC);
END;

-- metric_gauge.ix_gauge_metric_ts  [[metric_id], [ts] DESC]  键 392 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[metric_gauge]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'metric_id'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'ts'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'metric_gauge' AND i.name = 'ix_gauge_metric_ts'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_gauge_metric_ts] ON [metric_gauge] ([metric_id], [ts] DESC);
END;

-- metric_status.ix_status_metric_ts  [[metric_id], [ts] DESC]  键 392 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[metric_status]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'metric_id'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'ts'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'metric_status' AND i.name = 'ix_status_metric_ts'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_status_metric_ts] ON [metric_status] ([metric_id], [ts] DESC);
END;

-- metric_timeseries.ix_ts_agent_metric_ts  [[agent_id], [metric_id], [ts] DESC]  键 520 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[metric_timeseries]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 3
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'agent_id'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'metric_id'
         AND MAX(CASE WHEN ic.key_ordinal = 3 THEN c.name END) = 'ts'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'metric_timeseries' AND i.name = 'ix_ts_agent_metric_ts'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_ts_agent_metric_ts] ON [metric_timeseries] ([agent_id], [metric_id], [ts] DESC);
END;

-- package_policies.ix_package_policies_enabled  [[enabled]]  键 1 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[package_policies]')
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
  WHERE t.name = 'package_policies' AND i.name = 'ix_package_policies_enabled'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_package_policies_enabled] ON [package_policies] ([enabled]);
END;

-- package_runs.ix_run_agent_pkg  [[agent_id], [package_name], [started_at] DESC]  键 392 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[package_runs]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 3
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'agent_id'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'package_name'
         AND MAX(CASE WHEN ic.key_ordinal = 3 THEN c.name END) = 'started_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'package_runs' AND i.name = 'ix_run_agent_pkg'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_run_agent_pkg] ON [package_runs] ([agent_id], [package_name], [started_at] DESC);
END;

-- package_runs.IX_package_runs_status_started_at  [[status], [started_at] DESC]  键 72 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[package_runs]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NOT NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'status'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'started_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'package_runs' AND i.name = 'IX_package_runs_status_started_at'
)
BEGIN
  CREATE NONCLUSTERED INDEX [IX_package_runs_status_started_at] ON [package_runs] ([status], [started_at] DESC) WHERE ([status]='pending_trigger');
END;

-- package_runs.IX_pr_started_covering  [[package_name], [exit_code], [status], [agent_id], [started_at]]  键 460 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[package_runs]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 5
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'package_name'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'exit_code'
         AND MAX(CASE WHEN ic.key_ordinal = 3 THEN c.name END) = 'status'
         AND MAX(CASE WHEN ic.key_ordinal = 4 THEN c.name END) = 'agent_id'
         AND MAX(CASE WHEN ic.key_ordinal = 5 THEN c.name END) = 'started_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'package_runs' AND i.name = 'IX_pr_started_covering'
)
BEGIN
  CREATE NONCLUSTERED INDEX [IX_pr_started_covering] ON [package_runs] ([package_name], [exit_code], [status], [agent_id], [started_at]);
END;

-- package_scripts.ix_package_scripts_updated_at  [[updated_at]]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[package_scripts]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'updated_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'package_scripts' AND i.name = 'ix_package_scripts_updated_at'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_package_scripts_updated_at] ON [package_scripts] ([updated_at]);
END;

-- package_scripts_history.ix_package_scripts_history_name_pub  [[name], [published_at] DESC]  键 264 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[package_scripts_history]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'name'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'published_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'package_scripts_history' AND i.name = 'ix_package_scripts_history_name_pub'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_package_scripts_history_name_pub] ON [package_scripts_history] ([name], [published_at] DESC);
END;

-- report_email_outbox.idx_reo_pending  [[next_attempt_at]]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[report_email_outbox]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NOT NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'next_attempt_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'report_email_outbox' AND i.name = 'idx_reo_pending'
)
BEGIN
  CREATE NONCLUSTERED INDEX [idx_reo_pending] ON [report_email_outbox] ([next_attempt_at]) WHERE ([sent_at] IS NULL);
END;

-- report_email_outbox.idx_reo_kind  [[kind], [created_at] DESC]  键 28 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[report_email_outbox]')
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
  WHERE t.name = 'report_email_outbox' AND i.name = 'idx_reo_kind'
)
BEGIN
  CREATE NONCLUSTERED INDEX [idx_reo_kind] ON [report_email_outbox] ([kind], [created_at] DESC);
END;

-- report_fired_history.IX_report_fired_history_last_fired_at  [[last_fired_at] DESC]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[report_fired_history]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'last_fired_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'report_fired_history' AND i.name = 'IX_report_fired_history_last_fired_at'
)
BEGIN
  CREATE NONCLUSTERED INDEX [IX_report_fired_history_last_fired_at] ON [report_fired_history] ([last_fired_at] DESC);
END;

-- report_subscriptions.idx_rs_kind_enabled  [[kind], [enabled]]  键 17 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[report_subscriptions]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'kind'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'enabled'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'report_subscriptions' AND i.name = 'idx_rs_kind_enabled'
)
BEGIN
  CREATE NONCLUSTERED INDEX [idx_rs_kind_enabled] ON [report_subscriptions] ([kind], [enabled]);
END;

-- schema_migrations.ix_schema_migrations_status  [[status]]  键 16 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[schema_migrations]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'status'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'schema_migrations' AND i.name = 'ix_schema_migrations_status'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_schema_migrations_status] ON [schema_migrations] ([status]);
END;

-- sys_config_audit.idx_changed_at  [[changed_at] DESC]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[sys_config_audit]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'changed_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'sys_config_audit' AND i.name = 'idx_changed_at'
)
BEGIN
  CREATE NONCLUSTERED INDEX [idx_changed_at] ON [sys_config_audit] ([changed_at] DESC);
END;

-- sys_config_audit.idx_config_key  [[config_key]]  键 128 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[sys_config_audit]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'config_key'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'sys_config_audit' AND i.name = 'idx_config_key'
)
BEGIN
  CREATE NONCLUSTERED INDEX [idx_config_key] ON [sys_config_audit] ([config_key]);
END;

-- sys_config_audit.idx_changed_by  [[changed_by]]  键 4 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[sys_config_audit]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'changed_by'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'sys_config_audit' AND i.name = 'idx_changed_by'
)
BEGIN
  CREATE NONCLUSTERED INDEX [idx_changed_by] ON [sys_config_audit] ([changed_by]);
END;

-- system_alert_outbox.idx_sao_pending  [[next_attempt_at]]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[system_alert_outbox]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NOT NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'next_attempt_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'system_alert_outbox' AND i.name = 'idx_sao_pending'
)
BEGIN
  CREATE NONCLUSTERED INDEX [idx_sao_pending] ON [system_alert_outbox] ([next_attempt_at]) WHERE ([sent_at] IS NULL);
END;

-- system_alert_suppressions.ix_sas_set_at  [[set_at] DESC]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[system_alert_suppressions]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'set_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'system_alert_suppressions' AND i.name = 'ix_sas_set_at'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_sas_set_at] ON [system_alert_suppressions] ([set_at] DESC);
END;

-- system_alerts.ix_sa_kind_state  [[kind], [state], [fired_at] DESC]  键 68 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[system_alerts]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 3
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'kind'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'state'
         AND MAX(CASE WHEN ic.key_ordinal = 3 THEN c.name END) = 'fired_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'system_alerts' AND i.name = 'ix_sa_kind_state'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_sa_kind_state] ON [system_alerts] ([kind], [state], [fired_at] DESC);
END;

-- system_alerts.ix_sa_scope  [[scope_type], [scope_ref], [kind]]  键 570 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[system_alerts]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NOT NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 3
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'scope_type'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'scope_ref'
         AND MAX(CASE WHEN ic.key_ordinal = 3 THEN c.name END) = 'kind'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'system_alerts' AND i.name = 'ix_sa_scope'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_sa_scope] ON [system_alerts] ([scope_type], [scope_ref], [kind]) WHERE ([state]='firing');
END;

-- system_alerts.ix_sa_fired  [[fired_at] DESC]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[system_alerts]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'fired_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'system_alerts' AND i.name = 'ix_sa_fired'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_sa_fired] ON [system_alerts] ([fired_at] DESC);
END;

-- ad_dcs.ix_ad_dcs_lifecycle  [[decommissioned_at], [monitoring_paused_at]]  键 16 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_dcs]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'decommissioned_at'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'monitoring_paused_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_dcs' AND i.name = 'ix_ad_dcs_lifecycle'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_ad_dcs_lifecycle] ON [ad_dcs] ([decommissioned_at], [monitoring_paused_at]);
END;

-- ad_member_servers.ix_ad_member_servers_lifecycle  [[decommissioned_at], [monitoring_paused_at]]  键 16 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_member_servers]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'decommissioned_at'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'monitoring_paused_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_member_servers' AND i.name = 'ix_ad_member_servers_lifecycle'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_ad_member_servers_lifecycle] ON [ad_member_servers] ([decommissioned_at], [monitoring_paused_at]);
END;
