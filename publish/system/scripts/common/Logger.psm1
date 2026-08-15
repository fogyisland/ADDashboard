$Script:LogDir = 'C:\addashboard\Logs'
if (-not (Test-Path $Script:LogDir)) { New-Item -ItemType Directory -Path $Script:LogDir -Force | Out-Null }

function Write-Log {
  param([string]$Level, [string]$Message)
  $line = "{0} [{1}] {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
  Write-Host $line
  Add-Content -Path (Join-Path $Script:LogDir 'install.log') -Value $line
}

function Write-Step { param([string]$Message) Write-Log 'STEP' $Message }
function Write-Info { param([string]$Message) Write-Log 'INFO' $Message }
function Write-Warn2 { param([string]$Message) Write-Log 'WARN' $Message }
function Write-Err2 { param([string]$Message) Write-Log 'ERROR' $Message }
function Write-Ok { param([string]$Message) Write-Log 'OK' $Message }