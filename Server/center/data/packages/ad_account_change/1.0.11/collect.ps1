# collect.ps1 - ad_account_change v1.0.12 (R158.X.99, 2026-10-21)
#
# R158.X.99 (2026-10-21) — 修「每天必写 0 条」逻辑错误 (操作员 directive
#   "应该是查询前一天 0:0:0 到 23:59:59 的数据"). 详见下方窗口定义段.
#   真因: cronExpr='0 2 * * *' 每天 02:00 跑, 但窗口写的是 CST today 00:00
#   ~ 现在 = 只有 0~2 点, 该时段几乎 0 条账户管理事件 → 每日必写 0 条 →
#   前端「显示没有任何账户创建」. 同时时区基准不统一 (写 CST / 查 UTC,
#   差 8h). 修: 窗口改昨天整天 (含 EndTime 闭边界), 基准统一 UTC.
#   中心端同步改 dailyTopByAction 两个 dialect 的 "当日" 语义 → 昨天.
#
# R158.X.99.20.aac-1.0.11 (2026-10-18) — 操作员 directive "升级到 1.0.11"
#   闭合 1min cadence burst 真因. collect.ps1 body 1:1 平行 v1.0.6
#   (R158.72.x.10 0 改实质内容). Ship 1.0.11 = disk 端真存在
#   (1.0.6 dir 写 1.0.10 manifest 但 0.1.6/0.1.7/0.1.8 agent binary
#   拉时 fallback, 触发 setInterval 30s cadence 错位 burst, R158.X.99.13
#   staging 0.1.8 fix 0 真落地 lesson 14+20 锁). 走 aam 1.0.2 范式
#   100% 闭合 precedent: enabled=1 + interval_sec=86400 + cron='0 2 * * *'
#   (中心端 cron-scheduler 跑 1 次, agent 0 走 setInterval, 0 burst).
#   1:1 平行 R158.X.99.aelc.c + R158.X.99.19 aec 1.0.8 ship 范式.
#
# R158.72.x.5 (2026-10-16) — R158.72.x.4 PS5.1 parser lexer bug fix.
#
# 真因链 (R158.72.x / .x.1 / .x.2 / .x.3 / .x.4 / .x.5):
#   R158.72.x 加 Get-ADReplicationAttributeMetadata 强制 Import-Module ActiveDirectory
#   → PS 5.1 NSSM context 触 implicit `AD:` PSDrive mount → DC locator 防火墙拦
#   → 24h 607/607 partial (0 success). 改 inner try/catch (R158.72.x.2) 0 解决真因.
#   操作员 directive "不停执行导致 AD 出问题" → R158.72.x.3 硬删整包.
#   操作员 "我们后续用别的方式执行" → R158.72.x.4 走 Get-WinEvent 事件日志路径.
#   R158.72.x.4 ship 后 33 fleet AD agent 拉脚本 PS parser 报 3 错 (77 行 6 列
#   Missing '=' operator after key in hash literal + 83 行 5 列 Unexpected 'catch')
#   → 0 行真跑成功. 真因: hashtable 4767 KV 行尾紧跟中文长注释 + 后续嵌套 try
#   + Get-WinEvent -FilterHashtable 组合触发 PS5.1 lexer bug, 把后续 try 当
#   hashtable 未闭合的 key. R158.72.x.5 fix: 那行中文注释挪到 hashtable 闭合
#   `}` 之后独立一行, PS parser 0 错.
#
# R158.72.x.9 (2026-10-16) — 修 NoMatchingEventsFound 当 fail bug.
#   真因: 1.0.4 catch 块无差别把所有异常当 lastErrorMessage, 但 Get-WinEvent
#   -FilterHashtable 在 0 匹配时抛 NoMatchingEventsFound (FQID
#   "NoMatchingEventsFound,Microsoft.PowerShell.Commands.GetWinEventCommand")
#   是 expected outcome (auditpol 未配 / window 内 0 事件 / log enabled but empty),
#   不是 process failure. 1.0.5 fix: catch 块识别 NoMatchingEventsFound 异常 →
#   静默 + $events=@() + 0 lastErrorMessage (error_code=0). 其他异常 (权限错
#   EventLogNotFoundException, log 不存在) 仍当 fail (error_code=1 +
#   lastErrorMessage). 跟 R158.50.6 ad_lockout_list 同一类 fix 1:1 平行.
#
# R158.72.x.10 (2026-10-16) — 删正常路径 stderr 噪音. 操作员 directive
#   "按道理应该直接就是 0,或者 json 数据, 而不是 报错". 1.0.5 0 事件时
#   仍走 [Console]::Error.WriteLine 写 stderr (英文 tag, 治标不治本),
#   + 单事件 Properties parse 失败时也走 stderr. 1.0.6 fix:
#   (1) 0 事件 catch 块 = 静默, $events=@() + 0 stderr. 真异常仍 stderr
#   (EventLogNotFoundException, 权限错, 跟 R158.50.6 1:1 平行).
#   (2) 单事件 parse 失败 catch = 静默 (整 batch continue, 0 走 stderr).
#   真 init 异常 (try 块最外层) 仍 stderr + error_code=1.
#   0 影响中心端 wire shape (stdout JSON 字段 1:1 平行), R158.50.6
#   decision tree (runner.js:786-790) 自动处理 error_code:0/1 不变.
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
# v1.0.0/v1.0.1 走 AD cmdlet 触 PSDrive mount 100% fail, v1.0.2/v1.0.3 走 .NET
# EventLog API 0 依赖 AD module → 0 fail (v1.0.3 修复 v1.0.2 语法报错后真跑).
#
# 前置条件 (操作员必先配, 0 改中心端):
#   1. 域控开启 "审核账户管理" 策略:
#      auditpol /set /subcategory:"User Account Management" /success:enable /failure:enable
#   2. agent run-as account 加进 DC 本地 "Event Log Readers" 组 (普通域用户权限不够).
#
# 采集窗口 (R158.X.99): 昨天 00:00:00 ~ 今天 00:00:00 UTC (左闭右开).
#   cron 02:00 跑 = 跑完即得昨天全天数据. change_date = UTC 昨天 (yyyy-MM-dd).
#   中心端 dailyTopByAction 同步按「UTC 昨天」过滤, 写入/查询基准一致.
# per-DC 独立: 每台 DC 跑 1 次, 中心端 MERGE ON (sam, action, change_date) 自动 dedup 跨 DC.
#
# 输出 (wire shape) 跟 v1.0.0/v1.0.1 1:1, +1 字段 operator_user:
#   { metrics: { agent_id, dc_name, domain_dn, change_date (UTC yyyy-MM-dd),
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
# R158.72.x.9.b (2026-10-16) — PS5.1 stderr codepage 限制.
#   R136 [Console]::OutputEncoding 只盖 stdout, 但 stderr 走
#   [Console]::Error.WriteLine 时用 OS 默认 codepage (GBK 中文系统),
#   PS5.1 [Console]::Error 没 OutputEncoding setter 抛 InvalidOperation.
#   1.0.5.b fix: stderr 输出走纯英文 tag + 写 stdout 中文 (走 UTF-8 encoding).
#   0 影响中心端 wire shape (stdout JSON 不变).
# R158.72.x.10 (2026-10-16) — 根除 0 事件 stderr, 这条 codepage 注释仅适用
#   剩余 2 处 stderr (line 127 Get-WinEvent 真异常, line 192 init 异常).
#   那 2 处已走纯英文 tag, 0 codepage 风险.

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
  # 5 events ID 1:1 映射 (跟 v1.0.0/v1.0.1 5 actions 1:1 平行)
  $eventIdToAction = @{
    4720 = 'created'
    4722 = 'enabled'
    4725 = 'disabled'
    4738 = 'modified'
    4767 = 'unlocked'
  }
  # R158.72.x.5: 4767 (解锁) 跟 4738 (modified) 区分开, 中心端 normalizeEntry 把 unlocked 算作 modified 写入公共表
  # R158.72.x.6 (2026-10-16): PS5.1 $eventIdToAction.Keys 出来是 KeyCollection (元素 boxed Object),
  #   Get-WinEvent -FilterHashtable Id 字段要纯 Int32[]; 强转 [int[]] 修"在 Id 哈希表项中遇到 Null 值".
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
    # R158.72.x.10 (2026-10-16) — 删 0 事件 stderr 噪音. 操作员 directive
    #   "按道理应该直接就是 0,或者 json 数据, 而不是 报错". 0 事件 =
    #   expected outcome = 静默, $events=@() + 0 lastErrorMessage.
    #   真异常 (EventLogNotFoundException, 权限错) 仍 stderr + error_code=1
    #   跟 R158.50.6 1:1 平行. 0 影响中心端 wire shape (stdout JSON 不变).
    # R158.72.x.9 (2026-10-16) — 区分 "0 事件" vs 真异常:
    #   Get-WinEvent -FilterHashtable 在 0 匹配时抛 NoMatchingEventsFound
    #   (System.Diagnostics.Eventing.Reader.EventLogQueryException, FQID
    #   "NoMatchingEventsFound,Microsoft.PowerShell.Commands.GetWinEventCommand"),
    #   这是 expected outcome (auditpol 未配 / window 内 0 事件 / log empty),
    #   不是 process failure. 静默 + $events=@() + 0 lastErrorMessage.
    #   其他异常 (权限错 EventLogNotFoundException, log 不存在) 仍当 fail
    #   (error_code:1 + lastErrorMessage) — 跟 R158.50.6 1:1 平行.
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
      # R158.72.x.10 (2026-10-16) — 单事件 parse 失败 = 静默 continue. 操作员
      #   directive "前面的执行出错应该是没有写好脚本". 单个事件 Properties 缺
      #   TargetUserName (1 域账号属性缺失) 是 partial outcome, 0 走 stderr,
      #   整 batch 仍 continue. 真 init 异常仍 line 192 stderr (下面).
    }

    if ([string]::IsNullOrEmpty($sam)) { continue }

    # R158.72.x.4: 时间戳走事件 TimeCreated (本地时区, 跟 v1.0.0/v1.0.1
    # WhenChanged 1:1 平行; 中心端 normalizeEntry 接受 5 个 action 字符串不变).
    $timeCreated = $ev.TimeCreated
    $timeCreatedIso = $null
    if ($timeCreated) {
      $timeCreatedIso = $timeCreated.ToUniversalTime().ToString('o')
    }

    # DN 在事件日志 0 直接提供, 走 AD query 反查 (但 1.0.3 0 依赖 AD module,
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