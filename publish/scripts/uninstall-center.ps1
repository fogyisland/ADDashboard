[CmdletBinding()]
param(
  [string]$InstallPath = 'C:\addashboard\Center',
  [switch]$RemoveData
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'common\Logger.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\NSSM.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\Service.psm1') -Force

Write-Step "uninstalling center"
Remove-ServiceSafe -Name 'ADDashboardCenter'
if (Test-Path $InstallPath) { Remove-Item -Path $InstallPath -Recurse -Force; Write-Info "removed $InstallPath" }
if ($RemoveData) { Remove-Item -Path 'C:\addashboard' -Recurse -Force }
Write-Ok "done"