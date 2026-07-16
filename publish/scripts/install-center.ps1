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
  [string]$JwtSecret     # generated if missing
)

$ErrorActionPreference = 'Stop'
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Import-Module (Join-Path $PSScriptRoot 'common\Logger.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\NSSM.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\Service.psm1') -Force

Write-Step "install-center: $InstallPath (deployment only — wizard handles app init)"

# 0. Ensure NSSM is available locally (downloads to <projectRoot>/nssm/ on first run)
. (Join-Path $PSScriptRoot 'common\Ensure-Nssm.ps1') -ProjectRoot $projectRoot

# 1. Ensure directories
$logDir = 'C:\addashboard\Logs'
@($InstallPath, "$InstallPath\dist", $logDir) | ForEach-Object {
  if (-not (Test-Path $_)) { New-Item -ItemType Directory -Path $_ -Force | Out-Null; Write-Info "created $_" }
}
$Script:LogDir = $logDir

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

# 4. Copy center files (exclude node_modules + tests + appsettings.json + project-local nssm/)
$srcDir = Join-Path $projectRoot 'center'
Copy-Item -Path (Join-Path $srcDir '*') -Destination $InstallPath -Recurse -Force -Exclude 'node_modules','tests','appsettings.json'
if (-not (Test-Path (Join-Path $InstallPath 'node_modules'))) {
  Write-Step "installing center node_modules"
  Push-Location $InstallPath
  try { npm install --omit=dev } finally { Pop-Location }
}
Copy-Item -Path (Join-Path $distPath '*') -Destination (Join-Path $InstallPath 'dist') -Recurse -Force

# 5. Register and start service
Install-NssmService -Name 'ADDashboardCenter' `
  -Application $node `
  -AppDirectory $InstallPath `
  -AppParameters 'server.js' `
  -DisplayName 'AD Replication Dashboard Center' `
  -Description 'AD Replication Dashboard Center (Node.js + Express + Vue 3)' `
  -Start 2

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
