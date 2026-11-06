# collect.ps1 - ad_account_change v1.0.0 (R158.72, 2026-10-11)
#
# R158.72 — operator directive "增加一个包, 用来判断当天用来新建、禁用的账户,
# 而且执行时间固定在每天晚上 2 点". 5 种动作类型 (created/modified/deleted/
# enabled/disabled), 24h cadence (intervalSec=86400), 跟 ad_admin_members 同
# 模式. "凌晨 2 点" 是期望语义 — NSSM boot 后 setInterval 每 86400s, 不是真
# cron.
#
# 输出 (wire shape):
#   { metrics: { agent_id, dc_name, domain_dn, change_date (CST yyyy-MM-dd),
#                entries: [
#                  { sam, display_name, action, created_at, modified_at }
#                ],
#                entries_count,
#                collected_at } }
#
# Single-DC 语义 = 中心端 MERGE ON (sam, action, change_date) 自动 dedup 实现
# — 所有 34 DC 都跑 collect.ps1, 中心 collapse 重复 row. 不需 agent 端自选 PDC.
#
# 5 actions:
#   created   = WhenCreated >= today_local_00:00
#   modified  = WhenChanged >= today_local_00:00 AND WhenCreated < today_local_00:00
#   deleted   = AD Recycle Bin Get-ADObject -IncludeDeletedObjects (用 try/catch 隔
#                离, 部分 DC 上 AD Recycle Bin 可能未启用, 失败不阻塞其他 4 种)
#   enabled   = Enabled -eq $true AND WhenChanged >= today_local_00:00
#                AND (UserAccountControl -band 2) -eq 0
#   disabled  = Enabled -eq $false AND WhenChanged >= today_local_00:00
#                AND (UserAccountControl -band 2) -eq 2
#
# R158.52 hardening pattern: $ErrorActionPreference = 'Continue' + 每个 AD
# call try/catch 隔离 + accumulated $lastErrorMessage. 0 主动 ship 接受
# (operator "永远不主动升级 agent 版本"), agent 0.1.3 fleet 拉到新 manifest
# 自动跑新包.

$ErrorActionPreference = 'Continue'

# R136 — force UTF-8 stdout so any Chinese text in .NET exception
# messages / display names survives the PS->agent->centre pipeline without
# being transcoded through the system ANSI codepage.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$server = $env:COMPUTERNAME
$collectedAt = (Get-Date).ToUniversalTime().ToString('o')

# CST today 00:00 = "today" boundary. AD 属性 WhenCreated / WhenChanged
# 是 UTC (DateTime UTC kind). 跟 AD 查询时, Get-ADUser 默认返回本地时区
# 时间; 但 WhenCreated/WhenChanged 是 UTC 时间戳 (AD 内部 stored as UTC).
# 我们用本地 today 00:00 转 UTC 跟 UTC 时间戳比对, 实现 "当日 0 点起".
$cst = [System.TimeZoneInfo]::FindSystemTimeZoneById('China Standard Time')
$nowCst = [System.TimeZoneInfo]::ConvertTimeFromUtc((Get-Date).ToUniversalTime(), $cst)
$todayLocalMidnightCst = [datetime]$nowCst.Date  # CST today 00:00
$todayLocalMidnightUtc = [System.TimeZoneInfo]::ConvertTimeToUtc($todayLocalMidnightCst, $cst)
$todayMidnightIso = $todayLocalMidnightUtc.ToString('o')

$changeDate = $nowCst.ToString('yyyy-MM-dd')

$entries = @()
$domainDn = $null
$lastErrorMessage = $null

try {
  if (-not (Get-Module -Name ActiveDirectory -ListAvailable)) {
    throw 'ActiveDirectory RSAT module not available'
  }
  if (-not (Get-Module -Name ActiveDirectory)) {
    Import-Module ActiveDirectory -ErrorAction Stop
  }
  # R158.52 — guard each AD call independently so a transient DNS
  # or replication outage doesn't silently null $domainDn.
  try {
    $domain = Get-ADDomain -ErrorAction Stop
    $domainDn = $domain.DistinguishedName
  } catch {
    $lastErrorMessage = "get_addomain: $($_.Exception.Message)"
  }

  # 拉所有用户 (Properties 拿 WhenCreated / WhenChanged / Enabled /
  # UserAccountControl). -Filter * 在 7500+ user 域上 ~30s 可接受 (跟
  # ad_admin_members 同域, 单台 PDC 跑; ad_admin_members 已 ship fleet
  # 24h cadence 验证).
  try {
    $users = Get-ADUser -Filter * -Properties SamAccountName, DisplayName, WhenCreated, WhenChanged, Enabled, UserAccountControl -ErrorAction Stop
  } catch {
    [Console]::Error.WriteLine("Get-ADUser failed: $($_.Exception.Message)")
    if (-not $lastErrorMessage) { $lastErrorMessage = "get_aduser: $($_.Exception.Message)" }
    $users = @()
  }

  foreach ($u in $users) {
    $sam = [string]$u.SamAccountName
    if ([string]::IsNullOrEmpty($sam)) { continue }
    $dn = [string]$u.DistinguishedName
    $displayName = $null
    if ($u.DisplayName) { $displayName = [string]$u.DisplayName }
    $whenCreated = $u.WhenCreated  # DateTime UTC
    $whenChanged = $u.WhenChanged  # DateTime UTC
    $enabled = [bool]$u.Enabled
    $uac = [int]$u.UserAccountControl
    $disabledBit = ($uac -band 2) -eq 2

    # 1) created — 当日新建
    if ($whenCreated -and $whenCreated -ge $todayLocalMidnightUtc) {
      $entries += @{
        sam          = $sam
        display_name = $displayName
        action       = 'created'
        created_at   = $whenCreated.ToString('o')
        modified_at  = $null
        dn           = $dn
      }
    }
    # 2) modified — 当日修改 (排除新建)
    elseif ($whenChanged -and $whenChanged -ge $todayLocalMidnightUtc) {
      # 仅算 modified (排除 created, created 已 record 上面)
      $entries += @{
        sam          = $sam
        display_name = $displayName
        action       = 'modified'
        created_at   = if ($whenCreated) { $whenCreated.ToString('o') } else { $null }
        modified_at  = $whenChanged.ToString('o')
        dn           = $dn
      }
    }
    # 3) enabled — 当日从禁用变启用 (Enabled=$true 且 Modified_When 当日 且
    #    UAC bit2=0)
    if ($enabled -and $whenChanged -and $whenChanged -ge $todayLocalMidnightUtc -and -not $disabledBit) {
      # 重复 modified 也算 enabled (operator 决策 5 种 action 全覆盖)
      $entries += @{
        sam          = $sam
        display_name = $displayName
        action       = 'enabled'
        created_at   = if ($whenCreated) { $whenCreated.ToString('o') } else { $null }
        modified_at  = $whenChanged.ToString('o')
        dn           = $dn
      }
    }
    # 4) disabled — 当日禁用 (Enabled=$false 且 Modified_When 当日 且
    #    UAC bit2=2)
    if (-not $enabled -and $whenChanged -and $whenChanged -ge $todayLocalMidnightUtc -and $disabledBit) {
      $entries += @{
        sam          = $sam
        display_name = $displayName
        action       = 'disabled'
        created_at   = if ($whenCreated) { $whenCreated.ToString('o') } else { $null }
        modified_at  = $whenChanged.ToString('o')
        dn           = $dn
      }
    }
  }

  # 5) deleted — AD Recycle Bin. -IncludeDeletedObjects 需要 forest-level
  #    功能 (默认开启); 部分环境可能未启用, 单独 try/catch 隔离不阻塞其他.
  try {
    $deleted = Get-ADObject -Filter 'isDeleted -eq $true -and objectClass -eq "user"' -IncludeDeletedObjects -Properties SamAccountName, DisplayName, whenChanged -ErrorAction Stop
    foreach ($d in $deleted) {
      $dsam = [string]$d.SamAccountName
      if ([string]::IsNullOrEmpty($dsam)) { continue }
      $ddisplay = $null
      if ($d.DisplayName) { $ddisplay = [string]$d.DisplayName }
      $dchanged = $d.whenChanged
      if ($dchanged -and $dchanged -ge $todayLocalMidnightUtc) {
        $entries += @{
          sam          = $dsam
          display_name = $ddisplay
          action       = 'deleted'
          created_at   = $null
          modified_at  = $dchanged.ToString('o')
          dn           = [string]$d.DistinguishedName
        }
      }
    }
  } catch {
    # AD Recycle Bin 未启用或权限不足, 不阻塞其他 4 种 action
    [Console]::Error.WriteLine("Get-ADObject -IncludeDeletedObjects failed (skipping deleted action): $($_.Exception.Message)")
    if (-not $lastErrorMessage) { $lastErrorMessage = "deleted_objects: $($_.Exception.Message)" }
  }
} catch {
  [Console]::Error.WriteLine("ad_account_change init failed: $($_.Exception.Message)")
  $lastErrorMessage = "init: $($_.Exception.Message)"
}

$metrics = @{
  agent_id      = $server
  dc_name       = $server
  domain_dn     = $domainDn
  change_date   = $changeDate
  entries       = $entries
  entries_count = [int](@($entries).Count)
  collected_at  = $collectedAt
  error_code    = if ($lastErrorMessage) { 1 } else { 0 }
}

$payload = @{ metrics = $metrics }
if ($lastErrorMessage) { $payload.error = $lastErrorMessage }
$payload | ConvertTo-Json -Compress -Depth 6
exit 0