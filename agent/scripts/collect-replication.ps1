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
