# collect.ps1 - ad_eventlog_collector v1.0.6 (R158.50.7i, 2026-10-08)
#
# v1.0.6 changes vs v1.0.5 (R158.50.7i, 2026-10-08):
#   - Operator  5 channel `ps1: channel X: 
#      / 'X'`  →  partial.
#      PS5.1 `Get-WinEvent -FilterXml -ErrorAction Stop` :
#       Case 1 (idle): 0  - channel  + 2h  warning/error
#       Case 2 (config-missing): channel  (DC  AD Web Services / DFSR role)
#       Case 3 (real-fault): ProviderMetadata  / log unreadable / access denied
#     1.0.5 catch  3 case  $lastErrorMessages → payload.error
#     → runner.js  partial (case 1 + case 2 ,  partial).
#   - fix: Get-WinEvent `-ErrorAction Stop` → `SilentlyContinue` + 
#     3 case . case 1 + case 2  $lastErrorMessages, status  success.
#     case 3  R158.50.6  ( $lastErrorMessages → partial).
#   - summary row  case 1/2/3  count=0 ( render "0"  missing).
#   - Wire shape  (5 summary rows , $droppedCount  R158.52).
#
# v1.0.5 changes vs v1.0.4 (R158.52, 2026-10-08):
#   - $droppedCount when the 1000-row limit is reached (R158.52).
#
# v1.0.2 changes vs v1.0.1 (R158.23, 2026-10-02):
#   - Security 4625/4776  severity 'info' → 'error' (R158.23).
#
# v1.0.1 changes vs v1.0.0 (R154):
#   - Scan window 25h → 2h + new Security channel (4625/4776).
#
# Output wire shape:
#   { metrics: { agent_id, dc_name, collected_at,
#                events:     [ ... ],
#                summaries:  [ { channel, warning_count, error_count,
#                                 audit_failure_count, dropped_count,
#                                 collected_at }, ... ] },
#     error:   null | "channel X: <msg> (case 3 only)" }

$ErrorActionPreference = 'Continue'

# R136 encoding fix (unchanged): PS 5.1 default [Console]::OutputEncoding
# is the system ANSI codepage (CP936/GB18030 on CN Windows). Setting it
# to UTF8 makes ConvertTo-Json emit the original .NET bytes verbatim so
# the centre's NVARCHAR column sees the correct UTF-16 code points.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'

$server = $env:COMPUTERNAME
$collectedAt = (Get-Date).ToUniversalTime()

# Channel order is fixed - the public page renders 4+1 columns in this
# order. The Security channel carries the audit-failure filter; the
# other 4 channels carry Level=2 (error) + Level=3 (warning) like before.
$CHANNELS = @(
  @{ key = 'System';      name = 'System';          auditOnly = $false },
  @{ key = 'Application'; name = 'Application';     auditOnly = $false },
  @{ key = 'ADWeb';       name = 'AD Web Services'; auditOnly = $false },
  @{ key = 'DFSR';        name = 'DFSR';            auditOnly = $false },
  @{ key = 'Security';    name = 'Security';        auditOnly = $true  }
)

$AUDIT_FAILURE_IDS = @(4625, 4776)

$events    = New-Object System.Collections.Generic.List[object]
$summaries = New-Object System.Collections.Generic.List[object]
# R158.50.6 (2026-10-07) - per-channel try/catch → message → stdout `error`
# R158.50.7i (2026-10-08) - ONLY case 3 (real fault) populates this list.
#                              case 1 (idle) + case 2 (channel )
#                              ,  $lastErrorMessages → status=success.
$lastErrorMessages = New-Object System.Collections.Generic.List[string]

$SCAN_HOURS = 2

# R158.50.7i - track active channel count for case 2 stderr  ("X/5 channels active").
$activeChannels = 0

foreach ($ch in $CHANNELS) {
  $warningCount = 0
  $errorCount   = 0
  $auditFailureCount = 0
  $droppedCount = 0

  try {
    $startTime = (Get-Date).AddHours(-$SCAN_HOURS)

    if ($ch.auditOnly) {
      $idList = ($AUDIT_FAILURE_IDS | ForEach-Object { "EventID=$_" }) -join " or "
      $filterXml = @"
<QueryList>
  <Query Id="0" Path="$($ch.name)">
    <Select Path="$($ch.name)">*[System[TimeCreated[@SystemTime&gt;='$($startTime.ToUniversalTime().ToString('o'))'] and ($idList)]]</Select>
  </Query>
</QueryList>
"@
    } else {
      $filterXml = @"
<QueryList>
  <Query Id="0" Path="$($ch.name)">
    <Select Path="$($ch.name)">*[System[TimeCreated[@SystemTime&gt;='$($startTime.ToUniversalTime().ToString('o'))'] and (Level=2 or Level=3)]]</Select>
  </Query>
</QueryList>
"@
    }

    # R158.50.7i - Get-WinEvent `-ErrorAction Stop` → `SilentlyContinue`.
    #  case 1/2/3  $null , .  R158.50.7h ad_lockout_list 1.0.5
    #  idiom.
    $records = @(Get-WinEvent -FilterXml $filterXml -ErrorAction SilentlyContinue)
    if ($null -eq $records) {
      # Case 3 (real fault) - cmdlet throw  SilentlyContinue swallow,  $null.
      #  throw  catch .
      throw "Get-WinEvent returned `$null - provider metadata or log unreadable"
    }
    if ($records.Count -eq 0) {
      # Case 1 (idle) - channel  + 0 .  $lastErrorMessages.
      # summary row  count=0 ( render "0").
      [Console]::Error.WriteLine("[ad_eventlog_collector 1.0.6] channel $($ch.key) no events in 2h window on $server - normal idle state")
      $activeChannels++
    } else {
      $activeChannels++
      foreach ($r in $records) {
        $level = switch ($r.Level) {
          1 { 'error' }
          2 { 'error' }
          3 { 'warning' }
          4 { 'info' }
          default { 'info' }
        }
        if ($ch.auditOnly -and $AUDIT_FAILURE_IDS -contains [int]$r.Id) {
          $level = 'error'
        }
        if ($level -eq 'warning') { $warningCount++ }
        elseif ($level -eq 'error') { $errorCount++ }

        $isAuditFailure = 0
        if ($ch.auditOnly) {
          $isAuditFailure = 1
          $auditFailureCount++
        }

        if ($events.Count -lt 1000) {
          $message = if ($r.Message) { $r.Message } else { '' }
          if ($message.Length -gt 4000) { $message = $message.Substring(0, 4000) }
          $events.Add([pscustomobject]@{
            channel        = $ch.key
            severity       = $level
            event_id       = [int]$r.Id
            record_id      = [int64]$r.RecordId
            message        = $message
            ts             = $r.TimeCreated.ToUniversalTime().ToString('o')
            audit_failure  = [int]$isAuditFailure
          })
        } else {
          $droppedCount++
        }
      }
    }
  } catch {
    # R158.50.7i - 3 case  catch .
    $excMsg = $_.Exception.Message
    # Case 2 (channel  / DC ) - , summary row  count=0,
    #  $lastErrorMessages ( runner  partial).  locale:
    #   zh-CN: " localhost 'X' " (use"")
    #   en-US: "is not found on this computer" / "Event log ... does not exist"
    # R158.50.7i-fix (2026-10-08) - operator 8:30 deploy feedback:
    #   zh-CN on member DC  'is not found on this computer'
    #    case 3 (real fault),
    #   partial.  zh-CN pattern:  ' 没有与.+ '
    #   (U+201C/U+201D CJK) + ' '.
    if ($excMsg -match 'is not found on this computer|does not exist|specified (event log|channel)|ChannelMatchingException|在.+没有与.+匹配的事件日志') {
      [Console]::Error.WriteLine("[ad_eventlog_collector 1.0.6] channel $($ch.key) not enabled on $server - partial state, $activeChannels/5 channels active")
      # case 2 -  $lastErrorMessages, status  success.
    } else {
      # Case 3 (real fault) - ProviderMetadata / log  / access denied /  throw.
      #  $lastErrorMessages → payload.error → runner partial (R158.50.6 ).
      [Console]::Error.WriteLine("ad_eventlog_collector channel $($ch.key) failed: $excMsg")
      $lastErrorMessages.Add("channel $($ch.key): $excMsg")
    }
  }

  $summaries.Add([pscustomobject]@{
    channel             = $ch.key
    warning_count       = [int]$warningCount
    error_count         = [int]$errorCount
    audit_failure_count = [int]$auditFailureCount
    dropped_count       = [int]$droppedCount
    collected_at        = $collectedAt.ToString('o')
  })
}

$metrics = @{
  agent_id    = $server
  dc_name     = $server
  collected_at = $collectedAt.ToString('o')
  events      = $events.ToArray()
  summaries   = $summaries.ToArray()
}

# R158.50.6 - message → stdout `error`. R158.50.7i:  case 3 (real fault)
#  $lastErrorMessages, case 1 (idle) + case 2 (channel ) 
# , status  success.
$payload = @{
  metrics = $metrics
  error   = if ($lastErrorMessages.Count -gt 0) { ($lastErrorMessages.ToArray() -join '; ') } else { $null }
}
$payload | ConvertTo-Json -Compress -Depth 6
exit 0
