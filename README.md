# AD Replication Dashboard

Self-hosted dashboard for monitoring Active Directory replication health across multiple sites and DCs.

## Architecture

- **Agent** (per-DC): Windows Service that runs PowerShell collection on a schedule and POSTs results to Center
- **Center** (single): Windows Service exposing API + static frontend (Vue 3 + ECharts)
- **Storage**: MySQL 8+
- **Service manager**: NSSM

See [docs/superpowers/specs/2026-07-10-ad-dashboard-service-design.md](docs/superpowers/specs/2026-07-10-ad-dashboard-service-design.md) for the full design.

## Prerequisites

- **Node.js 18+** — center service is Node; agent uses Node-based scripts
- **NSSM** — Windows Service Helper (auto-installed by installer)
- **MySQL 5.7+** or **SQL Server 2014+**
- **PowerShell 5.1+**

## Quick Start

```bash
# 1. Deploy (PowerShell installer — handles NSSM service registration, file copy, service start)
.\scripts\install-center.ps1

# 2. Open browser to http://localhost:8080/init
#    Complete the 3-screen setup wizard:
#    - Database connection (MySQL or SQL Server)
#    - Administrator account
#    - Initialize schema + seed

# 3. Log in at http://localhost:8080/login
```

See [docs/operations/runbook.md](docs/operations/runbook.md#first-run-setup-wizard) for details.

## Development

```bash
npm install
npm test
npm run build:frontend
```

## Operations

- Runbook: [docs/operations/runbook.md](docs/operations/runbook.md)
- Troubleshooting: [docs/operations/troubleshooting.md](docs/operations/troubleshooting.md)
- First-run setup wizard: serve from the center service at `/init` when no admin user exists. See [runbook](docs/operations/runbook.md#first-run-setup-wizard).

## Multi-Database Backend

The `center` service supports both **MySQL 5.7+** and **SQL Server 2014+**.
Pick the dialect in `appsettings.json` via `db.dialect`. The same codebase
runs against either database; deploy-time selection only.

See `docs/operations/runbook.md` for full setup instructions.
