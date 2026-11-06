# ADDashboardCenter 部署脚本集 (6 file, 1-click 全周期)

操作员后续服务器 RDP 后, 走 `deploy\` 目录脚本闭 register → start → verify → stop → uninstall 周期.

## ★ 凭据模型 (R161.25 纠正 — 旧版这份文档写错了)

旧版本文档说「`.env` 必操作员手动维护 (`cp .env.example .env` + 填 DB_PWD / LICENSE_KEY / JWT_SECRET)」。
**那三个键中心从来不读**:

| KV | 真实落点 | 说明 |
|---|---|---|
| DB 口令 | `appsettings.json` (`db.mysql.password` / `db.mssql.password`) | 由目标机上的 `/init` 向导写入, 文件权限 **0600** (Linux) |
| `jwtSecret` | `appsettings.json` | 同上 |
| `agentToken` | `appsettings.json` | 同上 (agent 用它上报) |
| `LICENSE_KEY` | **不存在** | 中心这条链路上没有这个概念 (许可证是另一条链路的) |
| `ADDASHBOARD_INITIALIZED=1` | `appsettings.json` 同目录的 `.env` | **不是凭据文件** —— 它是"初始化已完成"的**标记**, 由程序自己写、自己读; 操作员**不需要**手动维护 |

⇒ **操作员不需要 (也不该) 手写任何 `.env`**。旧文档照做会得到一个"以为装好了、其实中心起不来"的机器:
`install-service.ps1` 的旧闸门是「`.env` 里必须有 DB_PWD/LICENSE_KEY/JWT_SECRET」—— 干净机器上永远满足不了。

⇒ NSSM 注册表里**不落任何凭据** (`reg query HKLM\SOFTWARE\ADDashboard` 看得到 DB 口令 / JWT secret 就说明出事了)。

## 5 脚本周期

### 步骤 1: 预跑 (操作员手动, 1 次性)
- 装 Node.js v22+ (`choco install nodejs` 或 node-v22.x-x64.msi)
- 装 NSSM 2.24+ (`choco install nssm` 或 nssm-2.24.zip 解压到 PATH)
- **不用**手写 `.env` / appsettings.json —— 中心起来后走 `/init` 向导, 由向导在目标机上生成

### 步骤 2: install-service.ps1 (1-click register)
```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\install-service.ps1
```
6 步 atomic: verify node → verify nssm → verify 交付物 (server.js / dist\index.html / 上一级 db\migrations)
→ 装依赖 (`npm install --omit=dev --no-audit --no-fund`; 目标机上没有 lock ⇒ **不能**用 `npm ci`, 会 EUSAGE)
→ nssm install → nssm set (AppDirectory/AppParameters/Logs/Rotate/RestartDelay/非敏感 env)。
已有同名服务时**刷新参数**而不是报错退出; 要重装加 `-Force`。

### 步骤 3: start.ps1 (1-click start)
```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\start.ps1 -Wait
```
- `-Wait` 选: 等 5s + verify `/healthz` 200 (503 = 进程活着但还没初始化, 属正常) + tail `Logs\service-stdout.log`
- 探测端口取自 `appsettings.json` 的 `listenPort` (中心启动成功后会把它回写成**实际绑定端口** ⇒ 与真实监听端口一致)
- `-Force` 选: stop + start (即使已 running)
- 幂等: 已 running 不重复 start (除非 -Force)

### 步骤 4: verify.ps1 (1-click health 6 维)
```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\verify.ps1
```
6 维 verify: node / nssm / **配置状态** / 依赖可解析 / service status / `/healthz`。
配置状态这一维 (R161.25 纠正): `appsettings.json` 在 = 正常模式; 不在且**没有**初始化标记 = init 模式 (正常);
不在但**有**初始化标记 = **真故障** (中心会以 exit 2 反复重启, 向导也被锁死)。

### 步骤 5: stop.ps1 (1-click stop)
```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\stop.ps1
```
- graceful stop (等 30s 兜底, 然后 force kill)
- `-Force` 选: 立即 stop (不等 graceful)

### 步骤 6: uninstall-service.ps1 (1-click 卸载)
```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\uninstall-service.ps1
```
- stop + nssm remove (操作员 confirm y/N, 除非 -Force)
- 不删 appsettings.json / .env / node_modules / src/dist/db/web (镜像下次 install 可复用)
- `-Force` 选: 同时删 Logs/ 目录

## 端口真值表 (R161.25)

| 来源 | 含义 | 谁写 |
|---|---|---|
| `appsettings.json` 的 `listenPort` | **期望端口** (下次启动要绑的端口) | `/init` 向导; 管理后台改端口后由中心在启动成功时回写 |
| `system_config.listenPort` | 期望端口的**镜像** (管理后台可改) | 启动期对账 / 管理后台 |
| `system_config.listenPort_source` | 镜像来源: `appsettings` \| `admin` | 同上 |
| `system_config.center_listen_port_bound` | **当前进程实际绑定的端口** | 每次正常模式启动 |

- 后台改端口 ⇒ 写 `system_config` 且标记 `admin` ⇒ **重启后真的换端口** (旧实现写库不读库, 改端口永远不生效)。
- 没有 `listenPort_source` 标记的老行按"文件镜像"处理 ⇒ **存量部署的端口一个字节都不变**。
- 部署自检脚本 (本目录 `verify.ps1` / `start.ps1`, Linux 侧 `scripts/verify.sh` / `scripts/start.sh`) 探的是
  **实际绑定端口**, 不会在"后台改了端口还没重启"那段时间里把健康的服务报成故障。

## 完整 1-click 流程 (操作员后续服务器)

```powershell
# 1. install + register
powershell -ExecutionPolicy Bypass -File .\deploy\install-service.ps1

# 2. start + verify
powershell -ExecutionPolicy Bypass -File .\deploy\start.ps1 -Wait

# 3. (后续) verify health
powershell -ExecutionPolicy Bypass -File .\deploy\verify.ps1

# 4. (维护) stop / restart
powershell -ExecutionPolicy Bypass -File .\deploy\stop.ps1
powershell -ExecutionPolicy Bypass -File .\deploy\start.ps1 -Force

# 5. (卸载) remove service
powershell -ExecutionPolicy Bypass -File .\deploy\uninstall-service.ps1
```

## 不走 deploy 流程的情况 (操作员手动)

如果后续服务器想手动操作 (不走 deploy 脚本):
- `nssm install ADDashboardCenter <node.exe 绝对路径>` —— **必须写绝对路径**: LocalSystem 的 PATH 里没有
  `%ProgramFiles%\nodejs`, 写 `node` 会注册成功但启动失败 (`AppPath` 找不到)。
- `nssm start ADDashboardCenter` 走 start.ps1 同样效果
- `nssm stop ADDashboardCenter` 走 stop.ps1 同样效果
- `nssm remove ADDashboardCenter confirm` 走 uninstall-service.ps1 同样效果

但 deploy 脚本提供 4 增值: verify 6 维 / idempotent register / log tail -Wait / confirm prompt 防误删.
