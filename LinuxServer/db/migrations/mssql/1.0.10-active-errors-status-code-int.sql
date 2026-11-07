-- verify: columntype ad_replication_active_errors.status_code int
--
-- R161.31 (2026-11-07) — ad_replication_active_errors.status_code 加宽 → INT (MSSQL)
--
-- ★★ 为什么用 `columntype` 而不是 `column`:
--   `column` 探针只查列**在不在**, **不查列的类型**
--   (center/src/db/sql.js 的 probe.column:
--      SELECT TOP 1 1 AS ok FROM INFORMATION_SCHEMA.COLUMNS
--       WHERE TABLE_NAME = ? AND COLUMN_NAME = ?
--   —— 没有类型条件)。
--   而这个迁移改的**就是类型**, 列本来就存在 ⇒ `column` 探针**必然通过**
--   ⇒ backfillMigrations() 会把本迁移**登记成 applied 而从不执行**
--   ⇒ 存量库的列类型**永远不变** ⇒ 两边 schema 分叉, 而且零告警
--     (这正是 R161.17 修掉的"编号迁移从来没被真正执行过"的同一个坑
--      换了个形状: 那次是"没标记 ⇒ 无条件登记", 这次是
--      "标记了但探针查不到类型差异 ⇒ 照样登记")。
--   ⇒ R161.31 给 verify 契约新增了 `columntype` 类型 (探针比对 sys.types.name),
--     类型变更类迁移**必须**用它。
--     (README 规则 0 的原话是"标记指向的产物, 就是这个迁移文件**建出来的东西**"
--      —— 类型变更没有"建出来"任何新东西, 列是旧的, 但它的**类型**是新的。)
--
-- ★★ MSSQL 的 TINYINT 是个历史包袱:
--   T-SQL 里 **没有** TINYINT 类型 —— `TINYINT` 是 `SMALLINT` 的**同义词**
--   (值域 -32768..32767)。也就是说基线里写的 `[status_code] TINYINT NOT NULL`
--   实际建出来的是 SMALLINT。
--   ⇒ 在 MSSQL 上 1398 / 1722 这些 Windows 错误码**装得下**, 所以这个
--     越界 bug 在 MSSQL 上**不会**复现 —— 但这不代表 MSSQL 就没问题:
--     ① 两边 schema 分叉 (MySQL 是真 TINYINT=127 上限, MSSQL 是 32767)
--        ⇒ 同一个 agent 报同一对 DC, 两边能存下的值域不同 ⇒ 跨库对比
--          / 数据搬迁 / 统一报表口径时会撞上。
--     ② MSSQL 的 SMALLINT 上限 32767 也**不是**"无上限" —— NTSTATUS 的
--        完整错误码空间里有超过 32767 的码 (如 0x8007... 系列), 一旦
--        agent 上报这类码, MSSQL 侧同样会越界。
--     ③ ad_replication_status / ad_replication_history 两张表在 MSSQL 上
--        本来就是 INT ⇒ 三张表统一到 INT 才叫"同一个 schema"。
--   ⇒ 本迁移把 MSSQL 侧也加宽到 INT, 让两个方言**收敛到同一个最终 schema**
--     (README 规则 4)。
--
-- ★★ 幂等性由 DDL 自身的守卫保证 (README 规则 2):
--   用 sys.columns 探当前类型, 只有"不是 int"时才执行 ALTER。
--   ⇒ 本文件重复跑**不会**报错, 也不会重复改表。
--
-- ★★ 为什么不是 BIGINT:
--   ad_replication_status / ad_replication_history 两张表的 status_code
--   在 MSSQL 上都是 **INT** ⇒ 三个表用同一个类型。INT 也够:
--   Windows 错误码最大 65535 (NTSTATUS), 远在 INT 范围内。

SET LOCK_TIMEOUT 10000;
SET QUOTED_IDENTIFIER ON;

-- 守卫: 只有当前类型不是 int 时才 ALTER。
--   ⚠ 用 sys.types.name (基本类型名 'int' / 'smallint' / 'tinyint' ...)
--     而不是 max_length: max_length 是**字节数** (int=4, smallint=2),
--     不同类型的字节数不同, 但"名字"才是人能读的语义。
--     ⚠ 同时排掉用户自定义类型 (user_type_id <> system_type_id):
--       用户类型会带着**基类型**的名字出现在 sys.types 里 (如
--       'int' 的别名), 不排除的话守卫会把"已经够了"判成"要改"。
IF EXISTS (
  SELECT 1
  FROM sys.columns c
  JOIN sys.types t ON t.user_type_id = c.user_type_id
  WHERE c.object_id = OBJECT_ID('[ad_replication_active_errors]')
    AND c.name = 'status_code'
    AND (t.name <> 'int' OR t.user_type_id <> t.system_type_id)
)
BEGIN
  ALTER TABLE [ad_replication_active_errors] ALTER COLUMN [status_code] INT NOT NULL;
END;
