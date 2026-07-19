# AD Replication Dashboard — Green Version

这是 **便携绿色版**（portable / extract-and-run）：解压后双击 `start.bat`（或 `start.ps1`）即可安装并启动 `ADDashboardCenter` Windows 服务，**默认即服务模式**（开机自启 + 后台进程 + 文件日志）。

适合：试用、本地排错、生产前快速验证。

开发模式（前台跑 `node server.js`，无服务包装）请加 `--console` / `-Console` 开关。

仅做前端调试 / 不动 `C:\addashboard\` 的轻量场景见本文末尾的 [附录：本地纯前端开发模式](#附录本地纯前端开发模式)。

---

## 快速开始（默认 = 服务模式）

```powershell
# 在 publish/ 目录下，以管理员身份运行：
.\start.bat
# 或 PowerShell：
.\start.ps1
```

脚本会幂等地完成：

1. 校验 Node.js 可达（首次会 `npm install` center 运行时依赖）
2. 确保 `frontend/dist/` 已构建 → 镜像到 `publish\center\dist\`
3. 用 NSSM 注册 `ADDashboardCenter` 服务（启动类型 = 自动）
4. 启动服务
5. 探测 `http://localhost:8080/api/init/status`

服务日志：`C:\addashboard\Logs\ADDashboardCenter-{stdout,stderr}.log`（10MB 自动滚动）。

首次运行后浏览器打开 **<http://localhost:8080/init>** 完成 3 屏初始化向导：

| 屏 | 内容 |
|---|---|
| 1 | 数据库连接：选 MySQL 或 SQL Server，填参数，测试通过后下一步 |
| 2 | 管理员账户：admin 用户名 + 密码（≥8 字符） |
| 3 | 自动跑 schema + seed + 创建 admin + 写 `appsettings.json` + 写初始化标记 |

向导 finalize 后，center 通过 `setImmediate` 干净退出（exit code 0），NSSM `AppExit=Default\Restart` + Windows Service Recovery 立即拉起新进程，前端轮询到状态由 `needsInit=true` 变为 `needsInit=false` 后跳到 **<http://localhost:8080/login>**，用刚创建的 admin 登录即可。

---

## 开关一览

| 入口 | 开关 | 行为 |
|---|---|---|
| `start.bat` | （默认） | 安装 + 启动 `ADDashboardCenter` 服务，然后退出 |
| `start.bat` | `--console` / `-c` | 前台跑 `node server.js`（开发模式，无服务） |
| `start.bat` | `--help` / `-h` | 打印帮助 |
| `start.ps1` | （默认） | 同上，PowerShell 镜像入口 |
| `start.ps1` | `-Console` | 前台跑 `node server.js` |
| `start.ps1` | `-Help` | 打印帮助 |

服务模式要求：

- **管理员权限**：注册 / 启动 Windows 服务必须提升。
- **PowerShell 5.1+**：`scripts\install-center.ps1` 走 PS 5.1 语法。
- **Node.js 18+** 已加入 PATH。

非管理员运行 `start.bat`（默认模式）会立即失败并提示；改用 `--console` 不需要管理员。

---

## 服务管理

服务名：`ADDashboardCenter`。

```powershell
# 启动 / 停止 / 重启
Start-Service ADDashboardCenter
Stop-Service ADDashboardCenter
Restart-Service ADDashboardCenter -Force

# 查看状态
Get-Service ADDashboardCenter

# NSSM 完整配置
nssm get ADDashboardCenter
```

### 跟踪日志

```powershell
# 实时 tail（10MB 自动滚动，多文件保留在同目录）
Get-Content 'C:\addashboard\Logs\ADDashboardCenter-stdout.log' -Tail 100 -Wait
Get-Content 'C:\addashboard\Logs\ADDashboardCenter-stderr.log' -Tail 100 -Wait
```

### 卸载

```powershell
# 默认保留 appsettings.json 和 .env（如要彻底清，加 -RemoveData）
.\scripts\uninstall-center.ps1

# 也可用 Windows 标准方式
Stop-Service ADDashboardCenter
sc.exe delete ADDashboardCenter
```

---

## 环境依赖

| 依赖 | 最低版本 | 说明 |
|---|---|---|
| Node.js | 18+（推荐 LTS 20/22） | center + 前端都是 Node 实现 |
| 数据库 | MySQL 5.7+ 或 SQL Server 2014+ | 部署时二选一，运行期不可切换 |
| 操作系统 | Windows 10 / Server 2016+ | `start.bat` 用 cmd 语法（其他平台请用 `node center/server.js` 前台模式，参见 [附录](#附录本地纯前端开发模式)） |
| PowerShell | 5.1+ | `scripts\install-center.ps1` 走 PS 5.1 语法 |

**NSSM 已捆绑**：本目录 `nssm/nssm.exe`（约 324 KB），服务模式默认使用此副本，**无需额外下载**。

---

## 目录结构

```
publish/                                  ← 解压后的根目录
├── start.bat                             ← 双击启动（默认 = 服务模式）
├── start.ps1                             ← PowerShell 启动（默认 = 服务模式）
├── README.md                             ← 本文件
├── center\                               ← center 源码 + appsettings.example.json
├── agent\                                ← agent 源码（生产 Agent 安装到 DC 上时用）
├── frontend\                             ← 前端源码（构建时使用）
├── nssm\nssm.exe                         ← NSSM 2.24（捆绑；服务模式默认使用）
└── scripts\                              ← PowerShell 安装/升级/卸载脚本
    ├── install-center.ps1
    ├── install-agent.ps1
    ├── uninstall-center.ps1
    ├── uninstall-agent.ps1
    ├── update-center.ps1
    ├── update-agent.ps1
    ├── smoke-test.ps1
    └── common\
        ├── Logger.psm1
        ├── NSSM.psm1
        ├── Service.psm1
        └── Ensure-Nssm.ps1
```

---

## 数据落盘位置

服务模式（默认）下：

| 文件 | 位置 |
|---|---|
| `appsettings.json` | `publish\center\appsettings.json` |
| 初始化标记（`.env` + 注册表） | `publish\center\.env` + `HKLM\SOFTWARE\ADDashboard\Initialized` |
| center 日志 | `C:\addashboard\Logs\ADDashboardCenter-{stdout,stderr}.log`（10MB 自动滚动） |

`--console` 前台模式（开发）下，所有数据写到 publish/ 同级目录（不污染 `C:\`）：

| 文件 | 位置 |
|---|---|
| `appsettings.json` | `publish\center\appsettings.json` |
| 初始化标记（`.env` + 注册表） | `publish\center\.env` + `HKLM\SOFTWARE\ADDashboard\Initialized` |
| center 日志 | 控制台 stdout（前台运行，无文件日志） |

若想重置：删除 `appsettings.json` 和 `.env`，重启服务，再次访问 `/init`。

---

## 跨机器批量安装 / 生产部署

绿色版默认就在 `publish\center\` 跑服务（日志写到 `C:\addashboard\Logs\`）。多机批量安装（含远程 WinRM 部署 Agent）见仓库根目录的 [`docs/operations/deployment.md`](../docs/operations/deployment.md) 和 [`scripts/README.md`](scripts/README.md)。

---

## 常见问题

**Q: `start.bat` 报 `需要管理员`？**
A: 服务模式注册 / 启动 Windows 服务必须以管理员身份运行。在开始菜单找到 `cmd` 或 `PowerShell`，右键 → "以管理员身份运行"，再 `cd` 进 publish/ 目录跑 `start.bat`。改用 `--console` 不需要管理员。

**Q: 第一次启动很久，正常吗？**
A: 正常。首次需要 `npm install`（约 30-60 秒）和 `npm run build`（约 10-20 秒），完成后浏览器秒开。

**Q: 端口 8080 被占用？**
A: 编辑 `publish\center\appsettings.json`（首次跑过后才会生成），改 `listenPort`，然后 `Restart-Service ADDashboardCenter`。

**Q: 服务起不来，去哪看错？**
A: `Get-Content 'C:\addashboard\Logs\ADDashboardCenter-stderr.log' -Tail 100`。常见 OOM、DB 连接失败、`node` 不在服务 PATH 中（install 阶段会自动修，但若手动注册 NSSM 服务可能漏配）。

**Q: 想前台看实时日志？**
A: `Stop-Service ADDashboardCenter`，然后 `.\start.bat --console`（或 `.\start.ps1 -Console`）。改回服务模式只需再跑 `.\start.bat`（默认）即可。

**Q: 重新初始化？**
A: 删 `appsettings.json` 和 `.env`（如存在），然后 `Restart-Service ADDashboardCenter` 即可再次进入 `/init` 向导。

**Q: 卸载？**
A: `.\scripts\uninstall-center.ps1`（默认保留数据），或 `Stop-Service ADDashboardCenter; sc.exe delete ADDashboardCenter`。

---

## 附录：本地纯前端开发模式

如果只想本地纯前端调试（不动 `C:\addashboard\`、不注册服务），仓库根目录还有：

```bash
npm install
npm start
```

`scripts/start-prod.js` 自动：`npm run build:frontend`（缺时）→ 镜像 `frontend/dist/` → `center/dist/` → spawn `node center/server.js`，cwd=`center/`，监听 `:8080`。按 **Ctrl+C** 关闭。

此模式适合纯前端开发（Vite / Vue），**不适合**做完整的端到端测试 —— 不会触发 init 模式逻辑（需要 `appsettings.json` 缺失才会进入）。
