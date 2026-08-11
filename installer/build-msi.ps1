[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$staging = Join-Path $root 'installer\staging'

# 1. Stage agent source (exclude tests + appsettings.json + node_modules + package-lock.json)
$agentSrc = Join-Path $root 'agent'
$agentDst = Join-Path $staging 'agent'
if (Test-Path $agentDst) { Remove-Item $agentDst -Recurse -Force }
# Use robocopy for reliable recursive copy with directory-name exclusion. robocopy
# is available on every Windows SKU since Windows 7 / Server 2008, so PS 5.1 +
# pwsh 7+ both inherit it. /MIR mirrors (deletes + copies), /XF excludes files
# by name, /XD excludes directories by name.
robocopy "$agentSrc" "$agentDst" /MIR /XD "node_modules" "tests" /XF "appsettings.json" "package-lock.json" | Out-Null

# 2. Stage appsettings.template.json
$templateDst = Join-Path $staging 'appsettings.template.json'
@'
{
  "centerUrl": "CHANGEME",
  "agentId": "AUTO_HOSTNAME",
  "agentToken": "CHANGEME",
  "logLevel": "info",
  "pollingIntervalMinutes": 15,
  "heartbeatIntervalSeconds": 5,
  "discoveryIntervalHours": 4,
  "queueDbPath": "INSTALLDIR\\queue.db",
  "psScriptPath": "INSTALLDIR\\scripts\\collect-replication.ps1",
  "psDiscoveryScriptPath": "INSTALLDIR\\scripts\\collect-discovery.ps1",
  "healthCheckIntervalMs": 600000,
  "agentType": "ad"
}
'@ | Set-Content -Path $templateDst -Encoding UTF8 -NoNewline

Push-Location (Join-Path $root 'installer\agent-installer')
try {
  dotnet build -c Release -p:Platform=x64
  if ($LASTEXITCODE -ne 0) { throw "dotnet build failed: $LASTEXITCODE" }
} finally { Pop-Location }
