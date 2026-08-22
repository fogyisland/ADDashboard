# AD Dashboard Center code-only update (legacy hot-fix path).
# Replaces code + node_modules + dist and restarts the service. Does NOT
# apply DB migrations or refresh shipped dist — for "扩展架构" deployments
# that include schema changes, use upgrade-center.ps1 instead. This script
# is intentionally minimal for the common case of "code-only hot-fix".
[CmdletBinding()]
param(
  [string]$InstallPath,
  [switch]$RebuildFrontend
)

# $PSScriptRoot is empty in [CmdletBinding()] default param values (parameter
# binding scope is a child of script scope; auto-vars only set in script scope).
# Resolve default InstallPath in the body where $PSScriptRoot is available.
if (-not $InstallPath) {
  $InstallPath = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')) 'Center')
}

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