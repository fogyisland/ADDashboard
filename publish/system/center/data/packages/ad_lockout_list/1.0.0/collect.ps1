# collect.ps1 - ad_lockout_list v1
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
#   3. Each event is stamped OccurredAt = ISO-8601 UTC.
#   4. Always emit a non-null `events` JSON array (empty array on no
#      events / failure) so metricstore validation never sees a missing
#      column. error_code bit accumulator:
#        1 = WinEvent query failed (RSAT absent or log unreadable)
#
# Server clock stamps `ts` on the center side; this script omits it.
# Exit code 0 regardless of outcome.

$ErrorActionPreference = 'Continue'

$server    = $env:COMPUTERNAME
$events    = @()
$errorCode = 0

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
  $raw    = Get-WinEvent -FilterHashtable @{
    LogName   = 'Security'
    Id        = 4740
    StartTime = $start
  } -ErrorAction Stop
  foreach ($e in $raw) {
    $xml = [xml]$e.ToXml()
    $ed  = $xml.Event.EventData
    $events += [PSCustomObject]@{
      EventRecordId      = [int64]$e.RecordId
      OccurredAt         = (ConvertTo-UtcIso -Value $e.TimeCreated)
      TargetUserName     = [string]$ed.Data[0].'#text'
      SubjectUserName    = [string]$ed.Data[1].'#text'
      SubjectDomain      = [string]$ed.Data[2].'#text'
      CallerComputerName = [string]$ed.Data[3].'#text'
    }
  }
} catch {
  [Console]::Error.WriteLine("lockoutEvents failed: $($_.Exception.Message)")
  $errorCode = $errorCode -bor 1
}

$metrics = @{
  agent_id    = $server
  events      = @($events)
  event_count = [int](@($events).Count)
  error_code  = [int]$errorCode
}

$payload = @{ metrics = $metrics }
$payload | ConvertTo-Json -Compress -Depth 6
exit 0
