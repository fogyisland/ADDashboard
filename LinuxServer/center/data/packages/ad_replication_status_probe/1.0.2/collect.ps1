# collect.ps1 - ad_replication_status_probe v1.0.2 (R158.15.2 / 2026-10-01)
#
# 15min cadence probe. Reads Get-ADReplicationPartnerMetadata (canonical
# RSAT cmdlet for "per (partner x NC) replication health") -- already in
# daily use by ad_partner_inbound_discover 1.1.5. Each returned row is
# one (peer DC, naming_context) tuple; we record LastReplicationSuccess /
# ConsecutiveFailureCount / LastReplicationAttempt + classify the row as
# success/error/partial for the v_partner_inbound view's 15-min probe_state.
# measure the attempt duration via Stopwatch. Emits one envelope with
# metrics.probes[] -- one entry per (peer, naming_context) tuple.
# Centre post-hook appends each row to ad_replication_probe_history.
#
# Pure ASCII (R158.11.4 lesson): no Chinese anywhere. All comments,
# Write-Warning messages, and ConvertTo-Json field names are 7-bit clean.
#
# Peer source priority:
#   1. Centre GET /api/agent/inbound-partners-warehouse -- reads
#      ad_dc_inbound_partners (R155.6 5-min centre refresh).
#      One row per (local_dc, peer_dc, naming_context); caller
#      dedupes peer_dc for the probe loop.
#   2. Fallback: Get-ADReplicationPartnerMetadata -Target $env:COMPUTERNAME
#      -PartnerType Inbound (R158.11.5 pattern, used when the centre
#      endpoint is unreachable).
#
# Wire shape (matches centre src/services/replication-status-probe.js
# upsertProbes expectations):
#   {
#     metrics: {
#       agent_id:    <string>,
#       collected_at: <iso8601 utc>,
#       probes: [
#         {
#           source_dc:           <string>,
#           dest_dc:             <string>,
#           naming_context:      <string>,
#           attempt_at:          <iso8601 utc>,
#           result:              <'success' | 'error'>,
#           status_code:         <int 0|2>,
#           duration_ms:         <int|null>,
#           objects_transferred: <int|null>,
#           error_code:          <int|null>,
#           error_message:       <string|null>
#         }
#       ]
#     }
#   }
#
# Cadence: every 15 minutes (manifest.agent.intervalSec = 900).
#
# Best-effort fallbacks:
#   - $env:DASHBOARD_CENTER_PORT missing -> exit 0, peers=[] (post-hook skips)
#   - Centre endpoint unreachable -> fallback to Get-ADReplicationPartnerMetadata
#   - Get-ADReplicationFailure throw per peer -> one __probe_error__ row,
#     peer loop continues (no crash)
#   - $env:DASHBOARD_AGENT_TOKEN missing -> no auth header (centre rejects
#     but PS still emits; post-hook drops)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8   # R136

$server       = $env:COMPUTERNAME
$collectedAt  = (Get-Date).ToUniversalTime().ToString('o')

# R158.15.1 (2026-10-01) -- resolve centre base URL without depending on
# DASHBOARD_CENTER_PORT. Older agent bundles (R93.7 / pre-R158.15) do not
# inject that env var, so $centerPort would be $null and the script would
# silently no-op with peers=[]. Priority:
#   1. DASHBOARD_CENTER_PORT (R158.15+ agent bundle).
#   2. CENTER_URL (R93.9+ agent bundle, always injected; rewritten to
#      "<host>:8081" by package-manager so it points at the heartbeat app).
#   3. Hard-coded localhost fallback (single-box deploy).
$centerPort = $env:DASHBOARD_CENTER_PORT
if ([string]::IsNullOrWhiteSpace($centerPort) -and -not [string]::IsNullOrWhiteSpace($env:CENTER_URL)) {
  $m = [regex]::Match($env:CENTER_URL, ':(\d+)$')
  if ($m) { $centerPort = $m.Groups[1].Value }
}
if ([string]::IsNullOrWhiteSpace($centerPort)) { $centerPort = '8081' }
$centerBase   = "http://127.0.0.1:${centerPort}"
$probeEntries = @()

# Step 1: fetch partner list from centre warehouse (R155.6).
$peerList = @()
try {
  $headers = @{ 'X-Agent-Id' = $server }
  if (-not [string]::IsNullOrWhiteSpace($env:DASHBOARD_AGENT_TOKEN)) {
    $headers['X-Agent-Token'] = $env:DASHBOARD_AGENT_TOKEN
  }
  $resp = Invoke-RestMethod -Method GET `
           -Uri "${centerBase}/api/agent/inbound-partners-warehouse" `
           -Headers $headers -TimeoutSec 10
  $peerList = @($resp.peers)
  Write-Warning ("ad_replication_status_probe v1.0.0: warehouse peerList.count=" + $peerList.Count)
} catch {
  Write-Warning ("ad_replication_status_probe v1.0.0: warehouse endpoint failed: " + $_.Exception.Message + "; falling back to Get-ADReplicationPartnerMetadata")
  $peerList = @()
  try {
    $partners = Get-ADReplicationPartnerMetadata -Target $server -PartnerType Inbound -ErrorAction Stop
    foreach ($p in @($partners)) {
      $partnerDn = [string]$p.Partner
      if ($partnerDn -match '(?i)CN=NTDS Settings,CN=([^,]+),') {
        $peerDc = $matches[1]
        if ($peerDc -ine $server) { $peerList += [pscustomobject]@{ peerDc = $peerDc } }
      }
    }
  } catch {
    Write-Warning ("ad_replication_status_probe v1.0.0: fallback cmdlet failed: " + $_.Exception.Message)
  }
}

# Step 2: probe every (peer, NC) tuple via Get-ADReplicationPartnerMetadata.
# R158.15.2 (2026-10-01) -- pivot from Get-ADReplicationFailure (which has
# no -Partner parameter and only surfaces replication *failures* across the
# whole DC) to Get-ADReplicationPartnerMetadata, which is the canonical
# RSAT cmdlet for "per (partner x NC) replication health" and is already in
# daily use by ad_partner_inbound_discover 1.1.5. Each returned row is one
# (peer DC, naming_context) tuple; we record LastReplicationSuccess /
# ConsecutiveFailureCount / LastReplicationAttempt + classify the row as
# success/error/healthy for the v_partner_inbound view's 15-min probe_state.
#
# Health rule (one-line per NC):
#   success     -- LastReplicationSuccess within last 7 days AND
#                  ConsecutiveFailureCount == 0.
#   error       -- ConsecutiveFailureCount > 0  (cluster is failing right
#                  now; operator needs to inspect).
#   partial     -- LastReplicationSuccess within 7 days BUT FailureCount>0
#                  historically, or LastReplicationSuccess is older than 7
#                  days (stale but not actively failing).
#
# We drop the centre peer-list fetch loop here -- Get-ADReplicationPartnerMetadata
# already enumerates the (peer, NC) tuples the cmdlet can see, which is the
# authoritative source. The earlier centre /api/agent/inbound-partners-warehouse
# endpoint stays in Step 1 only as a soft log ("how does the centre view
# this peer set"); the actual probe entries are derived from the cmdlet.
$probeSw = [System.Diagnostics.Stopwatch]::StartNew()
$cmdletAttemptAt = (Get-Date).ToUniversalTime().ToString('o')
$cmdletRows = @()
$cmdletError = $null
try {
  $cmdletRows = @(Get-ADReplicationPartnerMetadata -Target $server -PartnerType Inbound -ErrorAction Stop)
} catch {
  $cmdletError = $_.Exception.Message
}
$probeSw.Stop()
$cmdletDurationMs = [int]$probeSw.ElapsedMilliseconds

if ($cmdletError) {
  $errText = ("Get-ADReplicationPartnerMetadata: " + $cmdletError)
  if ($errText.Length -gt 512) { $errText = $errText.Substring(0, 512) }
  $probeEntries += @{
    source_dc           = $server
    dest_dc             = '__probe_error__'
    naming_context      = '__probe_error__'
    attempt_at          = $cmdletAttemptAt
    result              = 'error'
    status_code         = 2
    duration_ms         = $cmdletDurationMs
    objects_transferred = $null
    error_code          = -1
    error_message       = $errText
  }
} else {
  foreach ($row in $cmdletRows) {
    $peerDn  = [string]$row.Partner
    $peerDc  = $null
    if ($peerDn -match '(?i)CN=NTDS Settings,CN=([^,]+),') { $peerDc = $matches[1] }
    if ([string]::IsNullOrWhiteSpace($peerDc)) { continue }   # DN shape mismatch
    if ($peerDc -ieq $server) { continue }                     # skip self
    $ncName = [string]$row.NamingContext
    if ([string]::IsNullOrWhiteSpace($ncName)) { $ncName = 'CN=Configuration,DC=default' }

    # Pull health signals with try/catch per field -- some RSAT builds omit
    # fields, especially on freshly-promoted DCs.
    $lastSuccess  = $null
    $lastAttempt  = $null
    $consecFail   = 0
    $failCount    = 0
    try { $lastSuccess = $row.LastReplicationSuccess } catch { $lastSuccess = $null }
    try { $lastAttempt = $row.LastReplicationAttempt } catch { $lastAttempt = $null }
    try { $consecFail  = [int]$row.ConsecutiveFailureCount } catch { $consecFail = 0 }
    try { $failCount   = [int]$row.FailureCount }            catch { $failCount  = 0 }

    # Classify health per the rule above.
    $nowUtc  = (Get-Date).ToUniversalTime()
    $staleDays = 7
    $healthy   = $false
    $errLevel  = $false
    $partial   = $false
    $errMsg    = $null
    if ($consecFail -gt 0) {
      $errLevel = $true
      $errMsg   = ("ConsecutiveFailureCount=" + $consecFail)
    } elseif ($lastSuccess -and ($nowUtc - $lastSuccess).TotalDays -le $staleDays) {
      $healthy = $true
    } elseif (-not $lastSuccess) {
      $partial = $true
      $errMsg  = 'LastReplicationSuccess missing'
    } else {
      $partial = $true
      $days = [int](($nowUtc - $lastSuccess).TotalDays)
      $errMsg = ("LastReplicationSuccess older than " + $staleDays + " days (" + $days + ")")
    }

    if ($errLevel) {
      $result = 'error'; $statusCode = 2
    } elseif ($healthy) {
      $result = 'success'; $statusCode = 0
    } else {
      $result = 'partial'; $statusCode = 1
    }

    $probeEntries += @{
      source_dc           = $server
      dest_dc             = $peerDc
      naming_context      = $ncName
      attempt_at          = $cmdletAttemptAt
      result              = $result
      status_code         = $statusCode
      duration_ms         = $cmdletDurationMs
      objects_transferred = $failCount
      error_code          = $(if ($errLevel) { $consecFail } else { $null })
      error_message       = $errMsg
    }
  }
}

# Step 3: emit wire shape.
$payload = @{
  metrics = @{
    agent_id     = $server
    collected_at = $collectedAt
    probes       = $probeEntries
  }
}
$payload | ConvertTo-Json -Compress -Depth 6
exit 0
