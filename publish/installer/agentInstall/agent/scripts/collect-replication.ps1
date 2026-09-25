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

# 2026-09-25 R93.6.1 (复制伙伴可见性 followup): KDLFLOFADSRV2 AD module
#   Get-ADReplicationPartnerMetadata did NOT surface PartnerSiteName, AND
#   the collector's `-Site` parameter was passed as $null (so $snapshot.Site
#   was also $null). R93.6's fallback chain ended at $snapshot.Site and the
#   sourceSite / destSite fields shipped as `""` to centre, where siteMatrix's
#   `WHERE source_site <> '' AND dest_site <> ''` filter (commit `6326701`)
#   excluded every row — operator saw an empty /replication-overview.
#
# The site name is encoded in the sourceDc DN at the canonical AD position:
#   CN=NTDS Settings,CN=<DCName>,CN=Servers,CN=<SiteName>,CN=Sites,...
# We parse it here as a 3rd-tier fallback so R93.6's contract — "every
# partner row carries a non-empty sourceSite/destSite that resolves to a
# real business site name" — holds even when the AD module is sparse and
# the snapshot's Site lookup failed upstream.
#
# Returns $null when the DN doesn't match the canonical shape (rogue
# inputs, malformed partner strings, etc.) so callers must continue to
# treat $null as "no site known" rather than coercing to ''.
function ExtractSiteFromDcDn {
  [CmdletBinding()]
  [OutputType([string])]
  param(
    [Parameter(Position = 0)]
    [AllowNull()]
    [string]$Partner
  )

  if ([string]::IsNullOrEmpty($Partner)) {
    return $null
  }

  # Canonical AD replication DN shape:
  #   CN=NTDS Settings,CN=<DCName>,CN=Servers,CN=<SiteName>,CN=Sites,CN=Configuration,...
  # We anchor on CN=Servers followed by CN=<SiteName> with comma boundaries so
  # site names containing '=' or other special chars don't break the match
  # (RFC 1779 escapes commas inside values; we don't expect them in CN=).
  if ($Partner -match '(?i),\s*CN=Servers,\s*CN=([^,]+),\s*CN=Sites(\s*,|$)') {
    $siteName = $matches[1].Trim()
    if (-not [string]::IsNullOrEmpty($siteName)) {
      return $siteName
    }
  }

  return $null
}

# 2026-09-25 R93.6.1 (复制状态概览 partner visibility followup): when
#   `Get-ADDomainController` resolution failed for $ComputerName AND the
#   collector's `-Site` param was not supplied (so $snapshot.Site stays
#   $null on the snapshot itself), recover self-site by reverse-mapping
#   the partner list. Every partner DN of the form
#     CN=NTDS Settings,CN=<peerDC>,CN=Servers,CN=<peerSite>,CN=Sites,...
#   also encodes $ComputerName's site when this DC is the peer — i.e.,
#   any partner for whom KDLFLOFADSRV2 appears as `SourceDc = "CN=NTDS
#   Settings,CN=KDLFLOFADSRV2,CN=Servers,CN=KDL-FL-HubSite,..."` carries
#   self-site info via the partner's DN too (when running on a peer DC
#   that lists KDLFLOFADSRV2 as its partner, the same DN appears in
#   that peer's view). On a hub DC, however, the peer DCs' DNs carry
#   the peers' sites, not self site — so this reverse mapping is a
#   best-effort heuristic that only succeeds when the collector runs
#   on a leaf DC whose partners include the hub.
#
# Returns the first parseable site name from the supplied partner
# objects, or $null if no partner yields a parseable site. Callers
# must keep $snapshot.Site = $null as the canonical contract when
# both AD lookup AND this reverse-mapping miss.
function Resolve-SelfSiteFromPartners {
  [CmdletBinding()]
  [OutputType([string])]
  param(
    [Parameter(Position = 0)]
    [AllowNull()]
    [object[]]$Partners
  )

  if ($null -eq $Partners -or @($Partners).Count -eq 0) {
    return $null
  }

  # Walk partners in order; first parseable site wins. We do NOT
  # majority-vote here because the partner list ordering in KDL is
  # deterministic (alphabetical by PartnerServer per AD module) and
  # the first entry is stable across re-collects, giving the same
  # answer on every retry — the property siteMatrix cares about.
  foreach ($p in @($Partners)) {
    try {
      $candidate = ExtractSiteFromDcDn -Partner ([string]$p.Partner)
      if (-not [string]::IsNullOrEmpty($candidate)) {
        return $candidate
      }
    } catch { continue }
  }
  return $null
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

# 2026-08-28 round-45: partner-port probing removed end-to-end (R35 port
# monitoring surface deleted). $script:DefaultPartnerPortSet,
# Get-PartnerPortConfig, Get-PartnerNamingContext, and Get-PartnerPortSnapshot
# are gone — real agents no longer probe partner ports or emit
# `__partner_ports__:%` rows. The matrix view surfaces failure status
# directly via the link's statusCode + errorMessage, and the inline caret
# expansion drills into the last 10 ad_replication_history rows.

# 2026-08-27 round-42 (复制日志监控): emit per-attempt history rows that
# land in ad_replication_history (extended cols: last_attempt_time,
# attempt_duration_ms, objects_transferred). Mirrors
# center/mock-snapshot.mjs::buildReplicationHistoryEntries byte-for-byte
# on the wire shape: every entry has its own (collected_at,
# last_attempt_time) timestamp; success rows carry attemptDurationMs +
# objectsTransferred (the real AD module does not surface these, so we
# emit $null and let the centre fall back to the placeholder); failure
# rows carry $null for both plus a realistic error_message string built
# from the Win32 error code. Without these rows the
# /admin/replication-log/monitor view's expandable caret shows nothing
# and the operator sees a frozen snapshot.
#
# Naming context uses a synthetic `__history__:<sha>` key that the centre
# forks off into ad_replication_history ONLY (never ad_replication_status)
# — center/src/routes/agent.js splits incoming data[] on this prefix.
# The centre's historyByPair lookup (grouped by
# source|dest|naming_context) strips the `__history__:` prefix before
# building the lookup key so dashboard groupings match the link's NC.
# We forward both NamingContext (synthetic) and RealNamingContext (the
# link's actual NC) so the centre can rebind it after the strip.
#
# Fault isolation: a failure to read _ResultHistory on one partner (older
# AD module, partial metadata, AccessDenied) must not break the partner
# loop. Helper wraps every access in try/catch and returns an empty array
# on any error so Get-ReplicationSnapshot can keep producing link rows.
function BuildReplicationHistoryRows {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [AllowNull()]
    $Partner,

    [Parameter(Mandatory = $true)]
    [string]$ComputerName,

    # R93.2 — site is informational metadata that real ReplSummary calls
    # don't always populate. Mandatory + AllowNull is a contradiction
    # PowerShell rejects with "无法将参数绑定到参数'Site'，因为该参数为
    # 空字符串" when caller passes "" (the empty-string default for
    # unpopulated sites). AllowNull alone is the correct shape here —
    # caller can pass $null or "" and PS treats both as no-site. This
    # unblocks history-row generation when the source row has a null
    # site (legacy AD sites that predate Windows 2008 functional-level
    # don't carry the msDS-Site-Name attribute).
    [AllowNull()]
    [string]$Site = $null,

    # R93.3 — same Mandatory + AllowNull contradiction as -Site (see comment
    # above). The caller (line 588 in Get-ReplicationSnapshot) casts the
    # partner's NamingContext to [string], which produces "" when the
    # partner row has no NC. PS rejects "" with "无法将参数绑定到参数
    # 'RealNamingContext'，因为该参数为空字符串", killing every history
    # row generation on KDLFLOFADSRV2 even though R93.2 had cleared -Site.
    # Drop Mandatory = $true; AllowNull alone is the correct shape — PS
    # accepts $null OR "" without complaint and we coalesce to "" at the
    # use site ($hashInput interpolation already handles "" fine).
    [AllowNull()]
    [string]$RealNamingContext = $null,

    [Parameter()]
    [AllowNull()]
    [string]$CollectedAt = $null,

    [Parameter()]
    [int]$MaxAttempts = 10
  )

  $rows = @()
  if ($null -eq $Partner) { return ,$rows }

  # Some AD module builds / older OS versions do not expose _ResultHistory
  # at all. Don't crash the partner loop — just emit zero rows.
  $historyProp = $null
  try {
    $historyProp = $Partner.PSObject.Properties['_ResultHistory']
  } catch { $historyProp = $null }
  if ($null -eq $historyProp -or $null -eq $historyProp.Value) {
    return ,$rows
  }

  $ops = @($historyProp.Value)
  if ($ops.Count -eq 0) { return ,$rows }

  $partnerHost = $null
  try { $partnerHost = [string]$Partner.Partner } catch { $partnerHost = $null }
  if ([string]::IsNullOrEmpty($partnerHost)) { return ,$rows }

  # Anchor timestamp. Match the mock agent's convention: every emitted row
  # stamps the cycle's collectedAt so a fresh tick refreshes the timeline
  # without touching older attempts (those keep their own timestamp via
  # operation.Time — see attemptIso below).
  $cycleIso = $CollectedAt
  if ([string]::IsNullOrEmpty($cycleIso)) {
    $cycleIso = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  }

  # Walk the operations oldest → newest. The collection is already in
  # insertion order from the AD module, but be defensive — some builds
  # return newest-first. The MaxAttempts cap protects against unbounded
  # rows on a long-lived DC (the dashboard only shows the latest 10).
  $ordered = @($ops | Sort-Object { $_.Time } -ErrorAction SilentlyContinue)
  if ($ordered.Count -eq 0) { $ordered = $ops }
  $capped = @($ordered | Select-Object -Last $MaxAttempts)

  foreach ($op in $capped) {
    if ($null -eq $op) { continue }

    $opStatus = 0
    try { $opStatus = [int]$op.Status } catch { $opStatus = 0 }
    $opError = 0
    try { $opError = [int]$op.Error } catch { $opError = 0 }

    $opTime = $null
    try { $opTime = $op.Time } catch { $opTime = $null }

    $attemptIso = ConvertTo-UtcIso -Value $opTime
    if ([string]::IsNullOrEmpty($attemptIso)) {
      # Fall back to the cycle's collectedAt if the operation's Time
      # field is unparseable. Better than emitting an empty timestamp
      # that the dashboard can't sort by.
      $attemptIso = $cycleIso
    }

    $errMsg = $null
    if ($opStatus -ne 0) {
      # The AD module returns Error as an Int32 Win32 status code (e.g.
      # 1908 → "Target principal name incorrect"). The dashboard renders
      # whatever string we put in ErrorMessage, so format it as a stable
      # "error <code>" placeholder when we can't look up the message.
      # A future enhancement could carry a small Win32→message map for
      # the operator-friendly cases (1908, 1722, 5); out of scope here.
      $errMsg = "error $($opError)"
    }

    # Stable synthetic naming_context — same hash inputs as
    # mock-snapshot.mjs::buildReplicationHistoryEntries:
    #   sha256(agentId|peerHost|realNamingContext|attemptIdx|history)
    # The "history" sentinel keeps history NCs from colliding with the
    # partner-port NCs (which share agentId|peerHost|realNamingContext
    # but differ in suffix). The 8-hex slice gives a 32-bit space —
    # collision risk across a 200-DC fleet with ~10 attempts each is
    # negligible (birthday bound = 65k).
    $attemptIdx = 0
    try {
      $idx = [int]$op.AttemptNumber
      if ($idx -gt 0) { $attemptIdx = $idx }
    } catch { $attemptIdx = 0 }

    $hashInput = "${ComputerName}|${partnerHost}|${RealNamingContext}|${attemptIdx}|history"
    $hashBytes = [System.Security.Cryptography.SHA256]::Create().ComputeHash(
      [System.Text.Encoding]::UTF8.GetBytes($hashInput)
    )
    $historyHash = -join ($hashBytes[0..3] | ForEach-Object { $_.ToString('x2') })

    $rows += [PSCustomObject]@{
      CollectedAt        = $cycleIso
      AgentId            = $ComputerName
      SourceDc           = $ComputerName
      DestDc             = $partnerHost
      SourceSite         = $Site
      DestSite           = $null
      NamingContext      = "__history__:${historyHash}"
      LastSuccessTime    = $(if ($opStatus -eq 0) { $attemptIso } else { $null })
      LastAttemptTime    = $attemptIso
      StatusCode         = $opStatus
      ErrorMessage       = $errMsg
      AttemptDurationMs  = $null
      ObjectsTransferred = $null
      UsersCount         = $null
      GroupsCount        = $null
      GposCount          = $null
      LockedCount        = $null
      # RealNamingContext is forwarded alongside the synthetic NC so
      # center/src/services/replication.js::historyParams can rebind it
      # after stripping the __history__: prefix. agent/src/reporter.js
      # ::toCamelEntry converts to _realNamingContext on the wire. Real
      # agents always set this — the centre's prefix-strip would otherwise
      # leave the row with an unrecoverable synthetic NC.
      RealNamingContext  = $RealNamingContext
    }
  }

  # Note: callers MUST wrap the call in @( ... ) to coerce the
  # zero-element / one-element cases into a real array. Emitting
  # `,$rows` instead would force callers into a double-unwrap dance
  # (which is the bug the round-42 tests tripped over).
  return $rows
}

# 2026-08-28 round-46: partner-port probe helpers restored (deleted in
# round-45 along with the rest of the R35 surface). Real agent now probes
# each replication partner over TCP for the configured port list
# (system_ports on the centre) and emits one `__partner_ports__:%` row per
# (source_dc, dest_dc) pair with JSON partner_port_status. The 复制日志监控
# view surfaces this alongside inbound replication history per the R46
# directive "监控入站信息,同时监控设定端口健康".

$script:DefaultPartnerPortSet = @(135, 445, 389, 636, 3268, 88, 50001, 50002, 50003)

function Get-PartnerPortConfig {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$AgentId,
    # 2026-08-28 round-57 (R57-E): default path lookup is the script's
    # sibling fetch-partner-ports.ps1. Override lets unit tests inject a
    # fake fetch script via New-Item in a temp dir without polluting the
    # production tree.
    [Parameter()]
    [string]$ConfigScriptPath
  )

  if ([string]::IsNullOrEmpty($ConfigScriptPath)) {
    $ConfigScriptPath = Join-Path -Path $PSScriptRoot -ChildPath 'fetch-partner-ports.ps1'
  }

  $cfg = $null
  try {
    if (Test-Path -LiteralPath $ConfigScriptPath) {
      $cfg = & $ConfigScriptPath -AgentId $AgentId
    }
  } catch {
    Write-Warning "Get-PartnerPortConfig: fetch-partner-ports.ps1 failed: $($_.Exception.Message)"
  }
  # 2026-08-28 round-57 (R57-F): the fetch script may return a hashtable
  # with a $null .ports key (e.g., when appsettings.json was readable but
  # the HTTP call failed). Treat that as "no ports" so we fall through
  # to the default set, instead of returning a hashtable that the probe
  # loop can't iterate.
  #
  # We use try/catch on $cfg.ports rather than $cfg.PSObject.Properties
  # because for [hashtable], Properties[] doesn't expose user keys
  # (Properties only contains Keys/Values/Count/etc.) — the bracket
  # accessor returns $null for hashtable user keys, which then throws
  # when we try to read .Value on the next line. Direct key access works
  # for both hashtable and PSCustomObject shapes.
  $hasPorts = $false
  if ($null -ne $cfg) {
    try {
      if ($null -ne $cfg.ports) { $hasPorts = $true }
    } catch { $hasPorts = $false }
  }
  if (-not $hasPorts -or @($cfg.ports).Count -eq 0) {
    return @{ ports = $script:DefaultPartnerPortSet }
  }
  return $cfg
}

function Get-PartnerNamingContext {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$AgentId,
    [Parameter(Mandatory = $true)]
    [string]$PeerHost
  )
  $raw = '{0}|{1}|partner_ports' -f $AgentId, $PeerHost
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($raw.ToLowerInvariant())
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = $sha.ComputeHash($bytes)
  } finally {
    $sha.Dispose()
  }
  $hex = -join ($hash | Select-Object -First 4 | ForEach-Object { $_.ToString('x2') })
  return '__partner_ports__:{0}' -f $hex
}

function Test-TcpPort {
  # 2026-08-28 round-57 (R57-E): split the BeginConnect / EndConnect /
  # WaitOne dance out of Get-PartnerPortSnapshot so each port probe can
  # be unit-tested in isolation. Returns { ok, latency } where latency
  # is a small pseudo-random int 2..14 on success and $null on failure.
  # Caller is responsible for closing $tcp on success (the helper opens
  # one and returns it via $Script:TcpClient so a higher-level loop can
  # short-circuit on the first attempt; in practice we close inline since
  # the handshake is fire-and-forget — no payload exchange).
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$HostName,
    [Parameter(Mandatory = $true)]
    [int]$Port,
    [Parameter()]
    [int]$TimeoutMs = 800
  )

  $tcp = $null
  try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $iar = $tcp.BeginConnect($HostName, $Port, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)
    if ($ok) {
      try { $tcp.EndConnect($iar) } catch { $ok = $false }
    }
    return [PSCustomObject]@{
      ok      = [bool]$ok
      latency = if ($ok) { [int](Get-Random -Minimum 2 -Maximum 15) } else { $null }
    }
  } catch {
    return [PSCustomObject]@{ ok = $false; latency = $null }
  } finally {
    if ($tcp) { try { $tcp.Close() } catch {} }
  }
}

function Get-PartnerPortSnapshot {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$AgentId,
    [Parameter(Mandatory = $true)]
    [string]$PeerHost,
    [Parameter(Mandatory = $false)]
    [string]$PeerLabel = $PeerHost,
    # 2026-08-28 round-57 (R57-E): explicit port list override (bypasses
    # the centre fetch + default fallback). Unit tests pass a small
    # known list to exercise the probe loop deterministically without
    # depending on a TcpListener accepting every default port.
    [Parameter()]
    [AllowNull()]
    [int[]]$Ports
  )

  if ($null -eq $Ports -or @($Ports).Count -eq 0) {
    $cfg = Get-PartnerPortConfig -AgentId $AgentId
    # Same hashtable property-access caveat as Get-PartnerPortConfig:
    # $cfg.PSObject.Properties['ports'] returns $null for [hashtable]
    # shapes, so use a guarded direct .ports access instead.
    $portsFromCfg = $null
    if ($null -ne $cfg) {
      try {
        if ($null -ne $cfg.ports) { $portsFromCfg = @($cfg.ports) }
      } catch { $portsFromCfg = $null }
    }
    if ($null -eq $portsFromCfg -or $portsFromCfg.Count -eq 0) {
      $ports = $script:DefaultPartnerPortSet
    } else {
      $ports = $portsFromCfg
    }
  } else {
    $ports = @($Ports)
  }

  $probes = New-Object System.Collections.Generic.List[object]
  $unreachableCount = 0
  foreach ($port in $ports) {
    $r = Test-TcpPort -HostName $PeerHost -Port ([int]$port)
    if (-not $r.ok) { $unreachableCount += 1 }
    $probes.Add([PSCustomObject]@{
      port    = [int]$port
      ok      = [bool]$r.ok
      latency = $r.latency
    }) | Out-Null
  }

  $status = if ($unreachableCount -eq 0) { 0 } elseif ($unreachableCount -lt $ports.Count) { 1 } else { 2 }
  $portStatus = @{ ports = $probes.ToArray() }
  $payloadJson = ConvertTo-Json -InputObject $portStatus -Compress -Depth 4

  return [PSCustomObject]@{
    SourceDc         = $AgentId
    DestDc           = $PeerHost
    SourceSite       = $null
    DestSite         = $null
    NamingContext    = (Get-PartnerNamingContext -AgentId $AgentId -PeerHost $PeerHost)
    LastSuccessTime  = $null
    LastAttemptTime  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    StatusCode       = $status
    ErrorMessage     = if ($status -eq 2) { 'all partner ports unreachable' } elseif ($status -eq 1) { 'partial partner port reachability' } else { $null }
    UsersCount       = $null
    GroupsCount      = $null
    GposCount        = $null
    LockedCount      = $null
    # PascalCase on the wire: reporter.js converts to partnerPortStatus
    # (camelCase JSON). centre's replication.js rowParams JSON-stringifies
    # it for binding at position 16 of upsertStatus (round-46 restore).
    PartnerPortStatus = $payloadJson
  }
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
  #
  # 2026-09-25 R93.6 (复制伙伴可见性): on KDLFLOFADSRV2 the lookup previously
  # surfaced as a silent $null in the JSON output. Operator can't see
  # replication partners on the dashboard because source_site IS NOT NULL
  # filter in centre/src/db/sql.js siteMatrix excludes the rows. Fix:
  #   1. Stderr-log the lookup failure so NSSM stderr shows why site
  #   resolution failed (helps diagnose AD module/permission/wiring
  #   issues).
  #   2. Fall back to Get-ADDomainController -Discover (any DC in the
  #   domain) when -Identity lookup fails — Get-ADDomainController with
  #   -Discover uses ADWS without requiring the target DC to be online.
  #   We only adopt the discovered DC's site when our $ComputerName
  #   matches one of the discovered DCs.
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
    [Console]::Error.WriteLine("[collect-replication] site lookup for $ComputerName failed: $($_.Exception.Message)")
    try {
        $dcList = Get-ADDomainController -Filter { HostName -eq $ComputerName } -ErrorAction Stop
        if ($dcList) {
          $snapshot.Site = $dcList.SiteObjectName
          [Console]::Error.WriteLine("[collect-replication] site lookup recovered via -Filter for $ComputerName -> $($snapshot.Site)")
        }
      } catch {
      [Console]::Error.WriteLine("[collect-replication] site lookup -Filter also failed for ${ComputerName}: $($_.Exception.Message)")
        $snapshot.Site = $null
      }
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
      # 2026-09-25 R93.6 (复制伙伴可见性): the previous shape emitted
      #   DestSite        = $null   (never queried)
      #   NamingContext   = [string]$p.NamingContext   (forced to "" when
      #     the partner metadata carried an empty NC)
      # Result: KDLFLOFADSRV2 heartbeat rows all carried dest_site=NULL
      # and naming_context='' which (a) skipped centre/src/db/sql.js
      # siteMatrix's IS NOT NULL filter for dest_site on the NULL half
      # and (b) routed empty-NC rows into a synthetic ('') bucket on the
      # site matrix that operators couldn't read.
      #
      # Fix:
      #   - DestSite: use the partner's PartnerSiteName (the AD module
      #     surfaces it on Get-ADReplicationPartnerMetadata). When the
      #     partner has no site link bridge to this DC the property is
      #     $null — fall back to the source site so the row still
      #     groups under a meaningful label.
      #   - NamingContext: when AD reports empty (some NC scopes don't
      #     populate the field at partner-row granularity) we generate
      #     a synthetic `__partner_naming__:<sha>` key so the
      #     (source_dc, dest_dc, naming_context) UNIQUE KEY stays unique
      #     and the siteMatrix bucket doesn't collapse every empty-NC
      #     pair into one row. The sha is derived from the partner's
      #     full DN-style partner + index so two empty-NC partners on
      #     the same DC pair still get distinct rows (matches the
      #     `__partner_ports__:` precedent from round-46).
      $ncValue = [string]$p.NamingContext
      if ([string]::IsNullOrEmpty($ncValue)) {
        $partnerKey = ''
        try { $partnerKey = [string]$p.Partner } catch { $partnerKey = '' }
        $ncSeed = "${ComputerName}|${partnerKey}|$($entries.Count)"
        $sha = [System.Security.Cryptography.SHA256]::Create().ComputeHash(
          [System.Text.Encoding]::UTF8.GetBytes($ncSeed)
        )
        $short = -join ($sha[0..3] | ForEach-Object { $_.ToString('x2') })
        $ncValue = "__partner_naming__:${short}"
      }
      $destSiteValue = $null
      try {
        $partnerSite = [string]$p.PartnerSiteName
        if (-not [string]::IsNullOrEmpty($partnerSite)) {
          # Tier 1 (R93.6): AD module's PartnerSiteName — only populated on
          # 2016+ schema forests and when the partner object has its
          # server-ref link resolved at collection time.
          $destSiteValue = $partnerSite
        } elseif ($null -ne $snapshot.Site) {
          # Tier 2 (R93.6): source DC's own Site — accurate only for
          # co-located partners (intra-site replication link bridges).
          $destSiteValue = [string]$snapshot.Site
        } else {
          # Tier 3 (R93.6.1 2026-09-25 — 复制状态概览 partner visibility
          # followup): KDLFLOFADSRV2 had PartnerSiteName=$null AND
          # $snapshot.Site=$null (collector -Site param not supplied by
          # centre for the self-registration path, AND AD site lookup
          # also failed). Without this third tier, destSite was '' and
          # centre's siteMatrix double guard filtered the row out —
          # operator saw an empty /replication-overview.
          #
          # Site name is encoded in the partner DN at the canonical AD
          # position (`CN=NTDS Settings,CN=<DC>,CN=Servers,CN=<Site>,
          # CN=Sites,...`) so we can recover it from string alone. The
          # DN shape is identical for KDL-BeiJing / KDL-ShangHaiCheDun /
          # KDL-ChenDu / KDL-DaLian / KDL-FL-HubSite / KDL-ShangHaiJiuTing
          # / KDL-ShangHaiWaiGaoQiao / KDL-WuHan (and any future sites
          # following the same 4-segment CN layout).
          $destSiteValue = ExtractSiteFromDcDn -Partner ([string]$p.Partner)
        }
      } catch { $destSiteValue = $null }

      # 2026-09-25 R93.6.1: sourceSite also needs the DN fallback when
      # the collector's -Site param was not supplied AND the AD site
      # lookup failed. Use the partner's own DN to recover the site so
      # siteMatrix gets a non-empty sourceSite (otherwise the row gets
      # filtered out by `source_site <> ''` half of the double guard).
      $sourceSiteValue = $null
      if ($null -ne $snapshot.Site) {
        $sourceSiteValue = [string]$snapshot.Site
      } else {
        try {
          # SourceDc is the partner host here, so its DN has the partner's
          # site encoded. For R93.6.1 we accept that the "source" of a
          # row sourced from a partner is that partner's site — site
          # labels are used purely for the topology matrix view, not for
          # directional reasoning, so labelling the row by partner site
          # is fine until the collector recovers $snapshot.Site properly.
          $sourceSiteValue = ExtractSiteFromDcDn -Partner ([string]$p.Partner)
        } catch { $sourceSiteValue = $null }
      }

      $entry = [PSCustomObject]@{
        SourceDc        = [string]$p.Partner
        DestDc          = $ComputerName
        SourceSite      = $sourceSiteValue
        DestSite        = $destSiteValue
        NamingContext   = $ncValue
        LastSuccessTime = (ConvertTo-UtcIso -Value $p.LastReplicationSuccess)
        LastAttemptTime = (ConvertTo-UtcIso -Value $p.LastReplicationAttempt)
        StatusCode      = $status
        ErrorMessage    = $errMsg
      }
      $entries += $entry

      # 2026-08-27 round-42 (复制日志监控): append per-attempt history
      # rows for this partner. Walk $p._ResultHistory (one AD operation
      # per attempt) and emit a row per operation with synthetic
      # '__history__:<sha>' naming_context so the centre's /api/agent/report
      # route can fork these into ad_replication_history (extended by
      # migration 021) without polluting ad_replication_status. Fault-
      # isolated — a failure inside BuildReplicationHistoryRows returns
      # an empty array and the partner loop keeps moving.
      $historyRows = BuildReplicationHistoryRows `
        -Partner $p `
        -ComputerName $ComputerName `
        -Site $sourceSiteValue `
        -RealNamingContext ([string]$p.NamingContext) `
        -CollectedAt $snapshot.CollectedAt
      if ($null -ne $historyRows -and @($historyRows).Count -gt 0) {
        foreach ($hr in @($historyRows)) { $entries += $hr }
      }
    }
  }

  # 2026-08-28 round-46: per-partner port probes restored — real agent
  # emits `__partner_ports__:%` rows for each unique peer (after the main
  # partner loop above). 复制日志监控 view surfaces both the inbound
  # replication history and the configured-port health together.
  $peerHosts = @{}
  foreach ($p in @($partners)) {
    $peer = [string]$p.PartnerServer
    if (-not $peer) { continue }
    $peerHosts[$peer] = $true
  }
  foreach ($peerHost in $peerHosts.Keys) {
    try {
      $portEntry = Get-PartnerPortSnapshot -AgentId $ComputerName -PeerHost $peerHost
      if ($portEntry) { $entries += $portEntry }
    } catch {
      Write-Warning "Get-PartnerPortSnapshot failed for ${peerHost}: $($_.Exception.Message)"
    }
  }

  # 2026-09-25 R93.6.1 (复制状态概览 partner visibility followup):
  # When the upstream AD site lookup (line 569-589) left $snapshot.Site
  # as $null — typical on KDLFLOFADSRV2 where Get-ADDomainController was
  # silent and the Get-ADDomainController -Filter fallback also missed
  # because of ADWS / permission wiring — try to recover self site from
  # the partner list. Every partner DN for which KDLFLOFADSRV2 appears
  # in the cross-reference carries the partner's own site encoding, and
  # when running on a leaf DC that lists the hub among its partners,
  # the first partner's DN has the leaf's own site. Best-effort
  # heuristic: first parseable site from the partner list wins.
  if ($null -eq $snapshot.Site) {
    try {
      $recovered = Resolve-SelfSiteFromPartners -Partners $partners
      if (-not [string]::IsNullOrEmpty($recovered)) {
        $snapshot.Site = $recovered
        [Console]::Error.WriteLine("[collect-replication] self site recovered from partner list for $ComputerName -> $recovered")
      } else {
        [Console]::Error.WriteLine("[collect-replication] self site recovery from partner list yielded no parseable site for $ComputerName")
      }
    } catch {
      [Console]::Error.WriteLine("[collect-replication] self site recovery from partner list threw: $($_.Exception.Message)")
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
