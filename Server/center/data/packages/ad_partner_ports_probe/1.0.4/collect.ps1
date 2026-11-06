# collect.ps1 - ad_partner_ports_probe v1.0.4 (R158.52 bump / 2026-10-08)
# R158.52 hardening: SilentlyContinue -> Continue + accumulated $lastErrorMessage
# surfaced to centre as payload.error. NOT in BUILTIN_PACKAGES (R155.3 superseded
# by ad_dc_probe_inbound) but agent still runs it from cached current.json.
# Previous: R151.2 centre-computed peer list + 2000ms BeginConnect probe.
#
# For every replication peer returned by the centre's
# /api/agent/inbound-partners endpoint, probes every system port
# (resolved through centre GET /api/agent/ports) via a TcpClient
# BeginConnect with a 2000ms timeout, recording latency in
# milliseconds.
#
# Peer source priority (R151.2 operator directive:
# "可以增加一个端口探测，也就是提交本地的agentid 然后端点返回
#  inbound partner,这样探测才是最准确的"):
#   1. Centre GET /api/agent/inbound-partners — returns the list of DCs
#      that replicated TO this host in the last 30 minutes, computed by
#      the centre from ad_replication_status (dest_dc = agentId,
#      source_dc = peer DC). The centre is the authoritative source for
#      "which AD servers are still actively replicating with me" —
#      the agent no longer needs to call Get-ADReplicationPartnerMetadata
#      (whose default -Scope Server returns 0 rows on 28/34 of our agents
#      because it doesn't see cross-site links).
#   2. Local Get-ADReplicationPartnerMetadata -Target $env:COMPUTERNAME
#      is NO LONGER the primary source — kept out of 1.0.3 entirely
#      because:
#        - it returns 0 rows on agents with RSAT missing or with cross-
#          site-only replication (R151 root-cause analysis);
#        - the centre-side endpoint now does the same job more
#          reliably and stays aligned with what the dashboard's
#          /api/dashboard/partner-port-health/all view shows.
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
#   - GET /api/agent/inbound-partners fails → $peers = @(), exit 0
#     (no probe to run). The old Get-ADReplicationPartnerMetadata
#     fallback is removed because it returns the wrong direction on
#     most agents (see R151 root-cause) and we don't want silent
#     divergence from what the centre says.
#   - any single (peer × port) probe failure → ok=false, latency=null;
#     remaining probes continue.

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

# 2. Peer list — INBOUND replication partners only, sourced from the
# centre (R151.2). The endpoint filters ad_replication_status by
# dest_dc = agentId and emits the source_dc list of each row — i.e.
# DCs that replicated TO this host in the last 30 minutes.
#
# The previous (1.0.1) approach used
# Get-ADReplicationPartnerMetadata -Target $env:COMPUTERNAME locally,
# which works on 4/34 agents only (default -Scope Server only sees
# local-site links; cross-site and RSAT-missing agents return 0 rows).
# The centre-side endpoint JOINs against the full AD replication status
# and stays in sync with the dashboard's partner-port-health view.
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
        # The peer list from the centre is already deduped by source_dc,
        # so each entry becomes one (peer × all-ports) probe row.
        # collect.ps1 downstream expects destDc = the peer DC name to
        # TCP-probe. Align the field name to keep the wire shape
        # compatible with the existing centre post-hook
        # (services/partner-port-probe.js normalizePartnerProbe).
        $peers += @{ destDc = $peerDc }
      }
    }
  }
} catch {
  Write-Error "ad_partner_ports_probe: inbound-partners fetch failed: $($_.Exception.Message); emit peers=[] and exit 0"
  $payload = @{ metrics = @{ agent_id = $server; collected_at = $collectedAt; peers = @() } }
  $payload | ConvertTo-Json -Compress -Depth 8
  exit 0
}

Write-Verbose "ad_partner_ports_probe: $partnerSource returned $($peers.Count) inbound peer(s)"

# 3. Probe each (peer × port). TcpClient.BeginConnect + AsyncWaitHandle
# WaitOne(2000ms) — matches the real-agent's Get-PartnerPortSnapshot.
# Latency measures the connect attempt only (start stopwatch before
# BeginConnect, stop after EndConnect; the underlying TCP handshake
# completes the moment EndConnect returns).
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
    # R158.52 — outer peer loop guard. NOTE: $x ?? 'y' is PS7+ syntax;
    # use explicit if/else for PS5.1 compat (DC agents run PS5.1).
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
# R93.12 — -Depth 8 reaches the {port, ok, latency} leaf properties
# reliably. With -Depth 4 PowerShell enumerates the hashtable instead
# of recursing into its properties and the centre rejects the row.
$payload | ConvertTo-Json -Compress -Depth 8
exit 0
