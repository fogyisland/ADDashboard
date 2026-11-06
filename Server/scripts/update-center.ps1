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
# R161.25 — $repoRoot 提前到启动指纹之前求值 (原来在下面 "copying files"
# 之前才赋值, 于是指纹那几行拿到的是 $null)。
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
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
# R161.25 (2026-10-29 部署审计): 读**中心**的清单 (build-manifest.json),
# 不是 agent 的 —— 旧实现调 Get-AgentManifest, 打印出来的是 **agent 的
# 版本号**, 操作员会以为中心装的是 agent 那一版。
$mfst = Get-CenterManifest -ManifestRoot $repoRoot
$commit = if ($mfst -and $mfst.gitCommit) { $mfst.gitCommit } else { 'unknown' }
Write-Info ("{0} v{1} (commit={2})" -f $MyInvocation.MyCommand.Name, (Get-CenterVersion -ManifestRoot $repoRoot), $commit)

Write-Step "stopping service"
if (-not (Stop-ServiceSafe -Name 'ADDashboardCenter' -WaitSeconds 30)) { throw 'cannot stop service' }

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
  -Exclude (Get-CenterCopyExclusions)
Write-Info $codeCopy.Message
if ($codeCopy.Status -eq 'same-path') {
  Write-Warn2 "install path is the source tree ($InstallPath) — running in place, no code copy performed"
}
# R161.25 (2026-10-29 部署审计) — 刷新 <安装目录上一级>\db。
#   旧实现只有 install-center.ps1 拷 db/ ⇒ 目标机的 db/migrations/ 停在首次
#   安装时的那一版 ⇒ 新迁移到不了目标机 ⇒ 数据库停在旧 schema (静默)。
$dbSync = Sync-CenterDbDirectory -SourceRoot $repoRoot -InstallPath $InstallPath
Write-Info "db/ refreshed: $($dbSync.Message)"
$manifestSync = Sync-CenterBuildManifest -SourceRoot $repoRoot -InstallPath $InstallPath
Write-Info $manifestSync.Message
# 依赖安装: 判据 = 依赖能否被 require 解析 (npm workspaces 提升安装下
# <InstallPath>\node_modules 未必存在, 用目录存在性判会永远误判为"缺失")。
# 旧实现: `npm install --omit=dev` 不看退出码, 失败也照样往下走 ⇒ 服务带着
# 残缺依赖启动 ⇒ 崩溃重启循环 (R121 / R123 / R124 家族)。
#
# R161.26 — 走**共享实现** (Service.psm1::Install-CenterNodeDeps):
#   · **工作区感知** —— 在成员目录里跑 npm install, npm 认的 install root
#     是工作区根 ⇒ 成员自己的 devDependencies (vite/vitest/jsdom/...) 会被
#     一起剪掉 (实测 "removed 140 packages") ⇒ 装完这台机器再也 build 不出
#     前端、跑不了 web 测试, 报错是 "vite: not found" —— 与部署毫无关系。
#     共享实现装完会把工具链装回来 (只在装之前本机就有时才恢复 ⇒ 生产
#     目标机行为不变)。
#   · **显式限定工作区** —— 兄弟工作区 (agent) 的原生依赖 better-sqlite3
#     **只有在工作区根上跑** install 才会被拉进来 (实测: 根上跑会
#     "add better-sqlite3 11.10.0" + 30 个包)。旧代码躲过这一劫靠的是
#     "cwd 恰好在成员目录"这个**巧合** ⇒ 作用域必须显式写进命令行。
#   · 装完**复验**依赖可解析, 失败当场抛。
# install / upgrade / update 三条链必须走同一份实现, 否则修好一处另两处照旧。
$depResult = Install-CenterNodeDeps -InstallPath $InstallPath -ProjectRoot $repoRoot
Write-Info ("npm install: mode={0} root={1} workspace={2}" -f $depResult.Mode, $depResult.Root, $depResult.Member)
if ($depResult.DevToolingRestoreFailed) {
  Write-Warn2 ("could not restore the dev toolchain at {0} — 'npm run build:web' / 'npm run test:web' will fail until you run: npm install --workspace={1} --include=dev" -f $depResult.Root, $depResult.Member)
}
if ($RebuildFrontend -and (Test-Path (Join-Path $repoRoot 'center\dist'))) {
  $distCopy = Sync-DirectoryContent -SourceDir (Join-Path $repoRoot 'center\dist') -TargetDir (Join-Path $InstallPath 'dist')
  Write-Info $distCopy.Message
}
Write-Step "starting service"
# R161.25 — 把 stderr 捕获纠正回来 (历史安装里它被 reset 成"无重定向")。
# Node 的 import 期错误 (ERR_MODULE_NOT_FOUND 等) 只落在 stderr 上, 且不经过
# uncaughtException handler ⇒ 这是"更新后服务起不来"的唯一证据。
Enable-NssmStderr -Name 'ADDashboardCenter'
# 旧实现 `Start-ServiceSafe ... | Out-Null` 把返回值丢了 —— 服务起不来时
# 脚本照样打印 "update complete", 操作员以为更新成功, 实际服务根本没跑。
if (-not (Start-ServiceSafe -Name 'ADDashboardCenter' -WaitSeconds 20)) {
  Write-Err2 "service failed to start; see $Script:LogDir\ADDashboardCenter-stderr.log (node 启动期错误) and the center log directory $Script:LogDir (center.<date>.<n>.log / APP\<module>.log)"
  exit 1
}
# HTTP 就绪探针 —— SCM 说 Running 只代表 NSSM 拉起了 node, Express 还要
# 加载模块 + 绑定端口 (冷启动 2-15s)。不探针 = 更新完就说"完成"。
$probeUrl = "http://localhost:$ListenPort/api/init/status"
if (-not (Wait-ForHttpOk -Url $probeUrl -TimeoutSeconds 30 -IntervalSeconds 1)) {
  throw "service is up (per SCM) but HTTP probe at $probeUrl did not return 2xx within 30s. Check $Script:LogDir\ADDashboardCenter-stderr.log (node 启动期错误) and the center log directory $Script:LogDir (center.<date>.<n>.log / APP\<module>.log)."
}
Write-Ok "update complete"