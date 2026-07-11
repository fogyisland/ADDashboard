# AD Dashboard Troubleshooting

## Quick Triage

```powershell
# 1. Are services running?
Get-Service ADReplicationAgent, ADDashboardCenter

# 2. Is center reachable?
Invoke-WebRequest http://center:8080/healthz

# 3. Are agents heartbeating?
# Sign in → Agent 列表 (or GET /api/dashboard/agents)

# 4. What do logs say?
Get-Content "C:\ProgramData\ADDashboard\Logs\ADDashboardCenter-stderr.log" -Tail 200
Get-Content "C:\ProgramData\ADDashboard\Logs\ADReplicationAgent-stderr.log" -Tail 200
```

## Common Symptoms

### Symptom: Agent反复重启 (status: StartPending → Stopped)

**Likely causes:** PowerShell script error, missing AD module, config file typo

**Steps:**
1. `Get-EventLog Application -Source NSSM -Newest 20`
2. `Get-Content "C:\ProgramData\ADDashboard\Logs\ADReplicationAgent-stderr.log" -Tail 100`
3. Look for: `Cannot find module 'ActiveDirectory'` → install RSAT
4. Look for: `appsettings.json: ENOENT` → path contains spaces or wrong location
5. Manually run: `& "C:\Program Files\ADDashboard\Agent\agent.js"` to see Node.js stack trace

### Symptom: Agent心跳正常但无数据

**Steps:**
1. Verify `Test-NetConnection center -Port 8080` from the DC
2. Compare `appsettings.json` `agentToken` to `system_config.ad_agent_token` (sign in as admin → 管理 → 系统配置)
3. On the DC, manually invoke PS: `powershell -File "C:\Program Files\ADDashboard\Agent\scripts\collect-replication.ps1"` — should output JSON
4. If PS errors out with "active directory module not loaded": `Install-WindowsFeature -Name RSAT-AD-PowerShell`

### Symptom: Center启动失败 (status: Stopped immediately)

**Steps:**
1. `nssm get ADDashboardCenter` — show full config
2. `Get-Content "C:\ProgramData\ADDashboard\Logs\ADDashboardCenter-stderr.log" -Tail 100`
3. Most common:
   - `ECONNREFUSED 127.0.0.1:1433` → SQL Server not running or wrong port
   - `Login failed for user 'sa'` → wrong SQL password in `appsettings.json`
   - `EADDRINUSE :::8080` → port 8080 occupied (`netstat -ano | findstr :8080`)
4. After fix, `Start-Service ADDashboardCenter`

### Symptom: 前端 502 Bad Gateway

**Likely cause:** Center process exited; check `center-stderr.log` for unhandled exception
**Steps:**
1. `Get-Service ADDashboardCenter` (likely Stopped)
2. `Get-Content "C:\ProgramData\ADDashboard\Logs\ADDashboardCenter-stderr.log" -Tail 200`
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

### Symptom: 错误码 1311 (DNS)

**Steps:**
1. From destination DC: `nslookup <source_dc>.<domain>`
2. If fails, check DNS server config and `dcdiag /test:dns` on both DCs

### Symptom: "The memory usage exceeded" warnings

**Likely cause:** Better-sqlite3 native module in agent not closing transactions
**Steps:**
1. Restart agent: `Restart-Service ADReplicationAgent`
2. Apply update if newer version available: `.\scripts\update-agent.ps1`

## Diagnostic Data Collection

When escalating, capture:
```powershell
# Service config
nssm get ADDashboardCenter > nssm-center.txt
nssm get ADReplicationAgent > nssm-agent.txt

# Recent logs
Copy-Item "C:\ProgramData\ADDashboard\Logs\*-stdout.log" .
Copy-Item "C:\ProgramData\ADDashboard\Logs\*-stderr.log" .

# Health snapshot
Invoke-WebRequest http://center:8080/healthz | % Content
(Invoke-WebRequest http://center:8080/api/dashboard/overview -Headers @{Authorization="Bearer $t"} -UseBasicParsing).Content
```
