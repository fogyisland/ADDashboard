# SECURITY: this script interpolates SQL strings; only safe for installer-time usage, not runtime queries.
[CmdletBinding()]
param(
  [string]$InstallPath = 'C:\Program Files\ADDashboard\Center',
  [Parameter(Mandatory)][string]$SqlServer,
  [string]$SqlDatabase = 'AD_Monitoring',
  [string]$SqlUser = 'sa',
  [Parameter(Mandatory)][string]$SqlPassword,
  [int]$ListenPort = 8080,
  [string]$AgentToken,
  [string]$JwtSecret
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'common\Logger.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\NSSM.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\Service.psm1') -Force

Write-Step "install-center: $InstallPath"

# 1. Ensure directories
@($InstallPath, "$InstallPath\dist", 'C:\ProgramData\ADDashboard\Logs') | ForEach-Object {
  if (-not (Test-Path $_)) { New-Item -ItemType Directory -Path $_ -Force | Out-Null; Write-Info "created $_" }
}

# 2. Verify Node.js
$node = (Get-Command node.exe -ErrorAction Stop).Source
Write-Info "node: $node"

# 3. Apply database schema
$saCs = "Server=$SqlServer;Database=master;User ID=$SqlUser;Password=$SqlPassword;TrustServerCertificate=True"
if (-not (Invoke-Sqlcmd -ConnectionString $saCs -Query "SELECT DB_ID('$SqlDatabase')" -ErrorAction SilentlyContinue).Column1) {
  Write-Step "creating database $SqlDatabase"
  Invoke-Sqlcmd -ConnectionString $saCs -Query "CREATE DATABASE [$SqlDatabase]"
} else { Write-Info "database $SqlDatabase exists" }

$appCs = "Server=$SqlServer;Database=$SqlDatabase;User ID=$SqlUser;Password=$SqlPassword;TrustServerCertificate=True"
$schemaDir = Join-Path $PSScriptRoot '..\db\schema'
foreach ($f in @('01-tables.sql','02-seed-roles.sql')) {
  Write-Step "applying $f"
  Invoke-Sqlcmd -ConnectionString $appCs -InputFile (Join-Path $schemaDir $f)
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
  sql = @{ server = $SqlServer; database = $SqlDatabase; user = $SqlUser; password = $SqlPassword; options = @{ encrypt = $false; trustServerCertificate = $true } }
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

# 7. Set Agent token in DB
$tokenEsc = $AgentToken.Replace("'", "''")
Invoke-Sqlcmd -ConnectionString $appCs -Query "UPDATE system_config SET config_value = '$tokenEsc', updated_at = GETUTCDATE() WHERE config_key = 'ad_agent_token'"

# 8. Create initial admin user if none exists
$hasAdmin = Invoke-Sqlcmd -ConnectionString $appCs -Query "SELECT COUNT(*) AS n FROM sys_users u JOIN sys_roles r ON u.role_id=r.id WHERE r.role_name='admin'"
if ($hasAdmin.n -eq 0) {
  $initialPw = -join ((1..16) | ForEach-Object { [char[]]([char]33..[char]126) | Get-Random })
  $hash = & node -e "const b=require('bcrypt');b.hash(process.argv[1],12).then(h=>process.stdout.write(h))" $initialPw
  $hashEsc = $hash.Replace("'", "''")
  $pwEsc = $initialPw.Replace("'", "''")
  Invoke-Sqlcmd -ConnectionString $appCs -Query "INSERT INTO sys_users (username, password_hash, role_id) VALUES ('admin', '$hashEsc', (SELECT id FROM sys_roles WHERE role_name='admin'))"
  Write-Ok "initial admin / $initialPw"
  Add-Content -Path (Join-Path $Script:LogDir 'install.log') -Value "INITIAL_ADMIN_PASSWORD=$initialPw"
}

# 9. Register and start service
Install-NssmService -Name 'ADDashboardCenter' `
  -Application $node `
  -AppDirectory $InstallPath `
  -AppParameters 'server.js' `
  -DependOnService @('MSSQLSERVER') `
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
