# AD Dashboard Operations Runbook

## Services

| Service | Machine | Display Name | NSSM Name |
|---------|---------|--------------|-----------|
| Center  | Center management server | AD Replication Dashboard Center | `ADDashboardCenter` |
| Agent   | Each DC | AD Replication Agent (on `<hostname>`) | `ADReplicationAgent` |

## Common Commands

```powershell
# Service status (all DCs)
Get-Service ADReplicationAgent, ADDashboardCenter | Format-Table Name, Status, StartType, MachineName

# Restart agent locally
Restart-Service ADReplicationAgent -Force

# Tail agent logs
Get-Content "C:\ProgramData\ADDashboard\Logs\ADReplicationAgent-stdout.log" -Tail 100 -Wait

# Tail center logs
Get-Content "C:\ProgramData\ADDashboard\Logs\ADDashboardCenter-stdout.log" -Tail 100 -Wait

# Health check
Invoke-WebRequest http://center:8080/healthz | Select -ExpandProperty Content
```

## Routine Maintenance

### Add a new DC

1. Verify WinRM access from center to new DC: `Test-WSMan -ComputerName <newdc>`
2. Run `.\scripts\install-agent.ps1 -ComputerName <newdc> -CenterUrl http://center:8080 -AgentToken <token>`
3. Wait 60 seconds, then verify in Dashboard → Agent 列表 (or `GET /api/dashboard/agents`)

### Change polling interval

1. Sign in as admin
2. Navigate to 管理 → 系统配置
3. Edit `polling_interval_minutes`, save
4. Agents pick up new value on next 5-minute config refresh (or restart agent to apply immediately)

### Update Center

```powershell
# On center management server
cd C:\Repos\ADDashboard
git pull
.\scripts\update-center.ps1 -RebuildFrontend
```

### Update Agents (rolling)

```powershell
# Update one at a time, verify health between each
.\scripts\install-agent.ps1 -ComputerName DC-BJ-01 -CenterUrl http://center:8080 -AgentToken <token>
# This script calls Stop-ServiceSafe → copy → Start-ServiceSafe
```

### Database backup

```powershell
sqlcmd -S localhost -Q "BACKUP DATABASE [AD_Monitoring] TO DISK='D:\Backups\AD_Monitoring_<date>.bak'"
```

### Rotate Agent Token

1. Generate new UUID: `[Guid]::NewGuid().Guid`
2. Sign in as admin → 管理 → 系统配置 → set `ad_agent_token` to new value
3. On every DC: edit `C:\Program Files\ADDashboard\Agent\appsettings.json` → `agentToken`, then `Restart-Service ADReplicationAgent`

## Disaster Recovery

### Center machine lost

1. Provision new management server with SQL Server
2. Restore `AD_Monitoring` database from latest backup
3. Install center: `.\scripts\install-center.ps1 -SqlServer ... -SqlPassword ... -AgentToken <same-as-before> -JwtSecret <same-as-before>`
4. Verify `/healthz` returns 200

Agents continue running with their locally cached `appsettings.json` and buffered queue; once center URL is reachable again, they resume reporting.