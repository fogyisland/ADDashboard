# AD Dashboard 部署指南

> 适用版本：**v1.0.0+**。本文档是从「拿到一台新机器」到「dashboard 在浏览器可用」的完整流程；日常运维与灾难恢复参见 [`runbook.md`](runbook.md)。

## 目录

1. [架构速览](#架构速览)
2. [前置依赖](#前置依赖)
3. [Center 部署](#center-部署)
4. [Agent 部署](#agent-部署)
5. [首次启动向导](#首次启动向导)
6. [服务管理](#服务管理)
7. [升级与回滚](#升级与回滚)
8. [自定义端口健康检查（migration 003）](#自定义端口健康检查migration-003)
9. [升级到 v2.0+（包系统 / 插件系统）](#升级到-v20包系统--插件系统)
10. [本地 production preview（无服务）](#本地-production-preview无服务)
11. [故障排查](#故障排查)
12. [Green Bundle（publish/）的默认行为变更](#green-bundlepublish的默认行为变更)

---

## 架构速览

```
┌─────────────────────┐         HTTP POST          ┌──────────────────────┐
│  DC (per server)    │  ───────────────────────▶  │   Center             │
│  ADReplicationAgent │   /api/agent/{heartbeat,   │   ADDashboardCenter  │
│  (NSSM service)     │    replication, discover}  │   (NSSM service)     │
└─────────────────────┘                            └──────────┬───────────┘
                                                              │
                                                              ▼
                                                    ┌──────────────────┐
                                                    │  MySQL 5.7+ 或    │
                                                    │  SQL Server 2014+ │
                                                    └──────────────────┘
```

**Agent** 主动推数据（HTTP POST），Center 暴露 REST API + 静态前端（Vue 3 + ECharts）。

---

## 前置依赖

| 依赖 | 最低版本 | 说明 |
|---|---|---|
| Node.js | 18+（推荐 LTS 20/22） | center 服务 + agent 都是 Node 实现。安装时 `node.exe` 必须在 PATH 中 |
| PowerShell | 5.1+ | Windows 10 / Server 2016+ 自带。installer 脚本用 PS 5.1 语法 |
| 数据库 | MySQL 5.7+ **或** SQL Server 2014+ | 二选一，运行时不可切换 |
| 网络（首次部署） | 出网 HTTPS 到 nssm.cc | 仅当 `publish/nssm/nssm.exe` 不存在时才下载；否则直接用仓库内捆绑的副本 |
| 端口 | Center 监听 `:8080`（可改） | 防火墙需放行 |
| ActiveDirectory 模块 | — | 仅 Agent 端需要（PowerShell `Get-ADReplication*` cmdlet） |

**特别说明：**
- **NSSM 已捆绑在仓库内**：`publish/nssm/nssm.exe`（约 324 KB）随 git 提交，`Get-NssmPath` 优先用此路径。clone 仓库后**不需要**任何额外下载。
- 仅在 `publish/nssm/nssm.exe` 缺失（例如浅克隆/裁剪包）时，`scripts/common/Ensure-Nssm.ps1` 才会从 [nssm.cc](https://nssm.cc/release/nssm-2.24.zip) 自动下载回填到同一目录。

---

## Center 部署

### 标准流程（一条命令）

```powershell
# 在 center 管理服务器上，以管理员身份打开 PowerShell
git clone https://github.com/fogyisland/ADDashboard.git
cd ADDashboard
.\scripts\install-center.ps1
```

执行后自动完成：

1. 校验 Node.js 可达
2. **自动下载 NSSM 2.24**（如果 `<repo>/nssm/nssm.exe` 不存在）到项目本地
3. `npm run build:frontend`（仅当 `frontend/dist/index.html` 不存在时）
4. 拷贝 `center/` + `frontend/dist/` → `C:\addashboard\Center\`
5. `npm install --omit=dev` 安装 center 的运行时依赖
6. 用 NSSM 注册 `ADDashboardCenter` 服务（启动类型=自动）
7. 启动服务
8. 探测 `http://localhost:8080/api/init/status`

**默认安装路径：**

| 项 | 路径 |
|---|---|
| Center | `C:\addashboard\Center\` |
| 日志 | `C:\addashboard\Logs\ADDashboardCenter-{stdout,stderr}.log` |

### 自定义路径

```powershell
.\scripts\install-center.ps1 -InstallPath 'D:\apps\addashboard\Center' -ListenPort 9090
```

所有可调参数：

| 参数 | 默认值 | 说明 |
|---|---|---|
| `-InstallPath` | `C:\addashboard\Center` | 安装根目录 |
| `-ListenPort` | `8080` | HTTP 监听端口 |
| `-AgentToken` | 自动生成 UUID | center 与 agent 共享的鉴权 token（首次随机生成后保留在同一目录的 appsettings 中） |
| `-JwtSecret` | 自动生成 64 字符 | JWT 签名密钥 |

### 部署后必须做

浏览器打开 `http://<center>:8080/init`，完成 3 屏向导（详见[下文](#首次启动向导)）。

---

## Agent 部署

每台 DC 上都需要一份 agent。脚本支持**本地安装**和**远程批量安装**（通过 WinRM `Invoke-Command`）。

### 单机本地安装（在 DC 上执行）

```powershell
.\scripts\install-agent.ps1 `
  -ComputerName $env:COMPUTERNAME `
  -CenterUrl 'http://center-host:8080' `
  -AgentToken '<从 center appsettings.json 的 agentToken 字段复制>'
```

### 远程批量安装（在中心服务器执行）

```powershell
# 一次性安装到多台 DC
.\scripts\install-agent.ps1 `
  -ComputerName 'DC-BJ-01','DC-BJ-02','DC-SH-01' `
  -CenterUrl 'http://center:8080' `
  -AgentToken '<token>'
```

**安全提示：** AgentToken 通过 WinRM 明文传输。生产环境应使用 HTTPS WinRM 端点，或通过 Invoke-Command 的 `-ConfigurationName` + 证书认证。

### Agent 安装内容

| 项 | 路径 |
|---|---|
| Agent 服务 | `C:\addashboard\Agent\` |
| Node 脚本 | `C:\addashboard\Agent\agent.js` |
| PowerShell 采集脚本 | `C:\addashboard\Agent\scripts\collect-replication.ps1` |
| 离线队列 (SQLite WAL) | `C:\addashboard\Agent\queue.db` |
| 日志 | `C:\addashboard\Logs\ADReplicationAgent-{stdout,stderr}.log` |
| NSSM 服务名 | `ADReplicationAgent`（启动类型=自动，依赖 `DNS Client` + `Netlogon`） |

### 验证 Agent 已上线

```powershell
# 1. 服务是否在跑
Get-Service ADReplicationAgent

# 2. 最近一次心跳（从 center 视角）
Invoke-RestMethod http://center:8080/api/dashboard/agents -Headers @{Authorization="Bearer <jwt>"}
```

---

## 首次启动向导

首次启动（或任何时候没有 admin 用户时），center 服务以 **init 模式** 启动，并在 `http://<center>:8080/init` 提供 3 屏浏览器向导：

| 屏 | 内容 |
|---|---|
| 1 | 数据库连接：选 MySQL / SQL Server，填连接参数，"测试连接" 通过后下一步 |
| 2 | 管理员账户：admin 用户名 + 密码（≥8 字符） |
| 3 | 初始化：自动跑 schema + seed + admin 创建 + 写 `appsettings.json` + 写 init 标记 |

完成后 `/init` 自动跳转到 `/login`，用刚创建的 admin 登录即可。

**Init 模式触发条件**（任一）：
- `appsettings.json` 不存在
- 缺 `db.dialect` 字段
- DB 健康检查失败
- `sys_users` 中无 admin 角色用户

**Init 完成后会写入「完成标记」**：`<installPath>/.env` 文件中的 `ADDASHBOARD_INITIALIZED=1` 键（外加注册表 `HKLM\SOFTWARE\ADDashboard\Initialized`）。这层硬锁保证即使删除 admin 账户也不会自动触发向导，必须显式清除标记才能重跑。

---

## 服务管理

### 启动 / 停止 / 重启

```powershell
# Center
Start-Service ADDashboardCenter
Stop-Service ADDashboardCenter
Restart-Service ADDashboardCenter -Force

# Agent
Start-Service ADReplicationAgent
Stop-Service ADReplicationAgent
Restart-Service ADReplicationAgent -Force
```

### 查看状态

```powershell
# 看两服务
Get-Service ADReplicationAgent, ADDashboardCenter | Format-Table Name, Status, StartType

# NSSM 完整配置
nssm get ADDashboardCenter
```

### 跟踪日志

```powershell
Get-Content 'C:\addashboard\Logs\ADDashboardCenter-stdout.log' -Tail 100 -Wait
Get-Content 'C:\addashboard\Logs\ADReplicationAgent-stdout.log' -Tail 100 -Wait
```

### 健康探针

```powershell
Invoke-WebRequest http://center:8080/healthz
# 期望: { "status": "ok" } 或 { "status": "degraded", "error": "..." }
```

### 卸载

```powershell
# Center — 默认保留 appsettings.json 和 .env（如要彻底清，加 -RemoveData）
.\scripts\uninstall-center.ps1

# Agent
.\scripts\uninstall-agent.ps1
```

---

## 升级与回滚

### Center 升级

```powershell
cd ADDashboard
git pull
.\scripts\update-center.ps1 -RebuildFrontend
```

内部步骤：停服务 → 重 build 前端 → 覆盖拷贝 `center/` + `dist/` → `npm install --omit=dev` → 启服务。

### Agent 滚动升级（逐台）

```powershell
.\scripts\install-agent.ps1 -ComputerName 'DC-BJ-01' -CenterUrl 'http://center:8080' -AgentToken '<token>'
# 验证健康后再升级下一台
.\scripts\install-agent.ps1 -ComputerName 'DC-BJ-02' -CenterUrl 'http://center:8080' -AgentToken '<token>'
```

脚本内部走 `Stop-Service → 覆盖文件 → Start-Service`，不会丢离线队列中的未上传数据。

### 回滚

center 没有内置版本管理。最简单的回滚方式是：
1. `git checkout <previous-tag>` 在部署目录
2. 重新跑 `update-center.ps1`

---

## 自定义端口健康检查（migration 003）

此特性让管理员维护一份「待探测 TCP 端口」清单（如 RPC `135`、AD Web Services `9389`、自定义 `50001-50003`），每台 Agent 拉取该清单、对本机做 TCP 连通性探测，并把结果随心跳上报；Center 在 **Agents 视图** 用彩色徽章展示每个端口的最新状态。

数据落在两张新表：`system_ports`（管理员维护的端口清单）与 `ad_agent_port_status`（每 Agent × 每端口的最新探测结果）。二者由 **migration 003** 引入。

### 全新部署：无需额外操作

首次启动向导的 schema 应用器（`center/src/init/schema-applier.js` 的 `applyAll`）在跑完 `01-tables.sql` + `02-seed-roles.sql` 后，会**按文件名顺序自动应用 `db/migrations/` 下的全部迁移**（001 → 002 → 003）。所以走 [首次启动向导](#首次启动向导) 的全新库会自动建好这两张表，**不用手动跑任何 SQL**。

### 存量升级：手动应用 migration 003

已初始化的部署被 init 完成标记（`.env` 的 `ADDASHBOARD_INITIALIZED=1` + 注册表）硬锁在向导之外，`update-center.ps1` **只更新代码、不碰数据库**。因此升级到含本特性的版本后，必须对现有库手动应用一次 migration 003。两份迁移都是幂等的（`CREATE TABLE IF NOT EXISTS` / `IF OBJECT_ID(...) IS NULL`），重复执行安全。

**MySQL：**

```powershell
# 用库里的账户执行；<db> 为 appsettings.json 里配置的库名
Get-Content .\db\migrations\003-port-healthcheck.sql -Raw | mysql -u <user> -p <db>
```

**SQL Server：**

```powershell
sqlcmd -S <server> -d <db> -U <user> -P <pass> -i .\db\migrations\mssql\003-port-healthcheck.sql
```

应用后 `Restart-Service ADDashboardCenter`（新增端点/服务需要重载代码，若升级步骤已重启则可跳过）。

### 升级到 v2.0+（包系统 / 插件系统）

v2.0 起引入包管理（plugin system）：管理员可上传/启用/升级/卸载「包」，每个包按其 `manifest.type`（`gauge` / `counter` / `timeseries` / `status`）写入对应的 `metric_*` 表，并在 **指标看板**（`/dashboard/metrics`）展示。

数据落在六张新表（`migration 004` 引入）：

| 表 | 用途 |
|---|---|
| `installed_packages` | 已安装包清单（manifest、版本、启用位、参数、来源） |
| `package_runs` | Agent 每轮执行包脚本的运行记录（成功/失败/耗时） |
| `metric_gauge` | 最新 gauge 值，按 `(agent_id, metric_id)` 唯一 |
| `metric_counter` | 最新累计计数器值 + delta，按 `(agent_id, metric_id)` 唯一 |
| `metric_status` | 最新健康状态（OK/WARN/CRIT/...），按 `(agent_id, metric_id)` 唯一 |
| `metric_timeseries` | append-only 时序点 |

#### 全新部署：无需额外操作

首次启动向导的 schema 应用器（`center/src/init/schema-applier.js` 的 `applyAll`）按文件名顺序自动应用 `db/migrations/` 下的全部迁移（001 → 002 → 003 → 004）。走 [首次启动向导](#首次启动向导) 的全新库会自动建好这六张表，**不用手动跑任何 SQL**。

#### 存量升级：手动应用 migration 004

`update-center.ps1` **只更新代码、不碰数据库**。升级到含包系统的版本后，必须对现有库手动应用一次 migration 004。两份迁移都是幂等的（`CREATE TABLE IF NOT EXISTS` / `IF OBJECT_ID(...) IS NULL`），重复执行安全。

**MySQL：**

```powershell
# 用库里的账户执行；<db> 为 appsettings.json 里配置的库名
Get-Content .\db\migrations\004-package-system.sql -Raw | mysql -u <user> -p <db>
```

**SQL Server：**

```powershell
sqlcmd -S <server> -d <db> -U <user> -P <pass> -i .\db\migrations\mssql\004-package-system.sql
```

应用后 `Restart-Service ADDashboardCenter`（新增端点/服务需要重载代码，若升级步骤已重启则可跳过）。

#### 新增的 UI 入口

| 路径 | 权限 | 作用 |
|---|---|---|
| `/admin/packages` | `admin:packages` | 包管理：上传/启用/卸载/升级 |
| `/admin/packages/registry` | `admin:packages` | 从 Registry 导入包 |
| `/admin/packages/:name` | `admin:packages` | 单包参数编辑 |
| `/dashboard/metrics` | 默认登录 | 指标看板：按包查看 gauge/counter/timeseries/status |

Agent 侧**零配置**：每个 Agent 在跑包脚本后，会把收集到的指标随心跳一起上报，Center 自动按 `manifest.type` 落到对应表。

### 配置要探测的端口（管理员 UI）

以 admin 身份登录后打开 **`http://<center>:8080/admin/ports`**（该路由要求 `admin:users` 权限），在此增删改端口清单：

| 字段 | 说明 |
|---|---|
| `port` | 1-65535 的 TCP 端口号；全表唯一（重复端口返回 409） |
| `label` | 展示名（如 `RPC Endpoint Mapper`） |
| `sort_order` | 徽章展示排序，小的在前 |

底层 REST：`GET/POST /api/admin/ports`、`PUT/DELETE /api/admin/ports/:id`。

### Agent 侧：零配置

Agent **无需任何额外配置**。每个心跳周期（`heartbeatIntervalSeconds`，默认 5s）Agent 会：

1. 拉取 `GET /api/agent/ports` 获取当前端口清单（拉取失败时静默降级为空清单，不影响心跳）；
2. 对每个端口做并行 TCP 探测（2s 超时）；
3. 把 `ports:[{port, ok, latencyMs}]` 附在心跳里上报。

心跳负载对端口字段**向后兼容**：旧版 Agent（不带 `ports`）照常工作，Center 端不会因缺字段报错。清单为空时 Agent 不上报端口结果。

### 结果展示

Agents 视图每行按端口显示徽章，颜色反映最近一次探测的往返延迟：

| 徽章 | 含义 |
|---|---|
| 绿 | `ok=true` 且 `latencyMs < 100` |
| 黄 | `ok=true` 且 `100 ≤ latencyMs < 500` |
| 红 | `ok=false`（不可达）或 `latencyMs ≥ 500` |
| 灰 `–` | 该端口暂无探测数据（Agent 尚未上报） |

Center 在拼装 `GET /api/dashboard/agents` 的 `portStatuses` 时，只保留仍在 `system_ports` 清单中的端口——管理员删除某端口后，其历史探测行会在展示层被自动隐藏。

---

## 本地 production preview（无服务）

**调试 / 演示场景**：不想安装 Windows 服务，但要在本地跑出和 production 一模一样的形态。

```bash
npm install      # 首次需要
npm start
```

`scripts/start-prod.js` 自动完成：

1. `frontend/dist/index.html` 不存在 → 跑 `npm run build:frontend`
2. 镜像 `frontend/dist/` → `center/dist/`
3. spawn `node center/server.js`，cwd=`center/`，监听 `:8080`

浏览器打开 `http://localhost:8080/init` 即可首次初始化，或 `http://localhost:8080/login` 登录。

**和真正部署的唯一区别**：没有 NSSM 包装，进程绑在前台 shell 上，关掉 shell 就停了。生产路径以 `install-center.ps1` 为准。

---

## Green Bundle（publish/）的默认行为变更

`publish/` 目录下的便携绿色版（zip 解压即用）入口 `start.bat` / `start.ps1` **已从「前台跑 node」改为「默认安装并启动 ADDashboardCenter Windows 服务」**。

行为对比：

| 入口 | 旧默认 | 新默认 | 开发模式开关 |
|---|---|---|---|
| `start.bat` | 前台跑 `node server.js`（开发态） | 注册并启动 `ADDashboardCenter` 服务（幂等） | `--console` / `-c` |
| `start.ps1` | （无） | 同上，PowerShell 镜像 | `-Console` |

新默认下，`start.bat` / `start.ps1` 会以 **管理员身份** 调用 `scripts/install-center.ps1 -InPlace`：

- `InstallPath` 覆盖为 `<publish 根>\center`（**不拷贝**到 `C:\addashboard\Center`，与生产路径隔离）。
- `node_modules` 与 `frontend/dist/` 缺失时会自动补齐。
- NSSM 注册的服务名仍是 `ADDashboardCenter`，启动类型 = 自动。
- 日志落到 `C:\addashboard\Logs\ADDashboardCenter-{stdout,stderr}.log`（10MB 滚动）。
- `appsettings.json` 与 `.env` 初始化标记仍按 init 向导逻辑写入 `<InstallPath>` 下。

适用与限制：

- **必须以管理员身份运行** `start.bat` / `start.ps1`（默认模式），否则立即报错并退出。改用 `--console` / `-Console` 无需管理员。
- 同一台机器上 `publish/center` 路径下的服务实例与 `C:\addashboard\Center` 下的生产实例 **共享服务名 `ADDashboardCenter`**，二者不能同时跑 —— 绿色版适合作为「试用 + 排错」入口，生产部署仍走仓库根 `scripts/install-center.ps1`（无 `-InPlace`）。
- 想看完整的服务管理 / 卸载 / 日志路径说明见 [`publish/README.md`](../../publish/README.md)。

---

## 故障排查

| 症状 | 排查起点 |
|---|---|
| `Center 启动失败，状态 Stopped` | `Get-Content C:\addashboard\Logs\ADDashboardCenter-stderr.log -Tail 100` |
| `Agent 反复重启 (StartPending → Stopped)` | `Get-EventLog Application -Source NSSM -Newest 20`；日志同上 |
| `Agent 心跳正常但无数据` | 验证 `Test-NetConnection center -Port 8080`；检查 DC 上 appsettings.json 的 `agentToken` 是否与 center 的 `system_config.ad_agent_token` 一致 |
| `前端 502 Bad Gateway` | center 进程退出，查 stderr log；常见 OOM（`Get-Process | Sort WorkingSet` 查 top 5） |
| `install-center.ps1 报 'nssm.exe not found'` | 检查 `<repo>/publish/nssm/nssm.exe` 是否存在（被 .gitignore 排除的情况：需 `git checkout HEAD -- publish/` 或手动 `Ensure-Nssm.ps1`） |
| `首次启动没出现 /init` | 检查 `.env` 是否已被错误写入 `ADDASHBOARD_INITIALIZED=1`；清掉后重启 |

更多故障模式参见 [`troubleshooting.md`](troubleshooting.md)。

---

## 附录：完整文件清单

**仓库内 release artifact（随 git 提交）：**

```
ADDashboard/                     # 仓库根
├── publish\
│   └── nssm\
│       └── nssm.exe             # NSSM 2.24（约 324 KB），发布时捆绑，install 时优先用
├── scripts\
│   ├── install-center.ps1       # Center 部署入口
│   ├── install-agent.ps1        # Agent 部署入口（支持远程批量）
│   ├── update-*.ps1             # 升级脚本
│   ├── uninstall-*.ps1          # 卸载脚本
│   └── common\
│       ├── Logger.psm1
│       ├── NSSM.psm1            # Get-NssmPath 候选：publish/nssm/ > nssm/ > C:\Tools\nssm
│       └── Ensure-Nssm.ps1      # 仅在 publish/nssm/nssm.exe 缺失时下载回填
├── center\                      # center 源码（installer 拷贝到 InstallPath）
├── agent\                       # agent 源码（installer 拷贝到 InstallPath）
└── frontend\                    # Vue 3 前端源码（installer build 后拷贝到 InstallPath\dist）
```

**目标机器上的安装产物（`C:\addashboard\`）：**

```
C:\addashboard\
├── Center\
│   ├── server.js              # Express 入口
│   ├── package.json
│   ├── appsettings.json       # 由 /init 向导写入（含 db、jwtSecret、agentToken）
│   ├── .env                   # init 完成标记（ADDASHBOARD_INITIALIZED=1）
│   ├── node_modules\
│   └── dist\                  # 前端构建产物
├── Agent\                      # 仅 DC 上存在
│   ├── agent.js
│   ├── appsettings.json
│   ├── queue.db
│   ├── node_modules\
│   └── scripts\collect-replication.ps1
└── Logs\
    ├── ADDashboardCenter-stdout.log
    ├── ADDashboardCenter-stderr.log
    ├── ADReplicationAgent-stdout.log
    └── ADReplicationAgent-stderr.log
```

## WPF Package Designer — Metric-Centric Redesign

The Package Designer is now metric-centric. The 3-tab editor (form / SQL / PS1)
has been replaced by a single editor that picks metrics from a 5-entry catalog
and auto-generates `manifest.json`, `migrations/001_initial.sql`, and
`collect.ps1`.

**Build:** `dotnet publish PackageDesigner.csproj -c Release -r win-x64 --self-contained`
**Output:** `bin/PackageDesigner/publish/PackageDesigner.exe`
**Status:** Smoke deferred to Windows 11 VM (per plan's "Out-of-band" note); see `docs/superpowers/reports/2026-08-13-wpf-redesign-smoke.md`.