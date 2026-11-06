# collect.ps1 - ad_dc_probe_outbound v1.0.0 (R155.4 / 2026-09-30)
#
# For every replication peer returned by the centre's
# /api/agent/outbound-partners endpoint, probes every system port
# (resolved through centre GET /api/agent/ports) via a TcpClient
# BeginConnect with a 2000ms timeout, recording latency in
# milliseconds.
#
# R155.4 — OUTBOUND mirror of ad_dc_probe_inbound 1.0.0. Identical
# probe loop (TcpClient.BeginConnect + AsyncWaitHandle 2000ms), same
# wire shape (metrics.peers: [{ destDc, ports: [{port, ok, latency}] }]),
# but:
#   - Peer source flipped: GET /api/agent/outbound-partners (this host's
#     outbound replication destinations, source_dc=agent anchor) instead
#     of GET /api/agent/inbound-partners (dest_dc=agent anchor).
#   - Centre post-hook routes writes to ad_dc_probe_outbound (NEW
#     physical table, migration 034) via partnerPortProbeService.
#     upsertOutboundProbes instead of ad_replication_status. The two
#     data planes never collide — R155.3 inbound rows still land on
#     ad_replication_status with naming_context='__partner_ports__:<hash>',
#     these outbound rows land on ad_dc_probe_outbound keyed on
#     UNIQUE(source_dc, dest_dc) with no naming_context.
#
# Operator rationale (R155.4 directive 2026-09-30): "算了,既然有 outbound
# 那么我们就增加一个 probe-outbound 的 脚本,写入 prob_outbound 的数据,
# 这样避免数据错误". The earlier R155.3 stance (one probe pipeline, two
# render anchors on the same physical row) was retracted because the
# operator prefers the inbound vs outbound probe rows be physically
# separated so the data plane they audit matches the wire shape they
# configure.
#
# Wire shape (matches centre src/services/partner-port-probe.js
# normalizePartnerProbe expectations — same as inbound sibling):
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
#   - GET /api/agent/outbound-partners fails → $peers = @(), exit 0
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
  Write-Error "ad_dc_probe_outbound: fetch port list failed: $($_.Exception.Message)"
  $ports = @()
}

# 2. Peer list — OUTBOUND replication partners only, sourced from the
# centre (R155.4). The endpoint filters ad_replication_status by
# source_dc = agentId and emits the dest_dc list of each row — i.e.
# DCs that this host replicated TO in the last 30 minutes. The
# synthetic-row exclusion (naming_context NOT LIKE '__partner_ports__:%')
# is the echo-loop guard: without it, this endpoint would feed back
# the agent's own previous-cycle probe rows as new peers.
$peers = @()
$partnerSource = 'centre-outbound-partners'
try {
  $peerResp = Invoke-RestMethod -Method GET `
    -Headers $headers `
    -Uri "$centerUrl/api/agent/outbound-partners" `
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
  Write-Error "ad_dc_probe_outbound: outbound-partners fetch failed: $($_.Exception.Message); emit peers=[] and exit 0"
  $payload = @{ metrics = @{ agent_id = $server; collected_at = $collectedAt; peers = @() } }
  $payload | ConvertTo-Json -Compress -Depth 8
  exit 0
}

Write-Verbose "ad_dc_probe_outbound: $partnerSource returned $($peers.Count) outbound peer(s)"

# 3. Probe each (peer × port). TcpClient.BeginConnect + AsyncWaitHandle
# WaitOne(2000ms). Latency measures the connect attempt only. Byte-
# identical to the inbound sibling probe loop (R155.4 mirror of R155.3).
# R158.52 — operator directive "零或空": per-peer + per-port try/catch
# so a single DNS / IPv6 / WSAEHOSTUNREACH failure doesn't abort the
# whole batch.
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
        # R158.52 — TcpClient ctor / BeginConnect threw (DNS, IPv6, etc).
        $sw.Stop()
        try { $client.Close() } catch {}
        $portResults += @{ port = $portNum; ok = $false; latency = $null }
      }
    }
    $peersPayload += @{ destDc = $destDc; ports = $portResults }
  } catch {
    # R158.52 — outer peer loop guard for $null / property-access throws.
    # NOTE: $x ?? 'y' is PS7+ syntax; use explicit if/else for PS5.1
    # compat (DC agents run PS5.1).
    $peerLabel = if ($null -ne $destDc) { $destDc } else { '<null>' }
    $probeErrorMessages += "peer $peerLabel failed: $($_.Exception.Message)"
    $destLabel = if ($null -ne $destDc) { $destDc } else { '<unknown>' }
    $peersPayload += @{ destDc = $destLabel; ports = @(@{ port = $null; ok = $false; latency = $null }) }
  }
}
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