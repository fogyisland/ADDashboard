# AD Dashboard Center code-only update (legacy hot-fix path).
# Replaces code + node_modules + dist and restarts the service. Does NOT
# apply DB migrations or refresh shipped dist — for "扩展架构" deployments
# that include schema changes, use upgrade-center.ps1 instead. This script
# is intentionally minimal for the common case of "code-only hot-fix".
[CmdletBinding()]
param(
  [string]$InstallPath,
  [int]$ListenPort = 8080,
  [switch]$RebuildFrontend
)

# $PSScriptRoot is empty in [CmdletBinding()] default param values (parameter
# binding scope is a child of script scope; auto-vars only set in script scope).
# Resolve default InstallPath in the body where $PSScriptRoot is available.
if (-not $InstallPath) {
  $InstallPath = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')) 'Center')
}

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'common\Logger.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\NSSM.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\Service.psm1') -Force

# R119 — per-module/per-route server-side log directory. Mirror the
# install-center.ps1 / uninstall-center.ps1 layout: <InstallPath>/Logs/APP/
# is where this script's rotated file lives. Set BEFORE the first Write-*
# call below so the dual-write Write-Log lands in
# <InstallPath>/Logs/APP/update-center.log instead of the publish-root
# fallback. Mkdir APP/ explicitly so Write-Log's lazy mkdir (second line of
# defence) never sees a missing parent on a fresh update run.
$Script:LogDir = Join-Path $InstallPath 'Logs'
if (-not (Test-Path $Script:LogDir)) { New-Item -ItemType Directory -Path $Script:LogDir -Force | Out-Null }
$Script:AppLogDir = Join-Path $Script:LogDir 'APP'
if (-not (Test-Path $Script:AppLogDir)) { New-Item -ItemType Directory -Path $Script:AppLogDir -Force | Out-Null }
Set-LogDir $Script:LogDir
Set-LogModule 'update-center'
# R119.B boot fingerprint — single line naming the running version + git
# commit so operators can prove which code is installed.
$mfst = Get-AgentManifest
$commit = if ($mfst -and $mfst.gitCommit) { $mfst.gitCommit } else { 'unknown' }
Write-Info ("{0} v{1} (commit={2})" -f $MyInvocation.MyCommand.Name, (Get-AgentVersion), $commit)

Write-Step "stopping service"
if (-not (Stop-ServiceSafe -Name 'ADDashboardCenter' -WaitSeconds 30)) { throw 'cannot stop service' }

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
if ($RebuildFrontend) {
  Write-Step "rebuilding web UI"
  Push-Location $repoRoot
  try {
    # vite 是 center 的 devDependency, 而依赖安装走 `npm install --omit=dev`
    # ⇒ 上游任何一次生产依赖安装都会把 vite 从根 node_modules 里剪掉。
    # 不自愈就直接构建 = "vite: not found" (install-center.ps1 /
    # upgrade-center.ps1 都有这道自愈, 这里原来漏了)。
    if (-not (Test-Path (Join-Path $repoRoot 'node_modules\vite'))) {
      Write-Step "installing center dev dependencies (vite missing)"
      & npm.cmd install --workspace=center --include=dev
      if ($LASTEXITCODE -ne 0) { throw "npm install --workspace=center --include=dev failed (exit $LASTEXITCODE)" }
    }
    # 构建失败必须当场炸 —— 旧实现只看 $LASTEXITCODE 而这里连看都没看,
    # vite 报错时脚本照样往下走, 把"上一版 dist"发布出去, 现场表现为
    # "改了前端没生效"且没有任何错误提示。
    & npm.cmd run build:web --workspace=center
    if ($LASTEXITCODE -ne 0) { throw "npm run build:web --workspace=center failed (exit $LASTEXITCODE)" }
  } finally { Pop-Location }
  if (-not (Test-Path (Join-Path $repoRoot 'center\dist\index.html'))) {
    throw "web UI build did not produce $(Join-Path $repoRoot 'center\dist\index.html')"
  }
}
Write-Step "copying files"
# Copy-DirectoryContent skips the copy when source and target are the same
# directory — the default install path '<root>\Center' and the source tree
# '<root>\center' are the same directory on Windows (case-insensitive), so
# the old unconditional Copy-Item copied the tree onto itself.
$codeCopy = Copy-DirectoryContent -SourceDir (Join-Path $repoRoot 'center') -TargetDir $InstallPath `
  -Exclude @('node_modules', 'tests', 'appsettings.json', '.install-hash', 'Logs')
Write-Info $codeCopy.Message
if ($codeCopy.Status -eq 'same-path') {
  Write-Warn2 "install path is the source tree ($InstallPath) — running in place, no code copy performed"
}
# 依赖安装: 判据 = 依赖能否被 require 解析 (npm workspaces 提升安装下
# <InstallPath>\node_modules 未必存在, 用目录存在性判会永远误判为"缺失")。
# 旧实现: `npm install --omit=dev` 不看退出码, 失败也照样往下走 ⇒ 服务带着
# 残缺依赖启动 ⇒ 崩溃重启循环 (R121 / R123 / R124 家族)。
Push-Location $InstallPath
try {
  & npm.cmd install --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm install --omit=dev failed in $InstallPath (exit $LASTEXITCODE)" }
} finally { Pop-Location }
if (-not (Test-NodeDepsResolvable -InstallPath $InstallPath)) {
  throw "dependencies still not resolvable after npm install in $InstallPath — 绝不带着残缺依赖启动服务"
}
if ($RebuildFrontend -and (Test-Path (Join-Path $repoRoot 'center\dist'))) {
  $distCopy = Sync-DirectoryContent -SourceDir (Join-Path $repoRoot 'center\dist') -TargetDir (Join-Path $InstallPath 'dist')
  Write-Info $distCopy.Message
}
Write-Step "starting service"
# 旧实现 `Start-ServiceSafe ... | Out-Null` 把返回值丢了 —— 服务起不来时
# 脚本照样打印 "update complete", 操作员以为更新成功, 实际服务根本没跑。
if (-not (Start-ServiceSafe -Name 'ADDashboardCenter' -WaitSeconds 20)) {
  Write-Err2 "service failed to start; see the center log directory $Script:LogDir (center.<date>.<n>.log / APP\<module>.log)"
  exit 1
}
# HTTP 就绪探针 —— SCM 说 Running 只代表 NSSM 拉起了 node, Express 还要
# 加载模块 + 绑定端口 (冷启动 2-15s)。不探针 = 更新完就说"完成"。
$probeUrl = "http://localhost:$ListenPort/api/init/status"
if (-not (Wait-ForHttpOk -Url $probeUrl -TimeoutSeconds 30 -IntervalSeconds 1)) {
  throw "service is up (per SCM) but HTTP probe at $probeUrl did not return 2xx within 30s. Check the center log directory $Script:LogDir (center.<date>.<n>.log / APP\<module>.log)."
}
Write-Ok "update complete"