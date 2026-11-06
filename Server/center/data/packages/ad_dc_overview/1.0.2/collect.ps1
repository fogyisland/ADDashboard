# collect.ps1 - ad_dc_overview v1 (R110.A) + R158.44.7.8 computers/servers
#
# Reports users / computers / servers / groups / gpos counters for this DC.
# Output is one JSON object with shape:
#   { metrics: { agent_id, dc_name, site_id, users_count, computers_count,
#                servers_count, groups_count, gpos_count, partner_port_status,
#                collected_at } }
#
# Cadence: every 15 minutes (manifest.agent.intervalSec = 900). Independent
# of replication cycle so overview stays fresh on broken-replication DCs.
#
# site_id resolution happens at the centre side from agent_id via the
# existing ad_dcs table — agent does not carry site_id mapping. Set null here.
#
# Real-agent swap (operator directive: "agent"):
# the ActiveDirectory RSAT path below is the production wire shape; mock
# (centre/mock-snapshot.mjs) emits deterministic SHA-based counter values.
#
# R158.44.7.8 (2026-10-05) — operator directive "DC overview 、
# 、" (separator counters,  3  tile).
# computers_count = Get-ADComputer -Filter * (all computer accounts)
# servers_count   = Get-ADComputer -LDAPFilter '(operatingSystem=*Server*)'
# (servers  computers , OperatingSystem  'Server' 
# member server; DC  server  default  DC  Computers
# container, . PS -Filter  wildcard on OperatingSystem, 
# -LDAPFilter  LDAP filter ).

$ErrorActionPreference = 'Continue'

# R136: force UTF-8 stdout so any Chinese text in .NET exception
# messages / DC names survives the PS→agent→centre pipeline without
# being transcoded through the system ANSI codepage.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$server = $env:COMPUTERNAME
$collectedAt = (Get-Date).ToUniversalTime().ToString('o')

$usersCount     = $null
$computersCount = $null
$serversCount   = $null
$groupsCount    = $null
$gposCount      = $null
# R158.50.6 (2026-10-07) —  try/catch  message  stdout `error` 
$lastErrorMessage = $null

try {
  if (-not (Get-Module -Name ActiveDirectory -ListAvailable)) {
    throw 'ActiveDirectory RSAT module not available'
  }
  if (-not (Get-Module -Name ActiveDirectory)) {
    Import-Module ActiveDirectory -ErrorAction Stop
  }
} catch {
  [Console]::Error.WriteLine("ad_dc_overview module import failed: $($_.Exception.Message)")
  $lastErrorMessage = "ad_dc_overview module import failed: $($_.Exception.Message)"
}

# R158.52 — per-counter try/catch so one counter failure (e.g. Get-GPO
#  -All on a DC with broken SYSVOL) doesn't mask the other 4 counters
#  as all-null. The agent now reports 4 successes + 1 zero + 1
#  error_code bit instead of 5 nulls + 1 generic error.
$counterErrorBits = 0
try { $usersCount     = [int](Get-ADUser     -Filter * -Server $server -ErrorAction Stop | Measure-Object).Count } catch { $usersCount     = 0; $counterErrorBits = $counterErrorBits -bor 1; if (-not $lastErrorMessage) { $lastErrorMessage = "users_count: $($_.Exception.Message)" } }
try { $computersCount = [int](Get-ADComputer -Filter * -Server $server -ErrorAction Stop | Measure-Object).Count } catch { $computersCount = 0; $counterErrorBits = $counterErrorBits -bor 2; if (-not $lastErrorMessage) { $lastErrorMessage = "computers_count: $($_.Exception.Message)" } }
try { $serversCount   = [int](Get-ADComputer -LDAPFilter '(operatingSystem=*Server*)' -Server $server -ErrorAction Stop | Measure-Object).Count } catch { $serversCount   = 0; $counterErrorBits = $counterErrorBits -bor 4; if (-not $lastErrorMessage) { $lastErrorMessage = "servers_count: $($_.Exception.Message)" } }
try { $groupsCount    = [int](Get-ADGroup    -Filter * -Server $server -ErrorAction Stop | Measure-Object).Count } catch { $groupsCount    = 0; $counterErrorBits = $counterErrorBits -bor 8; if (-not $lastErrorMessage) { $lastErrorMessage = "groups_count: $($_.Exception.Message)" } }
try { $gposCount      = [int](Get-GPO        -All        -Server $server -ErrorAction Stop | Measure-Object).Count } catch { $gposCount      = 0; $counterErrorBits = $counterErrorBits -bor 16; if (-not $lastErrorMessage) { $lastErrorMessage = "gpos_count: $($_.Exception.Message)" } }

$metrics = @{
  agent_id            = $server
  dc_name             = $server
  site_id             = $null
  # R158.52 — operator directive "零或空": missing counter is 0, not null.
  # Per-counter try/catch above guarantees these are always int.
  users_count         = $usersCount
  computers_count     = $computersCount
  servers_count       = $serversCount
  groups_count        = $groupsCount
  gpos_count          = $gposCount
  partner_port_status = $null
  collected_at        = $collectedAt
  # R158.52 — per-counter error bit field. 0 = all 5 OK; non-zero = which
  # counter(s) failed. Centre uses this to colour the tile without
  # having to parse the human-readable $lastErrorMessage.
  error_code          = $counterErrorBits
}

# R158.50.6 —  message  stdout `error` , agent reporter  r.error
$payload = @{
  metrics = $metrics
  error   = if ($lastErrorMessage) { $lastErrorMessage } else { $null }
}
$payload | ConvertTo-Json -Compress -Depth 4
exit 0