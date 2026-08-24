# AD Dashboard 运维 Runbook

> **首次部署请看 [deployment.md](deployment.md)** — 本文是已部署之后的日常运维、恢复与故障排查。
>
> **路径约定**：本文示例用 `$DashboardRoot` 占位 dashboard 安装根目录。脚本默认 install 路径是脚本相对的 `<publish-root>/Center` 和 `<publish-root>/Agent`（可解压到任意位置运行）；若你想装到其他位置（典型如 `D:\dashboard`），复制命令前先 `Set-Variable DashboardRoot 'D:\dashboard'`，所有示例的 `$DashboardRoot` 即解析为该路径。

## 环境依赖（Prerequisites）

- **Node.js 18+**（推荐 LTS）— center 服务是 Node 实现，agent 也使用 Node 脚本采集数据。
- **NSSM**（Windows Service Helper）— 若缺失，`scripts/install-center.ps1` 会通过 `Install-Module` 自动安装。
- **数据库**：MySQL 5.7+ 或 SQL Server 2014+（部署时二选一）。
- **PowerShell 5.1+**（Windows 10/Server 2016+ 自带）。
- SQL Server 部署额外要求：`sqlcmd` 在 PATH 中（SQL Server Command Line Tools）— 仅手动应用 migration 时需要。

## 服务清单

| 服务 | 部署位置 | 显示名 | NSSM 服务名 |
|------|----------|--------|-------------|
| Center | Center 管理服务器 | AD Replication Dashboard Center | `ADDashboardCenter` |
| Agent | 每台 DC | AD Replication Agent (on `<hostname>`) | `ADReplicationAgent` |

## 常用命令

```powershell
# 查看所有 DC 上服务的运行状态
Get-Service ADReplicationAgent, ADDashboardCenter | Format-Table Name, Status, StartType, MachineName

# 重启本机 agent
Restart-Service ADReplicationAgent -Force

# 跟踪 agent 日志
Get-Content "$DashboardRoot\Logs\ADReplicationAgent-stdout.log" -Tail 100 -Wait

# 跟踪 center 日志
Get-Content "$DashboardRoot\Logs\ADDashboardCenter-stdout.log" -Tail 100 -Wait

# 健康检查
Invoke-WebRequest http://center:8080/healthz | Select -ExpandProperty Content
```

## 日常运维

### 新增 DC

1. 验证 center 到新 DC 的 WinRM 连通性：`Test-WSMan -ComputerName <newdc>`
2. 执行 `.\scripts\install-agent.ps1 -ComputerName <newdc> -CenterUrl http://center:8080 -AgentToken <token>`
3. 等待 60 秒，在 Dashboard → Agent 列表（或 `GET /api/dashboard/agents`）中确认

### 修改采集间隔

1. 用 admin 账号登录
2. 进入 管理 → 系统配置
3. 编辑 `polling_interval_minutes`，保存
4. agent 在下一次 5 分钟配置刷新时生效（或重启 agent 立即生效）

### 更新 Center

**推荐（API 触发，无需 admin shell）：**

```powershell
# 1. 在 center 管理服务器上覆盖新代码
cd C:\Repos\ADDashboard
git pull

# 2. 从本机调一次更新 API（localhost-only，无密码；自动跑 pending migration + 重启）
Invoke-RestMethod -Method Post -Uri http://localhost:8080/api/system/update
```

**首次升级走 API 之前需要手动重启一次**（让新端点代码生效）。之后所有升级都可走纯 API。详见 [`deployment.md` §7](deployment.md#升级与回滚)。

**脚本式（兼容旧路径，需 admin shell）：**

```powershell
.\scripts\upgrade-center.ps1 -RebuildFrontend
```

**注意：** 该路径**不会**自动跑 DB migration；新表结构 / 列仍需按旧文档手动应用 SQL。建议切到 API 触发路径。

### 滚动更新 Agent

```powershell
# 逐台更新，更新一台确认健康后再更新下一台
.\scripts\install-agent.ps1 -ComputerName DC-BJ-01 -CenterUrl http://center:8080 -AgentToken <token>
# 该脚本内部执行 Stop-ServiceSafe → 拷贝文件 → Start-ServiceSafe
```

### 数据库备份

```powershell
sqlcmd -S localhost -Q "BACKUP DATABASE [AD_Monitoring] TO DISK='D:\Backups\AD_Monitoring_<date>.bak'"
```

### 轮换 Agent Token

1. 生成新 UUID：`[Guid]::NewGuid().Guid`
2. 用 admin 登录 → 管理 → 系统配置 → 把 `ad_agent_token` 改为新值
3. 在每台 DC 上：编辑 `$DashboardRoot\Agent\appsettings.json` 的 `agentToken`，然后 `Restart-Service ADReplicationAgent`

## 灾难恢复

### Center 服务器丢失

1. 准备新管理服务器，安装与之前相同版本的数据库（MySQL 8+ 或 SQL Server 2014+，参见下文 [多数据库支持](#多数据库支持)）
2. 从最新备份恢复数据库
3. 安装 center，使用与之前一致的 agent token 和 jwt secret：
   ```
   .\scripts\install-center.ps1 -AgentToken <same-as-before> -JwtSecret <same-as-before>
   ```
   数据库连接由后续的 `/init` 向导处理（参见下文 [首次启动设置向导](#首次启动设置向导-first-run-setup-wizard)）
4. 浏览器打开 `http://server:8080/init`，在向导第 1 屏填入与之前一致的 MySQL/SQL Server 连接信息，依次完成 3 屏
5. 验证 `/healthz` 返回 200

agent 仍会使用本地缓存的 `appsettings.json` 与本地队列缓存；center URL 恢复可达后自动恢复上报。

## 数据库 Migration 与发现

### Migration

数据库 migration 文件位于 `db/migrations/NNN-name.sql`，由 `scripts/install-center.ps1` 安装 center 后通过首次启动的 `/init` 向导自动应用（schema + seed + migration 一并执行）。

如需手动应用 migration，按部署的 dialect 选择对应的 CLI：

```powershell
# MySQL
Get-Content db\migrations\001-dc-site-discovery.sql | mysql -h <host> -P 3306 -u root -p<pwd> ad_monitoring

# SQL Server（需要 sqlcmd 在 PATH 中）
Invoke-Sqlcmd -ServerInstance <host> -Database AD_Monitoring -InputFile db\migrations\mssql\001-dc-site-discovery.sql
```

已应用的 migration 通过文件名前缀顺序隐式追踪（未维护 migrations 表 — 若后续要加追踪表请参考 ADR-XXX）。

### DC/Site 发现

agent 每 `discovery_interval_hours`（默认 4 小时）采集本地 DC 元数据，POST 到 `/api/agent/discover`。center UPSERT 到 `ad_dcs`；`site_id` 永远由 admin 在中心侧维护，agent 不会触碰。

admin 通过 `/admin/sites-catalog` 维护站点，通过 `/admin/dcs-catalog` 分配 DC 到站点。`/admin/site-replication-matrix` 页面展示选中站点的 DC×DC 复制矩阵，每 `site_matrix_refresh_seconds`（默认 10 秒）自动刷新。

## 端口健康检查（Custom Port Healthcheck）

Agent 除了心跳上报复制/拓扑数据外，还会对管理员在 center 维护的 TCP 端口清单做主动连通性探测（127.0.0.1，2s 超时），结果在 Agents 视图用彩色徽章展示。

### 管理端口清单

1. 用 admin 登录 → 侧栏「管理」下「端口健康检查」（路径 `/admin/ports`）
2. 增删改 `port`（1-65535，唯一）/ `label`（展示名）/ `sort_order`（展示排序）
3. Agent 在下次心跳时（默认 5s 内）会拉取新清单并自动生效

底层 REST：`GET/POST /api/admin/ports`、`PUT/DELETE /api/admin/ports/:id`。

### 查看探测结果

- Agents 视图每行按端口显示徽章：绿 <100ms / 黄 100-500ms / 红 ≥500ms 或不可达 / 灰 `—` 无数据
- REST：`GET /api/dashboard/agents`，每个 agent 的 `portStatuses: [{port, label, ok, latencyMs, lastCheckedAt}]`
- 管理员从清单中删除某端口后，其历史探测行会在展示层自动隐藏（SQL `INNER JOIN system_ports`）

### 验证 agent 在上报端口数据

```powershell
# 从中心服务器
$t = (Invoke-WebRequest http://center:8080/api/auth/login `
  -Method POST -ContentType 'application/json' `
  -Body '{"username":"admin","password":"..."}').Content | ConvertFrom-Json
(Invoke-WebRequest http://center:8080/api/dashboard/agents `
  -Headers @{Authorization="Bearer $($t.token)"}).Content |
  ConvertFrom-Json |
  Select-Object agentId, @{N='ports';E={ $_.portStatuses.Count }}
```

每个 agent 应有非空 `portStatuses`（前提：system_ports 清单非空）。

### 添加新端口的推荐流程

1. 选 port：`Test-NetConnection -ComputerName <dc> -Port <port>` 在一台 DC 上确认业务在用
2. 加进 `/admin/ports`（label 用业务名，如 `AD Web Services`）
3. 等 30 秒，验证该 DC 在 Agents 视图显示绿/黄徽章
4. 跨 DC 横向对比：所有 DC 同端口应在同一颜色段（绿/黄/红），如果某台 DC 长期红说明该 DC 上业务停或防火墙策略差异

### 移除端口

在 `/admin/ports` 删除即可——agent 不再探测，旧探测行不再展示（无后台清理 job，靠展示层 SQL `INNER JOIN` 过滤）。

---

## 多数据库支持

center 服务同时支持 MySQL 5.7+ 和 SQL Server 2014+，部署时二选一。在 `appsettings.json` 中通过 `db.dialect` 指定（首次启动的 `/init` 向导第 1 屏也会写入）；服务运行时不切换 dialect。

### MySQL 5.7+（默认）

`appsettings.json`：
```json
{
  "db": {
    "dialect": "mysql",
    "mysql": { "host": "...", "port": 3306, "database": "...", "user": "...", "password": "..." }
  }
}
```

### SQL Server 2014+

`appsettings.json`：
```json
{
  "db": {
    "dialect": "mssql",
    "mssql": { "server": "...", "database": "...", "user": "...", "password": "...", "encrypt": false }
  }
}
```

SQL Server 部署需提前手动创建空数据库。手动应用 migration 时需要 `sqlcmd` 在 PATH 中。

### Schema 与 migration 目录布局

```
db/
├── schema/
│   ├── 01-tables.sql           # mysql（默认；legacy 别名）
│   ├── 02-seed-roles.sql       # mysql
│   ├── mysql/                  # mysql 规范路径
│   │   ├── 01-tables.sql
│   │   └── 02-seed-roles.sql
│   └── mssql/
│       ├── 01-tables.sql
│       └── 02-seed-roles.sql
└── migrations/
    ├── 001-dc-site-discovery.sql  # mysql（legacy 别名）
    ├── mysql/
    │   └── 001-dc-site-discovery.sql
    └── mssql/
        └── 001-dc-site-discovery.sql
```

### 集成测试

```bash
# 针对 mysql 跑全部集成测试
TEST_SQL_URL=127.0.0.1 npm test --workspace=center

# 针对 sql server 跑
TEST_MSSQL_URL=myserver.local npm test --workspace=center

# 同时跑两个
TEST_SQL_URL=127.0.0.1 TEST_MSSQL_URL=myserver.local npm test --workspace=center
```

若两个环境变量均未设置，集成测试自动跳过，只跑基于 mock 的单元测试。

## 首次启动设置向导（First-Run Setup Wizard）

首次启动（或任何时候没有 admin 用户时），center 服务以 **init 模式** 启动，并在 `http://server:8080/init` 提供一个 3 屏浏览器向导：

1. **第 1 屏 — 数据库连接**：选择 MySQL 或 SQL Server，填入 host/port/database/user/password，点击 "测试连接" 验证后点 "下一步"。
2. **第 2 屏 — 管理员账户**：设置初始 admin 用户名和密码（≥8 字符，带强度提示）。
3. **第 3 屏 — 初始化**：自动执行 schema 应用 + seed + admin 创建 + 写入 `appsettings.json` + 写入 init 完成标记，屏内分阶段显示进度。

初始化完成后：
- `appsettings.json` 已写入磁盘，包含所选的 DB 配置。
- `sys_users` 中已创建 admin。
- `sys_roles` 中已写入 3 个默认角色（admin/operator/viewer）。
- `system_config` 中已写入 7 个默认键（`ad_agent_token`、`polling_interval_minutes` 等）。
- `/init` 自动重定向到 `/login`。
- `/api/init/*` 返回 404。

### Init 模式触发条件

服务进入 init 模式（即以下**任一**条件成立）：
- `appsettings.json` 缺失
- `appsettings.json` 存在但缺 `db.dialect` 字段
- `db.healthcheck()` 失败（数据库不可达）
- `SELECT COUNT(*) FROM sys_users u JOIN sys_roles r ON u.role_id = r.id WHERE r.role_name = 'admin'` 返回 0

**注意**：一旦 init 完成，会在 `<installPath>/.env` 中写入 `ADDASHBOARD_INITIALIZED=1`（外加 Windows 注册表 `HKLM\SOFTWARE\ADDashboard\Initialized`）作为"init 已完成"硬锁标记。仅删除 admin 用户**不会**让向导再次出现 — 必须先把标记清除（见下）。

### 恢复（重跑向导）

如果需要重跑向导（例如忘记 admin 密码且无其他 admin），必须**同时**清除 init 标记 **和** admin 用户行 — 仅删除 admin 用户会被标记拦截。

**第 1 步 — 清除 init 标记**（以下任选其一即可，建议都做）：

- **文件标记**：编辑 `<installPath>/.env`，删除其中的 `ADDASHBOARD_INITIALIZED` 和 `ADDASHBOARD_INITIALIZED_AT` 两行，保存关闭。
- **Windows 注册表**（以管理员身份打开 `cmd.exe`）：
  ```
  reg delete "HKLM\SOFTWARE\ADDashboard" /v Initialized /f
  ```

**第 2 步 — 删除 admin 行**：

```sql
DELETE FROM sys_users WHERE role_id IN (SELECT id FROM sys_roles WHERE role_name = 'admin');
```

**第 3 步 — 重启服务**：

```powershell
Restart-Service ADDashboardCenter
```

之后向导会再次出现在 `http://server:8080/init`。若要彻底重置（换 DB 主机等），还需在重启前删除 `appsettings.json`，向导会要求重新走完整的"数据库连接 + admin 设置"流程。

### 完整安装流程

```powershell
# 1. 部署（install-center.ps1 — 仅做部署，不做应用初始化）
.\scripts\install-center.ps1 -InstallPath '$DashboardRoot\Center'

# 2. 浏览器打开 http://server:8080/init
# 3. 完成 3 屏向导
# 4. 用新创建的 admin 账号在 http://server:8080/login 登录
```