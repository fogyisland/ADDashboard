# AD Dashboard Center installer (DEPLOYMENT ONLY).
# For application init (DB connection, schema, seed, admin user, appsettings.json),
# the center service's built-in /init wizard handles that on first boot.
# This installer only does deployment: verify prerequisites, copy files,
# register NSSM service, start service.
[CmdletBinding()]
param(
  [string]$InstallPath,
  [int]$ListenPort = 8080,
  [string]$AgentToken,   # generated if missing
  [string]$JwtSecret,    # generated if missing
  [switch]$InPlace       # green-bundle: install service pointing at <projectRoot>\center, no file copy
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

if ($InPlace) {
  $InstallPath = Join-Path $projectRoot 'center'
  Write-Info "in-place install: service will point at $InstallPath (no file copy to <publish-root>/Center)"
}

Write-Step "install-center: $InstallPath (deployment only — wizard handles app init)"

# 0. Ensure NSSM is available locally (downloads to <projectRoot>/nssm/ on first run)
. (Join-Path $PSScriptRoot 'common\Ensure-Nssm.ps1') -ProjectRoot $projectRoot

# Idempotent node_modules install: hash-checked against package.json+package-lock.json.
# Reinstalls when the source deps change (added/removed/upgraded) or node_modules is missing.
# Writes the new hash to <InstallPath>\.install-hash after a successful install.
function Ensure-CenterNodeModules {
  param(
    [Parameter(Mandatory)] [string]$InstallPath,
    [Parameter(Mandatory)] [string]$SrcDir
  )
  $hashFile = Join-Path $InstallPath '.install-hash'
  $srcPkg = Join-Path $SrcDir 'package.json'
  $srcLock = Join-Path $SrcDir 'package-lock.json'
  $newHash = ''
  if (Test-Path $srcPkg) {
    $newHash += (Get-FileHash -Algorithm SHA256 -Path $srcPkg).Hash
  }
  if (Test-Path $srcLock) {
    $newHash += (Get-FileHash -Algorithm SHA256 -Path $srcLock).Hash
  }
  $oldHash = if (Test-Path $hashFile) { Get-Content -Path $hashFile -Raw -ErrorAction SilentlyContinue } else { '' }
  # "依赖是否到位"的判据 = **能不能真的被 require 解析**, 而不是
  # "有没有 <InstallPath>\node_modules 目录"。
  # 原因: npm workspaces 会把依赖提升到**工作区根**的 node_modules ——
  # `npm install --omit=dev` 跑在 <root>\center 里, 实际装到 <root>\node_modules,
  # <root>\center\node_modules 永远不出现。旧判据因此永远认为
  # "node_modules missing" ⇒ 每次安装都重跑一次 npm install, 而 --omit=dev
  # 还会顺手把根 node_modules 里的 vite/vitest 剪掉 ⇒ 之后 build:web
  # 报 "vite: not found"。判据换成"能否解析"之后, 提升安装与本地安装
  # 两种布局都能正确识别为"已就绪"。
  $depsOk = Test-NodeDepsResolvable -InstallPath $InstallPath
  $needsInstall = -not $depsOk
  if (-not $needsInstall -and $newHash -ne '' -and $newHash -ne $oldHash) {
    $needsInstall = $true
    $reason = 'deps changed (package.json or package-lock.json hash differs)'
  } elseif (-not $needsInstall) {
    $reason = 'up-to-date'
  } else {
    $reason = 'dependencies not resolvable from the install path'
  }
  if ($needsInstall) {
    Write-Step "installing center node_modules ($reason)"
    # 不再先删 <InstallPath>\node_modules —— 旧实现是"先删再装", 一旦
    # npm 装失败(离线服务器 / 源不可达), 树里就什么都不剩了。npm 本身
    # 会把依赖树对齐, 先删只增加"装失败 ⇒ 彻底没依赖"的风险。
    #
    # R161.26 — 真正的安装动作交给**共享实现**
    # (Service.psm1::Install-CenterNodeDeps):
    #   · **工作区感知** —— 成员目录里跑 npm install, npm 认的 install
    #     root 是工作区根 ⇒ 成员自己的 devDependencies (vite/vitest/
    #     jsdom/...) 会被一起剪掉 (实测 "removed 140 packages") ⇒ 装完
    #     这台机器再也 build 不出前端、跑不了 web 测试, 而报错是
    #     "vite: not found" —— 与部署毫无关系。共享实现装完会把工具链装回来。
    #   · **显式限定工作区** —— 兄弟工作区 (agent) 的原生依赖
    #     better-sqlite3 **只有在工作区根上跑** install 才会被拉进来
    #     (实测: 根上跑会 "add better-sqlite3 11.10.0" + 30 个包)。
    #     旧代码躲过这一劫靠的是"cwd 恰好在成员目录"这个**巧合** ——
    #     而同一文件下面的 dev 自愈恰恰是在**根上**跑的 ⇒ 作用域必须
    #     显式写进命令行, 不能靠 cwd 的启发式。
    #   · 装完**复验**依赖可解析 —— 旧实现"装完就写 .install-hash", 于是
    #     npm 失败时也把哈希记成成功, 下一轮就认为"依赖已就绪", 服务带着
    #     残缺的依赖启动 ⇒ 崩溃重启循环 (R121 / R123 / R124 家族)。
    #     现在失败当场抛, 不留"看起来装好了"的假象。
    # install / upgrade / update 三条链必须走**同一份**实现, 否则修好一处
    # 另两处照旧。
    $depResult = Install-CenterNodeDeps -InstallPath $InstallPath -ProjectRoot $projectRoot
    Write-Info ("npm install: mode={0} root={1} workspace={2}" -f $depResult.Mode, $depResult.Root, $depResult.Member)
    if ($depResult.DevToolingRestoreFailed) {
      Write-Warn2 ("could not restore the dev toolchain at {0} — 'npm run build:web' / 'npm run test:web' will fail until you run: npm install --workspace={1} --include=dev" -f $depResult.Root, $depResult.Member)
    }
    if ($newHash -ne '') {
      Set-Content -Path $hashFile -Value $newHash -NoNewline
    }
  } else {
    Write-Info "center node_modules up-to-date"
  }
}

# Set log directory inside the NSSM/Logger modules' own $Script: scope — module
# functions can't see the caller's $Script:LogDir, so we have to push the
# value across explicitly via the modules' setters. Co-located under the
# install dir so uninstall/upgrade scripts find it without an extra path arg.
$Script:LogDir = Join-Path $InstallPath 'Logs'
if (-not (Test-Path $Script:LogDir)) { New-Item -ItemType Directory -Path $Script:LogDir -Force | Out-Null }
# R119 — per-module/per-route server-side log directory. R119's
# createMultiRotatedLogger writes rotated files into <LogDir>/APP/
# (one file per module: agent.log, heartbeat.log, init.log, web.log).
# Mkdir here so first-request pino-roll open() never sees a missing
# directory. The dual defence (install-time mkdir + logger.js mkdir -p)
# closes the R91.4 / R110.A LESSON race where the rotated file was
# created in a parent that the operator's NSSM had not yet observed.
$Script:AppLogDir = Join-Path $Script:LogDir 'APP'
if (-not (Test-Path $Script:AppLogDir)) { New-Item -ItemType Directory -Path $Script:AppLogDir -Force | Out-Null }
Set-NssmLogDir $Script:LogDir
Set-LogDir $Script:LogDir
# R119 — per-module log file for this installer (dual-writes into legacy
# <LogDir>/install.log via Logger.psm1::Write-Log). Install-center writes
# before Set-LogDir land in the default 'install' module; everything
# after this point lands in <LogDir>/APP/install-center.log.
Set-LogModule 'install-center'
# R119.B boot fingerprint — single line naming the running version + git
# commit so operators can prove which code is installed.
# R161.25 (2026-10-29 部署审计): 读**中心**的清单 (build-manifest.json),
# 不是 agent 的 —— 旧实现调 Get-AgentManifest, 打印出来的是 **agent 的
# 版本号**, 操作员会以为中心装的是 agent 那一版。中心真正在跑的是
# server.js:430 读的 <repoRoot>\build-manifest.json。
$mfst = Get-CenterManifest -ManifestRoot $projectRoot
$commit = if ($mfst -and $mfst.gitCommit) { $mfst.gitCommit } else { 'unknown' }
Write-Info ("{0} v{1} (commit={2})" -f $MyInvocation.MyCommand.Name, (Get-CenterVersion -ManifestRoot $projectRoot), $commit)

# When -InPlace, skip file copy / dist mirror / npm install of the install target.
# node_modules is still installed if missing (green-bundle first-time setup).
$srcDir = Join-Path $projectRoot 'center'
if (-not $InPlace) {
  # 1. Ensure directories
  @($InstallPath, "$InstallPath\dist") | ForEach-Object {
    if (-not (Test-Path $_)) { New-Item -ItemType Directory -Path $_ -Force | Out-Null; Write-Info "created $_" }
  }

  # 2. Verify Node.js
  # R161.27 — 自带 Node 优先 (<root>\node\node.exe), PATH 只是回落。
  # 操作员 directive: 目标机不装其他 Node 环境 ⇒ 没有系统 Node 时安装
  # 也必须能走通。
  $node = Get-BundledNodeRuntime -ProjectRoot $projectRoot -Kind 'node'
  if (-not $node) {
    throw "node.exe not found — neither $projectRoot\node\node.exe (bundled) nor node on PATH. 交付树的 node\ 目录必须完整, 或本机安装 Node 20 LTS 并加入 PATH。"
  }
  Write-Info "node: $node"

  # 3. Build web UI if dist missing
  $distPath = Join-Path $projectRoot 'center\dist'
  if (-not (Test-Path (Join-Path $distPath 'index.html'))) {
    Write-Step "building web UI"
    # Fresh publish bundle has no <publish-root>/node_modules. Install at root so
    # vite is hoisted via workspaces; `npm run build:web --workspace=center`
    # delegates to the center workspace's web/ subpackage. Dev installs always
    # have root node_modules — no-op.
    #
    # R160 修复 (2026-10-25): 判据问的是"node_modules 目录在不在", 而构建
    # 需要的是 **node_modules\vite**。npm workspaces 把依赖提升到根, 而**本
    # 文件第 83 行自己就跑过** `npm install --omit=dev` —— 实测它会**删掉**
    # 根 node_modules 里的 vite (实测输出: "remove vite 5.4.21" /
    # "removed 141 packages")。于是"跑过一次安装之后"的状态恰恰是:
    #   node_modules **在**、vite **不在**
    # ⇒ 旧判据为假 ⇒ 自愈被跳过 ⇒ 下一行 npm run build:web 报
    # "vite: not found" ⇒ 安装在**最后一步**炸, 而真正的失败原因还被埋在
    # npm 输出里。
    # 同一文件下面的 in-place 分支用的就是 node_modules\vite —— 现在两条
    # 分支判据一致。
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\vite'))) {
      Write-Step "installing center dev dependencies (vite missing)"
      Push-Location $projectRoot
      try {
        # 只装 center 工作区 (与 in-place 分支同一条命令)。全量
        # `npm install` 会把 agent 工作区一起装上, 而 agent 的
        # better-sqlite3 是原生模块 (要 Python + node-gyp) —— 离线/生产机上
        # 装不上就会把整条安装链带崩。
        & npm.cmd install --workspace=center --include=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm install --workspace=center --include=dev failed at $projectRoot (exit $LASTEXITCODE)" }
      } finally { Pop-Location }
    }
    Push-Location $projectRoot
    try {
      & npm.cmd run build:web --workspace=center
      if ($LASTEXITCODE -ne 0) { throw "npm run build:web --workspace=center failed (exit $LASTEXITCODE)" }
    } finally { Pop-Location }
    # 构建没出 index.html 就别往下走 —— 否则服务起来之后每个页面都 404,
    # 而安装脚本一路报 OK (旧实现没有这道校验)。
    if (-not (Test-Path (Join-Path $distPath 'index.html'))) {
      throw "web UI build did not produce $distPath\index.html"
    }
  }

  # 4. Copy center files.
  #    Copy-DirectoryContent skips the copy when source and target are the same
  #    directory (Windows is case-insensitive, so the default install path
  #    '<root>\Center' IS the source tree '<root>\center'). Self-copying used
  #    to either throw or — in the dist variant — delete the directory it was
  #    about to copy from.
  #
  #    R160 修复 (2026-10-25):
  #    (a) 覆盖之前先停掉正在跑的服务。旧实现**从不**停服 (upgrade-center.ps1
  #        和 update-center.ps1 都停, 只有 install-center 漏了) ⇒ 重装时
  #        server.js / dist 被就地覆盖, 而 node 早就把模块 require 完了 ⇒
  #        **跑的还是旧代码**; 紧接着 Start-ServiceSafe 看到服务已是 Running
  #        就直接 return $true (Service.psm1) ⇒ 脚本打印 "service started",
  #        探针也被**旧进程**答 200 ⇒ 全绿, 但新版从未生效。
  #    (b) 拷贝时排除 .install-hash 与 Logs。
  #        .install-hash 是"这台机器的依赖装到哪一版"的标记, 属运行期状态,
  #        属目标机的, 不该被源树的副本覆盖 —— 一旦被覆盖, 之后算出来的
  #        "新哈希"与"被覆盖的旧哈希"都来自同一份源文件 ⇒ 永远相等 ⇒
  #        needsInstall 恒为 false ⇒ **目标机永远跳过 npm install**, 带着
  #        上一版依赖跑新代码。
  #        Logs 同理: 那是目标机自己的运行日志, 拷贝会用开发机的旧日志
  #        覆盖掉正在写的那个 (包括本脚本此刻写的那一行)。
  if (-not (Stop-ServiceSafe -Name 'ADDashboardCenter' -WaitSeconds 30)) {
    throw 'cannot stop the running ADDashboardCenter service — refusing to overwrite its files'
  }
  $codeCopy = Copy-DirectoryContent -SourceDir $srcDir -TargetDir $InstallPath `
    -Exclude (Get-CenterCopyExclusions)
  Write-Info $codeCopy.Message
  if ($codeCopy.Status -eq 'same-path') {
    Write-Warn2 "install path is the source tree ($InstallPath) — running in place, no code copy performed"
  }
  Ensure-CenterNodeModules -InstallPath $InstallPath -SrcDir $srcDir
  $distCopy = Copy-DirectoryContent -SourceDir $distPath -TargetDir (Join-Path $InstallPath 'dist')
  Write-Info $distCopy.Message
} else {
  # In-place: only install node_modules if missing; build dist if missing.
  # R161.27 — 自带 Node 优先, PATH 只是回落 (与上面的分支同一判据)。
  $node = Get-BundledNodeRuntime -ProjectRoot $projectRoot -Kind 'node'
  if (-not $node) {
    throw "node.exe not found — neither $projectRoot\node\node.exe (bundled) nor node on PATH. 交付树的 node\ 目录必须完整, 或本机安装 Node 20 LTS 并加入 PATH。"
  }
  Write-Info "node: $node"
  Ensure-CenterNodeModules -InstallPath $InstallPath -SrcDir $srcDir
  # <root>\center\dist is BOTH the shipped bundle and the directory the
  # service serves. The old code did
  #     Remove-Item $distPath
  #     Copy-Item $shippedDist\* → $distPath
  # with $shippedDist === $distPath, i.e. it deleted the UI and then copied
  # the (now empty) directory onto itself. The service came up serving
  # "ENOENT: ...\center\dist\index.html" (2026-10-25). Everything below is
  # guarded by Test-SamePath — the dist is never deleted, and when it has to
  # be rebuilt vite writes straight into it (vite owns the emptyOutDir wipe).
  $distPath = Join-Path $InstallPath 'dist'
  $shippedDist = Join-Path $projectRoot 'center\dist'
  if (Test-SamePath -PathA $distPath -PathB $shippedDist) {
    if (Test-Path (Join-Path $distPath 'index.html')) {
      Write-Step "in-place: dist is the served directory and already contains index.html — leaving it alone"
    } else {
      Write-Step "building web UI (in-place; vite writes straight into $distPath)"
      # vite is a devDependency of the center workspace, and the dependency
      # installer runs `npm install --omit=dev` — so on a freshly installed
      # server the build tooling is NOT present. Install it explicitly before
      # building, otherwise the build fails with "vite: not found".
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
      if (-not (Test-Path (Join-Path $distPath 'index.html'))) {
        throw "npm run build:web did not produce $distPath\index.html"
      }
      Write-Ok "web UI built into $distPath"
    }
  } else {
    # Defensive: source and target are genuinely different directories.
    $distSync = Sync-DirectoryContent -SourceDir $shippedDist -TargetDir $distPath
    Write-Info $distSync.Message
  }
}

# 4.2 (R161.17, 2026-10-27) — 把 db/ 装到**安装目录的上一级**。
#
#   init 向导的建库步骤 (POST /api/init/db/apply) 要读
#     <repoRoot>/db/migrations/<dialect>/1.0.0-baseline.sql
#   而 repoRoot 由 src/init/schema-applier.js 的 resolveRepoRoot() 现场解析:
#     1. ADDASHBOARD_REPO_ROOT 环境变量
#     2. <进程 cwd>/..        ← 默认布局命中的就是这一条
#     3. <进程 cwd>/../..
#     4. <进程 cwd> 本身
#   服务的 AppDirectory = $InstallPath ⇒ 进程 cwd = 安装目录 ⇒ 命中第 2 条
#   ⇒ db/ 必须待在**安装目录的上一级**。
#
#   ★ 旧实现只拷 center/, 从不拷 db/:
#     - 默认布局 (InstallPath = <root>\Center, 与源树 <root>\center 同一个
#       目录) 靠"源树里本来就有 db/"侥幸能跑;
#     - 但操作员把 -InstallPath 指到别处 (例如 D:\ADDashboard\Center) 时,
#       上一级没有 db/ ⇒ resolveRepoRoot 找不到基线 ⇒ init 向导在建库那一步
#       直接报「找不到基线文件」⇒ **向导在自定义安装路径下完全不可用**。
#   这里把 db/ 拷到 <安装目录上一级>\db, 与 Linux 交付包的布局一致
#   (LinuxServer/db 与 LinuxServer/center 平级)。
#
#   缺 db/ 时**当场抛** —— 少拷一个目录, 却让操作员在向导第 3 步撞上
#   「找不到基线文件」, 现场离原因十万八千里。
$dbSrc = Join-Path $projectRoot 'db'
if (-not (Test-Path -LiteralPath $dbSrc)) {
  throw "the db/ directory (baseline + migrations) is missing at $dbSrc — the init wizard cannot build the schema without it"
}
$dbSync = Sync-CenterDbDirectory -SourceRoot $projectRoot -InstallPath $InstallPath
Write-Info $dbSync.Message
if ($dbSync.Status -eq 'same-path') {
  Write-Info "db/ already sits next to the install directory ($($dbSync.Target)) — nothing to copy"
}

# 4.3 (R161.25) — build-manifest.json 也要到**安装目录的上一级**。
#   中心读的是 <repoRoot>\build-manifest.json (server.js:430); 自定义安装
#   路径下那一层本来没有这个文件 ⇒ 启动指纹退化 ⇒ 操作员无法证明目标机上
#   跑的是哪一版。
$manifestSync = Sync-CenterBuildManifest -SourceRoot $projectRoot -InstallPath $InstallPath
Write-Info $manifestSync.Message

# 4.5 (R158.License-config.install, 2026-10-15) — 在 NSSM register 前, 幂等写
#   appsettings.json.signature + installedAt. 调中心 license-validator.js 的
#   ensureSignatureAndInstalledAt (跟 server.js lazy 写同一函数, 0 在 PS 端再写
#   一份; R158.86.6 #5 6 维度: 复用 > 重写). 走 patchConfigAtomic (tmp+rename)
#   原子写, 不会被 NSSM 启动的 node 读到坏 cfg.
#
#   操作员 directive 2026-10-15 字面: "将 signature 和时间写入注册为服务的时间".
#   本步时点 = NSSM register 前, 即"注册为服务"时. appsettings.json 存在条件
#   触发 (操作员预生成 + wizard 之前手填 或 init-mode 完成后); 缺则 skip, 走
#   server.js 第一次正常启动的 lazy 写兜底 (R158.License-config 双层防御).
#
#   0 改既有的 5 步 install 流程; 0 触碰 R158.69 / R158.87 / R158.88 / agent.
$appsettingsPath = Join-Path $InstallPath 'appsettings.json'
if (Test-Path $appsettingsPath) {
  Write-Step "writing signature + installedAt (注册为服务时点, idempotent)"
  Push-Location $InstallPath
  try {
    $writeOut = node -e "import('./src/services/license-validator.js').then(m => { const r = m.ensureSignatureAndInstalledAt(process.argv[1], null); console.log(JSON.stringify(r)); }).catch(e => { console.error('FAIL:', e.message); process.exit(1); })" $appsettingsPath
    if ($LASTEXITCODE -ne 0) {
      Write-Warn2 "ensureSignatureAndInstalledAt failed; server.js lazy 写 will retry on first boot"
    } else {
      Write-Info "signature/installedAt write: $writeOut"
    }
  } finally { Pop-Location }
} else {
  Write-Info "appsettings.json 不存在 (init wizard 还没跑); signature/installedAt 走 server.js lazy 写 (R158.License-config 兜底)"
}

# 4.9 (R161.25, 2026-10-29 部署审计) — **机器级** init 标记预检。
#
#   init 完成标记存在**两个**存储: <installPath>/.env 与 Windows 注册表
#   HKLM\SOFTWARE\ADDashboard\Initialized。注册表那一份是**机器全局**的
#   (不按安装目录区分), 且 hasMarker() 只要**任意一个**存储命中就把向导
#   锁死 (src/init/marker.js:113)。
#
#   ⇒ 在一台**曾经装过中心**的机器上做全新安装时, 目标目录里既没有 .env
#     也没有 appsettings.json, 但注册表标记还在 ⇒ markerLocked=true +
#     config=null ⇒ server.js 走 process.exit(2) ⇒ **服务永远起不来, 向导
#     也进不去**, 而日志里只有一行 "init marker present but config missing"。
#     这个失败点离"装不上"的原因十万八千里。
#
#   所以在注册服务**之前**就把它挑明, 并给出可执行的一条命令。
$markerState = Get-CenterInitMarkerRegistryState
if ($markerState.Present) {
  Write-Warn2 "machine-level init marker detected — $($markerState.Detail)"
  if (-not (Test-Path -LiteralPath $appsettingsPath)) {
    Write-Warn2 "the target has NO appsettings.json, but the marker hard-locks the init wizard => server.js will exit(2) and the service will NOT start."
    Write-Warn2 "fix: reg delete HKLM\SOFTWARE\ADDashboard /v Initialized /f   (only if this machine hosts no other center install)"
  } else {
    Write-Warn2 "appsettings.json is present, so the marker is expected (previously initialized install)."
  }
} else {
  Write-Info "init marker pre-check: $($markerState.Detail)"
}

# 5. Register and start service
Install-NssmService -Name 'ADDashboardCenter' `
  -Application $node `
  -AppDirectory $InstallPath `
  -AppParameters 'server.js' `
  -DisplayName 'AD Replication Dashboard Center' `
  -Description 'AD Replication Dashboard Center (Node.js + Express + Vue 3)' `
  -Start SERVICE_AUTO_START

# R161.25 (2026-10-29 部署审计) — **恢复** NSSM 的 stderr 捕获。
#
# 旧实现在这里调 Disable-NssmStderr, 理由是 "NSSM 与 pino-roll 抢同一个
# 轮转文件"。**那个理由是错的**: 两个写入根本不在同一个文件上 ——
#   NSSM → <LogDir>\ADDashboardCenter-stderr.log / -stdout.log
#   pino → <LogDir>\center.<date>.<n>.log + <LogDir>\APP\<module>.log
# 文件名互不重叠, 不存在抢句柄 / 抢 rename。
#
# 而关掉 stderr 的代价是实打实的: **Node ESM 的 import 期错误不经过
# process.on('uncaughtException')** —— 实测 (stdout 全空, stderr 承载整条
# ERR_MODULE_NOT_FOUND 栈, handler 从未触发)。"少拷一个目录 / 少装一个
# 模块" 这类最常见的部署失败, 唯一的证据就在 stderr 上 ⇒ 关掉它 = 现场
# 一句"服务起不来", 没有堆栈。
#
# Install-NssmService 已经把 AppStderr 指向 <LogDir>\<name>-stderr.log;
# 这里再显式调一次, 是为了把**先前版本装的服务**(那时 AppStderr 被 reset
# 成"无重定向")也一并纠正过来。
Enable-NssmStderr -Name 'ADDashboardCenter'

# Configure auto-restart: NSSM picks up process.exit(0) and re-launches with new appsettings.json;
# Windows Service Recovery handles crashes (OOM, segfault, kill -9).
# Helper in scripts/common/Service.psm1 owns the NSSM + sc.exe wiring.
#
# R160 修复 (2026-10-25): 旧实现让 Set-ServiceRecovery 的异常直接冒泡。
# 这个 throw 点正好夹在"服务已注册、参数已设好"(上面的 Install-NssmService)
# 和"启动服务 + HTTP 探针"(下面)中间 ⇒ 恢复策略配不上 ⇒ **服务注册了但
# 从来没被拉起过**, 探针也没跑, 脚本直接终止, 操作员看到一个"装了但没跑"
# 的服务, 而且没有任何回滚 (没有 unregister)。
# 现在: 恢复策略是"锦上添花", 配不上也要把服务启动 + 探针跑完, 只是明确
# 告警 —— 与 Enable-NssmStderr 同一个处理原则 (NSSM.psm1)。
try {
  Set-ServiceRecovery -Name 'ADDashboardCenter'
} catch {
  Write-Warn2 "Set-ServiceRecovery failed: $($_.Exception.Message) — the service is still installed and will be started, but it will NOT auto-restart after a crash."
}

if (Start-ServiceSafe -Name 'ADDashboardCenter' -WaitSeconds 20) {
  Write-Ok "service started"
} else {
  # stderr 现在是**开着**的 (见上面 Enable-NssmStderr) ⇒ 指向它是有效的:
  # Node 的 import 期错误 (ERR_MODULE_NOT_FOUND 等) 只在 stderr 上, 且
  # 不经过 uncaughtException handler ⇒ 这个文件就是那类失败的唯一证据。
  Write-Err2 "service failed to start; see $Script:LogDir\ADDashboardCenter-stderr.log (node 启动期错误, 如 ERR_MODULE_NOT_FOUND) and the center log directory $Script:LogDir (center.<date>.<n>.log / APP\<module>.log)"
  exit 1
}

# 6. Probe health — wait for HTTP to come up instead of single-shot. SCM
# "Running" only means NSSM launched node; Express still needs to bind the
# port (cold cache: 2-15s). Wait-ForHttpOk polls until 2xx or 30s timeout.
#
# R161.25 (2026-10-29 部署审计): 旧实现在探针失败时只打两条 Write-Info,
# 然后脚本**正常结束 (exit 0)** ⇒ 操作员/CI 看到"安装成功", 而服务可能
# 正在崩溃重启循环里 (node 起不来 / 端口被占 / 缺模块 ⇒ 一秒后退出 ⇒ NSSM
# 再拉起 ⇒ 永远起不来)。upgrade-center.ps1 / update-center.ps1 在同样的
# 条件下是 `throw` —— 三个脚本三种行为, 同一个失败被报成两种结果。
# 现在统一: 探针不过 ⇒ exit 1, 并把可查的证据路径点出来。
$probeUrl = "http://localhost:$ListenPort/api/init/status"
if (Wait-ForHttpOk -Url $probeUrl -TimeoutSeconds 30 -IntervalSeconds 1) {
  $health = try { (Invoke-WebRequest -Uri $probeUrl -UseBasicParsing -TimeoutSec 5).Content } catch { "unreachable: $($_.Exception.Message)" }
  Write-Ok "init status: $health"
  Write-Ok "open browser to: http://localhost:$ListenPort/init to complete application initialization"
} else {
  Write-Err2 "HTTP probe at $probeUrl did not return 2xx within 30s — the center did NOT come up."
  Write-Err2 "the service is registered and 'Running' per SCM, but Express never bound the port (node crashed / crashed again on restart)."
  Write-Err2 "evidence: NSSM stderr $Script:LogDir\ADDashboardCenter-stderr.log | center log $Script:LogDir\center.<date>.<n>.log | per-module $Script:LogDir\APP\<module>.log"
  Write-Err2 "if the service exits immediately, run: nssm status ADDashboardCenter   (and read the stderr log above)"
  exit 1
}
