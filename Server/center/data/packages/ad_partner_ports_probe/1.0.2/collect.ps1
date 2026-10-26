# collect.ps1 - ad_partner_ports_probe v1 (R93.11)
#
# For every replication peer (resolved locally via
# Get-ADReplicationPartnerMetadata -Target $env:COMPUTERNAME, matching
# the real-agent's collect-replication.ps1:669 pattern), probes every
# system port (resolved through centre GET /api/agent/ports) via a
# TcpClient BeginConnect with a 2000ms timeout, recording latency in
# milliseconds.
#
# Output JSON shape (matches center/src/services/partner-port-probe.js
# normalizePartnerProbe expectations):
#   {
#     metrics: {
#       agent_id:    <string>,            # $env:COMPUTERNAME
#       collected_at: <iso8601 utc>,
#       peers: [                         # one entry per peer DC
#         {
#           destDc: <string>,
#           ports: [                     # one entry per system port
#             { port: <int>, ok: <bool>, latency: <int|null> }
#           ]
#         }
#       ]
#     }
#   }
#
# Cadence: every 15 minutes (manifest.agent.intervalSec = 900). Independent
# of the replication cycle so port health stays fresh even when replication
# is broken — this is the architecture reason for separating port probes
# from the regular replication probe.
#
# Best-effort fallbacks:
#   - $env:CENTER_URL missing → emit { metrics: { agent_id, peers: [] } }
#     and exit 0 (centre post-hook will skip).
#   - GET /api/agent/ports fails → $ports = @()
#   - Get-ADReplicationPartnerMetadata fails → $peers = @()
#   - any single (peer × port) probe failure → ok=false, latency=null;
#     remaining probes continue.
#
# Real-agent swap (operator directive: "代码一定要紧贴实际的agent"):
# The TcpClient.BeginConnect + Stopwatch probe matches the real-agent
# collect-replication.ps1 Get-PartnerPortSnapshot pattern.
# R93.11 — peer list source switched from centre's
# /api/agent/replication-partners to local
# Get-ADReplicationPartnerMetadata (same cmdlet the real-agent uses at
# collect-replication.ps1:669). The centre-side derivation was always
# empty on freshly-installed agents (ad_replication_status starts
# empty); the AD cmdlet is the authoritative source and is independent
# of centre's data plane.

$ErrorActionPreference = 'Continue'

$server = $env:COMPUTERNAME
$collectedAt = (Get-Date).ToUniversalTime().ToString('o')

$centerUrl = $env:CENTER_URL
if ([string]::IsNullOrWhiteSpace($centerUrl)) {
  # Best-effort fallback: centre has no URL to fetch port list from.
  # Centre post-hook will see peers:[] and skip. Don't surface this as
  # an error — the agent's PackageManager will log the missing env
  # var on its side.
  $payload = @{ metrics = @{ agent_id = $server; collected_at = $collectedAt; peers = @() } }
  $payload | ConvertTo-Json -Compress -Depth 4
  exit 0
}

$agentToken     = $env:AGENT_AUTH_TOKEN
$agentSignature = $env:AGENT_AUTH_SIGNATURE
$agentHostname  = $env:AGENT_HOSTNAME
$agentAgentId   = $env:AGENT_AGENT_ID

$headers = @{
  'X-Agent-Token'     = [string]$agentToken
  'X-Agent-Signature' = [string]$agentSignature
  'X-Agent-Id'        = [string]$agentAgentId
  'X-Agent-Hostname'  = [string]$agentHostname
}

# 1. Port list — configured system ports (admin-managed via /admin/ports).
# Bounded list, used as the row-key dimension in the partner_port_status JSON.
$ports = @()
try {
  $portsResp = Invoke-RestMethod -Method GET -Headers $headers -Uri "$centerUrl/api/agent/ports"
  if ($portsResp -is [System.Array]) {
    $ports = $portsResp
  } elseif ($portsResp -and $portsResp.PSObject.Properties['port']) {
    # /api/agent/ports on the heartbeat mount returns a raw array. The
    # partner-ports alias returns { ports: [...] }. Accept both shapes.
    $ports = @($portsResp)
  } elseif ($portsResp -and $portsResp.ports) {
    $ports = @($portsResp.ports)
  }
} catch {
  Write-Error "ad_partner_ports_probe: fetch port list failed: $($_.Exception.Message)"
  $ports = @()
}

# 2. Peer list — resolved locally via Get-ADReplicationPartnerMetadata
# (real-agent collect-replication.ps1:669 pattern). The previous R125
# version pulled this from centre's /api/agent/replication-partners but
# that endpoint derives peers from ad_replication_status latest-per-pair,
# which is empty on a freshly-installed agent or after a DB reset —
# so it always returns {"partners":[]} and the probe ships empty peers
# regardless of what the agent actually sees on the wire. The AD cmdlet
# is the authoritative source for "this DC's partners right now" and is
# what the rest of the agent already trusts.
$peers = @()
try {
  $partnerMeta = Get-ADReplicationPartnerMetadata -Target $env:COMPUTERNAME -ErrorAction Stop
  foreach ($p in @($partnerMeta)) {
    $raw = [string]$p.Partner
    if ([string]::IsNullOrWhiteSpace($raw)) { continue }
    # Canonical DN shape: CN=NTDS Settings,CN=<DCName>,CN=Servers,...
    # Older AD modules return bare names. Normalise to bare DC so the
    # downstream TcpClient.BeginConnect gets a resolvable hostname.
    $destDc = $null
    if ($raw -match '(?i)^CN=NTDS Settings,\s*CN=([^,]+),') {
      $destDc = $matches[1].Trim()
    } elseif ($raw -notmatch '(?i)CN=') {
      $destDc = $raw.Trim()
    }
    if ($destDc) { $peers += @{ destDc = $destDc } }
  }
} catch {
  Write-Error "ad_partner_ports_probe: Get-ADReplicationPartnerMetadata failed: $($_.Exception.Message)"
  $peers = @()
}

# 3. Probe each (peer × port). TcpClient.BeginConnect + AsyncWaitHandle
# WaitOne(2000ms) — matches the real-agent's Get-PartnerPortSnapshot.
# Latency measures the connect attempt only (start stopwatch before
# BeginConnect, stop after EndConnect; the underlying TCP handshake
# completes the moment EndConnect returns).
$peersPayload = @()
foreach ($peer in $peers) {
  $destDc = $peer.destDc
  if ([string]::IsNullOrWhiteSpace($destDc)) { continue }
  $portResults = @()
  foreach ($port in $ports) {
    $portNum = $null
    try { $portNum = [int]$port.port } catch {}
    if (-not $portNum -or $portNum -le 0) {
      $portResults += @{ port = $portNum; ok = $false; latency = $null }
      continue
    }
    $client = New-Object System.Net.Sockets.TcpClient
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $ar = $client.BeginConnect($destDc, $portNum, $null, $null)
    $completed = $ar.AsyncWaitHandle.WaitOne(2000, $false)
    $latencyMs = $null
    $ok = $false
    if ($completed) {
      try {
        $client.EndConnect($ar)
        $sw.Stop()
        $ok = $true
        $latencyMs = [int]$sw.ElapsedMilliseconds
      } catch {
        $sw.Stop()
        $ok = $false
        $latencyMs = $null
      }
      try { $client.Close() } catch {}
    } else {
      $sw.Stop()
      try { $client.Close() } catch {}
      $ok = $false
      $latencyMs = $null
    }
    $portResults += @{ port = $portNum; ok = $ok; latency = $latencyMs }
  }
  $peersPayload += @{ destDc = $destDc; ports = $portResults }
}

$metrics = @{
  agent_id     = $server
  collected_at = $collectedAt
  peers        = @($peersPayload)
}
$payload = @{ metrics = $metrics }
# 2026-09-28 R93.12 — -Depth 4 too shallow: the {port, ok, latency} hashtable
# sits at JSON tree depth 5 (metrics→peers[0]→ports[0]→{port,ok,latency}).
# With -Depth 4 PowerShell enumerates the hashtable instead of recursing into
# its properties, so each port entry serialised as the literal string
# "System.Collections.Hashtable" — centre rejected the row and the row went
# in as NULL/garbage. -Depth 8 reaches the leaf properties reliably.
$payload | ConvertTo-Json -Compress -Depth 8
exit 0