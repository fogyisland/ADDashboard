# collect.ps1 - member_admin_groups v1.0.0 (R158.100, 2026-10-13)
#
# v1.0.0 (R158.100, 2026-10-13) - Member Server 本地管理员组成员.
#   Mirror of ad_admin_members 1.0.1 (R158.47/R158.52) but for member-server
#   local-group membership. 0 AD RSAT, 走 Microsoft.PowerShell.LocalAccounts
#   (PSR 5.1+ in-box, member-server 全装, 0 装额外 module).
#   3 local groups per operator 2026-10-13 directive:
#     - BUILTIN\Administrators
#     - Remote Desktop Users
#     - Power Users
#
# Output wire shape (跟 ad_admin_members 1:1 平行, 改字段 hostname + groups):
#   { metrics: { agent_id, hostname, collected_at,
#                groups: [
#                  { name, members: [{ sid, name, class, principal_source, is_enabled, display_name }] }
#                ],
#                groups_count, total_members_count, error_code },
#     error: null | "<msg>" }
#
# 跟 R158.99.4 wrapper (package-runner.js:49-69 InputEncoding=UTF8) 1:1 平行.
# 这层 [Console]::OutputEncoding = UTF8 (R136) 保留作 belt-and-suspenders.

$ErrorActionPreference = 'Continue'

# R136 encoding fix
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'

$server = $env:COMPUTERNAME
$collectedAt = (Get-Date).ToUniversalTime()
$lastErrorMessage = $null

# R158.100 - Microsoft.PowerShell.LocalAccounts module check (PSR 5.1+ in-box).
# member-server 全装, 0 RSAT 必装. 但仍 defense in depth.
$localAccountsOk = $false
try {
  if (Get-Module -Name Microsoft.PowerShell.LocalAccounts -ListAvailable) {
    if (-not (Get-Module -Name Microsoft.PowerShell.LocalAccounts)) {
      Import-Module Microsoft.PowerShell.LocalAccounts -ErrorAction Stop
    }
    $localAccountsOk = $true
  } else {
    $lastErrorMessage = 'init: Microsoft.PowerShell.LocalAccounts module not available'
  }
} catch {
  $lastErrorMessage = "init: $($_.Exception.Message)"
}

# R158.100 - Get-LocalUser hashtable for enrich (is_enabled + display_name).
# 建在 group loop 外 1 次, member loop 内 lookup O(1).
$localUserEnrich = @{}
if ($localAccountsOk) {
  try {
    $users = Get-LocalUser -ErrorAction Stop
    foreach ($u in $users) {
      $key = $null
      try { $key = [string]$u.SID.Value } catch {}
      if ($key) {
        $localUserEnrich[$key] = @{
          is_enabled   = if ($u.Enabled) { 1 } else { 0 }
          display_name = if ($u.FullName) { [string]$u.FullName } else { $null }
        }
      }
    }
  } catch {
    if (-not $lastErrorMessage) { $lastErrorMessage = "get_localuser: $($_.Exception.Message)" }
  }
}

# R158.100 - 3 local groups per operator directive.
$targetGroups = @('Administrators', 'Remote Desktop Users', 'Power Users')
$groups = @()

foreach ($groupName in $targetGroups) {
  $groupEntry = @{
    name    = $groupName
    members = @()
  }
  if ($localAccountsOk) {
    try {
      $members = Get-LocalGroupMember -Group $groupName -ErrorAction Stop
      foreach ($m in $members) {
        $sid = $null
        try { $sid = [string]$m.SID.Value } catch {}
        $name = $null
        try { $name = [string]$m.Name } catch {}
        $class = $null
        try { $class = [string]$m.ObjectClass } catch {}
        $source = $null
        try { $source = [string]$m.PrincipalSource } catch {}
        # enrich from local user hashtable
        $enrich = $null
        if ($sid -and $localUserEnrich.ContainsKey($sid)) {
          $enrich = $localUserEnrich[$sid]
        }
        $groupEntry.members += @{
          sid              = $sid
          name             = $name
          class            = $class
          principal_source = $source
          is_enabled       = if ($enrich) { $enrich.is_enabled }   else { $null }
          display_name     = if ($enrich) { $enrich.display_name } else { $null }
        }
      }
    } catch {
      [Console]::Error.WriteLine("Get-LocalGroupMember $groupName failed: $($_.Exception.Message)")
      if (-not $lastErrorMessage) { $lastErrorMessage = "$($groupName -replace ' ', '_'): $($_.Exception.Message)" }
    }
  }
  $groups += $groupEntry
}

# R158.52 0-or-empty pattern: missing count = 0, not null. operator directive
# "零或空" allows the centre tile to show "0 admins" instead of "—".
$totalMembers = 0
foreach ($g in $groups) { $totalMembers += [int](@($g.members).Count) }

$metrics = @{
  agent_id            = $server
  hostname            = $server
  collected_at        = $collectedAt.ToString('o')
  groups              = $groups
  groups_count        = [int](@($groups).Count)
  total_members_count = [int]$totalMembers
  # R158.52 per-counter error_code bit
  error_code          = if ($lastErrorMessage) { 1 } else { 0 }
}

$payload = @{ metrics = $metrics }
if ($lastErrorMessage) { $payload.error = $lastErrorMessage }

$payload | ConvertTo-Json -Compress -Depth 8
exit 0
