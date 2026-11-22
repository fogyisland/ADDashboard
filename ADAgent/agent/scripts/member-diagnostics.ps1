# member-diagnostics.ps1 - R161.35 step 2 (2026-11-22)
#
# READ-ONLY diagnostics on a member server.
#
# ★ Strictly read-only by construction: every branch here only reads WMI /
#   the SCM / the event log / filesystem statistics. There is deliberately
#   NO "run this command" variant — if an operator needs something these
#   three kinds do not cover, the answer is a new sealed script in the
#   manifest, reviewed and shipped, not a free-form escape hatch.
#
# Invocation (dispatcher contract):
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
#     -File member-diagnostics.ps1 `
#     -ParamsPath <tmpfile.json>
#
# Params file (JSON):
#   { "kind": "services" | "disk" | "eventlog", "maxEntries": 1..200 (optional) }
#
# Wire shape (PS1 -> dispatcher stdout last-line JSON):
#   { success, data, error, exitCode, durationMs }

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
if ($kind -notin @('services', 'disk', 'eventlog')) {
  Fail 'kind must be one of: services, disk, eventlog' 1
}

# Hard clamp — the dispatcher already bounded this, but never trust the input.
$maxEntries = 50
if ($null -ne $params.maxEntries) {
  $n = 0
  if ([int]::TryParse([string]$params.maxEntries, [ref]$n) -and $n -ge 1) {
    $maxEntries = [Math]::Min(200, $n)
  }
}

try {
  switch ($kind) {
    'services' {
      # Only the agent's own service plus anything clearly unhealthy —
      # dumping every service is noise and a large payload.
      $svc = Get-Service -ErrorAction Stop | Where-Object {
        $_.Status -ne 'Running' -or $_.Name -match 'ADReplication|memberService'
      } | Select-Object -First 200 Name, DisplayName, Status, StartType

      $duration = ([DateTime]::UtcNow - $startedAt).TotalMilliseconds
      Write-Result @{
        success    = $true
        data       = @{ kind = 'services'; services = @($svc) }
        error      = $null
        exitCode   = 0
        durationMs = [int]$duration
      }
      exit 0
    }

    'disk' {
      $vols = Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction Stop |
        Select-Object DeviceID, VolumeName,
          @{ N = 'SizeGB';      E = { [math]::Round($_.Size / 1GB, 2) } },
          @{ N = 'FreeGB';      E = { [math]::Round($_.FreeSpace / 1GB, 2) } },
          @{ N = 'FreePercent'; E = {
              if ($_.Size -gt 0) { [math]::Round(100 * $_.FreeSpace / $_.Size, 1) } else { $null }
            } }

      $duration = ([DateTime]::UtcNow - $startedAt).TotalMilliseconds
      Write-Result @{
        success    = $true
        data       = @{ kind = 'disk'; volumes = @($vols) }
        error      = $null
        exitCode   = 0
        durationMs = [int]$duration
      }
      exit 0
    }

    'eventlog' {
      # ★ Event log TEXT is attacker-influenced (any local process can write
      #   entries). We only return typed fields the operator can scan — no
      #   free text is interpreted anywhere downstream, and the center
      #   renders it as plain text.
      $entries = Get-WinEvent -LogName 'System' -MaxEvents $maxEntries -ErrorAction Stop |
        Select-Object @{ N = 'TimeCreated'; E = { $_.TimeCreated } },
                      @{ N = 'Level';       E = { [string]$_.LevelDisplayName } },
                      @{ N = 'Provider';    E = { [string]$_.ProviderName } },
                      @{ N = 'Id';          E = { $_.Id } },
                      @{ N = 'Message';     E = {
                          $m = [string]$_.Message
                          # Bound each message: one huge entry must not blow
                          # the whole envelope past the center's 32KB cap.
                          if ($m.Length -gt 1000) { $m.Substring(0, 1000) + '…' } else { $m }
                        } }

      $duration = ([DateTime]::UtcNow - $startedAt).TotalMilliseconds
      Write-Result @{
        success    = $true
        data       = @{
          kind       = 'eventlog'
          logName    = 'System'
          maxEntries = $maxEntries
          entries    = @($entries)
        }
        error      = $null
        exitCode   = 0
        durationMs = [int]$duration
      }
      exit 0
    }

    default {
      Fail "unsupported kind: $kind" 1
    }
  }
} catch {
  Fail $_.Exception.Message 2
}
