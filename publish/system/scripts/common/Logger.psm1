# Default LogDir resolves relative to the script's own publish root (parent of
# scripts/common/) — install/update/uninstall callers always override this via
# Set-LogDir, but the fallback matters for any ad-hoc use of the module.
$Script:LogDir = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'Logs'
if (-not (Test-Path $Script:LogDir)) { New-Item -ItemType Directory -Path $Script:LogDir -Force | Out-Null }

function Set-LogDir {
  param([string]$Path)
  if ($Path) {
    $Script:LogDir = $Path
    if (-not (Test-Path $Script:LogDir)) {
      New-Item -ItemType Directory -Path $Script:LogDir -Force | Out-Null
    }
  }
}

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