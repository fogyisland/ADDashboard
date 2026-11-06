-- verify: index ad_admin_commands.ux_ad_admin_commands_task_id
-- verify: index ad_admin_members.uq_admin_member
-- verify: index ad_failed_logon_events.uq_failed_logon_dc_record
-- verify: index ad_ous_snapshot.uq_ous_dn
-- verify: index ad_dc_inbound_partners.uq_inbound_partner
-- verify: index ad_dc_outbound_partners.uq_outbound_partner
-- verify: index ad_user_group_memberships.uq_ugm
-- verify: index system_alert_suppressions.uq_sas_kind_scope
--
-- R161.18 (2026-10-28) — 补齐缺失的**唯一**二级索引 (建之前逐个查重)
-- 唯一索引 = 业务去重键; 有重复行则 RAISERROR, 不自动删数据。
SET LOCK_TIMEOUT 10000;
SET QUOTED_IDENTIFIER ON;
-- ★ 唯一索引是**业务语义**: 这几张表的去重键 (upsert 的匹配条件)。
--   生产形状的库里它们要么不存在, 要么是由 SSMS 自动命名的唯一约束
--   —— 形状等价, 所以本文件按**形状**判重, 不会重复建。
--   建之前逐个查重: 有重复行就直接 RAISERROR, 绝不自动删数据。
--
-- ★ 本文件是**全有或全无**的: applyMigration 把整个文件包进一个事务,
--   任何一个唯一索引查重不过 (RAISERROR) ⇒ 整个文件回滚 ⇒ 8 个唯一索引一个都建不上。
--   报错文本里带着定位用的诊断 SQL —— 按它查重、人工去重, 再重跑本迁移即可。
-- ★ 顺序依赖: uq_admin_member, uq_ous_dn, uq_ugm 的键列是 1.0.4 建出来的
--   hash 计算列 ⇒ 本文件必须排在 1.0.4 之后执行 (版本号字典序已保证)。

-- ad_admin_commands.ux_ad_admin_commands_task_id  [[task_id]]  键 128 字节
IF EXISTS (
  SELECT 1 FROM [ad_admin_commands] WHERE ([task_id] IS NOT NULL)
  GROUP BY [task_id]
  HAVING COUNT(*) > 1
)
BEGIN
  RAISERROR('R161.18: ad_admin_commands 上存在重复的 (task_id), 无法创建唯一索引 ux_ad_admin_commands_task_id。请先人工去重 (保留最新的一行), 再重跑本迁移。诊断: SELECT [task_id], COUNT(*) FROM ad_admin_commands WHERE ([task_id] IS NOT NULL) GROUP BY [task_id] HAVING COUNT(*)>1;', 16, 1);
  RETURN;
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_admin_commands]')
    AND i.type IN (1, 2)
    AND i.is_unique = 1
    AND i.filter_definition IS NOT NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 1
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'task_id'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_admin_commands' AND i.name = 'ux_ad_admin_commands_task_id'
)
BEGIN
  CREATE UNIQUE NONCLUSTERED INDEX [ux_ad_admin_commands_task_id] ON [ad_admin_commands] ([task_id]) WHERE ([task_id] IS NOT NULL);
END;

-- ad_admin_members.uq_admin_member  [[domain_dn_hash], [group_name], [member_sam]]  键 672 字节
IF EXISTS (
  SELECT 1 FROM [ad_admin_members]
  GROUP BY [domain_dn_hash], [group_name], [member_sam]
  HAVING COUNT(*) > 1
)
BEGIN
  RAISERROR('R161.18: ad_admin_members 上存在重复的 (domain_dn_hash, group_name, member_sam), 无法创建唯一索引 uq_admin_member。请先人工去重 (保留最新的一行), 再重跑本迁移。诊断: SELECT [domain_dn_hash], [group_name], [member_sam], COUNT(*) FROM ad_admin_members GROUP BY [domain_dn_hash], [group_name], [member_sam] HAVING COUNT(*)>1;', 16, 1);
  RETURN;
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_admin_members]')
    AND i.type IN (1, 2)
    AND i.is_unique = 1
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 3
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'domain_dn_hash'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'group_name'
         AND MAX(CASE WHEN ic.key_ordinal = 3 THEN c.name END) = 'member_sam'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_admin_members' AND i.name = 'uq_admin_member'
)
BEGIN
  CREATE UNIQUE NONCLUSTERED INDEX [uq_admin_member] ON [ad_admin_members] ([domain_dn_hash], [group_name], [member_sam]);
END;

-- ad_failed_logon_events.uq_failed_logon_dc_record  [[dc_name], [event_record_id]]  键 520 字节
IF EXISTS (
  SELECT 1 FROM [ad_failed_logon_events]
  GROUP BY [dc_name], [event_record_id]
  HAVING COUNT(*) > 1
)
BEGIN
  RAISERROR('R161.18: ad_failed_logon_events 上存在重复的 (dc_name, event_record_id), 无法创建唯一索引 uq_failed_logon_dc_record。请先人工去重 (保留最新的一行), 再重跑本迁移。诊断: SELECT [dc_name], [event_record_id], COUNT(*) FROM ad_failed_logon_events GROUP BY [dc_name], [event_record_id] HAVING COUNT(*)>1;', 16, 1);
  RETURN;
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_failed_logon_events]')
    AND i.type IN (1, 2)
    AND i.is_unique = 1
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'dc_name'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'event_record_id'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_failed_logon_events' AND i.name = 'uq_failed_logon_dc_record'
)
BEGIN
  CREATE UNIQUE NONCLUSTERED INDEX [uq_failed_logon_dc_record] ON [ad_failed_logon_events] ([dc_name], [event_record_id]);
END;

-- ad_ous_snapshot.uq_ous_dn  [[domain_name], [distinguished_name_hash]]  键 288 字节
IF EXISTS (
  SELECT 1 FROM [ad_ous_snapshot]
  GROUP BY [domain_name], [distinguished_name_hash]
  HAVING COUNT(*) > 1
)
BEGIN
  RAISERROR('R161.18: ad_ous_snapshot 上存在重复的 (domain_name, distinguished_name_hash), 无法创建唯一索引 uq_ous_dn。请先人工去重 (保留最新的一行), 再重跑本迁移。诊断: SELECT [domain_name], [distinguished_name_hash], COUNT(*) FROM ad_ous_snapshot GROUP BY [domain_name], [distinguished_name_hash] HAVING COUNT(*)>1;', 16, 1);
  RETURN;
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_ous_snapshot]')
    AND i.type IN (1, 2)
    AND i.is_unique = 1
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'domain_name'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'distinguished_name_hash'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_ous_snapshot' AND i.name = 'uq_ous_dn'
)
BEGIN
  CREATE UNIQUE NONCLUSTERED INDEX [uq_ous_dn] ON [ad_ous_snapshot] ([domain_name], [distinguished_name_hash]);
END;

-- ad_dc_inbound_partners.uq_inbound_partner  [[local_dc], [peer_dc], [naming_context]]  键 768 字节
IF EXISTS (
  SELECT 1 FROM [ad_dc_inbound_partners]
  GROUP BY [local_dc], [peer_dc], [naming_context]
  HAVING COUNT(*) > 1
)
BEGIN
  RAISERROR('R161.18: ad_dc_inbound_partners 上存在重复的 (local_dc, peer_dc, naming_context), 无法创建唯一索引 uq_inbound_partner。请先人工去重 (保留最新的一行), 再重跑本迁移。诊断: SELECT [local_dc], [peer_dc], [naming_context], COUNT(*) FROM ad_dc_inbound_partners GROUP BY [local_dc], [peer_dc], [naming_context] HAVING COUNT(*)>1;', 16, 1);
  RETURN;
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_dc_inbound_partners]')
    AND i.type IN (1, 2)
    AND i.is_unique = 1
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 3
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'local_dc'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'peer_dc'
         AND MAX(CASE WHEN ic.key_ordinal = 3 THEN c.name END) = 'naming_context'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_dc_inbound_partners' AND i.name = 'uq_inbound_partner'
)
BEGIN
  CREATE UNIQUE NONCLUSTERED INDEX [uq_inbound_partner] ON [ad_dc_inbound_partners] ([local_dc], [peer_dc], [naming_context]);
END;

-- ad_dc_outbound_partners.uq_outbound_partner  [[local_dc], [peer_dc], [naming_context]]  键 768 字节
IF EXISTS (
  SELECT 1 FROM [ad_dc_outbound_partners]
  GROUP BY [local_dc], [peer_dc], [naming_context]
  HAVING COUNT(*) > 1
)
BEGIN
  RAISERROR('R161.18: ad_dc_outbound_partners 上存在重复的 (local_dc, peer_dc, naming_context), 无法创建唯一索引 uq_outbound_partner。请先人工去重 (保留最新的一行), 再重跑本迁移。诊断: SELECT [local_dc], [peer_dc], [naming_context], COUNT(*) FROM ad_dc_outbound_partners GROUP BY [local_dc], [peer_dc], [naming_context] HAVING COUNT(*)>1;', 16, 1);
  RETURN;
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_dc_outbound_partners]')
    AND i.type IN (1, 2)
    AND i.is_unique = 1
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 3
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'local_dc'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'peer_dc'
         AND MAX(CASE WHEN ic.key_ordinal = 3 THEN c.name END) = 'naming_context'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_dc_outbound_partners' AND i.name = 'uq_outbound_partner'
)
BEGIN
  CREATE UNIQUE NONCLUSTERED INDEX [uq_outbound_partner] ON [ad_dc_outbound_partners] ([local_dc], [peer_dc], [naming_context]);
END;

-- ad_user_group_memberships.uq_ugm  [[domain_name], [user_sam], [group_dn_hash]]  键 800 字节
IF EXISTS (
  SELECT 1 FROM [ad_user_group_memberships]
  GROUP BY [domain_name], [user_sam], [group_dn_hash]
  HAVING COUNT(*) > 1
)
BEGIN
  RAISERROR('R161.18: ad_user_group_memberships 上存在重复的 (domain_name, user_sam, group_dn_hash), 无法创建唯一索引 uq_ugm。请先人工去重 (保留最新的一行), 再重跑本迁移。诊断: SELECT [domain_name], [user_sam], [group_dn_hash], COUNT(*) FROM ad_user_group_memberships GROUP BY [domain_name], [user_sam], [group_dn_hash] HAVING COUNT(*)>1;', 16, 1);
  RETURN;
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[ad_user_group_memberships]')
    AND i.type IN (1, 2)
    AND i.is_unique = 1
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 3
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'domain_name'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'user_sam'
         AND MAX(CASE WHEN ic.key_ordinal = 3 THEN c.name END) = 'group_dn_hash'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'ad_user_group_memberships' AND i.name = 'uq_ugm'
)
BEGIN
  CREATE UNIQUE NONCLUSTERED INDEX [uq_ugm] ON [ad_user_group_memberships] ([domain_name], [user_sam], [group_dn_hash]);
END;

-- system_alert_suppressions.uq_sas_kind_scope  [[kind], [scope_ref]]  键 550 字节
IF EXISTS (
  SELECT 1 FROM [system_alert_suppressions]
  GROUP BY [kind], [scope_ref]
  HAVING COUNT(*) > 1
)
BEGIN
  RAISERROR('R161.18: system_alert_suppressions 上存在重复的 (kind, scope_ref), 无法创建唯一索引 uq_sas_kind_scope。请先人工去重 (保留最新的一行), 再重跑本迁移。诊断: SELECT [kind], [scope_ref], COUNT(*) FROM system_alert_suppressions GROUP BY [kind], [scope_ref] HAVING COUNT(*)>1;', 16, 1);
  RETURN;
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                              AND ic.is_included_column = 0 AND ic.key_ordinal > 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.object_id = OBJECT_ID('[system_alert_suppressions]')
    AND i.type IN (1, 2)
    AND i.is_unique = 1
    AND i.filter_definition IS NULL
  GROUP BY i.index_id
  HAVING COUNT(*) = 2
         AND MAX(CASE WHEN ic.key_ordinal = 1 THEN c.name END) = 'kind'
         AND MAX(CASE WHEN ic.key_ordinal = 2 THEN c.name END) = 'scope_ref'
)
AND NOT EXISTS (
  SELECT 1 FROM sys.indexes i
  JOIN sys.tables t ON i.object_id = t.object_id
  WHERE t.name = 'system_alert_suppressions' AND i.name = 'uq_sas_kind_scope'
)
BEGIN
  CREATE UNIQUE NONCLUSTERED INDEX [uq_sas_kind_scope] ON [system_alert_suppressions] ([kind], [scope_ref]);
END;
