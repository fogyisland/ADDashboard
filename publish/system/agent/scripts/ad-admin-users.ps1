[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$CommandType,

  [Parameter(Mandatory = $true)]
  [string]$ParamsPath
)

# 2026-08-31 R75 — AD user-management cmdlet dispatcher.
#
# Receives a JSON params blob at $ParamsPath (written by the agent's
# JS dispatcher: agent/src/dispatchers/ad-admin.js) and runs the matching
# ActiveDirectory cmdlet. Returns ConvertTo-Json -Depth 5 -Compress to
# stdout on success; structured error JSON on stderr + exit 1 on failure.
#
# Per spec §6 the cmdlet mapping is:
#   user_search          → Get-ADUser -Filter
#   user_create          → New-ADUser
#   user_password_reset  → Set-ADAccountPassword -Reset + Unlock-ADAccount
#   user_enable          → Enable-ADAccount
#   user_disable         → Disable-ADAccount
#   user_unlock          → Unlock-ADAccount
#   user_set_attributes  → Set-ADUser -Replace
#   user_delete          → Remove-ADUser -Confirm:$false
#   user_list_groups     → Get-ADPrincipalGroupMembership | Get-ADGroup
#
# The JS dispatcher reads stdout for the result envelope
# ({success, data, error, exitCode, durationMs} — same shape as
# dispatchMockAdCommand in mock-ad-admin.mjs).
#
# Password fields NEVER appear on stdout; they're consumed by the cmdlet
# binding only. Spec §8 ruling #8 — passwords are REDACTED in audit
# payloads + result_json.

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

# ConvertTo-SecureString requires a [SecureString]. We accept the
# plaintext password only as a transient input — Set-ADAccountPassword
# consumes it directly so it never persists beyond this script's run.
function To-SecureString {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [AllowEmptyString()]
    [string]$Plain
  )
  if ([string]::IsNullOrEmpty($Plain)) {
    Emit-ErrorResult -Message 'password required' -ExitCode 1
  }
  return (ConvertTo-SecureString -String $Plain -AsPlainText -Force)
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

$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

try {
  Import-AdModule

  switch ($CommandType) {

    'user_search' {
      $filter = if ($p.filter) { [string]$p.filter } else { '' }
      $limit  = if ($p.limit)  { [int]$p.limit }    else { 200 }
      $wildcard = if ([string]::IsNullOrEmpty($filter)) { '*' } else { "${filter}*" }
      try {
        $rows = Get-ADUser -Filter "SamAccountName -like '$wildcard'" -Properties DisplayName, Enabled, LastLogonDate, Description -ErrorAction Stop
      } catch {
        Emit-ErrorResult -Message "Get-ADUser failed: $($_.Exception.Message)" -ExitCode 1
      }
      $out = @()
      foreach ($u in @($rows)) {
        if ($out.Count -ge $limit) { break }
        $out += [ordered]@{
          sam         = [string]$u.SamAccountName
          displayName = [string]$u.DisplayName
          enabled     = [bool]$u.Enabled
          lastLogon   = if ($u.LastLogonDate) { $u.LastLogonDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') } else { $null }
          description = [string]$u.Description
        }
      }
      $truncated = $rows.Count -gt $limit
      $result = [ordered]@{
        users     = $out
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

    'user_create' {
      if (-not $p.sam) { Emit-ErrorResult -Message 'sam required' }
      if (-not $p.password) { Emit-ErrorResult -Message 'password required' }
      $sam = [string]$p.sam
      $givenName = if ($p.givenName) { [string]$p.givenName } else { '' }
      $surname   = if ($p.surname)   { [string]$p.surname }   else { '' }
      $displayName = if ($p.displayName) { [string]$p.displayName } else { "${givenName} ${surname}".Trim() }
      if ([string]::IsNullOrEmpty($displayName)) { $displayName = $sam }
      $upn  = if ($p.upn)  { [string]$p.upn }  else { $null }
      $path = if ($p.ouPath) { [string]$p.ouPath } else { $null }
      $description = if ($p.description) { [string]$p.description } else { $null }
      $mustChange = if ($p.mustChangePassword -eq $true) { $true } else { $false }
      $secure = To-SecureString -Plain ([string]$p.password)
      $newUserParams = @{
        SamAccountName        = $sam
        Name                  = $displayName
        GivenName             = if ($givenName) { $givenName } else { $null }
        Surname               = if ($surname)   { $surname }   else { $null }
        DisplayName           = $displayName
        UserPrincipalName     = $upn
        AccountPassword       = $secure
        ChangePasswordAtLogon = $mustChange
        Enabled               = $true
        Description           = $description
      }
      if ($path) { $newUserParams['Path'] = $path }
      try {
        $created = New-ADUser @newUserParams -PassThru -ErrorAction Stop
      } catch {
        Emit-ErrorResult -Message "New-ADUser failed: $($_.Exception.Message)" -ExitCode 1
      }
      $dn = [string]$created.DistinguishedName
      $stopwatch.Stop()
      [Console]::Out.WriteLine(([ordered]@{
        success    = $true
        data       = [ordered]@{ sam = $sam; dn = $dn; created = $true }
        error      = $null
        exitCode   = 0
        durationMs = [int]$stopwatch.ElapsedMilliseconds
      } | ConvertTo-Json -Depth 5 -Compress))
    }

    'user_password_reset' {
      if (-not $p.sam) { Emit-ErrorResult -Message 'sam required' }
      if (-not $p.newPassword) { Emit-ErrorResult -Message 'newPassword required' }
      $sam = [string]$p.sam
      $mustChange = if ($p.mustChangePassword -eq $true) { $true } else { $false }
      $unlock = if ($p.unlockAccount -eq $false) { $false } else { $true }
      $secure = To-SecureString -Plain ([string]$p.newPassword)
      try {
        Set-ADAccountPassword -Identity $sam -Reset -NewPassword $secure -ErrorAction Stop
      } catch {
        Emit-ErrorResult -Message "Set-ADAccountPassword failed: $($_.Exception.Message)" -ExitCode 1
      }
      try {
        Set-ADUser -Identity $sam -ChangePasswordAtLogon $mustChange -ErrorAction Stop
      } catch {
        Emit-ErrorResult -Message "Set-ADUser (mustChange) failed: $($_.Exception.Message)" -ExitCode 1
      }
      $unlocked = $false
      if ($unlock) {
        try {
          Unlock-ADAccount -Identity $sam -ErrorAction Stop
          $unlocked = $true
        } catch {
          # Unlock failure is non-fatal — the password reset already succeeded.
          Emit-ErrorResult -Message "Unlock-ADAccount failed: $($_.Exception.Message)" -ExitCode 1
        }
      }
      $stopwatch.Stop()
      [Console]::Out.WriteLine(([ordered]@{
        success    = $true
        data       = [ordered]@{ sam = $sam; passwordReset = $true; unlocked = $unlocked }
        error      = $null
        exitCode   = 0
        durationMs = [int]$stopwatch.ElapsedMilliseconds
      } | ConvertTo-Json -Depth 5 -Compress))
    }

    'user_enable' {
      if (-not $p.sam) { Emit-ErrorResult -Message 'sam required' }
      $sam = [string]$p.sam
      try {
        Enable-ADAccount -Identity $sam -ErrorAction Stop
        Set-ADUser -Identity $sam -Enabled $true -ErrorAction Stop
      } catch {
        Emit-ErrorResult -Message "Enable-ADAccount failed: $($_.Exception.Message)" -ExitCode 1
      }
      $stopwatch.Stop()
      [Console]::Out.WriteLine(([ordered]@{
        success    = $true
        data       = [ordered]@{ sam = $sam; enabled = $true }
        error      = $null
        exitCode   = 0
        durationMs = [int]$stopwatch.ElapsedMilliseconds
      } | ConvertTo-Json -Depth 5 -Compress))
    }

    'user_disable' {
      if (-not $p.sam) { Emit-ErrorResult -Message 'sam required' }
      $sam = [string]$p.sam
      try {
        Disable-ADAccount -Identity $sam -ErrorAction Stop
        Set-ADUser -Identity $sam -Enabled $false -ErrorAction Stop
      } catch {
        Emit-ErrorResult -Message "Disable-ADAccount failed: $($_.Exception.Message)" -ExitCode 1
      }
      $stopwatch.Stop()
      [Console]::Out.WriteLine(([ordered]@{
        success    = $true
        data       = [ordered]@{ sam = $sam; enabled = $false }
        error      = $null
        exitCode   = 0
        durationMs = [int]$stopwatch.ElapsedMilliseconds
      } | ConvertTo-Json -Depth 5 -Compress))
    }

    'user_unlock' {
      if (-not $p.sam) { Emit-ErrorResult -Message 'sam required' }
      $sam = [string]$p.sam
      try {
        Unlock-ADAccount -Identity $sam -ErrorAction Stop
      } catch {
        Emit-ErrorResult -Message "Unlock-ADAccount failed: $($_.Exception.Message)" -ExitCode 1
      }
      $stopwatch.Stop()
      [Console]::Out.WriteLine(([ordered]@{
        success    = $true
        data       = [ordered]@{ sam = $sam; unlocked = $true }
        error      = $null
        exitCode   = 0
        durationMs = [int]$stopwatch.ElapsedMilliseconds
      } | ConvertTo-Json -Depth 5 -Compress))
    }

    'user_set_attributes' {
      if (-not $p.sam) { Emit-ErrorResult -Message 'sam required' }
      $sam = [string]$p.sam
      if (-not $p.attributes) { Emit-ErrorResult -Message 'attributes required' }
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
          Set-ADUser -Identity $sam -Replace $replace -ErrorAction Stop
        } catch {
          Emit-ErrorResult -Message "Set-ADUser failed: $($_.Exception.Message)" -ExitCode 1
        }
      }
      $stopwatch.Stop()
      [Console]::Out.WriteLine(([ordered]@{
        success    = $true
        data       = [ordered]@{ sam = $sam; updatedFields = $updated }
        error      = $null
        exitCode   = 0
        durationMs = [int]$stopwatch.ElapsedMilliseconds
      } | ConvertTo-Json -Depth 5 -Compress))
    }

    'user_delete' {
      if (-not $p.sam) { Emit-ErrorResult -Message 'sam required' }
      $sam = [string]$p.sam
      try {
        Remove-ADUser -Identity $sam -Confirm:$false -ErrorAction Stop
      } catch {
        Emit-ErrorResult -Message "Remove-ADUser failed: $($_.Exception.Message)" -ExitCode 1
      }
      $stopwatch.Stop()
      [Console]::Out.WriteLine(([ordered]@{
        success    = $true
        data       = [ordered]@{ sam = $sam; deleted = $true }
        error      = $null
        exitCode   = 0
        durationMs = [int]$stopwatch.ElapsedMilliseconds
      } | ConvertTo-Json -Depth 5 -Compress))
    }

    'user_list_groups' {
      if (-not $p.sam) { Emit-ErrorResult -Message 'sam required' }
      $sam = [string]$p.sam
      try {
        $memberships = Get-ADPrincipalGroupMembership -Identity $sam -ErrorAction Stop
      } catch {
        Emit-ErrorResult -Message "Get-ADPrincipalGroupMembership failed: $($_.Exception.Message)" -ExitCode 1
      }
      $groups = @()
      foreach ($g in @($memberships)) {
        try {
          $full = Get-ADGroup -Identity $g -Property Description, GroupCategory, GroupScope -ErrorAction Stop
          $groups += [ordered]@{
            name     = [string]$full.Name
            dn       = [string]$full.DistinguishedName
            category = [string]$full.GroupCategory
            scope    = [string]$full.GroupScope
          }
        } catch {
          Emit-ErrorResult -Message "Get-ADGroup failed for member $($g.Name): $($_.Exception.Message)" -ExitCode 1
        }
      }
      $stopwatch.Stop()
      [Console]::Out.WriteLine(([ordered]@{
        success    = $true
        data       = [ordered]@{ sam = $sam; groups = $groups }
        error      = $null
        exitCode   = 0
        durationMs = [int]$stopwatch.ElapsedMilliseconds
      } | ConvertTo-Json -Depth 5 -Compress))
    }

    default {
      Emit-ErrorResult -Message "unknown user command_type: $CommandType" -ExitCode 1
    }
  }
} catch {
  # Defensive outer catch — any unhandled exception inside the switch
  # emits a structured error envelope rather than letting PowerShell
  # # surface a raw stack trace.
  $stopwatch.Stop()
  [Console]::Error.WriteLine($_.Exception.Message)
  Emit-ErrorResult -Message $_.Exception.Message -ExitCode 2
}
