# AD 复制健康看板（AD Replication Dashboard）

自研的 AD 复制健康看板，用于跨站点、跨 DC 监控 Active Directory 复制状态。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/fogyisland/ADDashboard/actions/workflows/ci.yml/badge.svg)](https://github.com/fogyisland/ADDashboard/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/Node-18%2B-339933?logo=node.js&logoColor=white)
![PowerShell](https://img.shields.io/badge/PowerShell-5.1%2B-5391FE?logo=powershell&logoColor=white)

## 克隆

```bash
git clone https://github.com/fogyisland/ADDashboard.git
cd ADDashboard
npm install
```

## 架构

- **Agent**（每台 DC 一份）：Windows 服务，按计划运行 PowerShell 采集脚本，把结果 POST 给 Center。
- **Center**（单点）：Windows 服务，对外提供 API + 静态前端（Vue 3 + ECharts）。
- **存储**：MySQL 8+ 或 SQL Server 2014+（部署时二选一）。
- **服务管理**：NSSM。

完整设计参见 [docs/superpowers/specs/2026-07-10-ad-dashboard-service-design.md](docs/superpowers/specs/2026-07-10-ad-dashboard-service-design.md)。

## 环境依赖

- **Node.js 18+** — center 服务是 Node 实现；agent 也使用 Node 脚本
- **NSSM** — 已捆绑在 `publish/nssm/nssm.exe`，无需额外下载
- **MySQL 5.7+** 或 **SQL Server 2014+**（部署时二选一）
- **PowerShell 5.1+**

## 快速开始

```powershell
# 1. 部署（PowerShell installer — 首次运行会自动下载 NSSM 到 .\nssm\）
.\scripts\install-center.ps1

# 2. 浏览器打开 http://localhost:8080/init
#    完成 3 屏设置向导：
#    - 数据库连接（MySQL 或 SQL Server）
#    - 管理员账户
#    - 初始化 schema + seed + 写入 init 完成标记

# 3. 在 http://localhost:8080/login 用刚创建的 admin 账号登录
```

**默认安装路径：**

| 服务 | 路径 | 日志 |
|---|---|---|
| Center | `C:\addashboard\Center\` | `C:\addashboard\Logs\ADDashboardCenter-*.log` |
| Agent | `C:\addashboard\Agent\`（每台 DC） | `C:\addashboard\Logs\ADReplicationAgent-*.log` |

如需改路径，直接传参：`.\scripts\install-center.ps1 -InstallPath 'D:\apps\center'`

详细参见 [docs/operations/runbook.md](docs/operations/runbook.md#首次启动设置向导-first-run-setup-wizard)。

## 二次开发

```bash
npm install
npm test
npm run build:frontend
```

## 运维文档

- 部署指南：[docs/operations/deployment.md](docs/operations/deployment.md) — 从「拿到新机器」到「浏览器可用」的全流程
- Runbook：[docs/operations/runbook.md](docs/operations/runbook.md) — 日常运维与灾难恢复
- Troubleshooting：[docs/operations/troubleshooting.md](docs/operations/troubleshooting.md)
- 首次启动设置向导：center 服务在无 admin 时会在 `/init` 提供向导。参见 [deployment](docs/operations/deployment.md#首次启动向导)。

## 多数据库后端

`center` 服务同时支持 **MySQL 5.7+** 和 **SQL Server 2014+**。在 `appsettings.json` 中通过 `db.dialect` 指定 dialect；同一份代码既可跑 MySQL 也可跑 SQL Server，部署时选定后运行期不切换。

详见 [docs/operations/runbook.md](docs/operations/runbook.md#多数据库支持)。