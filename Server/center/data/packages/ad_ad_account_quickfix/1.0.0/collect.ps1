# collect.ps1 - ad_ad_account_quickfix v1.0.0 (R158.34, 2026-10-02)
#
# AD 账户快速重置包 — agent 端从中心仓 /api/admin/ad-commands 拉取
# command_type=ad_account_quickfix 的命令 (R75 AdCommandHistoryDrawer 机制
# 扩展), 在本机 DC 上执行快速账户重置 (解锁 + 重置密码 + 启用 + 同步
# displayName/description/UAC 属性)。返回 success/failed + 错误信息 +
# 耗时 (毫秒), 中心仓写一行 package_runs (action=quickfix target=username
# operator=<jwt sub> status=success/failed durationMs=<ms>)。
#
# **本包不通过 collect 循环触发** — collect 循环每 intervalSec=3600 跑
# 一次只输出 'idle, no commands pending' (避免 center 把 collect 误当数据
# 源, 也不会产生 package_runs 行)。真正的命令触发走 R75 机制:
#   1. operator UI 在 /admin/daily-ops 点 "快速重置"
#   2. center POST /api/admin/ad-account/quickfix 入队 ad_admin_commands
#   3. agent poll /api/admin/ad-commands/<dc> 拉到该命令
#   4. agent 调本 collect.ps1 --action=quickfix --sam=X --newPassword=Y ...
#   5. collect.ps1 跑完返回 JSON, agent POST 回 center
#   6. center 写 ad_admin_commands.status + package_runs 行
#
# 这是 'command' type 包, 不采集指标, 不写公共表。manifest.type=command 是
# 新分类 (区别于 gauge / eventlog), 后续 R 可能加 ad_ad_account_audit 等
# 同系列包。
#
# Wire shape (per-run, agent → center):
#   {
#     action: 'quickfix',
#     target: 'jdoe',
#     operator: '<jwt sub>',
#     success: true|false,
#     error: '<message>' | null,
#     durationMs: 1234,
#     unlocked: true|false,
#     passwordReset: true|false,
#     enabled: true|false,
#     attributesSet: <count> | null
#   }

$ErrorActionPreference = 'Stop'

# R136 encoding fix (unchanged): PS 5.1 default [Console]::OutputEncoding
# is the system ANSI codepage (CP936/GB18030 on CN Windows). Setting it
# to UTF8 makes ConvertTo-Json emit the original .NET bytes verbatim so
# the centre's NVARCHAR column sees the correct UTF-16 code points.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'

$server = $env:COMPUTERNAME

# ── Parse arguments ────────────────────────────────────────────────────
# 支持两种调用模式:
#   1. collect 循环触发 (idle 模式, 什么都不做)
#      powershell collect.ps1
#   2. agent admin-commands handler 调用 (执行模式)
#      powershell collect.ps1 --action quickfix --sam jdoe --newPassword "..." \
#        [--description "..."] [--displayName "..."]
$action = $null
$sam = $null
$newPassword = $null
$description = $null
$displayName = $null
$userAccountControl = $null

for ($i = 0; $i -lt $args.Count; $i++) {
  $a = $args[$i]
  switch ($a) {
    '--action' { $action = $args[++$i] }
    '--sam' { $sam = $args[++$i] }
    '--newPassword' { $newPassword = $args[++$i] }
    '--description' { $description = $args[++$i] }
    '--displayName' { $displayName = $args[++$i] }
    '--userAccountControl' { $userAccountControl = $args[++$i] }
    default { [Console]::Error.WriteLine("unknown arg: $a") }
  }
}

# ── Idle mode: collect 循环触发, 不做任何操作 ─────────────────────────
if (-not $action) {
  $metrics = @{
    agent_id    = $server
    dc_name     = $server
    collected_at = (Get-Date).ToUniversalTime().ToString('o')
    events      = @()
    summaries   = @()
  }
  $payload = @{ metrics = $metrics }
  $payload | ConvertTo-Json -Compress -Depth 6
  exit 0
}

# ── Execute mode: 运行 quickfix ────────────────────────────────────────
if ($action -ne 'quickfix') {
  $payload = @{
    action = $action
    target = $sam
    operator = '<unknown>'
    success = $false
    error = "unsupported action '$action'"
    durationMs = 0
  }
  $payload | ConvertTo-Json -Compress -Depth 6
  exit 1
}

$startMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

$unlocked = $false
$passwordReset = $false
$enabled = $false
$attributesSet = 0
$errMsg = $null

try {
  Import-Module ActiveDirectory -ErrorAction Stop
} catch {
  # RSAT 缺失 — 跟 R139 一样, 不致命, 报详细错误给 agent
  $payload = @{
    action = 'quickfix'
    target = $sam
    operator = '<rsat-missing>'
    success = $false
    error = "Import-Module ActiveDirectory failed: $($_.Exception.Message) (RSAT not installed?)"
    durationMs = 0
    unlocked = $false
    passwordReset = $false
    enabled = $false
    attributesSet = 0
  }
  $payload | ConvertTo-Json -Compress -Depth 6
  exit 1
}

try {
  if (-not $sam) { throw 'sam (sAMAccountName) is required' }

  $adUser = Get-ADUser -Identity $sam -Properties Enabled, LockedOut, DisplayName, Description, userAccountControl -ErrorAction Stop

  # R158.52 — operator directive "零或空 / 避免数据错误": aggregate
  # per-step errors so a partial success (3/4 sub-steps OK, 1 failed)
  # doesn't get reported as success=$true. Old behaviour swallowed
  # Unlock-ADAccount + Enable-ADAccount failures into stderr only.
  $stepErrors = @()

  # 1. 解锁
  try {
    Unlock-ADAccount -Identity $adUser -ErrorAction Stop
    $unlocked = $true
  } catch {
    # 账户未锁定时 Unlock-ADAccount 仍会成功, 这里 catch 是真的失败
    [Console]::Error.WriteLine("Unlock-ADAccount failed: $($_.Exception.Message)")
    $stepErrors += "unlock: $($_.Exception.Message)"
  }

  # 2. 重置密码 (如果给了 newPassword)
  if ($newPassword) {
    try {
      Set-ADAccountPassword -Identity $adUser -Reset -NewPassword (ConvertTo-SecureString $newPassword -AsPlainText -Force) -ErrorAction Stop
      $passwordReset = $true
    } catch {
      $stepErrors += "password_reset: $($_.Exception.Message)"
    }
  }

  # 3. 启用 (无论之前是否禁用都设一次, 幂等)
  try {
    Enable-ADAccount -Identity $adUser -ErrorAction Stop
    $enabled = $true
  } catch {
    [Console]::Error.WriteLine("Enable-ADAccount failed: $($_.Exception.Message)")
    $stepErrors += "enable: $($_.Exception.Message)"
  }

  # 4. 同步属性 (displayName / description / userAccountControl)
  $setParams = @{}
  if ($displayName) { $setParams['DisplayName'] = $displayName; $attributesSet++ }
  if ($description -ne $null) { $setParams['Description'] = $description; $attributesSet++ }
  if ($userAccountControl) {
    try {
      $uacInt = [int]$userAccountControl
      $setParams['Replace'] = @{ userAccountControl = $uacInt }
      $attributesSet++
    } catch {
      [Console]::Error.WriteLine("userAccountControl parse failed: $userAccountControl — $($_.Exception.Message)")
      $stepErrors += "uac_parse: $($_.Exception.Message)"
    }
  }
  if ($setParams.Count -gt 0) {
    try {
      Set-ADUser -Identity $adUser @setParams -ErrorAction Stop
    } catch {
      $stepErrors += "set_attrs: $($_.Exception.Message)"
    }
  }
  # R158.52 — surface the aggregated step errors as the top-level $errMsg
  # so the centre's success/$errMsg-based decision tree (R158.50.6) flags
  # the row as failed when any sub-step did not actually run.
  if ($stepErrors.Count -gt 0) {
    $errMsg = $stepErrors -join '; '
  }
} catch {
  $errMsg = $_.Exception.Message
}

$endMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$durationMs = $endMs - $startMs

$payload = @{
  action        = 'quickfix'
  target        = $sam
  operator      = '<unknown>'   # 由 agent 从 jwt 上下文填
  success       = [bool](-not $errMsg)
  error         = $errMsg
  durationMs    = $durationMs
  unlocked      = $unlocked
  passwordReset = $passwordReset
  enabled       = $enabled
  attributesSet = $attributesSet
}
$payload | ConvertTo-Json -Compress -Depth 6
exit 0
