[CmdletBinding()]
param(
  [switch]$ForTesting
)

# R112 — eventlog collector v1.0.0
#
# Scans four fixed Windows event channels (System / Application / ADWeb /
# DFSR) for Warning + Error events from the past 24 hours. Emits a single
# JSON envelope as the LAST non-empty line on stdout:
#
#   {
#     "metrics": {
#       "agent_id":     "<hostname>",
#       "dc_name":      "<hostname>",
#       "collected_at": "2026-09-26T...Z",
#       "events":     [{channel, severity, event_id, record_id, message, ts}, ...],
#       "summaries":  [{channel, warning_count, error_count, collected_at}, ...]
#     }
#   }
#
# Wire shape intentionally snake_case — matches centre-side
# center/src/services/eventlog.js (R112 service-layer `pickField` accepts
# BOTH camelCase + snake_case, so this is the agent-side canonical form).
#
# v2 package runner contract (agent/src/package-runner.js):
#   - spawn: powershell -NoProfile -ExecutionPolicy Bypass -File <this>
#   - stdin: { "name": "...", "params": {...} } as JSON
#   - parser: takes LAST non-empty line of stdout and JSON.parses it
#   - return: parsed.metrics ?? null  →  this script MUST emit {"metrics":{...}}
#
# Channel mapping (operator's exact wording — 系统、应用程序、ADWeb、DFSR):
#   System       → LogName "System"
#   Application  → LogName "Application"
#   ADWeb        → LogName "AD Web Services" (ADWS service log; channel
#                  reported by view as "ADWeb")
#   DFSR         → LogName "DFS Replication" (channel reported as "DFSR")
#
# Any single channel failure (missing log, ACL denied, timeout) is isolated
# via try/catch so the remaining channels still report. A fully failed run
# returns an empty envelope with all counts = 0 so centre's runner post-hook
# still has a structured response (rather than a hard error that the centre
# would have to special-case).

# 2026-08-24 round-9: PS 5.1 [Console]::OutputEncoding defaults to the
# system OEM codepage (CN = GBK/936). [Console]::Out/Error.WriteLine
# serializes non-ASCII (e.g., Chinese AD error text) using that encoding,
# producing GBK bytes on stdout. The agent child reads stdout as UTF-8
# by default, so Chinese characters become U+FFFD + isolated surrogate
# pairs (the mojibake pattern KDLWXOFADSRV1 was emitting). Set UTF-8
# explicitly so [Console]::Out/Error write UTF-8 bytes that Node decodes
# correctly. $OutputEncoding covers pipeline redirection for defense in
# depth. Same trap fires in collect-replication.ps1 / collect-discovery.ps1.
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding           = [System.Text.UTF8Encoding]::new($false)

$ErrorActionPreference = 'Continue'

$script:AgentId = $env:COMPUTERNAME
if ([string]::IsNullOrEmpty($script:AgentId)) {
  $script:AgentId = 'unknown-host'
}

# Centre hard-coded 24h retention (center/src/routes/eventlog.js clamps
# sinceHours to [1,24]). Keep the agent in lock-step so the centre's
# retention sweep doesn't drop rows the agent just shipped.
$script:SinceHours = 24

# Bound the per-channel scan. Centre drill-down defaults to limit=200, so
# 200 events/channel × 4 channels = 800 rows max keeps the wire payload
# sane and the Get-WinEvent call bounded to a few seconds per channel.
$script:MaxEventsPerChannel = 200

# Channel table — fixed order matches operator's brief + centre's channel
# whitelist (center/src/routes/eventlog.js + EventlogView.vue). DO NOT
# reorder without also updating the centre router's channel whitelist.
$script:Channels = @(
  @{ Channel = 'System';      LogName = 'System'            },
  @{ Channel = 'Application'; LogName = 'Application'       },
  @{ Channel = 'ADWeb';       LogName = 'AD Web Services'   },
  @{ Channel = 'DFSR';        LogName = 'DFS Replication'   }
)

function ConvertTo-UtcIso {
  [CmdletBinding()]
  param(
    [Parameter()]
    [AllowNull()]
    $Value
  )

  if ($null -eq $Value) {
    return $null
  }

  $dt = $null
  if ($Value -is [DateTime]) {
    $dt = $Value
  } else {
    try {
      $dt = [DateTime]::Parse(
        $Value,
        [System.Globalization.CultureInfo]::InvariantCulture,
        [System.Globalization.DateTimeStyles]::AssumeUniversal -bor [System.Globalization.DateTimeStyles]::AdjustToUniversal
      )
    } catch {
      return $null
    }
  }

  return $dt.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
}

# Severity mapping — Get-WinEvent -FilterXPath uses Level=1..5:
#   1=Critical 2=Error 3=Warning 4=Information 5=Verbose
# Operator's R112 brief is "出现警告和错误的数量" (Warning + Error only).
# Critical (Level=1) is folded into the error bucket — any failure-level
# event belongs on the dashboard.
function Get-SeverityFromLevel {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [int]$Level
  )

  if ($Level -eq 2) { return 'error' }
  if ($Level -eq 3) { return 'warning' }
  return $null
}

# Single-channel collector. Returns a PSCustomObject:
#   { channel, warning_count, error_count, events: PSCustomObject[] }
# Any throw inside the channel becomes a {channel, warning_count=0,
# error_count=0, events=[]} + a stderr breadcrumb — the outer loop keeps
# going so the other channels still ship.
function Get-ChannelEvents {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$Channel,

    [Parameter(Mandatory = $true)]
    [string]$LogName,

    [Parameter(Mandatory = $true)]
    [int]$SinceHours,

    [Parameter(Mandatory = $true)]
    [int]$MaxEvents
  )

  $warningCount = 0
  $errorCount   = 0
  $events       = New-Object System.Collections.Generic.List[object]

  # FilterXPath is dramatically faster than FilterHashtable on large logs
  # (it pushes the predicate into the EventLog query engine). The TimeCreated
  # window matches centre retention (24h) and Level in (1,2,3) covers
  # Critical + Error + Warning.
  $xpath = @"
  *[System[Level=2 or Level=3]
    and TimeCreated[timediff(@SystemTime) <= $($SinceHours * 60 * 60 * 1000)]]
"@

  try {
    $records = Get-WinEvent -FilterXPath $xpath -LogName $LogName -ErrorAction Stop -MaxEvents $MaxEvents
  } catch {
    # Channel missing, ACL denied, or timeout — log to stderr and return a
    # zeroed envelope so the centre's post-hook still sees a structured row.
    [Console]::Error.WriteLine("eventlog[$Channel] Get-WinEvent failed: $($_.Exception.Message)")
    return [PSCustomObject]@{
      channel        = $Channel
      warning_count  = 0
      error_count    = 0
      events         = @()
    }
  }

  foreach ($r in $records) {
    $severity = Get-SeverityFromLevel -Level ([int]$r.Level)
    if ($null -eq $severity) { continue }

    if ($severity -eq 'warning') { $warningCount++ } else { $errorCount++ }

    $ts = ConvertTo-UtcIso -Value $r.TimeCreated
    $events.Add([PSCustomObject]@{
      channel   = $Channel
      severity  = $severity
      event_id  = [int]$r.Id
      record_id = [int64]$r.RecordId
      message   = [string]$r.Message
      ts        = $ts
    })
  }

  return [PSCustomObject]@{
    channel        = $Channel
    warning_count  = $warningCount
    error_count    = $errorCount
    events         = $events.ToArray()
  }
}

# Test-only entrypoint — mirrors collect-discovery.ps1's -ForTesting flag
# so a Pester / Node test can source this script and call the helpers
# without the outer pipeline running. Currently unused (test file uses
# regex asserts on source), kept for parity with the other collectors.
if (-not $ForTesting) {
  try {
    $collectedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')

    $allEvents    = New-Object System.Collections.Generic.List[object]
    $allSummaries = New-Object System.Collections.Generic.List[object]

    foreach ($entry in $script:Channels) {
      $result = Get-ChannelEvents `
        -Channel $entry.Channel `
        -LogName $entry.LogName `
        -SinceHours $script:SinceHours `
        -MaxEvents $script:MaxEventsPerChannel

      foreach ($e in $result.events) { $allEvents.Add($e) }

      $allSummaries.Add([PSCustomObject]@{
        channel         = $result.channel
        warning_count   = $result.warning_count
        error_count     = $result.error_count
        collected_at    = $collectedAt
      })
    }

    $metrics = [ordered]@{
      agent_id     = $script:AgentId
      dc_name      = $script:AgentId
      collected_at = $collectedAt
      events       = $allEvents.ToArray()
      summaries    = $allSummaries.ToArray()
    }

    # Final stdout line MUST be JSON. v2 package runner parses the LAST
    # non-empty line; anything we wrote before this line (debug, stderr,
    # transient status) is discarded. Write ONLY this final envelope.
    $payload = [PSCustomObject]@{ metrics = $metrics }
    [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress -Depth 6))
    exit 0
  } catch {
    [Console]::Error.WriteLine("eventlog collector crashed: $($_.Exception.Message)")
    # Still emit a structured (empty) envelope so centre's runner post-hook
    # has a metrics object — runner expects {metrics: ...} or it returns
    # null and the centre logs "no metrics". Better to ship an empty
    # envelope than a non-zero exit that centre has to special-case.
    try {
      $collectedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
      $fallback = [PSCustomObject]@{
        metrics = [PSCustomObject]@{
          agent_id     = $script:AgentId
          dc_name      = $script:AgentId
          collected_at = $collectedAt
          events       = @()
          summaries    = @()
        }
      }
      [Console]::Out.WriteLine(($fallback | ConvertTo-Json -Compress -Depth 4))
    } catch {
      # If even the fallback can't be serialised, exit non-zero so the
      # agent's reportBatch records an error rather than a silent empty.
    }
    exit 2
  }
}