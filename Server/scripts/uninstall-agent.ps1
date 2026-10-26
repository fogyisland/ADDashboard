[CmdletBinding()]
param(
  [string]$InstallPath,
  [switch]$RemoveData
)

# $PSScriptRoot is empty in [CmdletBinding()] default param values (parameter
# binding scope is a child of script scope; auto-vars only set in script scope).
# Resolve default InstallPath in the body where $PSScriptRoot is available.
#
# Two supported layouts (mirror of start.ps1:88-104 + install-agent.ps1):
#   GREEN PACKAGE: $PSScriptRoot\agent\  (script at <green>/agentInstall/,
#                                         agent/ is a sibling — flat layout).
#                     Uninstall path mirrors install: the green package's
#                     install path IS the current directory's agent/ subdir,
#                     so uninstall targets the same dir without prompting.
#   DEV TREE:      $PSScriptRoot\..\Agent\ (script at <repo>/scripts/,
#                                          parent is repo root).
#
# Without this green-pkg-first check, the legacy default always resolves to
# <PSScriptRoot>\..\Agent = C:\Agent on a green-pkg run → Set-LogDir fails →
# Logger.psm1:21 Add-Content can't write to C:\Agent\Logs\install.log.
if (-not $InstallPath) {
  $greenPkgAgent = Join-Path $PSScriptRoot 'agent'
  $devTreeAgent  = Join-Path (Join-Path $PSScriptRoot '..') 'agent'
  if (Test-Path $greenPkgAgent) {
    $InstallPath = $greenPkgAgent
  } elseif (Test-Path $devTreeAgent) {
    $InstallPath = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')) 'Agent'
  } else {
    throw "agent/ source not found. Tried '$greenPkgAgent' (green-package layout) and '$devTreeAgent' (dev-tree layout). Verify the bundle layout."
  }
}

# ---- 盘根护栏: 必须在任何路径拼接/日志目录计算之前拦截 ----------------------
# 旧实现在删除前才检查, 用的正则是 '^[a-z]:$', 而
# ConvertTo-ComparablePath('D:\') 产出的是 'd:\' —— common\Service.psm1:26-30
# 刻意保留尾分隔符 (只有长度 < 3 才不裁, 'D:\' 长度正好 3) ⇒ 该正则**永远
# 不命中** ⇒ 护栏是死代码。实测:
#   ConvertTo-ComparablePath 'D:\'  => 'd:\'   -match '^[a-z]:$' => False
# 于是两条致命路径畅通无阻:
#   -InstallPath 'E:\' ⇒ Remove-Item -LiteralPath 'E:\' -Recurse -Force
#                     ⇒ 整块 E 盘被清空 (PowerShell 不会拒绝删盘根)
#   -InstallPath 'D:'  ⇒ GetFullPath('D:') 按 CWD 解析, Remove-Item 'D:'
#                     ⇒ 删掉的是**当前目录**的内容, 而且完全绕开盘根判定
# 提前拦截还有第二个作用: 否则下面第 70 行的
# Join-Path (Split-Path -Parent 'D:\') 'Logs' 会先抛 "Cannot bind argument to
# parameter 'Path' because it is an empty string" (Split-Path -Parent 'D:\'
# 返回空串), 操作员看到的是天书, 跟"你要删的是盘根"毫无关系。
$installPathTrimmed = ([string]$InstallPath).Trim().TrimEnd('\','/')
if ($installPathTrimmed -match '^[A-Za-z]:$') {
  throw "refusing to uninstall from a drive root: '$InstallPath' — 盘根/裸盘符不是合法的 agent 安装目录 (会清空整块磁盘)"
}

# ============================================================================
# Uninstall AD Dashboard Agent.
#
# 2026-08-23 split: this script now ONLY removes the install directory; the
# SCM-facing steps (Stop service + nssm remove) live in
# Register-ADDashboardAgent.ps1 -Action Unregister — the same single entry
# point that install-agent.ps1 invokes with -Action Register. This eliminates
# the prior split where uninstall-agent.ps1 directly imported common/Service.psm1
# while install-agent.ps1 went through a different code path; both now share
# the same NSSM/Service recovery sequence.
# ============================================================================

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'common\Logger.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\Service.psm1') -Force

# 判断 $Child 是否位于 $Parent 之内 (大小写不敏感, 边界安全: C:\a 不算在 C:\ab 里)。
function Test-PathWithin {
  param([string]$Child, [string]$Parent)
  if (-not $Child -or -not $Parent) { return $false }
  $c = [System.IO.Path]::GetFullPath($Child).TrimEnd('\')
  $p = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\')
  return $c.StartsWith($p + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

# ---- 日志目录: 必须活过这次卸载本身 ----------------------------------------
# 旧实现把 LogDir 设成 <InstallPath>\Logs —— 而 <InstallPath> 可能正是下一步
# 要删掉的目录。于是卸载脚本把自己的日志目录一起删了, 之后每一条 Write-Log
# 的 Add-Content 都抛 DirectoryNotFound, 结果是**卸载记录一条都没落盘**
# (2026-10-25 center 版实际发生过; agent 版是同一个 bug 家族, 当时没跟修)。
# 现在优先用发布包根 <scripts 的上一级>\Logs (不在删除范围内), 落在
# InstallPath 之内时退到 InstallPath 的父目录, 再不行退到 %TEMP%。
$packageRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Script:LogDir = Join-Path $packageRoot 'Logs'
if (Test-PathWithin -Child $Script:LogDir -Parent $InstallPath) {
  $Script:LogDir = Join-Path (Split-Path -Parent $InstallPath) 'Logs'
}
if (Test-PathWithin -Child $Script:LogDir -Parent $InstallPath) {
  $Script:LogDir = Join-Path ([System.IO.Path]::GetTempPath()) 'ADDashboard-logs'
}
if (-not (Test-Path -LiteralPath $Script:LogDir)) { New-Item -ItemType Directory -Path $Script:LogDir -Force | Out-Null }
# R119 — per-module log file for this uninstaller (dual-writes into legacy
# <LogDir>/install.log via Logger.psm1::Write-Log). Subsequent Write-*
# calls land in <LogDir>/APP/uninstall-agent.log so the operator's tail
# on the per-module dir sees only this script's stream.
$Script:AppLogDir = Join-Path $Script:LogDir 'APP'
if (-not (Test-Path -LiteralPath $Script:AppLogDir)) { New-Item -ItemType Directory -Path $Script:AppLogDir -Force | Out-Null }
Set-LogDir $Script:LogDir
Set-LogModule 'uninstall-agent'
# R119.B boot fingerprint — single line naming the running version + git
# commit so operators can prove which code is installed.
$mfst = Get-AgentManifest
$commit = if ($mfst -and $mfst.gitCommit) { $mfst.gitCommit } else { 'unknown' }
Write-Info ("{0} v{1} (commit={2})" -f $MyInvocation.MyCommand.Name, (Get-AgentVersion), $commit)

Write-Step "uninstalling agent on $env:COMPUTERNAME"
& (Join-Path $PSScriptRoot 'Register-ADDashboardAgent.ps1') `
    -InstallPath $InstallPath `
    -CenterUrl   '' `
    -AgentToken  '' `
    -AgentType   'ad' `
    -Action      Unregister `
    -SkipStart
# CenterUrl / AgentToken are unused by -Action Unregister; the placeholder
# values satisfy Register-ADDashboardAgent.ps1's [Parameter(Mandatory)] on
# both. -SkipStart is irrelevant for Unregister but kept symmetric with
# install-agent.ps1's call shape.
#
# $LASTEXITCODE 判空: 全新会话里它是 $null, 而 `$null -ne 0` 为 **True**
# ⇒ 旧实现每次卸载都误报 "Register Unregister failed: " (错误码还是空的),
# 而且它**永远检测不到真实失败** —— Register-ADDashboardAgent.ps1 的
# Unregister 分支不写 $LASTEXITCODE。所以改成: 只有拿到**数字型**非零
# 退出码才算失败; 而"服务到底注销了没有"交给下面的终态验证。
if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) {
  Write-Err2 "Register Unregister failed (exit $LASTEXITCODE)"
}
# 终态验证: 服务必须真的没了才继续删文件。注销失败还继续删目录 ⇒
# "服务还注册着 + 文件已被删" 的半成品 (NSSM 会因为 AppExit Default Restart
# 无限重启一个不存在的文件)。
$stillRegistered = [bool](Get-Service -Name 'ADReplicationAgent' -ErrorAction SilentlyContinue)
if ($stillRegistered) {
  throw "service 'ADReplicationAgent' is still registered after Unregister — refusing to delete $InstallPath (re-run as Administrator; the service may be in use)"
}

# Detect Windows case-collision between InstallPath and the green-package's
# agent/ source dir. On Windows the default install path <root>/Agent and the
# source <root>/agent resolve to the same physical directory; if we proceed
# with Remove-Item here we'd nuke the green package (including install-agent.ps1,
# agent.js, package.json, etc.). Refuse the directory removal in that case —
# the service has already been unregistered above, so the operator's intent
# (stop the agent) is satisfied. The green package remains on disk for
# re-install or troubleshooting.
#
# 判据用 Service.psm1 的 Test-SamePath, **不再**用内联的 ProviderPath 比较 ——
# 内联比较在 -InstallPath 带尾 '\' 时会失效 (Resolve-Path 保留尾分隔符,
# 实测 'D:\pkg\scripts\' ≠ 'D:\pkg\scripts'), 那正是防误删的守卫本身失效。
$greenPkgAgent = Join-Path $PSScriptRoot 'agent'
$devTreeAgent  = Join-Path (Join-Path $PSScriptRoot '..') 'agent'
$candidateSrc  = $null
if (Test-Path $greenPkgAgent) { $candidateSrc = $greenPkgAgent }
elseif (Test-Path $devTreeAgent) { $candidateSrc = $devTreeAgent }
if ($candidateSrc -and (Test-SamePath -PathA $InstallPath -PathB $candidateSrc)) {
  Write-Step "install path equals source path ($InstallPath); leaving green package on disk (service already unregistered)"
} elseif (Test-Path -LiteralPath $InstallPath) {
  # 盘根护栏 + LiteralPath (不用 -Path, 后者会做通配符解释, 路径里带
  # [ ] 时可能命中非预期目标)。
  # 盘根判定改用 [System.IO.Path]::GetPathRoot(): 路径的根 == 路径本身 ⇒ 就是
  # 根目录。旧实现的 '^[a-z]:$' 正则对 'D:\' 永远不命中 (原因见文件头的护栏
  # 说明), 而且它压根拦不住 UNC 共享根 (\\server\share)。
  $fullInstallPath = $null
  try { $fullInstallPath = [System.IO.Path]::GetFullPath($InstallPath) } catch { $fullInstallPath = $InstallPath }
  $installPathRoot = $null
  try { $installPathRoot = [System.IO.Path]::GetPathRoot($fullInstallPath) } catch { $installPathRoot = $null }
  if ($installPathRoot -and (Test-SamePath -PathA $fullInstallPath -PathB $installPathRoot)) {
    throw "refusing to delete a filesystem root: $InstallPath (root = $installPathRoot) — 根目录下递归删除会清空整块卷/共享"
  }
  Remove-Item -LiteralPath $InstallPath -Recurse -Force
  # -RemoveData was a no-op alias for $InstallPath removal in the old layout.
  # Kept for caller compatibility — InstallPath (which contains queue.db and
  # logs) is already gone above.
}
Write-Ok "done"