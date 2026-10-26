# collect.ps1 - ad_dc_probe_inbound v1.0.0 (R155.3 / 2026-09-30)
#
# For every replication peer returned by the centre's
# /api/agent/inbound-partners endpoint, probes every system port
# (resolved through centre GET /api/agent/ports) via a TcpClient
# BeginConnect with a 2000ms timeout, recording latency in
# milliseconds.
#
# R155.3 rename: this package is byte-identical to
# ad_partner_ports_probe 1.0.3 except for the manifest name/version.
# The data plane, wire shape, and centre post-hook are unchanged —
# the row (source_dc=agent, dest_dc=peer, naming_context='__partner_ports__:<hash>')
# is read by BOTH the /partner-port-health/inbound and /partner-port-health/outbound
# dashboard endpoints, which swap the anchor (source_dc vs dest_dc) to render
# the operator's two views from the SAME physical rows.
#
# Peer source priority (R151.2 operator directive:
# "可以增加一个端口探测，也就是提交本地的agentid 然后端点返回
#  inbound partner,这样探测才是最准确的"):
#   1. Centre GET /api/agent/inbound-partners — returns the list of DCs
#      that replicated TO this host in the last 30 minutes, computed by
#      the centre from ad_replication_status (dest_dc = agentId,
#      source_dc = peer DC).
#
# Wire shape (matches centre src/services/partner-port-probe.js
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
# is broken.
#
# Best-effort fallbacks:
#   - $env:CENTER_URL missing → emit { metrics: { agent_id, peers: [] } }
#     and exit 0 (centre post-hook will skip).
#   - GET /api/agent/ports fails → $ports = @()
#   - GET /api/agent/inbound-partners fails → $peers = @(), exit 0
#     (no probe to run).
#   - any single (peer × port) probe failure → ok=false, latency=null;
#     remaining probes continue.

$ErrorActionPreference = 'Continue'

$server = $env:COMPUTERNAME
$collectedAt = (Get-Date).ToUniversalTime().ToString('o')

$centerUrl = $env:CENTER_URL
if ([string]::IsNullOrWhiteSpace($centerUrl)) {
  # Best-effort fallback: centre has no URL to fetch port list from.
  # Centre post-hook will see peers:[] and skip.
  $payload = @{ metrics = @{ agent_id = $server; collected_at = $collectedAt; peers = @() } }
  $payload | ConvertTo-Json -Compress -Depth 8
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
$ports = @()
try {
  $portsResp = Invoke-RestMethod -Method GET -Headers $headers -Uri "$centerUrl/api/agent/ports"
  if ($portsResp -is [System.Array]) {
    $ports = $portsResp
  } elseif ($portsResp -and $portsResp.PSObject.Properties['port']) {
    $ports = @($portsResp)
  } elseif ($portsResp -and $portsResp.ports) {
    $ports = @($portsResp.ports)
  }
} catch {
  Write-Error "ad_dc_probe_inbound: fetch port list failed: $($_.Exception.Message)"
  $ports = @()
}

# 2. Peer list — INBOUND replication partners only, sourced from the
# centre (R151.2). The endpoint filters ad_replication_status by
# dest_dc = agentId and emits the source_dc list of each row — i.e.
# DCs that replicated TO this host in the last 30 minutes.
$peers = @()
$partnerSource = 'centre-inbound-partners'
try {
  $peerResp = Invoke-RestMethod -Method GET `
    -Headers $headers `
    -Uri "$centerUrl/api/agent/inbound-partners" `
    -TimeoutSec 15
  if ($peerResp -and $peerResp.peers -is [System.Array]) {
    foreach ($p in @($peerResp.peers)) {
      $peerDc = [string]$p.peerDc
      if (-not [string]::IsNullOrWhiteSpace($peerDc)) {
        $peers += @{ destDc = $peerDc }
      }
    }
  }
} catch {
  Write-Error "ad_dc_probe_inbound: inbound-partners fetch failed: $($_.Exception.Message); emit peers=[] and exit 0"
  $payload = @{ metrics = @{ agent_id = $server; collected_at = $collectedAt; peers = @() } }
  $payload | ConvertTo-Json -Compress -Depth 8
  exit 0
}

Write-Verbose "ad_dc_probe_inbound: $partnerSource returned $($peers.Count) inbound peer(s)"

# 3. Probe each (peer × port). TcpClient.BeginConnect + AsyncWaitHandle
# WaitOne(2000ms). Latency measures the connect attempt only.
# R158.52 — operator directive "零或空": wrap each peer in its own
# try/catch so one bad peerDc (DNS exception, IPv6 resolution fail,
# WSAEHOSTUNREACH) doesn't abort the whole batch. A failed peer
# contributes a synthetic {port:null, ok:false, latency:null} placeholder
# so the centre can still render the row in /replication-log/monitor.
$peersPayload = @()
$probeErrorMessages = @()
foreach ($peer in $peers) {
  $destDc = $null
  try {
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
      try {
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
      } catch {
        # R158.52 — TcpClient ctor or BeginConnect threw (DNS, IPv6, etc).
        # Record a per-port failure placeholder so this peer is not
        # silently dropped from the batch.
        $sw.Stop()
        try { $client.Close() } catch {}
        $portResults += @{ port = $portNum; ok = $false; latency = $null }
      }
    }
    $peersPayload += @{ destDc = $destDc; ports = $portResults }
  } catch {
    # R158.52 — outer peer loop guard. One bad $peer object (e.g. $null,
    # or property access throws) emits a synthetic failed peer so the
    # remaining peers are still probed. NOTE: $x ?? 'y' is PS7+ syntax;
    # use explicit if/else for PS5.1 compat (DC agents run PS5.1).
    $peerLabel = if ($null -ne $destDc) { $destDc } else { '<null>' }
    $probeErrorMessages += "peer $peerLabel failed: $($_.Exception.Message)"
    $destLabel = if ($null -ne $destDc) { $destDc } else { '<unknown>' }
    $peersPayload += @{ destDc = $destLabel; ports = @(@{ port = $null; ok = $false; latency = $null }) }
  }
}
# R158.52 — surface peer-level errors to the centre as `error` so partial
# probe failures are diagnosable.
$payloadError = if ($probeErrorMessages.Count -gt 0) { ($probeErrorMessages -join '; ') } else { $null }

$metrics = @{
  agent_id     = $server
  collected_at = $collectedAt
  peers        = @($peersPayload)
}
$payload = @{ metrics = $metrics }
# R158.52 — surface peer-level errors so partial probe failures are
# diagnosable. Centre parses `payload.error` (R158.50.6 pattern).
if ($payloadError) { $payload.error = $payloadError }
$payload | ConvertTo-Json -Compress -Depth 8
exit 0