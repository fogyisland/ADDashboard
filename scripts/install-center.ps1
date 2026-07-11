# AD Dashboard Center installer (MySQL 8+).
# - Uses `mysql.exe` CLI; the installer assumes it is on PATH (or set $MySqlClient).
# - Bootstrap DB, apply schema + seed, write appsettings.json, register NSSM
#   service for `node server.js`, set initial admin if none.
[CmdletBinding()]
param(
  [string]$InstallPath = 'C:\Program Files\ADDashboard\Center',
  [Parameter(Mandatory)][string]$MySqlHost,
  [int]$MySqlPort = 3306,
  [string]$MySqlDatabase = 'AD_Monitoring',
  [string]$MySqlUser = 'root',
  [Parameter(Mandatory)][string]$MySqlPassword,
  [int]$ListenPort = 8080,
  [string]$AgentToken,
  [string]$JwtSecret,
  [string]$MySqlClient = 'mysql'
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'common\Logger.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\NSSM.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\Service.psm1') -Force

Write-Step "install-center: $InstallPath"

# 0. Verify mysql.exe is callable
if (-not (Get-Command $MySqlClient -ErrorAction SilentlyContinue)) {
  throw "mysql client not on PATH (looked for '$MySqlClient'); install MySQL 8 client or set -MySqlClient"
}
Write-Info "mysql client: $MySqlClient"

# 1. Ensure directories
@($InstallPath, "$InstallPath\dist", 'C:\ProgramData\ADDashboard\Logs') | ForEach-Object {
  if (-not (Test-Path $_)) { New-Item -ItemType Directory -Path $_ -Force | Out-Null; Write-Info "created $_" }
}

# 2. Verify Node.js
$node = (Get-Command node.exe -ErrorAction Stop).Source
Write-Info "node: $node"

# 3. Apply database schema
function Invoke-MySql {
  # Invoke-MySql -Sql "CREATE DATABASE IF NOT EXISTS `...`"
  # Invoke-MySql -Sql @("SELECT 1", "SELECT 2")
  param([Parameter(Mandatory)][string[]]$Sql)
  $args = @('-h', $MySqlHost, '-P', $MySqlPort, '-u', $MySqlUser, "-p$MySqlPassword", '--protocol=TCP')
  foreach ($s in $Sql) {
    Write-Info "sql> $s"
    & $MySqlClient @args -e $s
    if ($LASTEXITCODE -ne 0) { throw "mysql failed for: $s" }
  }
}

Invoke-MySql -Sql "CREATE DATABASE IF NOT EXISTS ``$MySqlDatabase`` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"

foreach ($f in @('01-tables.sql','02-seed-roles.sql')) {
  Write-Step "applying $f"
  $schemaPath = Join-Path (Join-Path $PSScriptRoot '..\db\schema') $f
  $args = @('-h', $MySqlHost, '-P', $MySqlPort, '-u', $MySqlUser, "-p$MySqlPassword", $MySqlDatabase, '--protocol=TCP')
  Get-Content $schemaPath -Encoding UTF8 | & $MySqlClient @args
  if ($LASTEXITCODE -ne 0) { throw "mysql failed applying $f" }
}

# 4. Build frontend if dist missing
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$distPath = Join-Path $repoRoot 'frontend\dist'
if (-not (Test-Path (Join-Path $distPath 'index.html'))) {
  Write-Step "building frontend"
  Push-Location $repoRoot
  try { npm run build:frontend } finally { Pop-Location }
}

# 5. Copy center files (assume already built/transpiled; if not, install prod deps)
$srcDir = Join-Path $repoRoot 'center'
Copy-Item -Path (Join-Path $srcDir '*') -Destination $InstallPath -Recurse -Force -Exclude 'node_modules','tests','appsettings.json'
if (-not (Test-Path (Join-Path $InstallPath 'node_modules'))) {
  Write-Step "installing center node_modules"
  Push-Location $InstallPath
  try { npm install --omit=dev } finally { Pop-Location }
}
Copy-Item -Path (Join-Path $distPath '*') -Destination (Join-Path $InstallPath 'dist') -Recurse -Force

# 6. Generate config
if (-not $AgentToken) { $AgentToken = [Guid]::NewGuid().Guid }
if (-not $JwtSecret) { $JwtSecret = -join ((1..48) | ForEach-Object { [char[]]([char]33..[char]126) | Get-Random }) }
$cfg = @{
  mysql = @{ host = $MySqlHost; port = $MySqlPort; database = $MySqlDatabase; user = $MySqlUser; password = $MySqlPassword }
  listenPort = $ListenPort
  jwtSecret = $JwtSecret
  agentToken = $AgentToken
  staticDir = "$InstallPath\dist"
  logLevel = 'info'
  env = 'prod'
}
$cfgPath = Join-Path $InstallPath 'appsettings.json'
$cfg | ConvertTo-Json -Depth 6 | Set-Content -Path $cfgPath -Encoding UTF8
Write-Ok "wrote $cfgPath"

# 7. Set Agent token in DB (parameterized)
$tokenSetSql = @(
  "INSERT INTO system_config (config_key, config_value) VALUES ('agent_token', '$AgentToken') ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), updated_at = CURRENT_TIMESTAMP"
)
Invoke-MySql -Sql $tokenSetSql

# 8. Create initial admin user if none exists
$adminCheckSql = "SELECT COUNT(*) AS n FROM sys_users u JOIN sys_roles r ON u.role_id = r.id WHERE r.role_name = 'admin'"
$args = @('-h', $MySqlHost, '-P', $MySqlPort, '-u', $MySqlUser, "-p$MySqlPassword", $MySqlDatabase, '--protocol=TCP', '-N', '-B', '-e', $adminCheckSql)
$count = & $MySqlClient @args
if ([int]$count -eq 0) {
  $initialPw = -join ((1..16) | ForEach-Object { [char[]]([char]33..[char]126) | Get-Random })
  $hash = & node -e "const b=require('bcrypt');b.hash(process.argv[1],12).then(h=>process.stdout.write(h))" $initialPw
  $hashEsc = $hash -replace "'", "''"
  $pwEsc = $initialPw -replace "'", "''"
  Invoke-MySql -Sql "INSERT INTO sys_users (username, password_hash, role_id) VALUES ('admin', '$hashEsc', (SELECT id FROM sys_roles WHERE role_name = 'admin'))"
  Write-Ok "initial admin / $initialPw"
  Add-Content -Path (Join-Path $Script:LogDir 'install.log') -Value "INITIAL_ADMIN_PASSWORD=$initialPw"
}

# 9. Register and start service. Skip OnStart dependency for MySQL — its service name
# varies (MySQL / MySQL80 / MariaDB); the connection retry in db.js handles transient outages.
Install-NssmService -Name 'ADDashboardCenter' `
  -Application $node `
  -AppDirectory $InstallPath `
  -AppParameters 'server.js' `
  -DisplayName 'AD Replication Dashboard Center' `
  -Description 'AD Replication Dashboard Center (Node.js + Express + Vue 3)' `
  -Start 2

if (Start-ServiceSafe -Name 'ADDashboardCenter' -WaitSeconds 20) {
  Write-Ok "service started"
} else { Write-Err2 "service failed to start; see $(Join-Path $Script:LogDir 'ADDashboardCenter-stderr.log')" }

# 10. Probe health
$health = try { (Invoke-WebRequest -Uri "http://localhost:$ListenPort/healthz" -UseBasicParsing -TimeoutSec 10).Content } catch { "unreachable: $($_.Exception.Message)" }
Write-Ok "health: $health"
Write-Ok "URL: http://localhost:$ListenPort"
