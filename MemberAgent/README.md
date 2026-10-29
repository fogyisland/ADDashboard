# AD Dashboard Member Agent — Release Package

成员服务器(member server / 非 AD 主机)的 agent 客户端安装包. 直接拿走放到目标机器 `C:\agentInstall\`, 运行:

```powershell
cd C:\release\agentInstall
.\install-agent.ps1 -ComputerName . -CenterUrl "http://your-centre:8080" -AgentToken "<token>"
```

> `-AgentType` 的默认值就是 `non-ad`(成员血统),不用传。
> 显式传 `-AgentType ad` 会去找 AD/DC 的采集脚本,而这个绿色包里**没有**
> 那个文件 —— 属于误用,安装会直接报错中止。

## 目录布局

```
agentInstall\
  install-agent.ps1         WinRM/本地安装入口
  uninstall-agent.ps1       卸载入口
  start.ps1                 统一安装 / 热更新入口 (前台)
  Register-ADDashboardAgent.ps1   NSSM install / sc recovery 统一入口
  LogRetention.ps1          NSSM rotate 日志保留 (每天 00:05, 删 >7 天)
  version.inf               单一版本源 (version / agent / dashboard)
  appsettings.example.json   配置模板 (不含 token)
  common\                   Logger/Service/NSSM/Version 公共模块
  nssm\                     NSSM 二进制 (win32)
  node\                     Node.js 20 LTS portable
  agent\                    实际安装目标 — install-agent 把它 staging 到 <InstallPath>\
    agent.js                成员血统入口 (self-register + heartbeat + 取包)
    src\                    ESM JS 源码 (非 AD 血统)
    scripts\                PowerShell 脚本 (collect.ps1 = 成员采集器)
    data\packages\          中心下发的非 AD 包 (绿色包内为空)
```

## 安装流程

1. 拷贝整个目录到目标机 `C:\agentInstall\`
2. `cd C:\agentInstall\`
3. `.\install-agent.ps1 -ComputerName . -CenterUrl <url> -AgentToken <token>`
4. install-agent 会:
   - 拷贝 agent\ 内容到 InstallPath
   - 拷贝 node\ 到 InstallPath\node\
   - `npm install --omit=dev` 重建 node_modules
   - 写 appsettings.json
   - NSSM install memberServiceAgent + 12 参数设置
   - sc.exe failure recovery
   - Start-Service

## 服务与血统

| 项 | 值 |
|---|---|
| Windows 服务名 | `memberServiceAgent` |
| 代理类型 | `non-ad`(成员服务器, 非 DC) |
| 采集脚本 | `agent\scripts\collect.ps1`(eventlog + ADWeb + DFSR) |
| 升级包 | 中心 `/api/agent/upgrade-non-ad`,只接受 `build-manifest.json` 里 `lineage:"noad"` 的 bundle |

## 变更记录

- R158.75 — 从 AD 血统 fork 出来, 删除全部 AD/DC 采集线模块与脚本
- R158.86.6 — 服务名从 `ADReplicationAgent` 改为 `memberServiceAgent`
- R161.22 — 血统守卫: 代理只接受 `lineage:"noad"` 的升级包
- R161.23 — 绿色包血统清理 (本次):
  - `-AgentType` 默认值 `ad` → `non-ad`
  - 采集脚本路径 `collect-replication.ps1` / `collect-discovery.ps1`
    → `collect.ps1`
  - 删除 12 个 AD/DC 运行期模块 + 12 个 AD 采集脚本 + 24 个调试探针
  - 删除 `dashboard/server-secfix-*.js`(修复前的旧快照)
  - 版本对齐到 `0.1.6-noad`

R93.5 / R93.7 / package-runner env 透传 —— 这些是 **AD 血统**的历史条目,
随 fork 一并带过来;成员血统的对应实现见 `src/non-ad-scheduler.js` +
`src/package-runner.js`。
