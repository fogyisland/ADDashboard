# AD Replication Dashboard

Self-hosted dashboard for monitoring Active Directory replication health across multiple sites and DCs.

## Architecture

- **Agent** (per-DC): Windows Service that runs PowerShell collection on a schedule and POSTs results to Center
- **Center** (single): Windows Service exposing API + static frontend (Vue 3 + ECharts)
- **Storage**: SQL Server 2019+
- **Service manager**: NSSM

See [docs/superpowers/specs/2026-07-10-ad-dashboard-service-design.md](docs/superpowers/specs/2026-07-10-ad-dashboard-service-design.md) for the full design.

## Quick Start

```powershell
# On the center management server
.\scripts\install-center.ps1 -SqlServer localhost -ListenPort 8080

# On each DC
.\scripts\install-agent.ps1 -CenterUrl http://center:8080 -AgentToken <token>
```

## Development

```bash
npm install
npm test
npm run build:frontend
```

## Operations

- Runbook: [docs/operations/runbook.md](docs/operations/runbook.md)
- Troubleshooting: [docs/operations/troubleshooting.md](docs/operations/troubleshooting.md)
