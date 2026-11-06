# `db/` — 中心数据库结构 (基线 + 增量迁移)

本目录**随交付包一起发布**, 由安装脚本装到 **`<center>/../db/`** (= `<root>/db/`)。
它是中心建库与升级的**唯一** schema 来源。

---

## ★ 落位规则 (放错 = 静默不生效)

`center/src/init/schema-applier.js` 的 `resolveRepoRoot()` 现场解析仓库根, 候选顺序:

1. `opts.repoRoot` — 调用方钉死的路径 (测试夹具 / 特殊布局)
2. 环境变量 `ADDASHBOARD_REPO_ROOT`
3. **`<进程 cwd>/..`** ← 默认布局命中的就是这一条
4. `<进程 cwd>/../..`
5. `<进程 cwd>` 本身

每个候选**必须真的带 `db/` 子目录**才算数, 否则继续往下找。

| 平台 | cwd | `db/` 必须在 |
|---|---|---|
| Windows (NSSM) | `AppDirectory = <InstallPath>` | **安装目录的上一级** ⇒ `Server/scripts/install-center.ps1` 的 `Sync-CenterDbDirectory` 负责搬; 缺 `db/` **当场抛**, 不静默跳过 |
| Linux (PM2) | `cwd = <center>` | **交付包 `LinuxServer/` 里 `center/` 与 `db/` 平级** ⇒ `scripts/install.sh` 的 `check_tree_layout` 强制检查两份基线在位 |

⚠ **顶层没有回退**。`resolveSqlPath()` / `resolveMigrationsDir()` (R161.2) **只认
`db/migrations/<dialect>/`**, 找不到就返回 `null`:

- 初始化向导 (`applyAll`) ⇒ **大声报错**: 「找不到基线文件 db/migrations/<dialect>/1.0.0-baseline.sql」
- 启动自举 (`bootstrapMigrations`) ⇒ 静默跳过 (runtime-only 打包允许没有 `db/`)

⇒ **把迁移文件放在 `db/migrations/` 顶层 = 永远不会被执行, 且没有任何警告。**
这是 R161.2 故意拆掉的"安全网": 那条回退路径指向的顶层旧快照只有 54 张表
(MySQL 方言基线 75 张), 而且经历过一次有损编码往返, 一张表的 `CREATE TABLE`
粘在了 `--` 注释行尾 ⇒ 那张表从未被创建 ⇒ 引用它的外键必然失败。后果不是
"报错", 而是**静默装出错库**: 向导显示成功, 然后应用在完全不相干的地方报
"表不存在"。

---

## 目录结构 (R161.25 实测)

| 路径 | 角色 |
|---|---|
| `db/migrations/mysql/1.0.0-baseline.sql` | **MySQL 权威基线** (schema + seed 一体, 2344 行) |
| `db/migrations/mssql/1.0.0-baseline.sql` | **MSSQL 权威基线** (schema + seed 一体, 3036 行) |
| `db/migrations/<dialect>/1.0.x-*.sql` | **前向增量迁移** (升级路径真的执行) |
| `db/migrations/1.0.0-baseline.js` | ★ **留档, 当前不执行** — 见下 |
| `db/migrations/README.md` | 写迁移的规则 (**动手前必读**) |

### `1.0.0-baseline.js` 是留档, 不是在跑的迁移

它是 R66 (`installed_packages` → `package_scripts` + `package_policies`) 的 JS 数据
迁移侧车。但它住在 `db/migrations/` **顶层**, 而 `resolveJsFile()` /
`resolveMigrationJsFile()` 只扫 `db/migrations/<dialect>/` ⇒ **当前没有任何加载
路径会执行它**。R66 的拆分早已完成, 基线里已是拆好的形态。

⇒ **别把"随包发布"读成"会被执行"**, 也别因为"它是必需的"而不敢删 — 审计脚本
`Server/scripts/audit/check-linux-package-sync.mjs` 已经把这条写进了
`REQUIRED_PATHS` 的说明里 (C1b 单文件镜像对)。

### 编号迁移 (`NNN-*.sql`) 已全部退役

基线冻结 (R158.51) 之后, 方言目录里只剩 semver 命名的 `1.0.x-*.sql`。
`1.0.0` ~ `1.0.9` 的编号迁移是历史, `NNN-*` 三位编号的解析规则仍在代码里
(`/^(\d{1,3}(?:\.\d+){0,2})(?:-([a-z0-9-]+))?\.sql$/i`) 但**没有任何文件匹配它**。

---

## 两条安装路径

| 路径 | 触发 | 实际执行的文件 | 代码入口 |
|---|---|---|---|
| **新装** | 操作员跑 `/init` 向导建库 | 只跑 `db/migrations/<dialect>/1.0.0-baseline.sql` 一份 | `applyAll(dialect, db, opts)` (`schema-applier.js`) |
| **升级** | 存量部署启动, `schema_migrations` 表已有行而磁盘上有更新的文件 | 跑该方言目录下**尚未登记**的每一个文件 | `migrations.js` 的 `upgrade()` |

- **新装不跑迁移** (操作员 directive, R84 / 2026-09-09):「迁移只针对升级提供,
  新装不跑迁移」。新装的库直接从基线建出来, 基线里已经含全部累计 DDL。
- 新装之后 `backfillMigrations()` 会把磁盘上的迁移文件**登记**进
  `schema_migrations` (`applied_by='system-init'`, `execution_ms=0`, **不执行**),
  这样 admin「Schema Migrations」页不会把一台新机器显示成"一串待执行"。
- ★ 登记时带 `-- verify:` 标记的文件会**先探库**: 标记对不上就**跳过**
  (保持 pending, 让 admin 页如实显示)。没带标记的文件直接登记为已应用。

---

## 执行顺序 = 语义版本序 (不是文件名字典序)

`migrations.js` 的 `upgrade()` / `applyUpTo()` 与 `schema-applier.js` 的
`backfillMigrations()` 都走 `center/src/utils/migration-version.js` 的
`sortMigrationFiles()`。

⚠ 字典序下 `'1.0.10'` 排在 `'1.0.2'` **前面** ⇒ 版本号一到两位数, 执行顺序
就与版本语义相反 ⇒ 依赖前序迁移产物的迁移会建不出来 (例: `1.0.5` 的唯一索引
依赖 `1.0.4` 建出来的 hash 计算列)。**新迁移必须保证序号单调, 且依赖关系在前。**

---

## Seed 范围 (实测自基线 SQL)

| 表 | MySQL | MSSQL | 说明 |
|---|---|---|---|
| `sys_roles` | 3 | 3 | admin / operator / viewer |
| `role_permissions` | 4 | 4 | admin=`*`, operator=execute:sync+read:dash, viewer=read:dash |
| `system_config` | 33 | 49 | 两边**不等** —— 以各自基线的 seed 段为准 |
| `package_policies` | 14 | 14 | 1:1 对应 14 个内置包 |

**不**在 seed 里 (运行时由程序写):

- `probe_state` — 端口角色/状态/延迟, 启动后 1 分钟内写入
- `package_scripts` — 脚本正文 + sha256 + manifest_json; 源在
  `center/data/packages/<name>/<ver>/collect.ps1`, 由
  `seedBuiltinPackages()` (`center/src/services/builtin-packages.js`) 拷进库
- `cron_schedule` — `DEFAULT_SCHEDULES` JS 常量 (`center/src/services/cron-scheduler.js`),
  操作员 directive Q4 (2026-10-19)「保持 JS 常量」
- `system_config` 里的 token / secret / checksum 行 — 安装期由
  `ensureSignatureAndInstalledAt` 生成

---

## 改基线 / 加迁移的操作顺序

1. **先写增量**: `db/migrations/<dialect>/1.0.<n+1>-<slug>.sql`。
   **MySQL 与 MSSQL 都要写** (两个方言目录各一份), 语义必须一致。
2. **再合并进基线**: 同样的 DDL 合并进
   `db/migrations/<dialect>/1.0.0-baseline.sql` —— 否则**新装的库拿不到这个改动**
   (新装只跑基线)。
3. 迁移文件要带 `-- verify:` 标记 (见 `db/migrations/README.md` 的规则)。
4. 改完跑审计: `node Server/scripts/audit/check-linux-package-sync.mjs`
   (0 error / 0 warning) —— `db/` 目录必须在源树与 `LinuxServer/` 里**逐字节相同**。
5. 跑测试: `cd Server/center && npm test`。

### MSSQL 结构对账

改 MSSQL 基线前, 先拿**当前可用的 MSSQL 实例**导出的结构做对账 (操作员侧的
权威参考: `D:\Tools\data.sql`, **UTF-16LE** 编码, 用 `HEX`/TextDecoder 读别用
`Get-Content` 直接读)。别凭记忆改基线。
