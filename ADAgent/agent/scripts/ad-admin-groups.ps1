# ad-admin-groups.ps1 - R75/R158.46 (2026-10-06)
#
# AD group write-action dispatcher (agent side). Invoked by
# agent/src/dispatchers/ad-admin.js for any group_* commandType from
# center ad_admin_commands queue.
#
# Invocation (dispatcher contract):
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass ^
#     -File ad-admin-groups.ps1 ^
#     -CommandType <group_search|group_create|group_set_attributes|
#                   group_add_member|group_remove_member|group_set_members|
#                   group_delete|group_list_members> ^
#     -ParamsPath <tmpfile.json>
#
# Params file: JSON object the PS1 reads via Get-Content | ConvertFrom-Json.
#   group_search:         { filter, limit }
#   group_create:         { name, sam?, displayName?, category (Security/Distribution),
#                           scope (DomainLocal/Global/Universal), ouPath?, description?, mail? }
#   group_set_attributes: { name, attributes: {displayName,description,mail,...} }
#   group_add_member:     { name, members: [<sam-or-dn>, ...] }
#   group_remove_member:  { name, members: [<sam-or-dn>, ...] }
#   group_set_members:    { name, members: [<sam-or-dn>, ...] }    # full replace
#   group_delete:         { name }
#   group_list_members:   { name, page?, size? }
#
# Wire shape (per-run, PS1 -> dispatcher stdout last-line JSON):
#   {
#     success: true|false,
#     data:    <object|null>,
#     error:   <string|null>,
#     exitCode: <number>,
#     durationMs: <number>
#   }

$ErrorActionPreference = 'Stop'

# R136 encoding fix — see ad-admin-users.ps1 header.
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

# R158.56c-d (2026-10-09) — 跟 ad-admin-users.ps1 同款 FormatException fix.
# 改 [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() 替代
# [int][double]::Parse((Get-Date -UFormat %s.%N)). 详见 ad-admin-users.ps1:115.
$startMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

function Emit-Result {
  param(
    [bool]$success,
    $data,
    [string]$error,
    [int]$exitCode,
    [long]$startMsLocal   # R158.60.12 — 13 位 Unix ms > Int32.MaxValue, 用 long
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

# Helper: resolve a sam-or-DN list into a list of AD object references,
# failing if any is missing.
function Resolve-Members {
  param([object[]]$members)
  $resolved = @()
  foreach ($m in $members) {
    $id = [string]$m
    if (-not $id) { continue }
    $obj = $null
    # If it looks like a DN (contains '=') try Get-ADObject first; else try Get-ADUser then Get-ADGroup.
    if ($id.Contains('=')) {
      try {
        $obj = Get-ADObject -Identity $id -ErrorAction Stop
      } catch {
        throw "member DN not found: $id ($($_.Exception.Message))"
      }
    } else {
      try { $obj = Get-ADUser -Identity $id -ErrorAction Stop } catch {}
      if (-not $obj) {
        try { $obj = Get-ADGroup -Identity $id -ErrorAction Stop } catch {}
      }
      if (-not $obj) { throw "member not found (user/group): $id" }
    }
    $resolved += $obj
  }
  return $resolved
}

switch ($commandType) {

  # ── group_search ─────────────────────────────────────────────────────
  'group_search' {
    $filter = if ($params.filter) { [string]$params.filter } else { '*' }
    $limit  = if ($params.limit) { [int]$params.limit } else { 200 }
    try {
      # R158.50.5 (2026-10-07) — 加 members 属性拉取. Get-ADGroup 默认不拉
      # `members`, 必须显式 -Properties members. 输出 memberCount 字段,
      # 前端 GroupPropertyPanel 模板读 `group.memberCount`, live 模式两端
      # wire shape 对齐. 注意: Get-ADGroup 取顶层 member (不递归), 大组
      # (Domain Users 8000+) 会被 AD MaxValRange=1500 截断; 后端 snapshot
      # 走 'member;range=0-*' 累加才准, live 路径性能可接受 (drill-down).
      $groups = Get-ADGroup -Filter $filter -Properties displayName, description, mail, groupCategory, groupScope, members -ErrorAction Stop -ResultSetSize $limit
      $list = @()
      foreach ($g in $groups) {
        $memberCount = 0
        if ($g.members) {
          try { $memberCount = @($g.members).Count } catch { $memberCount = 0 }
        }
        $list += @{
          name              = $g.Name
          sam               = $g.samAccountName
          displayName       = $g.displayName
          description       = $g.description
          mail              = $g.mail
          category          = $g.groupCategory
          scope             = $g.groupScope
          distinguishedName = $g.DistinguishedName
          memberCount       = $memberCount
        }
      }
      Emit-Result -success $true -data @{ count = $list.Count; groups = $list } -error $null -exitCode 0 -startMsLocal $startMs
      exit 0
    } catch { Fail -msg "Get-ADGroup failed: $($_.Exception.Message)" }
  }

  # ── group_create — New-ADGroup ──────────────────────────────────────
  'group_create' {
    if (-not $params.name)     { Fail 'name required' }
    if (-not $params.category) { Fail 'category required (Security|Distribution)' }
    if (-not $params.scope)    { Fail 'scope required (DomainLocal|Global|Universal)' }
    try {
      $props = @{
          Name       = [string]$params.name
          GroupScope = [string]$params.scope
          GroupCategory = [string]$params.category
        }
      if ($params.sam)         { $props['SamAccountName'] = [string]$params.sam }
      if ($params.displayName) { $props['DisplayName']    = [string]$params.displayName }
      if ($params.description) { $props['Description']    = [string]$params.description }
      if ($params.ouPath)      { $props['Path']           = [string]$params.ouPath }
      if ($params.mail)        { $props['Mail']           = [string]$params.mail }
      $newGroup = New-ADGroup @props -PassThru -ErrorAction Stop
      Emit-Result -success $true -data @{
        name              = $newGroup.Name
        sam               = $newGroup.samAccountName
        distinguishedName = $newGroup.DistinguishedName
      } -error $null -exitCode 0 -startMsLocal $startMs
      exit 0
    } catch { Fail -msg "New-ADGroup failed: $($_.Exception.Message)" }
  }

  # ── group_set_attributes — generic Set-ADGroup field set ───────────
  'group_set_attributes' {
    if (-not $params.name)        { Fail 'name required' }
    if (-not $params.attributes)  { Fail 'attributes object required' }
    try {
      $group = Get-ADGroup -Identity ([string]$params.name) -ErrorAction Stop
      $setParams = @{}
      foreach ($prop in $params.attributes.PSObject.Properties) {
        switch ($prop.Name) {
          'displayName' { $setParams['DisplayName'] = [string]$prop.Value }
          'description' { $setParams['Description'] = [string]$prop.Value }
          'mail'        { $setParams['Mail']        = [string]$prop.Value }
          'managedBy'   {
            try {
              $mgr = Get-ADUser -Identity ([string]$prop.Value) -ErrorAction Stop
              $setParams['ManagedBy'] = $mgr.DistinguishedName
            } catch {
              try {
                $mgr = Get-ADGroup -Identity ([string]$prop.Value) -ErrorAction Stop
                $setParams['ManagedBy'] = $mgr.DistinguishedName
              } catch {
                $setParams['ManagedBy'] = [string]$prop.Value
              }
            }
          }
          default { [Console]::Error.WriteLine("ignored field: $($prop.Name)") }
        }
      }
      if ($setParams.Count -gt 0) {
        Set-ADGroup -Identity $group @setParams -ErrorAction Stop
      }
      Emit-Result -success $true -data @{
        name          = $group.Name
        attributesSet = $setParams.Count
      } -error $null -exitCode 0 -startMsLocal $startMs
      exit 0
    } catch { Fail -msg "Set-ADGroup failed: $($_.Exception.Message)" }
  }

  # ── group_add_member — Add-ADGroupMember ─────────────────────────────
  'group_add_member' {
    if (-not $params.name)               { Fail 'name required' }
    if (-not $params.members -or $params.members.Count -eq 0) { Fail 'members required' }
    try {
      $group = Get-ADGroup -Identity ([string]$params.name) -ErrorAction Stop
      $objs = Resolve-Members -members ([array]$params.members)
      Add-ADGroupMember -Identity $group -Members $objs -ErrorAction Stop
      Emit-Result -success $true -data @{
        name            = $group.Name
        added           = @($objs | ForEach-Object { $_.samAccountName })
        addedCount      = $objs.Count
      } -error $null -exitCode 0 -startMsLocal $startMs
      exit 0
    } catch { Fail -msg "Add-ADGroupMember failed: $($_.Exception.Message)" }
  }

  # ── group_remove_member — Remove-ADGroupMember ──────────────────────
  'group_remove_member' {
    if (-not $params.name)               { Fail 'name required' }
    if (-not $params.members -or $params.members.Count -eq 0) { Fail 'members required' }
    try {
      $group = Get-ADGroup -Identity ([string]$params.name) -ErrorAction Stop
      $objs = Resolve-Members -members ([array]$params.members)
      Remove-ADGroupMember -Identity $group -Members $objs -Confirm:$false -ErrorAction Stop
      Emit-Result -success $true -data @{
        name          = $group.Name
        removed       = @($objs | ForEach-Object { $_.samAccountName })
        removedCount  = $objs.Count
      } -error $null -exitCode 0 -startMsLocal $startMs
      exit 0
    } catch { Fail -msg "Remove-ADGroupMember failed: $($_.Exception.Message)" }
  }

  # ── group_set_members — full replace (Set-ADGroup -Members/-Clear) ──
  'group_set_members' {
    if (-not $params.name) { Fail 'name required' }
    try {
      $group = Get-ADGroup -Identity ([string]$params.name) -ErrorAction Stop
      $objs = Resolve-Members -members ([array]$params.members)
      Set-ADGroup -Identity $group -Clear members -ErrorAction Stop
      if ($objs.Count -gt 0) {
        Add-ADGroupMember -Identity $group -Members $objs -ErrorAction Stop
      }
      Emit-Result -success $true -data @{
        name           = $group.Name
        members        = @($objs | ForEach-Object { $_.samAccountName })
        membersCount   = $objs.Count
      } -error $null -exitCode 0 -startMsLocal $startMs
      exit 0
    } catch { Fail -msg "group_set_members failed: $($_.Exception.Message)" }
  }

  # ── group_delete — Remove-ADGroup ───────────────────────────────────
  'group_delete' {
    if (-not $params.name) { Fail 'name required' }
    try {
      Remove-ADGroup -Identity ([string]$params.name) -Confirm:$false -ErrorAction Stop
      Emit-Result -success $true -data @{ name = [string]$params.name } -error $null -exitCode 0 -startMsLocal $startMs
      exit 0
    } catch { Fail -msg "Remove-ADGroup failed: $($_.Exception.Message)" }
  }

  # ── group_list_members — Get-ADGroupMember (paginated) ──────────────
  'group_list_members' {
    if (-not $params.name) { Fail 'name required' }
    $size  = if ($params.size)  { [int]$params.size }  else { 100 }
    $page  = if ($params.page)  { [int]$params.page }  else { 1 }
    if ($page -lt 1) { $page = 1 }
    try {
      $group = Get-ADGroup -Identity ([string]$params.name) -ErrorAction Stop
      $allMembers = Get-ADGroupMember -Identity $group -Recursive:$false -ErrorAction Stop
      $list = @()
      foreach ($m in $allMembers) {
        $list += @{
          sam               = $m.samAccountName
          objectClass       = $m.objectClass
          distinguishedName = $m.DistinguishedName
        }
      }
      $total  = $list.Count
      $skip   = ($page - 1) * $size
      $sliced = if ($skip -ge $total) { @() } else { $list[$skip..([Math]::Min($skip + $size - 1, $total - 1))] }
      Emit-Result -success $true -data @{
        name       = $group.Name
        members    = $sliced
        page       = $page
        size       = $size
        totalCount = $total
      } -error $null -exitCode 0 -startMsLocal $startMs
      exit 0
    } catch { Fail -msg "group_list_members failed: $($_.Exception.Message)" }
  }

  default {
    Fail -msg "unsupported commandType: $commandType"
  }
}