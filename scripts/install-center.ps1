# AD Dashboard Center installer (MySQL 5.7+ / SQL Server 2014+).
# - Branches by -DbDialect: 'mysql' uses `mysql.exe`, 'mssql' uses `sqlcmd`.
# - For mysql, the client binary is 'mysql' on PATH (or set -SqlClient).
# - For mssql, the client binary is 'sqlcmd' on PATH (or set -SqlClient).
# - Bootstrap DB, apply schema + seed, write appsettings.json, register NSSM
#   service for `node server.js`, set initial admin if none.
[CmdletBinding()]
param(
  [string]$InstallPath = 'C:\Program Files\ADDashboard\Center',
  [ValidateSet('mysql','mssql')][string]$DbDialect = 'mysql',
  [string]$DbServer,    # mssql: 'host\instance' or 'host,port'; if set, overrides DbHost/DbPort for the connection string
  [Parameter(Mandatory)][string]$DbHost,
  [int]$DbPort,         # default picked per dialect below (3306 mysql / 1433 mssql)
  [string]$DbDatabase = 'AD_Monitoring',
  [string]$DbUser = '',
  [Parameter(Mandatory)][string]$DbPassword,
  [int]$ListenPort = 8080,
  [string]$AgentToken,
  [string]$JwtSecret,
  [string]$SqlClient    # override path to mysql.exe / sqlcmd; defaults to bare name on PATH
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'common\Logger.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\NSSM.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\Service.psm1') -Force

# 0. Resolve dialect-specific defaults for port + client binary.
if (-not $DbUser) {
  $DbUser = switch ($DbDialect) {
    'mysql'  { 'root' }
    'mssql'  { 'sa' }
  }
  Write-Info "DbUser defaulting to '$DbUser' for dialect '$DbDialect'"
}
if (-not $DbPort) {
  $DbPort = if ($DbDialect -eq 'mssql') { 1433 } else { 3306 }
}
if (-not $SqlClient) {
  $SqlClient = if ($DbDialect -eq 'mssql') { 'sqlcmd' } else { 'mysql' }
}

Write-Step "install-center: $InstallPath (dialect=$DbDialect)"

# 1. Verify the SQL CLI is callable
if (-not (Get-Command $SqlClient -ErrorAction SilentlyContinue)) {
  throw "$DbDialect client not on PATH (looked for '$SqlClient'); install $DbDialect client tools or set -SqlClient"
}
Write-Info "$DbDialect client: $SqlClient"

# 2. Ensure directories
@($InstallPath, "$InstallPath\dist", 'C:\ProgramData\ADDashboard\Logs') | ForEach-Object {
  if (-not (Test-Path $_)) { New-Item -ItemType Directory -Path $_ -Force | Out-Null; Write-Info "created $_" }
}

# 3. Verify Node.js
$node = (Get-Command node.exe -ErrorAction Stop).Source
Write-Info "node: $node"

# 4. Build connection args + dialect-aware SQL helper.
#    For mysql:  -h host -P port -u user -p<pw> [--protocol=TCP] [-D db] -e/-N -B
#    For mssql:  -S server[\instance | ,port] -d db -U user -P pw [-C trust cert] -Q/-i
#
#    $DbServer is for mssql only — when set it overrides host:port (e.g. named instances,
#    or a non-default port embedded in the server string). For mysql, $DbHost/$DbPort are
#    used directly because mysql.exe doesn't support an equivalent 'server string' flag.
$connArgs = if ($DbDialect -eq 'mssql') {
  $server = if ($DbServer) { $DbServer } else { "$DbHost,$DbPort" }
  @('-S', $server, '-d', $DbDatabase, '-U', $DbUser, '-P', $DbPassword, '-C') # -C = trust server cert
} else {
  @('-h', $DbHost, '-P', $DbPort, '-u', $DbUser, "-p$DbPassword", '--protocol=TCP')
}
# $connArgsNoDb is used for server-level calls (CREATE DATABASE) where no -d/-D is wanted.
$connArgsNoDb = if ($DbDialect -eq 'mssql') {
  $server = if ($DbServer) { $DbServer } else { "$DbHost,$DbPort" }
  @('-S', $server, '-U', $DbUser, '-P', $DbPassword, '-C')
} else {
  @('-h', $DbHost, '-P', $DbPort, '-u', $DbUser, "-p$DbPassword", '--protocol=TCP')
}

function Invoke-Sql {
  # Invoke-Sql -Sql "CREATE DATABASE ..."
  # Invoke-Sql -Sql @("SELECT 1", "SELECT 2") -NoDatabase (server-level call)
  param(
    [Parameter(Mandatory)][string[]]$Sql,
    [switch]$NoDatabase
  )
  $base = if ($NoDatabase) { $connArgsNoDb } else { $connArgs }
  foreach ($s in $Sql) {
    Write-Info "sql> $s"
    if ($DbDialect -eq 'mssql') {
      # sqlcmd takes a single -Q "query" string per invocation.
      & $SqlClient @base -Q $s
    } else {
      # mysql.exe accepts -e "sql" for a single inline statement.
      & $SqlClient @base -e $s
    }
    if ($LASTEXITCODE -ne 0) { throw "$DbDialect client failed for: $s" }
  }
}

function Invoke-SqlFile {
  # Invoke-SqlFile -Path ./schema/01-tables.sql
  param([Parameter(Mandatory)][string]$Path)
  Write-Info "sqlfile> $Path"
  if ($DbDialect -eq 'mssql') {
    & $SqlClient @connArgs -i $Path
  } else {
    Get-Content $Path -Encoding UTF8 | & $SqlClient @connArgs
  }
  if ($LASTEXITCODE -ne 0) { throw "$DbDialect client failed applying: $Path" }
}

# 5. Apply database schema (dialect-aware paths)
if ($DbDialect -eq 'mssql') {
  # Operator pre-creates the empty SQL Server database per spec; no CREATE DATABASE here.
  Write-Info "mssql: assuming '$DbDatabase' already exists on $DbHost"
} else {
  Invoke-Sql -Sql "CREATE DATABASE IF NOT EXISTS ``$DbDatabase`` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci" -NoDatabase
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$schemaDir = Join-Path $repoRoot (Join-Path 'db\schema' $DbDialect)
foreach ($f in @('01-tables.sql','02-seed-roles.sql')) {
  Write-Step "applying schema/$DbDialect/$f"
  Invoke-SqlFile -Path (Join-Path $schemaDir $f)
}

$migrationsDir = Join-Path $repoRoot (Join-Path 'db\migrations' $DbDialect)
if (Test-Path $migrationsDir) {
  Get-ChildItem -Path $migrationsDir -Filter '*.sql' | Sort-Object Name | ForEach-Object {
    Write-Step "applying migration/$DbDialect/$($_.Name)"
    Invoke-SqlFile -Path $_.FullName
  }
}

# 6. Build frontend if dist missing
$distPath = Join-Path $repoRoot 'frontend\dist'
if (-not (Test-Path (Join-Path $distPath 'index.html'))) {
  Write-Step "building frontend"
  Push-Location $repoRoot
  try { npm run build:frontend } finally { Pop-Location }
}

# 7. Copy center files (assume already built/transpiled; if not, install prod deps)
$srcDir = Join-Path $repoRoot 'center'
Copy-Item -Path (Join-Path $srcDir '*') -Destination $InstallPath -Recurse -Force -Exclude 'node_modules','tests','appsettings.json'
if (-not (Test-Path (Join-Path $InstallPath 'node_modules'))) {
  Write-Step "installing center node_modules"
  Push-Location $InstallPath
  try { npm install --omit=dev } finally { Pop-Location }
}
Copy-Item -Path (Join-Path $distPath '*') -Destination (Join-Path $InstallPath 'dist') -Recurse -Force

# 8. Generate config (dialect-aware shape: db.dialect + db.<dialect> block)
if (-not $AgentToken) { $AgentToken = [Guid]::NewGuid().Guid }
if (-not $JwtSecret) { $JwtSecret = -join ((1..48) | ForEach-Object { [char[]]([char]33..[char]126) | Get-Random }) }

if ($DbDialect -eq 'mssql') {
  # mssql uses 'server' (optionally with \instance or ,port) plus separate port.
  $dialectCfg = @{ server = $DbHost; port = $DbPort; database = $DbDatabase; user = $DbUser; password = $DbPassword }
} else {
  $dialectCfg = @{ host = $DbHost; port = $DbPort; database = $DbDatabase; user = $DbUser; password = $DbPassword }
}

$cfg = @{
  db = @{ dialect = $DbDialect; $DbDialect = $dialectCfg }
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

# 9. Set Agent token in DB (dialect-aware upsert)
if ($DbDialect -eq 'mssql') {
  # MERGE … USING (VALUES …) is the canonical SQL Server 2014+ upsert pattern.
  $tokenSetSql = @(
    "MERGE INTO system_config AS t USING (VALUES ('agent_token', '$AgentToken')) AS s(config_key, config_value) ON t.config_key = s.config_key WHEN MATCHED THEN UPDATE SET config_value = s.config_value, updated_at = SYSUTCDATETIME() WHEN NOT MATCHED THEN INSERT (config_key, config_value) VALUES (s.config_key, s.config_value);"
  )
} else {
  $tokenSetSql = @(
    "INSERT INTO system_config (config_key, config_value) VALUES ('agent_token', '$AgentToken') ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), updated_at = CURRENT_TIMESTAMP"
  )
}
Invoke-Sql -Sql $tokenSetSql

# 10. Create initial admin user if none exists.
#     COUNT(*) join is dialect-agnostic; admin insert differs: mysql uses
#     INSERT … VALUES (…, (SELECT …)), mssql uses INSERT … SELECT … FROM.
$adminCheckSql = "SELECT COUNT(*) AS n FROM sys_users u JOIN sys_roles r ON u.role_id = r.id WHERE r.role_name = 'admin'"
$count = Invoke-Sql -Sql $adminCheckSql
if ([int]$count -eq 0) {
  $initialPw = -join ((1..16) | ForEach-Object { [char[]]([char]33..[char]126) | Get-Random })
  $hash = & node -e "const b=require('bcrypt');b.hash(process.argv[1],12).then(h=>process.stdout.write(h))" $initialPw
  $hashEsc = $hash -replace "'", "''"
  $pwEsc = $initialPw -replace "'", "''"
  if ($DbDialect -eq 'mssql') {
    Invoke-Sql -Sql "INSERT INTO sys_users (username, password_hash, role_id) SELECT 'admin', '$hashEsc', id FROM sys_roles WHERE role_name = 'admin'"
  } else {
    Invoke-Sql -Sql "INSERT INTO sys_users (username, password_hash, role_id) VALUES ('admin', '$hashEsc', (SELECT id FROM sys_roles WHERE role_name = 'admin'))"
  }
  Write-Ok "initial admin / $initialPw"
  Add-Content -Path (Join-Path $Script:LogDir 'install.log') -Value "INITIAL_ADMIN_PASSWORD=$initialPw"
}

# 11. Register and start service. Skip OnStart dependency for the database — its
#     service name varies by dialect and install (MySQL / MySQL80 / MariaDB /
#     MSSQLSERVER / MSSQL$INSTANCENAME). The connection retry in the Node service
#     handles transient outages at boot.
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

# 12. Probe health
$health = try { (Invoke-WebRequest -Uri "http://localhost:$ListenPort/healthz" -UseBasicParsing -TimeoutSec 10).Content } catch { "unreachable: $($_.Exception.Message)" }
Write-Ok "health: $health"
Write-Ok "URL: http://localhost:$ListenPort"
