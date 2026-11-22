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
#   { "kind": "collector" }
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
if ($kind -ne 'collector') {
  Fail "kind must be: collector" 1
}

# ★ 只有一种采集动作, 采集脚本由 **本集** 的 config 决定:
#   AD agent   → scripts/collect-replication.ps1 (+ collect-discovery.ps1)
#   NoAD agent → scripts/collect.ps1 (config 默认值)
# ★ 路径不能写死在清单里: AD 绿包里根本没有
#   collect.ps1, 而 NoAD 绿包里根本没有 collect-replication.ps1 ——
#   同一份清单覆盖两种发版, 只能让脚本自己发现。
$agentRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$configPath = Join-Path $agentRoot 'appsettings.json'
if (-not (Test-Path -LiteralPath $configPath)) {
  Fail "appsettings.json not found at $configPath" 2
}

$cfg = $null
try {
  $cfg = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
  Fail "cannot parse appsettings.json: $($_.Exception.Message)" 2
}

$rel = [string]$cfg.psScriptPath
if ([string]::IsNullOrWhiteSpace($rel)) {
  # config.js 的默认值是 <agent>/scripts/collect.ps1
  $rel = Join-Path 'scripts' 'collect.ps1'
}
# 相对路径按 agent 根解析; 绝对路径照用 (部署线的真值).
# ★ 这里不做路径白名单: collect.ps1 本身就是这个 agent
#   每个心跳在执行的脚本, 这个动作只是"现在就跑",
#   不引入任何新的执行面。
$collectorPath = $rel
if (-not [System.IO.Path]::IsPathRooted($collectorPath)) {
  $collectorPath = Join-Path $agentRoot $collectorPath
}

if (-not (Test-Path -LiteralPath $collectorPath)) {
  Fail "collector not found: $rel" 2
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
      collector     = (Split-Path -Leaf $collectorPath)
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
