# collect.ps1 - ad_ad_ou_create v1.0.0 (R158.40, 2026-10-03)
#
# AD 创建 OU 包 — agent 端从中心仓 /api/admin/ad-commands 拉取
# command_type=ou_create 的命令, 在本机 DC 上执行 New-ADOrganizationalUnit.
# 返回 success/failed + DN + 错误信息 + 耗时, 中心仓写一行 ad_admin_commands
# 状态 + audit 行 (ad_ou_create, severity=medium).
#
# **本包不通过 collect 循环触发** — collect 循环每 intervalSec=3600 跑一次
# 只输出 'idle, no commands pending'. 真正的命令触发走 R75 机制:
#   1. operator UI 在 /admin/daily-ops 选 OU 节点, 右栏 "创建子 OU" 表单
#   2. center POST /api/admin/ad-commands 入队 (commandType=ou_create, params={parentDn, name, description?})
#   3. agent poll /api/agent/ad-commands?hostname=X 拉到该命令
#   4. agent dispatcher pickScript 'ou_' prefix → 走包路径 →
#      '<agentDataDir>/packages/ad_ad_ou_create/1.0.0/collect.ps1' --
#      --action=create --parentDn=<DN> --name=<OUName> [--description=<text>]
#   5. collect.ps1 跑完返回 JSON envelope (action, target, success, error,
#      durationMs, distinguishedName), agent POST 回 center
#   6. center 写 ad_admin_commands.status + audit row (verb=ad_ou_create)
#
# 跟 R158.34 quickfix 区别: quickfix 用 Unlock-ADAccount + Set-ADAccountPassword
# + Enable-ADAccount + Set-ADUser. 本包仅用 New-ADOrganizationalUnit, 不动用户.
#
# Wire shape (per-run, agent → center):
#   {
#     action: 'create',
#     target: '<OUName>',
#     success: true|false,
#     error: '<message>' | null,
#     durationMs: 1234,
#     distinguishedName: '<DN>' | null
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
# Two call modes:
#   1. Collect loop trigger (idle mode, do nothing):
#        powershell collect.ps1
#   2. Agent admin-commands handler (execution mode):
#        powershell collect.ps1 --action create --parentDn '<DN>' --name '<OUName>' [--description '<text>']
$action = $null
$parentDn = $null
$name = $null
$description = $null

for ($i = 0; $i -lt $args.Count; $i++) {
  $a = $args[$i]
  switch ($a) {
    '--action'     { $action = $args[++$i] }
    '--parentDn'   { $parentDn = $args[++$i] }
    '--name'       { $name = $args[++$i] }
    '--description' { $description = $args[++$i] }
    default { [Console]::Error.WriteLine("unknown arg: $a") }
  }
}

# ── Idle mode: collect loop trigger, no-op ───────────────────────────
if (-not $action) {
  $metrics = @{
    agent_id     = $server
    dc_name      = $server
    # R158.52 — operator directive "零或空": idle mode emits
    # `collected_at` for parity with ad_ad_object_delete / move.
    collected_at = (Get-Date).ToUniversalTime().ToString('o')
    idle         = $true
  }
  $metrics | ConvertTo-Json -Compress -Depth 4
  exit 0
}

# ── Execution mode: create OU ─────────────────────────────────────────
# R158.56c (2026-10-08) — fix FormatException. `Get-Date -UFormat %s.%N`
# 不可移植: Windows PowerShell 5.1 + PS7 都不识别 `%N` 纳秒格式说明符
# (Unix glibc strftime 才有), 实测输出 "1759935261.%N" 字面量 →
# [double]::Parse 抛 FormatException. 改用 [DateTimeOffset]::UtcNow
# .ToUnixTimeMilliseconds() 拿 Unix ms, 跟 platform 完全无关, 100% PS5.1+ 兼容.
$startMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

try {
  Import-Module ActiveDirectory -ErrorAction Stop
} catch {
  $endMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  @{
    action            = 'create'
    target            = $name
    success           = $false
    error             = "Import-Module ActiveDirectory failed: $($_.Exception.Message)"
    durationMs        = $endMs - $startMs
    distinguishedName = $null
  } | ConvertTo-Json -Compress -Depth 6
  exit 1
}

if ($action -ne 'create') {
  $endMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  @{
    action            = $action
    target            = $name
    success           = $false
    error             = "unsupported action '$action'"
    durationMs        = $endMs - $startMs
    distinguishedName = $null
  } | ConvertTo-Json -Compress -Depth 6
  exit 1
}

if (-not $parentDn -or -not $name) {
  $endMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  @{
    action            = 'create'
    target            = $name
    success           = $false
    error             = 'invalid params: parentDn and name required'
    durationMs        = $endMs - $startMs
    distinguishedName = $null
  } | ConvertTo-Json -Compress -Depth 6
  exit 1
}

try {
  $props = @{
    Name        = $name
    Path        = $parentDn
    Description = if ($description) { $description } else { $null }
    ProtectedFromAccidentalDeletion = $true
  }
  $ou = New-ADOrganizationalUnit @props -PassThru -ErrorAction Stop
  # R158.52 — operator directive "零或空": verify -PassThru returned a
  # real AD object. On rare silent-reject paths (RSAT/AD inconsistency,
  # domain controller in the middle of a tombstone reap), $ou is $null
  # and the previous code reported success=$true with a null DN.
  if ($null -eq $ou) {
    throw 'New-ADOrganizationalUnit returned null (silent AD reject)'
  }
  $endMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  @{
    action            = 'create'
    target            = $name
    success           = $true
    error             = $null
    durationMs        = $endMs - $startMs
    distinguishedName = $ou.DistinguishedName
  } | ConvertTo-Json -Compress -Depth 6
  exit 0
} catch {
  $endMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  @{
    action            = 'create'
    target            = $name
    success           = $false
    error             = $_.Exception.Message
    durationMs        = $endMs - $startMs
    distinguishedName = $null
  } | ConvertTo-Json -Compress -Depth 6
  exit 1
}