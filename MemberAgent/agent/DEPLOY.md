# KDLFLOFADSRV1 agent bundle — 部署说明

> 模板来源：`D:\agentInstall\kdlflofadsrv1-agent-backup\agent\`（2026-09-30）
> 代码水位：**R158.9**（与 centre `D:\dashboard\center\` R158.9 对齐）
> 上一水位：R93.12（2026-09-27 bundle）

## 1. 适配范围

此 bundle 是从 `KDLFLOFADSRV1` 沈阳 FLO 1 拷贝出来的**运行快照**，目标是作为模板直接复制到其它 AD DC 上部署。要部署到新机器请按以下流程，**不能直接全目录覆盖**——`appsettings.json` 里 `agentToken` 是该台专属的。

## 2. 部署步骤（每台新机器）

1. **复制整个目录** 到目标机的 `C:\agentInstall\agent\`（或部署约定路径）。
2. **重置 `appsettings.json` 的运行专属字段**：
   ```powershell
   $cfg = Get-Content 'C:\agentInstall\agent\appsettings.json' -Raw | ConvertFrom-Json
   $cfg.agentId          = '<本机 agentId, e.g. KDLFLOFADSRV2>'
   $cfg.agentToken       = '<该 agent 在 centre 已注册的 token>'
   $cfg.centerUrl        = 'http://10.170.140.23:8080'   # 中心地址（按实际）
   $cfg.queueDbPath      = 'C:\agentInstall\agent\queue.db'
   $cfg.psScriptPath     = 'C:\agentInstall\agent\scripts\collect-replication.ps1'
   $cfg.psDiscoveryScriptPath = 'C:\agentInstall\agent\scripts\collect-discovery.ps1'
   $cfg.heartbeatIntervalSeconds = 60                    # R157 必须 60s
   $cfg | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 'C:\agentInstall\agent\appsettings.json'
   ```
3. **删 `queue.db*`**（避免把 FLO1 的运行队列带到新机器）：
   ```powershell
   Remove-Item 'C:\agentInstall\agent\queue.db', 'C:\agentInstall\agent\queue.db-shm', 'C:\agentInstall\agent\queue.db-wal' -ErrorAction SilentlyContinue
   ```
4. **依赖**：`node_modules\` 已在 backup 内，可直接 `npm start` 验证。
5. **注册 NSSM 服务**（如未注册）：
   ```powershell
   nssm install ADReplicationAgent "C:\Program Files\nodejs\node.exe" "C:\agentInstall\agent\agent.js"
   nssm set ADReplicationAgent AppDirectory "C:\agentInstall\agent"
   nssm set ADReplicationAgent AppStdout "C:\agentInstall\agent\Logs\ADReplicationAgent-stdout.log"
   nssm set ADReplicationAgent AppStderr "C:\agentInstall\agent\Logs\ADReplicationAgent-stderr.log"
   nssm set ADReplicationAgent Start SERVICE_AUTO_START
   Start-Service ADReplicationAgent
   ```
6. **首次启动验证**：60s 内应看到首次心跳到达 centre（dashboard `/overview` 卡片会出现该 agent）。

### 日志保留 (R158.60.11)

- NSSM stdout/stderr 走 10MB rotate (AppRotateBytes=10MB + AppRotateFiles=1 + AppRotateOnline=1)，backup 落到 `<LogDir>\ADReplicationAgent-{stdout,stderr}.log.YYYYMMDDHHMMSS.log`
- Register-ADDashboardAgent.ps1 自动注册 Windows Task Scheduler `ADDashboardAgent-LogRetention` (每天 00:05 SYSTEM 账户)
- Task 跑 `LogRetention.ps1` 删 >7 天的 rotate backup，**不**碰现役 `<svc>-{stdout,stderr}.log` (NSSM 持有 handle)
- ad-hoc preview: `powershell -File C:\agentInstall\agent\LogRetention.ps1 -DryRun` (只列不删)
- 真机 ship 后第一次 `Register-ADDashboardAgent.ps1` 自动生效 (幂等 re-register safe)
- 卸载时 `Register-ADDashboardAgent.ps1 -Action Unregister` 同步 unregister task

## 3. 保留文件（不要删）

| 路径 | 原因 |
|---|---|
| `data\ad_partner_ports_probe.collect.ps1` | **R93.11 override** —— 绕过 centre `/api/agent/replication-partners` 404 让 probe 走本地 `Get-ADReplicationPartnerMetadata`。删了 R155 故障复发，partners=[] |
| `data\packages\ad_partner_inbound_discover\1.1.0\*` | R157.4 5min cron 直采 inbound partners，写 `ad_partner_inbound` 表 |
| `data\packages\ad_partner_outbound_discover\1.1.0\*` | R157.4 5min cron 直采 outbound partners，写 `ad_partner_outbound` 表 |
| `data\packages\ad_dc_probe_inbound\1.0.0\*` | R155.3 入站 probe collector |
| `data\packages\ad_os_baseline\1.0.3\*` | R147 加 5 字段(bios_info/cpu_brand/mem_total_bytes/disks/c_used_pct) |

## 4. 关键修复水位（与 centre R158.9 对齐）

| 文件 | 版本前 | 版本后 | 内容 |
|---|---|---|---|
| `agent.js` | 45503 | **46051** | R158 `runTriggeredPackages` 注入（line 459） |
| `src\config.js` | 4462 | **4847** | R157 `heartbeatIntervalSeconds: 60` 默认值 |
| `src\heartbeat-callbacks.js` | 8975 | **10091** | R158 `packagesTriggers` piggyback |
| `src\package-manager.js` | 25549 | **31056** | R157.1 `CHUNK_SIZE=50` + R158 `runTriggersNow()` |
| `appsettings.json` | heartbeat=5 | **heartbeat=60** | R157 OOM 治理（其它字段保留原值） |

## 5. centre 端必须就位（部署前检查）

部署新 agent 之前，确认 centre 端已跑：

- **migration 039**（MSSQL）：`package_runs ADD status NVARCHAR(32) NULL` + filtered index on (status, started_at DESC) WHERE status='pending_trigger'
  文件：`D:\dashboard\db\migrations\mssql\039-package-runs-status-column.sql`
- **migration 036/037**（R156 partner-discover 仓表）：`ad_partner_inbound` / `ad_partner_outbound` 物理表
- **migration 035**（R155.6）：`ad_dc_inbound_partners` + `ad_dc_outbound_partners` 仓表
- **migration 033**（R155.3）：`ad_partner_inbound_discover` / `ad_partner_outbound_discover` 表 rename + endpoint 路径 `/monitor-inbound`
- centre `D:\dashboard\center\src\services\cron-scheduler.js` 已 R158.9（status='pending_trigger' 字面量）
- centre `D:\dashboard\center\src\services\partner-discover.js` 已 R157.8（两步 `[domain,query]` SQL key resolve）
- centre `D:\dashboard\center\src\services\trigger-queue.js` 已存在（R158 claimPendingTriggers）

## 6. 验证清单（部署后）

| # | 检查项 | 命令 / 关键字 | 期望 |
|---|---|---|---|
| 1 | 服务运行 | `Get-Service ADReplicationAgent` | Running |
| 2 | 心跳周期 | 日志搜 `heartbeat intervalMs: 60000` | 60000（不是 5000） |
| 3 | 60s 内首次 syncFromCenter | 日志搜 `synced package ... 1.1.0` | 出现 `ad_partner_inbound_discover`/`ad_partner_outbound_discover` 1.1.0 |
| 4 | R158 trigger 链路 | 日志搜 `runTriggeredPackages` | ≤ 60s 内 fan-out 触发 partner-discover |
| 5 | partner-port probe | `data\ad_partner_ports_probe.collect.ps1` 仍在 | 文件存在 |
| 6 | 业务数据 | centre DB `SELECT * FROM ad_partner_inbound WHERE agent_id='<新 agentId>'` | ≥ 1 行 |
| 7 | dashboard UI | `/admin/partner-discover/inbound` | 新 agent 行可见 |

## 7. 回滚

原 FLO1 旧 bundle 在 `D:\agentInstall\rollback\agent.r93.12-*`（如已建），
或直接重部署 `D:\agentInstall\kdlflofadsrv1-agent-backup\agent\` + 重置 appsettings.json 走 R93.12 路径。

---

最近一次升级：2026-09-30（operator 授权）
升级操作人：架构师本人
对应 dashboard memory：`Dashboard R158.9+ R93.12→R158.9 backup 升级`（待写）