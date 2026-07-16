# Green version launcher (PowerShell wrapper). Forwards all args to start.js.
$ErrorActionPreference = 'Stop'
$node = (Get-Command node.exe -ErrorAction SilentlyContinue)
if (-not $node) {
  Write-Error "[green] Node.js not found in PATH. Install Node.js 18+ from https://nodejs.org/"
  exit 1
}
& node "$PSScriptRoot\start.js" @args