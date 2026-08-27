# ============================================================================
# mock-daemon-start.ps1 — launch the mock heartbeat daemon with correct ports
#
# Why this exists (R34.1):
#   mock-heartbeat-daemon.mjs defaults CENTER_URL=http://127.0.0.1:8081 and
#   REPORT_URL=http://127.0.0.1:8082. Round-34's silent-stop incident:
#   operator changed the centre's heartbeat/report ports to 9081/9082 via the
#   admin UI but kept launching the daemon with the baked-in defaults. The
#   daemon then POSTed to dead ports; the dashboard's 最近报告 column froze
#   and operators thought "no issues" when reality was "no data".
#
#   This wrapper reads the LIVE ports from system_config and passes them as
#   env vars, so launching it is safe regardless of admin-UI overrides.
#
# Usage:
#   pwsh -File scripts/mock-daemon-start.ps1
#   pwsh -File scripts/mock-daemon-start.ps1 -WhatIf        # print + exit
#   pwsh -File scripts/mock-daemon-start.ps1 -CenterPath .\center
#
# PowerShell 5.1 + pwsh 7+ compatible. No `??`, no ternary.
# ============================================================================

[CmdletBinding()]
param(
  # Path to the center/ directory containing appsettings.json + mock-heartbeat-daemon.mjs.
  # Auto-detected from the script's own location; override only if your layout is unusual.
  [string]$CenterPath,
  # Path to appsettings.json. Defaults to <CenterPath>/appsettings.json.
  [string]$AppsettingsPath,
  # Path to node.exe. Defaults to <CenterPath>/../node/node.exe (green-package layout) or PATH.
  [string]$NodePath,
  # Print resolved ports + command, do NOT actually spawn the daemon. Used by Pester + dry-run.
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'

# ---- Layout resolution ----
# The script lives at <repo>/scripts/mock-daemon-start.ps1. The center/ is at:
#   - <repo>/center/                 (dev tree)
#   - <repo>/publish/system/center/  (green-package / publish mirror)
# We detect by walking up from $PSScriptRoot looking for a directory that
# contains both appsettings.json AND mock-heartbeat-daemon.mjs.

function Resolve-CenterPath {
  param([string]$ScriptDir)
  $scriptParent = Split-Path -Parent $ScriptDir
  $candidates = @(
    (Join-Path $scriptParent 'center'),
    (Join-Path $scriptParent 'publish\system\center')
  )
  foreach ($p in $candidates) {
    if ($p -and (Test-Path -LiteralPath (Join-Path $p 'appsettings.json')) -and
        (Test-Path -LiteralPath (Join-Path $p 'mock-heartbeat-daemon.mjs'))) {
      return (Resolve-Path -LiteralPath $p).Path
    }
  }
  return $null
}

if (-not $CenterPath) {
  $CenterPath = Resolve-CenterPath -ScriptDir $PSScriptRoot
  if (-not $CenterPath) {
    throw "Cannot find center/ directory with both appsettings.json and mock-heartbeat-daemon.mjs. Pass -CenterPath explicitly."
  }
} elseif (-not (Test-Path -LiteralPath $CenterPath)) {
  throw "CenterPath does not exist: $CenterPath"
}

if (-not $AppsettingsPath) { $AppsettingsPath = Join-Path $CenterPath 'appsettings.json' }
if (-not (Test-Path -LiteralPath $AppsettingsPath)) {
  throw "appsettings.json not found at: $AppsettingsPath. Pass -AppsettingsPath explicitly."
}

$DaemonsPath = Join-Path $CenterPath 'mock-heartbeat-daemon.mjs'
if (-not (Test-Path -LiteralPath $DaemonsPath)) {
  throw "mock-heartbeat-daemon.mjs not found at: $DaemonsPath"
}

# ---- Node path resolution (mirrors Register-ADDashboardAgent.ps1) ----
if (-not $NodePath) {
  $repoRoot = Split-Path -Parent $CenterPath
  $candidates = @(
    (Join-Path $repoRoot 'node\node.exe'),
    (Join-Path $CenterPath '..\node\node.exe')
  )
  foreach ($p in $candidates) {
    if ($p -and (Test-Path -LiteralPath $p)) { $NodePath = $p; break }
  }
  if (-not $NodePath) {
    $onPath = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($onPath) { $NodePath = $onPath.Source }
  }
}
if (-not $NodePath) {
  throw 'node.exe not found. Install Node.js 20 LTS or ensure <repo>/node/node.exe exists (green-package layout).'
}

# ---- Read live ports via the Node helper ----
$helper = Join-Path $PSScriptRoot 'read-center-ports.mjs'
if (-not (Test-Path -LiteralPath $helper)) {
  throw "read-center-ports.mjs missing at: $helper"
}

$json = & $NodePath $helper $AppsettingsPath 2>&1
if ($LASTEXITCODE -ne 0) {
  # & 2>&1 captures both streams; if anything was written to stderr, surface it.
  $stderr = ($json | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] }) 2>$null
  $stdout = ($json | Where-Object { $_ -is [string] }) -join "`n"
  throw "read-center-ports.mjs failed (exit=$LASTEXITCODE). Output: $stdout"
}

try {
  $ports = $json | ConvertFrom-Json
} catch {
  throw "read-center-ports.mjs returned non-JSON: $json"
}

Write-Host ("[mock-daemon-start] centre ports (source: {0}):" -f $ports.source)
Write-Host ("  listen     = {0}" -f $ports.listenPort)
Write-Host ("  heartbeat  = {0}  -> CENTER_URL" -f $ports.heartbeatPort)
Write-Host ("  report     = {0}  -> REPORT_URL" -f $ports.reportPort)

$centerUrl  = "http://127.0.0.1:$($ports.heartbeatPort)"
$reportUrl  = "http://127.0.0.1:$($ports.reportPort)"

# Mock agent token — read from appsettings.json so the daemon's X-Agent-Token
# header matches what the running centre expects.
$appsettingsRaw = Get-Content -LiteralPath $AppsettingsPath -Raw
$appsettingsObj = $appsettingsRaw | ConvertFrom-Json
$agentToken = $appsettingsObj.agentToken
if (-not $agentToken) {
  throw 'appsettings.json missing agentToken — the centre cannot authenticate the daemon.'
}

$env:CENTER_URL = $centerUrl
$env:REPORT_URL = $reportUrl
$env:AGENT_TOKEN = $agentToken

Write-Host ("[mock-daemon-start] daemon: {0}" -f $DaemonsPath)
Write-Host ("  CENTER_URL  = {0}" -f $env:CENTER_URL)
Write-Host ("  REPORT_URL  = {0}" -f $env:REPORT_URL)
$tokHead = $agentToken.Substring(0, [Math]::Min(8, $agentToken.Length))
$tokTail = $agentToken.Substring([Math]::Max(0, $agentToken.Length - 4))
Write-Host ("  AGENT_TOKEN = {0}...{1}" -f $tokHead, $tokTail)

if ($WhatIf) {
  Write-Host '[mock-daemon-start] -WhatIf set — not spawning daemon.'
  return
}

Write-Host '[mock-daemon-start] spawning daemon. Ctrl+C to stop.'
& $NodePath $DaemonsPath
if ($LASTEXITCODE -ne 0) {
  throw "mock-heartbeat-daemon.mjs exited with code $LASTEXITCODE"
}