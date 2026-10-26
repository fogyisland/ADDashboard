# ad-admin-users.ps1 - R75/R158.46 (2026-10-06)
#
# AD user write-action dispatcher (agent side). Invoked by
# agent/src/dispatchers/ad-admin.js for any user_* commandType from
# center ad_admin_commands queue.
#
# Invocation (dispatcher contract):
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass ^
#     -File ad-admin-users.ps1 ^
#     -CommandType <user_search|user_create|user_password_reset|user_enable|
#                   user_disable|user_unlock|user_set_attributes|user_set_manager|
#                   user_delete|user_list_groups> ^
#     -ParamsPath <tmpfile.json>
#
# Params file: JSON object the PS1 reads via Get-Content | ConvertFrom-Json.
#   user_search:         { filter, limit }
#   user_create:         { sam, password, mustChangePassword,
#                          givenName, surname, displayName, upn, ouPath, description }
#   user_password_reset: { sam, newPassword, mustChangePassword, unlockAccount }
#   user_enable:         { sam }
#   user_disable:        { sam }
#   user_unlock:         { sam }
#   user_set_attributes: { sam, attributes: {displayName,description,...} }
#   user_set_manager:    { sam, managerSam, managerDistinguishedName? }
#   user_delete:         { sam }
#   user_list_groups:    { sam }
#
# Wire shape (per-run, PS1 -> dispatcher stdout last-line JSON):
#   {
#     success: true|false,
#     data:    <object|null>,     # command-specific result
#     error:   <string|null>,
#     exitCode: <number>,
#     durationMs: <number>
#   }
#
# The dispatcher parses the LAST non-empty stdout line as JSON; anything
# written before that line is ignored. Warnings go to [Console]::Error to
# avoid polluting the JSON parse stream.

$ErrorActionPreference = 'Stop'

# R136 encoding fix (unchanged from R158.34 quickfix template): PS 5.1
# default [Console]::OutputEncoding is the system ANSI codepage
# (CP936/GB18030 on CN Windows). Set UTF8 so ConvertTo-Json emits the
# original .NET bytes verbatim — the centre's NVARCHAR column sees the
# correct UTF-16 code points for Chinese chars in displayName etc.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'

$server = $env:COMPUTERNAME

# ── Parse arguments ────────────────────────────────────────────────────
$commandType = $null
$paramsPath = $null
for ($i = 0; $i -lt $args.Count; $i++) {
  $a = $args[$i]
  switch ($a) {
    '-CommandType' { $commandType = $args[++$i] }
    '-ParamsPath'  { $paramsPath  = $args[++$i] }
    default { [Console]::Error.WriteLine("unknown arg: $a") }
  }
}

# ── Idle mode (collect loop trigger — should never happen, defensive) ──
if (-not $commandType -or -not $paramsPath) {
  @{
    success    = $false
    data       = $null
    error      = 'missing -CommandType or -ParamsPath'
    exitCode   = 1
    durationMs = 0
  } | ConvertTo-Json -Compress -Depth 6
  exit 1
}

# ── Load params ────────────────────────────────────────────────────────
if (-not (Test-Path -LiteralPath $paramsPath)) {
  @{
    success    = $false
    data       = $null
    error      = "params file not found: $paramsPath"
    exitCode   = 1
    durationMs = 0
  } | ConvertTo-Json -Compress -Depth 6
  exit 1
}
try {
  $params = Get-Content -LiteralPath $paramsPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
  @{
    success    = $false
    data       = $null
    error      = "params JSON parse failed: $($_.Exception.Message)"
    exitCode   = 1
    durationMs = 0
  } | ConvertTo-Json -Compress -Depth 6
  exit 1
}

# ── Import AD module (RSAT check — match quickfix pattern) ─────────────
try {
  Import-Module ActiveDirectory -ErrorAction Stop
} catch {
  @{
    success    = $false
    data       = $null
    error      = "Import-Module ActiveDirectory failed: $($_.Exception.Message) (RSAT not installed?)"
    exitCode   = 1
    durationMs = 0
  } | ConvertTo-Json -Compress -Depth 6
  exit 1
}

# R158.56c-d (2026-10-09) — fix FormatException. `Get-Date -UFormat %s.%N`
# 不可移植: Windows PowerShell 5.1 + PS7 都不识别 `%N` 纳秒格式说明符
# (Unix glibc strftime 才有), 实测输出 "1759935261.%N" 字面量 →
# [double]::Parse 抛 FormatException ("输入字符串的格式不正确").
# KDLBJOFADSRV1 task KDLBJOFADSRV1-20261009005128357 user_create 重现.
# 改用 [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() 拿 Unix ms,
# 跟 platform 完全无关, 100% PS5.1+ 兼容 (R158.56c ad_ad_ou_create 1.0.0 同款修复).
$startMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

# ── Command dispatch ──────────────────────────────────────────────────
function Emit-Result {
  param(
    [bool]$success,
    $data,
    [string]$error,
    [int]$exitCode,
    [int]$startMsLocal
  )
  $endMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  @{
    success    = $success
    data       = $data
    error      = if ($error) { $error } else { $null }
    exitCode   = $exitCode
    durationMs = $endMs - $startMsLocal
  } | ConvertTo-Json -Compress -Depth 8
}

function Fail {
  param([string]$msg, [int]$code = 1)
  Emit-Result -success $false -data $null -error $msg -exitCode $code -startMsLocal $startMs
  exit $code
}

switch ($commandType) {

  # ── user_search — list users via AD filter ───────────────────────────
  'user_search' {
    $filter = if ($params.filter) { [string]$params.filter } else { '*' }
    $limit  = if ($params.limit) { [int]$params.limit } else { 200 }
    try {
      $users = Get-ADUser -Filter $filter -Properties samAccountName, displayName, givenName, surname, mail, enabled, whenCreated -ErrorAction Stop -ResultSetSize $limit
      $list = @()
      foreach ($u in $users) {
        $list += @{
          sam          = $u.samAccountName
          displayName  = $u.displayName
          givenName    = $u.givenName
          surname      = $u.surname
          mail         = $u.mail
          enabled      = $u.enabled
          whenCreated  = if ($u.whenCreated) { $u.whenCreated.ToUniversalTime().ToString('o') } else { $null }
          distinguishedName = $u.DistinguishedName
        }
      }
      Emit-Result -success $true -data @{ count = $list.Count; users = $list } -error $null -exitCode 0 -startMsLocal $startMs
      exit 0
    } catch {
      Fail -msg "Get-ADUser failed: $($_.Exception.Message)"
    }
  }

  # ── user_create — New-ADUser ────────────────────────────────────────
  'user_create' {
    if (-not $params.sam)      { Fail 'sam required' }
    if (-not $params.password) { Fail 'password required' }
    try {
      $secPwd = ConvertTo-SecureString ([string]$params.password) -AsPlainText -Force
      $props = @{
        Name              = [string]$params.sam
        SamAccountName    = [string]$params.sam
        AccountPassword   = $secPwd
        Enabled           = $true
      }
      if ($params.ouPath)         { $props['Path'] = [string]$params.ouPath }
      if ($params.givenName)      { $props['GivenName'] = [string]$params.givenName }
      if ($params.surname)        { $props['Surname']   = [string]$params.surname }
      if ($params.displayName)    { $props['DisplayName'] = [string]$params.displayName }
      if ($params.upn)            { $props['UserPrincipalName'] = [string]$params.upn }
      if ($params.description)    { $props['Description'] = [string]$params.description }
      $newUser = New-ADUser @props -PassThru -ErrorAction Stop
      # Must-change-password-at-next-logon
      if ($params.mustChangePassword -eq $true) {
        try {
          Set-ADUser -Identity $newUser -ChangePasswordAtLogon $true -ErrorAction Stop
        } catch {
          [Console]::Error.WriteLine("Set-ADUser ChangePasswordAtLogon failed: $($_.Exception.Message)")
        }
      }
      Emit-Result -success $true -data @{
        sam               = $newUser.samAccountName
        distinguishedName = $newUser.DistinguishedName
      } -error $null -exitCode 0 -startMsLocal $startMs
      exit 0
    } catch {
      Fail -msg "New-ADUser failed: $($_.Exception.Message)"
    }
  }

  # ── user_password_reset — Set-ADAccountPassword ─────────────────────
  'user_password_reset' {
    if (-not $params.sam)         { Fail 'sam required' }
    if (-not $params.newPassword) { Fail 'newPassword required' }
    try {
      $adUser = Get-ADUser -Identity ([string]$params.sam) -ErrorAction Stop
      $secPwd = ConvertTo-SecureString ([string]$params.newPassword) -AsPlainText -Force
      Set-ADAccountPassword -Identity $adUser -Reset -NewPassword $secPwd -ErrorAction Stop
      if ($params.mustChangePassword -eq $true) {
        try { Set-ADUser -Identity $adUser -ChangePasswordAtLogon $true -ErrorAction Stop }
        catch { [Console]::Error.WriteLine("Set-ADUser ChangePasswordAtLogon failed: $($_.Exception.Message)") }
      }
      if ($params.unlockAccount -ne $false) {
        try { Unlock-ADAccount -Identity $adUser -ErrorAction Stop }
        catch { [Console]::Error.WriteLine("Unlock-ADAccount failed: $($_.Exception.Message)") }
      }
      Emit-Result -success $true -data @{
        sam = $adUser.samAccountName
        passwordReset = $true
        unlocked      = ($params.unlockAccount -ne $false)
      } -error $null -exitCode 0 -startMsLocal $startMs
      exit 0
    } catch {
      Fail -msg "password reset failed: $($_.Exception.Message)"
    }
  }

  # ── user_enable / user_disable / user_unlock — atomic flag flips ────
  'user_enable' {
    if (-not $params.sam) { Fail 'sam required' }
    try {
      Enable-ADAccount -Identity ([string]$params.sam) -ErrorAction Stop
      Emit-Result -success $true -data @{ sam = [string]$params.sam; enabled = $true } -error $null -exitCode 0 -startMsLocal $startMs
      exit 0
    } catch { Fail -msg "Enable-ADAccount failed: $($_.Exception.Message)" }
  }
  'user_disable' {
    if (-not $params.sam) { Fail 'sam required' }
    try {
      Disable-ADAccount -Identity ([string]$params.sam) -ErrorAction Stop
      Emit-Result -success $true -data @{ sam = [string]$params.sam; enabled = $false } -error $null -exitCode 0 -startMsLocal $startMs
      exit 0
    } catch { Fail -msg "Disable-ADAccount failed: $($_.Exception.Message)" }
  }
  'user_unlock' {
    if (-not $params.sam) { Fail 'sam required' }
    try {
      Unlock-ADAccount -Identity ([string]$params.sam) -ErrorAction Stop
      Emit-Result -success $true -data @{ sam = [string]$params.sam; unlocked = $true } -error $null -exitCode 0 -startMsLocal $startMs
      exit 0
    } catch { Fail -msg "Unlock-ADAccount failed: $($_.Exception.Message)" }
  }

  # ── user_set_attributes — generic Set-ADUser field set ──────────────
  'user_set_attributes' {
    if (-not $params.sam)              { Fail 'sam required' }
    if (-not $params.attributes)       { Fail 'attributes object required' }
    try {
      $adUser = Get-ADUser -Identity ([string]$params.sam) -ErrorAction Stop
      $setParams = @{}
      foreach ($prop in $params.attributes.PSObject.Properties) {
        # Allowed fields only (no sAMAccountName / SID / password fields via this path)
        switch ($prop.Name) {
          'displayName'   { $setParams['DisplayName']   = [string]$prop.Value }
          'description'   { $setParams['Description']   = [string]$prop.Value }
          'givenName'     { $setParams['GivenName']     = [string]$prop.Value }
          'surname'       { $setParams['Surname']       = [string]$prop.Value }
          'mail'          { $setParams['EmailAddress']   = [string]$prop.Value }
          'title'         { $setParams['Title']         = [string]$prop.Value }
          'department'    { $setParams['Department']    = [string]$prop.Value }
          'company'       { $setParams['Company']       = [string]$prop.Value }
          'telephoneNumber' { $setParams['OfficePhone'] = [string]$prop.Value }
          'mobile'        { $setParams['MobilePhone']   = [string]$prop.Value }
          default {
            [Console]::Error.WriteLine("ignored field: $($prop.Name)")
          }
        }
      }
      if ($setParams.Count -gt 0) {
        Set-ADUser -Identity $adUser @setParams -ErrorAction Stop
      }
      Emit-Result -success $true -data @{
        sam = $adUser.samAccountName
        attributesSet = $setParams.Count
      } -error $null -exitCode 0 -startMsLocal $startMs
      exit 0
    } catch { Fail -msg "Set-ADUser failed: $($_.Exception.Message)" }
  }

  # ── user_set_manager — R158.36 ──────────────────────────────────────
  'user_set_manager' {
    if (-not $params.sam) { Fail 'sam required' }
    try {
      $adUser = Get-ADUser -Identity ([string]$params.sam) -ErrorAction Stop
      if ($params.managerSam) {
        $mgr = Get-ADUser -Identity ([string]$params.managerSam) -ErrorAction Stop
        Set-ADUser -Identity $adUser -Manager $mgr -ErrorAction Stop
        Emit-Result -success $true -data @{
          sam        = $adUser.samAccountName
          managerSam = $mgr.samAccountName
        } -error $null -exitCode 0 -startMsLocal $startMs
      } elseif ($params.managerDistinguishedName) {
        Set-ADUser -Identity $adUser -Manager ([string]$params.managerDistinguishedName) -ErrorAction Stop
        Emit-Result -success $true -data @{
          sam                    = $adUser.samAccountName
          managerDistinguishedName = [string]$params.managerDistinguishedName
        } -error $null -exitCode 0 -startMsLocal $startMs
      } else {
        # Clear manager
        Set-ADUser -Identity $adUser -Clear manager -ErrorAction Stop
        Emit-Result -success $true -data @{
          sam        = $adUser.samAccountName
          managerSam = $null
        } -error $null -exitCode 0 -startMsLocal $startMs
      }
      exit 0
    } catch { Fail -msg "user_set_manager failed: $($_.Exception.Message)" }
  }

  # ── user_delete — Remove-ADUser ─────────────────────────────────────
  'user_delete' {
    if (-not $params.sam) { Fail 'sam required' }
    try {
      Remove-ADUser -Identity ([string]$params.sam) -Confirm:$false -ErrorAction Stop
      Emit-Result -success $true -data @{ sam = [string]$params.sam } -error $null -exitCode 0 -startMsLocal $startMs
      exit 0
    } catch { Fail -msg "Remove-ADUser failed: $($_.Exception.Message)" }
  }

  # ── user_list_groups — Get-ADPrincipalGroupMembership ───────────────
  'user_list_groups' {
    if (-not $params.sam) { Fail 'sam required' }
    try {
      $adUser  = Get-ADUser -Identity ([string]$params.sam) -ErrorAction Stop
      $groups  = Get-ADPrincipalGroupMembership -Identity $adUser -ErrorAction Stop
      $list = @()
      foreach ($g in $groups) {
        $list += @{ name = $g.Name; distinguishedName = $g.DistinguishedName }
      }
      Emit-Result -success $true -data @{
        sam    = $adUser.samAccountName
        groups = $list
        count  = $list.Count
      } -error $null -exitCode 0 -startMsLocal $startMs
      exit 0
    } catch { Fail -msg "user_list_groups failed: $($_.Exception.Message)" }
  }

  default {
    Fail -msg "unsupported commandType: $commandType"
  }
}