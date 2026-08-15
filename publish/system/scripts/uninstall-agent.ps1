[CmdletBinding()]
param(
  [string]$InstallPath = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')) 'Agent'),
  [switch]$RemoveData
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'common\Logger.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\NSSM.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\Service.psm1') -Force

Write-Step "uninstalling agent on $env:COMPUTERNAME"
Remove-ServiceSafe -Name 'ADReplicationAgent'
if (Test-Path $InstallPath) { Remove-Item -Path $InstallPath -Recurse -Force }
# -RemoveData was a no-op alias for $InstallPath removal in the old layout.
# Kept for caller compatibility — InstallPath (which contains queue.db and
# logs) is already gone above.
Write-Ok "done"