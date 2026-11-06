# AD Dashboard Agent — 绿色包安装指南

本目录是 `agentInstall/` 绿色安装包,无需 MSI、无需 SCCM,直接拷贝 + 跑脚本即可部署 Agent 服务。适合:

- **空气隔离环境**:不能拉 MSI 二进制,只能手工传文件
- **MSI 调试**:MSI 安装失败 (2343 / 1925 等) 时用作旁路,验证 Agent 本身能起来
- **测试 / 开发机**:不想每次都过 MSI 安装向导

服务名、NSSM 配置、文件落盘位置与 MSI 路径**完全一致**,两条路径可任意切换。

## 推荐入口:`start.ps1`

绿色包里所有 PS1 都围绕这一个统一入口转。脚本会自动判断当前机器的 agent 状态:

- **服务未注册(全新机)**:在 PowerShell 终端里交互式问 `CenterUrl` 和 `AgentToken`(token 不回显),然后走 `install-agent.ps1` → `Register-ADDashboardAgent.ps1` 装机流程
- **服务已注册(升级)**:停服务 → 覆盖 `agent/*` + `collect-replication.ps1` → `npm install --omit=dev` → 启服务

操作员只需要记住一个命令:

```cmd
C:\green\agentInstall\start.ps1
```

`start.ps1` 就是这个统一入口本身(负责交互式 prompt 和具体的 install/update 逻辑)。直接在 PowerShell 终端里 `.\start.ps1` 运行;若目标机 PS 执行策略是 Restricted,用 `powershell -ExecutionPolicy Bypass -File .\start.ps1` 兜底。

## 目标机器前置条件

| 组件 | 要求 | 检查命令 |
|---|---|---|
| Windows | Server 2016+ / Win10+ | `[Environment]::OSVersion` |
| PowerShell | 5.1 (Win 内置) | `$PSVersionTable.PSVersion` |
| 网络 | 可达 `CenterUrl` + npm registry | `Test-NetConnection center-host -Port 8080`;`npm ping` |

绿色包**自带 Node.js 20 LTS x64**(位于 `<green>/node/`,随包分发,无需目标机预装;与 MSI 行为一致)。`install-agent.ps1` 会把它复制到 `<InstallPath>\node\`,然后 NSSM 启动 `<InstallPath>\node\node.exe agent.js`,完全自包含,适合空气隔离环境。

**绿色包不打包 `node_modules`** — 目标机的 `install-agent.ps1` 会跑 `npm install --omit=dev` 现场构造一份(因为 npm 会按目标机的 Node 版本 + 平台 ABI 解析,而 ship 一份预构建的 `node_modules` 既占空间又有跨主机 ABI drift 风险)。所以目标机需要 **npm + 能访问 npm registry**(若走公司内网镜像就配 `.npmrc`)。`node_modules` 由 `<green>/node/` 自带的 npm 解析,不依赖 PATH 上的 Node。

## 安装步骤

### 1. 把绿色包拷到目标机器

任选一种方式:

```powershell
# 方式 A:本地解压后整目录拷过去
Expand-Archive agentInstall.zip -DestinationPath C:\green\
# 或 SMB / WinRM Copy-Item / scp,文件大小约 80-90 MB(含 Node 20 LTS portable;
# node_modules 不打包,在目标机上现场 npm install)

# 方式 B:从管理机用 WinRM 远程推
Copy-Item -Recurse \\fileserver\share\agentInstall `
          \\target-server\C$\green\
```

### 2. 在目标机器(或远程)执行安装

**本地安装(推荐入口 — 交互式问 CenterUrl/AgentToken)**:

```cmd
C:\green\agentInstall\start.ps1
```
脚本会检测到当前机没装过服务,在终端里问:
```
Enter CenterUrl (e.g., http://center.example.com:8080): http://center.example.com:8080
Enter AgentToken: ********   # SecureString,不回显
```

**本地安装(命令行参数版 — 跳过交互式 prompt,适合脚本/CI)**:

```cmd
C:\green\agentInstall\start.ps1 -CenterUrl "http://center.example.com:8080" -AgentToken "<token>"
```
(`start.ps1` 接受所有 `-CenterUrl` / `-AgentToken` / `-ComputerName` 参数,所有 `-CenterUrl` / `-AgentToken` / `-ComputerName` 都生效。)

**底层直接调 PS1**(已经在 PowerShell 进程里的场景,比如已在 PS 进程里):

```powershell
& C:\green\agentInstall\start.ps1 -CenterUrl 'http://center.example.com:8080' -AgentToken '<token>' -InstallPath 'C:\addashboard\Agent' -AgentType ad
```

**远程安装**(在管理机上批量推):

```powershell
$cred = Get-Credential  # 目标机管理员
$block = [scriptblock]::Create((Get-Content -Raw 'C:\green\agentInstall\install-agent.ps1'))
Invoke-Command -ComputerName target01,target02 -Credential $cred -ScriptBlock $block `
  -ArgumentList @(@('target01','target02'), 'http://center:8080', '<token>', 'ad', 'C:\addashboard\Agent')
```

### 3. 验证

```powershell
Get-Service ADReplicationAgent      # 状态应为 Running
Get-Content C:\addashboard\Logs\ADReplicationAgent-stdout.log -Tail 20
# 应看到 "center heartbeat ok" 或类似的启动日志
```

在 Center Web UI → Agents 页面应能看到这个 agent 出现。

## 卸载

```powershell
& C:\green\agentInstall\uninstall-agent.ps1 `
  -InstallPath 'C:\addashboard\Agent'
```

## 升级

直接在已装机器上跑同一个命令即可 — `start.ps1` 自动识别「已装」并走热更新分支(stop → 覆盖文件 + 刷新 bundled Node → npm install → start)。不需要卸载重装。

```cmd
C:\green\agentInstall\start.ps1
```

## 与 MSI 路径的差异

| | MSI (主路径) | 绿色包 (旁路) |
|---|---|---|
| Node.js | 内嵌 Node 20 LTS | 内嵌 Node 20 LTS(`<green>/node/`,自包含) |
| 安装原子性 | InstallFiles + CAs 原子 | 手工,半成品状态可观测 |
| 远程部署 | `msiexec /qn` via WinRM | PowerShell `Invoke-Command` |
| 卸载 | `msiexec /x ... /qn` | 跑 uninstall-agent.ps1 |
| 升级 | MajorUpgrade 自动 | 重跑 install-agent.ps1 / start.ps1 |
| 出问题定位 | 翻 verbose log(`/l*v`) | 直接看 PowerShell 输出 |
| 适用场景 | 生产 / SCCM | 调试 / 空气隔离 / 测试 |

服务名 `ADReplicationAgent` 一致 — 绿色包装出的服务 MSI 能识别,反之亦然。
