# Agent 安装包

把 Agent 打包成两种可分发形态：

| 形态 | 文件 | 适用场景 |
|---|---|---|
| **MSI**（主路径） | `publish/installer/ADDashboardAgent.msi` | 生产 / SCCM / GPO 批量部署 / `msiexec /qn` |
| **绿色包**（旁路） | `publish/installer/ADDashboardAgent-green/` + `.zip` | 空气隔离 / MSI 安装调试 / 测试 |

两条路径产生的服务名一致（`ADReplicationAgent`），NSSM 配置一致 — 可任意切换。

## 路径选择

- **生产 / 批量部署 → MSI**。自带 Node 20 LTS，原子安装（`InstallFiles` + CAs），卸载走 `msiexec /x`。
- **MSI 出错 / 空气隔离 / 临时旁路 → 绿色包**。手工拷目录 + 跑 `install-agent.ps1`，目标机需自备 Node 20 LTS。详见 [`README-green-install.md`](README-green-install.md)（随绿色包分发，也在本目录）。

---

# Agent MSI 安装包

把 Agent 打包成 Windows MSI 安装包（用于 SCCM / GPO 批量部署）。

## 直接使用（推荐）

**Windows 用户：** 双击 [`ADDashboardAgent.msi`](ADDashboardAgent.msi) 启动安装向导。

`msiexec` 静默安装：

```cmd
msiexec /i ADDashboardAgent.msi /qn
```

或带日志：

```cmd
msiexec /i ADDashboardAgent.msi /qn /l*v install.log
```

### 自定义安装路径

默认装到 `C:\addashboard\Agent`。要装到其他路径，在 `msiexec` 命令行加 `INSTALLDIR=`：

```cmd
msiexec /i ADDashboardAgent.msi /qn INSTALLDIR="D:\Dashboard\Agent"
```

日志路径自动跟随 INSTALLDIR：装到 `D:\Dashboard\Agent` 时日志落到 `D:\Dashboard\Logs\`，跟 PS1 installer (`<InstallPath>\Logs`) 行为一致。带空格的路径也支持（如 `C:\Program Files\ADDashboard\Agent`），但需用英文双引号包住。

不传 `INSTALLDIR=` 时保持向后兼容（v1.0.0 升级路径不变，MajorUpgrade 原地升级）。

## 重新构建

源码 + 构建脚本：

```powershell
cd installer
.\build-msi.ps1
```

或用 cmd：

```cmd
cd installer
build-msi.cmd
```

需要本机装好：

- .NET 8 SDK（`dotnet --version` 输出 8.x）
- WiX Toolset 5.0+（`wix --version`）

构建产物：

```
installer\agent-installer\bin\x64\Release\zh-CN\addashboard-agent-x64-1.0.0.0.msi
```

构建完成后 `build-msi.ps1` 自动把 MSI 拷到 `publish/installer/ADDashboardAgent.msi`（publish 包 MSI 形态的交付产物）。

## 重新构建绿色包

```powershell
cd installer
.\build-green-package.ps1
```

产出 `publish/installer/ADDashboardAgent-green/` 文件夹 + `publish/installer/ADDashboardAgent-green.zip`。

需要本机装好：

- Node.js 20 LTS（脚本要 `npm install` 预装 node_modules）

构建产物：

```
publish\installer\ADDashboardAgent-green\
├── agent\                 预装的 agent 运行时（含 node_modules）
├── scripts\               install / uninstall / common\ 模块
├── nssm\nssm.exe
└── README-green-install.md
```

绿色包跟 MSI 的 staging 逻辑一致（`build-msi.ps1:14-132` vs `build-green-package.ps1`），改 `agent/` 后两个包都要重新 build。

> ⚠️ **改源后必须本地 rebuild**。本仓库**不**自动 rebuild MSI — 编辑 `installer/agent-installer/`（`.wxs` / `.cs` / `appsettings.template.json` 等）后,`publish/installer/ADDashboardAgent.msi` 仍是上次 build 的旧版。Operator 拿到旧 MSI 装会装到旧行为(Launch message、旧 CA 逻辑等)。commit 前必须跑 `build-msi.ps1` 一次,把新 MSI 一起 commit。
>
> Pre-commit checklist:
> ```bash
> git diff --stat installer/ publish/installer/ADDashboardAgent.msi
> ```
> installer/ 有改动但 MSI 没动 → 先 build 再 commit。

## 目录结构

```
installer/
├── ADDashboardAgent.msi              ← 最终 MSI 安装包
├── build-msi.ps1                     ← PowerShell 构建脚本
├── build-msi.cmd                     ← cmd 镜像脚本
├── README.md
├── agent-installer/
│   ├── AgentInstaller.csproj         ← WiX 5 SDK-style csproj
│   ├── Product.wxs                   ← MSI 产品定义
│   ├── Files.wxs                     ← 要打包的文件
│   ├── CustomActions.wxs             ← 自定义动作声明
│   ├── Dialogs.wxs                   ← 安装对话框
│   ├── Properties.wxs                ← MSI 属性
│   ├── CA/                           ← Custom Action C# 代码
│   │   ├── AgentInstaller.CA.csproj
│   │   ├── ConfigureAgentAction.cs   ← 安装后写 appsettings.json
│   │   └── RollbackAgentAction.cs    ← 卸载时清理
│   └── ui/
│       └── WixUI_zh_CN.wxl           ← 中文 UI 字符串
└── tests/
    ├── AgentInstaller.CA.Tests/      ← xUnit 测试（ConfigureAgentAction + Rollback）
    ├── msi-smoke.Tests.ps1           ← Pester smoke
    └── spec-mirror.Tests.ps1         ← 验证 wxs 文件覆盖 spec 全部 mandate
```

## 数据落盘

MSI 安装的 Agent 数据在目标机器上：

| 文件 | 位置 |
|---|---|
| Agent 程序文件 | `C:\Program Files\ADDashboard\Agent\` |
| `appsettings.json` | `C:\Program Files\ADDashboard\Agent\appsettings.json` |
| Agent 日志 | `<INSTALLDIR>\..\Logs\ADReplicationAgent-{stdout,stderr}.log`（默认 `C:\addashboard\Logs`） |
| 服务名 | `ADDashboardAgent`（NSSM 管理） |