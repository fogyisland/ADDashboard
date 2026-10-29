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

# ---- 盘根护栏 (第一层): 必须在任何路径拼接/日志目录计算之前拦截 -------------
# 旧实现**完全没有**这道护栏, 而删除处那个 '^[a-z]:$' 正则也是死代码
# (ConvertTo-ComparablePath('D:\') 产出 'd:\' —— common\Service.psm1 刻意保留
# 尾分隔符 ⇒ 永远不命中)。于是在客户机上:
#   -InstallPath 'E:\'  ⇒ Remove-Item -LiteralPath 'E:\' -Recurse -Force
#                       ⇒ **整块 E 盘被清空** (PowerShell 不会拒绝删盘根)
#   -InstallPath 'D:'   ⇒ GetFullPath('D:') 按 CWD 解析, 删掉的是**当前目录**,
#                       且完全绕开盘根判定
# 提前拦截还有第二个作用: 否则下面 Join-Path (Split-Path -Parent 'D:\') 'Logs'
# 会先抛 "Cannot bind argument to parameter 'Path' because it is an empty
# string", 操作员看到的是天书, 跟"你要删的是盘根"毫无关系。
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

# 判断 $Child 是否位于 $Parent 之内 (大小写不敏感, 边界安全: C:\a 不算在 C:\ab 里)。
function Test-PathWithin {
  param([string]$Child, [string]$Parent)
  if (-not $Child -or -not $Parent) { return $false }
  $c = [System.IO.Path]::GetFullPath($Child).TrimEnd('\')
  $p = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\')
  return $c.StartsWith($p + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

# ---- 日志目录: 必须活过这次卸载本身 ----------------------------------------
# 旧实现把 LogDir 设成 <InstallPath>\Logs —— 而 <InstallPath> 正是下一步要
# 删掉的目录。于是卸载脚本把自己的日志目录一起删了, 之后每一条 Write-Log
# 的 Add-Content 都抛 DirectoryNotFound, 结果是**卸载记录一条都没落盘**
# (排障时最需要的那份证据恰恰没了)。
# 现在优先用发布包根 <脚本所在目录>\Logs (不在删除范围内), 落在 InstallPath
# 之内时退到 InstallPath 的父目录, 再不行退到 %TEMP%。
$Script:LogDir = Join-Path $PSScriptRoot 'Logs'
if (Test-PathWithin -Child $Script:LogDir -Parent $InstallPath) {
  $Script:LogDir = Join-Path (Split-Path -Parent $InstallPath) 'Logs'
}
if (Test-PathWithin -Child $Script:LogDir -Parent $InstallPath) {
  $Script:LogDir = Join-Path ([System.IO.Path]::GetTempPath()) 'ADDashboard-logs'
}
if (-not (Test-Path -LiteralPath $Script:LogDir)) { New-Item -ItemType Directory -Path $Script:LogDir -Force | Out-Null }
Set-LogDir $Script:LogDir

Write-Step "uninstalling agent on $env:COMPUTERNAME"
& (Join-Path $PSScriptRoot 'Register-ADDashboardAgent.ps1') `
    -InstallPath $InstallPath `
    -CenterUrl   '' `
    -AgentToken  '' `
    -AgentType   'non-ad' `
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
# Unregister 分支不写 $LASTEXITCODE。改成: 只有拿到**数字型**非零退出码
# 才算失败; 而"服务到底注销了没有"交给下面的终态验证。
if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) {
  Write-Err2 "Register Unregister failed (exit $LASTEXITCODE)"
}
# 终态验证: 服务必须真的没了才继续删文件。注销失败还继续删目录 ⇒
# "服务还注册着 + 文件已被删" 的半成品 (NSSM 会因为 AppExit Default Restart
# 无限重启一个不存在的文件, 表现为崩溃重启循环)。
$stillRegistered = [bool](Get-Service -Name 'memberServiceAgent' -ErrorAction SilentlyContinue)
if ($stillRegistered) {
  throw "service 'memberServiceAgent' is still registered after Unregister — refusing to delete $InstallPath (re-run as Administrator; the service may be in use)"
}

# Detect Windows case-collision between InstallPath and the green-package's
# agent/ source dir. On Windows the default install path <root>/Agent and the
# source <root>/agent resolve to the same physical directory; if we proceed
# with Remove-Item here we'd nuke the green package (including install-agent.ps1,
# agent.js, package.json, etc.). Refuse the directory removal in that case —
# the service has already been unregistered above, so the operator's intent
# (stop the agent) is satisfied. The green package remains on disk for
# re-install or troubleshooting.
$greenPkgAgent = Join-Path $PSScriptRoot 'agent'
$devTreeAgent  = Join-Path (Join-Path $PSScriptRoot '..') 'agent'
$candidateSrc  = $null
if (Test-Path $greenPkgAgent) { $candidateSrc = $greenPkgAgent }
elseif (Test-Path $devTreeAgent) { $candidateSrc = $devTreeAgent }
$resolvedInstall = (Resolve-Path -LiteralPath $InstallPath -ErrorAction SilentlyContinue).ProviderPath
$resolvedSrc     = if ($candidateSrc) { (Resolve-Path -LiteralPath $candidateSrc -ErrorAction SilentlyContinue).ProviderPath } else { $null }
if ($resolvedInstall -and $resolvedSrc -and [string]::Equals($resolvedInstall, $resolvedSrc, [StringComparison]::OrdinalIgnoreCase)) {
  Write-Step "install path equals source path ($resolvedInstall); leaving green package on disk (service already unregistered)"
} elseif (Test-Path -LiteralPath $InstallPath) {
  # ---- 盘根护栏 (第二层) ----------------------------------------------------
  # 第一层 (脚本开头) 只拦"裸盘符" ('D:'); 这里拦**真正的盘根** ('D:\') 和
  # UNC 共享根 ('\\server\share')。
  #
  # 判据: [System.IO.Path]::GetPathRoot($full) == $full (忽略大小写与尾分隔符)
  # ⇔ 这个路径本身就是根。旧实现的 '^[a-z]:$' 正则既拦不住 'D:\' (尾分隔符),
  # 也压根拦不住 UNC 共享根。
  $fullInstallPath = $null
  try { $fullInstallPath = [System.IO.Path]::GetFullPath($InstallPath) } catch { $fullInstallPath = $InstallPath }
  $installPathRoot = $null
  try { $installPathRoot = [System.IO.Path]::GetPathRoot($fullInstallPath) } catch { $installPathRoot = $null }
  $isFilesystemRoot = $false
  if ($installPathRoot) {
    $trimmedPath = $fullInstallPath.TrimEnd('\','/')
    $trimmedRoot = $installPathRoot.TrimEnd('\','/')
    $isFilesystemRoot = [string]::Equals($trimmedPath, $trimmedRoot, [StringComparison]::OrdinalIgnoreCase)
  }
  if ($isFilesystemRoot) {
    throw "refusing to delete a filesystem root: $InstallPath (root = $installPathRoot) — 根目录下递归删除会清空整块卷/共享"
  }
  # 用 -LiteralPath 而不是 -Path: 后者会做通配符解释, 路径里带 [ ] 时可能命中
  # 非预期目标。
  Remove-Item -LiteralPath $InstallPath -Recurse -Force
  # -RemoveData was a no-op alias for $InstallPath removal in the old layout.
  # Kept for caller compatibility — InstallPath (which contains queue.db and
  # logs) is already gone above.
}
Write-Ok "done"