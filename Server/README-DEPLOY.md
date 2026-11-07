# Server/ 拷贝部署指南（Windows，自带 Node，零环境依赖）

> 目标：把本目录拷到**任何一台 Windows 机器**（不需要装 Node、不需要装 NSSM），
> 双击 `start.bat` 即完成 依赖安装 → 服务注册 → 启动 → （首次）进入初始化向导。

## 1. 拷贝清单

**整个 `Server\` 目录**，但**排除以下内容**：

| 排除 | 原因 |
|---|---|
| `node_modules/`（根 + `center/`） | 体积大；目标机由 `start.bat` → 自带 npm 现装 |
| `center/.env` | ★ init 完成标记（`ADDASHBOARD_INITIALIZED=1`）—— 带走它 = 新位置直接"已初始化"，**向导永远不出现** |
| `center/appsettings.json` | ★ 老机器的 DB 口令 / jwtSecret / agentToken；新位置应由向导重新生成 |
| `center/Logs/` | 运行日志，属目标机 |
| `center/.install-hash` | 本机依赖状态标记，运行期自建 |
| `center/dist/.vite/` | 构建缓存 |

**必须带上**（缺一不可）：

| 内容 | 用途 |
|---|---|
| `node/`（node.exe + npm.cmd） | 自带 Node v25.8.2 —— 部署链全程用它 |
| `nssm/`（nssm.exe） | 服务注册 |
| `center/`（src, server.js, dist, package.json） | 中心本体 + 已构建前端 |
| `db/` | 基线 + 迁移（向导建库时读，必须位于**安装目录上一级**） |
| `scripts/` | install/upgrade/update-center.ps1 |
| `package.json` + `package-lock.json` | workspaces 根清单 + 钉版本的 lock |
| `build-manifest.json` | 启动指纹 |
| `center/appsettings.json.example` | 配置结构模板（仅参照，向导不读它） |

## 2. 首次启动

```
cd <新位置>\Server
start.bat          （管理员 cmd；或右键"以管理员身份运行"）
```

流程：`start.bat` → 自带 node 前置 PATH → `install-center.ps1 -InPlace`
→ `npm ci`-式装依赖（走 `package-lock.json`，钉版本）→ 注册 NSSM 服务
`ADDashboardCenter` → 启动 → HTTP 探针。

浏览器打开 `http://localhost:8080` → 自动进入 `/init` 向导 →
填数据库（MySQL / MSSQL）→ 建管理员 → 完成（向导写
`center/.env` + `center/appsettings.json` + 注册表标记）。

## 3. 如果新机器曾装过中心（向导被锁死时）

init 标记有**两个**存储，`center/.env`（已排除）+ **机器级注册表**：

```powershell
reg delete "HKLM\SOFTWARE\ADDashboard\Initialized" /f
```

再删掉目标目录里的 `center\.env` 与 `center\appsettings.json`，重启服务即可重走向导。

## 4. 端口

默认 8080（`start.bat` 不带参数）。换端口：`start.bat` 后按
`install-center.ps1 -ListenPort <port>` 的口径改，或初始化完成后在管理后台改
（改完需重启服务生效 —— 见 R161.25 端口真值表）。

★ **R161.29（2026-11-07）单端口架构**：Web/管理界面、Agent 心跳（原 8081）、
Agent 大包上报（原 8082）**共用这一个端口**。防火墙只放通 `listenPort` 一个口；
8081/8082 不再监听。**Agent 必须随中心一起升级**（老 Agent 硬编码 :8081/:8082，
指向死端口会静默 404）。

## 5. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 启动即 500 / 页面空白但服务 Running | 没排除 `center/appsettings.json` ⇒ DB 连不上；删它重走向导 |
| 向导不出现 | `center\.env` 或注册表标记残留 ⇒ 见第 3 节 |
| `npm install` 失败 | 离线机：在有网机器上 `cd Server && .\node\npm.cmd ci --omit=dev` 后连 `node_modules` 一起拷过去 |
| 服务起不来、无日志 | 看 `center\Logs\ADDashboardCenter-stderr.log`（Node 启动期错误只落 stderr） |
