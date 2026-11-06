# collect.ps1 - ad_ad_object_move v1.0.0 (R158.40, 2026-10-03)
#
# AD 移动对象包 — agent 端从中心仓 /api/admin/ad-commands 拉取
# command_type=object_move 的命令, 在本机 DC 上执行 Move-ADObject.
# 把任意对象 (user / group / ou / gpo 等) 从当前 parent DN 移到 new parent DN.
# 返回 success/failed + 错误信息 + 耗时, 中心仓写一行 ad_admin_commands
# 状态 + audit (ad_object_move, severity=medium).
#
# **本包不通过 collect 循环触发** — collect 循环每 intervalSec=3600 跑一次
# 只输出 'idle, no commands pending'. 真正的命令触发走 R75 机制:
#   1. operator UI 在 /admin/daily-ops 选用户/组/OU 节点, 右栏 "移动到 OU" /
#      "移动对象" 表单, 选择新 parent
#   2. center POST /api/admin/ad-commands 入队 (commandType=object_move, params={targetDn, newParentDn})
#   3. agent poll /api/agent/ad-commands 拉到该命令
#   4. agent 调本 collect.ps1 --action=move --targetDn=<DN> --newParentDn=<newDN>
#   5. Move-ADObject 执行, 返回 envelope
#   6. center 写 status + audit row
#
# Wire shape (per-run, agent → center):
#   {
#     action: 'move',
#     target: '<DN>',
#     success: true|false,
#     error: '<message>' | null,
#     durationMs: 1234,
#     newDistinguishedName: '<newDN>' | null
#   }

$ErrorActionPreference = 'Stop'

# R136 encoding fix: PS 5.1 default [Console]::OutputEncoding is the
# system ANSI codepage (CP936/GB18030 on CN Windows). Setting UTF8 makes
# ConvertTo-Json emit the original .NET bytes verbatim so the centre's
# NVARCHAR column sees the correct UTF-16 code points.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'

$server = $env:COMPUTERNAME

# ── Parse arguments ────────────────────────────────────────────────────
$action = $null
$targetDn = $null
$newParentDn = $null

for ($i = 0; $i -lt $args.Count; $i++) {
  $a = $args[$i]
  switch ($a) {
    '--action'       { $action = $args[++$i] }
    '--targetDn'     { $targetDn = $args[++$i] }
    '--newParentDn'  { $newParentDn = $args[++$i] }
    default { [Console]::Error.WriteLine("unknown arg: $a") }
  }
}

# ── Idle mode ─────────────────────────────────────────────────────────
if (-not $action) {
  $metrics = @{
    agent_id     = $server
    dc_name      = $server
    # R158.52 — operator directive "零或空": idle mode emits
    # `collected_at` for parity with sibling ad_ad_object_delete.
    collected_at = (Get-Date).ToUniversalTime().ToString('o')
    idle         = $true
  }
  $metrics | ConvertTo-Json -Compress -Depth 4
  exit 0
}

$startMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

try {
  Import-Module ActiveDirectory -ErrorAction Stop
} catch {
  $endMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  @{
    action              = 'move'
    target              = $targetDn
    success             = $false
    error               = "Import-Module ActiveDirectory failed: $($_.Exception.Message)"
    durationMs          = $endMs - $startMs
    newDistinguishedName = $null
  } | ConvertTo-Json -Compress -Depth 6
  exit 1
}

if ($action -ne 'move') {
  $endMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  @{
    action              = $action
    target              = $targetDn
    success             = $false
    error               = "unsupported action '$action'"
    durationMs          = $endMs - $startMs
    newDistinguishedName = $null
  } | ConvertTo-Json -Compress -Depth 6
  exit 1
}

if (-not $targetDn -or -not $newParentDn) {
  $endMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  @{
    action              = 'move'
    target              = $targetDn
    success             = $false
    error               = 'invalid params: targetDn and newParentDn required'
    durationMs          = $endMs - $startMs
    newDistinguishedName = $null
  } | ConvertTo-Json -Compress -Depth 6
  exit 1
}

try {
  Move-ADObject -Identity $targetDn -TargetPath $newParentDn -ErrorAction Stop
  # R158.52 — operator directive "零或空 / 避免数据错误": re-fetch the
  # canonical DN from AD instead of reconstructing via string concat.
  # The previous `$firstRdn,$newParentDn` shortcut produced malformed
  # DNs when the RDN contained escaped characters (e.g. CN=Service\, Account
  # where the `\,` escape lost its meaning after the comma split). The
  # post-move Get-ADObject returns the exact AD-stored DN with proper
  # escaping. Falls back to the string concat only if the re-fetch fails
  # (e.g. cross-domain replication lag).
  $newDn = $null
  try {
    $moved = Get-ADObject -Identity $targetDn -Server $server -ErrorAction Stop
    $newDn = [string]$moved.DistinguishedName
  } catch {
    $firstRdn = ($targetDn -split ',', 2)[0]
    $newDn = "$firstRdn,$newParentDn"
  }
  $endMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  @{
    action              = 'move'
    target              = $targetDn
    success             = $true
    error               = $null
    durationMs          = $endMs - $startMs
    newDistinguishedName = $newDn
  } | ConvertTo-Json -Compress -Depth 6
  exit 0
} catch {
  $endMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  @{
    action              = 'move'
    target              = $targetDn
    success             = $false
    error               = $_.Exception.Message
    durationMs          = $endMs - $startMs
    newDistinguishedName = $null
  } | ConvertTo-Json -Compress -Depth 6
  exit 1
}