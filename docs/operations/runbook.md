# AD Dashboard Operations Runbook

## Prerequisites

- **Node.js 18+** (LTS recommended) — the center service is Node, and the
  agent runs Node-based collection scripts.
- **NSSM** (Windows Service Helper) — installed by `scripts/install-center.ps1`
  via `Install-Module` if missing.
- **Database**: MySQL 5.7+ or SQL Server 2014+ (deploy-time choice).
- **PowerShell 5.1+** (ships with Windows 10/Server 2016+).
- For SQL Server deployments: `sqlcmd` on PATH (SQL Server Command Line
  Tools) — only needed when applying migrations manually.

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

1. Provision new management server with the database tier used previously (MySQL 8+ OR SQL Server 2014+ — see [Multi-Database Support](#multi-database-support) below)
2. Restore `AD_Monitoring` database from latest backup
3. Install center using the same dialect: `.\scripts\install-center.ps1 -DbDialect <mysql|mssql> -DbHost <host> -DbDatabase AD_Monitoring -DbUser <user> -DbPassword <pw> -AgentToken <same-as-before> -JwtSecret <same-as-before>` (see the multi-DB section for the full param set per dialect)
4. Verify `/healthz` returns 200

Agents continue running with their locally cached `appsettings.json` and buffered queue; once center URL is reachable again, they resume reporting.

## Database Migrations & Discovery

### Migrations

Database migrations live in `db/migrations/NNN-name.sql`. They are applied
automatically by `scripts/install-center.ps1` after the base schema.

To apply manually:

The installer applies migrations automatically after the base schema (see
[Multi-Database Support](#multi-database-support) below). To apply a
migration manually, use the CLI for your deployed dialect:

```powershell
# MySQL
Get-Content db\migrations\001-dc-site-discovery.sql | mysql -h <host> -P 3306 -u root -p<pwd> ad_monitoring

# SQL Server (requires sqlcmd on PATH)
Invoke-Sqlcmd -ServerInstance <host> -Database AD_Monitoring -InputFile db\migrations\mssql\001-dc-site-discovery.sql
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

## First-Run Setup Wizard

On first boot (or whenever no admin user exists), the center service
boots in **init mode** and serves a 3-screen browser wizard at
`http://server:8080/init`. The wizard:

1. **Screen 1 — Database connection**: pick MySQL or SQL Server, fill in
   host/port/database/user/password, click "Test connection" to verify,
   then "Next".
2. **Screen 2 — Administrator**: set the initial admin username and
   password (≥8 chars, with strength indicator).
3. **Screen 3 — Initialize**: auto-executes schema apply + seed + admin
   creation + writes `appsettings.json`. Shows progress per stage.

After init completes:
- `appsettings.json` exists on disk with the chosen DB config.
- `sys_users` has the new admin.
- `sys_roles` has the 3 default roles (admin/operator/viewer).
- `system_config` has the 7 default keys (ad_agent_token, polling_interval_minutes, etc.).
- `/init` redirects to `/login`.
- `/api/init/*` returns 404.

### Trigger conditions (init mode)

The server enters init mode when **any** of the following is true:
- `appsettings.json` is missing
- `appsettings.json` exists but has no `db.dialect` field
- `db.healthcheck()` fails (DB unreachable)
- `SELECT COUNT(*) FROM sys_users u JOIN sys_roles r ON u.role_id = r.id WHERE r.role_name = 'admin'` returns 0

### Recovery

If you need to re-run the wizard (e.g., after losing the admin password
and there's no other admin), you must clear **both** the init marker and
the admin row — the marker alone will block the wizard from re-appearing
even after deleting admins.

**Step 1 — clear the init marker** (one or both of):

- **File marker**: edit `<installPath>/.env` and delete the
  `ADDASHBOARD_INITIALIZED` and `ADDASHBOARD_INITIALIZED_AT` lines
  (save and close).
- **Windows registry**: open an elevated `cmd.exe` and run
  `reg delete "HKLM\SOFTWARE\ADDashboard" /v Initialized /f`.

**Step 2 — clear the admin row**:

```sql
DELETE FROM sys_users WHERE role_id IN (SELECT id FROM sys_roles WHERE role_name = 'admin');
```

**Step 3 — restart the service**:

```powershell
Restart-Service ADDashboardCenter
```

The wizard appears again at `http://server:8080/init`. To fully reset
to a clean install (different DB host, etc.), also delete
`appsettings.json` before restarting — the wizard will then require the
full DB connection + admin setup flow.

### Install flow

```bash
# 1. Deploy (install-center.ps1 — slimmed, deployment only)
.\scripts\install-center.ps1 -InstallPath 'C:\Program Files\ADDashboard\Center'

# 2. Open browser to http://server:8080/init
# 3. Complete the 3 screens
# 4. Log in at http://server:8080/login with the new admin credentials
```
