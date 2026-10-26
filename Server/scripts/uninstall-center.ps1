[CmdletBinding()]
param(
  [string]$InstallPath,
  [switch]$RemoveData
)

# $PSScriptRoot is empty in [CmdletBinding()] default param values (parameter
# binding scope is a child of script scope; auto-vars only set in script scope).
# Resolve default InstallPath in the body where $PSScriptRoot is available.
#
# 布局事实 (2026-10-25 修复): 绿色包根 = <scripts 的上一级>, 源码树 = <包根>\center,
# 默认安装路径 = <包根>\Center。Windows 大小写不敏感 ⇒ 这两个是**同一个物理目录**。
# 旧实现直接 `Remove-Item -Recurse`, 于是"卸载"把绿包自己的 src/ web/ dist/
# node_modules/ appsettings.json 一起删光 (2026-10-25 实际发生: 一次卸载之后
# 整个 center\ 消失, 连 dist/index.html 都没了)。装链侧早就用 Test-SamePath
# 挡住了同一个坑 (install-center.ps1:145-150 的 "same-path → 不复制也不删"),
# 卸载侧漏了 —— 同一个 bug 家族, 兄弟脚本 agent 版也有守卫
# (uninstall-agent.ps1:79-101), 只有 center 版没有。
#
# 现在的契约跟 uninstall-agent.ps1 完全一致:
#   卸载 = 摘服务 (Remove-ServiceSafe); 文件默认保留在盘上。
#   只有当安装路径确实是一份**独立的**安装副本 (与源码树不是同一目录) 时才删目录。
#   要在服务器上做彻底清理, 卸载后手工删目录即可 —— 不给脚本留"一键误删源码"的
#   默认路径。
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $InstallPath) {
  $InstallPath = Join-Path $projectRoot 'Center'
}

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'common\Logger.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\NSSM.psm1') -Force
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
# 要删掉的目录。于是卸载脚本把自己的日志目录一起删了, 之后每一条 Write-Log 的
# Add-Content 都抛 DirectoryNotFound (GetContentWriterDirectoryNotFoundError),
# 结果是**卸载记录一条都没落盘** (2026-10-25 实际发生: 控制台看到
# "[INFO] removed ..." 和 "[OK] done", 但文件里什么都没有)。
#
# 现在优先用发布包根 <projectRoot>\Logs (不在删除范围内); 只有当它落在
# InstallPath 之内时 (脚本被放在安装目录内部的布局) 才退到 InstallPath 的父目录,
# 再不行退到 %TEMP%\ADDashboard-logs。
$Script:LogDir = Join-Path $projectRoot 'Logs'
if (Test-PathWithin -Child $Script:LogDir -Parent $InstallPath) {
  $Script:LogDir = Join-Path (Split-Path -Parent $InstallPath) 'Logs'
}
if (Test-PathWithin -Child $Script:LogDir -Parent $InstallPath) {
  $Script:LogDir = Join-Path ([System.IO.Path]::GetTempPath()) 'ADDashboard-logs'
}
if (-not (Test-Path -LiteralPath $Script:LogDir)) { New-Item -ItemType Directory -Path $Script:LogDir -Force | Out-Null }
# R119 — per-module/per-route server-side log directory. <LogDir>/APP/ is where
# this script's rotated file lives. Set BEFORE the first Write-* call (which
# fires on the next line) so the dual-write Write-Log lands in
# <LogDir>/APP/uninstall-center.log instead of the publish-root fallback.
# Mkdir APP/ explicitly so Write-Log's lazy mkdir (second line of defence)
# never sees a missing parent on a fresh uninstall run.
$Script:AppLogDir = Join-Path $Script:LogDir 'APP'
if (-not (Test-Path -LiteralPath $Script:AppLogDir)) { New-Item -ItemType Directory -Path $Script:AppLogDir -Force | Out-Null }
Set-LogDir $Script:LogDir
Set-LogModule 'uninstall-center'
# R119.B boot fingerprint — single line naming the running version + git
# commit so operators can prove which code is installed.
$mfst = Get-AgentManifest
$commit = if ($mfst -and $mfst.gitCommit) { $mfst.gitCommit } else { 'unknown' }
Write-Info ("{0} v{1} (commit={2})" -f $MyInvocation.MyCommand.Name, (Get-AgentVersion), $commit)

Write-Step "uninstalling center"
Remove-ServiceSafe -Name 'ADDashboardCenter'

# ---- 源码树判定: 安装路径 == 绿包自己的 center 目录 ⇒ 不删文件 ---------------
# 判据用 Service.psm1 的 Test-SamePath, **不再**用内联的 ProviderPath 比较。
# 内联比较有个致命缺口 (2026-10-25 实测): Resolve-Path 保留尾部分隔符 ——
#   Resolve-Path -LiteralPath 'D:\pkg\scripts\'  →  'D:\pkg\scripts\'
#   Resolve-Path -LiteralPath 'D:\pkg\scripts'   →  'D:\pkg\scripts'
# 于是操作员只要在 -InstallPath 末尾带一个 '\' (Windows 上极常见的手写习惯),
# OrdinalIgnoreCase 比较就落空 ⇒ 这道"防误删源码树"的守卫直接失效 ⇒
# 2026-10-25 那场事故原样重演。Test-SamePath 会 TrimEnd('\','/') 并做
# 大小写不敏感比较, 两种写法都判 True。
$sourceTree = Join-Path $projectRoot 'center'
if (Test-SamePath -PathA $InstallPath -PathB $sourceTree) {
  Write-Step "install path equals the source tree ($InstallPath) — service unregistered, files kept on disk"
  Write-Info "kept: src/ web/ dist/ node_modules/ appsettings.json (green package stays intact; remove the folder by hand for a clean wipe)"
} elseif (Test-Path -LiteralPath $InstallPath) {
  # 盘根护栏: `Remove-Item -LiteralPath 'D:\' -Recurse -Force` 是灾难性的。
  $normalized = (ConvertTo-ComparablePath -Path $InstallPath)
  if ($normalized -match '^[a-z]:$') {
    throw "refusing to delete a drive root: $InstallPath"
  }
  Remove-Item -LiteralPath $InstallPath -Recurse -Force
  Write-Info "removed $InstallPath"
} else {
  Write-Info "install path not found: $InstallPath (nothing to remove)"
}

# -RemoveData removed a hardcoded `C:\addashboard` tree in the old layout.
# In the script-relative layout there is no single parent to wipe (parent is
# the publish bundle which we must NOT delete). The flag is kept for caller
# compatibility and acts as a no-op; data persisted to MSSQL is unaffected.
# Runtime state that still lives on disk under the install path (center\data,
# center\Logs) belongs to the install root, not to this script — the operator
# removes those with the folder itself.
Write-Ok "done"
