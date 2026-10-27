-- verify: foreignkey ad_dc_overview.fk_dc_overview_site
--
-- R161.18 (2026-10-28) — 补齐缺失的外键 fk_dc_overview_site (建之前查孤儿)
-- 外键 = 引用完整性; 有孤儿行则 RAISERROR, 不自动删数据。
SET LOCK_TIMEOUT 10000;
SET QUOTED_IDENTIFIER ON;

-- ★ 基线里有、生产形状的库里没有的外键 (实测 22 vs 23)。
--   建之前查孤儿: 有孤儿就 RAISERROR, 把诊断 SQL 一并给出, 绝不自动删数据。
--   ★ 孤儿检查必须**在** ADD CONSTRAINT **之前**单独一批 —— splitSqlStatements
--     按语句拆批, 一个 BEGIN...END 块就是一批, 块里的 RETURN 会退出整批。

IF EXISTS (
  SELECT 1 FROM [ad_dc_overview] d
  WHERE d.site_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM [ad_sites] s WHERE s.site_id = d.site_id)
)
BEGIN
  RAISERROR('R161.18: ad_dc_overview 里有 site_id 指向 ad_sites 中不存在的行 (孤儿), 无法创建外键 fk_dc_overview_site。请先清理孤儿 (诊断: SELECT d.site_id, COUNT(*) FROM ad_dc_overview d WHERE d.site_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ad_sites s WHERE s.site_id = d.site_id) GROUP BY d.site_id;), 再重跑本迁移。', 16, 1);
  RETURN;
END;

-- 守卫按**形状**: 同一个子表 + 同一个被参照表 + 同一对列 ⇒ 视为已存在。
-- 名字只是附加条件 —— 客户库里这条约束可能叫别的名字 (SSMS 自动名),
-- 只按名字判重会造出第二条**重复**的外键约束 (SQL Server 允许同列多约束)。
IF NOT EXISTS (
  SELECT 1
  FROM sys.foreign_keys f
  JOIN sys.tables pt ON f.parent_object_id = pt.object_id
  JOIN sys.tables rt ON f.referenced_object_id = rt.object_id
  JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = f.object_id
  JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
  JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
  WHERE pt.name = 'ad_dc_overview'
    AND rt.name = 'ad_sites'
    AND pc.name = 'site_id'
    AND rc.name = 'site_id'
    AND (SELECT COUNT(*) FROM sys.foreign_key_columns c2 WHERE c2.constraint_object_id = f.object_id) = 1
)
AND NOT EXISTS (
  SELECT 1 FROM sys.foreign_keys f
  JOIN sys.tables t ON f.parent_object_id = t.object_id
  WHERE t.name = 'ad_dc_overview' AND f.name = 'fk_dc_overview_site'
)
BEGIN
  ALTER TABLE [ad_dc_overview] ADD CONSTRAINT [fk_dc_overview_site] FOREIGN KEY ([site_id]) REFERENCES [dbo].[ad_sites] ([site_id]);
END;
