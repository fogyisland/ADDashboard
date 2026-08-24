<#
.SYNOPSIS
  AD Replication Dashboard — green-bundle entry (PowerShell).

.DESCRIPTION
  Unified operator entry. Detects install vs update automatically:
    - ADDashboardCenter service NOT registered → install-center.ps1 -InPlace (first-time setup)
    - ADDashboardCenter service already exists   → hot-restart (picks up edited code, no install)
  No admin password required for either path; this is the local-green workflow.

  -Console: run node server.js in foreground (dev mode, no service).
  -Help:    show usage.

.EXAMPLE
  .\start.ps1              # install OR hot-restart, picks up code edits
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
  (default)   install + start ADDashboardCenter service (first time),
              OR hot-restart the existing service (subsequent runs).
              No password required. Operator edits code in <bundleRoot>\center,
              re-runs .\start.ps1, service restarts with new code.
  -Console    run node server.js in foreground (dev mode, no service)
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

# Service mode (install OR hot-restart; no password needed for either).
$ps = Get-Command powershell.exe -ErrorAction SilentlyContinue
if (-not $ps) { Write-Host '[start] PowerShell not found.' -ForegroundColor Red; exit 1 }
if (-not (Test-IsAdministrator)) {
  Write-Host '[start] Service install/restart requires Administrator. Re-run from an elevated PowerShell.' -ForegroundColor Red
  exit 1
}

$svc = Get-Service -Name 'ADDashboardCenter' -ErrorAction SilentlyContinue
if ($svc) {
  # Hot-restart path: service already registered, just bounce it so the edited
  # code under <bundleRoot>\center takes effect. No install, no password.
  Write-Host "[start] ADDashboardCenter already installed ($($svc.Status)) — hot-restart" -ForegroundColor Cyan
  try {
    Restart-Service -Name 'ADDashboardCenter' -Force -ErrorAction Stop
    Write-Host '[start] restart issued, waiting for service to settle' -ForegroundColor Cyan
    Start-Sleep -Seconds 2
    $after = Get-Service -Name 'ADDashboardCenter' -ErrorAction SilentlyContinue
    Write-Host "[start] post-restart status: $($after.Status)" -ForegroundColor Cyan
    if ($after.Status -ne 'Running') {
      Write-Host '[start] WARN: service did not return to Running. Check Logs\ADDashboardCenter-stderr.log' -ForegroundColor Yellow
    }
  } catch {
    Write-Host "[start] hot-restart failed: $_" -ForegroundColor Red
    Write-Host '[start] falling back to full install-center.ps1 -InPlace' -ForegroundColor Yellow
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $bundleRoot 'scripts\install-center.ps1') -InPlace
    exit $LASTEXITCODE
  }
} else {
  # First-time install: register service pointing at <bundleRoot>\center (no file copy).
  Write-Host '[start] ADDashboardCenter not registered — first-time install' -ForegroundColor Cyan
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $bundleRoot 'scripts\install-center.ps1') -InPlace
  exit $LASTEXITCODE
}
exit 0