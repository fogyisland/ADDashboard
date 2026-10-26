# AD Dashboard Center upgrade — architecture extension flow.
# Use AFTER first-time install (install-center.ps1 handles init via /api/init
# wizard on first boot). This script handles subsequent deployments:
#   1. stop NSSM service
#   2. replace code (mirror → install path, hash-checked npm install)
#   3. replace dist (shipped bundle, or local build via -RebuildFrontend)
#   4. start NSSM service + HTTP probe
#   5. apply pending DB migrations via HTTP API (the "扩展架构" piece)
#   6. (Built-in packages + SMTP defaults + agent_token bundle re-seed
#      automatically on normal-mode restart — no extra HTTP call needed.)
#
# -RebuildFrontend: force a fresh local `npm run build:web --workspace=center`
# instead of copying the shipped dist. Use when the local web UI source has
# changes that are not yet in the shipped bundle (stale-UI fix). Equivalent
# to publish/system/update.{ps1,bat}.
#
# IMPORTANT: NOT for first-time install. Use install-center.ps1 instead.
# This script ASSUMES the DB already exists and /init has been completed.
# It will refuse to proceed against an uninitialized install (needsInit=true).
[CmdletBinding()]
param(
  [string]$InstallPath,
  [int]$ListenPort = 8080,
  [string]$WebAdminUser = 'admin',
  [Parameter(Mandatory)][string]$WebAdminPassword,
  [switch]$RebuildFrontend
)

# $PSScriptRoot is empty in [CmdletBinding()] default param values (parameter
# binding scope is a child of script scope; auto-vars only set in script scope).
# Resolve default InstallPath in the body where $PSScriptRoot is available.
if (-not $InstallPath) {
  $InstallPath = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')) 'Center')
}

$ErrorActionPreference = 'Stop'
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Import-Module (Join-Path $PSScriptRoot 'common\Logger.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\NSSM.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'common\Service.psm1') -Force

# 0. Ensure NSSM is available locally (downloads to <projectRoot>/nssm/ on first run).
# When script lives at publish/system/scripts/upgrade-center.ps1, $projectRoot
# = publish/system/, so Ensure-Nssm picks the published nssm copy there.
. (Join-Path $PSScriptRoot 'common\Ensure-Nssm.ps1') -ProjectRoot $projectRoot

# Set log directory inside the NSSM/Logger modules' own $Script: scope.
$Script:LogDir = Join-Path $InstallPath 'Logs'
if (-not (Test-Path $Script:LogDir)) { New-Item -ItemType Directory -Path $Script:LogDir -Force | Out-Null }
# R119 — per-module/per-route server-side log directory. install-center.ps1
# already creates this on first install, but upgrade-center.ps1 may run on
# a pre-R119 install where APP/ doesn't exist yet. Mkdir here so the first
# Write-Log after Set-LogModule never EACCES on a missing parent.
$Script:AppLogDir = Join-Path $Script:LogDir 'APP'
if (-not (Test-Path $Script:AppLogDir)) { New-Item -ItemType Directory -Path $Script:AppLogDir -Force | Out-Null }
Set-NssmLogDir $Script:LogDir
Set-LogDir $Script:LogDir
# R119 — pick this script's per-module log file under <LogDir>/APP/upgrade-center.log
# (dual-writes into the legacy <LogDir>/install.log via Logger.psm1::Write-Log).
Set-LogModule 'upgrade-center'
# R119.B boot fingerprint — single line naming the running version + git
# commit so operators can prove which code is installed.
$mfst = Get-AgentManifest
$commit = if ($mfst -and $mfst.gitCommit) { $mfst.gitCommit } else { 'unknown' }
Write-Info ("{0} v{1} (commit={2})" -f $MyInvocation.MyCommand.Name, (Get-AgentVersion), $commit)

Write-Step "upgrade-center: $InstallPath (architecture extension — not first-time init)"

# Refuse to run if the install has not been initialized yet. The /api/init
# wizard handles DB connection + schema + seed + admin user + appsettings.json;
# if needsInit is still true at runtime, calling this script means the operator
# skipped install-center.ps1, and applying migrations against a non-existent
# DB would silently no-op (or fail loudly on first apply — confusing either way).
# Surface a clear error so they run the right script.
$initStatusUrl = "http://localhost:$ListenPort/api/init/status"
try {
  $initResp = Invoke-WebRequest -Uri $initStatusUrl -UseBasicParsing -TimeoutSec 5
  $initBody = $initResp.Content | ConvertFrom-Json
  if ($initBody.needsInit -eq $true) {
    throw "install at $InstallPath has not been initialized (/init wizard still pending). Run install-center.ps1 first."
  }
} catch {
  # 旧实现写的是 `catch [System.Net.WebException]`, 那个"服务连不上,请先启动"
  # 的友好提示**只在 Windows PowerShell 5.1 下可达**:
  #   PS 5.1 : Invoke-WebRequest 连不上 → System.Net.WebException   ✔ 被捕获
  #   PS 7   : Invoke-WebRequest 连不上 → System.Net.Http.HttpRequestException
  #            (内层 System.Net.Sockets.SocketException)             ✘ 捕获不到
  # ⇒ 在 PS 7 上 (operator 用 pwsh 跑升级脚本是常态) 这条分支永远走不到,
  # 操作员看到的是裸的 HttpRequestException 栈, 完全不知道下一步该干什么。
  #
  # 这里改成**按异常类型名**判定, 不依赖任何 catch 类型字面量 —— 后者会触发
  # 程序集加载, 在没预载 System.Net.Http 的 PS 5.1 上可能变成 "无法找到类型"。
  $ex = $_.Exception
  $isUnreachable = $false
  if ($ex -is [System.Net.WebException]) { $isUnreachable = $true }
  if ($ex.GetType().FullName -eq 'System.Net.Http.HttpRequestException') { $isUnreachable = $true }
  if ($ex.InnerException -and $ex.InnerException.GetType().FullName -eq 'System.Net.Sockets.SocketException') { $isUnreachable = $true }
  if ($isUnreachable) {
    throw "service not reachable at $initStatusUrl — is it running? Start it first or run install-center.ps1 (which registers and starts the NSSM service). (underlying: $($ex.GetType().FullName): $($ex.Message))"
  }
  # 非连接类异常 (例如上面那句 needsInit 的 throw) 原样冒泡, 不改写语义。
  throw
}

# Idempotent node_modules install: hash-checked against package.json+package-lock.json.
# After we copy new code into $InstallPath, the InstallPath's own package.json is
# the new source — so SrcDir = InstallPath.
function Ensure-NodeModules {
  param([Parameter(Mandatory)] [string]$InstallPath)
  $hashFile = Join-Path $InstallPath '.install-hash'
  $pkgJson = Join-Path $InstallPath 'package.json'
  $pkgLock = Join-Path $InstallPath 'package-lock.json'
  $newHash = ''
  if (Test-Path $pkgJson) { $newHash += (Get-FileHash -Algorithm SHA256 -Path $pkgJson).Hash }
  if (Test-Path $pkgLock) { $newHash += (Get-FileHash -Algorithm SHA256 -Path $pkgLock).Hash }
  $oldHash = if (Test-Path $hashFile) { Get-Content -Path $hashFile -Raw -ErrorAction SilentlyContinue } else { '' }
  # 判据 = 依赖能否被 require 解析 (npm workspaces 会把依赖提升到工作区根,
  # <InstallPath>\node_modules 未必存在 —— 见 Service.psm1::Test-NodeDepsResolvable)。
  $needsInstall = -not (Test-NodeDepsResolvable -InstallPath $InstallPath)
  if (-not $needsInstall -and $newHash -ne '' -and $newHash -ne $oldHash) {
    $needsInstall = $true
    $reason = 'deps changed (package.json or package-lock.json hash differs)'
  } elseif (-not $needsInstall) {
    $reason = 'up-to-date'
  } else {
    $reason = 'dependencies not resolvable from the install path'
  }
  if ($needsInstall) {
    Write-Step "installing node_modules ($reason)"
    # 不先删 node_modules: 旧实现"先删再装", npm 一失败 (离线服务器) 树里
    # 就什么都不剩了。npm 自己会把依赖树对齐。
    Push-Location $InstallPath
    try {
      & npm.cmd install --omit=dev --no-audit --no-fund
      if ($LASTEXITCODE -ne 0) { throw "npm install --omit=dev failed in $InstallPath (exit $LASTEXITCODE)" }
    } finally { Pop-Location }
    # 装完复验 —— npm 失败时绝不能把哈希记成成功 (否则下一轮认为依赖已就绪,
    # 服务带着残缺依赖启动 ⇒ 崩溃重启循环, R121/R123/R124 家族)。
    if (-not (Test-NodeDepsResolvable -InstallPath $InstallPath)) {
      throw "dependencies still not resolvable after npm install in $InstallPath — 离线服务器请预置 node_modules 或 npm 缓存后重试"
    }
    if ($newHash -ne '') { Set-Content -Path $hashFile -Value $newHash -NoNewline }
  } else {
    Write-Info "node_modules up-to-date"
  }
}

# 1. Stop the running NSSM service so file replacement doesn't race with
# running node processes. Stop-ServiceSafe waits until SCM reports stopped.
Write-Step "stopping service"
if (-not (Stop-ServiceSafe -Name 'ADDashboardCenter' -WaitSeconds 30)) { throw 'cannot stop service' }

# 2. Copy new code from bundle into install path. Excludes node_modules
# (re-installed hash-checked), tests (not for prod), and appsettings.json
# (operator-owned config — overwriting it would clobber DB credentials + jwt
# secret + agent_token).
$srcDir = Join-Path $projectRoot 'center'
Write-Step "copying code: $srcDir → $InstallPath"
# Copy-DirectoryContent skips the copy when source and target are the same
# directory. The default install path is '<root>\Center' while the source
# tree is '<root>\center' — on Windows (case-insensitive) those are the SAME
# directory, so the old unconditional Copy-Item copied the tree onto itself.
$codeCopy = Copy-DirectoryContent -SourceDir $srcDir -TargetDir $InstallPath `
  -Exclude @('node_modules', 'tests', 'appsettings.json', '.install-hash', 'Logs')
Write-Info $codeCopy.Message
if ($codeCopy.Status -eq 'same-path') {
  Write-Warn2 "install path is the source tree ($InstallPath) — running in place, no code copy performed"
}

# 3. Hash-checked npm install (idempotent — no-op if deps unchanged).
Ensure-NodeModules -InstallPath $InstallPath

# 4. Refresh dist. Priority order:
#    (a) -RebuildFrontend: force a local `npm run build:web --workspace=center`
#        (stale-UI fix when shipped bundle drifted from local source).
#        Equivalent to publish/system/update.{ps1,bat}.
#    (b) Shipped bundle present: copy it (default, fast).
#    (c) Shipped bundle absent AND install dist absent: build locally (legacy
#        bundles that pre-date the shipped-dist convention).
#    (d) Shipped bundle absent AND install dist present: leave alone (clobbering
#        a working dist just because we don't ship one is the wrong default).
#
#    All four paths go through Sync-DirectoryContent, which refuses to delete
#    the target when it IS the source (2026-10-25: the old code did
#    Remove-Item $distPath followed by Copy-Item $shippedDist\* → $distPath
#    where both paths were '<root>\center\dist' — the installer deleted the
#    web UI it was supposed to publish).
$distPath = Join-Path $InstallPath 'dist'
$shippedDist = Join-Path $projectRoot 'center\dist'
$localDist = Join-Path $projectRoot 'center\dist'
if ($RebuildFrontend) {
  Write-Step "rebuilding web UI (npm run build:web --workspace=center)"
  Push-Location $projectRoot
  try {
    # vite is a devDependency of the center workspace; the dependency
    # installer uses `npm install --omit=dev`, so the build tooling is absent
    # on a freshly installed server. Install just the center workspace's dev
    # deps instead of the whole root (the agent workspace pulls a native
    # better-sqlite3 build that has nothing to do with the web UI).
    if (-not (Test-Path (Join-Path $projectRoot 'node_modules\vite'))) {
      Write-Step "installing center dev dependencies (vite missing)"
      npm install --workspace=center --include=dev
      if ($LASTEXITCODE -ne 0) { throw "npm install --workspace=center --include=dev failed: $LASTEXITCODE" }
    }
    npm run build:web --workspace=center
    if ($LASTEXITCODE -ne 0) { throw "npm run build:web --workspace=center failed: $LASTEXITCODE" }
  } finally { Pop-Location }
  if (-not (Test-Path (Join-Path $localDist 'index.html'))) {
    throw "npm run build:web --workspace=center did not produce center\dist\index.html"
  }
  $distSync = Sync-DirectoryContent -SourceDir $localDist -TargetDir $distPath
  Write-Info $distSync.Message
} elseif (Test-Path (Join-Path $shippedDist 'index.html')) {
  Write-Step "refreshing dist from shipped bundle"
  $distSync = Sync-DirectoryContent -SourceDir $shippedDist -TargetDir $distPath
  Write-Info $distSync.Message
} elseif (-not (Test-Path (Join-Path $distPath 'index.html'))) {
  Write-Step "building web UI (shipped dist absent)"
  Push-Location $projectRoot
  try {
    if (-not (Test-Path (Join-Path $projectRoot 'node_modules\vite'))) {
      Write-Step "installing center dev dependencies (vite missing)"
      npm install --workspace=center --include=dev
      if ($LASTEXITCODE -ne 0) { throw "npm install --workspace=center --include=dev failed: $LASTEXITCODE" }
    }
    npm run build:web --workspace=center
    if ($LASTEXITCODE -ne 0) { throw "npm run build:web --workspace=center failed: $LASTEXITCODE" }
  } finally { Pop-Location }
  $distSync = Sync-DirectoryContent -SourceDir (Join-Path $projectRoot 'center\dist') -TargetDir $distPath
  Write-Info $distSync.Message
} else {
  Write-Info "install dist already present; leaving alone (shipped dist absent)"
}

# 5. Refresh NSSM AppStderr config. install-center.ps1 disables AppStderr so pino-roll
# (which rotates <InstallPath>/logs/center.<date>.<n>.log) is the sole writer of the
# rotated log file. Existing installs installed before round-12 still have AppStderr
# pointing at ADDashboardCenter-stderr.log, which races pino-roll for the rotated
# file handle on each daily rename (NSSM append → rename vs pino-roll append →
# rename in the same second). Re-apply the disable on every upgrade so all installs
# converge on the round-12 setting, regardless of when they were first installed.
# Idempotent — `nssm reset` on an already-unset parameter is a no-op at the NSSM level.
#
# Implementation note (2026-10-25): this used to be
#   Invoke-Nssm @('set', 'ADDashboardCenter', 'AppStderr', '')
# which CANNOT work — NSSM 2.24 rejects an empty parameter value (usage banner +
# exit 1), so every upgrade died here before it could start the service. Use
# Disable-NssmStderr (scripts/common/NSSM.psm1) → `nssm reset <svc> AppStderr`.
Disable-NssmStderr -Name 'ADDashboardCenter'

# 6. Start NSSM service. Start-ServiceSafe has pre-flight NSSM diagnostics +
# Win32 error surfacing (see scripts/common/Service.psm1 for details).
if (Start-ServiceSafe -Name 'ADDashboardCenter' -WaitSeconds 20) {
  Write-Ok "service started"
} else {
  # 不要指向 ADDashboardCenter-stderr.log —— AppStderr 已被 Disable-NssmStderr
  # 关掉 (见上面第 5 步), 那个文件永远不会被写, 指向它是把操作员引到空路。
  # 真正的日志在 <LogDir>: pino-roll 的 center.<date>.<n>.log + APP\<module>.log。
  Write-Err2 "service failed to start; see the center log directory $Script:LogDir (center.<date>.<n>.log / APP\<module>.log)"
  exit 1
}

# 7. HTTP readiness probe — wait for /api/init/status to come back 2xx.
# Cold cache (modules loading, DB pool init, route mount) takes 2-15s before
# Express binds the listening socket. Single-shot Invoke-WebRequest races the
# boot; Wait-ForHttpOk polls until 2xx or 30s timeout.
$probeUrl = "http://localhost:$ListenPort/api/init/status"
if (-not (Wait-ForHttpOk -Url $probeUrl -TimeoutSeconds 30 -IntervalSeconds 1)) {
  throw "service is up (per SCM) but HTTP probe at $probeUrl did not return 2xx within 30s. Check the center log directory $Script:LogDir (center.<date>.<n>.log / APP\<module>.log)."
}
Write-Ok "HTTP probe green"

# 7. Authenticate as admin. Migration apply requires admin:users permission.
Write-Step "authenticating as $WebAdminUser"
$token = $null
try {
  $loginBody = @{ username = $WebAdminUser; password = $WebAdminPassword } | ConvertTo-Json -Compress
  $loginResp = Invoke-WebRequest -Uri "http://localhost:$ListenPort/api/auth/login" -Method POST -Body $loginBody -ContentType 'application/json' -UseBasicParsing -TimeoutSec 5
  $loginJson = $loginResp.Content | ConvertFrom-Json
  $token = $loginJson.token
} catch {
  throw "admin login failed for $WebAdminUser at http://localhost:$ListenPort/api/auth/login: $($_.Exception.Message)"
}
if (-not $token) { throw "admin login succeeded but token is empty" }
Write-Ok "authenticated"

# 8. List pending migrations. The "扩展架构" step — apply all migrations that
# are present in the deployed code but not yet applied to the DB. Sequential
# (NOT parallel): migrations may have inter-dependencies (e.g. adding a column
# before adding an index on it). apply-up-to would be safer but the API only
# exposes per-version apply.
$authHeaders = @{ Authorization = "Bearer $token" }
$listResp = Invoke-WebRequest -Uri "http://localhost:$ListenPort/api/admin/migrations" -Headers $authHeaders -UseBasicParsing -TimeoutSec 10
$migrations = $listResp.Content | ConvertFrom-Json

# Migrations come back with a status field. Apply only "pending" or "failed".
# "applied" ones are skipped (idempotent re-run).
$pending = @($migrations | Where-Object { $_.status -eq 'pending' -or $_.status -eq 'failed' })
if ($pending.Count -eq 0) {
  Write-Ok "no pending migrations — DB is up-to-date"
} else {
  Write-Step "applying $($pending.Count) pending migration(s)"
  $appliedCount = 0
  foreach ($m in $pending) {
    Write-Info "  applying $($m.version) ($($m.status))..."
    $applyBody = @{ appliedBy = 'upgrade-center.ps1' } | ConvertTo-Json -Compress
    try {
      $applyResp = Invoke-WebRequest -Uri "http://localhost:$ListenPort/api/admin/migrations/$($m.version)/apply" -Method POST -Body $applyBody -ContentType 'application/json' -Headers $authHeaders -UseBasicParsing -TimeoutSec 60
      $applyJson = $applyResp.Content | ConvertFrom-Json
      if ($applyJson.status -ne 'applied') {
        throw "migration $($m.version) apply returned status=$($applyJson.status): $($applyJson | ConvertTo-Json -Compress)"
      }
      $appliedCount++
      Write-Ok "  $($m.version) applied ($($applyJson.executionMs)ms)"
    } catch {
      throw "migration $($m.version) apply failed: $($_.Exception.Message). Earlier migrations have been applied — re-run this script after fixing the root cause to resume."
    }
  }
  Write-Ok "applied $appliedCount migration(s)"
}

# 9. Verify 0 pending. If something still pending, the apply loop must have
# hit a permanent failure — surface clearly so the operator doesn't think
# the upgrade is complete.
$verifyResp = Invoke-WebRequest -Uri "http://localhost:$ListenPort/api/admin/migrations" -Headers $authHeaders -UseBasicParsing -TimeoutSec 10
$verifyMigrations = $verifyResp.Content | ConvertFrom-Json
$stillPending = @($verifyMigrations | Where-Object { $_.status -eq 'pending' })
if ($stillPending.Count -gt 0) {
  # 旧写法 `... | Sort-Object -Join ', '` 是语法错误 (Sort-Object 没有 -Join 参数),
  # PowerShell 会在 throw 的字符串展开阶段直接抛 ParserError, 把真正的失败原因
  # (哪几条迁移没上) 盖掉。正确写法: 先排序, 再 join。
  $stillPendingVersions = (@($stillPending | ForEach-Object { $_.version }) | Sort-Object) -join ', '
  throw "$($stillPending.Count) migration(s) still pending after upgrade: $stillPendingVersions"
}
Write-Ok "DB migrations verified — 0 pending"

Write-Ok "upgrade complete: code + dist + deps + migrations + auto-seeded built-in packages"