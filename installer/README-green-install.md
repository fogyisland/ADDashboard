# AD Dashboard Agent — 绿色包安装指南

本目录是 `agentInstall/` 绿色安装包,无需 MSI、无需 SCCM,直接拷贝 + 跑脚本即可部署 Agent 服务。适合:

- **空气隔离环境**:不能拉 MSI 二进制,只能手工传文件
- **MSI 调试**:MSI 安装失败 (2343 / 1925 等) 时用作旁路,验证 Agent 本身能起来
- **测试 / 开发机**:不想每次都过 MSI 安装向导

服务名、NSSM 配置、文件落盘位置与 MSI 路径**完全一致**,两条路径可任意切换。

## 推荐入口:`start.bat`

绿色包里所有 PS1 都围绕这一个统一入口转。脚本会自动判断当前机器的 agent 状态:

- **服务未注册(全新机)**:在 PowerShell 终端里交互式问 `CenterUrl` 和 `AgentToken`(token 不回显),然后走 `install-agent.ps1` → `Register-ADDashboardAgent.ps1` 装机流程
- **服务已注册(升级)**:停服务 → 覆盖 `agent/*` + `collect-replication.ps1` → `npm install --omit=dev` → 启服务

操作员只需要记住一个命令:

```cmd
C:\green\agentInstall\start.bat
```

`start.bat` 内部转调 `upgrade-agent.ps1`(PowerShell 脚本,负责交互式 prompt 和具体的 install/update 逻辑)。`.bat` 包装让运维不用管 PowerShell 执行策略和 `.ps1` 扩展名关联。

## 目标机器前置条件

| 组件 | 要求 | 检查命令 |
|---|---|---|
| Windows | Server 2016+ / Win10+ | `[Environment]::OSVersion` |
| PowerShell | 5.1 (Win 内置) | `$PSVersionTable.PSVersion` |
| Node.js | 20 LTS x64(自带 npm) | `node --version`(需输出 v20.x)`npm --version` |
| 网络 | 可达 `CenterUrl` + npm registry | `Test-NetConnection center-host -Port 8080`;`npm ping` |

MSI 把 Node.js 一起打包进安装包;绿色包**不**打包 Node.js,假设目标机已经装好(运维标配)。

**绿色包不打包 `node_modules`** — 目标机的 `install-agent.ps1` 会跑 `npm install --omit=dev` 现场构造一份(因为 npm 会按目标机的 Node 版本 + 平台 ABI 解析,而 ship 一份预构建的 `node_modules` 既占空间又有跨主机 ABI drift 风险)。所以目标机需要 **npm + 能访问 npm registry**(若走公司内网镜像就配 `.npmrc`)。

## 安装步骤

### 1. 把绿色包拷到目标机器

任选一种方式:

```powershell
# 方式 A:本地解压后整目录拷过去
Expand-Archive agentInstall.zip -DestinationPath C:\green\
# 或 SMB / WinRM Copy-Item / scp,文件大小约 1-2 MB(node_modules 不打包,
# 在目标机上现场 npm install)

# 方式 B:从管理机用 WinRM 远程推
Copy-Item -Recurse \\fileserver\share\agentInstall `
          \\target-server\C$\green\
```

### 2. 在目标机器(或远程)执行安装

**本地安装(推荐入口 — 交互式问 CenterUrl/AgentToken)**:

```cmd
C:\green\agentInstall\start.bat
```
脚本会检测到当前机没装过服务,在终端里问:
```
Enter CenterUrl (e.g., http://center.example.com:8080): http://center.example.com:8080
Enter AgentToken: ********   # SecureString,不回显
```

**本地安装(命令行参数版 — 跳过交互式 prompt,适合脚本/CI)**:

```cmd
C:\green\agentInstall\start.bat -CenterUrl "http://center.example.com:8080" -AgentToken "<token>"
```
(`start.bat` 把参数原样转给 `upgrade-agent.ps1`,所有 `-CenterUrl` / `-AgentToken` / `-ComputerName` 都生效。)

**底层直接调 PS1**(不需要 `start.bat` 包装的场景,比如已在 PS 进程里):

```powershell
& C:\green\agentInstall\upgrade-agent.ps1 -CenterUrl 'http://center.example.com:8080' -AgentToken '<token>' -InstallPath 'C:\addashboard\Agent' -AgentType ad
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

直接在已装机器上跑同一个命令即可 — `start.bat` 自动识别「已装」并走热更新分支(stop → 覆盖文件 → npm install → start)。不需要卸载重装。

```cmd
C:\green\agentInstall\start.bat
```

会停服务、移除 NSSM 注册、删除 `C:\addashboard\Agent\` 与 `C:\addashboard\Logs\`(如有)。

## 升级

绿色包安装的 agent 升级方式:

1. `nssm stop ADReplicationAgent`
2. `nssm remove ADReplicationAgent confirm`
3. 删除 `C:\addashboard\Agent\`(node_modules 一起删,下次安装会重新拉)
4. 用新版本绿色包重新跑 install-agent.ps1

或直接调 **`upgrade-center.ps1`** 的 Agent 等价版本(目前 agent 升级路径还是手工,后续规划统一进 `upgrade-agent.ps1`)。

## 与 MSI 路径的差异

| | MSI (主路径) | 绿色包 (旁路) |
|---|---|---|
| Node.js | 内嵌 Node 20 LTS | 目标机预装(自带 npm) |
| 安装原子性 | InstallFiles + CAs 原子 | 手工,半成品状态可观测 |
| 远程部署 | `msiexec /qn` via WinRM | PowerShell `Invoke-Command` |
| 卸载 | `msiexec /x ... /qn` | 跑 uninstall-agent.ps1 |
| 升级 | MajorUpgrade 自动 | 重跑 install-agent.ps1 |
| 出问题定位 | 翻 verbose log(`/l*v`) | 直接看 PowerShell 输出 |
| 适用场景 | 生产 / SCCM | 调试 / 空气隔离 / 测试 |

服务名 `ADReplicationAgent` 一致 — 绿色包装出的服务 MSI 能识别,反之亦然。
