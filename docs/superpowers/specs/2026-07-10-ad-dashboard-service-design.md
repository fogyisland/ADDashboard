# AD Replication Dashboard - 服务化方案设计

> **创建日期：** 2026-07-10
> **状态：** 已通过用户审核，待进入实施计划
> **目标读者：** 实施工程师、运维 SRE、安全审计

---

## 1. 背景与目标

企业内部 Active Directory 拓扑跨多站点、多域控（DC），复制健康状况缺乏统一可视化手段。本项目目标是构建一套完全自研的 AD 复制 Dashboard：

- **数据采集** PowerShell 脚本在每台 DC 上定时运行
- **持久化** SQL Server 存储最新状态与历史快照
- **后端服务** Node.js 中心 API + Vue 3 前端（同进程托管）
- **部署形态** 全部组件以 Windows Service 方式运行，NSSM 包装
- **运维友好** 一键安装/升级脚本，标准 `Get-Service` / `Restart-Service` 操作

---

## 2. 核心设计决策

| 决策点 | 选定方案 | 备选 |
|--------|----------|------|
| 部署拓扑 | 单中心节点 + 分布式 Agent | 多中心 / 中心在 DC 本机 |
| Agent ↔ Center 通信 | Agent 主动 HTTP POST | WebSocket / Redis / 拉取 |
| 数据库 | SQL Server | MySQL / PostgreSQL / InfluxDB |
| 服务安装工具 | NSSM 封装 | node-windows / sc.exe / 自研 |
| 前端 | Vue 3 + Vite + ECharts 5 | React / Nuxt / 静态 jQuery |
| 认证 | 本地账号 + RBAC（JWT） | Windows 集成 / LDAP / 无认证 |

---

## 3. 整体架构

```
┌──────────────────────────────────────────────────────────────────┐
│  Active Directory 站点拓扑                                       │
│                                                                  │
│  [DC-BJ-01]    [DC-BJ-02]    [DC-SH-01]    [DC-SZ-01]            │
│      │              │              │              │               │
│  ┌───┴──────────────┴──┐    ┌──────┴───┐    ┌──────┴───┐           │
│  │ AD Agent 服务 (NSSM)│    │ AD Agent │    │ AD Agent │    ...   │
│  │ - 定时跑 PS 采集    │    │   服务   │    │   服务   │           │
│  │ - HTTP POST 上报    │    │          │    │          │           │
│  └──────────┬──────────┘    └────┬─────┘    └────┬─────┘           │
└─────────────┼────────────────────┼──────────────┼─────────────────┘
              │   HTTPS POST       │              │
              │   /api/agent/report│              │
              ▼                    ▼              ▼
      ┌───────────────────────────────────────────────────┐
      │  中心管理服务器（单节点）                          │
      │                                                   │
      │  ┌───────────────────────────────────────────┐   │
      │  │  AD Dashboard 服务 (NSSM)                 │   │
      │  │  - Node.js + Express API                  │   │
      │  │  - Vue 3 静态资源（Vite 构建产物）        │   │
      │  │  - 同进程托管 API + 静态文件              │   │
      │  │  - JWT 认证 + RBAC 中间件                 │   │
      │  └──────────────┬────────────────────────────┘   │
      │                 │                                 │
      │  ┌──────────────▼────────────────────────────┐   │
      │  │  SQL Server (AD_Monitoring 库)             │   │
      │  │  - ad_replication_status (复制快照)        │   │
      │  │  - ad_replication_history (历史)          │   │
      │  │  - ad_agent_heartbeat (Agent 心跳)         │   │
      │  │  - ad_sites / ad_dcs (拓扑元数据)         │   │
      │  │  - sys_users / sys_roles (RBAC)           │   │
      │  │  - system_config (阈值/轮询等配置)        │   │
      │  │  - audit_logs (审计日志)                   │   │
      │  └───────────────────────────────────────────┘   │
      └───────────────────────────────────────────────────┘
              ▲
              │   浏览器访问 http://center:8080
              │
      ┌───────┴────────┐
      │  运维人员浏览器 │
      └────────────────┘
```

**关键约束：**
- DC 端零入站端口：Agent 全部出站，中心机不需访问 DC 任何端口
- 中心机单一入站：仅 `8080`（API+前端）+ `1433`（SQL Server）
- Agent 故障隔离：单台 DC Agent 异常不影响其他 DC 数据上报

---

## 4. 组件职责

### 4.1 AD Agent 服务

| 项目 | 详细 |
|------|------|
| 服务名 | `ADReplicationAgent` |
| 运行账户 | 域账户 `svc-ad-agent@domain.local`（Domain Users 即可） |
| 采集周期 | 默认 15 分钟，中心可远程下发 |
| 安装目录 | `C:\Program Files\ADDashboard\Agent\` |
| 日志目录 | `C:\ProgramData\ADDashboard\Logs\` |
| NSSM 依赖 | `DNS Client`, `Netlogon` |
| 启动方式 | Automatic (Delayed Start) |

**职责：**
1. **数据采集** 调用 `collect-replication.ps1`，执行：
   ```powershell
   Get-ADReplicationPartnerMetadata -Target $env:COMPUTERNAME -Scope Domain
   Get-ADReplicationFailure -Target $env:COMPUTERNAME -Scope Domain
   Get-ADDomainController -Identity $env:COMPUTERNAME | Select Site
   ```
2. **数据上报** POST 到 `https://center:8080/api/agent/report`，Body 包含 `agentId`、`collectedAt`、`data[]`
3. **心跳上报** 每 60 秒 POST `/api/agent/heartbeat`，含 Agent 版本、采集次数、最后状态
4. **配置拉取** 每次心跳拉取中心最新配置（采集周期、阈值）
5. **本地缓存** 网络/中心不可达时暂存本地 SQLite 队列，恢复后批量补传
6. **健康自检** 启动时 + 每 10 分钟校验 AD 模块、域连通性、中心可达性

**PowerShell 采集脚本约束：**
- `try/catch` 包裹单条命令，单条失败不影响其他采集
- 时间统一 UTC，输出 ISO 8601 字符串
- 输出结构化 JSON 数组，便于 Node.js 解析
- 单次执行总时长控制在 60 秒内

### 4.2 AD Dashboard Center 服务

| 项目 | 详细 |
|------|------|
| 服务名 | `ADDashboardCenter` |
| 运行账户 | `LocalSystem` 或专用域账户 `svc-ad-dashboard` |
| 监听端口 | `8080`（可配） |
| 安装目录 | `C:\Program Files\ADDashboard\Center\` |
| 日志目录 | `C:\ProgramData\ADDashboard\Logs\` |
| NSSM 依赖 | `MSSQLSERVER` |
| 启动方式 | Automatic |

**职责：**
1. **API 服务** Express 路由，前缀 `/api/*`
2. **静态托管** `express.static` 托管 Vue 3 构建产物
3. **数据接收** `/api/agent/report` 与 `/api/agent/heartbeat`
4. **数据服务** `/api/dashboard/*` 给前端图表
5. **用户管理** `/api/admin/*` 给 RBAC 管理员
6. **审计日志** 所有写操作落入 `audit_logs` 表

---

## 5. 数据模型

### 5.1 核心表

```sql
-- 复制状态快照表（UPSERT 维护最新一条）
CREATE TABLE ad_replication_status (
  id              BIGINT IDENTITY PRIMARY KEY,
  collected_at    DATETIME2      NOT NULL,
  agent_id        NVARCHAR(64)   NOT NULL,  -- = DC 主机名
  source_dc       NVARCHAR(128)  NOT NULL,
  dest_dc         NVARCHAR(128)  NOT NULL,
  source_site     NVARCHAR(64),
  dest_site       NVARCHAR(64),
  naming_context  NVARCHAR(256)  NOT NULL,
  last_success_time DATETIME2,
  last_attempt_time DATETIME2,
  status_code     INT            NOT NULL DEFAULT 0,
  error_message   NVARCHAR(512),
  CONSTRAINT uq_repl UNIQUE (source_dc, dest_dc, naming_context)
);
CREATE INDEX ix_repl_collected ON ad_replication_status(collected_at);
CREATE INDEX ix_repl_dest ON ad_replication_status(dest_dc);

-- 历史流水（按需开启）
CREATE TABLE ad_replication_history (
  id              BIGINT IDENTITY PRIMARY KEY,
  collected_at    DATETIME2      NOT NULL,
  agent_id        NVARCHAR(64)   NOT NULL,
  source_dc       NVARCHAR(128)  NOT NULL,
  dest_dc         NVARCHAR(128)  NOT NULL,
  naming_context  NVARCHAR(256)  NOT NULL,
  last_success_time DATETIME2,
  status_code     INT            NOT NULL,
  error_message   NVARCHAR(512)
);
CREATE INDEX ix_hist_time ON ad_replication_history(collected_at);

-- Agent 心跳
CREATE TABLE ad_agent_heartbeat (
  agent_id            NVARCHAR(64) PRIMARY KEY,
  last_heartbeat_at   DATETIME2,
  agent_version       NVARCHAR(32),
  last_report_at      DATETIME2,
  last_report_status  NVARCHAR(32),
  pending_queue_size  INT DEFAULT 0
);

-- 站点元数据
CREATE TABLE ad_sites (
  site_id     INT IDENTITY PRIMARY KEY,
  site_name   NVARCHAR(64) UNIQUE NOT NULL,
  region_code NVARCHAR(32),
  is_hub      BIT DEFAULT 0
);

-- DC 元数据
CREATE TABLE ad_dcs (
  dc_name    NVARCHAR(128) PRIMARY KEY,
  site_id    INT FOREIGN KEY REFERENCES ad_sites(site_id),
  ip_address NVARCHAR(64),
  os_version NVARCHAR(64),
  is_pdc     BIT DEFAULT 0
);

-- 系统配置
CREATE TABLE system_config (
  config_key   NVARCHAR(64) PRIMARY KEY,
  config_value NVARCHAR(MAX),
  description  NVARCHAR(256),
  updated_at   DATETIME2 DEFAULT GETUTCDATE(),
  updated_by   NVARCHAR(64)
);

-- 用户
CREATE TABLE sys_users (
  id              INT IDENTITY PRIMARY KEY,
  username        NVARCHAR(64) UNIQUE NOT NULL,
  password_hash   NVARCHAR(256) NOT NULL,
  role_id         INT NOT NULL,
  status          BIT DEFAULT 1,
  last_login_at   DATETIME2,
  created_at      DATETIME2 DEFAULT GETUTCDATE()
);

-- 角色
CREATE TABLE sys_roles (
  id          INT IDENTITY PRIMARY KEY,
  role_name   NVARCHAR(64) UNIQUE NOT NULL,
  permissions NVARCHAR(MAX)  -- JSON 数组
);

-- 审计日志
CREATE TABLE audit_logs (
  id         BIGINT IDENTITY PRIMARY KEY,
  user_id    INT,
  action     NVARCHAR(64) NOT NULL,
  target     NVARCHAR(128),
  payload    NVARCHAR(MAX),
  created_at DATETIME2 DEFAULT GETUTCDATE()
);
CREATE INDEX ix_audit_time ON audit_logs(created_at);
```

### 5.2 关键 UPSERT 逻辑

`POST /api/agent/report` 接收后，按 `(source_dc, dest_dc, naming_context)` 做 MERGE：
- 存在 → 更新 `last_success_time`, `status_code`, `error_message`, `collected_at`
- 不存在 → 插入新行
- 历史同步写入 `ad_replication_history`（按 `system_config.history_enabled` 开关）

---

## 6. API 接口

### 6.1 Agent ↔ Center

| 方法 | 路径 | 鉴权 | 用途 |
|------|------|------|------|
| `POST` | `/api/agent/heartbeat` | X-Agent-Token | 60 秒一次心跳 |
| `POST` | `/api/agent/report` | X-Agent-Token | 上报采集数据 |
| `GET` | `/api/agent/config` | X-Agent-Token | 拉取最新配置 |

### 6.2 前端 ↔ Center

| 方法 | 路径 | 鉴权 | 用途 |
|------|------|------|------|
| `POST` | `/api/auth/login` | 无 | 登录获取 JWT |
| `GET` | `/api/dashboard/overview` | JWT | 顶部状态条 |
| `GET` | `/api/dashboard/site-matrix` | JWT | 站点矩阵（热力图） |
| `GET` | `/api/dashboard/topology` | JWT | 拓扑关系图 |
| `GET` | `/api/dashboard/errors` | JWT | 错误链路排行 |
| `GET` | `/api/dashboard/agents` | JWT | Agent 在线状态 |
| `GET/POST/PUT/DELETE` | `/api/admin/users` ... | JWT + Admin | 用户/角色/配置管理 |
| `GET` | `/healthz` | 无 | 健康检查 |

### 6.3 Agent Token 机制

- 中心生成 UUID 存 `system_config.ad_agent_token`
- 首次部署由 `install-agent.ps1` 写入 `appsettings.json`
- Agent 每次请求 Header `X-Agent-Token: <uuid>`
- Center 中间件校验失败返回 401

---

## 7. 服务安装

### 7.1 中心服务一键安装

```powershell
.\install-center.ps1 `
  -InstallPath "C:\Program Files\ADDashboard\Center" `
  -SqlServer "localhost" `
  -SqlDatabase "AD_Monitoring" `
  -ListenPort 8080 `
  -AgentToken (New-Guid).Guid
```

执行步骤：
1. 创建安装目录与日志目录
2. 复制 `server.js` + `package.json` + 前端 `dist/`
3. `Invoke-Sqlcmd` 执行 `schema/*.sql`
4. 写入 `appsettings.json`（SQL 连接串、Agent Token、端口）
5. `nssm.exe install ADDashboardCenter ...` 注册服务
6. `nssm set ADDashboardCenter DependOnService MSSQLSERVER`
7. `Start-Service ADDashboardCenter`
8. 校验端口监听 + 输出访问 URL + 初始管理员密码

### 7.2 Agent 批量安装

```powershell
# 远程批量（需 WinRM 启用）
Invoke-Command -ComputerName (Get-Content dc-list.txt) `
  -FilePath .\install-agent.ps1 `
  -ArgumentList "https://center:8080", "<agent-token>"
```

执行步骤：
1. 远程复制 Agent 文件
2. NSSM 注册 `ADReplicationAgent` 服务
3. 写入 `appsettings.json`（Center URL + Agent Token）
4. 启动服务
5. 30 秒后远程校验心跳到达

**批量推送工具**：Ansible / PDQ Deploy / GPO Startup Script 均可，PowerShell 原生 `Invoke-Command` 也能做。

### 7.3 NSSM 服务配置完整参数

| 参数 | Agent | Center |
|------|-------|--------|
| AppDirectory | `C:\Program Files\ADDashboard\Agent` | `C:\Program Files\ADDashboard\Center` |
| Application | `C:\Program Files\nodejs\node.exe` | `C:\Program Files\nodejs\node.exe` |
| AppParameters | `agent.js` | `server.js` |
| DisplayName | `AD Replication Agent (on <hostname>)` | `AD Replication Dashboard Center` |
| Start | `SERVICE_AUTO_START` | `SERVICE_AUTO_START` |
| DependOnService | `DNS Client`, `Netlogon` | `MSSQLSERVER` |
| AppStdout | `C:\ProgramData\ADDashboard\Logs\agent-stdout.log` | `C:\ProgramData\ADDashboard\Logs\center-stdout.log` |
| AppStderr | `C:\ProgramData\ADDashboard\Logs\agent-stderr.log` | `C:\ProgramData\ADDashboard\Logs\center-stderr.log` |
| AppRotateFiles | `1` | `1` |
| AppRotateOnline | `1` | `1` |
| AppRotateBytes | `10485760` (10MB) | `10485760` |
| AppEnvironmentExtra | `NODE_ENV=production` | `NODE_ENV=production` |

---

## 8. 日常运维

### 8.1 常用命令

```powershell
# 服务状态
Get-Service ADReplicationAgent, ADDashboardCenter |
  Format-Table Name, Status, StartType

# 启停
Restart-Service ADReplicationAgent -Force
Restart-Service ADDashboardCenter -Force

# 实时日志
Get-Content "C:\ProgramData\ADDashboard\Logs\agent-stdout.log" -Tail 200 -Wait

# 健康检查
Invoke-WebRequest -Uri "http://center:8080/healthz" |
  Select-Object -ExpandProperty Content
```

### 8.2 升级流程

| 步骤 | Agent | Center |
|------|-------|--------|
| 1. 备份 | 无（无状态） | 备份 `system_config` / `sys_users` 表 |
| 2. 停止 | `Stop-Service ADReplicationAgent` | `Stop-Service ADDashboardCenter`（短暂 30s） |
| 3. 替换 | 复制新文件到安装目录 | 替换 `server.js` + 前端 `dist/` |
| 4. 启动 | `Start-Service ADReplicationAgent` | `Start-Service ADDashboardCenter` |
| 5. 校验 | 心跳 60s 内恢复 | `/healthz` 返回 200 |

Agent 逐台滚动，Center 业务低峰期短停。未来扩展：Center 前置 IIS ARR + 多实例 → 0 停机。

### 8.3 健康自检

- **Agent 启动 + 每 10 分钟**：
  - `Get-Module ActiveDirectory` 可加载
  - `Resolve-DnsName domain.local` 成功
  - `Test-NetConnection center -Port 8080` 成功
  - 任一失败：告警日志 + 指数退避重试（30s → 60s → 120s → 上限 600s）
- **Center 启动**：
  - SQL Server 可达 + 表结构完整
  - `/healthz` 返回 `{db: "ok", agents: N, lastReport: "..."}`
  - `lastReport` 超过 2 个采集周期自动告警（未来对接企业微信 Webhook）

### 8.4 故障恢复对照

| 现象 | 排查 | 处置 |
|------|------|------|
| Agent 反复重启 | `Get-EventLog Application -Source NSSM -Newest 20` | 看 stderr 日志 |
| Agent 心跳正常但无数据 | 看 `agent-stderr.log` PowerShell 异常 | 检查 AD 模块 / 域账号权限 |
| Center 启动失败 | `nssm get ADDashboardCenter` | 常见 SQL 连接串错 / 端口占用 |
| 前端 502 | 看 center-stderr.log | Node.js 异常退出 / OOM |
| 数据长时间不更新 | `/api/dashboard/agents` 看在线数 | 防火墙 / Token 不匹配 / 路径含中文 |

### 8.5 备份策略

- **配置数据**（`system_config`、`sys_users`、`sys_roles`）：每日 SQL 备份，归档 30 天
- **历史快照**（`ad_replication_history`）：每周全量备份，保留 90 天
- **服务文件**：`server.js` / `collect-replication.ps1` / `install-*.ps1` 走 Git，部署版本可追溯

---

## 9. RBAC 角色

| 角色 | 权限（permissions JSON） | 可操作界面 |
|------|--------------------------|------------|
| `admin` | `["*"]` | 全部：用户、配置、审计 |
| `operator` | `["read:dash", "execute:sync"]` | 查看大屏、手动触发采集 |
| `viewer` | `["read:dash"]` | 仅查看 Dashboard |

初始安装时创建默认 `admin` 账号，密码随机生成并写入 `install-center.log`。

---

## 10. 未来扩展（YAGNI - 不在本次实施范围）

- Center 多实例 + 负载均衡（IIS ARR / Nginx）
- 告警通道：企业微信 / 钉钉 / 飞书 Webhook
- DNS 健康监控（独立子模块）
- AD 用户/组变更审计（独立子模块）
- 历史趋势图（基于 `ad_replication_history`）
- Agent 灰度发布（按站点分批）

---

## 11. 待确认事项

无。本次设计已经用户全四段确认通过。

---

**下一步：** 用户审核本文档 → 调用 `superpowers:writing-plans` 创建实施计划。
