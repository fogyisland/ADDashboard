# collect.ps1 - ad_admin_members v1.0.1 (R158.52 bump / 2026-10-08)
# R158.52 hardening: SilentlyContinue -> Continue + accumulated $lastErrorMessage
# surfaced to centre as payload.error so partial-success runs surface diagnostics.
# Previous: R158.47 single-DC semantic via centre-side MERGE.
#
# Reports Domain Admins + Enterprise Admins group membership for this DC.
# Output is one JSON object with shape:
#   { metrics: { agent_id, dc_name, domain_dn, forest_dn,
#                domain_admins: [{ sam, dn }],
#                enterprise_admins: [{ sam, dn }],
#                domain_admins_count, enterprise_admins_count,
#                collected_at } }
#
# Cadence: every 24 hours (manifest.agent.intervalSec = 86400). Admin
# group membership changes are infrequent; operator wants daily cadence.
#
# Single-DC semantic (operator directive 2026-10-06) is implemented
# CENTRE-side: every DC runs this script, the centre post-hook
# (center/src/services/admin-members.js) does an MERGE ON
# (domain_dn, group_name, member_sam) so duplicate reports collapse
# automatically. No agent-side PDC selection logic needed (avoids
# wasting LDAP bandwidth on non-PDC DCs).
#
# R158.47 (2026-10-06) - operator: build a package that extracts
# Domain Admins + Enterprise Admins members, displayed in the
# dashboard overview panel.

$ErrorActionPreference = 'Continue'

# R136: force UTF-8 stdout so any Chinese text in .NET exception
# messages / DC names survives the PS->agent->centre pipeline without
# being transcoded through the system ANSI codepage.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$server = $env:COMPUTERNAME
$collectedAt = (Get-Date).ToUniversalTime().ToString('o')

$domainAdmins = @()
$enterpriseAdmins = @()
$domainDn = $null
$forestDn = $null
# R158.52 — operator directive "零或空": accumulate $lastErrorMessage
# so the centre can distinguish "RSAT missing" from "group empty".
$lastErrorMessage = $null

try {
  if (-not (Get-Module -Name ActiveDirectory -ListAvailable)) {
    throw 'ActiveDirectory RSAT module not available'
  }
  if (-not (Get-Module -Name ActiveDirectory)) {
    Import-Module ActiveDirectory -ErrorAction Stop
  }
  # R158.52 — guard each AD call independently so a transient DNS
  # or replication outage doesn't silently null both DNs.
  try { $domain = Get-ADDomain -ErrorAction Stop; $domainDn = $domain.DistinguishedName } catch { $lastErrorMessage = "get_addomain: $($_.Exception.Message)" }
  try { $forest = Get-ADForest -ErrorAction Stop; $forestDn = $forest.DistinguishedName } catch { if (-not $lastErrorMessage) { $lastErrorMessage = "get_adforest: $($_.Exception.Message)" } }

  # Domain Admins (this DC's domain). -Recursive flattens nested group
  # nesting (DA sometimes nestules into regional admins for tiered
  # administration). SamAccountName + DistinguishedName are the wire
  # fields used by the post-hook for centre-side MERGE dedup.
  try {
    $da = Get-ADGroupMember -Identity 'Domain Admins' -Recursive -Server $server -ErrorAction Stop
    foreach ($m in $da) {
      $domainAdmins += @{
        sam = [string]$m.SamAccountName
        dn  = [string]$m.DistinguishedName
      }
    }
  } catch {
    [Console]::Error.WriteLine("Get-ADGroupMember Domain Admins failed: $($_.Exception.Message)")
    $lastErrorMessage = "domain_admins: $($_.Exception.Message)"
  }

  # Enterprise Admins (forest root). Enterprise Admins lives in the
  # forest root domain, NOT this DC's domain - point -Server at
  # $forest.RootDomain so the LDAP lookup crosses the forest trust.
  # R158.52 — guard $forest null so Get-ADForest failure doesn't
  # produce a "Cannot bind argument to parameter 'Server'" error that
  # overwrites the real $lastErrorMessage from L53.
  if ($null -ne $forest -and $forest.RootDomain) {
    try {
      $ea = Get-ADGroupMember -Identity 'Enterprise Admins' -Recursive -Server $forest.RootDomain -ErrorAction Stop
      foreach ($m in $ea) {
        $enterpriseAdmins += @{
          sam = [string]$m.SamAccountName
          dn  = [string]$m.DistinguishedName
        }
      }
    } catch {
      [Console]::Error.WriteLine("Get-ADGroupMember Enterprise Admins failed: $($_.Exception.Message)")
      if (-not $lastErrorMessage) { $lastErrorMessage = "enterprise_admins: $($_.Exception.Message)" }
    }
  } else {
    if (-not $lastErrorMessage) { $lastErrorMessage = "enterprise_admins: forest metadata unavailable" }
  }
} catch {
  [Console]::Error.WriteLine("ad_admin_members init failed: $($_.Exception.Message)")
  $lastErrorMessage = "init: $($_.Exception.Message)"
}

$metrics = @{
  agent_id                    = $server
  dc_name                     = $server
  domain_dn                   = $domainDn
  forest_dn                   = $forestDn
  domain_admins               = $domainAdmins
  enterprise_admins           = $enterpriseAdmins
  # R158.52 — operator directive "零或空": missing count is 0, not null.
  # Force int coercion so the centre's tile shows "0 admins" instead
  # of "—" when RSAT is missing or both AD calls failed.
  domain_admins_count         = [int](@($domainAdmins).Count)
  enterprise_admins_count     = [int](@($enterpriseAdmins).Count)
  collected_at                = $collectedAt
  # R158.52 — per-counter error_code bits. bit1 = RSAT/domain, bit2 = DA,
  # bit4 = EA. Centre uses this to colour the tile without parsing the
  # human-readable $lastErrorMessage.
  error_code                  = if ($lastErrorMessage) { 1 } else { 0 }
}

$payload = @{ metrics = $metrics }
# R158.52 — surface $lastErrorMessage to the centre as `error` so partial
# failures are diagnosable from package_runs.
if ($lastErrorMessage) { $payload.error = $lastErrorMessage }
$payload | ConvertTo-Json -Compress -Depth 5
exit 0