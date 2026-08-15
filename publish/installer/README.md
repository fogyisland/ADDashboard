# Agent MSI 安装包

把 Agent 打包成 Windows MSI 安装包（用于 SCCM / GPO 批量部署）。

## 前置条件

本机需要：

- .NET 8 SDK（`dotnet --version` 输出 8.x）
- WiX Toolset 5.0+（`wix --version`）

## 构建

```powershell
cd installer
.\build-msi.ps1
```

或者用 cmd：

```cmd
cd installer
build-msi.cmd
```

产物路径：

```
installer\agent-installer\bin\Release\net8.0-windows\win-x64\ADDashboardAgent.msi
```

## 目录结构

```
installer/
├── build-msi.ps1                    ← PowerShell 构建脚本（推荐）
├── build-msi.cmd                    ← cmd 镜像脚本
├── agent-installer/
│   ├── AgentInstaller.csproj        ← WiX 5 SDK-style csproj
│   ├── Product.wxs                  ← MSI 产品定义
│   ├── Files.wxs                    ← 要打包的文件
│   ├── CustomActions.wxs            ← 自定义动作声明
│   ├── Dialogs.wxs                  ← 安装对话框
│   ├── Properties.wxs               ← MSI 属性
│   ├── CA/                          ← Custom Action C# 代码
│   │   ├── AgentInstaller.CA.csproj
│   │   ├── ConfigureAgentAction.cs  ← 安装后写 appsettings.json
│   │   └── RollbackAgentAction.cs   ← 卸载时清理
│   └── ui/
│       └── WixUI_zh_CN.wxl          ← 中文 UI 字符串
└── tests/
    ├── AgentInstaller.CA.Tests/     ← xUnit 测试（ConfigureAgentAction + Rollback）
    ├── msi-smoke.Tests.ps1          ← Pester smoke
    └── spec-mirror.Tests.ps1        ← 验证 wxs 文件覆盖 spec 全部 mandate
```

## 数据落盘

MSI 安装的 Agent 数据在目标机器上：

| 文件 | 位置 |
|---|---|
| Agent 程序文件 | `C:\Program Files\ADDashboard\Agent\` |
| `appsettings.json` | `C:\Program Files\ADDashboard\Agent\appsettings.json` |
| Agent 日志 | `C:\addashboard\Logs\ADDashboardAgent-{stdout,stderr}.log` |
| 服务名 | `ADDashboardAgent`（NSSM 管理） |