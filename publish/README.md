# AD Replication Dashboard — Green Version

这是 **便携绿色版**（portable / extract-and-run）：解压后双击 `start.bat` 即可在本地启动完整的 center + 前端，**无需安装 Windows 服务**。

适合：演示、试用、本地排错、不想动 `C:\addashboard\` 的场景。

生产部署（Windows 服务 + 跨 DC 批量安装 Agent）请看 [`scripts/README.md`](scripts/README.md) 或仓库根目录的 [`docs/operations/deployment.md`](../docs/operations/deployment.md)。

---

## 快速开始

```powershell
# 在 publish/ 目录下：
.\start.bat
```

首次运行会自动：

1. 安装 `publish/center/` 和 `publish/frontend/` 的运行时依赖
2. 构建前端 → 镜像到 `publish/center/dist/`
3. 启动 center，监听 `http://localhost:8080`

浏览器打开 **<http://localhost:8080/init>** 完成 3 屏初始化向导：

| 屏 | 内容 |
|---|---|
| 1 | 数据库连接：选 MySQL 或 SQL Server，填参数，测试通过后下一步 |
| 2 | 管理员账户：admin 用户名 + 密码（≥8 字符） |
| 3 | 自动跑 schema + seed + 创建 admin + 写 `appsettings.json` + 写初始化标记 |

完成后自动跳转到 **<http://localhost:8080/login>**，用刚创建的 admin 登录即可。

按 **Ctrl+C** 关闭服务。

---

## 环境依赖

| 依赖 | 最低版本 | 说明 |
|---|---|---|
| Node.js | 18+（推荐 LTS 20/22） | center + 前端都是 Node 实现 |
| 数据库 | MySQL 5.7+ 或 SQL Server 2014+ | 部署时二选一，运行期不可切换 |
| 操作系统 | Windows 10 / Server 2016+ | `start.bat` 用 cmd 语法；其他平台用 `node start.js` |

**无需 NSSM** —— 本目录 `nssm/` 下的二进制仅在你想升级到 Windows 服务模式时才会用到。

---

## 目录结构

```
publish/                                  ← 解压后的根目录
├── start.bat                             ← 双击启动（cmd）
├── start.ps1                             ← PowerShell 启动
├── start.js                              ← 实际启动逻辑（Node.js）
├── README.md                             ← 本文件
├── center\                               ← center 源码 + appsettings.example.json
├── agent\                                ← agent 源码（生产 Agent 安装到 DC 上时用）
├── frontend\                             ← 前端源码（构建时使用）
├── nssm\nssm.exe                         ← NSSM 2.24（捆绑；服务模式时供 install-*.ps1 使用）
└── scripts\                              ← PowerShell 安装/升级/卸载脚本（服务模式）
    ├── install-center.ps1
    ├── install-agent.ps1
    ├── uninstall-center.ps1
    ├── uninstall-agent.ps1
    ├── update-center.ps1
    ├── update-agent.ps1
    └── common\
        ├── Logger.psm1
        ├── NSSM.psm1
        ├── Service.psm1
        └── Ensure-Nssm.ps1
```

---

## 数据落盘位置

绿色版启动后，所有数据写到 publish/ 同级目录（不污染 `C:\`）：

| 文件 | 位置 |
|---|---|
| `appsettings.json` | `publish\center\appsettings.json` |
| 初始化标记（`.env` + 注册表） | `publish\center\.env` + `HKCU\SOFTWARE\ADDashboard\Initialized` |
| center 日志 | 控制台 stdout（绿色版前台运行，无文件日志） |

若想重置：删除 `publish\center\appsettings.json` 和 `publish\center\.env`，重启服务，再次访问 `/init`。

---

## 升级到服务模式（可选）

绿色版跑通后，如果你想升级到 Windows 服务（开机自启 + 后台进程 + 文件日志）：

```powershell
# 以管理员身份运行 PowerShell
cd <publish 根目录>
.\scripts\install-center.ps1
# 默认安装到 C:\addashboard\Center\，服务名 ADDashboardCenter
```

之后每台 DC 上单独装 agent：

```powershell
.\scripts\install-agent.ps1 `
  -ComputerName $env:COMPUTERNAME `
  -CenterUrl 'http://center-host:8080' `
  -AgentToken '<从 C:\addashboard\Center\appsettings.json 的 agentToken 字段复制>'
```

完整的多机批量安装、升级、回滚、Troubleshooting 见 [`docs/operations/deployment.md`](../docs/operations/deployment.md)。

---

## 常见问题

**Q: `start.bat` 报 `node: command not found`？**
A: 安装 Node.js 18+ 并确保 `node` 在 PATH 中。装完新开一个 cmd 窗口再试。

**Q: 第一次启动很久，正常吗？**
A: 正常。首次需要 `npm install`（约 30-60 秒）和 `npm run build`（约 10-20 秒），完成后浏览器秒开。

**Q: 端口 8080 被占用？**
A: 编辑 `publish\center\appsettings.json`（首次跑过后才会生成），改 `listenPort`，重启服务。

**Q: 绿色版能跨机器用吗？**
A: center 可以跑在任何装了 Node 的机器上。但 agent 必须装在 DC 上才能采集 AD 复制数据。生产部署用 `scripts/install-*.ps1`。

**Q: 重新初始化？**
A: 删 `publish\center\appsettings.json` 和 `publish\center\.env`（如果存在），重启即可。