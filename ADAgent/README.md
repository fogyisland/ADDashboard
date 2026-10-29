# AD Replication Agent — Release Package

完整的 agent 客户端安装包. 直接拿走放到目标机器 `C:\agentInstall\`, 运行:

```powershell
cd C:\release\agentInstall
.\install-agent.ps1 -ComputerName . -CenterUrl "http://your-centre:8080" -AgentToken "<token>" -AgentType ad
```

## 目录布局

```
agentInstall\
  install-agent.ps1         WinRM/本地安装入口
  uninstall-agent.ps1       卸载入口
  start.ps1                 调试用启动 (前台运行)
  start-dashboard.ps1       独立拉起 dashboard
  Register-ADDashboardAgent.ps1   NSSM install / sc recovery 统一入口
  LogRetention.ps1          NSSM rotate 日志保留 (每天 00:05, 删 >7 天)
  version.inf               单一版本源 (version / agent / dashboard)
  appsettings.example.json   配置模板 (不含 token)
  common\                   Logger/Service/NSSM/Version 公共模块
  nssm\                     NSSM 二进制 (win32)
  node\                     Node.js 20 LTS portable
  dashboard\                进程内 dashboard (agent.js 静态 import ../dashboard/server.js —— ★必需)
  agent\                    实际安装目标 — install-agent 把它 staging 到 <InstallPath>\
    agent.js                AD/DC 血统入口 (self-register + heartbeat + 取包)
    src\                    ESM JS 源码 (R93.5 / R93.7 / package-runner env)
    scripts\                PowerShell 脚本 (collect-replication.ps1 = DC 采集器)
    data\packages\          7 个 collect.ps1 包
    package.json
```

## 安装流程

1. 拷贝整个目录到目标机 `C:\agentInstall\`
2. `cd C:\agentInstall`
3. `.\install-agent.ps1 -ComputerName . -CenterUrl <url> -AgentToken <token> -AgentType ad`
4. install-agent 会:
   - 拷贝 agent\ 内容到 InstallPath
   - 拷贝 node\ 到 InstallPath\node\
   - `npm install --omit=dev` 重建 node_modules
   - 写 appsettings.json
   - NSSM install ADReplicationAgent + 12 参数设置
   - sc.exe failure recovery
   - Start-Service

## R161.23 changelog

绿色包血统与发布链收口:

- `scripts/make-release.ps1` 之前**没有拷 `dashboard/`、`version.inf`、
  `LogRetention.ps1`、`start-dashboard.ps1`** ⇒ 打出来的包:
  - 缺 `dashboard/` ⇒ `agent/agent.js` 的静态 import
    `import { startDashboard } from '../dashboard/server.js'` 解析不到
    ⇒ 目标机启动第一秒 `ERR_MODULE_NOT_FOUND` ⇒ NSSM 崩溃重启循环,
    而安装脚本照样报"安装成功";
  - 缺 `version.inf` ⇒ `Register-ADDashboardAgent.ps1` 直接抛
    "version.inf missing or [components] version key unset"。
  现在这四项都进包, 且 `dashboard/` **缺失即中止发布**(不是 warn)。
- `README.md` 不再由脚本内嵌一份拷贝 —— 改成从包根复制, 杜绝"发布包里
  写着另一份说明"。
- 删除 AD 侧调试残留: `agent/scripts/` 下的 `run-partner-probe.js`、
  `submit-partner-probe.js`、`submit-partner-probe-v2.js`、
  `trigger-all-packages-once.js`(源树里本来就没有, 发布脚本会剔除)。
- 删除成员血统孤儿模块 `src/non-ad-scheduler.js` + `src/agent-filters.js`
  (源树与绿色包同时删) —— AD 血统用 `PackageManager`, noad 血统有自己的
  `src/non-ad-scheduler.js`; 这两个文件互相引用但没人引用它们, 留在
  DC 服务器上只会误导"包为什么没跑"的排查。
- 源树补齐 `scripts/fetch-partner-ports.ps1` + `fetch-partner-ports-helpers.ps1`
  —— `scripts/collect-replication.ps1` 运行时按同目录找这两个兄弟文件,
  绿色包里一直有、源树里却缺 ⇒ 源树与交付包不一致。
- 删除 `dashboard/server-secfix-*.js`(安全修复前的旧快照, 带着未转义的
  `onclick="openPkg('${escapeHtml(...)}')"` 模式, 无人引用)。

## R93.x changelog

R93.5 — packages-report 端口错位 (8080 → 8082)
R93.7 — reschedule() 改为 set-difference (KEEP/UPDATE/ADD/REMOVE)
        不再无差别 clearInterval 重建, 老 timer 时间累计保留
        900s / 3600s 包 (ad_lockout_list / ad_domain_consistency 等) 现在按 cadence 正常 fire

package-runner.js — env 字段透传给 spawn 的 PowerShell
        collect.ps1 读 $env:CENTER_URL 后能正常 POST 8081 拿 peers

## 已知问题

- ad_partner_ports_probe 在 LocalSystem 下 collect.ps1 拿不到 peers
  - 中期 fix: package-manager.js.runOne() 调 _runPackageScript 时透传 env
