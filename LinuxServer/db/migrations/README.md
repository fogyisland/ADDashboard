# `db/migrations/` — 升级路径增量

**这个目录只喂升级路径。** 新装**不执行**这里的任何文件 —— 新装只跑
`db/migrations/<dialect>/1.0.0-baseline.sql`。动手加文件前先读完这一页。

---

## 两条安装路径

| 路径 | 触发 | 实际执行的文件 | 代码入口 |
|---|---|---|---|
| **新装** | 操作员跑 `/init` 向导, 建一个**全新**的库 | `db/migrations/<dialect>/1.0.0-baseline.sql` **一份** (schema + seed 一体) | `applyAll(dialect, db, opts)` — `center/src/init/schema-applier.js` |
| **升级** | 存量部署启动, `schema_migrations` 表已有行, 而磁盘上有更新的文件 | 该方言目录下**尚未登记**的每一个 `.sql` | `migrations.js` 的 `upgrade()` — `center/src/services/migrations.js` |

判别很简单: `schema_migrations` 表存在且有行 ⇒ 升级路径; 缺失或为空 ⇒ 新装路径。

新装跑完基线后, `backfillMigrations()` 会把磁盘上的迁移文件**登记**进
`schema_migrations` (`applied_by='system-init'`, `execution_ms=0`, **一行 SQL 都不跑**)
—— 这样 admin「Schema Migrations」页不会把一台新机器显示成"一串待执行"。

---

## ★ 规则 0: 迁移文件**必须**带 `-- verify:` 标记

这是**唯一一个"漏了也不会报错、但功能就是不上"的坑** (R161.17 / R161.18)。

`backfillMigrations()` 遇到一个 `.sql` 文件时:

- **带标记** ⇒ 先探库, 标记指向的表/列/索引/外键**在库里**才登记成 applied;
  不在 ⇒ **跳过** (保持 pending), 并打一条 warn 日志。
- **不带标记** ⇒ **无条件登记成 applied**, 从不探库, **零告警**。

⇒ 没有标记的迁移文件, 在某些路径上会**从未被执行**, 而且没有任何迹象。
R161.17 就是这么发现"编号迁移从来没被真正执行过"的; R161.18 则是同一个坑的
第二条腿 (外键迁移写的 `-- verify: foreignkey ...` 被解析器整个忽略 ⇒ 等价于
没有标记 ⇒ 外键永远建不出来)。

### 标记语法

每种类型**一行一个**, 一个标记只带**一个**名字:

```sql
-- verify: table      <table_name>
-- verify: column     <table>.<column>
-- verify: index      <table>.<index_name>
-- verify: foreignkey <table>.<constraint_name>
```

规则:

- 关键字**大小写不敏感**; 关键字与名字之间的空白会被折叠。
- **只扫文件开头 50 行非空行** —— 标记要写在靠前的位置 (评审的人先看到它)。
- 复数形式 (`tables` / `columns` / `indexes`) 和逗号列表**故意不接受** ——
  不许用一个偷懒的标记盖掉半成品; 一个产物一行。
- 标记必须在块注释 `/* ... */` **外面**。
- 标记指向的产物, 就是这个迁移文件**建出来的东西**。标记写错 ⇒ 探针永远失败
  ⇒ 文件永远 pending ⇒ admin 页如实显示"这个还没落库"。

---

## 规则 1: 一个改动要改**四个地方**

1. `db/migrations/mysql/1.0.<n+1>-<slug>.sql` — MySQL 增量
2. `db/migrations/mssql/1.0.<n+1>-<slug>.sql` — MSSQL 增量
3. `db/migrations/mysql/1.0.0-baseline.sql` — 把同样的 DDL **合并进 MySQL 基线**
4. `db/migrations/mssql/1.0.0-baseline.sql` — 把同样的 DDL **合并进 MSSQL 基线**

★ **3 和 4 不能省。** 新装只跑基线 (规则 0 上面的表) ⇒ 忘了合并 ⇒ **新装的库
拿不到这个改动**, 而升级路径上的老库有 ⇒ 两边 schema 分叉, 且分叉方向是
"新装的缺东西" ⇒ 装完立刻报错, 而且报错现场离原因很远。

---

## 规则 2: 迁移文件是升级形态的**唯一真值**

基线文件是**去规范化的便利副本** —— 两边要**手工保持同步**。

- 迁移文件必须**幂等**: MySQL 5.7 **没有** `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
  ⇒ 用过程化的守卫 (`INFORMATION_SCHEMA.COLUMNS` 探针 + 动态 SQL); MSSQL 用
  `IF COL_LENGTH(...) IS NULL` 或 `sys.columns` 探针 + `EXEC`。
- 合并进基线时, 直接把列/表/索引写进 `CREATE TABLE` 里 —— 基线不需要守卫。

---

## 规则 3: 命名与**执行顺序**

- 命名: `1.0.<n>-<short-kebab-name>.sql` (例: `1.0.4-mssql-hash-columns.sql`)。
- **执行顺序 = 语义版本序**, 由 `center/src/utils/migration-version.js` 的
  `sortMigrationFiles()` 决定, **不是文件名字典序**。
  ⚠ 字典序下 `'1.0.10'` 排在 `'1.0.2'` **前面** ⇒ 版本号一到两位数, 执行顺序
  就与版本语义相反 ⇒ 依赖前序迁移产物的迁移会建不出来 (例: `1.0.5` 的唯一索引
  依赖 `1.0.4` 建出来的 hash 计算列)。
  ⇒ **序号必须单调递增, 依赖关系必须在前。**
- 文件名匹配 `/^(\d{1,3}(?:\.\d+){0,2})(?:-([a-z0-9-]+))?\.sql$/i`:
  semver (`1.0.5-foo.sql`) 与旧的三位编号 (`053-foo.sql`) 都认, 但**旧编号迁移
  已全部退役** (基线冻结 R158.51 之后目录里只剩 semver 命名)。

---

## 规则 4: 双方言必须收敛到**同一个最终 schema**

- MSSQL 侧特有: `IF OBJECT_ID(...) IS NULL` + `GO` 批次分隔 + `SET QUOTED_IDENTIFIER ON`。
  `splitSqlStatements()` 认识 `GO` 与 MySQL 的 `DELIMITER`。
- 索引键长两边口径不同 (**声明宽度**算, 不是数据长度):
  - MySQL / InnoDB: 上限 **3072 字节** (utf8mb4 每字符 4 字节); 超了 DDL 直接
    失败 (ER 1071)。前缀索引 `col(n)` 的 n 以**字符**计。
  - MSSQL: `NVARCHAR` 每字符 2 字节; 聚集索引键上限 **900** 字节, 非聚集
    **1700** 字节; DDL 阶段只警告 (Msg 1945), **写入阶段硬失败** (Msg 1946)。
    MSSQL **不支持**前缀索引 ⇒ 长列必须改列宽或改键设计。
  - 守卫脚本: `node Server/scripts/audit/check-index-key-length.mjs`
    (它复用生产代码 `splitSqlStatements`, 检查的就是真正会执行的那批语句)。

---

## 规则 5: 一个文件 = 一个事务

`applyMigration()` 把整个文件切开后放进**一个事务**执行 (MSSQL 侧由
`db.transaction` 承担)。⇒ 文件内部要么全成要么全败。

★ JS 侧车例外: 同目录下 `<version>-*.js` 在 **SQL 事务提交之后**才跑。
JS 步骤失败 ⇒ SQL **不会回滚** (事务已提交), 但该版本在 `schema_migrations`
里被标成 `failed` ⇒ 操作员重试时整个文件重跑 (迁移文件要能重跑)。

---

## 验证一个迁移真的落地

1. **新装路径** — 用一个空库跑 `/init` 向导, 然后确认**基线**里带上了这个改动
   (`SHOW COLUMNS FROM <表>` / `sys.columns`)。
2. **升级路径** — 用一个"旧 schema + 新文件"的库启动中心, 看 `Logs/center.log`
   里的启动自举日志, 以及 admin「Schema Migrations」页该版本变成 applied。
3. **两边都做** — 只验证一边, 另一半的分叉要到下次升级才暴露。

---

## 审计

改动 `db/` 之后必跑:

```bash
node Server/scripts/audit/check-linux-package-sync.mjs   # 源树 vs LinuxServer 逐字节
node Server/scripts/audit/check-index-key-length.mjs     # 索引键长
node Server/scripts/audit/check-dialect-compat.mjs       # 方言泄漏
cd Server/center && npm test
```

---

## 历史

- **R161.19 (2026-10-28)** — 执行顺序改成语义版本序; 编号迁移纳入索引键长扫描;
  MSSQL 键长模型按实测纠正 (聚集键不追加进非聚集索引键)。
- **R161.18 (2026-10-28)** — verify 标记新增 `foreignkey` 类型。
- **R161.17 (2026-10-27)** — verify 标记契约写死: 带标记的才探库, 不带标记的
  **无条件登记成 applied** ⇒ "编号迁移从来没被真正执行过"。
- **R161.3 / R161.2 (2026-10-25)** — 索引键长守卫 + MySQL 外键顺序。
- **R158.51 (2026-10-08)** — 基线冻结: schema 收成单份 `1.0.0-baseline.sql`,
  `db/schema/` 目录删除, seed 折进基线。
- **R84 (2026-09-09)** — 拆开新装与升级语义: `applyAll()` 不再遍历
  `db/migrations/`。操作员原话:「迁移只针对升级提供, 新装不跑迁移」。
