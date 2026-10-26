# collect.ps1 - ad_lockout_summary v1.0.3 (R158.52 bump / 2026-10-08)
# R158.52 hardening: SilentlyContinue -> Continue + accumulated $lastErrorMessage
# surfaced to centre as payload.error so the 15-min locked_count gap chart
# surfaces real RSAT failures instead of silent null.
# Previous: split out from collect-replication.ps1 (15min independent cadence).
# Reports the number of currently locked-out AD user accounts on this DC.
# Split out from collect-replication.ps1 (which used to include this counter
# in the __dc_summary__ row) so the cadence is independent of the replication
# cycle: the user wants this every 15 minutes, regardless of replication
# activity, so a DC with broken replication still surfaces its lockout trend.
#
# Algorithm:
#   1. Try Import-Module ActiveDirectory (RSAT). Failure → error_code=1,
#      locked_count=null, exit 0 (the bit carries the failure; the row is
#      still useful for the gap chart).
#   2. Search-ADAccount -LockedOut -Server $env:COMPUTERNAME | count.
#   3. Emit {agent_id, locked_count, error_code} as JSON {metrics:{...}}.
#
# Server clock stamps `ts` on the center side; this script omits it.
# Exit code 0 regardless of outcome (error_code bit conveys the failure).

$ErrorActionPreference = 'Continue'

# R136: force UTF-8 stdout so any Chinese text in .NET exception
# messages / DC names survives the PS→agent→centre pipeline without
# being transcoded through the system ANSI codepage.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$server = $env:COMPUTERNAME

$lockedCount = $null
$errorCode   = 0
# R158.50.6 (2026-10-07) —  try/catch  message  stdout `error` ,
# agent reporter  r.error → centre package_runs.status='failed' .
$lastErrorMessage = $null

try {
  if (-not (Get-Module -Name ActiveDirectory -ListAvailable)) {
    throw 'ActiveDirectory RSAT module not available'
  }
  if (-not (Get-Module -Name ActiveDirectory)) {
    Import-Module ActiveDirectory -ErrorAction Stop
  }
  $lockedCount = (Search-ADAccount -LockedOut -Server $server | Measure-Object).Count
} catch {
  [Console]::Error.WriteLine("lockedCount failed: $($_.Exception.Message)")
  # R158.50.6 —  message  payload.error
  $lastErrorMessage = "lockedCount failed: $($_.Exception.Message)"
  $errorCode = $errorCode -bor 1
}

$metrics = @{
  agent_id     = $server
  # R158.52 — operator directive "零或空": missing count is 0, not null.
  # The previous `if ($null -ne $lockedCount) { [int]$lockedCount } else { $null }`
  # pattern emitted null on RSAT failure, making the centre's tile show "—"
  # instead of "0". error_code still carries the failure bit so the tile
  # can be coloured to indicate the count is a fallback.
  # PS5.1 idiom (R158.52 lesson + R158.52.1 audit): never use `[int](if ...)`
  # (cast if statement — parser fails with "无法将 if 项识别为 cmdlet"), use
  # `$(if ...)` sub-expression with the cast inside. The same bug lived in
  # 1.0.2 too; 1.0.3 fixed it via this same template.
  locked_count = $(if ($null -ne $lockedCount) { [int]$lockedCount } else { 0 })
  error_code   = [int]$errorCode
}

# R158.50.6 —  message  stdout `error` 
$payload = @{
  metrics = $metrics
  error   = if ($lastErrorMessage) { $lastErrorMessage } else { $null }
}
$payload | ConvertTo-Json -Compress -Depth 4
exit 0
