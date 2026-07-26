<#
.SYNOPSIS
  AD Replication Dashboard — green-bundle entry (PowerShell).

.DESCRIPTION
  Default: install + start ADDashboardCenter Windows service (idempotent), then exit.
  -Console: run node server.js in foreground (dev mode).
  -Help:    show usage.

.EXAMPLE
  .\start.ps1
  .\start.ps1 -Console
#>
[CmdletBinding()]
param(
  [switch]$Console,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'
$bundleRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Test-IsAdministrator {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $pr = New-Object Security.Principal.WindowsPrincipal($id)
  return $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if ($Help) {
  @'
Usage: start.ps1 [-Console] [-Help]
  (default)   install + start ADDashboardCenter Windows service, then exit
  -Console    run node server.js in foreground (dev mode)
  -Help       show this message
'@ | Write-Host
  exit 0
}

if ($Console) {
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node) { Write-Host '[console] Node.js not found in PATH.' -ForegroundColor Red; exit 1 }
  Push-Location (Join-Path $bundleRoot 'center')
  try { & node server.js } finally { Pop-Location }
  exit $LASTEXITCODE
}

# Service mode
$ps = Get-Command powershell.exe -ErrorAction SilentlyContinue
if (-not $ps) { Write-Host '[start] PowerShell not found.' -ForegroundColor Red; exit 1 }
if (-not (Test-IsAdministrator)) {
  Write-Host '[start] Service install requires Administrator. Re-run from an elevated PowerShell.' -ForegroundColor Red
  exit 1
}
$installer = Join-Path $bundleRoot 'scripts\install-center.ps1'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -InPlace
exit $LASTEXITCODE