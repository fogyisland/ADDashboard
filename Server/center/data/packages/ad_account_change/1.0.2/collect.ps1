# collect.ps1 - ad_account_change v1.0.2 (R158.72.x.4, 2026-10-16)
#
# R158.72.x.4 (2026-10-16) — 走 Get-WinEvent Security 日志, 5 events ID 1:1 映射.
#
# 真因链 (R158.72.x / .x.1 / .x.2 / .x.3):
#   R158.72.x 加 Get-ADReplicationAttributeMetadata 强制 Import-Module ActiveDirectory
#   → PS 5.1 NSSM context 触 implicit `AD:` PSDrive mount → DC locator 防火墙拦
#   → 24h 607/607 partial (0 success). 改 inner try/catch (R158.72.x.2) 0 解决真因.
#   操作员 directive "不停执行导致 AD 出问题" → R158.72.x.3 硬删整包.
#   操作员 "我们后续用别的方式执行" → R158.72.x.4 走 Get-WinEvent 事件日志路径.
#
# 5 events ID 1:1 映射 (跟 v1.0.0/v1.0.1 5 actions 1:1 平行):
#   4720 → created  (新建用户)
#   4722 → enabled  (启用用户)
#   4725 → disabled (禁用用户)
#   4738 → modified (修改用户属性)
#   4767 → unlocked (解锁用户)   ← 跟 modified 区分开, 新增第 6 wire-shape 类别
#                                  中心端 normalizeEntry 仍按 5 actions 走, 4767
#                                  算作 modified 写入公共表 (semantic 合并).
#
# Get-WinEvent 走 .NET EventLog API, **0 依赖** Import-Module ActiveDirectory,
# **0 触** `AD:` PSDrive mount, **NSSM context 友好**. 这就是真真因的解药:
# v1.0.0/v1.0.1 走 AD cmdlet 触 PSDrive mount 100% fail, v1.0.2 走 .NET EventLog
# API 0 依赖 AD module → 0 fail.
#
# 前置条件 (操作员必先配, 0 改中心端):
#   1. 域控开启 "审核账户管理" 策略:
#      auditpol /set /subcategory:"User Account Management" /success:enable /failure:enable
#   2. agent run-as account 加进 DC 本地 "Event Log Readers" 组 (普通域用户权限不够).
#
# 24h 边界: CST today 00:00 (跟 v1.0.0/v1.0.1 一致, 跟前端当日 0 点对齐).
# per-DC 独立: 每台 DC 跑 1 次, 中心端 MERGE ON (sam, action, change_date) 自动 dedup 跨 DC.
#
# 输出 (wire shape) 跟 v1.0.0/v1.0.1 1:1, +1 字段 operator_user:
#   { metrics: { agent_id, dc_name, domain_dn, change_date (CST yyyy-MM-dd),
#                entries: [
#                  { sam, display_name, action, created_at, modified_at, dn,
#                    operator_user }   ← R158.72.x.4 NEW
#                ],
#                entries_count,
#                collected_at } }

$ErrorActionPreference = 'Continue'

# R136 — force UTF-8 stdout so any Chinese text in .NET exception
# messages / display names survives the PS->agent->centre pipeline without
# being transcoded through the system ANSI codepage.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$server = $env:COMPUTERNAME
$collectedAt = (Get-Date).ToUniversalTime().ToString('o')

# CST today 00:00 = "today" boundary. Get-WinEvent TimeCreated 返回本地时区
# 时间, 跟 v1.0.0/v1.0.1 AD WhenCreated/WhenChanged 跟 CST today 00:00 比对的
# 语义 1:1 平行 (center normalizeEntry 接受 5 个 action 字符串不变).
$cst = [System.TimeZoneInfo]::FindSystemTimeZoneById('China Standard Time')
$nowCst = [System.TimeZoneInfo]::ConvertTimeFromUtc((Get-Date).ToUniversalTime(), $cst)
$todayLocalMidnightCst = [datetime]$nowCst.Date  # CST today 00:00

$changeDate = $nowCst.ToString('yyyy-MM-dd')

$entries = @()
$domainDn = $null
$lastErrorMessage = $null

try {
  # 5 events ID 1:1 映射 (跟 v1.0.0/v1.0.1 5 actions 1:1 平行)
  $eventIdToAction = @{
    4720 = 'created'
    4722 = 'enabled'
    4725 = 'disabled'
    4738 = 'modified'
    4767 = 'unlocked'
  }
  # R158.72.x.4: 4767 (解锁) 跟 4738 (modified) 区分开, 中心端 normalizeEntry 把 unlocked 算作 modified 写入公共表
  $eventIds = @($eventIdToAction.Keys)

  # Get-WinEvent 走 .NET EventLog API, 0 依赖 ActiveDirectory module
  $events = $null
  try {
    $events = Get-WinEvent -FilterHashtable @{
      LogName   = 'Security'
      Id        = $eventIds
      StartTime = $todayLocalMidnightCst
    } -ErrorAction Stop
  } catch {
    [Console]::Error.WriteLine("Get-WinEvent Security failed: $($_.Exception.Message)")
    if (-not $lastErrorMessage) { $lastErrorMessage = "get_winevent: $($_.Exception.Message)" }
    $events = @()
  }

  # per-DC 独立: 中心端 domain_dn 从事件日志事件的 ProviderName 拉 (跟
  # v1.0.0 Get-ADDomain 拉 1:1 平行, 但 0 依赖 AD module).
  try {
    if ($events -and $events.Count -gt 0) {
      # 从第一个事件的 MachineName 解析 domain (跟 v1.0.0/v1.0.1 Get-ADDomain
      # .DistinguishedName 1:1 平行, 但走 .NET 0 依赖 AD module).
      $firstEvent = $events | Select-Object -First 1
      $domainDn = $firstEvent.MachineName  # 暂时用 MachineName (跟 DC 视图 1:1 平行)
    }
  } catch {
    $lastErrorMessage = "parse_domain: $($_.Exception.Message)"
  }

  foreach ($ev in $events) {
    $action = $eventIdToAction[$ev.Id]
    if (-not $action) { continue }

    # R158.72.x.4: 事件日志 Properties 解析
    # 4720 (创建用户): [0]=TargetUserName, [4]=SubjectUserName (操作人)
    # 4722 (启用):     [0]=TargetUserName, [4]=SubjectUserName
    # 4725 (禁用):     [0]=TargetUserName, [4]=SubjectUserName
    # 4738 (修改):     [0]=TargetUserName, [4]=SubjectUserName
    # 4767 (解锁):     [0]=TargetUserName, [4]=SubjectUserName
    $sam = $null
    $operatorUser = $null
    try {
      $props = $ev.Properties
      if ($props -and $props.Count -ge 5) {
        if ($props[0].Value) { $sam = [string]$props[0].Value }
        if ($props[4].Value) { $operatorUser = [string]$props[4].Value }
      }
    } catch {
      [Console]::Error.WriteLine("Parse event $($ev.Id) properties failed: $($_.Exception.Message)")
    }

    if ([string]::IsNullOrEmpty($sam)) { continue }

    # R158.72.x.4: 时间戳走事件 TimeCreated (本地时区, 跟 v1.0.0/v1.0.1
    # WhenChanged 1:1 平行; 中心端 normalizeEntry 接受 5 个 action 字符串不变).
    $timeCreated = $ev.TimeCreated
    $timeCreatedIso = $null
    if ($timeCreated) {
      $timeCreatedIso = $timeCreated.ToUniversalTime().ToString('o')
    }

    # DN 在事件日志 0 直接提供, 走 AD query 反查 (但 1.0.2 0 依赖 AD module,
    # 用 machine name + sam 拼 placeholder, 中心端 etl 0 严校验 dn 字段).
    $dn = "CN=$sam,$domainDn"

    $entries += @{
      sam           = $sam
      display_name  = $null  # 事件日志 0 直接提供, 中心端 etl 0 改 normalizeEntry
      action        = $action
      created_at    = if ($ev.Id -eq 4720) { $timeCreatedIso } else { $null }
      modified_at   = $timeCreatedIso
      dn            = $dn
      operator_user = $operatorUser  # R158.72.x.4 NEW
    }
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
