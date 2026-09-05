# 2026-09-05 R81 — Real agent PowerShell wrapper for member-server
# arbitrary script execution. The center queues a free-form PowerShell
# script against a member-server hostname; this script is what the
# agent's JS dispatcher spawns.
#
# Mirrors the contract of agent/scripts/ad-admin-users.ps1 + -groups.ps1
# (R75): reads -CommandType + -ParamsPath, runs the user's script, and
# emits a JSON result envelope on stdout (single line, last non-empty
# line is parsed by the dispatcher).
#
# Contract:
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
#     -File run-member-script.ps1 `
#     -CommandType member_script `
#     -ParamsPath <path> `
#     -TimeoutSec <int>
#
# -ParamsPath is a UTF-8 JSON file the dispatcher wrote via mkdtemp +
# writeFileSync. We read it back via Get-Content -Raw | ConvertFrom-Json.
#
# The user's script body lives at $params.script. We run it via
# Invoke-Expression so the operator's free-form PS works as-is (with
# the same risk surface as running it interactively in a PowerShell
# session — the guard rails live in the dispatcher + center service:
# script ≤32KB, timeout 5-60s, per-host rate-limit, audit persistence,
# password redact on result_json, host-online check). This script
# itself trusts the upstream guard rails.
#
# Result envelope:
#   { "success": <bool>, "data": { stdout, stderr, exitCode, durationMs },
#     "error": <string|null>, "exitCode": <int>, "durationMs": <int> }
#
# The center-side service.completeCommand redacts password-shaped keys
# from data on its way to the DB, so we don't bother redoing it here.

param(
  [Parameter(Mandatory = $true)][string]$CommandType,
  [Parameter(Mandatory = $true)][string]$ParamsPath,
  [Parameter(Mandatory = $true)][int]$TimeoutSec
)

$startedAt = [DateTime]::UtcNow

function Write-Result($result) {
  # Emit the envelope as a single JSON line on stdout so the JS
  # dispatcher can parse it. ConvertTo-Json -Compress strips the
  # newlines that break parsing on the agent side.
  $json = $result | ConvertTo-Json -Depth 10 -Compress
  Write-Output $json
}

# Validate commandType — only member_script for R81.
if ($CommandType -ne 'member_script') {
  $duration = ([DateTime]::UtcNow - $startedAt).TotalMilliseconds
  Write-Result @{
    success    = $false
    data       = $null
    error      = "unsupported commandType: $CommandType"
    exitCode   = 1
    durationMs = [int]$duration
  }
  exit 1
}

# Read the params blob. Missing or malformed file → 1 + error message.
$params = $null
try {
  $raw = Get-Content -LiteralPath $ParamsPath -Raw -Encoding UTF8 -ErrorAction Stop
  $params = $raw | ConvertFrom-Json -ErrorAction Stop
} catch {
  $duration = ([DateTime]::UtcNow - $startedAt).TotalMilliseconds
  Write-Result @{
    success    = $false
    data       = $null
    error      = "params read failed: $($_.Exception.Message)"
    exitCode   = 1
    durationMs = [int]$duration
  }
  exit 1
}

if (-not $params.script -or [string]::IsNullOrWhiteSpace($params.script)) {
  $duration = ([DateTime]::UtcNow - $startedAt).TotalMilliseconds
  Write-Result @{
    success    = $false
    data       = $null
    error      = "invalid params: script"
    exitCode   = 1
    durationMs = [int]$duration
  }
  exit 1
}

# Run the user's script body. We capture stdout / stderr via a job so
# the timeout can interrupt cleanly. Jobs are scoped to this script
# invocation and exit with the run; no cross-script state.
$scriptBody = [string]$params.script
$effectiveTimeout = [Math]::Max(1, [Math]::Min(120, $TimeoutSec))
$job = Start-Job -ScriptBlock {
  param($body)
  $global:LASTEXITCODE = 0
  try {
    Invoke-Expression $body
    if ($global:LASTEXITCODE -ne $null -and $global:LASTEXITCODE -ne 0) {
      exit $global:LASTEXITCODE
    }
    exit 0
  } catch {
    Write-Error $_.Exception.Message
    exit 2
  }
} -ArgumentList $scriptBody

$completed = Wait-Job -Job $job -Timeout $effectiveTimeout
$duration = ([DateTime]::UtcNow - $startedAt).TotalMilliseconds

if ($completed) {
  $stdout = Receive-Job -Job $job -Keep | Out-String
  $stderr = $job.ChildJobs[0].Error | Out-String
  Remove-Job -Job $job -Force
  # Last non-zero $LASTEXITCODE surfaced by the script — capture
  # through $job.State (Completed|Running|Failed) + $job.ChildJobs[0].ExitCode.
  $exitCode = 0
  try {
    # PS5.1 doesn't expose ExitCode on the job object directly; fall
    # back to inferring from the absence of stderr.
    $childExit = $job.ChildJobs[0].ExitCode
    if ($null -ne $childExit) {
      $exitCode = [int]$childExit
    } elseif (-not [string]::IsNullOrWhiteSpace($stderr)) {
      $exitCode = 2
    }
  } catch { $exitCode = 0 }
  # Trim trailing whitespace so the JSON parser on the JS side doesn't
  # choke on whitespace at the envelope boundary.
  $stdoutTrimmed = ($stdout -replace "`r`n$", '').TrimEnd()
  $stderrTrimmed = ($stderr -replace "`r`n$", '').TrimEnd()
  Write-Result @{
    success    = ($exitCode -eq 0)
    data       = @{
      stdout     = $stdoutTrimmed
      stderr     = $stderrTrimmed
      exitCode   = $exitCode
      durationMs = [int]$duration
    }
    error      = if ($exitCode -eq 0) { $null } else { if ($stderrTrimmed) { $stderrTrimmed } else { "exit $exitCode" } }
    exitCode   = $exitCode
    durationMs = [int]$duration
  }
  exit $exitCode
} else {
  # Timeout — kill it. The center's sweep will flip the row to
  # 'timeout' but we still ack so the row leaves 'running' promptly.
  Stop-Job -Job $job -Force
  Remove-Job -Job $job -Force
  Write-Result @{
    success    = $false
    data       = @{
      stdout     = ''
      stderr     = "timeout after ${effectiveTimeout}s"
      exitCode   = 2
      durationMs = [int]$duration
    }
    error      = "timeout after ${effectiveTimeout}s"
    exitCode   = 2
    durationMs = [int]$duration
  }
  exit 2
}