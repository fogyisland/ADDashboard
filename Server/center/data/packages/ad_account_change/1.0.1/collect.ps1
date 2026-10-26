# collect.ps1 - ad_account_change v1.0.1 (R158.72.x, 2026-10-14)
#
# R158.72.x — 5 actions 互斥修复. v1.0.0 的 elseif +独立 if 结构会让
# (WhenChanged >= today && Enabled=$true) 的账号同时落 modified 和
# enabled, 导致 enabled 数虚高 (KDLWGQWHADSRV1 baseline 157). v1.0.1 用
# Get-ADReplicationAttributeMetadata -Object $dn (默认本 DC 视图, 不传
# -Server) 读 userAccountControl 属性的 LastOriginatingChangeTime:
#   - WhenCreated >= today       → created
#   - UAC.LastOriginatingChangeTime >= today && 当前 Enabled=$true
#                               → enabled
#   - UAC.LastOriginatingChangeTime >= today && 当前 Enabled=$false
#                               → disabled
#   - WhenChanged >= today       → modified
#   - else                       → skip
#
# Get-ADReplicationAttributeMetadata 所有副本的 LastOriginatingChangeTime
# 收敛到同一 originating write time (AD replication metadata 语义), 跨 DC
# 一致; 每台 DC 各自查自己的副本视图, 中心端 MERGE ON (sam, action,
# change_date) 自动 dedup 跨 DC 重复 (跟 v1.0.0 同 R110.A pattern). 不需
# PDC 绑定, 不需 per-DC state cache, 不改 cadence (intervalSec=86400 不变).
#
# R158.72.x.1 (2026-10-15) — 显式 -Server $server (本机 hostname, 等于本 DC).
# cmdlet 官方 docs 标 -Server mandatory, auto-discovery 在 NSSM service context /
# 防火墙拦 DNS SRV / nltest stale cache 时 100% 失败. 显式传 -Server 绕开.
#
# R158.72.x.2 (2026-10-16) — fleet 100% partial 真因:
# R158.72.x.1 ship 后 24h fleet 33 DC 607/607 partial, 0 success. 真因 =
# PS 5.1 `Import-Module ActiveDirectory` 触 implicit `AD:` PSDrive mount →
# 试连 DC locator → firewall 拦 → 抛 "目录服务连接不可用" → 整段 try 块
# 抛到 line 205 catch. line 67-72 模块加载是唯一无 inner catch 段, 加
# inner try/catch 跟 line 75-80/86-92/129-147/180-203 1:1 平行. 同时
# line 181 Get-ADObject -IncludeDeletedObjects 加 -Server $server 跟
# line 139 Get-ADReplicationAttributeMetadata 1:1 平行. R158.72.x.1
# dry-run 漏了"24h 后 AD 状态变"维度, R158.72.x.2 必 ship 后 1h+24h+72h
# 3 次 partial ratio verify.
#
# 如果 Get-ADReplicationAttributeMetadata 在某台 DC 上 fail (RSAT 模块缺 /
# DC 视图 partial / 权限不足), fallback 进 modified 分支兜底 (该 user 顶
# 多算 modified), 不回退 v1.0.0 的 elseif + 独立 if 双 row 行为 (那是
# bug).
#
# 输出 (wire shape) 跟 v1.0.0 1:1 一致, 中心端 normalizeEntry 接受 5 个
# action 字符串不变:
#   { metrics: { agent_id, dc_name, domain_dn, change_date (CST yyyy-MM-dd),
#                entries: [
#                  { sam, display_name, action, created_at, modified_at, dn }
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
    try {
      # R158.72.x.2 (2026-10-16) — wrap Import-Module in inner try/catch
      # because PS 5.1's Import-Module ActiveDirectory triggers an implicit
      # `AD:` PSDrive mount that queries DC locator; in NSSM service context
      # (no AD: PSDrive, no interactive session) the DC locator query is
      # blocked by firewall / nltest stale cache and throws
      # "与要处理请求的目录的连接不可用", which previously bubbled to the
      # outer catch and aborted the whole run (607/607 partial in 24h after
      # R158.72.x.1). Match the inner try/catch pattern already used by
      # Get-ADDomain / Get-ADUser / Get-ADReplicationAttributeMetadata /
      # Get-ADObject -IncludeDeletedObjects below.
      Import-Module ActiveDirectory -ErrorAction Stop
    } catch {
      [Console]::Error.WriteLine("Import-Module ActiveDirectory failed: $($_.Exception.Message)")
      if (-not $lastErrorMessage) { $lastErrorMessage = "import_module: $($_.Exception.Message)" }
    }
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

  # R158.72.x — in-process cache keyed by dn, skip重复 LDAP round-trip
  # on multi-pass fsinfo if any. metadata 不进 disk, 仅这一次脚本运行
  # 的 in-memory hashtable, 跟 "no per-DC state cache" 约束一致.
  $metaCache = @{}

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

    # R158.72.x — 5 actions 互斥 state-machine. 顺序不能换:
    #   created  > enabled/disabled (by metadata) > modified > skip
    $action = $null

    # 1) created — 当日新建 (最强语义, 命中即停)
    if ($whenCreated -and $whenCreated -ge $todayLocalMidnightUtc) {
      $action = 'created'
    }
    else {
      # 2) enabled / 3) disabled — 看 userAccountControl 属性的
      #    LastOriginatingChangeTime (本 DC 视图, 显式 -Server $server,
      #    R158.72.x.1 修 auto-discovery 失败). AD replication metadata 所
      #    有副本收敛到同一 originating write time, 跨 DC 一致; 每台 DC 各
      #    自查自己, 中心端 MERGE 自动 dedup 跨 DC.
      $uacMetaTime = $null
      if ($metaCache.ContainsKey($dn)) {
        $uacMetaTime = $metaCache[$dn]
      } else {
        try {
          # R158.72.x.1 (2026-10-15) — fix double-bug.
          #   Bug A: Get-ADReplicationAttributeMetadata 官方 docs 标 '-Server mandatory',
          #     auto-discovery 在 NSSM service context / DC locator 防火墙拦 / nltest
          #     cache stale 时 100% 失败 → '强制参数 Server 缺失' stderr 风暴. 显式传
          #     -Server $server (本机 hostname = 本 DC) 绕开 auto-discovery.
          #   Bug B: 返回对象是 ADReplicationAttributeMetadata, 列名 = AttributeName
          #     (LDAP display name), 不是 Name. R158.72.x v1.0.1 原代码 _.Name 永远
          #     filter 0 行 → 永远 fallback 到 modified. (Microsoft Q&A + Tencent +
          #     jb51 + PowerShellGallery ActiveDirectoryTools 1.0.1.14 都用 _.AttributeName.)
          $meta = Get-ADReplicationAttributeMetadata -Object $dn -Server $server -Properties userAccountControl -ErrorAction Stop
          $uacRow = $meta | Where-Object { $_.AttributeName -eq 'userAccountControl' } | Select-Object -First 1
          if ($uacRow) { $uacMetaTime = $uacRow.LastOriginatingChangeTime }
        } catch {
          # RSAT 缺 / DC 视图 partial / 权限不足 — 这条 user 拿不到 metadata,
          # fallback 进 modified 分支兜底, 永不回退 v1.0.0 的双 row 行为.
          [Console]::Error.WriteLine("Get-ADReplicationAttributeMetadata failed for $sam : $($_.Exception.Message)")
          if (-not $lastErrorMessage) { $lastErrorMessage = "uac_meta: $($_.Exception.Message)" }
        }
        $metaCache[$dn] = $uacMetaTime
      }

      $uacChangedToday = $false
      if ($uacMetaTime -and $uacMetaTime -ge $todayLocalMidnightUtc) { $uacChangedToday = $true }

      if ($uacChangedToday -and $enabled -and -not $disabledBit) {
        $action = 'enabled'
      }
      elseif ($uacChangedToday -and -not $enabled -and $disabledBit) {
        $action = 'disabled'
      }
      elseif ($whenChanged -and $whenChanged -ge $todayLocalMidnightUtc) {
        # 4) modified — 当日修改 (排除 created, enabled, disabled)
        $action = 'modified'
      }
    }

    if ($action) {
      $entries += @{
        sam          = $sam
        display_name = $displayName
        action       = $action
        created_at   = if ($whenCreated) { $whenCreated.ToString('o') } else { $null }
        modified_at  = if ($whenChanged) { $whenChanged.ToString('o') } else { $null }
        dn           = $dn
      }
    }
  }

  # 5) deleted — AD Recycle Bin. -IncludeDeletedObjects 需要 forest-level
  #    功能 (默认开启); 部分环境可能未启用, 单独 try/catch 隔离不阻塞其他.
  try {
    $deleted = Get-ADObject -Filter 'isDeleted -eq $true -and objectClass -eq "user"' -Server $server -IncludeDeletedObjects -Properties SamAccountName, DisplayName, whenChanged -ErrorAction Stop
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
