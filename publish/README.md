# AD Replication Dashboard — 发布包

本目录包含三个独立的可交付包，每个都是自包含的、可以直接使用：

```
publish/
├── system/         ← 系统运行时（绿色版，便携包，双击 start.bat 启动）
├── designer/       ← WPF 包设计器（自包含 exe，双击 PackageDesigner.exe 启动）
└── installer/      ← MSI 安装包源码（含 build-msi.ps1，运行后产出 .msi）
```

每个子目录都自带 README，按需阅读：

| 包 | README | 用途 |
|---|---|---|
| `system/` | [`system/README.md`](system/README.md) | 部署中心 + 节点代理到目标机器 |
| `designer/` | （双击 `PackageDesigner.exe`） | 设计 / 编辑 / 发布 Agent 包 |
| `installer/` | （执行 `build-msi.ps1`） | 把 Agent 打包成 Windows MSI 安装包 |

## 三个包的对应场景

| 场景 | 用哪个 |
|---|---|
| 试用 / POC / 小规模部署 | `system/` 直接解压运行 |
| 在 Windows 工作站上设计 Agent 包 | `designer/` 双击 exe |
| 把 Agent 推到成百上千台 DC 上 | `installer/` → 跑 build-msi.ps1 → 拿 .msi 走 GPO / SCCM |

## system/ 初始化状态

`system/` **首次运行** 会自动触发初始化向导（选数据库类型 → 创建 admin → 跑 schema）：

1. `npm install`（首次约 30-60 秒，无 package-lock.json 锁定版本）
2. `npm run build:frontend`（约 10-20 秒）
3. 浏览器打开 `http://localhost:8080/init` 完成 3 屏向导
4. 向导成功后跳到登录页

向导不会重复触发，除非删除 `system/center/.env` 和 `system/center/appsettings.json`。

## designer/ 用法

`designer/PackageDesigner.exe` 是 self-contained 的，无需安装 .NET 运行时。直接双击或在文件资源管理器里右键 → "发送到"。

首次启动会在 `%APPDATA%\ADDashboard\PackageDesigner\` 下保存用户偏好和最近打开的包。

## installer/ 用法

需要本机装好：

- .NET SDK 8.0+（`dotnet --version`）
- WiX Toolset 5.0+（`wix --version`）

```powershell
cd installer
.\build-msi.ps1
# 产物：installer\agent-installer\bin\Release\net8.0-windows\win-x64\ADDashboardAgent.msi
```

或者 `build-msi.cmd`（cmd 镜像脚本）。