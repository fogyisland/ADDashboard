# AD Dashboard Center update — post-install unified entry.
# Parallel to start.ps1 (first-time install); this is the user-facing
# entry for subsequent updates. Always rebuilds the frontend locally
# (npm run build:frontend) so server-dist matches local-source — fixes
# the stale-UI trap where the shipped bundle drifted from local changes.
#
# Equivalent to: upgrade-center.ps1 -RebuildFrontend
[CmdletBinding()]
param(
  [string]$InstallPath,
  [int]$ListenPort = 8080,
  [string]$AdminUser = 'admin',
  [Parameter(Mandatory)][string]$AdminPassword
)

$ErrorActionPreference = 'Stop'
$bundleRoot = Resolve-Path (Join-Path $PSScriptRoot 'scripts')
$upgradeScript = Join-Path $bundleRoot 'upgrade-center.ps1'
$forward = @{
  InstallPath   = $InstallPath
  ListenPort    = $ListenPort
  AdminUser     = $AdminUser
  AdminPassword = $AdminPassword
}
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $upgradeScript @forward -RebuildFrontend
exit $LASTEXITCODE
