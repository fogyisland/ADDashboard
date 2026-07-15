[CmdletBinding()]
param([string]$InstallPath = 'C:\addashboard\Agent')
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'common\Logger.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\NSSM.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\Service.psm1') -Force

if (-not (Stop-ServiceSafe -Name 'ADReplicationAgent' -WaitSeconds 30)) { throw 'cannot stop' }
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Copy-Item -Path (Join-Path $repoRoot 'agent\*') -Destination $InstallPath -Recurse -Force -Exclude 'node_modules','tests','appsettings.json'
Push-Location $InstallPath; try { npm install --omit=dev } finally { Pop-Location }
Copy-Item -Path (Join-Path $repoRoot 'agent\scripts\collect-replication.ps1') -Destination (Join-Path $InstallPath 'scripts') -Force
Start-ServiceSafe -Name 'ADReplicationAgent' -WaitSeconds 20 | Out-Null
Write-Ok "agent update complete"