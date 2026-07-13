# AD Replication Dashboard

Self-hosted dashboard for monitoring Active Directory replication health across multiple sites and DCs.

## Architecture

- **Agent** (per-DC): Windows Service that runs PowerShell collection on a schedule and POSTs results to Center
- **Center** (single): Windows Service exposing API + static frontend (Vue 3 + ECharts)
- **Storage**: MySQL 8+
- **Service manager**: NSSM

See [docs/superpowers/specs/2026-07-10-ad-dashboard-service-design.md](docs/superpowers/specs/2026-07-10-ad-dashboard-service-design.md) for the full design.

## Quick Start

```powershell
# On the center management server (MySQL 5.7+ — default dialect)
.\scripts\install-center.ps1 -DbDialect mysql -DbHost localhost -DbDatabase ad_monitoring -DbUser root -DbPassword <pw> -ListenPort 8080

# Or for SQL Server 2014+
.\scripts\install-center.ps1 -DbDialect mssql -DbHost <server> -DbDatabase AD_Monitoring -DbUser sa -DbPassword <pw> -ListenPort 8080

# On each DC
.\scripts\install-agent.ps1 -CenterUrl http://center:8080 -AgentToken <token>
```

For full per-dialect parameter lists and appsettings examples, see
[docs/operations/runbook.md](docs/operations/runbook.md#multi-database-support).

## Development

```bash
npm install
npm test
npm run build:frontend
```

## Operations

- Runbook: [docs/operations/runbook.md](docs/operations/runbook.md)
- Troubleshooting: [docs/operations/troubleshooting.md](docs/operations/troubleshooting.md)

## Multi-Database Backend

The `center` service supports both **MySQL 5.7+** and **SQL Server 2014+**.
Pick the dialect in `appsettings.json` via `db.dialect`. The same codebase
runs against either database; deploy-time selection only.

See `docs/operations/runbook.md` for full setup instructions.
