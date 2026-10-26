# collect.ps1 - ad_failed_logon_collector v1.0.0 (R158.50)
#
# Reports Security event 4625 (An account failed to log on) entries from
# the local Security log over the last 1800 seconds (30 minutes), as a JSON
# array. Companion to ad_lockout_list/1.0.2 (4740) — same 24h displayName
# cache, same EventData name-based extraction (R135), same error_code bit
# semantics.
#
# Operator directive (R158.50): "在前台增加一个功能,统计密码错误次数,
# 同时在包中新建一个统计最近 1800 秒内的输错密码的账户、displayname、认证
# DC、IP地址 用来写入数据库后,在前台dashboard增加一个显示24小时或者7d
# 错误次数走向的图. 然后下面倒序显示最近输错的信息, 每 1800 秒执行一次".
#
# Algorithm:
#   1. Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4625;
#      StartTime=(Get-Date).AddSeconds(-1800)} — 1800s window of 4625s.
#   2. 4625 EventData schema (per Microsoft docs) is richer than 4740:
#        SubjectUserSid, SubjectUserName, SubjectDomainName, SubjectLogonId,
#        TargetUserSid, TargetUserName, TargetDomainName, TargetLogonId,
#        Status, FailureReason, LogonProcessName, LogonType,
#        WorkstationName, CallerComputerName, IpAddress, IpPort,
#        AuthenticationPackageName.
#      → IpAddress + WorkstationName 都在 EventData, 不需要 R158.49
#        Message-regex workaround.
#   3. IpAddress 可能是 comma-separated 多值 (R127 / R158.49 lesson:
#      proxy chain / RDP farm dual stack) — 取 first segment,
#      '-' (anonymous) 或 '' → null.
#   4. 24h displayName cache (同 ad_lockout_list/1.0.2)
#   5. error_code bit accumulator:
#        1 = WinEvent query failed (RSAT absent or log unreadable)
#        2 = ActiveDirectory RSAT module unavailable (description
#            lookups skipped, 4625 events still flow with description=null)

$ErrorActionPreference = 'Continue'

# R136: force UTF-8 stdout.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$server            = $env:COMPUTERNAME
$events            = @()
$errorCode         = 0
# R158.50.6 (2026-10-07) — 把 PS1 try/catch 抓的异常 message 写到 stdout
# JSON `error` 字段, agent package-runner.js 转 r.error → centre status='failed'.
$lastErrorMessage  = $null

# 24h process-level displayName cache (R139.1 pattern).
$script:UserDescCache       = @{}
$script:UserDescCacheExpiry = (Get-Date).AddHours(-1)

function Reset-UserDescCacheIfExpired {
  if ((Get-Date) -gt $script:UserDescCacheExpiry) {
    $script:UserDescCache = @{}
    $script:UserDescCacheExpiry = (Get-Date).AddHours(24)
  }
}

function Get-UserDisplayNameCached {
  param([string]$Sam, [string]$Server)
  if ([string]::IsNullOrWhiteSpace($Sam)) { return $null }
  Reset-UserDescCacheIfExpired
  $key = $Sam.ToLowerInvariant()
  if ($script:UserDescCache.ContainsKey($key)) {
    return $script:UserDescCache[$key]
  }
  $displayName = $null
  try {
    $u = Get-ADUser -Identity $Sam -Server $Server -Properties displayName -ErrorAction Stop
    if ($null -ne $u -and $null -ne $u.displayName) {
      $raw = [string]$u.displayName
      if ($raw.Length -gt 254) { $raw = $raw.Substring(0, 254) }
      $displayName = $raw
    }
  } catch {
    [Console]::Error.WriteLine("Get-ADUser('$Sam') failed: $($_.Exception.Message)")
  }
  $script:UserDescCache[$key] = $displayName
  return $displayName
}

function Ensure-ActiveDirectoryModule {
  if (-not (Get-Module -Name ActiveDirectory -ListAvailable)) {
    throw 'ActiveDirectory RSAT module not available'
  }
  if (-not (Get-Module -Name ActiveDirectory)) {
    Import-Module ActiveDirectory -ErrorAction Stop
  }
}

function ConvertTo-UtcIso {
  param($Value)
  if ($null -eq $Value) { return $null }
  $dt = $null
  if ($Value -is [DateTime]) {
    $dt = $Value
  } else {
    try {
      $dt = [DateTime]::Parse($Value, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AssumeUniversal -bor [System.Globalization.DateTimeStyles]::AdjustToUniversal)
    } catch {
      return $null
    }
  }
  return $dt.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
}

# R158.50 — IpAddress first-segment normalizer. EventData IpAddress may
# be "192.168.1.5,10.0.0.1" (proxy chain / dual stack) or "::1" or "-"
# (anonymous). Always take first non-empty non-dash segment; if all
# segments are dash/empty, return $null.
function Get-IpAddressFirst {
  param([string]$Raw)
  if ([string]::IsNullOrWhiteSpace($Raw)) { return $null }
  $parts = $Raw -split ','
  foreach ($p in $parts) {
    $t = $p.Trim()
    if ([string]::IsNullOrEmpty($t)) { continue }
    if ($t -eq '-') { continue }
    return $t
  }
  return $null
}

# Helper: read one EventData field by Name (R135 name-based extraction).
function Get-EventDataField {
  param([xml]$Ed, [string]$FieldName)
  [string]($Ed.Data | Where-Object { $_.Name -eq $FieldName } | Select-Object -First 1 -ExpandProperty '#text')
}

# Helper: read one EventData int field by Name; return $null if blank.
function Get-EventDataInt {
  param([xml]$Ed, [string]$FieldName)
  $s = Get-EventDataField -Ed $Ed -FieldName $FieldName
  if ([string]::IsNullOrWhiteSpace($s)) { return $null }
  try { return [int]$s } catch { return $null }
}

try {
  $start = (Get-Date).AddSeconds(-1800)  # 1800s / 30min window (R158.50.2 cadence bump)
  # R158.50.5 (2026-10-07) — switch FilterHashtable → FilterXml. 所有 agent
  # 跑 `Get-WinEvent -FilterHashtable @{LogName=Security; Id=4625; StartTime=...}`
  # 100% 抛异常 → error_code=1 → events[] 空 → centre ETL upserted=0
  # (`SELECT * FROM ad_failed_logon_events` 全空).
  # 真因: Get-WinEvent 对 FilterHashtable `Id + LogName=Security + StartTime`
  # 组合在 agent 服务账户下抛 ProviderMetadata 异常; 改用 FilterXml (跟
  # ad_eventlog_collector/1.0.3 Security channel 一样) 走通. 同时 ad_lockout_list
  # (4740) 同样 100% 失败 (历史 KDLFLOFADSRV2 在 2026-09-30 跑过 1376 bytes
  # 是当时服务账户/环境 OK, 现在所有 agent 都卡 FilterHashtable 同一 bug).
  $startIso = $start.ToUniversalTime().ToString('o')
  $filterXml = @"
<QueryList>
  <Query Id="0" Path="Security">
    <Select Path="Security">*[System[TimeCreated[@SystemTime>='$startIso'] and (EventID=4625)]]</Select>
  </Query>
</QueryList>
"@
  $raw   = Get-WinEvent -FilterXml $filterXml -ErrorAction Stop

  foreach ($e in $raw) {
    $xml = [xml]$e.ToXml()
    $ed  = $xml.Event.EventData

    $eventRecordId    = [int64]$e.RecordId
    $occurredAt       = (ConvertTo-UtcIso -Value $e.TimeCreated)

    $targetUserName     = Get-EventDataField -Ed $ed -FieldName 'TargetUserName'
    $targetDomainName   = Get-EventDataField -Ed $ed -FieldName 'TargetDomainName'
    $targetSid          = Get-EventDataField -Ed $ed -FieldName 'TargetSid'
    $subjectUserName    = Get-EventDataField -Ed $ed -FieldName 'SubjectUserName'
    $subjectDomainName  = Get-EventDataField -Ed $ed -FieldName 'SubjectDomainName'

    # 4625 EventData 专属字段 (4740 没有这些):
    $ipAddressRaw       = Get-EventDataField -Ed $ed -FieldName 'IpAddress'
    $ipAddress          = Get-IpAddressFirst -Raw $ipAddressRaw
    $ipPort             = Get-EventDataField -Ed $ed -FieldName 'IpPort'
    $logonType          = Get-EventDataInt   -Ed $ed -FieldName 'LogonType'
    $logonProcessName   = Get-EventDataField -Ed $ed -FieldName 'LogonProcessName'
    $authPackageName    = Get-EventDataField -Ed $ed -FieldName 'AuthenticationPackageName'
    $workstationName    = Get-EventDataField -Ed $ed -FieldName 'WorkstationName'
    $callerComputerName = Get-EventDataField -Ed $ed -FieldName 'CallerComputerName'
    $failureReason      = Get-EventDataField -Ed $ed -FieldName 'FailureReason'
    $status             = Get-EventDataField -Ed $ed -FieldName 'Status'

    $targetUserDisplayName = (Get-UserDisplayNameCached -Sam $targetUserName -Server $server)

    $events += [PSCustomObject]@{
      EventRecordId           = $eventRecordId
      OccurredAt              = $occurredAt
      TargetUserName          = $targetUserName
      TargetUserDisplayName   = $targetUserDisplayName
      TargetDomainName        = $targetDomainName
      TargetSid               = $targetSid
      SubjectUserName         = $subjectUserName
      SubjectDomainName       = $subjectDomainName
      CallerComputerName      = $callerComputerName
      IpAddress               = $ipAddress
      IpPort                  = $ipPort
      LogonType               = $logonType
      LogonProcessName        = $logonProcessName
      AuthenticationPackageName = $authPackageName
      FailureReason           = $failureReason
      Status                  = $status
      WorkstationName         = $workstationName
    }
  }
} catch {
  [Console]::Error.WriteLine("failedLogonEvents query failed: $($_.Exception.Message)")
  # R158.50.6 — 记下异常 message 写到 stdout `error` 字段
  $lastErrorMessage = "failedLogonEvents query failed: $($_.Exception.Message)"
  $errorCode = $errorCode -bor 1
}

# Probe AD module once at the end (R158.31 lesson).
try {
  Ensure-ActiveDirectoryModule
} catch {
  [Console]::Error.WriteLine("ActiveDirectory module unavailable: $($_.Exception.Message)")
  # R158.50.6 — 累计 error message
  if (-not $lastErrorMessage) {
    $lastErrorMessage = "ActiveDirectory module unavailable: $($_.Exception.Message)"
  } else {
    $lastErrorMessage = "$lastErrorMessage; ActiveDirectory module unavailable: $($_.Exception.Message)"
  }
  $errorCode = $errorCode -bor 2
}

$metrics = @{
  agent_id    = $server
  events      = @($events)
  event_count = [int](@($events).Count)
  error_code  = [int]$errorCode
}

# R158.50.6 — 把异常 message 写到 stdout `error` 字段, agent reporter 转 r.error
$payload = @{
  metrics = $metrics
  error   = if ($lastErrorMessage) { $lastErrorMessage } else { $null }
}
$payload | ConvertTo-Json -Compress -Depth 6
exit 0
