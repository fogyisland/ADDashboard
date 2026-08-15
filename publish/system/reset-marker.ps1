[CmdletBinding()]
param(
  [string]$InstallDir = 'D:\dashboard\center',
  [string]$Service    = 'ADDashboardCenter',
  [string]$LogDir     = 'C:\addashboard\Logs'
)
$ErrorActionPreference = 'Stop'

Stop-Service $Service -Force -ErrorAction SilentlyContinue
(Get-Service $Service).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30)) | Out-Null

$envFile = Join-Path $InstallDir '.env'
if (Test-Path -LiteralPath $envFile) {
  Copy-Item -LiteralPath $envFile -Destination "$envFile.backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')" -Force
  Remove-Item -LiteralPath $envFile -Force
  Write-Host "removed marker: $envFile"
}

$cfgFile = Join-Path $InstallDir 'appsettings.json'
if (Test-Path -LiteralPath $cfgFile) {
  Copy-Item -LiteralPath $cfgFile -Destination "$cfgFile.backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')" -Force
  Remove-Item -LiteralPath $cfgFile -Force
  Write-Host "removed appsettings.json: $cfgFile"
}

# Clear registry marker (both 32/64 bit views)
& reg.exe delete 'HKLM\SOFTWARE\ADDashboard' /v Initialized /f 2>&1 | Out-Null
Write-Host "registry marker cleared (if it existed)"

Start-Service $Service
Start-Sleep -Seconds 6

Get-Service $Service | Format-List Name, Status, StartType
try {
  $h = Invoke-WebRequest 'http://localhost:8080/healthz' -UseBasicParsing -TimeoutSec 5
  Write-Host "healthz: $($h.Content)"
} catch {
  Write-Host "healthz unreachable: $($_.Exception.Message)"
}
try {
  $s = Invoke-WebRequest 'http://localhost:8080/api/init/status' -UseBasicParsing -TimeoutSec 5
  Write-Host "init/status: $($s.Content)"
} catch {
  Write-Host "init/status unreachable: $($_.Exception.Message)"
}
