# collect.ps1 - ad_partner_inbound_discover v1.1.4 (R158.11.4 / 2026-10-01)
#
# R158.11.4 -- operator fix: previous versions (1.1.0..1.1.3) had
#   embedded Chinese (zh-CN) comments + Chinese strings inside
#   Write-Warning / Write-Error calls. PowerShell 5.1 (the agent's
#   default) reads the script with the system codepage (zh-CN =
#   CP936 / GB18030) and the centre's Windows editor saved the file
#   with a different encoding (UTF-8 no-BOM from the dev box). The
#   mismatch caused PowerShell to either:
#     (a) refuse to parse the script (silently swallowed by
#         ErrorAction Stop -> catch -> peers=[] exit 0)
#     (b) parse it but produce a Unicode-escaped literal that does
#         not match any expected string, again -> peers=[] exit 0
#   v1.1.4 strips every non-ASCII (non-Latin1) character from the
#   file so the script is pure 7-bit-clean ASCII. Comments stay
#   informative in English; Write-Warning messages are English-only.
#   Behaviour on RSAT-equipped DCs is identical to v1.1.3
#   (parses the partner DC name from the CN= segment of $p.Partner).
#
# Cadence: 5 min (manifest.agent.intervalSec = 300). Driven by the
# agent package-manager.js periodic timer. Centre cron-scheduler.js
# also fires a __cron__ trigger every 5 min as a defence-in-depth
# wake-up, but the agent runs on its own intervalSec clock regardless.
#
# Wire shape (matches centre src/services/partner-discover.js
# upsertDiscovers expectations -- direction binding via packageName):
#   {
#     metrics: {
#       agent_id:     <string>,     # $env:COMPUTERNAME
#       collected_at: <iso8601 utc>,
#       peers: [
#         {
#           destDc: <string>        # peer DC name (the upstream source)
#         }
#       ]
#     }
#   }
#
# Best-effort fallbacks (collect, never crash the package):
#   - Get-ADReplicationPartnerMetadata throws / RSAT missing -> emit
#     empty peers[], exit 0. Centre reconciliation will DELETE stale
#     rows (this is acceptable: a DC whose RSAT tools are gone is
#     effectively blind to topology).

$ErrorActionPreference = 'Continue'

$server = $env:COMPUTERNAME
$collectedAt = (Get-Date).ToUniversalTime().ToString('o')

$peers = @()

# Query AD for the inbound replication partners of this DC.
# Operator-prescribed cmdlet: -Target $localcomputer forces the Target
# parameter set so Server/Partner field semantics are stable across
# Windows versions; -PartnerType Inbound filters to peers that
# replicate TO this host (upstream DCs the target receives from).
try {
  $localcomputer = $env:COMPUTERNAME
  $partners = Get-ADReplicationPartnerMetadata -Target $localcomputer -PartnerType Inbound -ErrorAction Stop

  $seen = @{}
  foreach ($p in @($partners)) {
    # Pre-1.1.3 read $p.Server here -- BUG: $p.Server is the TARGET DC
    # (this host), not the partner DC, so the dedupe filter
    # $peerDc -ieq $server silently dropped every record. The fix
    # parses the partner DC name from the DN in $p.Partner:
    #   CN=NTDS Settings,CN=KDLFLOFADSRV2,CN=Servers,...
    # The partner DC name is the CN= segment immediately following
    # CN=NTDS Settings.
    $peerDc = $null
    $partnerDn = [string]$p.Partner
    if ($partnerDn -match '(?i)CN=NTDS Settings,CN=([^,]+),') {
      $peerDc = $matches[1]
    }
    if ([string]::IsNullOrWhiteSpace($peerDc)) {
      # DN shape did not match -- log and skip rather than emit garbage.
      Write-Warning ("ad_partner_inbound_discover v1.1.4: cannot parse partner DC from Partner DN='" + $partnerDn + "'")
      continue
    }
    if ($peerDc -ieq $server) { continue }  # skip self (defence-in-depth)
    if ($seen.ContainsKey($peerDc)) { continue }  # dedupe across partitions
    $seen[$peerDc] = $true
    $peers += @{ destDc = $peerDc }
  }
  # Diagnostic breadcrumb so the next ETL run surfaces what the cmdlet
  # returned and how many peer names we extracted.
  Write-Warning ("ad_partner_inbound_discover v1.1.4: partners.count=" + @($partners).Count + " peers.extracted=" + @($peers).Count)
  if (@($peers).Count -gt 0) {
    $sample = ($peers | Select-Object -First 3 | ForEach-Object { $_.destDc }) -join ','
    Write-Warning ("ad_partner_inbound_discover v1.1.4: peers.sample=" + $sample)
  }
} catch {
  # Fail loud-but-soft: emit empty peers[], exit 0, let the centre
  # reconciliation DELETE stale rows. The error_code bit 2 (RSAT
  # missing) is recorded by the centre runner when peers=[] + exit=0
  # + stderr contains "Get-ADReplicationPartnerMetadata".
  Write-Warning ("ad_partner_inbound_discover v1.1.4: Get-ADReplicationPartnerMetadata failed: " + $_.Exception.Message + "; emitting empty peers[]")
}

$payload = @{
  metrics = @{
    agent_id     = $server
    collected_at = $collectedAt
    peers        = $peers
  }
}
$payload | ConvertTo-Json -Compress -Depth 8
exit 0