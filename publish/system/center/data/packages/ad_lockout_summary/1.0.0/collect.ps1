# collect.ps1 - ad_lockout_summary v1
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

$server = $env:COMPUTERNAME

$lockedCount = $null
$errorCode   = 0

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
  $errorCode = $errorCode -bor 1
}

$metrics = @{
  agent_id     = $server
  locked_count = if ($null -ne $lockedCount) { [int]$lockedCount } else { $null }
  error_code   = [int]$errorCode
}

$payload = @{ metrics = $metrics }
$payload | ConvertTo-Json -Compress -Depth 4
exit 0
