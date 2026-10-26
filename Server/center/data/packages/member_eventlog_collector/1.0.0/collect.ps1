# collect.ps1 - member_eventlog_collector v1.0.0 (R158.78, 2026-10-12)
#
# v1.0.0 (R158.78, 2026-10-12) — Member Server 事件日志采集首版.
#   跟 ad_eventlog_collector 1.0.6 平行但隔离:
#     · 3 通道 (System / Application / Security), 去 DC-only 通道 (ADWeb / DFSR)
#     · Wire envelope 字段 dc_name → hostname (跟 ad_member_servers.hostname 对齐)
#     · intervalSec=3600 (1h cadence, operator 决策 "1 小时 (降低频率)")
#     · agent.type='non-ad' (走 noad-scheduler.js:17 shouldRunPackageForNonAd filter)
#     · 错误隔离: Get-WinEvent -ErrorAction SilentlyContinue + 3 case 分支
#       (idle / channel-missing / real-fault) — 直接复用 R158.50.7i 模式
#     · Security 通道走 R154/R158.23 4625/4776 audit-failure 语义
#     · manifest omits `database` block (R112 公共表 pattern) → runner.js
#       post-hook 直接写 ad_member_eventlog_* 专表 (不混 DC ad_eventlog_*)
#
# Output wire shape:
#   { metrics: { agent_id, hostname, collected_at,
#                events:     [ { channel, severity, event_id, record_id,
#                                 message, ts, audit_failure }, ... ],
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

# R158.78 — 3 channels (member 版去 ADWeb/DFSR 因为 member-server 不装
# DC 角色). Security 走 R154/R158.23 4625/4776 audit-failure 语义.
$CHANNELS = @(
  @{ key = 'System';      name = 'System';      auditOnly = $false },
  @{ key = 'Application'; name = 'Application'; auditOnly = $false },
  @{ key = 'Security';    name = 'Security';    auditOnly = $true  }
)

$AUDIT_FAILURE_IDS = @(4625, 4776)

$events    = New-Object System.Collections.Generic.List[object]
$summaries = New-Object System.Collections.Generic.List[object]
# 错误隔离: case 1 (idle) + case 2 (channel-missing) 不进 $lastErrorMessages
# → status=success; case 3 (real-fault) 进 $lastErrorMessages → partial
$lastErrorMessages = New-Object System.Collections.Generic.List[string]

# R158.78 — 跟 intervalSec=3600 对齐, 1h 扫描窗口
$SCAN_HOURS = 1

# 跟踪 active channel count for case 2 stderr 输出 ("X/3 channels active")
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

    # 错误隔离: Get-WinEvent -ErrorAction SilentlyContinue, 后置 3 case
    # 分支识别. 跟 R158.50.7i 1.0.6 同模式.
    $records = @(Get-WinEvent -FilterXml $filterXml -ErrorAction SilentlyContinue)
    if ($null -eq $records) {
      # Case 3 (real fault) - cmdlet throw  SilentlyContinue swallow,  $null.
      throw "Get-WinEvent returned `$null - provider metadata or log unreadable"
    }
    if ($records.Count -eq 0) {
      # Case 1 (idle) - channel  + 0 .  $lastErrorMessages.
      # summary row  count=0 ( render "0").
      [Console]::Error.WriteLine("[member_eventlog_collector 1.0.0] channel $($ch.key) no events in 1h window on $server - normal idle state")
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
    # 3 case 分支 (idle / channel-missing / real-fault)
    $excMsg = $_.Exception.Message
    if ($excMsg -match 'is not found on this computer|does not exist|specified (event log|channel)|ChannelMatchingException|ProviderNotFoundException|Event log .* was not found|cannot open|not supported on this') {
      [Console]::Error.WriteLine("[member_eventlog_collector 1.0.0] channel $($ch.key) not enabled on $server - partial state, $activeChannels/3 channels active")
      # case 2 -  $lastErrorMessages, status  success.
    } else {
      # Case 3 (real fault)
      [Console]::Error.WriteLine("member_eventlog_collector channel $($ch.key) failed: $excMsg")
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

# R158.78 — wire envelope 字段 dc_name → hostname (跟 ad_member_servers 对齐)
$metrics = @{
  agent_id    = $server
  hostname    = $server
  collected_at = $collectedAt.ToString('o')
  events      = $events.ToArray()
  summaries   = $summaries.ToArray()
}

# 错误隔离: 只有 case 3 (real fault) 进 payload.error
$payload = @{
  metrics = $metrics
  error   = if ($lastErrorMessages.Count -gt 0) { ($lastErrorMessages.ToArray() -join '; ') } else { $null }
}
$payload | ConvertTo-Json -Compress -Depth 6
exit 0
