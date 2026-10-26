# ADDashboardCenter 部署脚本集 (5 file, 1-click 全周期)

操作员后续服务器 RDP 后, 走 `deploy\` 目录 5 脚本闭 register → start → verify → stop → uninstall 周期.
0 必任何敏感 KV (DB_PWD / LICENSE_KEY / JWT_SECRET) 落 NSSM 注册表 (R158.95-ext 锁 + 操作员 directive "0 copy 真值"):
- `.env` 必操作员手动维护 (`cp .env.example .env` + 填 3 必填 KV)
- NSSM AppEnvironmentExtra 仅 set 3 非敏感 KV (PORT/NODE_ENV/LOG_DIR)
- DB_PWD/LICENSE_KEY/JWT_SECRET 由 server.js 启动时 dotenv 读 .env, 0 落 NSSM

## 5 脚本周期

### 步骤 1: 预跑 (操作员手动, 1 次性)
- 装 Node.js v22+ (`choco install nodejs` 或 node-v22.x-x64.msi)
- 装 NSSM 2.24+ (`choco install nssm` 或 nssm-2.24.zip 解压到 PATH)
- 填 `.env` 真值 (`cp .env.example .env` + notepad 填 DB_PWD / LICENSE_KEY / JWT_SECRET)

### 步骤 2: install-service.ps1 (1-click register)
```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\install-service.ps1
```
6 步 atomic: verify node → verify nssm → verify .env 3 KV → npm ci --omit=dev → nssm install → nssm set (AppDirectory/Logs/Rotate/RestartDelay/3 non-sensitive env)

### 步骤 3: start.ps1 (1-click start)
```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\start.ps1 -Wait
```
- `-Wait` 选: 等 5s + verify /api/health 200 + tail Logs\service-stdout.log
- `-Force` 选: stop + start (即使已 running)
- 幂等: 已 running 0 必重复 start (除非 -Force)

### 步骤 4: verify.ps1 (1-click health 6 维)
```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\verify.ps1
```
6 维 verify: node / nssm / .env 3 KV (0 echo value) / node_modules / service status / /api/health

### 步骤 5: stop.ps1 (1-click stop)
```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\stop.ps1
```
- graceful stop (等 30s 兜底, 然后 force kill)
- `-Force` 选: 立即 stop (0 等 graceful)

### 步骤 6: uninstall-service.ps1 (1-click 卸载)
```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\uninstall-service.ps1
```
- stop + nssm remove (操作员 confirm y/N, 除非 -Force)
- 0 删 .env / 0 删 node_modules / 0 删 src/dist/db/web (镜像下次 install 可复用)
- `-Force` 选: 同时删 Logs/ 目录

## 0 触凭证固化 (R158.95-ext 锁 + 操作员 directive "0 copy 真值")

| KV | 落点 | 是否固化到 NSSM 注册表 |
|---|---|---|
| DB_PWD | .env 文件 (操作员手动维护) | ❌ 否 (server.js dotenv 启动读) |
| LICENSE_KEY | .env 文件 | ❌ 否 (server.js dotenv 启动读) |
| JWT_SECRET | .env 文件 | ❌ 否 (server.js dotenv 启动读) |
| PORT | NSSM AppEnvironmentExtra | ✓ 是 (非敏感) |
| NODE_ENV | NSSM AppEnvironmentExtra | ✓ 是 (非敏感) |
| LOG_DIR | NSSM AppEnvironmentExtra | ✓ 是 (非敏感) |

3 敏感 KV 仅存 .env 文件 (后续服务器操作员手动维护), NSSM 注册表 0 触. 任何 Windows 管理员调 `reg query` 看 0 到 DB_PWD/LICENSE_KEY/JWT_SECRET.

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

## 0 走 deploy 流程的情况 (操作员手动)

如果后续服务器想手动操作 (0 走 deploy 脚本):
- `nssm install ADDashboardCenter node server.js` 走 install-service.ps1 同样效果
- `nssm start ADDashboardCenter` 走 start.ps1 同样效果
- `nssm stop ADDashboardCenter` 走 stop.ps1 同样效果
- `nssm remove ADDashboardCenter confirm` 走 uninstall-service.ps1 同样效果

但 deploy 脚本提供 4 增值: verify 6 维 / idempotent register / log tail -Wait / confirm prompt 防误删.
