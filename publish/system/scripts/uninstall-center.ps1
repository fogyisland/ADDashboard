[CmdletBinding()]
param(
  [string]$InstallPath,
  [switch]$RemoveData
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

Write-Step "uninstalling center"
Remove-ServiceSafe -Name 'ADDashboardCenter'
if (Test-Path $InstallPath) { Remove-Item -Path $InstallPath -Recurse -Force; Write-Info "removed $InstallPath" }
# -RemoveData removed a hardcoded `C:\addashboard` tree in the old layout.
# In the script-relative layout there is no single parent to wipe (parent is
# the publish bundle which we must NOT delete). The flag is kept for caller
# compatibility and acts as a no-op; data persisted to MSSQL is unaffected.
Write-Ok "done"