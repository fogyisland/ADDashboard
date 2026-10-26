# collect.ps1 - ad_failed_logon_collector v1.0.8 (R158.58)
#
# R158.50.7l (2026-10-08) — supersedes 1.0.4 R158.50.7e cross-domain fix.
# 1.0.4 Get-UserDisplayNameCached -Domain $TargetDomainName assumed the
# EventData TargetDomainName is an AD domain FQDN/NETBIOS. In cross-domain
# trust scenarios the actual value of TargetDomainName is the caller
# workstation hostname (verified on KDLFLOFADSRV2 2026-10-08: TargetDomainName
# 'BJ-L-PF27GZN7' == CallerComputerName, not 'SPHKDL' the AD domain).
# Get-ADUser -Server <workstation> throws "unable to contact server" and
# the lookup returns null. DB evidence on 4625 shows target_user_display_name
# populated with "184132" (a number — operator flagged as broken).
#
# 1.0.5 reverts to the R139.1 default-Get-ADUser idiom (no -Server),
# which targets the current user logon domain = local AD domain when
# the agent runs as a DC service account. 99% of 4625 lockouts are
# in-domain, so local LDAP succeeds. Cross-domain trust users will
# still resolve to null but that's acceptable degradation, much
# better than the 1.0.4 "always null" anti-pattern.
# Cache key simplified to SAM only (was {Domain}|{Sam}).
# Null lookups are NOT cached (R158.50.7e lesson — caching null
# locked the bad state for 24h).
#
# R158.50.7e (2026-10-07) was the broken version. 1.0.5 supersedes it.
# R158.50.7d (2026-10-07) — `param([xml]$Ed, ...)` type-coercion bug fix.
#
# R158.50.7d (2026-10-07) — fix `param([xml]$Ed, ...)` type-coercion
# bug. R158.50.7c (1.0.2) fixed the cast path
# `$xml = [xml]$e.ToXml()` → `XmlDocument.LoadXml()`, but the helper
# functions Get-EventDataField / Get-EventDataInt still declared
# `param([xml]$Ed, ...)`. PS5.1 parameter binding goes through
# LanguagePrimitives.ConvertTo which does NOT auto-wrap XmlElement →
# XmlDocument the way a return-value cast does. Caller passes
# `$ed = $doc.DocumentElement.EventData` (XmlElement) → throws
# "Cannot convert value 'System.Xml.XmlElement' to type
# 'System.Xml.XmlDocument'" → outer try/catch fires → $errorCode |= 1
# → events=[] → ETL upserted=0 → ad_failed_logon_events empty.
# 1.0.3 changed param to [Parameter()] — accepts both XmlDocument and
# XmlElement; .Data works on either.
#
# Reports Security event 4625 (An account failed to log on) entries from
# the local Security log over the last 900 seconds (15 minutes), as a JSON
# array. Companion to ad_lockout_list/1.0.2 (4740) — same 24h displayName
# cache, same EventData name-based extraction (R135), same error_code bit
# semantics.
#
# Operator directive (R158.50): ",,
# 2、displayname、DC、IP
# ,dashboard247
# .  1800 ".
#
# R158.58 (2026-10-09) — window 1800s → 900s. manifest.intervalSec
# is already 900 (R158.53 1.0.7 cadence). The PS1 hardcoded window was
# 1800s, so adjacent runs covered overlapping 15-min slices — each
# event fetched twice, then deduped by the MSSQL MERGE ON
# (dc_name, event_record_id). Aligned window to intervalSec to stop
# the wasted re-fetch overhead. No behavior change visible to
# /failed-logon-2h (event counts unchanged, only DC agent load drops).
#
# Algorithm:
#   1. Get-WinEvent -FilterXml (R158.50.5) for Security/4625 in last 900s.
#   2. 4625 EventData schema (per Microsoft docs):
#        SubjectUserSid, SubjectUserName, SubjectDomainName, SubjectLogonId,
#        TargetUserSid, TargetUserName, TargetDomainName, TargetLogonId,
#        Status, FailureReason, LogonProcessName, LogonType,
#        WorkstationName, CallerComputerName, IpAddress, IpPort,
#        AuthenticationPackageName.
#   3. IpAddress comma-separated → first non-empty non-dash segment.
#   4. Filter machine accounts (TargetUserName ending in '$').
#   5. DisplayName lookup: Get-ADUser -Server <TargetDomainName> (R158.50.7e).
#      24h process-level cache to amortize LDAP roundtrips.
#   6. error_code bit accumulator:
#        1 = WinEvent query failed (RSAT absent or log unreadable)
#        2 = ActiveDirectory RSAT module unavailable (description
#            lookups skipped, 4625 events still flow with description=null)

$ErrorActionPreference = 'Continue'

# R136: force UTF-8 stdout.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$server            = $env:COMPUTERNAME
$events            = @()
$errorCode         = 0
# R158.50.6 — propagate PS1 exception message into stdout JSON `error`,
# so agent package-runner.js sets r.error → centre status='failed'.
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
  # R158.50.7l — supersedes 1.0.4 R158.50.7e cross-domain fix.
  # 1.0.4 used Get-ADUser -Server $Domain where $Domain came from
  # EventData TargetDomainName. In cross-domain trust scenarios the
  # actual value of TargetDomainName is the CALLER workstation hostname
  # (verified on KDLFLOFADSRV2 2026-10-08: TargetDomainName="BJ-L-PF27GZN7"
  # matched CallerComputerName, not the AD domain). Get-ADUser -Server
  # <workstation> fails with "unable to contact server" and the lookup
  # returns null. 1.0.5 reverts to the R139.1 default-Get-ADUser idiom:
  # when no -Server is specified, Get-ADUser targets the domain of the
  # current user (which on a DC service account is the local AD domain).
  # 99% of 4625 failed-logons are in-domain, so the local LDAP succeeds.
  # Cross-domain trust users will still resolve to null but that's a
  # known acceptable degradation, much better than the 1.0.4 "always
  # null" anti-pattern.
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
      if ($raw.Length -gt 254) { $raw = $raw.Substring(0, 254) }
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
# R158.50.7d — type [xml] replaced with [Parameter()]. PS5.1
# param type binding goes through LanguagePrimitives.ConvertTo which does
# NOT auto-wrap System.Xml.XmlElement → System.Xml.XmlDocument the way
# a return-value `[xml]` cast does. The caller passes
#   $ed = $doc.DocumentElement.EventData   # this is XmlElement, not XmlDocument
# so `param([xml]$Ed, ...)` throws "Cannot convert ..." on the first
# 4625 in the window → outer try/catch fires → $errorCode |= 1 +
# events=[]. Using [Parameter()] (no type) accepts both XmlDocument and
# XmlElement — $Ed.Data works on either.
function Get-EventDataField {
  param([Parameter()]$Ed, [string]$FieldName)
  [string]($Ed.Data | Where-Object { $_.Name -eq $FieldName } | Select-Object -First 1 -ExpandProperty '#text')
}

function Get-EventDataInt {
  param([Parameter()]$Ed, [string]$FieldName)
  $s = Get-EventDataField -Ed $Ed -FieldName $FieldName
  if ([string]::IsNullOrWhiteSpace($s)) { return $null }
  try { return [int]$s } catch { return $null }
}

try {
  $start = (Get-Date).AddSeconds(-900)   # 900s / 15min window — R158.58 aligned with manifest.intervalSec
  # R158.50.5 — FilterXml (FilterHashtable 100% fails under agent service).
  $startIso = $start.ToUniversalTime().ToString('o')
  $filterXml = @"
<QueryList>
  <Query Id="0" Path="Security">
    <Select Path="Security">*[System[TimeCreated[@SystemTime>='$startIso'] and (EventID=4625)]]</Select>
  </Query>
</QueryList>
"@
  $raw   = Get-WinEvent -FilterXml $filterXml -ErrorAction SilentlyContinue 2>$null
  if ($null -eq $raw) {
    # 0 events in 30min window — normal at quiet DC. do not flag as error.
  } else {
  $skippedComputer = 0
  # R158.52 — operator directive " / ": per-event
  # try/catch so one corrupt 4625 event (malformed XML, missing field,
  # displayName cache throw) doesn't drop the entire 30-min batch.
  $skippedBadEvent = 0
  foreach ($e in $raw) {
    try {
      # R158.50.7c — XmlDocument.LoadXml (was [xml]$e.ToXml() cast).
      $doc = New-Object System.Xml.XmlDocument
      $doc.LoadXml($e.ToXml())
      $ed  = $doc.DocumentElement.EventData

      $eventRecordId    = [int64]$e.RecordId
      $occurredAt       = (ConvertTo-UtcIso -Value $e.TimeCreated)

      $targetUserName     = Get-EventDataField -Ed $ed -FieldName 'TargetUserName'
      $targetDomainName   = Get-EventDataField -Ed $ed -FieldName 'TargetDomainName'
      $targetSid          = Get-EventDataField -Ed $ed -FieldName 'TargetSid'
      $subjectUserName    = Get-EventDataField -Ed $ed -FieldName 'SubjectUserName'
      $subjectDomainName  = Get-EventDataField -Ed $ed -FieldName 'SubjectDomainName'

      # 4625 EventData (richer than 4740):
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

      # R158.50.7e — filter machine accounts. SAMs ending in '$' are
      # computer accounts; 4625 attempts on a machine account are not
      # user-password attacks and they skew the /failed-logon-2h
      # per-user pivot. Skip before any further work.
      if ($targetUserName -like '*$') {
        $skippedComputer++
        continue
      }

      # R158.50.7l — supersedes R158.50.7e. 1.0.4's
      # Get-UserDisplayNameCached -Domain $targetDomainName failed
      # because EventData TargetDomainName is the caller workstation
      # hostname in cross-domain trust, not an AD domain FQDN.
      # 1.0.5 uses the default Get-ADUser (no -Server) which targets
      # the current user's logon domain = local AD domain on a DC.
      $targetUserDisplayName = (Get-UserDisplayNameCached -Sam $targetUserName)

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
    } catch {
      # R158.52 — per-event guard. A single corrupt 4625 (malformed XML,
      # missing EventData, displayName cache throw) is skipped instead
      # of dropping the entire 30-min batch.
      $skippedBadEvent++
      [Console]::Error.WriteLine("R158.52: skipped bad 4625 event record=$($e.RecordId): $($_.Exception.Message)")
    }
  }
  # R158.50.7e — surface computer-account filter count in metrics so the
  # operator can see what's being dropped (helps debug "missing" 4625).
  if ($skippedComputer -gt 0) {
    [Console]::Error.WriteLine("R158.50.7e: filtered $skippedComputer machine-account 4625 event(s)")
  }
  # R158.52 — surface per-event skip count for diagnostic.
  if ($skippedBadEvent -gt 0) {
    [Console]::Error.WriteLine("R158.52: skipped $skippedBadEvent malformed 4625 event(s)")
  }
  }
} catch {
  [Console]::Error.WriteLine("failedLogonEvents query failed: $($_.Exception.Message)")
  # R158.50.6 — propagate message into stdout `error`.
  $lastErrorMessage = "failedLogonEvents query failed: $($_.Exception.Message)"
  $errorCode = $errorCode -bor 1
}

# Probe AD module once at the end (R158.31 lesson).
try {
  Ensure-ActiveDirectoryModule
} catch {
  [Console]::Error.WriteLine("ActiveDirectory module unavailable: $($_.Exception.Message)")
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

# R158.50.6 — message -> stdout `error`, agent reporter -> r.error.
# R158.50.7c — 'ok' placeholder for normal case (agent runner ignores
# 'ok' string, DB `error` column stays null).
$payload = @{
  metrics = $metrics
  error   = if ($lastErrorMessage) { $lastErrorMessage } else { 'ok' }
}
$payload | ConvertTo-Json -Compress -Depth 6
exit 0
