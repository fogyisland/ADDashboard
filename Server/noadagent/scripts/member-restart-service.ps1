# member-restart-service.ps1 - R161.35 step 2 (2026-11-22)
#
# Restart a single Windows service on a member server.
#
# ★ Replaces the free-form PowerShell path for the single most common ops
#   action. The operator can name the service and nothing else — no script.
#
# Invocation (dispatcher contract):
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
#     -File member-restart-service.ps1 `
#     -ParamsPath <tmpfile.json>
#
# Params file (JSON):
#   { "serviceName": "<name>", "force": true|false (optional) }
#
# Wire shape (PS1 -> dispatcher stdout last-line JSON):
#   { success, data, error, exitCode, durationMs }
#
# The dispatcher parses the LAST non-empty stdout line as JSON. Anything
# before it is ignored; warnings go to stderr to keep the JSON stream clean.

$ErrorActionPreference = 'Stop'

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'

$startedAt = [DateTime]::UtcNow

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

# ── Parse arguments ────────────────────────────────────────────────────
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

$serviceName = [string]$params.serviceName
if ([string]::IsNullOrWhiteSpace($serviceName)) {
  Fail 'serviceName is required' 1
}

# ★ Defense in depth. The dispatcher already validated serviceName against
#   ^[A-Za-z0-9_.\-]{1,128}$ via the manifest schema, but the PS1 must not
#   trust its caller: this is the layer that actually hands the string to a
#   cmdlet. A name with a wildcard, a quote, or a space could otherwise
#   match other services or be re-parsed.
if ($serviceName -notmatch '^[A-Za-z0-9_.\-]{1,128}$') {
  Fail 'serviceName contains characters that are not allowed' 1
}

$forceRestart = $false
if ($null -ne $params.force) { $forceRestart = [bool]$params.force }

try {
  # Confirm the service exists first — Restart-Service's own error for a
  # missing service is less actionable than an explicit check.
  $svc = Get-Service -Name $serviceName -ErrorAction Stop

  $before = [string]$svc.Status

  # ★ Restart-Service without -Force refuses when other services depend on
  #   this one. -Force cascades to dependents, which is what an operator
  #   means by "force". We never use -Force unless explicitly requested.
  if ($forceRestart) {
    Restart-Service -Name $serviceName -Force -ErrorAction Stop
  } else {
    Restart-Service -Name $serviceName -ErrorAction Stop
  }

  # Give SCM a moment to settle, then report the observed state. A service
  # that is still Stopping/Pending here is a real result, not an error.
  Start-Sleep -Milliseconds 500
  $after = [string](Get-Service -Name $serviceName -ErrorAction Stop).Status

  $duration = ([DateTime]::UtcNow - $startedAt).TotalMilliseconds
  Write-Result @{
    success    = $true
    data       = @{
      serviceName   = $serviceName
      statusBefore  = $before
      statusAfter   = $after
      forced        = $forceRestart
    }
    error      = $null
    exitCode   = 0
    durationMs = [int]$duration
  }
  exit 0
} catch {
  Fail $_.Exception.Message 2
}
