# collect.ps1 - ad_domain_consistency v1
# Snapshots the local DC's user / group / GPO inventories and emits a count +
# SHA-256-hashed fingerprint per class. Used by the center to detect cross-DC
# consistency drift: if every DC produces a different hash, replication is
# missing objects on at least one node.
#
# Algorithm:
#   1. For each of users / groups / gpos:
#      - Try/catch around the AD cmdlet (ActiveDirectory RSAT module is
#        required; member servers without RSAT will fail this class).
#      - Collect canonical names: SamAccountName for users and groups
#        (falls back to DistinguishedName when SamAccountName is empty —
#        rare; happens for foreign security principals), DisplayName for
#        GPOs (canonical, no whitespace/dup issues; Get-GPO has no
#        -Server switch because it is local-domain only).
#      - Sort with InvariantCulture ordinal-ignore-case so two DCs with
#        the same objects in different insertion order produce the same
#        hash. [string]::CompareOrdinal + ToLower() is PS 5.1 native.
#      - Join with "|" and SHA-256-hash the UTF-8 bytes; lowercase hex
#        matches node-side `crypto.createHash('sha256').digest('hex')`.
#   2. Aggregate an error_code bit accumulator:
#        1 = users class failed
#        2 = groups class failed
#        4 = gpos class failed
#      So error_code = 0 means all three classes succeeded; 7 means all
#      three failed. Bits let a partial failure be diagnosed without
#      separate columns.
#   3. Always emit ALL 9 schema columns (agent_id + 7 metrics + error_code)
#      even when some classes failed; metricstore strict validation
#      rejects unknown keys but accepts any subset of declared keys, and
#      we want the shape to be stable for downstream consumers.
#
# Server clock stamps `ts` on the center side; this script omits it.
# Exit code 0 regardless of per-class outcome (the bit accumulator
# carries the failure information).

$ErrorActionPreference = 'Continue'

$server = $env:COMPUTERNAME

# ActiveDirectory RSAT is required for users / groups. GPOs use the
# GroupPolicy module instead (RSAT-GPMC). Both are bundled with the
# AD DS / GPMC RSAT packs and are typically present on DCs.

function Ensure-ActiveDirectoryModule {
  if (-not (Get-Module -Name ActiveDirectory -ListAvailable)) {
    throw "ActiveDirectory RSAT module not available"
  }
  if (-not (Get-Module -Name ActiveDirectory)) {
    Import-Module ActiveDirectory -ErrorAction Stop
  }
}

# Canonical-name selectors: SamAccountName is the compact, case-stable
# identifier (case-insensitive uniqueness is enforced by AD). Falls back
# to DistinguishedName when SamAccountName is $null / empty (foreign
# security principals etc.).
function Get-UserCanonicalName($obj) {
  $name = $obj.SamAccountName
  if ([string]::IsNullOrEmpty($name)) { $name = [string]$obj.DistinguishedName }
  return [string]$name
}

function Get-GroupCanonicalName($obj) {
  $name = $obj.SamAccountName
  if ([string]::IsNullOrEmpty($name)) { $name = [string]$obj.DistinguishedName }
  return [string]$name
}

# Get-GPO exposes DisplayName; it's the canonical human-readable
# identifier (DisplayName + ID is what gpresult / GPMC show).
function Get-GpoCanonicalName($obj) {
  return [string]$obj.DisplayName
}

# Class collectors: each returns @{ Count = <int>|null; Hash = <hex>|null }
# Hash is lowercase SHA-256 hex of the UTF-8 bytes of the join('|')-ed
# sorted names list, or $null if the cmdlet threw.
function Invoke-Class([string]$label, [string]$server, [scriptblock]$selector, [scriptblock]$cmdlet) {
  try {
    Ensure-ActiveDirectoryModule
  } catch {
    [Console]::Error.WriteLine("$label module load failed: $($_.Exception.Message)")
    return @{ Count = $null; Hash = $null }
  }
  try {
    $names = @(& $cmdlet -Server $server | ForEach-Object { & $selector $_ }) | Where-Object { $_ } | Sort-Object -Culture iv -CaseSensitive:$false
    $joined = ($names -join '|')
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($joined)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      $hashBytes = $sha.ComputeHash($bytes)
      $hex = -join ($hashBytes | ForEach-Object { $_.ToString('x2') })
    } finally {
      $sha.Dispose()
    }
    return @{ Count = [int]$names.Count; Hash = $hex }
  } catch {
    [Console]::Error.WriteLine("$label collection failed: $($_.Exception.Message)")
    return @{ Count = $null; Hash = $null }
  }
}

$userResult  = Invoke-Class 'users'  $server ${function:Get-UserCanonicalName}  { Get-ADUser  -Filter * }
$groupResult = Invoke-Class 'groups' $server ${function:Get-GroupCanonicalName} { Get-ADGroup -Filter * }

# GPOs: no -Server switch (Get-GPO is local-domain only).
$gpoResult = $null
try {
  $names = @(Get-GPO -All | ForEach-Object { Get-GpoCanonicalName $_ }) | Where-Object { $_ } | Sort-Object -Culture iv -CaseSensitive:$false
  $joined = ($names -join '|')
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($joined)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hashBytes = $sha.ComputeHash($bytes)
    $hex = -join ($hashBytes | ForEach-Object { $_.ToString('x2') })
  } finally {
    $sha.Dispose()
  }
  $gpoResult = @{ Count = [int]$names.Count; Hash = $hex }
} catch {
  [Console]::Error.WriteLine("gpos collection failed: $($_.Exception.Message)")
  $gpoResult = @{ Count = $null; Hash = $null }
}

# Bit accumulator: 1=users, 2=groups, 4=gpos
$errorCode = 0
if ($null -eq $userResult.Count)  { $errorCode = $errorCode -bor 1 }
if ($null -eq $groupResult.Count) { $errorCode = $errorCode -bor 2 }
if ($null -eq $gpoResult.Count)   { $errorCode = $errorCode -bor 4 }

$metrics = @{
  agent_id    = $server
  user_count  = $userResult.Count
  user_hash   = $userResult.Hash
  group_count = $groupResult.Count
  group_hash  = $groupResult.Hash
  gpo_count   = $gpoResult.Count
  gpo_hash    = $gpoResult.Hash
  error_code  = [int]$errorCode
}

$payload = @{ metrics = $metrics }
$payload | ConvertTo-Json -Compress -Depth 4
exit 0