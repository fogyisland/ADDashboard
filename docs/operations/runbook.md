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

1. Provision new management server with MySQL 8+
2. Restore `AD_Monitoring` database from latest backup
3. Install center: `.\scripts\install-center.ps1 -MySqlHost ... -MySqlPassword ... -AgentToken <same-as-before> -JwtSecret <same-as-before>`
4. Verify `/healthz` returns 200

Agents continue running with their locally cached `appsettings.json` and buffered queue; once center URL is reachable again, they resume reporting.

## Database Migrations & Discovery

### Migrations

Database migrations live in `db/migrations/NNN-name.sql`. They are applied
automatically by `scripts/install-center.ps1` after the base schema.

To apply manually:

```powershell
Get-Content db\migrations\001-dc-site-discovery.sql | mysql -h <host> -P 3306 -u root -p<pwd> ad_monitoring
```

To list applied migrations, query the implicit list (we track via
filename ordering, not a migrations table — see ADR-XXX if/when we add
a tracking table).

### DC/Site Discovery

Agents collect local DC metadata every `discovery_interval_hours` (default 4h)
and POST to `/api/agent/discover`. The center UPSERTs into `ad_dcs`; `site_id`
is never touched by the agent.

Admins maintain sites via `/admin/sites-catalog` and assign DCs via
`/admin/dcs-catalog`. The `/admin/site-replication-matrix` page shows the
DC×DC replication matrix for a selected site and auto-refreshes every
`site_matrix_refresh_seconds` (default 10s).

## Multi-Database Support

The center service supports both MySQL 5.7+ and SQL Server 2014+ via deploy-time
selection. Pick one dialect in `appsettings.json` (or via the installer parameter);
the service does not switch at runtime.

### MySQL 5.7+ (default)

`appsettings.json`:
```json
{
  "db": {
    "dialect": "mysql",
    "mysql": { "host": "...", "port": 3306, "database": "...", "user": "...", "password": "..." }
  }
}
```

Bootstrap:
```
.\scripts\install-center.ps1 -DbDialect mysql -DbHost <host> -DbPort 3306 -DbDatabase ad_monitoring -DbUser root -DbPassword <pw>
```

### SQL Server 2014+

`appsettings.json`:
```json
{
  "db": {
    "dialect": "mssql",
    "mssql": { "server": "...", "database": "...", "user": "...", "password": "...", "encrypt": false }
  }
}
```

Operator must pre-create the empty database before running the installer.

Bootstrap:
```
.\scripts\install-center.ps1 -DbDialect mssql -DbHost <server> -DbDatabase ad_monitoring -DbUser sa -DbPassword <pw>
```

Requires `sqlcmd` on PATH (SQL Server Command Line Tools).

### Schema and migration layout

```
db/
├── schema/
│   ├── 01-tables.sql           # mysql (default; legacy alias)
│   ├── 02-seed-roles.sql       # mysql
│   ├── mysql/                  # canonical mysql location
│   │   ├── 01-tables.sql
│   │   └── 02-seed-roles.sql
│   └── mssql/
│       ├── 01-tables.sql
│       └── 02-seed-roles.sql
└── migrations/
    ├── 001-dc-site-discovery.sql  # mysql (legacy alias)
    ├── mysql/
    │   └── 001-dc-site-discovery.sql
    └── mssql/
        └── 001-dc-site-discovery.sql
```

### Integration testing

```bash
# Run all integration tests against mysql:
TEST_SQL_URL=127.0.0.1 npm test --workspace=center

# Run against sql server:
TEST_MSSQL_URL=myserver.local npm test --workspace=center

# Run against both:
TEST_SQL_URL=127.0.0.1 TEST_MSSQL_URL=myserver.local npm test --workspace=center
```

If neither env is set, integration tests skip and only mock-based unit tests run.
