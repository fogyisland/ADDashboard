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
  }

  # Each counter is isolated: a failure here must not break replication
  # collection or other counters. $ErrorActionPreference stays 'Continue'
  # so unexpected throwables are still caught below.

  # 2026-08-26 round-18: LockedCount is no longer part of the replication
  # snapshot. It moved to its own ad_lockout_summary package so the
  # cadence is independent of the replication cycle (user wants every
  # 15 minutes, regardless of replication activity).

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

  return [PSCustomObject]$counters
}

# 2026-08-26 round-18: Get-LockoutEvents was removed. Lockout events now
# ship via the ad_lockout_list package on a 15-minute cadence, independent
# of the replication cycle. The function body lives in
# center/data/packages/ad_lockout_list/1.0.0/collect.ps1 if you need to
# trace it.

# Default 5 ports to probe against every replication partner. The same set
# appears in ad_local_port_check/collect.ps1 (Task 2). String keys
# ("135" / "445" / ...) are used in the emitted JSON so the centre can
# index by port without parsing dotted notation.
$script:DefaultPartnerPortSet = @(135, 445, 50001, 50002, 50003)

# 2026-08-26 round-16 replication-port probe config: fetch the operator-
# defined port list from the centre on every run so changes in the admin UI
# reach the agent without reinstalling. Falls back to the hardcoded default
# set on any failure (no network, missing appsettings.json, bad token, JSON
# parse error, non-array response, etc.) — the agent must NEVER abort a
# replication cycle just because the port-config fetch hiccupped.
function Get-PartnerPortConfig {
  [CmdletBinding()]
  param()

  # Default first — overwritten on success.
  $resolved = $script:DefaultPartnerPortSet

  # Locate appsettings.json. The script lives at <install>/Agent/scripts/
  # collect-replication.ps1; appsettings.json is at <install>/Agent/
  # appsettings.json. $PSScriptRoot gives us a stable relative path; do not
  # use $PWD (the agent child process inherits the NSSM service's working
  # directory which is unrelated to the install root).
  $cfgPath = Join-Path -Path $PSScriptRoot -ChildPath '..\appsettings.json'
  $cfgPath = [System.IO.Path]::GetFullPath($cfgPath)
  if (-not (Test-Path -LiteralPath $cfgPath)) {
    return ,$resolved
  }

  # Read + parse JSON. PowerShell 5.1's ConvertFrom-Json handles PS1's own
  # UTF-8-with-BOM (appsettings.json was historically saved that way by the
  # agent installer — see round-8 BOM-strip story in agent/src/config.js
  # for context).
  $cfg = $null
  try {
    $cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
  } catch {
    return ,$resolved
  }
  if ($null -eq $cfg) { return ,$resolved }

  $centerUrl = [string]$cfg.centerUrl
  $token     = [string]$cfg.agentToken
  if ([string]::IsNullOrEmpty($centerUrl) -or [string]::IsNullOrEmpty($token)) {
    return ,$resolved
  }

  # The endpoint is auth-free on the server side (operator-defined read
  # endpoint, see center/src/routes/agent.js GET /api/agent/partner-ports).
  # We send X-Agent-Token anyway — server logs use it to attribute the
  # request, and the server tolerates both presence and absence.
  $url = ($centerUrl.TrimEnd('/')) + '/api/agent/partner-ports'
  try {
    # .NET WebClient is the lowest-common-denominator HTTP client available
    # on PS 5.1 without Import-Module. Sync request with a 3 s timeout —
    # the centre is on the LAN; longer than that means something is wrong
    # and we'd rather probe the default ports than block the script.
    Add-Type -AssemblyName System.Net.Http -ErrorAction Stop
    $client = New-Object System.Net.Http.HttpClient
    $client.Timeout = [TimeSpan]::FromSeconds(3)
    $req = New-Object System.Net.Http.HttpRequestMessage -ArgumentList 'GET', $url
    $req.Headers.Add('X-Agent-Token', $token)
    $resp = $client.SendAsync($req).GetAwaiter().GetResult()
    if (-not $resp.IsSuccessStatusCode) {
      return ,$resolved
    }
    $body = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    $parsed = $body | ConvertFrom-Json -ErrorAction Stop
    if ($null -eq $parsed -or $null -eq $parsed.ports) { return ,$resolved }
    # Defensive: filter to integers in [1, 65535] — refuse anything weird.
    $clean = @()
    foreach ($p in @($parsed.ports)) {
      $n = 0
      if ([int]::TryParse([string]$p, [ref]$n) -and $n -ge 1 -and $n -le 65535) {
        $clean += $n
      }
    }
    if ($clean.Count -gt 0) {
      $resolved = @($clean | Sort-Object)
    }
    return ,$resolved
  } catch {
    return ,$resolved
  }
}

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
      PartnerPortStatus = $payload
    }
  }

  # Comma operator forces the array to survive even when $rows is empty.
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
    # Server scope (default) — returns only this DC's replication partners.
    # -Scope Domain queries all DCs across the domain and fails with
    # "specified domain either does not exist or could not be contacted"
    # whenever the local ADWS can't reach even one remote DC for metadata
    # (KDLWXOFADSRV1 hit this: Get-ADDomain/Get-ADDomainController work,
    # Get-ADReplicationPartnerMetadata -Scope Domain fails). For an agent
    # whose job is "give me THIS DC's partners", Server scope is exactly
    # the right surface area.
    $partners = Get-ADReplicationPartnerMetadata -Target $ComputerName -ErrorAction Stop
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
  #
  # 2026-08-26 round-16 replication-port probe config: fetch the operator-
  # defined port list from the centre on every run. Get-PartnerPortConfig
  # already swallows every failure mode (no appsettings.json / no token /
  # network unreachable / bad JSON / non-2xx / out-of-range port) and falls
  # back to $script:DefaultPartnerPortSet — so this call site stays simple:
  # resolve the list once, hand it to Get-PartnerPortSnapshot via -Ports.
  if ($null -ne $partners -and @($partners).Count -gt 0) {
    $portsToProbe = Get-PartnerPortConfig
    $portEntries = Get-PartnerPortSnapshot `
      -ComputerName $ComputerName `
      -Partners $partners `
      -Site $snapshot.Site `
      -CollectedAt $snapshot.CollectedAt `
      -Ports $portsToProbe
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
  }
  $entries += $summaryEntry

  # 2026-08-26 round-18: LockoutEvents and LockedCount moved out of the
  # replication snapshot. They now ship via the ad_lockout_list and
  # ad_lockout_summary packages on a 15-minute cadence, independent of
  # the replication cycle. The center's /api/agent/report no longer
  # reads req.body.lockoutEvents.

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
