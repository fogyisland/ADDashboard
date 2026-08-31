[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$CommandType,

  [Parameter(Mandatory = $true)]
  [string]$ParamsPath
)

# 2026-08-31 R75 — AD group-management cmdlet dispatcher.
#
# Receives a JSON params blob at $ParamsPath (written by the agent's
# JS dispatcher: agent/src/dispatchers/ad-admin.js) and runs the matching
# ActiveDirectory cmdlet. Returns ConvertTo-Json -Depth 5 -Compress to
# stdout on success; structured error JSON on stdout + exit 1 on failure.
#
# Per spec §6 the cmdlet mapping is:
#   group_search          → Get-ADGroup -Filter
#   group_create          → New-ADGroup
#   group_set_attributes  → Set-ADGroup -Replace
#   group_delete          → Remove-ADGroup -Confirm:$false
#   group_list_members    → Get-ADGroupMember | Get-ADObject
#   group_add_member      → Add-ADGroupMember (sam or DN accepted)
#   group_remove_member   → Remove-ADGroupMember
#   group_set_membership  → $_.Clear + Add-ADGroupMember (replace)
#
# The JS dispatcher reads stdout for the result envelope
# ({success, data, error, exitCode, durationMs} — same shape as
# dispatchMockAdCommand in mock-ad-admin.mjs).

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding           = [System.Text.UTF8Encoding]::new($false)

$ErrorActionPreference = 'Stop'

# Read + parse the params blob. The JS dispatcher writes this to a temp
# file BEFORE spawning powershell.exe — keeps param shapes type-safe even
# when the payload contains nested objects (ConvertFrom-Json handles
# this cleanly).
try {
  $paramsJson = Get-Content -LiteralPath $ParamsPath -Raw -Encoding UTF8
  $p = $paramsJson | ConvertFrom-Json
} catch {
  [Console]::Error.WriteLine("params parse failed: $($_.Exception.Message)")
  exit 1
}

# Shared error envelope helper — emits the same JSON shape the JS
# dispatcher expects when it parses stdout as the success path.
function Emit-ErrorResult {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$Message,
    [Parameter()]
    [int]$ExitCode = 1
  )
  $errObj = [ordered]@{
    success    = $false
    data       = $null
    error      = $Message
    exitCode   = $ExitCode
    durationMs = 0
  }
  [Console]::Out.WriteLine(($errObj | ConvertTo-Json -Depth 5 -Compress))
  exit $ExitCode
}

# Lazy-load the ActiveDirectory module. Some servers have it under the
# RSAT-AD-PowerShell feature and not imported by default. The
# `Get-Module -ListAvailable` guard prevents a noisy error when the
# module genuinely isn't installed.
function Import-AdModule {
  [CmdletBinding()]
  param()
  if (-not (Get-Module -Name ActiveDirectory -ListAvailable)) {
    Emit-ErrorResult -Message 'ActiveDirectory module not available (install RSAT-AD-PowerShell)' -ExitCode 2
  }
  if (-not (Get-Module -Name ActiveDirectory)) {
    try {
      Import-Module ActiveDirectory -ErrorAction Stop
    } catch {
      Emit-ErrorResult -Message "ActiveDirectory import failed: $($_.Exception.Message)" -ExitCode 2
    }
  }
}

# Normalize a member id. The JS dispatcher accepts either a SAM
# (`jdoe`) or a DN (`CN=John Doe,CN=Users,DC=...`); Get-ADGroupMember
# accepts either natively, but Add-/Remove-ADGroupMember want a
# non-null identity string. We pass-through after a basic emptiness
# guard.
function Resolve-MemberIdentity {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [AllowNull()]
    [AllowEmptyString()]
    [string]$MemberId
  )
  if ([string]::IsNullOrWhiteSpace($MemberId)) {
    Emit-ErrorResult -Message 'memberId required'
  }
  return $MemberId
}

$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

try {
  Import-AdModule

  switch ($CommandType) {

    'group_search' {
      $filter = if ($p.filter) { [string]$p.filter } else { '' }
      $limit  = if ($p.limit)  { [int]$p.limit }    else { 200 }
      $wildcard = if ([string]::IsNullOrEmpty($filter)) { '*' } else { "${filter}*" }
      try {
        $rows = Get-ADGroup -Filter "Name -like '$wildcard'" -Properties Description, GroupCategory, GroupScope -ErrorAction Stop
      } catch {
        Emit-ErrorResult -Message "Get-ADGroup failed: $($_.Exception.Message)" -ExitCode 1
      }
      $out = @()
      foreach ($g in @($rows)) {
        if ($out.Count -ge $limit) { break }
        $out += [ordered]@{
          name        = [string]$g.Name
          dn          = [string]$g.DistinguishedName
          category    = [string]$g.GroupCategory
          scope       = [string]$g.GroupScope
          description = [string]$g.Description
        }
      }
      $truncated = $rows.Count -gt $limit
      $result = [ordered]@{
        groups    = $out
        truncated = $truncated
        count     = $out.Count
      }
      $stopwatch.Stop()
      [Console]::Out.WriteLine(([ordered]@{
        success    = $true
        data       = $result
        error      = $null
        exitCode   = 0
        durationMs = [int]$stopwatch.ElapsedMilliseconds
      } | ConvertTo-Json -Depth 5 -Compress))
    }

    'group_create' {
      if (-not $p.name) { Emit-ErrorResult -Message 'name required' }
      $name        = [string]$p.name
      $category    = if ($p.category) { [string]$p.category } else { 'Security' }
      $scope       = if ($p.scope)    { [string]$p.scope }    else { 'Global' }
      $path        = if ($p.ouPath)   { [string]$p.ouPath }   else { $null }
      $description = if ($p.description) { [string]$p.description } else { $null }
      $newParams = @{
        Name          = $name
        GroupCategory = $category
        GroupScope    = $scope
      }
      if ($path)        { $newParams['Path']        = $path }
      if ($description) { $newParams['Description'] = $description }
      try {
        $created = New-ADGroup @newParams -PassThru -ErrorAction Stop
      } catch {
        Emit-ErrorResult -Message "New-ADGroup failed: $($_.Exception.Message)" -ExitCode 1
      }
      $dn = [string]$created.DistinguishedName
      $stopwatch.Stop()
      [Console]::Out.WriteLine(([ordered]@{
        success    = $true
        data       = [ordered]@{ name = $name; dn = $dn; created = $true }
        error      = $null
        exitCode   = 0
        durationMs = [int]$stopwatch.ElapsedMilliseconds
      } | ConvertTo-Json -Depth 5 -Compress))
    }

    'group_set_attributes' {
      if (-not $p.name) { Emit-ErrorResult -Message 'name required' }
      if (-not $p.attributes) { Emit-ErrorResult -Message 'attributes required' }
      $name = [string]$p.name
      $replace = @{}
      $updated = @()
      foreach ($prop in $p.attributes.PSObject.Properties) {
        $v = $prop.Value
        if ($null -eq $v) { continue }
        $replace[$prop.Name] = $v
        $updated += $prop.Name
      }
      if ($replace.Count -gt 0) {
        try {
          Set-ADGroup -Identity $name -Replace $replace -ErrorAction Stop
        } catch {
          Emit-ErrorResult -Message "Set-ADGroup failed: $($_.Exception.Message)" -ExitCode 1
        }
      }
      $stopwatch.Stop()
      [Console]::Out.WriteLine(([ordered]@{
        success    = $true
        data       = [ordered]@{ name = $name; updatedFields = $updated }
        error      = $null
        exitCode   = 0
        durationMs = [int]$stopwatch.ElapsedMilliseconds
      } | ConvertTo-Json -Depth 5 -Compress))
    }

    'group_delete' {
      if (-not $p.name) { Emit-ErrorResult -Message 'name required' }
      $name = [string]$p.name
      try {
        Remove-ADGroup -Identity $name -Confirm:$false -ErrorAction Stop
      } catch {
        Emit-ErrorResult -Message "Remove-ADGroup failed: $($_.Exception.Message)" -ExitCode 1
      }
      $stopwatch.Stop()
      [Console]::Out.WriteLine(([ordered]@{
        success    = $true
        data       = [ordered]@{ name = $name; deleted = $true }
        error      = $null
        exitCode   = 0
        durationMs = [int]$stopwatch.ElapsedMilliseconds
      } | ConvertTo-Json -Depth 5 -Compress))
    }

    'group_list_members' {
      if (-not $p.name) { Emit-ErrorResult -Message 'name required' }
      $name = [string]$p.name
      $recursive = if ($p.recursive -eq $true) { $true } else { $false }
      try {
        $members = Get-ADGroupMember -Identity $name -Recursive:$recursive -ErrorAction Stop
      } catch {
        Emit-ErrorResult -Message "Get-ADGroupMember failed: $($_.Exception.Message)" -ExitCode 1
      }
      $out = @()
      foreach ($m in @($members)) {
        $out += [ordered]@{
          sam        = [string]$m.SamAccountName
          dn         = [string]$m.DistinguishedName
          objectClass = [string]$m.objectClass
          name       = [string]$m.Name
        }
      }
      $stopwatch.Stop()
      [Console]::Out.WriteLine(([ordered]@{
        success    = $true
        data       = [ordered]@{ name = $name; members = $out; recursive = $recursive }
        error      = $null
        exitCode   = 0
        durationMs = [int]$stopwatch.ElapsedMilliseconds
      } | ConvertTo-Json -Depth 5 -Compress))
    }

    'group_add_member' {
      if (-not $p.name) { Emit-ErrorResult -Message 'name required' }
      if (-not $p.memberId) { Emit-ErrorResult -Message 'memberId required' }
      $name = [string]$p.name
      $member = Resolve-MemberIdentity -MemberId ([string]$p.memberId)
      try {
        Add-ADGroupMember -Identity $name -Members $member -ErrorAction Stop
      } catch {
        Emit-ErrorResult -Message "Add-ADGroupMember failed: $($_.Exception.Message)" -ExitCode 1
      }
      $stopwatch.Stop()
      [Console]::Out.WriteLine(([ordered]@{
        success    = $true
        data       = [ordered]@{ name = $name; addedMember = $member }
        error      = $null
        exitCode   = 0
        durationMs = [int]$stopwatch.ElapsedMilliseconds
      } | ConvertTo-Json -Depth 5 -Compress))
    }

    'group_remove_member' {
      if (-not $p.name) { Emit-ErrorResult -Message 'name required' }
      if (-not $p.memberId) { Emit-ErrorResult -Message 'memberId required' }
      $name = [string]$p.name
      $member = Resolve-MemberIdentity -MemberId ([string]$p.memberId)
      try {
        Remove-ADGroupMember -Identity $name -Members $member -Confirm:$false -ErrorAction Stop
      } catch {
        Emit-ErrorResult -Message "Remove-ADGroupMember failed: $($_.Exception.Message)" -ExitCode 1
      }
      $stopwatch.Stop()
      [Console]::Out.WriteLine(([ordered]@{
        success    = $true
        data       = [ordered]@{ name = $name; removedMember = $member }
        error      = $null
        exitCode   = 0
        durationMs = [int]$stopwatch.ElapsedMilliseconds
      } | ConvertTo-Json -Depth 5 -Compress))
    }

    'group_set_membership' {
      if (-not $p.name) { Emit-ErrorResult -Message 'name required' }
      if (-not $p.memberIds) { Emit-ErrorResult -Message 'memberIds required' }
      $name = [string]$p.name
      # Read current membership, diff against target list, then add/remove.
      try {
        $current = @(Get-ADGroupMember -Identity $name -ErrorAction Stop)
      } catch {
        Emit-ErrorResult -Message "Get-ADGroupMember failed: $($_.Exception.Message)" -ExitCode 1
      }
      $currentSet = @{}
      foreach ($m in $current) { $currentSet[[string]$m.SamAccountName] = [string]$m.DistinguishedName }
      $targetSet = @{}
      $targetList = @()
      foreach ($id in @($p.memberIds)) {
        $tid = [string]$id
        if ([string]::IsNullOrWhiteSpace($tid)) { continue }
        $targetSet[$tid] = $true
        $targetList += $tid
      }
      $toAdd    = @()
      $toRemove = @()
      foreach ($k in $targetSet.Keys) { if (-not $currentSet.ContainsKey($k)) { $toAdd    += $k } }
      foreach ($k in $currentSet.Keys) { if (-not $targetSet.ContainsKey($k)) { $toRemove += $currentSet[$k] } }
      if ($toRemove.Count -gt 0) {
        try {
          Remove-ADGroupMember -Identity $name -Members $toRemove -Confirm:$false -ErrorAction Stop
        } catch {
          Emit-ErrorResult -Message "Remove-ADGroupMember failed: $($_.Exception.Message)" -ExitCode 1
        }
      }
      if ($toAdd.Count -gt 0) {
        try {
          Add-ADGroupMember -Identity $name -Members $toAdd -ErrorAction Stop
        } catch {
          Emit-ErrorResult -Message "Add-ADGroupMember failed: $($_.Exception.Message)" -ExitCode 1
        }
      }
      $stopwatch.Stop()
      [Console]::Out.WriteLine(([ordered]@{
        success    = $true
        data       = [ordered]@{ name = $name; finalCount = $targetList.Count; added = $toAdd; removed = $toRemove }
        error      = $null
        exitCode   = 0
        durationMs = [int]$stopwatch.ElapsedMilliseconds
      } | ConvertTo-Json -Depth 5 -Compress))
    }

    default {
      Emit-ErrorResult -Message "unknown group command_type: $CommandType" -ExitCode 1
    }
  }
} catch {
  # Defensive outer catch — any unhandled exception inside the switch
  # emits a structured error envelope rather than letting PowerShell
  # surface a raw stack trace.
  $stopwatch.Stop()
  [Console]::Error.WriteLine($_.Exception.Message)
  Emit-ErrorResult -Message $_.Exception.Message -ExitCode 2
}