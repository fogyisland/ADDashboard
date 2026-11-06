# collect.ps1 - ad_lockout_list v1.0.5 (R158.50.7f — 0 命中识别为正常 idle 状态)
#
# R158.50.7f (2026-10-08) — supersedes 1.0.4 catch-as-error 反模式.
# PS5.1 Get-WinEvent -FilterXml -ErrorAction Stop 在 0 命中时抛
# EventLogQueryException (中文 Windows: "找不到任何与指定的选择条件匹配的事件。"),
# 这是 cmdlet 的标准行为,不是真故障. 1.0.4 把这个异常喂到 $lastErrorMessage
# + error_code=1 → agent runner.error → UI 部分行变黄/红.
# 1.0.5 改用 -ErrorAction SilentlyContinue + @($raw).Count 判空:
#   - 0 命中 → events=@(), error_code=0, lastErrorMessage=null → status='success'
#   - 真异常 (ProviderMetadata / log 损坏 / WMI 不可用) → cmdlet 抛但仍 swallow,
#     $raw 变 $null, 显式 throw 走 catch → error_code=1 保留 R158.50.6 链路
#   - 运维人员通过 stderr 看到 "[ad_lockout_list 1.0.5] no 4740 events
#     in 15min window on <DC> — normal idle state" 知道 DC 是健康的,只是没锁定.
#
# 完整算法:
#   1. Get-WinEvent -FilterXml -ErrorAction SilentlyContinue (15-min window, EventID=4740).
#   2. If $null → throw → catch → error_code=1 (真异常, 真故障).
#   - If @($raw).Count -eq 0 → idle state → events=@(), stderr informational, no error.
#   - Else foreach parse each event:
#        R135  - name-based EventData extraction (NOT index-based)
#        R158.49.1 - callerComputerName regex `(?ms).+?\s*$` (含 '-' hostname)
#        R158.50.7e - displayName via TargetDomainName (跨域)
#        R158.52  - per-event try/catch, skip one bad 4740
#   3. Ensure ActiveDirectory RSAT module is available (R158.31) → error_code=2 if missing
#      (so the operator knows description=* will be NULL even when 4740 events flow).
#   4. Emit {metrics, error} JSON. Exit 0.
#
# 保留不动的 R-系列修复:
#   - R136: UTF-8 stdout
#   - R139.1: 24h Get-ADUser displayName cache (R158.50.7e 改用 Domain 不是 Server)
#   - R158.49.1: callerComputerName regex `(?ms).+?\s*$` (含 '-' hostname)
#   - R158.50.5: FilterXml (不走 FilterHashtable)
#   - R158.50.6: $lastErrorMessage → payload.error (上行链路保留)
#   - R158.50.7e: Get-UserDisplayNameCached -Domain (跨域 displayName)
#   - R158.52: per-event try/catch + accumulated $skippedBadEvent
#   - R158.50.7g: status 决策 (success/partial/failed/running) 由 centre runner 负责

$ErrorActionPreference = 'Continue'

# R136: force UTF-8 stdout so any Chinese text in .NET exception
# messages / DC names survives the PS→agent→centre pipeline without
# being transcoded through the system ANSI codepage.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$server            = $env:COMPUTERNAME
$events            = @()
$errorCode         = 0
# R158.50.6 (2026-10-07) —  PS1 try/catch  message  stdout
# JSON `error` , agent package-runner.js  r.error,  centre
# package_runs.status='failed'  ( exit 0 + try/catch ).
# R158.50.7f (2026-10-08) — 1.0.5 only sets this for REAL failures
# (cmdlet 抛 ProviderMetadata / log 损坏 / WMI 不可用). 0 命中是 idle
# state, 不动这个变量.
$lastErrorMessage  = $null

# R139.1 — process-level 24h cache for `Get-ADUser -Properties displayName`.
# Keyed by lowercase SAM (case-insensitive). The hashtable + expiry
# pattern is intentionally simple (no JSON disk persistence): the agent
# process restarts at most once per OS reboot, so a cold cache is
# acceptable. 24h TTL chosen so a long-running agent that polls every
# 15 min re-validates at most once a day.
# R158.50.7e — cache key now composite `{Domain}|{Sam}` so cross-domain
# SAMs (bdm@KDL vs bdm@OTHER) don't collide.
$script:UserDescCache       = @{}
$script:UserDescCacheExpiry = (Get-Date).AddHours(-1)   # sentinel: expired on first call

function Reset-UserDescCacheIfExpired {
  if ((Get-Date) -gt $script:UserDescCacheExpiry) {
    $script:UserDescCache = @{}
    $script:UserDescCacheExpiry = (Get-Date).AddHours(24)
  }
}

function Get-UserDisplayNameCached {
  # R158.50.7e — add $Domain parameter so cross-domain 4740 events
  # resolve displayName via LDAP against the right domain controller.
  # Pre-1.0.4 used -Server $server (local DC hostname) which made
  # Get-ADUser return null for cross-domain SAMs. Composite cache key
  # {Domain}|{Sam} avoids cross-domain SAM collision.
  param(
    [string]$Sam,
    [string]$Domain
  )
  if ([string]::IsNullOrWhiteSpace($Sam)) { return $null }

  Reset-UserDescCacheIfExpired

  $key = "$(if($Domain){$Domain}else{''})|$($Sam.ToLowerInvariant())"
  if ($script:UserDescCache.ContainsKey($key)) {
    return $script:UserDescCache[$key]
  }

  $displayName = $null
  try {
    # R158.50.7e — if Domain is empty/whitespace fall back to local
    # DC server (pre-1.0.4 behavior); otherwise use the Domain name
    # so Get-ADUser targets the right domain's DC.
    $queryServer = if ([string]::IsNullOrWhiteSpace($Domain)) { $server } else { $Domain }
    # -Properties displayName → forces AD to populate the otherwise-default-
    # suppressed displayName attribute. Identity lookup by SAM (no -Filter),
    # because we want exactly one row and 4740 TargetUserName is already
    # a SAM-style account name.
    $u = Get-ADUser -Identity $Sam -Server $queryServer -Properties displayName -ErrorAction Stop
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
    [Console]::Error.WriteLine("Get-ADUser('$Sam' on '$Domain') failed: $($_.Exception.Message)")
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
  # R158.50.5 (2026-10-07) — switch FilterHashtable → FilterXml.
  # ad_failed_logon_collector  bug: Get-WinEvent -FilterHashtable
  # `{LogName=Security; Id=4740; StartTime=...}`  agent
  # 100%  → error_code=1 → events[]  → ad_lockout_events
  # .  KDLFLOFADSRV2 2026-09-30  1376 bytes /
  #  OK,  DC  FilterHashtable  bug.  FilterXml
  # ( ad_eventlog_collector/1.0.3 Security channel ).
  $startIso = $start.ToUniversalTime().ToString('o')
  $filterXml = @"
<QueryList>
  <Query Id="0" Path="Security">
    <Select Path="Security">*[System[TimeCreated[@SystemTime>='$startIso'] and (EventID=4740)]]</Select>
  </Query>
</QueryList>
"@
  # R158.50.7f (2026-10-08) — switch -ErrorAction Stop → SilentlyContinue
  # so 0 命中 is NOT raised as EventLogQueryException ("找不到任何与指定
  # 的选择条件匹配的事件。"). 0 命中 is the normal idle state for
  # ad_lockout_list (15-min window, EventID=4740 is rare on most DCs).
  # Real failures (ProviderMetadata / log 损坏 / WMI 不可用) cause the
  # cmdlet to write a non-terminating error and return $null; the
  # explicit `$null -eq $raw` check below catches that and routes to
  # the catch block (preserving R158.50.6 error_code=1 path).
  $raw = @(Get-WinEvent -FilterXml $filterXml -ErrorAction SilentlyContinue)
  if ($null -eq $raw) {
    # Real failure: cmdlet throw swallowed by SilentlyContinue. Throw
    # to enter the catch block below so $lastErrorMessage + error_code=1
    # are set per R158.50.6.
    throw "Get-WinEvent returned `$null — log unreadable or EventLog provider metadata failed"
  }
  # R158.52 — per-event try/catch so one corrupt 4740 (malformed XML,
  # regex throw, displayName cache throw) doesn't drop the entire
  # 15-min batch. Mirrors the R158.50.7d / R158.52 ad_failed_logon fix.
  $skippedBadEvent = 0
  if ($raw.Count -eq 0) {
    # R158.50.7f — normal idle state. 15-min window produced 0
    # lockout events. Surface a diagnostic line on stderr so an
    # operator can see "this DC is healthy, just no lockouts in the
    # last 15min" but DO NOT mark $lastErrorMessage / $error_code.
    # status will be 'success' (R158.50.7g).
    [Console]::Error.WriteLine("[ad_lockout_list 1.0.5] no 4740 events in 15min window on $server — normal idle state")
    $events = @()
  } else {
    foreach ($e in $raw) {
      try {
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
        #
        # R158.49.1 (2026-10-07) — supersedes R158.49 regex `[^\r\n\-]+`.
        # The old regex excluded `-` thinking it might be a terminator, but
        # workstation hostnames routinely contain `-` (DL-08001-D,
        # KDLFL-OFADSRV1, SRV-DC01-PROD). The `-` exclusion caused the
        # match to stop at the first `-` and ship `DL` for `DL-08001-D`.
        # New regex uses non-greedy `.+?\s*$` with multiline mode (?ms)
        # so the match captures everything up to end-of-line.
        $callerComputerName = ''
        try {
          $msg = [string]$e.Message
          # Match EN first ("Caller Computer Name: workstation01"). The
          # pattern is "label:" followed by a value up to EOL. Group
          # captures the workstation name verbatim (incl. hyphens).
          if ($msg -match '(?ms)^\s*Caller\s+Computer\s+Name:\s*(?<ccn>.+?)\s*$') {
            $callerComputerName = $matches['ccn'].Trim()
          }
          # Localized: ZH-SIMPLIFIED uses "" / "".
          elseif ($msg -match '(?ms)^\s*:\s*(?<ccn>.+?)\s*$') {
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
        # R158.50.7e — port cross-domain displayName fix from
        # ad_failed_logon_collector. Old code used -Server $server (local
        # DC), which made Get-ADUser return null for cross-domain 4740
        # events. Use -Domain $targetDomainName so LDAP lookup points at
        # the right domain controller.
        $targetUserDisplayName = (Get-UserDisplayNameCached -Sam $targetUserName -Domain $targetDomainName)
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
      } catch {
        # R158.52 — per-event guard. Skip one bad 4740 instead of dropping
        # the entire 15-min batch.
        $skippedBadEvent++
        [Console]::Error.WriteLine("R158.52: skipped bad 4740 event record=$($e.RecordId): $($_.Exception.Message)")
      }
    }
    if ($skippedBadEvent -gt 0) {
      [Console]::Error.WriteLine("R158.52: skipped $skippedBadEvent malformed 4740 event(s)")
    }
  }
} catch {
  [Console]::Error.WriteLine("lockoutEvents failed: $($_.Exception.Message)")
  # R158.50.6 —  message  stdout `error`
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
  # R158.50.6 —  error message ( lockoutEvents )
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

# R158.50.6 —  message  stdout `error` ,  agent reporter
#  r.error, centre package_runs.status='failed'. PS1  exit 0
# ( spawn  spawn-error ),  agent  error .
# R158.50.7f — 0 命中 keeps $lastErrorMessage=null so error:null in JSON.
# status='success' (R158.50.7g) → 绿色 ✓.
$payload = @{
  metrics = $metrics
  error   = if ($lastErrorMessage) { $lastErrorMessage } else { $null }
}
$payload | ConvertTo-Json -Compress -Depth 6
exit 0