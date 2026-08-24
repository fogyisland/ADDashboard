<#
.SYNOPSIS
  AD Replication Dashboard — green-bundle operator entry (PowerShell).

.DESCRIPTION
  Single entry for both first-time install AND code updates.

  Behavior:
    - ADDashboardCenter service NOT registered → first-time install:
        1. Run `npm run build` to regenerate dist (always — operator
           requirement).
        2. Call install-center.ps1 -InPlace: register NSSM service
           pointing at <bundleRoot>\center (no file copy), start it,
           probe /api/init/status.
        3. Operators then open http://<host>:8080/init to complete the
           wizard (DB credentials, admin user).
    - ADDashboardCenter service already registered → update flow:
        1. Run `npm run build` to regenerate dist (so the freshly
           restarted process serves the latest frontend bundle).
        2. POST http://localhost:8080/api/system/update (preferred —
           applies pending DB migrations and exits cleanly; NSSM
           restarts with new code + new dist).
        3. If the API endpoint is not yet available (404) or the service
           isn't reachable yet, fall back to a plain service restart.
           The new code, once loaded, auto-applies any pending
           migrations on its own startup, so this fallback is safe.

  No password required. The API is gated by localhost-only; the
  fallback restart needs Administrator (NSSM service control).

  -Console: run node server.js in foreground (dev mode, no service).
  -Help:    show usage.

.EXAMPLE
  .\start.ps1              # install OR update; one command does both
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

function Send-SystemUpdateRequest {
  param([int]$ListenPort = 8080, [int]$TimeoutSec = 10)
  $uri = "http://localhost:${ListenPort}/api/system/update"
  return Invoke-WebRequest -Method Post -Uri $uri -TimeoutSec $TimeoutSec -UseBasicParsing
}

function Get-SystemUpdateResultFromResponse {
  # Tries to surface a useful status line from Invoke-WebRequest's response
  # object. StatusCode + body, or null on parse failure.
  param($Response)
  if (-not $Response) { return $null }
  $body = ''
  try {
    if ($Response.Content) { $body = $Response.Content }
  } catch {}
  return [pscustomobject]@{
    StatusCode = [int]$Response.StatusCode
    Body = $body
  }
}

if ($Help) {
  @'
Usage: start.ps1 [-Console] [-Help]
  (default)   install (if first time) OR update (if service already
              registered). Single command — no separate update script
              needed. The endpoint POST /api/system/update is used
              when available; otherwise the script restarts the
              service and lets the new code auto-apply migrations.
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

$ps = Get-Command powershell.exe -ErrorAction SilentlyContinue
if (-not $ps) { Write-Host '[start] PowerShell not found.' -ForegroundColor Red; exit 1 }
if (-not (Test-IsAdministrator)) {
  Write-Host '[start] Service install/restart requires Administrator. Re-run from an elevated PowerShell.' -ForegroundColor Red
  exit 1
}

$svc = Get-Service -Name 'ADDashboardCenter' -ErrorAction SilentlyContinue

if (-not $svc) {
  # First-time install: rebuild dist (per operator requirement: always
  # regenerate on install), then register the NSSM service pointing at
  # <bundleRoot>\center (no file copy). After the service starts, the
  # operator opens /init to fill in DB credentials + admin user.
  Write-Host '[start] ADDashboardCenter not registered — first-time install' -ForegroundColor Cyan
  Write-Host '[start] running npm run build to regenerate dist' -ForegroundColor Cyan
  Push-Location $bundleRoot
  try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) {
      Write-Host '[start] npm run build failed (exit ' -NoNewline -ForegroundColor Red
      Write-Host "$LASTEXITCODE" -NoNewline -ForegroundColor Red
      Write-Host '). Check node + npm + center/web/node_modules.' -ForegroundColor Red
      exit $LASTEXITCODE
    }
  } finally { Pop-Location }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $bundleRoot 'scripts\install-center.ps1') -InPlace
  exit $LASTEXITCODE
}

# Service is registered. Update flow: rebuild dist → apply code + schema.
# Step 1: rebuild dist from the on-disk source so the freshly-restarted
# process serves the latest frontend bundle (green bundles ship dist; this
# regen ensures dev trees and edge-case bundles also stay current).
# Step 2: prefer the API path so DB migrations apply under the running
# process's audit log + transaction visibility; fall back to a plain
# restart if the endpoint isn't there yet (first deploy of
# /api/system/update itself, or rollback). The fallback is safe because
# the service's own startup runs service.upgrade() before routes bind,
# so any pending migrations land on the new code's first boot.
Write-Host '[start] service registered — update flow (rebuild + apply)' -ForegroundColor Cyan
Write-Host '[start] running npm run build to regenerate dist' -ForegroundColor Cyan
Push-Location $bundleRoot
try {
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) {
    Write-Host '[start] npm run build failed (exit ' -NoNewline -ForegroundColor Red
    Write-Host "$LASTEXITCODE" -NoNewline -ForegroundColor Red
    Write-Host '). Check node + npm + center/web/node_modules.' -ForegroundColor Red
    exit $LASTEXITCODE
  }
} finally { Pop-Location }

$listenPort = 8080
$apiUpdate = $null
$apiUpdateError = $null
try {
  $apiUpdate = Send-SystemUpdateRequest -ListenPort $listenPort -TimeoutSec 10
} catch {
  $apiUpdateError = $_
}

if ($apiUpdate -and $apiUpdate.StatusCode -ge 200 -and $apiUpdate.StatusCode -lt 300) {
  # 200: service applied migrations and will exit within 500ms; NSSM
  # auto-restarts with the new code + freshly-built dist. No further
  # action from us.
  Write-Host "[start] update via API ok ($($apiUpdate.StatusCode)); service will restart itself" -ForegroundColor Green
  if ($apiUpdate.Content) { Write-Host "[start] response: $($apiUpdate.Content)" }
  exit 0
}

if ($apiUpdate) {
  # Non-2xx (e.g. 403 if somehow not localhost, 500 on migration failure):
  # surface the body so the operator can decide whether to retry or
  # investigate. Do NOT restart blindly — a migration failure won't fix
  # itself on restart.
  Write-Host "[start] update API returned $($apiUpdate.StatusCode); not restarting automatically" -ForegroundColor Yellow
  if ($apiUpdate.Content) { Write-Host "[start] response: $($apiUpdate.Content)" }
  exit 1
}

# API unreachable — fall back to service restart. The new code on disk
# + freshly-built dist will load; startup auto-applies pending migrations
# before serving.
Write-Host '[start] update API not reachable — restarting service' -ForegroundColor Cyan
if ($apiUpdateError) {
  Write-Host "[start] reason: $($apiUpdateError.Exception.Message)" -ForegroundColor DarkGray
}
try {
  Restart-Service -Name 'ADDashboardCenter' -Force -ErrorAction Stop
  Write-Host '[start] restart issued; waiting for service to settle' -ForegroundColor Cyan
  Start-Sleep -Seconds 3
  $after = Get-Service -Name 'ADDashboardCenter' -ErrorAction SilentlyContinue
  Write-Host "[start] post-restart status: $($after.Status)" -ForegroundColor Cyan
  if ($after.Status -ne 'Running') {
    Write-Host '[start] WARN: service did not return to Running. Check center\Logs\ADDashboardCenter-stderr.log' -ForegroundColor Yellow
    exit 1
  }
  exit 0
} catch {
  Write-Host "[start] restart failed: $_" -ForegroundColor Red
  exit 1
}
