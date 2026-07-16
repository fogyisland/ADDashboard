[CmdletBinding()]
param(
  [string]$InstallPath = 'C:\addashboard\Center',
  [switch]$RebuildFrontend
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'common\Logger.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\NSSM.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\Service.psm1') -Force

Write-Step "stopping service"
if (-not (Stop-ServiceSafe -Name 'ADDashboardCenter' -WaitSeconds 30)) { throw 'cannot stop service' }

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
if ($RebuildFrontend) {
  Write-Step "rebuilding frontend"
  Push-Location $repoRoot; try { npm run build:frontend } finally { Pop-Location }
}
Write-Step "copying files"
Copy-Item -Path (Join-Path $repoRoot 'center\*') -Destination $InstallPath -Recurse -Force -Exclude 'node_modules','tests','appsettings.json'
Push-Location $InstallPath; try { npm install --omit=dev } finally { Pop-Location }
if ($RebuildFrontend -and (Test-Path (Join-Path $repoRoot 'frontend\dist'))) {
  Copy-Item -Path (Join-Path $repoRoot 'frontend\dist\*') -Destination (Join-Path $InstallPath 'dist') -Recurse -Force
}
Write-Step "starting service"
Start-ServiceSafe -Name 'ADDashboardCenter' -WaitSeconds 20 | Out-Null
Write-Ok "update complete"