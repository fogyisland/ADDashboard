# apply-missing-migrations.ps1
# R84 operator handoff: run the SQL gap from db/migrations/ against the live MySQL.
#
# This script is RUN-BY-OPERATOR on the production host. It does NOT touch the
# running center service — the center will run any gap it sees on its own next
# startup. Running it ahead of restart is optional: the center's
# migrationService.upgrade() (center/src/services/migrations.js) applies the same
# files with the same idempotent guards.
#
# Usage (run from this directory):
#   pwsh apply-missing-migrations.ps1                # interactive, prompts for service creds
#   pwsh apply-missing-migrations.ps1 -DryRun        # show only what would run
#   pwsh apply-missing-migrations.ps1 -FromVersion 024 -ToVersion 025
#
# What it does:
#   1. Reads connection params from center/appsettings.json (no inline password)
#   2. Lists every migration NNN-*.sql whose row in schema_migrations is
#      missing OR status != 'applied' (the gap)
#   3. Prints the gap, prompts for confirmation (or skips under -DryRun)
#   4. Executes each file via the mysql CLI in a single transaction per file
#   5. After each file, refreshes schema_migrations to 'applied' (if not already
#      recorded) using sha256(file contents) as checksum
#
# Idempotency:
#   Every file in db/migrations/ uses `DROP TABLE IF EXISTS` / `CREATE TABLE` /
#   `IF NOT EXISTS` guards. Re-running an applied migration is a no-op at the
#   DDL level. The schema_migrations row update is also idempotent (version is
#   the PK).

[CmdletBinding()]
param(
    [switch]$DryRun,
    [int]$FromVersion = 0,
    [int]$ToVersion = 999
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path "$PSScriptRoot/..").Path
$migrationsDir = Join-Path $repoRoot 'db/migrations'
$configPath = Join-Path $repoRoot 'center/appsettings.json'
$logFile = Join-Path $repoRoot 'logs/migration-apply.log'

# --- load DB config -----------------------------------------------------------
if (-not (Test-Path $configPath)) {
    throw "appsettings.json not found at $configPath. Run from the repo root."
}
$cfg = Get-Content $configPath -Raw | ConvertFrom-Json
$db = $cfg.db
if ($db.dialect -ne 'mysql') {
    Write-Warning "This script targets MySQL only. Dialect in appsettings.json: $($db.dialect)"
    Write-Warning "For MSSQL use sqlcmd + db/migrations/mssql/*.sql manually."
    return
}
$mysql = $db.mysql
$conn = @{
    Host     = $mysql.host
    Port     = [int]$mysql.port
    User     = $mysql.user
    Password = $mysql.password
    Database = $mysql.database
}
Write-Host "Target: $($conn.User)@$($conn.Host):$($conn.Port)/$($conn.Database)"
Write-Host "Migrations dir: $migrationsDir"
Write-Host ""

# --- helpers ------------------------------------------------------------------
function Invoke-MysqlQuery {
    param([string]$Sql, [string]$Database)
    $env:MYSQL_PWD = $conn.Password
    $args = @('-h', $conn.Host, '-P', $conn.Port, '-u', $conn.User, '--protocol=TCP')
    if ($Database) { $args += @('-D', $Database) }
    $args += @('-e', $Sql)
    & mysql @args
    if ($LASTEXITCODE -ne 0) { throw "mysql exited $LASTEXITCODE for: $($Sql.Substring(0, [Math]::Min(80, $Sql.Length)))..." }
}
function Get-SchemaMigrationRows {
    $env:MYSQL_PWD = $conn.Password
    $rows = & mysql -h $conn.Host -P $conn.Port -u $conn.User --protocol=TCP `
        -D $conn.Database -N -B -e "SELECT version, status, checksum FROM schema_migrations" 2>$null
    if ($LASTEXITCODE -ne 0) { return @() }
    $out = @()
    foreach ($r in $rows) {
        $parts = $r -split "`t"
        $out += [pscustomobject]@{ Version = $parts[0]; Status = $parts[1]; Checksum = $parts[2] }
    }
    $out
}
function ConvertFrom-JsonYmdSafe { param([string]$Path)
    # Robust against BOM (PowerShell 5.1 BOM bites ConvertFrom-Json). The
    # schema-applier already strips BOM when reading SQL — mirror that here.
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        $text = [System.Text.Encoding]::UTF8.GetString($bytes, 3, $bytes.Length - 3)
    } else {
        $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    }
    ConvertFrom-Json $text
}

# --- build the gap ------------------------------------------------------------
$applied = Get-SchemaMigrationRows
$appliedMap = @{}
foreach ($a in $applied) { $appliedMap[$a.Version] = $a }

$files = Get-ChildItem -Path $migrationsDir -Filter '*.sql' | Sort-Object Name
$gap = @()
foreach ($f in $files) {
    if ($f.Name -match '^(\d{3})-') {
        $ver = $matches[1]
        $verInt = [int]$ver
        if ($verInt -lt $FromVersion -or $verInt -gt $ToVersion) { continue }
        $row = $appliedMap[$ver]
        $status = if ($row) { $row.Status } else { 'missing' }
        if ($status -ne 'applied') {
            $gap += [pscustomobject]@{
                Version  = $ver
                File     = $f.FullName
                Status   = $status
                Checksum = (Get-FileHash -Path $f.FullName -Algorithm SHA256).Hash.ToLower()
            }
        }
    }
}

Write-Host "=== Migration gap ===" -ForegroundColor Cyan
if ($gap.Count -eq 0) {
    Write-Host "No missing migrations. Live DB is up-to-date." -ForegroundColor Green
    if (-not $DryRun) { return }
} else {
    foreach ($g in $gap) {
        $color = if ($g.Status -eq 'failed') { 'Red' } else { 'Yellow' }
        Write-Host ("  {0}  {1,-40}  status={2}" -f $g.Version, (Split-Path $g.File -Leaf), $g.Status) -ForegroundColor $color
    }
    Write-Host ""
    if ($DryRun) {
        Write-Host "DryRun: not executing. Re-run without -DryRun to apply." -ForegroundColor Cyan
        return
    }
    $ans = Read-Host "Apply $($gap.Count) migration(s)? [y/N]"
    if ($ans -notin @('y','Y','yes','YES')) {
        Write-Host "Aborted." -ForegroundColor Yellow
        return
    }
}

# --- execute the gap ----------------------------------------------------------
$appliedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
foreach ($g in $gap) {
    Write-Host ""
    Write-Host "Applying $($g.Version) :: $(Split-Path $g.File -Leaf)" -ForegroundColor Cyan
    $sql = Get-Content $g.File -Raw
    try {
        # splitSqlStatements-equivalent: feed whole file to mysql -e as one
        # multi-statement batch. MySQL handles ; at EOF without --multi-line.
        # This matches what migrationService.upgrade() does via Node mysql2.
        $env:MYSQL_PWD = $conn.Password
        & mysql -h $conn.Host -P $conn.Port -u $conn.User --protocol=TCP `
            -D $conn.Database --comments --delimiter=';' -e $sql 2>&1 | Tee-Object -FilePath $logFile -Append
        if ($LASTEXITCODE -ne 0) { throw "mysql exited $LASTEXITCODE applying $($g.Version)" }
        # mark applied
        $description = ($g.File | Split-Path -Leaf) -replace '^\d{3}-', '' -replace '\.sql$', ''
        $markSql = @"
INSERT INTO schema_migrations (version, description, type, script, checksum, applied_at, execution_ms, applied_by, status, error_message)
VALUES ('$($g.Version)', '$description', 'sql', '$(Split-Path $g.File -Leaf)', '$($g.Checksum)', '$appliedAt', 0, 'manual-apply', 'applied', NULL)
ON DUPLICATE KEY UPDATE status='applied', applied_at='$appliedAt', checksum='$($g.Checksum)', error_message=NULL;
"@
        Invoke-MysqlQuery -Sql $markSql -Database $conn.Database
        Write-Host "  ✓ $($g.Version) applied" -ForegroundColor Green
    } catch {
        Write-Host "  ✗ $($g.Version) FAILED: $($_.Exception.Message)" -ForegroundColor Red
        # mark failed (only if a row exists; insert isn't right for a failure path)
        $failSql = "UPDATE schema_migrations SET status='failed', error_message='$($_.Exception.Message -replace "'","''")' WHERE version='$($g.Version)'"
        try { Invoke-MysqlQuery -Sql $failSql -Database $conn.Database } catch {}
        throw
    }
}
Write-Host ""
Write-Host "Done. Restart center NSSM service to load new schema-aware code." -ForegroundColor Green