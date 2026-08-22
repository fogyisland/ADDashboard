# AD Dashboard Center upgrade — architecture extension flow.
# Use AFTER first-time install (install-center.ps1 handles init via /api/init
# wizard on first boot). This script handles subsequent deployments:
#   1. stop NSSM service
#   2. replace code (mirror → install path, hash-checked npm install)
#   3. replace dist (shipped bundle, or local build via -RebuildFrontend)
#   4. start NSSM service + HTTP probe
#   5. apply pending DB migrations via HTTP API (the "扩展架构" piece)
#   6. (Built-in packages + SMTP defaults + agent_token bundle re-seed
#      automatically on normal-mode restart — no extra HTTP call needed.)
#
# -RebuildFrontend: force a fresh local `npm run build:web --workspace=center`
# instead of copying the shipped dist. Use when the local web UI source has
# changes that are not yet in the shipped bundle (stale-UI fix). Equivalent
# to publish/system/update.{ps1,bat}.
#
# IMPORTANT: NOT for first-time install. Use install-center.ps1 instead.
# This script ASSUMES the DB already exists and /init has been completed.
# It will refuse to proceed against an uninitialized install (needsInit=true).
[CmdletBinding()]
param(
  [string]$InstallPath,
  [int]$ListenPort = 8080,
  [string]$WebAdminUser = 'admin',
  [Parameter(Mandatory)][string]$WebAdminPassword,
  [switch]$RebuildFrontend
)

# $PSScriptRoot is empty in [CmdletBinding()] default param values (parameter
# binding scope is a child of script scope; auto-vars only set in script scope).
# Resolve default InstallPath in the body where $PSScriptRoot is available.
if (-not $InstallPath) {
  $InstallPath = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')) 'Center')
}

$ErrorActionPreference = 'Stop'
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Import-Module (Join-Path $PSScriptRoot 'common\Logger.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\NSSM.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\Service.psm1') -Force

# 0. Ensure NSSM is available locally (downloads to <projectRoot>/nssm/ on first run).
# When script lives at publish/system/scripts/upgrade-center.ps1, $projectRoot
# = publish/system/, so Ensure-Nssm picks the published nssm copy there.
. (Join-Path $PSScriptRoot 'common\Ensure-Nssm.ps1') -ProjectRoot $projectRoot

# Set log directory inside the NSSM/Logger modules' own $Script: scope.
$Script:LogDir = Join-Path $InstallPath 'Logs'
if (-not (Test-Path $Script:LogDir)) { New-Item -ItemType Directory -Path $Script:LogDir -Force | Out-Null }
Set-NssmLogDir $Script:LogDir
Set-LogDir $Script:LogDir

Write-Step "upgrade-center: $InstallPath (architecture extension — not first-time init)"

# Refuse to run if the install has not been initialized yet. The /api/init
# wizard handles DB connection + schema + seed + admin user + appsettings.json;
# if needsInit is still true at runtime, calling this script means the operator
# skipped install-center.ps1, and applying migrations against a non-existent
# DB would silently no-op (or fail loudly on first apply — confusing either way).
# Surface a clear error so they run the right script.
$initStatusUrl = "http://localhost:$ListenPort/api/init/status"
try {
  $initResp = Invoke-WebRequest -Uri $initStatusUrl -UseBasicParsing -TimeoutSec 5
  $initBody = $initResp.Content | ConvertFrom-Json
  if ($initBody.needsInit -eq $true) {
    throw "install at $InstallPath has not been initialized (/init wizard still pending). Run install-center.ps1 first."
  }
} catch [System.Net.WebException] {
  throw "service not reachable at $initStatusUrl — is it running? Start it first or run install-center.ps1 (which registers and starts the NSSM service)."
}

# Idempotent node_modules install: hash-checked against package.json+package-lock.json.
# After we copy new code into $InstallPath, the InstallPath's own package.json is
# the new source — so SrcDir = InstallPath.
function Ensure-NodeModules {
  param([Parameter(Mandatory)] [string]$InstallPath)
  $hashFile = Join-Path $InstallPath '.install-hash'
  $pkgJson = Join-Path $InstallPath 'package.json'
  $pkgLock = Join-Path $InstallPath 'package-lock.json'
  $newHash = ''
  if (Test-Path $pkgJson) { $newHash += (Get-FileHash -Algorithm SHA256 -Path $pkgJson).Hash }
  if (Test-Path $pkgLock) { $newHash += (Get-FileHash -Algorithm SHA256 -Path $pkgLock).Hash }
  $oldHash = if (Test-Path $hashFile) { Get-Content -Path $hashFile -Raw -ErrorAction SilentlyContinue } else { '' }
  $needsInstall = -not (Test-Path (Join-Path $InstallPath 'node_modules'))
  if (-not $needsInstall -and $newHash -ne '' -and $newHash -ne $oldHash) {
    $needsInstall = $true
    $reason = 'deps changed (package.json or package-lock.json hash differs)'
  } elseif (-not $needsInstall) {
    $reason = 'up-to-date'
  } else {
    $reason = 'node_modules missing'
  }
  if ($needsInstall) {
    Write-Step "installing node_modules ($reason)"
    if (Test-Path (Join-Path $InstallPath 'node_modules')) {
      Remove-Item -Path (Join-Path $InstallPath 'node_modules') -Recurse -Force
    }
    Push-Location $InstallPath
    try { npm install --omit=dev } finally { Pop-Location }
    if ($newHash -ne '') { Set-Content -Path $hashFile -Value $newHash -NoNewline }
  } else {
    Write-Info "node_modules up-to-date"
  }
}

# 1. Stop the running NSSM service so file replacement doesn't race with
# running node processes. Stop-ServiceSafe waits until SCM reports stopped.
Write-Step "stopping service"
if (-not (Stop-ServiceSafe -Name 'ADDashboardCenter' -WaitSeconds 30)) { throw 'cannot stop service' }

# 2. Copy new code from bundle into install path. Excludes node_modules
# (re-installed hash-checked), tests (not for prod), and appsettings.json
# (operator-owned config — overwriting it would clobber DB credentials + jwt
# secret + agent_token).
$srcDir = Join-Path $projectRoot 'center'
Write-Step "copying code: $srcDir → $InstallPath"
Copy-Item -Path (Join-Path $srcDir '*') -Destination $InstallPath -Recurse -Force -Exclude 'node_modules','tests','appsettings.json'

# 3. Hash-checked npm install (idempotent — no-op if deps unchanged).
Ensure-NodeModules -InstallPath $InstallPath

# 4. Refresh dist. Priority order:
#    (a) -RebuildFrontend: force a local `npm run build:web --workspace=center`
#        (stale-UI fix when shipped bundle drifted from local source).
#        Equivalent to publish/system/update.{ps1,bat}.
#    (b) Shipped bundle present: copy it (default, fast).
#    (c) Shipped bundle absent AND install dist absent: build locally (legacy
#        bundles that pre-date the shipped-dist convention).
#    (d) Shipped bundle absent AND install dist present: leave alone (clobbering
#        a working dist just because we don't ship one is the wrong default).
$distPath = Join-Path $InstallPath 'dist'
$shippedDist = Join-Path $projectRoot 'center\dist'
if ($RebuildFrontend) {
  Write-Step "rebuilding web UI (npm run build:web --workspace=center)"
  Push-Location $projectRoot
  try {
    if (-not (Test-Path (Join-Path $projectRoot 'center\web\node_modules'))) {
      Write-Step "installing web UI node_modules (vite missing)"
      npm install
    }
    npm run build:web --workspace=center
  } finally { Pop-Location }
  $localDist = Join-Path $projectRoot 'center\dist'
  if (-not (Test-Path (Join-Path $localDist 'index.html'))) {
    throw "npm run build:web --workspace=center did not produce center\dist\index.html"
  }
  if (Test-Path $distPath) { Remove-Item -Path $distPath -Recurse -Force }
  New-Item -ItemType Directory -Path $distPath -Force | Out-Null
  Copy-Item -Path (Join-Path $localDist '*') -Destination $distPath -Recurse -Force
} elseif (Test-Path (Join-Path $shippedDist 'index.html')) {
  Write-Step "refreshing dist from shipped bundle"
  if (Test-Path $distPath) { Remove-Item -Path $distPath -Recurse -Force }
  New-Item -ItemType Directory -Path $distPath -Force | Out-Null
  Copy-Item -Path (Join-Path $shippedDist '*') -Destination $distPath -Recurse -Force
} elseif (-not (Test-Path (Join-Path $distPath 'index.html'))) {
  Write-Step "building web UI (shipped dist absent)"
  if (-not (Test-Path (Join-Path $projectRoot 'center\web\node_modules'))) {
    Write-Step "installing web UI node_modules (vite missing)"
    Push-Location $projectRoot
    try { npm install } finally { Pop-Location }
  }
  Push-Location $projectRoot
  try { npm run build:web --workspace=center } finally { Pop-Location }
  if (Test-Path $distPath) { Remove-Item -Path $distPath -Recurse -Force }
  New-Item -ItemType Directory -Path $distPath -Force | Out-Null
  Copy-Item -Path (Join-Path $projectRoot 'center\dist\*') -Destination $distPath -Recurse -Force
} else {
  Write-Info "install dist already present; leaving alone (shipped dist absent)"
}

# 5. Start NSSM service. Start-ServiceSafe has pre-flight NSSM diagnostics +
# Win32 error surfacing (see scripts/common/Service.psm1 for details).
if (Start-ServiceSafe -Name 'ADDashboardCenter' -WaitSeconds 20) {
  Write-Ok "service started"
} else {
  Write-Err2 "service failed to start; see $(Join-Path $Script:LogDir 'ADDashboardCenter-stderr.log')"
  exit 1
}

# 6. HTTP readiness probe — wait for /api/init/status to come back 2xx.
# Cold cache (modules loading, DB pool init, route mount) takes 2-15s before
# Express binds the listening socket. Single-shot Invoke-WebRequest races the
# boot; Wait-ForHttpOk polls until 2xx or 30s timeout.
$probeUrl = "http://localhost:$ListenPort/api/init/status"
if (-not (Wait-ForHttpOk -Url $probeUrl -TimeoutSeconds 30 -IntervalSeconds 1)) {
  throw "service is up (per SCM) but HTTP probe at $probeUrl did not return 2xx within 30s. Check $(Join-Path $Script:LogDir 'ADDashboardCenter-stderr.log')."
}
Write-Ok "HTTP probe green"

# 7. Authenticate as admin. Migration apply requires admin:users permission.
Write-Step "authenticating as $WebAdminUser"
$token = $null
try {
  $loginBody = @{ username = $WebAdminUser; password = $WebAdminPassword } | ConvertTo-Json -Compress
  $loginResp = Invoke-WebRequest -Uri "http://localhost:$ListenPort/api/auth/login" -Method POST -Body $loginBody -ContentType 'application/json' -UseBasicParsing -TimeoutSec 5
  $loginJson = $loginResp.Content | ConvertFrom-Json
  $token = $loginJson.token
} catch {
  throw "admin login failed for $WebAdminUser at http://localhost:$ListenPort/api/auth/login: $($_.Exception.Message)"
}
if (-not $token) { throw "admin login succeeded but token is empty" }
Write-Ok "authenticated"

# 8. List pending migrations. The "扩展架构" step — apply all migrations that
# are present in the deployed code but not yet applied to the DB. Sequential
# (NOT parallel): migrations may have inter-dependencies (e.g. adding a column
# before adding an index on it). apply-up-to would be safer but the API only
# exposes per-version apply.
$authHeaders = @{ Authorization = "Bearer $token" }
$listResp = Invoke-WebRequest -Uri "http://localhost:$ListenPort/api/admin/migrations" -Headers $authHeaders -UseBasicParsing -TimeoutSec 10
$migrations = $listResp.Content | ConvertFrom-Json

# Migrations come back with a status field. Apply only "pending" or "failed".
# "applied" ones are skipped (idempotent re-run).
$pending = @($migrations | Where-Object { $_.status -eq 'pending' -or $_.status -eq 'failed' })
if ($pending.Count -eq 0) {
  Write-Ok "no pending migrations — DB is up-to-date"
} else {
  Write-Step "applying $($pending.Count) pending migration(s)"
  $appliedCount = 0
  foreach ($m in $pending) {
    Write-Info "  applying $($m.version) ($($m.status))..."
    $applyBody = @{ appliedBy = 'upgrade-center.ps1' } | ConvertTo-Json -Compress
    try {
      $applyResp = Invoke-WebRequest -Uri "http://localhost:$ListenPort/api/admin/migrations/$($m.version)/apply" -Method POST -Body $applyBody -ContentType 'application/json' -Headers $authHeaders -UseBasicParsing -TimeoutSec 60
      $applyJson = $applyResp.Content | ConvertFrom-Json
      if ($applyJson.status -ne 'applied') {
        throw "migration $($m.version) apply returned status=$($applyJson.status): $($applyJson | ConvertTo-Json -Compress)"
      }
      $appliedCount++
      Write-Ok "  $($m.version) applied ($($applyJson.executionMs)ms)"
    } catch {
      throw "migration $($m.version) apply failed: $($_.Exception.Message). Earlier migrations have been applied — re-run this script after fixing the root cause to resume."
    }
  }
  Write-Ok "applied $appliedCount migration(s)"
}

# 9. Verify 0 pending. If something still pending, the apply loop must have
# hit a permanent failure — surface clearly so the operator doesn't think
# the upgrade is complete.
$verifyResp = Invoke-WebRequest -Uri "http://localhost:$ListenPort/api/admin/migrations" -Headers $authHeaders -UseBasicParsing -TimeoutSec 10
$verifyMigrations = $verifyResp.Content | ConvertFrom-Json
$stillPending = @($verifyMigrations | Where-Object { $_.status -eq 'pending' })
if ($stillPending.Count -gt 0) {
  throw "$($stillPending.Count) migration(s) still pending after upgrade: $($stillPending | ForEach-Object { $_.version } | Sort-Object -Join ', ')"
}
Write-Ok "DB migrations verified — 0 pending"

Write-Ok "upgrade complete: code + dist + deps + migrations + auto-seeded built-in packages"