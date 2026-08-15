[CmdletBinding()]
param(
  [string]$InstallPath = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')) 'Center'),
  [switch]$RemoveData
)
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