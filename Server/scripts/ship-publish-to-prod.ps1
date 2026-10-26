# ship-publish-to-prod.ps1 — Operator-run script to mirror the local
# `publish/system/` green-package bundle to the prod center install path
# (default `D:\dashboard\`) and restart the NSSM service.
#
# R118.4 context:
#   The prod 8080 webApp on KDLWXOFADSRV1 / 10.170.140.23 serves from
#   `D:\dashboard\center\`, NOT from `D:\ToolDevelop\ADDashboard\center\`.
#   The local `publish/system/` mirror is byte-equal with source (verified
#   by verify-mirror.ps1, 261 pass), but the prod binary at `D:\dashboard\`
#   still carries the R66-pre V0 mount chain (userAuth globally mounted on
#   every router, including the agentPackagesRouter). Fresh agent log
#   2026-09-27T01:26:42 (POST-restart) proves port 8080 webApp serves
#   `/api/agent/packages*` with 401 "missing token" while 8081/8082 work.
#
#   This script exists because the dev box has no SMB / network path to
#   `\\10.170.140.23\C$\dashboard` (smoke-tested, returns False). The
#   bundle must travel by:
#     a) operator copies the script + scripts/start.ps1 to prod (manual)
#     b) operator runs this script on prod
#     c) operator restarts the NSSM service (Restart-Service dashboard-8080
#        OR via NSSM — name confirmed via Get-Service)
#
# Standing directives preserved:
#   - "后续就在8080端口，重启服务告诉我 我手动来重启" — Claude NEVER auto-restarts.
#     This script does NOT auto-restart. It stops, mirrors, then prints the
#     exact operator command to run.
#   - "MYSQL和MSSQL" dual dialect support — N/A (script only copies files).
#   - "不需要压缩成zip" — script does NOT zip. It mirrors trees in place.
#   - Co-Authored-By attribution — N/A (this is a script, not a commit).
#
# Why mirrors only `publish/system/center\`:
#   The prod install path is `D:\dashboard\center\`. The published bundle
#   root `publish/system/` also contains `scripts/`, `docs/`, `db/`,
#   `node/`, `nssm/`, `package.json`, `start.bat`, `start.ps1`. Scripts &
#   docs go to `D:\dashboard\scripts\` and `D:\dashboard\docs\` (per
#   install-center.ps1 green-bundle layout — see the original installer's
#   Copy-Item line 121 that copies `Join-Path $srcDir '*'` into the
#   install root, but the prod tree predates that and keeps center/src
#   under center/, scripts at root).
#
#   To keep this script robust against either layout (single-root vs
#   split-center-root), it enumerates every first-level entry under
#   publish/system/ and mirrors it to its peer at the install root. That
#   matches what install-center.ps1 line 121 does.
#
# Pre-flight (line 28-44):
#   refuse to run if the prod center binary is missing or if the source
#   mirror is missing. Bailing here beats silently copying into a wrong
#   tree.
#
# Per-tree excludes (line 58-69):
#   - node_modules: rebuilt on-target by Ensure-CenterNodeModules during
#     install-center.ps1. NEVER mirror — Windows path-name cases differ
#     and ABI-specific binaries (better-sqlite3 native bindings) will
#     fail to load on the prod server.
#   - tests: Pester + node:test + vitest. Never ship to runtime.
#   - appsettings.json: per-host runtime config. NEVER overwrite.
#   - package-lock.json: regenerated on-target by `npm install --omit=dev`.
#     Mirror would either no-op (no source) or commit a stale lockfile.
#     See install-center.ps1:140-145's comment for the same reasoning.
#   - dist: shipped via `dist/` mirror, separately handled below.
#
# Restoring node_modules after copy (line 80-87):
#   robocopy /MIR with /XD node_modules is the right way to leave the
#   target's node_modules intact, but a pre-existing node_modules
#   directory at the target might be left stale (deps changed but node/
#   bindings not rebuilt). The script logs the .install-hash so the
#   operator can see whether Ensure-NodeModules will reinstall on next
#   NSSM start.
#
# Restart policy (line 95-103):
#   Print the exact command. Do NOT execute. Per standing directive.

[CmdletBinding()]
param(
  [string] $BundleRoot = 'publish\system',
  [string] $InstallRoot = 'D:\dashboard',
  # 服务名候选列表 (2026-10-25): 规范名是 ADDashboardCenter (install-center.ps1
  # / upgrade-center.ps1 / update-center.ps1 / uninstall-center.ps1 全都用它),
  # 'dashboard-8080' 是生产机上的历史遗留名。旧实现把后者写成默认值, 于是
  # 一旦操作员用 install-center.ps1 重新注册 (名字变成 ADDashboardCenter),
  # 本脚本仍会打印 `Restart-Service -Name 'dashboard-8080'` —— 一条必然
  # 报错的命令, 而且只给个 WARNING 就退出 0。
  [string[]] $ServiceName = @('ADDashboardCenter', 'dashboard-8080')
)

$ErrorActionPreference = 'Stop'

# Resolve script-side paths. BundleRoot is relative to the directory the
# operator invoked the script from (likely the unzipped bundle root, which
# contains `publish/` as a sibling). Fall back to the script's own parent
# when invoked from inside scripts/.
function Resolve-BundleRoot {
  param([string] $Raw)
  if (Test-Path -LiteralPath $Raw) { return (Resolve-Path -LiteralPath $Raw).Path }
  $candidates = @(
    (Join-Path (Get-Location).Path $Raw),
    (Join-Path $PSScriptRoot '..\publish\system'),
    (Join-Path $PSScriptRoot '..\..\publish\system')
  )
  foreach ($c in $candidates) {
    if (Test-Path -LiteralPath (Join-Path $c 'center\server.js')) {
      return (Resolve-Path -LiteralPath $c).Path
    }
  }
  throw "BundleRoot not found. Tried '$Raw' + 3 fallback paths. Pass -BundleRoot '<abs path>\publish\system'."
}

$srcRoot = Resolve-BundleRoot -Raw $BundleRoot
$dstRoot = $InstallRoot

Write-Host "[ship-publish-to-prod] src = $srcRoot" -ForegroundColor Cyan
Write-Host "[ship-publish-to-prod] dst = $dstRoot" -ForegroundColor Cyan

if (-not (Test-Path -LiteralPath $InstallRoot)) {
  throw "InstallRoot '$InstallRoot' does not exist. Verify the prod center install path. Default is 'D:\dashboard' — pass -InstallRoot to override."
}
if (-not (Test-Path -LiteralPath (Join-Path $srcRoot 'center\server.js'))) {
  throw "source mirror incomplete: $srcRoot\center\server.js missing. Run scripts/sync-source-mirror.ps1 on the dev box first."
}
# 生产 UI 保护: /MIR 会把"源端没有、目标端有"的一切删掉。center\dist 是通过
# **独立的 dist 镜像**发布的 (publish-sync.mjs 只同步源码), 所以源镜像里可能
# 根本没有 center\dist —— 此时一次"发代码"就会把生产机上的 UI 删光, 首页变
# ENOENT (Service.psm1:6-13 记录的 2026-10-25 同类事故)。源端没有、目标端有
# ⇒ 立刻中止, 让人先把 dist 同步进源镜像再发。
$srcDistIndex = Join-Path $srcRoot 'center\dist\index.html'
$dstDistIndex = Join-Path $dstRoot 'center\dist\index.html'
if ((-not (Test-Path -LiteralPath $srcDistIndex)) -and (Test-Path -LiteralPath $dstDistIndex)) {
  throw "source mirror has no center\dist\index.html but the target has one ($dstDistIndex). Mirroring with /MIR would PURGE the production UI. Sync center\dist into the source mirror (publish/system/center/dist) first, then re-run."
}

# Every top-level entry under publish/system/ is mirrored to the peer
# path at the install root. install-center.ps1:121's `Copy-Item
# (Join-Path $srcDir '*') -Destination $InstallPath` does the same thing
# for the green-bundle layout. Re-doing it via robocopy /MIR is byte-
# identical except for the excludes below.
$topLevel = Get-ChildItem -LiteralPath $srcRoot | Select-Object -ExpandProperty Name

$robocopyBase = @(
  '/MIR', '/NJH', '/NJS', '/NDL', '/NFL', '/NP', '/R:1', '/W:1'
)

# Excludes that apply to ALL trees. /XF is a flat filename list, NOT
# nested under /XD. node_modules is /XD (it's a directory tree).
#
# RUNTIME 目录必须排除 (2026-10-25 修复, P0):
#   /MIR = /E + /PURGE ⇒ **目标端存在、源端不存在的一切都会被删除**。
#   而发布镜像按 center/scripts/publish-sync.mjs 的 EXCLUDE_DIR 构造,
#   那个表把 APP / FEATURE / data / Logs / logs / .backup / .scratch /
#   .git / tmp 全部排除在外 —— 也就是说, 镜像里**没有**这些目录。
#   于是镜像 = /MIR 打到生产端 ⇒ 生产端的
#     center\APP\     (48 个 per-module 轮转日志)
#     center\FEATURE\ (83 个)
#     center\data\    (297 个: file-push / license-requests / packages /
#                           instance_id / index.json)
#     center\Logs\    (pino 轮转日志)
#     center\.backup\
#   全被静默 purge 掉 —— 而旧实现用 `*> $null` 把 robocopy 的输出
#   (含"正在删除 X")一并吞了, 操作员**看不到任何删除痕迹**。
#   /XD 的参数是目录名, 在整棵树的任意层级都生效, 所以这里列目录名。
$alwaysXD = @(
  'node_modules', 'tests', '.cache',
  # 运行期目录 —— 绝不 purge
  'APP', 'FEATURE', 'data', 'Logs', 'logs', '.backup', '.backups',
  '.scratch', '.git', 'tmp', '.tmp'
)
# .env 是 center 的 init marker (center/src/init/marker.js: envFilePath() →
# <installPath>\.env, 而 installPath = 服务的工作目录 = 生产端的 center\)。
# 镜像的**源端永远没有** .env (publish-sync.mjs 的 EXCLUDE_FILE 就只含 .env),
# 于是 /MIR(= /E + /PURGE) 会把生产机的 center\.env 当成"源端已删除"而
# 静默删掉 ⇒ 重启后 center 认为未初始化 ⇒ 退回 init 向导模式 (而不是
# 服务生产 dashboard)。必须列入 /XF (目标端保留, 不用镜像覆盖)。
$alwaysXF = @('appsettings.json', 'package-lock.json', 'queue.db', 'queue.db-shm', 'queue.db-wal', '.install-hash', '.env')

# robocopy 的输出**不许丢**。/MIR 是破坏性操作, 删除清单必须留痕。
$rcLogDir = Join-Path ([System.IO.Path]::GetTempPath()) 'ADDashboard-logs'
if (-not (Test-Path -LiteralPath $rcLogDir)) { New-Item -ItemType Directory -Path $rcLogDir -Force | Out-Null }
$rcLog = Join-Path $rcLogDir ("ship-publish-robocopy-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))

foreach ($name in $topLevel) {
  $src = Join-Path $srcRoot $name
  $dst = Join-Path $dstRoot $name
  $srcItem = Get-Item -LiteralPath $src
  # 顶层条目分两种, 必须区别对待:
  #   目录 (center/ db/ docs/ node/ nssm/ scripts/) → robocopy /MIR
  #   文件 (package.json / start.bat / start.ps1 / build-manifest.json 等) → Copy-Item
  # 旧实现把两者一视同仁, 造成两个独立的故障:
  #   ① robocopy 的源参数**必须是目录**, 给文件会 exit 16 (复制失败) → 命中
  #      下面的 `>= 8` → 整个镜像抛错中止 ⇒ 生产树停在"一半新一半旧",
  #      而 start.bat / start.ps1 永远发不过去;
  #   ② 紧接着那行 New-Item -ItemType Directory 会在生产根目录凭空造出
  #      一个叫 package.json 的**目录** (不是文件) ⇒ npm 在那儿直接
  #      ENOTDIR 失败。
  if (-not $srcItem.PSIsContainer) {
    $dstItem = $null
    if (Test-Path -LiteralPath $dst) { $dstItem = Get-Item -LiteralPath $dst }
    if ($dstItem -and $dstItem.PSIsContainer) {
      # 目标端是目录 —— 只可能是旧实现造出来的假目录 (源端同名的那个是文件)。
      # 留着它 npm 会 ENOTDIR, 所以清掉再写文件。
      Write-Host "[ship-publish-to-prod] removing bogus directory '$dst' (artifact of the old top-level-file handling)" -ForegroundColor Yellow
      Remove-Item -LiteralPath $dst -Recurse -Force
    }
    Copy-Item -LiteralPath $src -Destination $dst -Force
    Write-Host "[ship-publish-to-prod] copied file $name" -ForegroundColor DarkGray
    continue
  }
  if (-not (Test-Path -LiteralPath $dst)) {
    New-Item -ItemType Directory -Path $dst -Force | Out-Null
  }

  $xf = @('/XF') + $alwaysXF
  $xd = @('/XD') + $alwaysXD

  # dist is shipped as-is — it IS the published build output.
  # Other trees: standard mirror with excludes.
  Write-Host "[ship-publish-to-prod] mirroring $name\" -ForegroundColor Cyan
  # /LOG: 把 robocopy 的完整输出(含 purge 清单)写进日志文件, 不用 *> $null。
  & robocopy $src $dst @robocopyBase @xd @xf "/LOG:$rcLog" | Out-Null
  $rc = $LASTEXITCODE
  $LASTEXITCODE = 0
  # robocopy 退出码: 0-7 = 成功(带额外信息), >=8 = 失败。
  if ($rc -ge 8) {
    throw "robocopy failed for $name\ (exit $rc) — see $rcLog"
  }
  if ($rc -gt 0) {
    # 有文件被复制/删除 —— 让操作员知道这次镜像动了东西。
    Write-Host "[ship-publish-to-prod]   robocopy exit $rc (files copied/removed) — details: $rcLog" -ForegroundColor DarkGray
  }
}
Write-Host "[ship-publish-to-prod] robocopy log: $rcLog" -ForegroundColor DarkGray

# Sanity: assert the new server.js byte-equal matches source.
$srcServer = Join-Path $srcRoot 'center\server.js'
$dstServer = Join-Path $dstRoot 'center\server.js'
if (-not (Test-Path -LiteralPath $dstServer)) {
  throw "post-mirror check: $dstServer missing — mirror incomplete"
}
$srcHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $srcServer).Hash
$dstHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $dstServer).Hash
if ($srcHash -ne $dstHash) {
  throw "post-mirror check: server.js hash mismatch ($srcHash vs $dstHash) — investigate before restart"
}
Write-Host "[ship-publish-to-prod] mirror complete; server.js byte-equal verified" -ForegroundColor Green

# Check whether NSSM service exists. Print the exact restart command
# the operator must run. DO NOT restart automatically (standing directive:
# "后续就在8080端口，重启服务告诉我 我手动来重启").
$resolvedServiceName = $null
$svc = $null
foreach ($candidate in $ServiceName) {
  if (-not $candidate) { continue }
  $found = Get-Service -Name $candidate -ErrorAction SilentlyContinue
  if ($found) { $resolvedServiceName = $candidate; $svc = $found; break }
}
if (-not $svc) {
  Write-Host "[ship-publish-to-prod] ERROR: none of these services is registered on this machine: $($ServiceName -join ', ')" -ForegroundColor Red
  Write-Host "  If the prod 8080 service has a different name, pass -ServiceName '<real-name>'." -ForegroundColor Yellow
  Write-Host "  Otherwise, register first:  & '$srcRoot\scripts\install-center.ps1' -InstallPath '$dstRoot' -ListenPort 8080" -ForegroundColor Yellow
} else {
  Write-Host "[ship-publish-to-prod] detected service '$resolvedServiceName' (status: $($svc.Status))." -ForegroundColor Green
  Write-Host ""
  Write-Host "=== Operator action (DO NOT auto-run by Claude) ===" -ForegroundColor Magenta
  Write-Host "  Restart-Service -Name '$resolvedServiceName' -Force" -ForegroundColor Magenta
  Write-Host "  # then verify with:" -ForegroundColor Magenta
  Write-Host "  Invoke-WebRequest http://127.0.0.1:8080/api/init/status -UseBasicParsing | Select-Object -ExpandProperty Content" -ForegroundColor Magenta
  Write-Host ""
  Write-Host "  After restart, fresh agent log should show:" -ForegroundColor Magenta
  Write-Host "    GET http://<agent>:8080/api/agent/packages → 401 {""error"":""invalid agent token""}" -ForegroundColor Magenta
  Write-Host "  instead of the current 401 {""error"":""missing token""} (binary stale)." -ForegroundColor Magenta
}

# Sanity: log the .install-hash so the operator can predict whether the
# next NSSM start will trigger Ensure-CenterNodeModules reinstall.
$hashFile = Join-Path $dstRoot 'center\.install-hash'
$srcPkg = Join-Path $srcRoot 'center\package.json'
$srcLock = Join-Path $srcRoot 'center\package-lock.json'
$newHash = ''
if (Test-Path $srcPkg) { $newHash += (Get-FileHash -Algorithm SHA256 -LiteralPath $srcPkg).Hash }
if (Test-Path $srcLock) { $newHash += (Get-FileHash -Algorithm SHA256 -LiteralPath $srcLock).Hash }
$oldHash = if (Test-Path $hashFile) { Get-Content -Path $hashFile -Raw -ErrorAction SilentlyContinue } else { '' }
if ($newHash -ne $oldHash) {
  # NSSM 启动服务时**不会**跑 npm install —— Ensure-CenterNodeModules 只在
  # install-center.ps1 / upgrade-center.ps1 里被调用, center/server.js 与
  # src/ 里没有任何 install-hash 的引用。旧实现在这里打印 "next NSSM start
  # will run Ensure-CenterNodeModules (npm install --omit=dev)", 操作员于是
  # 只重启服务 → 依赖从未安装 → 新代码 import 一个生产机没有的包 → node
  # 第一秒崩 → NSSM AppExit=Default Restart → 崩溃重启循环 (R121 / R123 /
  # R124 那一族), 而操作员被明确告知"重启就够了"。现在把真话说出来。
  Write-Host "[ship-publish-to-prod] center deps CHANGED (package.json / package-lock.json hash differs)." -ForegroundColor Yellow
  Write-Host "  NSSM 启动服务时**不会**自动装依赖 —— 必须显式跑一次安装/升级脚本:" -ForegroundColor Yellow
  Write-Host "    & '$dstRoot\scripts\install-center.ps1' -InPlace -ListenPort 8080" -ForegroundColor Yellow
  Write-Host "  (或 upgrade-center.ps1) —— 跑完再重启服务。" -ForegroundColor Yellow
} else {
  Write-Host "[ship-publish-to-prod] center deps unchanged → 已与 manifest 一致, 无需重装依赖。" -ForegroundColor Green
}

Write-Host "[ship-publish-to-prod] DONE. Mirror + hash verified. Awaiting operator restart." -ForegroundColor Green