[CmdletBinding()]
param(
  [string]$InstallPath = 'C:\Program Files\ADDashboard\Agent',
  [switch]$RemoveData
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'common\Logger.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\NSSM.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\Service.psm1') -Force

Write-Step "uninstalling agent on $env:COMPUTERNAME"
Remove-ServiceSafe -Name 'ADReplicationAgent'
if (Test-Path $InstallPath) { Remove-Item -Path $InstallPath -Recurse -Force }
if ($RemoveData) { Remove-Item -Path 'C:\ProgramData\ADDashboard\Agent' -Recurse -Force }
Write-Ok "done"