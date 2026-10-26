# DEPLOY — NoAD agent bundle (R158.75)

> Install this bundle on a member-server (non-AD) Windows host that should register itself with the centre as `agent_type: 'non-ad'` and pull per-host packages.

## Prerequisites

- Windows Server / Windows client (PowerShell 5.1+)
- Node.js 18+ (the same LTS used by the AD fleet agent bundle)
- Network connectivity to the centre (`<centerUrl>` e.g. `http://center:8080`)
- Agent token from centre — obtained from `system_config.agent_token_current` (centre's seed; do **not** copy the legacy `appsettings.agentToken` from AD fleet — that path was orphaned in R158.69.9 and the values diverge).
- NSSM installed (used to register the agent as a Windows service)

## Step 1 — back up the existing install

```powershell
$stamp = Get-Date -Format 'yyyy-MM-dd'
if (Test-Path D:\NoADagentInstall\agent) {
  Copy-Item -Recurse -Force D:\NoADagentInstall\agent D:\NoADagentInstall\agent.bak.$stamp
}
```

If a backup from a previous ship exists, rename it to `agent.bak.<date-of-this-ship>` instead.

## Step 2 — copy the new bundle

Copy the bundle source tree to the install dir. Exclude per-host files (appsettings, version, data, node_modules) — robocopy's `/XF`/`/XD` flags do this.

```powershell
robocopy D:\dashboard\noadagent D:\NoADagentInstall\agent `
  /E `
  /XD node_modules data `
  /XF appsettings.json version.inf package-lock.json
```

If `D:\NoADagentInstall\agent\node_modules\` does not exist yet (fresh install):

```powershell
cd D:\NoADagentInstall\agent
npm install --omit=dev
```

## Step 3 — edit appsettings.json

Open `D:\NoADagentInstall\agent\appsettings.json` (create from `appsettings.example.json` if missing):

```json
{
  "centerUrl": "http://<your-center-host>:8080",
  "agentId": "<hostname>",         // e.g. "KDLBJOFADSRV1"
  "agentToken": "<system_config.agent_token_current>",
  "agentType": "non-ad",            // R158.75 default; can stay as-is
  "psScriptPath": "C:\\NoADagentInstall\\agent\\scripts\\collect.ps1",
  "agentDataDir": "C:\\NoADagentInstall\\agent\\data",
  ...
}
```

`agentToken` is **critical** — copy the current value from the centre's `system_config` table, not from any AD fleet's `appsettings.json`. The centre tokens are 96 chars; legacy AD appsettings values are 32 chars and will 401 forever (R158.69.9 lesson).

## Step 4 — register or restart the service

If `NSSM service ADDashboardAgent` does not yet exist (fresh install):

```powershell
nssm install ADDashboardAgent "C:\node.exe" "D:\NoADagentInstall\agent\agent.js"
nssm set ADDashboardAgent AppDirectory D:\NoADagentInstall\agent
nssm set ADDashboardAgent AppStdout D:\NoADagentInstall\agent\data\agent-stdout.log
nssm set ADDashboardAgent AppStderr D:\NoADagentInstall\agent\data\agent-stderr.log
nssm set ADDashboardAgent AppRotateFiles 1
nssm set ADDashboardAgent AppRotateBytes 10485760   # 10 MB
nssm set ADDashboardAgent Start SERVICE_AUTO_START
```

For an existing service:

```powershell
nssm restart ADDashboardAgent
```

## Step 5 — observe boot

Watch stderr for the boot markers:

```powershell
Get-Content D:\NoADagentInstall\agent\data\agent-stderr.log -Tail 50 -Wait
```

Expected sequence (within ~10 seconds of restart):

1. `agent starting` — loadConfig completed
2. `dashboard listening on http://127.0.0.1:<port>/` (if `dashboardEnabled: true`)
3. `self-register ok` — POST `/api/admin/member-servers/self-register` succeeded
4. `non-ad agent started` — boot terminal statement reached

The string `non-ad agent started` is the unambiguous success marker for this bundle. If you see `agent started` *without* the `non-ad` prefix, you're running the AD bundle (`D:\dashboard\agent\`) instead — verify the file in `agent.js` top-of-file header comment.

## Step 6 — verify on the centre

Open `/admin/member-servers` in the dashboard. The new hostname should appear with:
- `discovered_via` = `self-register`
- `agent_type` = `non-ad`
- `enabled` = 1
- `site_id` = NULL (operator assigns via the ports UI per R158.74)

In the SQL view:

```sql
SELECT id, hostname, agent_version, agent_type, discovered_via, created_at
FROM ad_member_servers
WHERE discovered_via = 'self-register'
ORDER BY id DESC LIMIT 5;
```

The audit log should also have a row:

```sql
SELECT id, action, target_hostname, created_at
FROM ad_audit_log
WHERE action = 'agent_self_register'
ORDER BY id DESC LIMIT 5;
```

## Step 7 — heartbeat check

Wait 60 seconds, then look for the agent's heartbeat:

```sql
SELECT TOP 5 agent_id, agent_type, hostname, created_at
FROM ad_agent_heartbeat
WHERE agent_type = 'non-ad'
ORDER BY id DESC;
```

If the row appears, the agent is fully wired.

## Optional — publish a non-AD package and verify round-trip

1. Centre → `/admin/packages` → publish a package with `agent.type = 'non-ad'`, `platforms = ['windows']`, `intervalSec = 300`.
2. Wait up to 5 minutes for the agent's `pollPackages` cadence.
3. Centre → `/admin/member-servers/<hostname>/ports` (or the package-run report endpoint) — confirm one run row per package.

## Rollback

If anything is broken, see `REFACTOR_NOTES.md` "Rollback procedure". The backup from step 1 is the primary recovery asset.

## What this bundle does NOT do

- It does NOT register itself as an AD/DC. It cannot collect replication data. Centre-side AD endpoints (`/api/agent/commands`, `/api/agent/discover`, `/api/agent/report`, `/api/agent/ports`) remain in place but are unreachable from this bundle.
- It does NOT auto-upgrade. Centre's `agent-upgrade-source.js` reads only `<repoRoot>/agent/` (the AD lineage); this fork is operator-managed.
- It does NOT bundle node_modules. Run `npm install` once after copy.