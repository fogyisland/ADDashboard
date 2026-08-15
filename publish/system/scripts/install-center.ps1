# AD Dashboard Center installer (DEPLOYMENT ONLY).
# For application init (DB connection, schema, seed, admin user, appsettings.json),
# the center service's built-in /init wizard handles that on first boot.
# This installer only does deployment: verify prerequisites, copy files,
# register NSSM service, start service.
[CmdletBinding()]
param(
  [string]$InstallPath = 'C:\addashboard\Center',
  [int]$ListenPort = 8080,
  [string]$AgentToken,   # generated if missing
  [string]$JwtSecret,    # generated if missing
  [switch]$InPlace       # green-bundle: install service pointing at <projectRoot>\center, no file copy
)

$ErrorActionPreference = 'Stop'
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Import-Module (Join-Path $PSScriptRoot 'common\Logger.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\NSSM.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\Service.psm1') -Force

if ($InPlace) {
  $InstallPath = Join-Path $projectRoot 'center'
  Write-Info "in-place install: service will point at $InstallPath (no file copy to C:\addashboard)"
}

Write-Step "install-center: $InstallPath (deployment only — wizard handles app init)"

# 0. Ensure NSSM is available locally (downloads to <projectRoot>/nssm/ on first run)
. (Join-Path $PSScriptRoot 'common\Ensure-Nssm.ps1') -ProjectRoot $projectRoot

# 0a. Install center + frontend workspace deps at projectRoot if either's
#     node_modules is missing. The init-state bundle ships without
#     package-lock.json (so first run resolves fresh); without this,
#     `npm run build:frontend` later would fail because vite isn't in
#     frontend/node_modules/.bin yet. Idempotent: exits fast when both are
#     already populated. Agent deps installed by install-agent.ps1 only.
#     Two-step: center with --omit=dev (prod only); frontend WITH devDeps so
#     vite gets installed (build step needs it).
$centerNm = Join-Path $projectRoot 'center\node_modules'
$frontendNm = Join-Path $projectRoot 'frontend\node_modules'
if (-not (Test-Path $centerNm)) {
  Write-Info "installing center deps (npm install --workspace=center --include-workspace-root --omit=dev)"
  Push-Location $projectRoot
  try { npm install --workspace=center --include-workspace-root --omit=dev --no-audit --no-fund }
  finally { Pop-Location }
}
if (-not (Test-Path $frontendNm)) {
  Write-Info "installing frontend deps (npm install --workspace=frontend --include-workspace-root --no-audit --no-fund)"
  Push-Location $projectRoot
  try { npm install --workspace=frontend --include-workspace-root --no-audit --no-fund }
  finally { Pop-Location }
}

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

# Set log directory inside the NSSM module's own $Script: scope — module
# functions can't see the caller's $Script:LogDir, so we have to push the
# value across explicitly via the module's setter. Same value is held in
# this script's $Script:LogDir for the Write-Err2 path below.
$Script:LogDir = 'C:\addashboard\Logs'
if (-not (Test-Path $Script:LogDir)) { New-Item -ItemType Directory -Path $Script:LogDir -Force | Out-Null }
Set-NssmLogDir $Script:LogDir

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
    # Workspace deps installed at step 0a; just run the build from projectRoot
    # so npm's workspace context resolves correctly.
    Push-Location $projectRoot
    try { npm run build:frontend } finally { Pop-Location }
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

# 6. Probe health (server boots in init mode if appsettings.json missing → /init responds)
$health = try { (Invoke-WebRequest -Uri "http://localhost:$ListenPort/api/init/status" -UseBasicParsing -TimeoutSec 10).Content } catch { "unreachable: $($_.Exception.Message)" }
Write-Ok "init status: $health"
Write-Ok "open browser to: http://localhost:$ListenPort/init to complete application initialization"
