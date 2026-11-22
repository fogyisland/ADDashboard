# member-collect-now.ps1 - R161.35 step 2 (2026-11-22)
#
# Run one of the agent's own bundled collectors on demand and return its
# raw output to the operator.
#
# ★ This does NOT accept a script or a path. `kind` is an enum that maps to
#   a collector file that already ships with the agent and already runs on
#   the heartbeat — the operator is only choosing "which one, now".
#
# Invocation (dispatcher contract):
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
#     -File member-collect-now.ps1 `
#     -ParamsPath <tmpfile.json>
#
# Params file (JSON):
#   { "kind": "replication" | "discovery" }
#
# Wire shape (PS1 -> dispatcher stdout last-line JSON):
#   { success, data, error, exitCode, durationMs }
#
# ★ Output size is bounded (MAX_OUTPUT_BYTES) before it enters the envelope:
#   the center truncates at 32KB too, but truncating here means we never
#   build a multi-megabyte JSON string just to have it thrown away.

$ErrorActionPreference = 'Stop'

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'

$startedAt = [DateTime]::UtcNow
$MAX_OUTPUT_BYTES = 32768

function Write-Result($result) {
  $json = $result | ConvertTo-Json -Depth 10 -Compress
  Write-Output $json
}

function Fail($message, $code) {
  $duration = ([DateTime]::UtcNow - $startedAt).TotalMilliseconds
  Write-Result @{
    success    = $false
    data       = $null
    error      = [string]$message
    exitCode   = [int]$code
    durationMs = [int]$duration
  }
  exit $code
}

$paramsPath = $null
for ($i = 0; $i -lt $args.Count; $i++) {
  if ($args[$i] -eq '-ParamsPath') { $paramsPath = $args[$i + 1] }
}

if (-not $paramsPath -or -not (Test-Path -LiteralPath $paramsPath)) {
  Fail "params file not found: $paramsPath" 1
}

$params = $null
try {
  $params = Get-Content -LiteralPath $paramsPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
  Fail "cannot parse params JSON: $($_.Exception.Message)" 1
}

$kind = [string]$params.kind

# ★ `kind` selects a FIXED file. It is never used to build a path, so there
#   is no path-traversal surface here even if the enum check were bypassed.
$collectorMap = @{
  'replication' = 'collect-replication.ps1'
  'discovery'   = 'collect-discovery.ps1'
}

if (-not $collectorMap.ContainsKey($kind)) {
  Fail "kind must be one of: $($collectorMap.Keys -join ', ')" 1
}

$agentScriptsDir = Split-Path -Parent $PSCommandPath
$collectorPath = Join-Path $agentScriptsDir $collectorMap[$kind]

if (-not (Test-Path -LiteralPath $collectorPath)) {
  Fail "collector not found: $($collectorMap[$kind])" 2
}

try {
  $raw = & $collectorPath 2>&1 | Out-String

  $byteCount = [System.Text.Encoding]::UTF8.GetByteCount($raw)
  $truncated = $false
  if ($byteCount -gt $MAX_OUTPUT_BYTES) {
    # Byte-aware truncation: take chars until the UTF-8 encoding fits, so we
    # never cut a multi-byte character in half.
    $maxChars = $MAX_OUTPUT_BYTES
    while ($maxChars -gt 0 -and
           [System.Text.Encoding]::UTF8.GetByteCount($raw.Substring(0, $maxChars)) -gt $MAX_OUTPUT_BYTES) {
      $maxChars = [int]($maxChars * 0.9)
      if ($maxChars -le 0) { break }
    }
    if ($maxChars -le 0) { $maxChars = 0 }
    $raw = $raw.Substring(0, $maxChars)
    $truncated = $true
  }

  $duration = ([DateTime]::UtcNow - $startedAt).TotalMilliseconds
  Write-Result @{
    success    = $true
    data       = @{
      kind          = $kind
      collector     = $collectorMap[$kind]
      output        = $raw
      truncated     = $truncated
      originalBytes = $byteCount
    }
    error      = $null
    exitCode   = 0
    durationMs = [int]$duration
  }
  exit 0
} catch {
  Fail $_.Exception.Message 2
}
