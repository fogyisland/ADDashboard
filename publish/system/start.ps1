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

# Returns $true if <bundleRoot>/center/web/ source exists. Repo-root installs
# ship the frontend source; green bundles ship pre-built dist only (no
# center/web/). A rebuild only makes sense when source is present.
function Test-HasWebSource {
  return (Test-Path -LiteralPath (Join-Path $bundleRoot 'center/web'))
}

# Picks the build script that the bundle's package.json defines. Repo root
# uses `build:web` (= npm run build:web --workspace=center); green bundles
# (publish/system) ship only `build:frontend`. We probe both so the same
# start.ps1 works on either layout — and return $null if neither exists.
function Get-BuildScriptName {
  $pkgPath = Join-Path $bundleRoot 'package.json'
  if (-not (Test-Path $pkgPath)) { return $null }
  try {
    $pkg = Get-Content -Path $pkgPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    foreach ($name in @('build', 'build:web', 'build:frontend')) {
      if ($pkg.scripts.PSObject.Properties.Name -contains $name) { return $name }
    }
  } catch {}
  return $null
}

function Invoke-BundleBuild {
  # Run npm run <script> at the bundle root when source + script are both
  # available. Returns $true if we attempted a build and it succeeded (or
  # there was nothing to build); $false if the build ran but failed —
  # caller should exit.
  if (-not (Test-HasWebSource)) {
    Write-Host '[start] no center/web/ source (green bundle ships dist); skipping rebuild' -ForegroundColor DarkGray
    return $true
  }
  $script = Get-BuildScriptName
  if (-not $script) {
    Write-Host '[start] center/web/ source found but no build script defined; skipping rebuild' -ForegroundColor DarkGray
    return $true
  }
  # Green bundles do NOT ship node_modules. `npm run build:web` resolves through
  # `npm run build:web --workspace=center` → `vite build --config web/vite.config.js`,
  # and vite is a devDependency hoisted to <bundleRoot>/node_modules by npm
  # workspaces. install-center.ps1 -InPlace only runs `npm install --omit=dev`
  # inside center/ (devs don't need vite at runtime), so root node_modules is
  # empty for a fresh green-bundle first install AND for any subsequent update
  # flow that hits this script. Without it, the build silently exits with
  # "vite: not found" and the freshly-restarted center process serves no UI
  # bundle (static fallback 404s on every /init, /login, etc.).
  #
  # Scope the install to the center workspace ONLY. The bundle also declares
  # `agent` as a workspace, and agent has native deps (better-sqlite3) that
  # require Python 3.x + node-gyp on the host — irrelevant for the center
  # web build, and the user's center host typically doesn't have them.
  # `npm install --workspace=center` lets us hoist vite to root node_modules
  # without dragging agent's native build chain along. Vite's postinstall
  # (esbuild binary download) is preserved — `--ignore-scripts` would skip
  # it and break the subsequent build.
  #
  # Self-heal: run scoped install at the bundle root if node_modules is
  # missing OR if it has no `vite` binary. Idempotent — npm skips up-to-
  # date deps on re-run.
  $rootNm = Join-Path $bundleRoot 'node_modules'
  $viteBin = Join-Path $rootNm 'vite'
  if (-not (Test-Path $rootNm) -or -not (Test-Path $viteBin)) {
    $reason = if (Test-Path $rootNm) { 'vite missing in root node_modules' } else { 'root node_modules missing' }
    Write-Host "[start] $reason — running npm install --workspace=center" -ForegroundColor Cyan
    Push-Location $bundleRoot
    try {
      & npm.cmd install --workspace=center
      if ($LASTEXITCODE -ne 0) {
        Write-Host "[start] npm install failed (exit $LASTEXITCODE); cannot build" -ForegroundColor Red
        return $false
      }
    } finally { Pop-Location }
  }
  Write-Host "[start] running npm run $script to regenerate dist into center/dist/" -ForegroundColor Cyan
  Push-Location $bundleRoot
  try {
    & npm.cmd run $script
    if ($LASTEXITCODE -ne 0) {
      Write-Host "[start] npm run $script failed (exit " -NoNewline -ForegroundColor Red
      Write-Host "$LASTEXITCODE" -NoNewline -ForegroundColor Red
      Write-Host '). Check node + npm + root node_modules/vite.' -ForegroundColor Red
      return $false
    }
    return $true
  } finally { Pop-Location }
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
  # regenerate on install when source is available), then register the
  # NSSM service pointing at <bundleRoot>\center (no file copy). After
  # the service starts, the operator opens /init to fill in DB
  # credentials + admin user.
  Write-Host '[start] ADDashboardCenter not registered — first-time install' -ForegroundColor Cyan
  if (-not (Invoke-BundleBuild)) { exit $LASTEXITCODE }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $bundleRoot 'scripts\install-center.ps1') -InPlace
  exit $LASTEXITCODE
}

# Service is registered. Update flow: rebuild dist → apply code + schema.
# Step 1: rebuild dist from the on-disk source so the freshly-restarted
# process serves the latest frontend bundle (green bundles ship dist and
# skip this; repo-root installs always regen).
# Step 2: prefer the API path so DB migrations apply under the running
# process's audit log + transaction visibility; fall back to a plain
# restart if the endpoint isn't there yet (first deploy of
# /api/system/update itself, or rollback). The fallback is safe because
# the service's own startup runs service.upgrade() before routes bind,
# so any pending migrations land on the new code's first boot.
Write-Host '[start] service registered — update flow (rebuild + apply)' -ForegroundColor Cyan
if (-not (Invoke-BundleBuild)) { exit $LASTEXITCODE }

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
