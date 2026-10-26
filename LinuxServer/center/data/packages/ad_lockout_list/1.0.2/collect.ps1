# collect.ps1 - ad_lockout_list v1.0.1 (R158.31 — displayName column wiring, was description in R139.1)
#
# Reports the Security event 4740 (user account locked out) entries from
# the local Security log over the last 15 minutes, as a JSON array.
# Split out from collect-replication.ps1 (which used to attach LockoutEvents
# to the replication snapshot) so the cadence is independent of replication
# and the data lands in its own package table.
#
# Algorithm:
#   1. Get-WinEvent -FilterHashtable @{LogName='Security'; Id=4740;
#      StartTime=(Get-Date).AddMinutes(-15)} — last 15 minutes of 4740s.
#   2. For each event, parse the EventData XML and extract:
#        TargetUserName, SubjectUserName, SubjectDomain, CallerComputerName
#   3. R158.31: for each TargetUserName, look up the AD user object's
#      `displayName` property (via Get-ADUser -Properties displayName) and
#      stamp the value into the event as TargetUserDisplayName. Lookups
#      are cached in a 24h process-level hashtable keyed by lowercase SAM
#      so repeat-lockouts for the same account cost 0 AD calls after the
#      first hit. Failures (account deleted, cross-domain trust broken,
#      RSAT absent) return $null — the field is nullable in the centre
#      table and the UI renders '—'.
#   4. Each event is stamped OccurredAt = ISO-8601 UTC.
#   5. Always emit a non-null `events` JSON array (empty array on no
#      events / failure) so metricstore validation never sees a missing
#      column. error_code bit accumulator:
#        1 = WinEvent query failed (RSAT absent or log unreadable)
#        2 = ActiveDirectory RSAT module unavailable (description lookups
#            skipped, but 4740 events still flow — description = null)
#
# Server clock stamps `ts` on the center side; this script omits it.
# Exit code 0 regardless of outcome.

$ErrorActionPreference = 'Continue'

# R136: force UTF-8 stdout so any Chinese text in .NET exception
# messages / DC names survives the PS→agent→centre pipeline without
# being transcoded through the system ANSI codepage.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$server            = $env:COMPUTERNAME
$events            = @()
$errorCode         = 0
# R158.50.6 (2026-10-07) — 把 PS1 try/catch 抓的异常 message 写到 stdout
# JSON `error` 字段, agent package-runner.js 会把它转成 r.error, 让 centre
# package_runs.status='failed' 真反映异常 (之前 exit 0 + try/catch 掩盖了).
$lastErrorMessage  = $null

# R139.1 — process-level 24h cache for `Get-ADUser -Properties description`.
# Keyed by lowercase SAM (case-insensitive). The hashtable + expiry
# pattern is intentionally simple (no JSON disk persistence): the agent
# process restarts at most once per OS reboot, so a cold cache is
# acceptable. 24h TTL chosen so a long-running agent that polls every
# 15 min re-validates at most once a day.
$script:UserDescCache       = @{}
$script:UserDescCacheExpiry = (Get-Date).AddHours(-1)   # sentinel: expired on first call

function Reset-UserDescCacheIfExpired {
  if ((Get-Date) -gt $script:UserDescCacheExpiry) {
    $script:UserDescCache = @{}
    $script:UserDescCacheExpiry = (Get-Date).AddHours(24)
  }
}

function Get-UserDisplayNameCached {
  param(
    [string]$Sam,
    [string]$Server
  )
  if ([string]::IsNullOrWhiteSpace($Sam)) { return $null }

  Reset-UserDescCacheIfExpired

  $key = $Sam.ToLowerInvariant()
  if ($script:UserDescCache.ContainsKey($key)) {
    return $script:UserDescCache[$key]
  }

  $displayName = $null
  try {
    # -Properties displayName → forces AD to populate the otherwise-default-
    # suppressed displayName attribute. Identity lookup by SAM (no -Filter),
    # because we want exactly one row and 4740 TargetUserName is already
    # a SAM-style account name. -Server $Server keeps the lookup on the
    # local DC, matching ad_lockout_summary's Search-ADAccount pattern.
    $u = Get-ADUser -Identity $Sam -Server $Server -Properties displayName -ErrorAction Stop
    if ($null -ne $u -and $null -ne $u.displayName) {
      $raw = [string]$u.displayName
      # Trim to 510 chars (VARCHAR(512) leaves 2 buffer; MySQL strict mode
      # would otherwise error out on overflow. MSSQL NVARCHAR is wider but
      # 510 is the safe common-denominator).
      if ($raw.Length -gt 510) { $raw = $raw.Substring(0, 510) }
      $displayName = $raw
    }
  } catch {
    # Account deleted, cross-domain trust broken, insufficient rights, or
    # RSAT module absent — none of these should kill the 4740 batch. Cache
    # the null so we don't retry on every subsequent event for the same SAM.
    [Console]::Error.WriteLine("Get-ADUser('$Sam') failed: $($_.Exception.Message)")
  }

  $script:UserDescCache[$key] = $displayName
  return $displayName
}

function Ensure-ActiveDirectoryModule {
  # Mirrors ad_lockout_summary/1.0.1/collect.ps1:30-41 pattern. Failure
  # sets bit 2 in the caller's $errorCode (caller ORs it in).
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

try {
  $start  = (Get-Date).AddMinutes(-15)
  # R158.50.5 (2026-10-07) — switch FilterHashtable → FilterXml. 跟
  # ad_failed_logon_collector 同 bug: Get-WinEvent -FilterHashtable
  # `{LogName=Security; Id=4740; StartTime=...}` 在所有 agent 服务账户下
  # 100% 抛异常 → error_code=1 → events[] 空 → ad_lockout_events 不再
  # 更新. 历史 KDLFLOFADSRV2 2026-09-30 跑过 1376 bytes 是当时服务账户/
  # 临时环境 OK, 现在所有 DC 卡 FilterHashtable 同一 bug. 改 FilterXml
  # (跟 ad_eventlog_collector/1.0.3 Security channel 同款).
  $startIso = $start.ToUniversalTime().ToString('o')
  $filterXml = @"
<QueryList>
  <Query Id="0" Path="Security">
    <Select Path="Security">*[System[TimeCreated[@SystemTime>='$startIso'] and (EventID=4740)]]</Select>
  </Query>
</QueryList>
"@
  $raw    = Get-WinEvent -FilterXml $filterXml -ErrorAction Stop
  foreach ($e in $raw) {
    $xml = [xml]$e.ToXml()
    $ed  = $xml.Event.EventData
    # R135 — name-based extraction (not by Data[i] index). Index-based
    # lookup assumes a fixed ordering of EventData fields, which is
    # implementation-defined across Windows versions and Service Pack
    # levels — the order is NOT guaranteed by the event manifest schema.
    # Index 0 on this DC happened to be TargetUserName, but index 2 was
    # TargetSid (a SID, not a domain), which is why the operator saw
    # "SubjectDomain=S-1-5-21-..." in the UI. Index 3 was SubjectUserName
    # (a SAM name like cdpadmin), not CallerComputerName. Index-based
    # extraction is therefore wrong-by-default. Use $ed.Data | Where-Object
    # { $_.Name -eq '<name>' } so the script is robust against ordering
    # changes and against Windows adding/removing fields between versions.
    $eventRecordId      = [int64]$e.RecordId
    $occurredAt         = (ConvertTo-UtcIso -Value $e.TimeCreated)
    $targetUserName     = [string]($ed.Data | Where-Object { $_.Name -eq 'TargetUserName' } | Select-Object -First 1 -ExpandProperty '#text')
    $targetDomainName   = [string]($ed.Data | Where-Object { $_.Name -eq 'TargetDomainName' } | Select-Object -First 1 -ExpandProperty '#text')
    $targetSid          = [string]($ed.Data | Where-Object { $_.Name -eq 'TargetSid' } | Select-Object -First 1 -ExpandProperty '#text')
    $subjectUserName    = [string]($ed.Data | Where-Object { $_.Name -eq 'SubjectUserName' } | Select-Object -First 1 -ExpandProperty '#text')
    $subjectDomainName  = [string]($ed.Data | Where-Object { $_.Name -eq 'SubjectDomainName' } | Select-Object -First 1 -ExpandProperty '#text')
    # R158.49 (2026-10-06) — callerComputerName fix. The 4740 EventData
    # payload does NOT actually contain a "CallerComputerName" element
    # (Microsoft's documented 4740 schema lists Subject/Target fields
    # only — see https://learn.microsoft.com/windows/security/threat-protection/
    # auditing/event-4740). The earlier lookup
    #     $ed.Data | Where-Object { $_.Name -eq 'CallerComputerName' }
    # always returned empty, so every event shipped callerComputerName=""
    # and the operator saw the column rendered as "—" for every row.
    #
    # The actual caller workstation is rendered into the event's Message
    # string (the same text Event Viewer shows — "Caller Computer Name:
    # workstation01"). Parse it via a localized regex; if the locale's
    # field label differs, the named EventData fields are still present
    # in $ed and we fall back to the SubjectUserName (the account that
    # performed the bad-password call) so the column is never empty
    # unless both sources are absent.
    $callerComputerName = ''
    try {
      $msg = [string]$e.Message
      # Match EN first ("Caller Computer Name:  / WS01" or "<name>"); the
      # pattern is "label:" followed by a value up to end-of-line or a
      # known EN-terminator ("-"). Group captures the workstation name.
      if ($msg -match '(?m)^\s*Caller\s+Computer\s+Name:\s*(?<ccn>[^\r\n\-]+)') {
        $callerComputerName = $matches['ccn'].Trim()
      }
      # Localized: ZH-SIMPLIFIED uses "调用方计算机名" / "调用工作站".
      elseif ($msg -match '(?m)^\s*调用方计算机名:\s*(?<ccn>[^\r\n\-]+)') {
        $callerComputerName = $matches['ccn'].Trim()
      }
      # Fallback: use the SubjectUserName (the account that triggered the
      # bad-password call). Not the workstation, but better than "—"
      # because the subject is at least an identifiable AD principal.
      if ([string]::IsNullOrWhiteSpace($callerComputerName)) {
        $callerComputerName = $subjectUserName
      }
    } catch {
      # Ignore parse errors — fall through with $callerComputerName=''.
    }
    $status             = [string]($ed.Data | Where-Object { $_.Name -eq 'Status' } | Select-Object -First 1 -ExpandProperty '#text')
    # R158.31: enrich with AD user displayName. Returns null on lookup
    # failure (RSAT absent, account deleted, etc.) — column is nullable.
    $targetUserDisplayName = (Get-UserDisplayNameCached -Sam $targetUserName -Server $server)
    $events += [PSCustomObject]@{
      EventRecordId         = $eventRecordId
      OccurredAt            = $occurredAt
      TargetUserName        = $targetUserName
      TargetUserDisplayName = $targetUserDisplayName
      TargetDomainName      = $targetDomainName
      TargetSid             = $targetSid
      SubjectUserName       = $subjectUserName
      SubjectDomainName     = $subjectDomainName
      CallerComputerName    = $callerComputerName
      Status                = $status
    }
  }
} catch {
  [Console]::Error.WriteLine("lockoutEvents failed: $($_.Exception.Message)")
  # R158.50.6 — 记下异常 message 写到 stdout `error` 字段
  $lastErrorMessage = "lockoutEvents failed: $($_.Exception.Message)"
  $errorCode = $errorCode -bor 1
}

# R158.31 (was R139.1): probe the AD module once at the end so the error_code bit 2
# is set even when no 4740 events fired in the 15-min window (otherwise
# an idle DC with a missing RSAT install would silently report
# error_code=0 while description=* is always null — a misleading green
# state). We don't fail the script if it's missing — 4740 events still
# flow with description=null.
try {
  Ensure-ActiveDirectoryModule
} catch {
  [Console]::Error.WriteLine("ActiveDirectory module unavailable: $($_.Exception.Message)")
  # R158.50.6 — 累计 error message (如果上面 lockoutEvents 已经写过就不覆盖)
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

# R158.50.6 — 把异常 message 写到 stdout `error` 字段, 让 agent reporter
# 把它转成 r.error, centre package_runs.status='failed'. PS1 仍然 exit 0
# (避免 spawn 层报 spawn-error 误导运维), 但 agent 端把 error 上报.
$payload = @{
  metrics = $metrics
  error   = if ($lastErrorMessage) { $lastErrorMessage } else { $null }
}
$payload | ConvertTo-Json -Compress -Depth 6
exit 0
