[CmdletBinding()]
param(
  [switch]$ForTesting
)

$ErrorActionPreference = 'Continue'

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
      $dt = [DateTime]::Parse($Value, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AssumeUniversal -bor [System.Globalization.DateTimeStyles]::AdjustToUniversal)
    } catch {
      return $null
    }
  }

  return $dt.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
}

function Get-DcCounters {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$ComputerName
  )

  $counters = [ordered]@{
    UsersCount  = $null
    GroupsCount = $null
    GposCount   = $null
    LockedCount = $null
  }

  # Each counter is isolated: a failure here must not break replication
  # collection or other counters. $ErrorActionPreference stays 'Continue'
  # so unexpected throwables are still caught below.

  try {
    if (-not (Get-Module -Name ActiveDirectory -ListAvailable)) {
      throw "ActiveDirectory module not available"
    }
    if (-not (Get-Module -Name ActiveDirectory)) {
      Import-Module ActiveDirectory -ErrorAction Stop
    }
    $counters.UsersCount = (Get-ADUser -Filter * -Server $ComputerName | Measure-Object).Count
  } catch {
    [Console]::Error.WriteLine("usersCount failed: $($_.Exception.Message)")
  }

  try {
    if (-not (Get-Module -Name ActiveDirectory)) {
      Import-Module ActiveDirectory -ErrorAction Stop
    }
    $counters.GroupsCount = (Get-ADGroup -Filter * -Server $ComputerName | Measure-Object).Count
  } catch {
    [Console]::Error.WriteLine("groupsCount failed: $($_.Exception.Message)")
  }

  try {
    $counters.GposCount = (Get-GPO -All | Measure-Object).Count
  } catch {
    [Console]::Error.WriteLine("gposCount failed: $($_.Exception.Message)")
  }

  try {
    if (-not (Get-Module -Name ActiveDirectory)) {
      Import-Module ActiveDirectory -ErrorAction Stop
    }
    $counters.LockedCount = (Search-ADAccount -LockedOut -Server $ComputerName | Measure-Object).Count
  } catch {
    [Console]::Error.WriteLine("lockedCount failed: $($_.Exception.Message)")
  }

  return [PSCustomObject]$counters
}

function Get-LockoutEvents {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$ComputerName
  )

  # ComputerName is accepted for symmetry with Get-DcCounters but is
  # intentionally unused inside the function body: PS 5.1's
  # Get-WinEvent -FilterHashtable form does not accept -ComputerName
  # (only the non-Hashtable form does). The agent runs locally on each
  # DC, so reading the local Security log is sufficient. If remote
  # collection is added later, switch to
  # Get-WinEvent -ComputerName $ComputerName -FilterHashtable @{...}
  # on pwsh 7+ only.
  $events = @()
  try {
    $start = (Get-Date).AddMinutes(-15)
    $raw = Get-WinEvent -FilterHashtable @{
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
  }
  # The comma operator forces PowerShell to emit the array even when empty
  # — without it, an empty $events collapses to $null on return.
  return ,$events
}

function Get-ReplicationSnapshot {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$ComputerName
  )

  $snapshot = [PSCustomObject]@{
    CollectedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    AgentId     = $ComputerName
    Site        = $null
    Entries     = @()
  }

  # Try to resolve site via AD module. If unavailable, leave $null and rely on
  # the meta-failure entry below.
  try {
    if (-not (Get-Module -Name ActiveDirectory -ListAvailable)) {
      throw "ActiveDirectory module not available"
    }
    Import-Module ActiveDirectory -ErrorAction Stop
    $dc = Get-ADDomainController -Identity $ComputerName -ErrorAction Stop
    if ($dc) {
      $snapshot.Site = $dc.SiteObjectName
    }
  } catch {
    Write-Verbose "Site lookup failed: $_"
    $snapshot.Site = $null
  }

  # Try to get replication partner metadata. If it fails, emit a meta failure entry.
  $partners = $null
  try {
    if (-not (Get-Module -Name ActiveDirectory -ListAvailable)) {
      throw "ActiveDirectory module not available"
    }
    if (-not (Get-Module -Name ActiveDirectory)) {
      Import-Module ActiveDirectory -ErrorAction Stop
    }
    $partners = Get-ADReplicationPartnerMetadata -Target $ComputerName -Scope Domain -ErrorAction Stop
  } catch {
    $metaFailure = [PSCustomObject]@{
      SourceDc         = '*'
      DestDc           = '*'
      SourceSite       = $null
      DestSite         = $null
      NamingContext    = 'META'
      LastSuccessTime  = $null
      LastAttemptTime  = $null
      StatusCode       = -1
      ErrorMessage     = $_.Exception.Message
    }
    $snapshot.Entries = @($metaFailure)
    return $snapshot
  }

  $entries = @()
  if ($null -ne $partners) {
    foreach ($p in $partners) {
      $status = 0
      try {
        $status = [int]$p.LastReplicationResult
      } catch {
        $status = 0
      }
      $errMsg = $null
      if ($status -ne 0) {
        $errMsg = "code $($status)"
      }
      $entry = [PSCustomObject]@{
        SourceDc        = [string]$p.Partner
        DestDc          = $ComputerName
        SourceSite      = $snapshot.Site
        DestSite        = $null
        NamingContext   = [string]$p.NamingContext
        LastSuccessTime = (ConvertTo-UtcIso -Value $p.LastReplicationSuccess)
        LastAttemptTime = (ConvertTo-UtcIso -Value $p.LastReplicationAttempt)
        StatusCode      = $status
        ErrorMessage    = $errMsg
      }
      $entries += $entry
    }
  }

  # DC summary card counters — emitted as a self-loop entry so the data
  # rides on the same replication ingest path. Naming context 'META' is
  # already used by the meta-failure entry above; '__dc_summary__' is the
  # canonical marker for "this row holds the 4 card counters".
  $counters = Get-DcCounters -ComputerName $ComputerName
  $summaryEntry = [PSCustomObject]@{
    SourceDc        = $ComputerName
    DestDc          = $ComputerName
    SourceSite      = $snapshot.Site
    DestSite        = $null
    NamingContext   = '__dc_summary__'
    LastSuccessTime = $snapshot.CollectedAt
    LastAttemptTime = $snapshot.CollectedAt
    StatusCode      = 0
    ErrorMessage    = $null
    UsersCount      = $counters.UsersCount
    GroupsCount     = $counters.GroupsCount
    GposCount       = $counters.GposCount
    LockedCount     = $counters.LockedCount
  }
  $entries += $summaryEntry

  # Lockout troubleshooting — append the last 15 min of Security event 4740
  # (user account locked out) from the local Security log. Travels as a
  # top-level snapshot field (not as an Entry, because these aren't
  # replication rows). The center's UNIQUE(dc_name, event_record_id) gives
  # us idempotent ingest — the agent is stateless across cycles.
  $LockoutEvents = Get-LockoutEvents -ComputerName $ComputerName
  $snapshot | Add-Member -NotePropertyName LockoutEvents `
                        -NotePropertyValue $LockoutEvents

  $snapshot.Entries = $entries
  return $snapshot
}

function ConvertTo-SnapshotJson {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    $Snapshot
  )

  return ($Snapshot | ConvertTo-Json -Depth 6 -Compress)
}

if (-not $ForTesting) {
  try {
    $snap = Get-ReplicationSnapshot -ComputerName $env:COMPUTERNAME
    $json = ConvertTo-SnapshotJson -Snapshot $snap
    [Console]::Out.WriteLine($json)
    if ($snap.Entries.Count -gt 0) {
      exit 0
    } else {
      exit 1
    }
  } catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 2
  }
}
