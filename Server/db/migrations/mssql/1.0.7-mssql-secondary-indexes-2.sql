-- verify: index ad_member_admin_groups.idx_member_admin_collected_at
-- verify: index ad_member_commands.ix_member_commands_host_status
-- verify: index ad_member_commands.ix_member_commands_status_created
-- verify: index ad_member_commands.ix_member_commands_operator
-- verify: index ad_member_eventlog_events.ix_ad_member_eventlog_events_host_channel_ts
-- verify: index ad_member_eventlog_events.ix_ad_member_eventlog_events_collected_at
-- verify: index ad_member_eventlog_summary.ix_ad_member_eventlog_summary_collected_at
-- verify: index ad_member_eventlog_summary.ix_ad_member_eventlog_summary_host_collected
-- verify: index ad_member_heartbeat.ix_ad_member_heartbeat_last_hb
-- verify: index ad_member_os_baseline.ix_ad_member_os_baseline_host_collected
-- verify: index ad_member_os_baseline.ix_ad_member_os_baseline_collected_at
-- verify: index ad_member_os_baseline_latest.ix_ad_member_os_baseline_latest_collected_at
-- verify: index ad_member_server_packages.ix_msp_pkg
-- verify: index ad_member_servers.ix_member_servers_site
-- verify: index ad_notify_outbox.idx_ad_notify_outbox_pending
-- verify: index ad_notify_outbox.idx_ad_notify_outbox_created
-- verify: index ad_ous_snapshot.ix_ous_snapshot_at
-- verify: index ad_ous_snapshot.idx_ous_forest_dc
-- verify: index ad_dc_inbound_partners.ix_inbound_partner_local_dc
-- verify: index ad_dc_inbound_partners.ix_inbound_partner_peer_dc
-- verify: index ad_dc_inbound_partners.ix_inbound_partner_naming_context
-- verify: index ad_dc_inbound_partners.ix_inbound_partner_refreshed_at
-- verify: index ad_dc_outbound_partners.ix_outbound_partner_local_dc
-- verify: index ad_dc_outbound_partners.ix_outbound_partner_peer_dc
-- verify: index ad_dc_outbound_partners.ix_outbound_partner_naming_context
-- verify: index ad_dc_outbound_partners.ix_outbound_partner_refreshed_at
-- verify: index ad_partner_inbound.ix_partner_inbound_collected_at
-- verify: index ad_partner_inbound.ix_partner_inbound_dest_dc
-- verify: index ad_partner_inbound.ix_partner_inbound_agent_id
-- verify: index ad_remote_port_probe.ix_remote_probe_dc
-- verify: index ad_remote_port_probe.ix_remote_probe_at
-- verify: index ad_remote_port_probe.ix_remote_probe_ok
-- verify: index ad_replication_active_errors.ix_active_error_attempt
-- verify: index ad_replication_active_errors.ix_active_error_pair
-- verify: index ad_replication_history.ix_hist_time
-- verify: index ad_replication_history.ix_hist_pair_time
-- verify: index ad_replication_probe_history.ix_probe_pair_time
-- verify: index ad_replication_probe_history.ix_probe_attempt_at
-- verify: index ad_replication_probe_history.ix_probe_collected_at
-- verify: index ad_replication_probe_history.ix_probe_agent
--
-- R161.18 (2026-10-28) — 补齐缺失的**非唯一**二级索引 (第 2/3 批)
-- 非唯一索引 = 纯性能; 无数据风险。
SET LOCK_TIMEOUT 10000;
SET QUOTED_IDENTIFIER ON;
-- 非唯一索引 = 纯性能, 建索引不会因为数据重复而失败 ⇒ 零数据风险。
-- 本文件是第 2/3 批 (拆文件的原因: init/verify-marker.js
-- 只扫文件前 50 行的 verify 标记, 一批塞不下 40 个以上的标记)。

-- ad_member_admin_groups.idx_member_admin_collected_at  [[collected_at]]  键 8 字节
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
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'collected_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_member_admin_groups' AND i.name = 'idx_member_admin_collected_at'
)
BEGIN
  CREATE NONCLUSTERED INDEX [idx_member_admin_collected_at] ON [ad_member_admin_groups] ([collected_at]);
END;

-- ad_member_commands.ix_member_commands_host_status  [[hostname], [status]]  键 288 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_member_commands]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'hostname'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'status'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_member_commands' AND i.name = 'ix_member_commands_host_status'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_member_commands_host_status] ON [ad_member_commands] ([hostname], [status]);
END;

-- ad_member_commands.ix_member_commands_status_created  [[status], [created_at]]  键 40 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_member_commands]')
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
  WHERE t.name = 'ad_member_commands' AND i.name = 'ix_member_commands_status_created'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_member_commands_status_created] ON [ad_member_commands] ([status], [created_at]);
END;

-- ad_member_commands.ix_member_commands_operator  [[operator_id], [created_at]]  键 16 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_member_commands]')
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
  WHERE t.name = 'ad_member_commands' AND i.name = 'ix_member_commands_operator'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_member_commands_operator] ON [ad_member_commands] ([operator_id], [created_at]);
END;

-- ad_member_eventlog_events.ix_ad_member_eventlog_events_host_channel_ts  [[hostname], [channel], [ts] DESC]  键 168 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_member_eventlog_events]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 3
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'hostname'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'channel'
         AND MAX(CASE WHEN ic.key_ordinal = 3 THEN c.name END) = 'ts'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_member_eventlog_events' AND i.name = 'ix_ad_member_eventlog_events_host_channel_ts'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_ad_member_eventlog_events_host_channel_ts] ON [ad_member_eventlog_events] ([hostname], [channel], [ts] DESC);
END;

-- ad_member_eventlog_events.ix_ad_member_eventlog_events_collected_at  [[collected_at]]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_member_eventlog_events]')
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
  WHERE t.name = 'ad_member_eventlog_events' AND i.name = 'ix_ad_member_eventlog_events_collected_at'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_ad_member_eventlog_events_collected_at] ON [ad_member_eventlog_events] ([collected_at]);
END;

-- ad_member_eventlog_summary.ix_ad_member_eventlog_summary_collected_at  [[collected_at]]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_member_eventlog_summary]')
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
  WHERE t.name = 'ad_member_eventlog_summary' AND i.name = 'ix_ad_member_eventlog_summary_collected_at'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_ad_member_eventlog_summary_collected_at] ON [ad_member_eventlog_summary] ([collected_at]);
END;

-- ad_member_eventlog_summary.ix_ad_member_eventlog_summary_host_collected  [[hostname], [collected_at] DESC]  键 136 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_member_eventlog_summary]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'hostname'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'collected_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_member_eventlog_summary' AND i.name = 'ix_ad_member_eventlog_summary_host_collected'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_ad_member_eventlog_summary_host_collected] ON [ad_member_eventlog_summary] ([hostname], [collected_at] DESC);
END;

-- ad_member_heartbeat.ix_ad_member_heartbeat_last_hb  [[last_heartbeat_at]]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_member_heartbeat]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'last_heartbeat_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_member_heartbeat' AND i.name = 'ix_ad_member_heartbeat_last_hb'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_ad_member_heartbeat_last_hb] ON [ad_member_heartbeat] ([last_heartbeat_at]);
END;

-- ad_member_os_baseline.ix_ad_member_os_baseline_host_collected  [[hostname], [collected_at] DESC]  键 136 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_member_os_baseline]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'hostname'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'collected_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_member_os_baseline' AND i.name = 'ix_ad_member_os_baseline_host_collected'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_ad_member_os_baseline_host_collected] ON [ad_member_os_baseline] ([hostname], [collected_at] DESC);
END;

-- ad_member_os_baseline.ix_ad_member_os_baseline_collected_at  [[collected_at]]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_member_os_baseline]')
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
  WHERE t.name = 'ad_member_os_baseline' AND i.name = 'ix_ad_member_os_baseline_collected_at'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_ad_member_os_baseline_collected_at] ON [ad_member_os_baseline] ([collected_at]);
END;

-- ad_member_os_baseline_latest.ix_ad_member_os_baseline_latest_collected_at  [[collected_at]]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_member_os_baseline_latest]')
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
  WHERE t.name = 'ad_member_os_baseline_latest' AND i.name = 'ix_ad_member_os_baseline_latest_collected_at'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_ad_member_os_baseline_latest_collected_at] ON [ad_member_os_baseline_latest] ([collected_at]);
END;

-- ad_member_server_packages.ix_msp_pkg  [[package_name]]  键 256 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_member_server_packages]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'package_name'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_member_server_packages' AND i.name = 'ix_msp_pkg'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_msp_pkg] ON [ad_member_server_packages] ([package_name]);
END;

-- ad_member_servers.ix_member_servers_site  [[site_id]]  键 4 字节
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
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'site_id'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_member_servers' AND i.name = 'ix_member_servers_site'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_member_servers_site] ON [ad_member_servers] ([site_id]);
END;

-- ad_notify_outbox.idx_ad_notify_outbox_pending  [[next_attempt_at], [id]]  键 12 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_notify_outbox]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NOT NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'next_attempt_at'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'id'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_notify_outbox' AND i.name = 'idx_ad_notify_outbox_pending'
)
BEGIN
  CREATE NONCLUSTERED INDEX [idx_ad_notify_outbox_pending] ON [ad_notify_outbox] ([next_attempt_at], [id]) WHERE ([sent_at] IS NULL);
END;

-- ad_notify_outbox.idx_ad_notify_outbox_created  [[created_at]]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_notify_outbox]')
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
  WHERE t.name = 'ad_notify_outbox' AND i.name = 'idx_ad_notify_outbox_created'
)
BEGIN
  CREATE NONCLUSTERED INDEX [idx_ad_notify_outbox_created] ON [ad_notify_outbox] ([created_at]);
END;

-- ad_ous_snapshot.ix_ous_snapshot_at  [[snapshot_at]]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_ous_snapshot]')
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
  WHERE t.name = 'ad_ous_snapshot' AND i.name = 'ix_ous_snapshot_at'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_ous_snapshot_at] ON [ad_ous_snapshot] ([snapshot_at]);
END;

-- ad_ous_snapshot.idx_ous_forest_dc  [[forest_id], [domain_name]]  键 264 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_ous_snapshot]')
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
  WHERE t.name = 'ad_ous_snapshot' AND i.name = 'idx_ous_forest_dc'
)
BEGIN
  CREATE NONCLUSTERED INDEX [idx_ous_forest_dc] ON [ad_ous_snapshot] ([forest_id], [domain_name]);
END;

-- ad_dc_inbound_partners.ix_inbound_partner_local_dc  [[local_dc]]  键 256 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_dc_inbound_partners]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'local_dc'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_dc_inbound_partners' AND i.name = 'ix_inbound_partner_local_dc'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_inbound_partner_local_dc] ON [ad_dc_inbound_partners] ([local_dc]);
END;

-- ad_dc_inbound_partners.ix_inbound_partner_peer_dc  [[peer_dc]]  键 256 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_dc_inbound_partners]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'peer_dc'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_dc_inbound_partners' AND i.name = 'ix_inbound_partner_peer_dc'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_inbound_partner_peer_dc] ON [ad_dc_inbound_partners] ([peer_dc]);
END;

-- ad_dc_inbound_partners.ix_inbound_partner_naming_context  [[naming_context]]  键 256 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_dc_inbound_partners]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'naming_context'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_dc_inbound_partners' AND i.name = 'ix_inbound_partner_naming_context'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_inbound_partner_naming_context] ON [ad_dc_inbound_partners] ([naming_context]);
END;

-- ad_dc_inbound_partners.ix_inbound_partner_refreshed_at  [[refreshed_at]]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_dc_inbound_partners]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'refreshed_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_dc_inbound_partners' AND i.name = 'ix_inbound_partner_refreshed_at'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_inbound_partner_refreshed_at] ON [ad_dc_inbound_partners] ([refreshed_at]);
END;

-- ad_dc_outbound_partners.ix_outbound_partner_local_dc  [[local_dc]]  键 256 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_dc_outbound_partners]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'local_dc'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_dc_outbound_partners' AND i.name = 'ix_outbound_partner_local_dc'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_outbound_partner_local_dc] ON [ad_dc_outbound_partners] ([local_dc]);
END;

-- ad_dc_outbound_partners.ix_outbound_partner_peer_dc  [[peer_dc]]  键 256 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_dc_outbound_partners]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'peer_dc'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_dc_outbound_partners' AND i.name = 'ix_outbound_partner_peer_dc'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_outbound_partner_peer_dc] ON [ad_dc_outbound_partners] ([peer_dc]);
END;

-- ad_dc_outbound_partners.ix_outbound_partner_naming_context  [[naming_context]]  键 256 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_dc_outbound_partners]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'naming_context'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_dc_outbound_partners' AND i.name = 'ix_outbound_partner_naming_context'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_outbound_partner_naming_context] ON [ad_dc_outbound_partners] ([naming_context]);
END;

-- ad_dc_outbound_partners.ix_outbound_partner_refreshed_at  [[refreshed_at]]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_dc_outbound_partners]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'refreshed_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_dc_outbound_partners' AND i.name = 'ix_outbound_partner_refreshed_at'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_outbound_partner_refreshed_at] ON [ad_dc_outbound_partners] ([refreshed_at]);
END;

-- ad_partner_inbound.ix_partner_inbound_collected_at  [[collected_at]]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_partner_inbound]')
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
  WHERE t.name = 'ad_partner_inbound' AND i.name = 'ix_partner_inbound_collected_at'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_partner_inbound_collected_at] ON [ad_partner_inbound] ([collected_at]);
END;

-- ad_partner_inbound.ix_partner_inbound_dest_dc  [[dest_dc]]  键 256 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_partner_inbound]')
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
  WHERE t.name = 'ad_partner_inbound' AND i.name = 'ix_partner_inbound_dest_dc'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_partner_inbound_dest_dc] ON [ad_partner_inbound] ([dest_dc]);
END;

-- ad_partner_inbound.ix_partner_inbound_agent_id  [[agent_id]]  键 128 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_partner_inbound]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'agent_id'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_partner_inbound' AND i.name = 'ix_partner_inbound_agent_id'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_partner_inbound_agent_id] ON [ad_partner_inbound] ([agent_id]);
END;

-- ad_remote_port_probe.ix_remote_probe_dc  [[dc_name]]  键 256 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_remote_port_probe]')
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
  WHERE t.name = 'ad_remote_port_probe' AND i.name = 'ix_remote_probe_dc'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_remote_probe_dc] ON [ad_remote_port_probe] ([dc_name]);
END;

-- ad_remote_port_probe.ix_remote_probe_at  [[probe_at]]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_remote_port_probe]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'probe_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_remote_port_probe' AND i.name = 'ix_remote_probe_at'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_remote_probe_at] ON [ad_remote_port_probe] ([probe_at]);
END;

-- ad_remote_port_probe.ix_remote_probe_ok  [[ok]]  键 1 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_remote_port_probe]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'ok'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_remote_port_probe' AND i.name = 'ix_remote_probe_ok'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_remote_probe_ok] ON [ad_remote_port_probe] ([ok]);
END;

-- ad_replication_active_errors.ix_active_error_attempt  [[last_attempt_time] DESC]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_replication_active_errors]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'last_attempt_time'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_replication_active_errors' AND i.name = 'ix_active_error_attempt'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_active_error_attempt] ON [ad_replication_active_errors] ([last_attempt_time] DESC);
END;

-- ad_replication_active_errors.ix_active_error_pair  [[source_dc], [dest_dc], [naming_context]]  键 384 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_replication_active_errors]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 3
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'source_dc'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'dest_dc'
         AND MAX(CASE WHEN ic.key_ordinal = 3 THEN c.name END) = 'naming_context'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_replication_active_errors' AND i.name = 'ix_active_error_pair'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_active_error_pair] ON [ad_replication_active_errors] ([source_dc], [dest_dc], [naming_context]);
END;

-- ad_replication_history.ix_hist_time  [[collected_at]]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_replication_history]')
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
  WHERE t.name = 'ad_replication_history' AND i.name = 'ix_hist_time'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_hist_time] ON [ad_replication_history] ([collected_at]);
END;

-- ad_replication_history.ix_hist_pair_time  [[source_dc], [dest_dc], [naming_context], [collected_at]]  键 1032 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_replication_history]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 4
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'source_dc'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'dest_dc'
         AND MAX(CASE WHEN ic.key_ordinal = 3 THEN c.name END) = 'naming_context'
         AND MAX(CASE WHEN ic.key_ordinal = 4 THEN c.name END) = 'collected_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_replication_history' AND i.name = 'ix_hist_pair_time'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_hist_pair_time] ON [ad_replication_history] ([source_dc], [dest_dc], [naming_context], [collected_at]);
END;

-- ad_replication_probe_history.ix_probe_pair_time  [[source_dc], [dest_dc], [naming_context], [attempt_at]]  键 1032 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_replication_probe_history]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 4
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'source_dc'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'dest_dc'
         AND MAX(CASE WHEN ic.key_ordinal = 3 THEN c.name END) = 'naming_context'
         AND MAX(CASE WHEN ic.key_ordinal = 4 THEN c.name END) = 'attempt_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_replication_probe_history' AND i.name = 'ix_probe_pair_time'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_probe_pair_time] ON [ad_replication_probe_history] ([source_dc], [dest_dc], [naming_context], [attempt_at]);
END;

-- ad_replication_probe_history.ix_probe_attempt_at  [[attempt_at]]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_replication_probe_history]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'attempt_at'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_replication_probe_history' AND i.name = 'ix_probe_attempt_at'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_probe_attempt_at] ON [ad_replication_probe_history] ([attempt_at]);
END;

-- ad_replication_probe_history.ix_probe_collected_at  [[collected_at]]  键 8 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_replication_probe_history]')
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
  WHERE t.name = 'ad_replication_probe_history' AND i.name = 'ix_probe_collected_at'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_probe_collected_at] ON [ad_replication_probe_history] ([collected_at]);
END;

-- ad_replication_probe_history.ix_probe_agent  [[agent_id]]  键 128 字节
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_replication_probe_history]')
    AND i.type IN (1, 2)
    AND i.is_unique = 0
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'agent_id'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_replication_probe_history' AND i.name = 'ix_probe_agent'
)
BEGIN
  CREATE NONCLUSTERED INDEX [ix_probe_agent] ON [ad_replication_probe_history] ([agent_id]);
END;
