# 服务模式部署脚本

绿色版（`start.bat`）跑通后，可以用这里的脚本升级到 Windows 服务模式。

> **前置**：必须以 **管理员身份** 运行 PowerShell；机器需联网（首次会自动下载/补齐 NSSM）。

## Center（中心服务）

```powershell
# 安装 center 服务（默认路径 C:\addashboard\Center\）
.\install-center.ps1

# 自定义端口 / 路径
.\install-center.ps1 -InstallPath 'D:\apps\center' -ListenPort 9090

# 升级（停服务 → 覆盖文件 → 重 build 前端 → 启服务）
.\update-center.ps1 -RebuildFrontend

# 卸载
.\uninstall-center.ps1
```

服务名：`ADDashboardCenter`，自动启动，依赖 DNS / Netlogon。

## Agent（每台 DC 一份）

```powershell
# 单机本地安装（在 DC 上执行）
.\install-agent.ps1 `
  -ComputerName $env:COMPUTERNAME `
  -CenterUrl 'http://center-host:8080' `
  -AgentToken '<从 center 的 appsettings.json 的 agentToken 字段复制>'

# 远程批量安装（在中心机上执行，通过 WinRM）
.\install-agent.ps1 `
  -ComputerName 'DC-BJ-01','DC-BJ-02','DC-SH-01' `
  -CenterUrl 'http://center:8080' `
  -AgentToken '<token>'

# 升级 / 卸载
.\update-agent.ps1 -ComputerName 'DC-BJ-01' -CenterUrl 'http://center:8080' -AgentToken '<token>'
.\uninstall-agent.ps1 -ComputerName 'DC-BJ-01'
```

服务名：`ADReplicationAgent`，自动启动，依赖 DNS Client / Netlogon。

## 详细文档

完整的多机部署、远程批量、Token 安全、日志位置、Troubleshooting：

- 仓库根 `docs/operations/deployment.md`
- 仓库根 `docs/operations/runbook.md`