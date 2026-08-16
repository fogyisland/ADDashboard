# AD Dashboard Center installer (DEPLOYMENT ONLY).
# For application init (DB connection, schema, seed, admin user, appsettings.json),
# the center service's built-in /init wizard handles that on first boot.
# This installer only does deployment: verify prerequisites, copy files,
# register NSSM service, start service.
[CmdletBinding()]
param(
  [string]$InstallPath,
  [int]$ListenPort = 8080,
  [string]$AgentToken,   # generated if missing
  [string]$JwtSecret,    # generated if missing
  [switch]$InPlace       # green-bundle: install service pointing at <projectRoot>\center, no file copy
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

if ($InPlace) {
  $InstallPath = Join-Path $projectRoot 'center'
  Write-Info "in-place install: service will point at $InstallPath (no file copy to <publish-root>/Center)"
}

Write-Step "install-center: $InstallPath (deployment only — wizard handles app init)"

# 0. Ensure NSSM is available locally (downloads to <projectRoot>/nssm/ on first run)
. (Join-Path $PSScriptRoot 'common\Ensure-Nssm.ps1') -ProjectRoot $projectRoot

# Idempotent node_modules install: hash-checked against package.json+package-lock.json.
# Reinstalls when the source deps change (added/removed/upgraded) or node_modules is missing.
# Writes the new hash to <InstallPath>\.install-hash after a successful install.
function Ensure-CenterNodeModules {
  param(
    [Parameter(Mandatory)] [string]$InstallPath,
    [Parameter(Mandatory)] [string]$SrcDir
  )
  $hashFile = Join-Path $InstallPath '.install-hash'
  $srcPkg = Join-Path $SrcDir 'package.json'
  $srcLock = Join-Path $SrcDir 'package-lock.json'
  $newHash = ''
  if (Test-Path $srcPkg) {
    $newHash += (Get-FileHash -Algorithm SHA256 -Path $srcPkg).Hash
  }
  if (Test-Path $srcLock) {
    $newHash += (Get-FileHash -Algorithm SHA256 -Path $srcLock).Hash
  }
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
    Write-Step "installing center node_modules ($reason)"
    if (Test-Path (Join-Path $InstallPath 'node_modules')) {
      Remove-Item -Path (Join-Path $InstallPath 'node_modules') -Recurse -Force
    }
    Push-Location $InstallPath
    try { npm install --omit=dev } finally { Pop-Location }
    if ($newHash -ne '') {
      Set-Content -Path $hashFile -Value $newHash -NoNewline
    }
  } else {
    Write-Info "center node_modules up-to-date"
  }
}

# Set log directory inside the NSSM/Logger modules' own $Script: scope — module
# functions can't see the caller's $Script:LogDir, so we have to push the
# value across explicitly via the modules' setters. Co-located under the
# install dir so uninstall/upgrade scripts find it without an extra path arg.
$Script:LogDir = Join-Path $InstallPath 'Logs'
if (-not (Test-Path $Script:LogDir)) { New-Item -ItemType Directory -Path $Script:LogDir -Force | Out-Null }
Set-NssmLogDir $Script:LogDir
Set-LogDir $Script:LogDir

# When -InPlace, skip file copy / dist mirror / npm install of the install target.
# node_modules is still installed if missing (green-bundle first-time setup).
$srcDir = Join-Path $projectRoot 'center'
if (-not $InPlace) {
  # 1. Ensure directories
  @($InstallPath, "$InstallPath\dist") | ForEach-Object {
    if (-not (Test-Path $_)) { New-Item -ItemType Directory -Path $_ -Force | Out-Null; Write-Info "created $_" }
  }

  # 2. Verify Node.js
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  Write-Info "node: $node"

  # 3. Build frontend if dist missing
  $distPath = Join-Path $projectRoot 'frontend\dist'
  if (-not (Test-Path (Join-Path $distPath 'index.html'))) {
    Write-Step "building frontend"
    # Fresh publish bundle has no <publish-root>/node_modules. Install at root so
    # vite is hoisted via workspaces; `npm run build:frontend` delegates to the
    # frontend workspace. Dev installs always have root node_modules — no-op.
    if (-not (Test-Path (Join-Path $projectRoot 'node_modules'))) {
      Write-Step "installing root workspaces (vite missing)"
      Push-Location $projectRoot
      try { npm install } finally { Pop-Location }
    }
    Push-Location $projectRoot
    try { npm run build:frontend } finally { Pop-Location }
  }

  # 4. Copy center files
  Copy-Item -Path (Join-Path $srcDir '*') -Destination $InstallPath -Recurse -Force -Exclude 'node_modules','tests','appsettings.json'
  Ensure-CenterNodeModules -InstallPath $InstallPath -SrcDir $srcDir
  Copy-Item -Path (Join-Path $distPath '*') -Destination (Join-Path $InstallPath 'dist') -Recurse -Force
} else {
  # In-place: only install node_modules if missing; build dist if missing.
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  Write-Info "node: $node"
  Ensure-CenterNodeModules -InstallPath $InstallPath -SrcDir $srcDir
  $distPath = Join-Path $InstallPath 'dist'
  if (-not (Test-Path (Join-Path $distPath 'index.html'))) {
    Write-Step "building frontend (in-place)"
    # Fresh publish bundle has no frontend/node_modules. Install in frontend/
    # so vite is locally available; `npm run build` runs `vite build` from here.
    # Dev installs always have frontend/node_modules — no-op.
    if (-not (Test-Path (Join-Path $projectRoot 'frontend\node_modules'))) {
      Write-Step "installing frontend node_modules (vite missing)"
      Push-Location (Join-Path $projectRoot 'frontend')
      try { npm install } finally { Pop-Location }
    }
    Push-Location (Join-Path $projectRoot 'frontend')
    try { npm run build } finally { Pop-Location }
    if (Test-Path $distPath) { Remove-Item -Path $distPath -Recurse -Force }
    New-Item -ItemType Directory -Path $distPath -Force | Out-Null
    Copy-Item -Path (Join-Path $projectRoot 'frontend\dist\*') -Destination $distPath -Recurse -Force
  }
}

# 5. Register and start service
Install-NssmService -Name 'ADDashboardCenter' `
  -Application $node `
  -AppDirectory $InstallPath `
  -AppParameters 'server.js' `
  -DisplayName 'AD Replication Dashboard Center' `
  -Description 'AD Replication Dashboard Center (Node.js + Express + Vue 3)' `
  -Start SERVICE_AUTO_START

# Configure auto-restart: NSSM picks up process.exit(0) and re-launches with new appsettings.json;
# Windows Service Recovery handles crashes (OOM, segfault, kill -9).
# Helper in scripts/common/Service.psm1 owns the NSSM + sc.exe wiring.
Set-ServiceRecovery -Name 'ADDashboardCenter'

if (Start-ServiceSafe -Name 'ADDashboardCenter' -WaitSeconds 20) {
  Write-Ok "service started"
} else {
  Write-Err2 "service failed to start; see $(Join-Path $Script:LogDir 'ADDashboardCenter-stderr.log')"
  exit 1
}

# 6. Probe health — wait for HTTP to come up instead of single-shot. SCM
# "Running" only means NSSM launched node; Express still needs to bind the
# port (cold cache: 2-15s). Wait-ForHttpOk polls until 2xx or 30s timeout.
$probeUrl = "http://localhost:$ListenPort/api/init/status"
if (Wait-ForHttpOk -Url $probeUrl -TimeoutSeconds 30 -IntervalSeconds 1) {
  $health = try { (Invoke-WebRequest -Uri $probeUrl -UseBasicParsing -TimeoutSec 5).Content } catch { "unreachable: $($_.Exception.Message)" }
  Write-Ok "init status: $health"
  Write-Ok "open browser to: http://localhost:$ListenPort/init to complete application initialization"
} else {
  # Service is up (Start-ServiceSafe returned true) but HTTP didn't bind in time.
  # Don't fail the install — log a clear warning instead. The browser will retry.
  Write-Info "service started but HTTP probe at $probeUrl did not return 2xx within 30s"
  Write-Info "this usually means Express is still loading modules; check $(Join-Path $Script:LogDir 'ADDashboardCenter-stderr.log') and try http://localhost:$ListenPort/init in a few seconds"
}
