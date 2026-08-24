<#
.SYNOPSIS
  AD Replication Dashboard — green-bundle entry (PowerShell).

.DESCRIPTION
  Install-only operator entry. Registers the ADDashboardCenter NSSM service
  pointing at <bundleRoot>\center and starts it. Idempotent — re-running on an
  already-installed host refreshes NSSM parameters (path, app args, recovery)
  without disturbing the running service or its data.

  Updates are a separate flow: copy new code into the install dir, then hit
  POST http://localhost:8080/api/system/update from the same host. The
  endpoint applies any pending DB migrations and schedules a process exit so
  NSSM picks the new code on the next launch. No password, no admin shell.

  -Console: run node server.js in foreground (dev mode, no service).
  -Help:    show usage.

.EXAMPLE
  .\start.ps1              # install (or refresh params of) ADDashboardCenter
  .\start.ps1 -Console     # foreground dev (no service)
  .\start.ps1 -Help        # usage
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
  (default)   install (or refresh) ADDashboardCenter NSSM service.
              Idempotent — safe to re-run after a code change to refresh
              NSSM parameters without disturbing the running service.
  -Console    run node server.js in foreground (dev mode, no service)
  -Help       show this message

Updates:
  1. Copy new code into the install directory (overwrite).
  2. POST http://localhost:8080/api/system/update
     (no auth, localhost-only; applies pending DB migrations + restarts).
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

# Service install / refresh requires Administrator (NSSM registers a service
# in HKLM). install-center.ps1 -InPlace is itself idempotent: on a fresh host
# it registers the service; on an existing host it refreshes NSSM parameters
# (path, AppParameters, AppDirectory, log rotation, recovery) without
# disturbing the running process or its data.
$ps = Get-Command powershell.exe -ErrorAction SilentlyContinue
if (-not $ps) { Write-Host '[start] PowerShell not found.' -ForegroundColor Red; exit 1 }
if (-not (Test-IsAdministrator)) {
  Write-Host '[start] Service install/refresh requires Administrator. Re-run from an elevated PowerShell.' -ForegroundColor Red
  exit 1
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $bundleRoot 'scripts\install-center.ps1') -InPlace
exit $LASTEXITCODE
