# collect.ps1 - ad_account_change v1.0.12 (R158.X.99, 2026-10-21)
#
# R158.X.99 (2026-10-21) — 修「每天必写 0 条」逻辑错误 (操作员 directive
#   "应该是查询前一天 0:0:0 到 23:59:59 的数据, 因为从 0 点到两点数据肯定
#   是 0, 所以逻辑不对"). 详见下方窗口定义段.
#   真因: cronExpr='0 2 * * *' 每天 02:00 跑, 但 StartTime = CST today 00:00
#   → 窗口只有 0~2 点, 该时段几乎 0 条账户管理事件 → 每日必写 0 条 →
#   前端「显示没有任何账户创建」. 同时时区基准不统一 (写 CST / 查 UTC,
#   差 8h). 修: 窗口改昨天整天 (含 EndTime 闭边界), 基准统一 UTC.
#   中心端同步改 dailyTopByAction 两个 dialect 的 "当日" 语义 → 昨天.
#
# 历史 (1.0.11 及之前, 供追溯):
# R158.X.99.20.aac-1.0.11 (2026-10-18) — 操作员 directive "升级到 1.0.11"
#   闭合 1min cadence burst 真因. Ship 1.0.11 = disk 端真存在
#   (1.0.6 dir 写 1.0.10 manifest 但 0.1.6/0.1.7/0.1.8 agent binary
#   拉时 fallback, 触发 setInterval 30s cadence 错位 burst).
#   enabled=1 + interval_sec=86400 + cron='0 2 * * *' (中心端 cron-scheduler
#   跑 1 次, agent 0 走 setInterval, 0 burst).
#
# R158.72.x.5 (2026-10-16) — R158.72.x.4 PS5.1 parser lexer bug fix.
#   R158.72.x.4 ship 后 33 fleet AD agent PS parser 报 3 错 → 0 行真跑成功.
#   真因: hashtable 4767 KV 行尾紧跟中文长注释 + 后续嵌套 try +
#   Get-WinEvent -FilterHashtable 组合触发 PS5.1 lexer bug. 修法: 那行中文
#   注释挪到 hashtable 闭合 `}` 之后独立一行, PS parser 0 错.
#
# R158.72.x.9 / .x.10 (2026-10-16) — 0 事件 = expected outcome, 不当 fail.
#   catch 块识别 NoMatchingEventsFound → 静默 + $events=@() + error_code:0.
#   其他异常 (权限错 EventLogNotFoundException) 仍 error_code:1.
#   0 事件时 0 走 stderr (操作员 directive "按道理应该直接就是 0,或者 json
#   数据, 而不是报错").
#
# 5 events ID 1:1 映射:
#   4720 → created  (新建用户)
#   4722 → enabled  (启用用户)
#   4725 → disabled (禁用用户)
#   4738 → modified (修改用户属性)
#   4767 → unlocked (解锁用户)   ← 中心端 normalizeEntry 算作 modified
#                                  写入公共表 (semantic 合并).
#
# Get-WinEvent 走 .NET EventLog API, **0 依赖** Import-Module ActiveDirectory,
# **0 触** `AD:` PSDrive mount, **NSSM context 友好**.
#
# 前置条件 (操作员必先配, 0 改中心端):
#   1. 域控开启 "审核账户管理" 策略:
#      auditpol /set /subcategory:"User Account Management" /success:enable /failure:enable
#   2. agent run-as account 加进 DC 本地 "Event Log Readers" 组 (普通域用户权限不够).
#   ⚠️ 未配时 Get-WinEvent 静默返 0 条 (error_code=0), 前端显示空但不报错.
#      排查「0 条」时先确认这两项.
#
# 采集窗口 (R158.X.99): 昨天 00:00:00 ~ 今天 00:00:00 UTC (左闭右开).
#   cron 02:00 跑 = 跑完即得昨天全天数据. change_date = UTC 昨天 (yyyy-MM-dd).
#   中心端 dailyTopByAction 同步按「UTC 昨天」过滤, 写入/查询基准一致.
# per-DC 独立: 每台 DC 跑 1 次, 中心端 MERGE ON (sam, action, change_date)
#   自动 dedup 跨 DC.
#
# 输出 (wire shape):
#   { metrics: { agent_id, dc_name, domain_dn, change_date (UTC yyyy-MM-dd),
#                entries: [
#                  { sam, display_name, action, created_at, modified_at, dn,
#                    operator_user }
#                ],
#                entries_count,
#                collected_at,
#                error_code } }

$ErrorActionPreference = 'Continue'

# R136 — force UTF-8 stdout so any Chinese text in .NET exception
# messages / display names survives the PS->agent->centre pipeline without
# being transcoded through the system ANSI codepage.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$server = $env:COMPUTERNAME
$collectedAt = (Get-Date).ToUniversalTime().ToString('o')

# R158.X.99 (2026-10-21) — 采集窗口改为「昨天整天」, 修正逻辑错误.
#
# 旧逻辑 (v1.0.11 及之前) 的缺陷:
#   cronExpr='0 2 * * *' 每天 02:00 跑, 但 StartTime = CST today 00:00.
#   02:00 跑时窗口只有 0~2 点, 这个时段几乎必然 0 条账户管理事件.
#   → 每天写入必然是 0 条 = 前端「显示没有任何账户创建」的直接原因 (每日必现,
#     不是偶发). 根因是窗口语义与调度时刻矛盾, 不是时区错位.
#
# 新逻辑 (R158.X.99):
#   窗口 = 昨天 00:00:00 ~ 今天 00:00:00 (左闭右开, 昨天完整 24h).
#   cron 02:00 跑 → 跑完立刻能看到昨天全天的数据. 这是日结包的天然语义.
#
# EndTime 必须显式给: 不设的话 Get-WinEvent 一直读到「现在」, 会把今天
# 00:00~02:00 的事件混进昨天窗口, 边界不准.
#
# 时区基准统一到 UTC (跟中心端 SQL 的 GETUTCDATE() / DATEADD 对齐):
#   旧版写 CST 日期, 中心端按 UTC 日期查, 差 8 小时 → 跨天时错位.
#   现在写入端与查询端都用 UTC 基准, 不再错位.
$utcNow = (Get-Date).ToUniversalTime()
$todayMidnightUtc = [datetime]::new($utcNow.Year, $utcNow.Month, $utcNow.Day, 0, 0, 0, [System.DateTimeKind]::Utc)
$yesterdayMidnightUtc = $todayMidnightUtc.AddDays(-1)

$changeDate = $yesterdayMidnightUtc.ToString('yyyy-MM-dd')

$entries = @()
$domainDn = $null
$lastErrorMessage = $null

try {
  # 5 events ID 1:1 映射
  $eventIdToAction = @{
    4720 = 'created'
    4722 = 'enabled'
    4725 = 'disabled'
    4738 = 'modified'
    4767 = 'unlocked'
  }
  # R158.72.x.6 (2026-10-16): PS5.1 $eventIdToAction.Keys 出来是 KeyCollection
  #   (元素 boxed Object), Get-WinEvent -FilterHashtable Id 字段要纯 Int32[];
  #   强转 [int[]] 修 "在 Id 哈希表项中遇到 Null 值".
  [int[]]$eventIds = $eventIdToAction.Keys

  # Get-WinEvent 走 .NET EventLog API, 0 依赖 ActiveDirectory module
  # R158.X.99 — 窗口 = 昨天 00:00:00 (含) ~ 今天 00:00:00 (不含).
  $events = $null
  try {
    $events = Get-WinEvent -FilterHashtable @{
      LogName   = 'Security'
      Id        = $eventIds
      StartTime = $yesterdayMidnightUtc
      EndTime   = $todayMidnightUtc
    } -ErrorAction Stop
  } catch {
    # 0 事件 = expected outcome (auditpol 未配 / window 内 0 事件 / log empty)
    #   → 静默 + $events=@() + error_code:0, 0 走 stderr.
    # 真异常 (EventLogNotFoundException, 权限错) → stderr + error_code:1.
    $msg = $_.Exception.Message
    $fqid = $_.FullyQualifiedErrorId
    if ($msg -like '*No events were found*' -or $fqid -like '*NoMatchingEventsFound*') {
      $events = @()  # 静默, 0 stderr
    } else {
      [Console]::Error.WriteLine("Get-WinEvent Security failed - $msg")
      if (-not $lastErrorMessage) { $lastErrorMessage = "get_winevent: $msg" }
      $events = @()
    }
  }

  # per-DC 独立: 中心端 domain_dn 从事件的 MachineName 取 (0 依赖 AD module).
  try {
    if ($events -and $events.Count -gt 0) {
      $firstEvent = $events | Select-Object -First 1
      $domainDn = $firstEvent.MachineName
    }
  } catch {
    $lastErrorMessage = "parse_domain: $($_.Exception.Message)"
  }

  foreach ($ev in $events) {
    $action = $eventIdToAction[$ev.Id]
    if (-not $action) { continue }

    # 事件日志 Properties 解析:
    # [0]=TargetUserName, [4]=SubjectUserName (操作人)
    $sam = $null
    $operatorUser = $null
    try {
      $props = $ev.Properties
      if ($props -and $props.Count -ge 5) {
        if ($props[0].Value) { $sam = [string]$props[0].Value }
        if ($props[4].Value) { $operatorUser = [string]$props[4].Value }
      }
    } catch {
      # 单事件 parse 失败 = 静默 continue, 整 batch 继续 (R158.72.x.10).
    }

    if ([string]::IsNullOrEmpty($sam)) { continue }

    $timeCreated = $ev.TimeCreated
    $timeCreatedIso = $null
    if ($timeCreated) {
      $timeCreatedIso = $timeCreated.ToUniversalTime().ToString('o')
    }

    # DN 在事件日志 0 直接提供, 用 machine name + sam 拼 placeholder.
    $dn = "CN=$sam,$domainDn"

    $entries += @{
      sam           = $sam
      display_name  = $null
      action        = $action
      created_at    = if ($ev.Id -eq 4720) { $timeCreatedIso } else { $null }
      modified_at   = $timeCreatedIso
      dn            = $dn
      operator_user = $operatorUser
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