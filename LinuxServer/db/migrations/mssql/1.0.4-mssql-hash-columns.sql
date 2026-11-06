-- verify: column ad_admin_members.domain_dn_hash
-- verify: column ad_ous_snapshot.distinguished_name_hash
-- verify: column ad_user_group_memberships.group_dn_hash
--
-- R161.18 (2026-10-28) — 补 3 个 PERSISTED hash 计算列 (P0: 4 条 MSSQL MERGE 依赖它们)
-- 生产形状的 MSSQL 库缺这三个列 ⇒ 那 4 条写路径必然编译失败 (Msg 207)。
-- 计算列由引擎回填, 不改业务数据 ⇒ 零数据风险。
SET LOCK_TIMEOUT 10000;
SET QUOTED_IDENTIFIER ON;

-- ★ P0: Server/center/src/db/sql.js 里有 4 条 MSSQL MERGE 的 ON 子句直接引用
--   这三个列 (adminMembers / upsertOu / upsertOuWithForest / upsertUgm),
--   而生产形状的库里没有它们 ⇒ 那 4 条写路径必然 Msg 207 "列名无效"。
--   计算列是 PERSISTED ⇒ 建列时引擎自动回填, 不用碰业务数据。
--   MSSQL 的 HASHBYTES 按 UTF-16 字节算, MySQL 的 SHA2 按 UTF-8 算 ——
--   两边的哈希值本来就不可比, 各方言内部自洽即可。

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[ad_admin_members]') AND name = 'domain_dn_hash')
BEGIN
  ALTER TABLE [ad_admin_members] ADD [domain_dn_hash] AS CONVERT(BINARY(32), HASHBYTES('SHA2_256', [domain_dn])) PERSISTED;
END;

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[ad_ous_snapshot]') AND name = 'distinguished_name_hash')
BEGIN
  ALTER TABLE [ad_ous_snapshot] ADD [distinguished_name_hash] AS CONVERT(BINARY(32), HASHBYTES('SHA2_256', [distinguished_name])) PERSISTED;
END;

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('[ad_user_group_memberships]') AND name = 'group_dn_hash')
BEGIN
  ALTER TABLE [ad_user_group_memberships] ADD [group_dn_hash] AS CONVERT(BINARY(32), HASHBYTES('SHA2_256', [group_dn])) PERSISTED;
END;
