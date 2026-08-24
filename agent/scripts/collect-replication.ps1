[CmdletBinding()]
param(
  [switch]$ForTesting
)

# 2026-08-24 round-9: PS 5.1 [Console]::OutputEncoding defaults to the
# system OEM codepage (CN = GBK/936). [Console]::Out/Error.WriteLine
# serializes non-ASCII (e.g., Chinese AD error text) using that encoding,
# producing GBK bytes on stdout. The agent child reads stdout as UTF-8
# by default, so Chinese characters become U+FFFD + isolated surrogate
# pairs (the mojibake pattern KDLWXOFADSRV1 was emitting). Set UTF-8
# explicitly so [Console]::Out/Error write UTF-8 bytes that Node decodes
# correctly. $OutputEncoding covers pipeline redirection for defense in
# depth. Same trap fires in collect-discovery.ps1 — fixed there too.
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding           = [System.Text.UTF8Encoding]::new($false)

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

# Default 5 ports to probe against every replication partner. The same set
# appears in ad_local_port_check/collect.ps1 (Task 2). String keys
# ("135" / "445" / ...) are used in the emitted JSON so the centre can
# index by port without parsing dotted notation.
$script:DefaultPartnerPortSet = @(135, 445, 50001, 50002, 50003)

# Build the naming_context value for a partner-port row.
# Column is `ad_replication_status.naming_context VARCHAR(256)` (see
# db/schema/01-tables.sql). FQDN partners up to 253 chars + the
# 17-char `__partner_ports__:` prefix blow past 256, and IPv6 literals
# like `[2001:db8::1]:389` push past any reasonable limit. Truncate the
# host to 64 chars and append a 4-byte SHA-256 hex suffix derived from
# the FULL host — preserves uniqueness across partners that share a
# common 64-char prefix while keeping every emitted value well under
# 86 chars (64 + 1 separator + 8 hex + 17 prefix).
function Get-PartnerNamingContext {
  param([string]$partnerHost)
  if ([string]::IsNullOrEmpty($partnerHost)) { return $null }
  $truncated = if ($partnerHost.Length -gt 64) {
    $partnerHost.Substring(0, 64)
  } else {
    $partnerHost
  }
  $bytes = [System.Security.Cryptography.SHA256]::Create().ComputeHash(
    [System.Text.Encoding]::UTF8.GetBytes($partnerHost)
  )
  $hashStr = -join ($bytes[0..3] | ForEach-Object { $_.ToString('x2') })
  return "__partner_ports__:${truncated}_${hashStr}"
}

function Get-PartnerPortSnapshot {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$ComputerName,

    [Parameter(Mandatory = $true)]
    [AllowNull()]
    $Partners,

    [Parameter()]
    [int]$PerProbeTimeoutMs = 1500,

    [Parameter()]
    [int]$MaxPartners = 25,

    [Parameter()]
    [AllowNull()]
    [string]$Site = $null,

    [Parameter()]
    [AllowNull()]
    [string]$CollectedAt = $null,

    [Parameter()]
    [int[]]$Ports = $script:DefaultPartnerPortSet
  )

  $rows = @()
  if ($null -eq $Partners) {
    return ,$rows
  }

  # self-loop guard — Get-ADReplicationPartnerMetadata -Target $ComputerName
  # already excludes self, but defend-in-depth (brief: "if Partner equals
  # ComputerName, skip").
  $capped = @($Partners | Select-Object -First $MaxPartners)
  $nowIso = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')

  # Sequential probing. Worst-case latency per partner where every port
  # times out: Ports.Count * PerProbeTimeoutMs = 5 * 1500 = 7500 ms.
  # 25 partners worst-case = 187 s (collector's default timeoutMs = 60 s).
  # Start-Job startup overhead (>300 ms per job) outweighs the savings in
  # the typical reachable case (probe completes <100 ms), so we stay
  # sequential and document this trade-off in the report — caller can pass
  # a bumped timeoutMs into runCollector if their topology has many
  # unreachable partners.
  foreach ($p in $capped) {
    $partnerHost = $null
    try { $partnerHost = [string]$p.Partner } catch { $partnerHost = $null }
    if ([string]::IsNullOrEmpty($partnerHost)) { continue }
    if ($partnerHost -eq $ComputerName) { continue }

    # Probe this partner's 5 ports sequentially. Each probe is wrapped in
    # try/catch/finally with Close() in finally so one failure cannot
    # strand a socket or abort the rest of the partner's probes.
    $portResults = @()
    foreach ($port in $Ports) {
      $client = New-Object System.Net.Sockets.TcpClient
      $reachable = $false
      $latencyMs = $null
      $errorMsg = $null
      try {
        $connectTask = $client.ConnectAsync($partnerHost, [int]$port)
        $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
        $completed = $connectTask.Wait($PerProbeTimeoutMs)
        $stopwatch.Stop()
        if ($completed -and $client.Connected) {
          $reachable = $true
          $latencyMs = [int]$stopwatch.ElapsedMilliseconds
        } else {
          $errorMsg = 'timeout'
        }
      } catch {
        $errorMsg = $_.Exception.Message
      } finally {
        try { $client.Close() } catch {}
      }
      $portResults += [PSCustomObject]@{
        port      = [int]$port
        reachable = $reachable
        latencyMs = $latencyMs
        error     = $errorMsg
      }
    }

    # Build the per-partner row matching the 16-column INSERT shape
    # (collected_at, agent_id, source_dc, dest_dc, source_site, dest_site,
    # naming_context, last_success_time, last_attempt_time, status_code,
    # error_message, users_count, groups_count, gpos_count, locked_count,
    # partner_port_status) — see center/src/db/sql.js
    # replication.upsertStatus. status_code: 0 = every port reachable,
    # otherwise the count of unreachable ports (caller maps to severity
    # tiers server-side).
    $unreachableCount = 0
    $portMap = [ordered]@{}
    foreach ($r in $portResults) {
      $portMap[[string]$r.port] = @{
        reachable = $r.reachable
        latencyMs = $r.latencyMs
        error     = $r.error
      }
      if (-not $r.reachable) { $unreachableCount += 1 }
    }
    $statusCode = if ($unreachableCount -eq 0) { 0 } else { $unreachableCount }
    $payload = [ordered]@{
      checked_at = $nowIso
      ports      = $portMap
    } | ConvertTo-Json -Compress -Depth 4

    $rows += [PSCustomObject]@{
      CollectedAt       = $nowIso
      AgentId           = $ComputerName
      SourceDc          = $ComputerName
      DestDc            = $partnerHost
      SourceSite        = $Site
      DestSite          = $null
      # Sanitized: see Get-PartnerNamingContext for the truncate+hash
      # rationale. Keeps every emitted value well under
      # naming_context VARCHAR(256).
      NamingContext     = Get-PartnerNamingContext -partnerHost $partnerHost
      LastSuccessTime   = $(if ($CollectedAt) { $CollectedAt } else { $nowIso })
      LastAttemptTime   = $(if ($CollectedAt) { $CollectedAt } else { $nowIso })
      StatusCode        = $statusCode
      ErrorMessage      = $null
      UsersCount        = $null
      GroupsCount       = $null
      GposCount         = $null
      LockedCount       = $null
      PartnerPortStatus = $payload
    }
  }

  # Comma operator forces the array to survive even when $rows is empty,
  # mirroring Get-LockoutEvents's documented contract.
  return ,$rows
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

  # Per-partner port probes — one row per replication partner, each with
  # the same 16-column INSERT shape (R1 partner_port_status carries the
  # per-port reachable/latency JSON; R2 naming context
  # '__partner_ports__:<host>' keeps each partner's row UNIQUE). Function
  # is fault-isolated: a probe failure on one partner cannot abort the
  # others, and an empty partner list produces no rows (no error).
  if ($null -ne $partners -and @($partners).Count -gt 0) {
    $portEntries = Get-PartnerPortSnapshot `
      -ComputerName $ComputerName `
      -Partners $partners `
      -Site $snapshot.Site `
      -CollectedAt $snapshot.CollectedAt
    if ($null -ne $portEntries -and @($portEntries).Count -gt 0) {
      foreach ($pe in @($portEntries)) { $entries += $pe }
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
