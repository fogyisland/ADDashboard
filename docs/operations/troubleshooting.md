# AD Dashboard Troubleshooting

> **路径约定**：本文示例用 `$DashboardRoot` 占位 dashboard 安装根目录。脚本默认 install 路径是脚本相对的 `<publish-root>/Center` 和 `<publish-root>/Agent`（可解压到任意位置运行）；若你想装到其他位置（典型如 `D:\dashboard`），复制命令前先 `Set-Variable DashboardRoot 'D:\dashboard'`，所有示例的 `$DashboardRoot` 即解析为该路径。

## Quick Triage

```powershell
# 1. Are services running?
Get-Service ADReplicationAgent, ADDashboardCenter

# 2. Is center reachable?
Invoke-WebRequest http://center:8080/healthz

# 3. Are agents heartbeating?
# Sign in → Agent 列表 (or GET /api/dashboard/agents)

# 4. What do logs say?
Get-Content "$DashboardRoot\Logs\ADDashboardCenter-stderr.log" -Tail 200
Get-Content "$DashboardRoot\Logs\ADReplicationAgent-stderr.log" -Tail 200
```

## Common Symptoms

### Symptom: Agent反复重启 (status: StartPending → Stopped)

**Likely causes:** PowerShell script error, missing AD module, config file typo

**Steps:**
1. `Get-EventLog Application -Source NSSM -Newest 20`
2. `Get-Content "$DashboardRoot\Logs\ADReplicationAgent-stderr.log" -Tail 100`
3. Look for: `Cannot find module 'ActiveDirectory'` → install RSAT
4. Look for: `appsettings.json: ENOENT` → path contains spaces or wrong location
5. Manually run: `& "$DashboardRoot\Agent\agent.js"` to see Node.js stack trace

### Symptom: Agent心跳正常但无数据

**Steps:**
1. Verify `Test-NetConnection center -Port 8080` from the DC
2. Compare `appsettings.json` `agentToken` to `system_config.ad_agent_token` (sign in as admin → 管理 → 系统配置)
3. On the DC, manually invoke PS: `powershell -File "$DashboardRoot\Agent\scripts\collect-replication.ps1"` — should output JSON
4. If PS errors out with "active directory module not loaded": `Install-WindowsFeature -Name RSAT-AD-PowerShell`

### Symptom: Center启动失败 (status: Stopped immediately)

**Steps:**
1. `nssm get ADDashboardCenter` — show full config
2. `Get-Content "$DashboardRoot\Logs\ADDashboardCenter-stderr.log" -Tail 100`
3. Most common:
   - `ECONNREFUSED 127.0.0.1:1433` → SQL Server not running or wrong port
   - `Login failed for user 'sa'` → wrong SQL password in `appsettings.json`
   - `EADDRINUSE :::8080` → port 8080 occupied (`netstat -ano | findstr :8080`)
4. After fix, `Start-Service ADDashboardCenter`

### Symptom: 前端 502 Bad Gateway

**Likely cause:** Center process exited; check `center-stderr.log` for unhandled exception
**Steps:**
1. `Get-Service ADDashboardCenter` (likely Stopped)
2. `Get-Content "$DashboardRoot\Logs\ADDashboardCenter-stderr.log" -Tail 200`
3. Common: OOM (check `Get-Process | Sort-Object WorkingSet -Descending | Select -First 5`); reduce log level
4. Restart: `Start-Service ADDashboardCenter`

### Symptom: 数据长时间不更新

**Steps:**
1. `GET /api/dashboard/agents` — check `seconds_since_heartbeat`
2. If all agents stale:
   - Center may be unreachable from DCs
   - Check firewall: `Test-NetConnection -ComputerName center -Port 8080` from any DC
3. If individual agents stale:
   - That specific DC: `Get-Service ADReplicationAgent`
   - Check its stderr log

### Symptom: 错误码 1722 (RPC server unavailable)

**Operator guidance:** shown directly in `frontend/src/components/ErrorTable.vue` CODES map.
**Steps to investigate:**
1. From destination DC: `Test-NetConnection -ComputerName <source_dc> -Port 135`
2. Check Windows Firewall on source DC allows inbound from destination subnet
3. Check `dcdiag /test:rpc` on source DC

### Symptom: 端口徽章全红

**Likely causes:** 该端口业务确实停 / Windows 防火墙拦截 / 端口被其他进程占用

**Steps:**
1. 从该 DC 直接验证：`Test-NetConnection -ComputerName localhost -Port <port>`（应该是 True/False）
2. 若 True 但 agent 报红：检查 `$DashboardRoot\Logs\ADReplicationAgent-stderr.log` 看 `tcpProbe` 异常
3. 若 False：业务停或服务没启，跟端口业务核对
4. 跨 DC 对比：若只有某台 DC 报红，检查该 DC 的 Windows Firewall inbound 规则

### Symptom: 端口徽章全灰 (—)

**Likely cause:** Agent 还没上报端口数据，或 system_ports 清单为空

**Steps:**
1. 登录 admin → `/admin/ports`——若清单为空，先加要监控的端口
2. 等 5s（agent 下一个心跳周期），Agents 视图应出现徽章
3. 若清单非空但仍全灰：
   - `GET /api/dashboard/agents` 的 `portStatuses` 应非空——查 agent 是否在跑：`Get-Service ADReplicationAgent`
   - agent 日志看 `fetchPortList` 是否报错（401/网络/DNS）

### Symptom: Agent 启动后没有任何端口数据

**Likely cause:** agent 拉取端口清单失败（`fetchPortList` 永不抛错，所以 agent 不会因此退出）

**Steps:**
1. `Get-Content "$DashboardRoot\Logs\ADReplicationAgent-stdout.log" -Tail 200` — 找 `fetchPortList` 相关错误
2. 验证 center 端：`Invoke-WebRequest http://center:8080/api/agent/ports -Headers @{Authorization="Bearer <agentToken>"}`（用 `appsettings.json` 里的 agentToken）
3. 401 → agentToken 不匹配；500 → center 端 DB 故障

### Symptom: 错误码 1311 (DNS)

**Steps:**
1. From destination DC: `nslookup <source_dc>.<domain>`
2. If fails, check DNS server config and `dcdiag /test:dns` on both DCs

### Symptom: "The memory usage exceeded" warnings

**Likely cause:** Better-sqlite3 native module in agent not closing transactions
**Steps:**
1. Restart agent: `Restart-Service ADReplicationAgent`
2. Apply update if newer version available: `.\scripts\upgrade-agent.ps1` (auto-detects install vs hot-update; prompts for CenterUrl/AgentToken on first-time install)

## Diagnostic Data Collection

When escalating, capture:
```powershell
# Service config
nssm get ADDashboardCenter > nssm-center.txt
nssm get ADReplicationAgent > nssm-agent.txt

# Recent logs
Copy-Item "$DashboardRoot\Logs\*-stdout.log" .
Copy-Item "$DashboardRoot\Logs\*-stderr.log" .

# Health snapshot
Invoke-WebRequest http://center:8080/healthz | % Content
(Invoke-WebRequest http://center:8080/api/dashboard/overview -Headers @{Authorization="Bearer $t"} -UseBasicParsing).Content
```
