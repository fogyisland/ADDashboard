# AD Dashboard 部署指南

> 适用版本：**v1.0.0+**。本文档是从「拿到一台新机器」到「dashboard 在浏览器可用」的完整流程；日常运维与灾难恢复参见 [`runbook.md`](runbook.md)。
>
> **路径约定**：本文示例用 `$DashboardRoot` 占位 dashboard 安装根目录。脚本默认 install 路径是脚本相对的 `<publish-root>/Center` 和 `<publish-root>/Agent`（可解压到任意位置运行）；若你想装到其他位置（典型如 `D:\dashboard`），复制命令前先 `Set-Variable DashboardRoot 'D:\dashboard'`，所有示例的 `$DashboardRoot` 即解析为该路径。

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
4. 拷贝 `center/` + `frontend/dist/` → `$DashboardRoot\Center\`
5. `npm install --omit=dev` 安装 center 的运行时依赖
6. 用 NSSM 注册 `ADDashboardCenter` 服务（启动类型=自动）
7. 启动服务
8. 探测 `http://localhost:8080/api/init/status`

**默认安装路径：**

| 项 | 路径 |
|---|---|
| Center | `$DashboardRoot\Center\` |
| 日志 | `$DashboardRoot\Logs\ADDashboardCenter-{stdout,stderr}.log` |

### 自定义路径

```powershell
.\scripts\install-center.ps1 -InstallPath 'D:\apps\addashboard\Center' -ListenPort 9090
```

所有可调参数：

| 参数 | 默认值 | 说明 |
|---|---|---|
| `-InstallPath` | `$DashboardRoot\Center` | 安装根目录 |
| `-ListenPort` | `8080` | HTTP 监听端口 |
| `-AgentToken` | 自动生成 UUID | center 与 agent 共享的鉴权 token（首次随机生成后保留在同一目录的 appsettings 中） |
| `-JwtSecret` | 自动生成 64 字符 | JWT 签名密钥 |

### 部署后必须做

浏览器打开 `http://<center>:8080/init`，完成 3 屏向导（详见[下文](#首次启动向导)）。

---

## Agent 部署

每台 DC 上都需要一份 agent。脚本支持**本地安装**和**远程批量安装**（通过 WinRM `Invoke-Command`）。

### Agent MSI 安装（推荐）

自 v2.1 起，MSI 是 AD Dashboard Agent 的**首选**安装路径。MSI 自包含 Node.js 20 LTS、node_modules、NSSM，**装机时零网络访问**。服务以 LocalSystem 身份运行（与 `install-agent.ps1` 一致，不可配置）。

#### 双击安装（GUI）

1. 把 `addashboard-agent-x64-<version>.msi` 拷到目标机（DC 或成员服务器）
2. 双击，按向导填：
   - **Agent 类型**：ad（域控）或 non-ad（成员服务器）
   - **CenterUrl + AgentToken**：从中心的 `appsettings.json` `agentToken` 字段复制
   - **安装路径**：默认 `$DashboardRoot\Agent`
3. Finish — 服务 `ADReplicationAgent` 自动启动

#### 静默安装（SCCM / Ansible / 命令行）

```powershell
msiexec /i addashboard-agent-x64-1.0.0.0.msi /qn /l*v "$env:TEMP\agent-install.log" `
  CENTERURL="http://center:8081" `
  AGENTTOKEN="456fb..." `
  AGENTTYPE="ad"
```

可加 `INSTALLDIR="D:\addashboard\Agent"` 改安装路径。

退出码：
- `0` = 成功
- `1603` = 属性校验失败（看 `$env:TEMP\agent-install.log`）

#### 升级

跑新版 MSI 即可，旧版自动卸载并升级（MajorUpgrade）。默认 `PRESERVE_APPSETTINGS=0`，会用本次安装时传的 `CENTERURL` / `AGENTTOKEN` **覆盖** `appsettings.json`；如需保留旧配置请传 `PRESERVE_APPSETTINGS=1`。

#### 卸载

```powershell
msiexec /x addashboard-agent-x64-1.0.0.0.msi /qn
```

服务自动注销。`appsettings.json`（安装时由自定义动作生成，不在 MSI File 表中）和 `queue.db`（运行时 SQLite）不会被 MSI 自动删除；如需彻底清理请手动 `Remove-Item -Recurse $InstallDir`。

#### 与 WinRM 推送的关系

MSI 是**本地**装（双击或 msiexec）。要批量推到多台 DC/member 仍用 `.\scripts\install-agent.ps1 -ComputerName ...`（走 WinRM）。两条路径产生**同名服务 `ADReplicationAgent` + 同 NSSM 配置**，可任意切换。

#### 验证

- `Get-Service ADReplicationAgent` 状态应为 Running
- `Get-Content $DashboardRoot\Logs\ADReplicationAgent-stdout.log -Tail 50` 看启动日志
- 中心侧：登录 → Agents 视图，新装机器 30 秒内应出现

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
| Agent 服务 | `$DashboardRoot\Agent\` |
| Node 脚本 | `$DashboardRoot\Agent\agent.js` |
| PowerShell 采集脚本 | `$DashboardRoot\Agent\scripts\collect-replication.ps1` |
| 离线队列 (SQLite WAL) | `$DashboardRoot\Agent\queue.db` |
| 日志 | `$DashboardRoot\Logs\ADReplicationAgent-{stdout,stderr}.log` |
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
Get-Content '$DashboardRoot\Logs\ADDashboardCenter-stdout.log' -Tail 100 -Wait
Get-Content '$DashboardRoot\Logs\ADReplicationAgent-stdout.log' -Tail 100 -Wait
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

### Center 升级（一条命令：`start.ps1`）

**无论是首次安装还是后续升级，operator 只跑同一个脚本：**

```powershell
# 在 center 管理服务器上，以管理员身份打开 PowerShell
cd C:\Repos\ADDashboard          # 或 green bundle 的 publish\ 根目录
git pull                          # 或解压新版 zip 覆盖
.\start.ps1                       # ← 这一个脚本搞定一切
```

`start.ps1` 是**单一入口**（install-or-update 二合一）：
- service 未注册 → 若 `center/web/` 源码存在，按 `package.json` 中可用的 build 脚本（`build` / `build:web` / `build:frontend`）重新生成 dist，然后调用 `install-center.ps1 -InPlace` 完成首次安装 + 启动。
- service 已注册 → 同上重建 dist，然后优先 `POST /api/system/update`（应用 pending migration + `process.exit(0)`），不可达则 `Restart-Service`（启动 bootstrap 自动跑 pending migration）。
- service 已注册 → 内部按以下顺序尝试升级：
  1. **首选**：`POST http://localhost:8080/api/system/update`（localhost-only，no-auth；端点内部跑 `service.upgrade()` 应用 pending migration + 写审计 + `process.exit(0)`；NSSM 用新代码拉起）。
  2. **降级**：API 不可达（首次部署 `/api/system/update` 端点本身，或回滚）→ `Restart-Service -Force`。新代码加载后，**启动 bootstrap 自带的 `service.upgrade()`** 会自动应用 pending migration，所以此降级路径**安全**。

**约定**：
- `start.ps1` 是 install 和 update 的**唯一**入口。operator 不再需要单独调 `Invoke-RestMethod -Method Post ...` 或 `Restart-Service`。
- `/api/system/update` 端点保留为**内部实现**：start.ps1 调用它；远程调用返回 `403 {"error":"localhost-only"}`。远程升级需要 RDP/SSH 进主机后跑 `start.ps1`。
- 升级期间（约 1-3 秒）`/api/*` 与 `/healthz` 短暂不可用；NSSM 默认 `Restart` 重试策略会自动拉起新进程。

**端点契约**（供运维了解 start.ps1 内部行为）：

`POST /api/system/update` → 200：

```json
{
  "ok": true,
  "message": "升级完成: 0 migration 应用, seed unchanged",
  "restarted": true,
  "migrationsApplied": [],
  "migrationsFailed": [],
  "seed": { "ran": false, "reason": "unchanged" }
}
```

服务端会：
1. 按顺序应用 `db/migrations/` 下所有尚未运行的迁移（幂等，复用现有 `service.upgrade()` 路径）
2. 写入 `system_update` 审计行（含客户端 IP）
3. 500ms 后 `process.exit(0)` —— NSSM 看到进程退出后自动用新代码拉起

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
2. `Invoke-RestMethod -Method Post -Uri http://localhost:8080/api/system/update`（自动跑可能需要的降级迁移——若升级路径新增过 migration，降级一般需要手动 reverse；新 API 不会自动 reverse）

---

## 自定义端口健康检查（migration 003）

此特性让管理员维护一份「待探测 TCP 端口」清单（如 RPC `135`、AD Web Services `9389`、自定义 `50001-50003`），每台 Agent 拉取该清单、对本机做 TCP 连通性探测，并把结果随心跳上报；Center 在 **Agents 视图** 用彩色徽章展示每个端口的最新状态。

数据落在两张新表：`system_ports`（管理员维护的端口清单）与 `ad_agent_port_status`（每 Agent × 每端口的最新探测结果）。二者由 **migration 003** 引入。

### 全新部署：无需额外操作

首次启动向导的 schema 应用器（`center/src/init/schema-applier.js` 的 `applyAll`）在跑完 `01-tables.sql` + `02-seed-roles.sql` 后，会**按文件名顺序自动应用 `db/migrations/` 下的全部迁移**（001 → 002 → 003）。所以走 [首次启动向导](#首次启动向导) 的全新库会自动建好这两张表，**不用手动跑任何 SQL**。

### 存量升级：调用 `/api/system/update`

迁移随升级 API **自动应用**，无需手动执行 SQL。详见 [§7 Center 升级](#center-升级api-触发推荐)。旧文档中提到的 `mysql ... < 003-*.sql` / `sqlcmd -i 003-*.sql` 步骤已被该 API 取代。

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

#### 存量升级：调用 `/api/system/update`

同 §7，新版 API 自动应用所有 pending migration，**无需手动跑 SQL**。`migration 004-013` 均在此路径下被自动消费。

#### Migration 013+ 后续迁移

Migration 014+（alert_metrics、outbox、orphan_schemas 等）均为 `CREATE TABLE IF NOT EXISTS` 风格的幂等 DDL，已初始化的部署在下次调 `/api/system/update` 时自动应用。**不再需要手动执行 SQL**。

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

`publish/` 目录下的便携绿色版（zip 解压即用）入口 `start.bat` / `start.ps1` **已从「前台跑 node」改为「默认安装并启动 ADDashboardCenter Windows 服务」**，并与生产路径共用同一个 **`start.ps1` 单入口**（install-or-update 二合一）。

行为对比：

| 入口 | 默认行为 | 开发模式开关 |
|---|---|---|
| `start.bat` / `start.ps1` | 自动判定 install 还是 update：service 未注册 → 若 `center/web/` 源码存在则按 `package.json` 中可用的 build 脚本（`build` / `build:web` / `build:frontend`）重新生成 dist + `install-center.ps1 -InPlace`（注册 NSSM service）；service 已注册 → 同上重建 dist + 优先 `POST /api/system/update`，不可达则 `Restart-Service`（启动 bootstrap 自动跑 pending migration） | `--console` / `-Console`（前台跑 `node server.js`） |

`install-center.ps1 -InPlace` 的关键行为：

- `InstallPath` 覆盖为 `<publish 根>\center`（**不拷贝**到 `$DashboardRoot\Center`，与生产路径隔离）。
- `node_modules` 与 `frontend/dist/` 缺失时会自动补齐；hash 变化时也会自动重装。
- NSSM 注册的服务名仍是 `ADDashboardCenter`，启动类型 = 自动，启动失败有 recovery 重试。
- 日志落到 `<publish 根>\center\Logs\ADDashboardCenter-{stdout,stderr}.log`（10MB 滚动）。
- `appsettings.json` 与 `.env` 初始化标记仍按 init 向导逻辑写入 `<InstallPath>` 下。

### Green Bundle 的更新流程（operator 只跑 start.ps1）

```powershell
# 1. 解压新版本 zip 覆盖到当前 <publish 根>（或 git pull）
# 2. 在主机上跑（与生产路径完全一致的命令）
.\start.ps1
```

`start.ps1` 内部会自动尝试 `POST /api/system/update`，不可达时 `Restart-Service`。新代码加载后，启动 bootstrap 自带的 `service.upgrade()` 会自动应用 pending migration。

### 适用与限制

- **首次安装**必须以 **管理员身份** 运行 `start.bat` / `start.ps1`（默认模式），否则立即报错并退出。改用 `--console` / `-Console` 无需管理员。
- 同一台机器上 `publish/center` 路径下的服务实例与 `$DashboardRoot\Center` 下的生产实例 **共享服务名 `ADDashboardCenter`**，二者不能同时跑 —— 绿色版适合作为「试用 + 排错」入口，生产部署仍走仓库根 `scripts/install-center.ps1`（无 `-InPlace`）。
- 想看完整的服务管理 / 卸载 / 日志路径说明见 [`publish/README.md`](../../publish/README.md)。

---

## 故障排查

| 症状 | 排查起点 |
|---|---|
| `Center 启动失败，状态 Stopped` | `Get-Content $DashboardRoot\Logs\ADDashboardCenter-stderr.log -Tail 100` |
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

**目标机器上的安装产物（`$DashboardRoot\`）：**

```
$DashboardRoot\
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