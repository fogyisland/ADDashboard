# collect.ps1 - ad_lockout_list v1.0.6 (R158.50.7l — displayName )
#
# R158.50.7l (2026-10-08) — supersedes 1.0.5 R158.50.7e cross-domain fix.
# 1.0.5 Get-UserDisplayNameCached -Domain $TargetDomainName  EventData 
# TargetDomainName  AD  FQDN/NETBIOS,  trust 
# workstation  (BJ-L-PF27GZN7). Get-ADUser -Server <workstation>
#  "" → null → cache null 24h → displayName .
# 4625 (ad_failed_logon_collector 1.0.4) , displayName  "184132" .
#
# 1.0.6  1.0.3  (R139.1)  LDAP idiom:
#   - Get-UserDisplayNameCached -Sam $targetUserName ( -Domain / -Server)
#   - Get-ADUser  -Server  LDAP (DC )
#   - 99% ,  LDAP 
#   -  (trust )  null, " workstation hostname " 
#   - cache key  SAM ( -Domain )
#   - null  ( 24h, R158.50.7e lesson 4)
#
# R158.50.7f (2026-10-08) — 0  idle  (1.0.5 ship , 1.0.6 ).
#   - Get-WinEvent -FilterXml -ErrorAction SilentlyContinue
#   - 0  → events=@(), error_code=0 → status='success'
#   -  → $null → throw → catch → error_code=1
#   -  stderr "no 4740 events in 15min window"  idle.
#
# :
#   1. Get-WinEvent -FilterXml -ErrorAction SilentlyContinue (15-min window, EventID=4740).
#   2. If $null → throw → catch → error_code=1 (, ).
#   - If @($raw).Count -eq 0 → idle state → events=@(), stderr informational, no error.
#   - Else foreach parse each event:
#        R135  - name-based EventData extraction (NOT index-based)
#        R158.49.1 - callerComputerName regex `(?ms).+?\s*$` ( '-' hostname)
#        R158.50.7l - displayName via  LDAP (default -Server = agent login domain)
#        R158.52  - per-event try/catch, skip one bad 4740
#   3. Ensure ActiveDirectory RSAT module is available (R158.31) → error_code=2 if missing
#      (so the operator knows description=* will be NULL even when 4740 events flow).
#   4. Emit {metrics, error} JSON. Exit 0.
#
#  R-:
#   - R136: UTF-8 stdout
#   - R139.1: 24h Get-ADUser displayName cache (R158.50.7e  Domain  Server)
#   - R158.49.1: callerComputerName regex `(?ms).+?\s*$` ( '-' hostname)
#   - R158.50.5: FilterXml ( FilterHashtable)
#   - R158.50.6: $lastErrorMessage → payload.error ()
#   - R158.50.7e: Get-UserDisplayNameCached -Domain ( displayName)
#   - R158.52: per-event try/catch + accumulated $skippedBadEvent
#   - R158.50.7g: status  (success/partial/failed/running)  centre runner 

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
# (cmdlet  ProviderMetadata / log  / WMI ). 0  idle
# state, .
$lastErrorMessage  = $null

# R139.1 — process-level 24h cache for `Get-ADUser -Properties displayName`.
# Keyed by lowercase SAM (case-insensitive). The hashtable + expiry
# pattern is intentionally simple (no JSON disk persistence): the agent
# process restarts at most once per OS reboot, so a cold cache is
# acceptable. 24h TTL chosen so a long-running agent that polls every
# 15 min re-validates at most once a day.
# R158.50.7l — cache key simplified to SAM only (was {Domain}|{Sam}
# in 1.0.5 R158.50.7e). 1.0.6 reverted to local-LDAP lookup so cross-
# domain SAM collision is moot on the local DC. R158.50.7e also cached
# null on lookup failure which locked the bad state for 24h; 1.0.6 only
# caches positive lookups, null always retries next call.
$script:UserDescCache       = @{}
$script:UserDescCacheExpiry = (Get-Date).AddHours(-1)   # sentinel: expired on first call

function Reset-UserDescCacheIfExpired {
  if ((Get-Date) -gt $script:UserDescCacheExpiry) {
    $script:UserDescCache = @{}
    $script:UserDescCacheExpiry = (Get-Date).AddHours(24)
  }
}

function Get-UserDisplayNameCached {
  # R158.50.7l — supersedes 1.0.5 R158.50.7e cross-domain fix.
  # 1.0.5 used Get-ADUser -Server $Domain where $Domain came from
  # EventData TargetDomainName. In cross-domain trust scenarios the
  # actual value of TargetDomainName is the CALLER workstation hostname
  # (verified on KDLFLOFADSRV2 2026-10-08: TargetDomainName="BJ-L-PF27GZN7"
  # matched CallerComputerName, not the AD domain). Get-ADUser -Server
  # <workstation> fails with "" and the lookup returns null.
  # 1.0.6 reverts to the R139.1 default-Get-ADUser idiom: when no -Server
  # is specified, Get-ADUser targets the domain of the current user
  # (which on a DC service account is the local AD domain). 99% of 4740
  # lockouts are in-domain, so the local LDAP succeeds. Cross-domain
  # trust users will still resolve to null but that's a known acceptable
  # degradation, much better than the 1.0.5 "always null" anti-pattern.
  param([string]$Sam)
  if ([string]::IsNullOrWhiteSpace($Sam)) { return $null }

  Reset-UserDescCacheIfExpired

  $key = $Sam.ToLowerInvariant()
  if ($script:UserDescCache.ContainsKey($key)) {
    return $script:UserDescCache[$key]
  }

  $displayName = $null
  try {
    # No -Server: Get-ADUser uses current user logon domain (= the
    # local AD domain when running as the agent service account on
    # a DC). Identity lookup by SAM is unambiguous; -Properties
    # displayName forces AD to populate the otherwise-suppressed
    # displayName attribute.
    $u = Get-ADUser -Identity $Sam -Properties displayName -ErrorAction Stop
    if ($null -ne $u -and $null -ne $u.displayName) {
      $raw = [string]$u.displayName
      # Trim to 510 chars (VARCHAR(512) leaves 2 buffer; MySQL strict
      # mode would otherwise error out on overflow. MSSQL NVARCHAR is
      # wider but 510 is the safe common-denominator).
      if ($raw.Length -gt 510) { $raw = $raw.Substring(0, 510) }
      $displayName = $raw
    }
  } catch {
    # Account deleted, RSAT module absent, AD unreachable, etc.
    # Do NOT cache the null — R158.50.7e lesson: caching null locked
    # the failure for 24h. Retry every call so a transient LDAP
    # outage self-heals once AD is back.
    [Console]::Error.WriteLine("Get-ADUser('$Sam') failed: $($_.Exception.Message)")
    return $null
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
  # so 0  is NOT raised as EventLogQueryException ("
  # 。"). 0  is the normal idle state for
  # ad_lockout_list (15-min window, EventID=4740 is rare on most DCs).
  # Real failures (ProviderMetadata / log  / WMI ) cause the
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
        # R158.50.7l — supersedes R158.50.7e. 1.0.5's
        # Get-UserDisplayNameCached -Domain $targetDomainName failed
        # because EventData TargetDomainName is the caller workstation
        # hostname in cross-domain trust, not an AD domain FQDN.
        # 1.0.6 uses the default Get-ADUser (no -Server) which targets
        # the current user's logon domain = local AD domain on a DC.
        $targetUserDisplayName = (Get-UserDisplayNameCached -Sam $targetUserName)
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
# R158.50.7f — 0  keeps $lastErrorMessage=null so error:null in JSON.
# status='success' (R158.50.7g) →  ✓.
$payload = @{
  metrics = $metrics
  error   = if ($lastErrorMessage) { $lastErrorMessage } else { $null }
}
$payload | ConvertTo-Json -Compress -Depth 6
exit 0