# SECURITY: this script uses Invoke-Command; -ComputerName values must be trusted and reachable over WinRM.
# AgentToken is sent in cleartext over the WinRM channel — use HTTPS WinRM or pre-shared credentials in production.
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string[]]$ComputerName,
  [Parameter(Mandatory)][string]$CenterUrl,
  [Parameter(Mandatory)][string]$AgentToken,
  # T16: agent type discriminator. 'ad' (default) installs the legacy DC
  # collector with DisplayName "AD Replication Agent (on <host>)"; 'non-ad'
  # installs the member-server runtime with DisplayName "AD Dashboard
  # Agent (Member)" and persists agentType to appsettings.json so the
  # running process picks it up on next start. Backward compatible: callers
  # who omit the param keep the pre-T16 behavior.
  [ValidateSet('ad','non-ad')]
  [string]$AgentType = 'ad',
  [string]$InstallPath,
  # Internal-use parameters for remote-install forwarding. When the script runs
  # in a remote session, $PSScriptRoot is null; we pre-resolve and pass these
  # explicitly so the scriptblock always knows where to copy from.
  [string]$AgentSrc,
  [string]$PsScriptSrc
)

# $PSScriptRoot is empty in [CmdletBinding()] default param values (parameter
# binding scope is a child of script scope; auto-vars only set in script scope).
# Resolve default InstallPath in the body where $PSScriptRoot is available.
#
# Two supported layouts (mirror of start.ps1:88-104):
#   GREEN PACKAGE: $PSScriptRoot\agent\  (script at <green>/agentInstall/,
#                                         agent/ is a sibling — flat layout).
#                     The green package's install path IS the current
#                     directory's agent/ subdir: operators run
#                     install-agent.ps1 from where they extracted the bundle
#                     and nothing else. No external path to specify.
#   DEV TREE:      $PSScriptRoot\..\Agent\ (script at <repo>/scripts/,
#                                          parent is repo root — one level up;
#                                          Agent/ is a separate install dir).
#
# Without this green-pkg-first check, the legacy default always resolves to
# <PSScriptRoot>\..\Agent = C:\Agent on a green-pkg run, which doesn't exist
# on the operator's machine → Set-LogDir fails → Logger.psm1:21 Add-Content
# can't write to C:\Agent\Logs\install.log (real install run on KDLWXOFADSRV1
# hit this; see 2026-08-25 round-12).
if (-not $InstallPath) {
  $greenPkgAgent = Join-Path $PSScriptRoot 'agent'
  $devTreeAgent  = Join-Path (Join-Path $PSScriptRoot '..') 'agent'
  if (Test-Path $greenPkgAgent) {
    $InstallPath = $greenPkgAgent
  } elseif (Test-Path $devTreeAgent) {
    $InstallPath = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')) 'Agent'
  } else {
    throw "agent/ source not found. Tried '$greenPkgAgent' (green-package layout) and '$devTreeAgent' (dev-tree layout). Verify the bundle layout — agentInstall/ expects agent/, common/, nssm/ as siblings."
  }
}

# ============================================================================
# Local / WinRM remote install for AD Dashboard Agent. As of v2.1+, this is
# the SECONDARY install path; the primary path is the WiX MSI installer
# (addashboard-agent-x64-<version>.msi). Operators who can double-click an
# MSI (or run `msiexec /i ... /qn CENTERURL=... AGENTTOKEN=... AGENTTYPE=...`)
# should prefer the MSI path — see docs/operations/deployment.md §Agent MSI
# Install. This script remains for:
#   - WinRM-based remote install to multiple machines from a management box
#   - Air-gapped environments where pulling the MSI binary is undesirable
# Both paths produce the same service name (ADReplicationAgent) and the same
# NSSM configuration, so you can switch between them freely.
#
# 2026-08-23 split: this script now ONLY does file copy + `npm install`; the
# SCM-facing steps (appsettings.json write + NSSM install + NSSM parameters +
# sc.exe failure recovery + Start-Service) live in
# Register-ADDashboardAgent.ps1 — the single entry point shared with
# uninstall-agent.ps1 and (future) the MSI's ConfigureAgentAction. This
# eliminates the pre-split duplication where the green package was missing
# the Set-ServiceRecovery call that the MSI always made, and gives the MSI
# path a future option to delegate to PS1 without a second copy of the logic.
# ============================================================================

$ErrorActionPreference = 'Stop'
# Logger.psm1 supplies Write-Step / Write-Ok used in this script's file-copy
# + npm-install phase. The SCM-facing steps (appsettings.json + NSSM + sc.exe
# failure) live in Register-ADDashboardAgent.ps1 which has its own inline
# logger so the two scripts are independently self-contained.
Import-Module (Join-Path $PSScriptRoot 'common\Logger.psm1') -Force
# Push LogDir into Logger.psm1's module-scoped $Script:LogDir (Write-Step /
# Write-Ok etc. can't see the caller's variable directly).
$Script:LogDir = Join-Path $InstallPath 'Logs'
if (-not (Test-Path $Script:LogDir)) { New-Item -ItemType Directory -Path $Script:LogDir -Force | Out-Null }
Set-LogDir $Script:LogDir

# Layout-independent agent source resolution.
#
# Two supported layouts:
#   GREEN PACKAGE: $PSScriptRoot\agent\   (script at <green>/agentInstall/,
#                                         agent/ is a sibling — flat layout)
#   DEV TREE:      $PSScriptRoot\..\agent\ (script at <repo>/scripts/,
#                                         parent is repo root — one level up)
#
# Detect by file presence; default to whichever layout finds an `agent/`
# sibling. If neither matches, fall through to a clear error so the operator
# knows the bundle layout is wrong.
$greenPkgAgent = Join-Path $PSScriptRoot 'agent'
$devTreeAgent  = Join-Path (Join-Path $PSScriptRoot '..') 'agent'
if (-not $AgentSrc) {
  if (Test-Path $greenPkgAgent) {
    $AgentSrc = $greenPkgAgent
  } elseif (Test-Path $devTreeAgent) {
    $AgentSrc = $devTreeAgent
  } else {
    throw "agent/ source not found. Tried '$greenPkgAgent' (green-package layout) and '$devTreeAgent' (dev-tree layout). Verify the bundle layout — agentInstall/ expects agent/, common/, nssm/ as siblings."
  }
}
# R161.23 (2026-10-29) — lineage-aware collector selection. The AD/DC lineage
# collects replication state via scripts\collect-replication.ps1; the non-AD
# lineage has no DC replication to collect and uses scripts\collect.ps1.
# Hard-coding the AD collector here meant a member-server install through this
# bundle copied the wrong collector and pointed appsettings.json at it.
if (-not $PsScriptSrc) {
  $collectorScriptName = if ($AgentType -eq 'non-ad') { 'collect.ps1' } else { 'collect-replication.ps1' }
  $PsScriptSrc = Join-Path $AgentSrc ('scripts\' + $collectorScriptName)
}
$psScriptDstDir = Join-Path $InstallPath 'scripts'
# Pre-flight: Node.js 20 LTS. Green package bundles it at <green>/node/
# (see installer/build-green-package.ps1 step 4). Search order:
#   1. <green>/node/node.exe — bundled (green-package layout)
#   2. <InstallPath>/node/node.exe — already-copied by a prior install
#   3. node.exe on PATH — operator-installed fallback (legacy, pre-bundling)
# start.ps1 already runs this same check before delegating here; we re-run
# it so callers who invoke install-agent.ps1 directly (WinRM remote install,
# automation) get the same friendly error instead of an unfriendly
# CommandNotFoundException downstream.
$bundledGreenNode = Join-Path $PSScriptRoot 'node\node.exe'
$bundledInstalledNode = Join-Path $InstallPath 'node\node.exe'
$node = $null
if (Test-Path -LiteralPath $bundledGreenNode) { $node = $bundledGreenNode }
elseif (Test-Path -LiteralPath $bundledInstalledNode) { $node = $bundledInstalledNode }
else {
  $nodeOnPath = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($nodeOnPath) { $node = $nodeOnPath.Source }
}
if (-not $node) {
  throw "node.exe not found. The green package SHOULD bundle Node.js 20 LTS at <green>\node\node.exe — verify the bundle layout. If you have a custom bundle without Node, install Node 20 LTS and add it to PATH. See installer/README-green-install.md."
}
Write-Step "using Node.js: $node"

function Install-LocalAgent {
  Write-Step "installing local agent to $InstallPath (agentType=$AgentType)"
  @($InstallPath, $psScriptDstDir, (Join-Path $InstallPath 'Logs')) | ForEach-Object {
    if (-not (Test-Path $_)) { New-Item -ItemType Directory -Path $_ -Force | Out-Null }
  }
  # Detect Windows case-insensitive source/destination collision. The green
  # package layout places source under <root>/agent and default install under
  # <root>/Agent; on Windows those collapse to the same physical directory
  # (e.g. C:\agentInstall\agent and C:\agentInstall\Agent both map to one
  # dir). Copy-Item then refuses with "Cannot use the item itself to
  # overwrite the item" on every file. Skip BOTH the recursive code copy AND
  # the single-file collect-replication.ps1 copy when source==dest — the
  # agent code is already in place; npm install + service registration
  # below still run. (Real install run on KDLWXOFADSRV1 hit this.)
  $resolvedSrc = (Resolve-Path -LiteralPath $AgentSrc -ErrorAction SilentlyContinue).ProviderPath
  $resolvedDst = (Resolve-Path -LiteralPath $InstallPath -ErrorAction SilentlyContinue).ProviderPath
  $srcEqDst = $resolvedSrc -and $resolvedDst -and [string]::Equals($resolvedSrc, $resolvedDst, [StringComparison]::OrdinalIgnoreCase)
  if ($srcEqDst) {
    Write-Step "source and install path resolve to the same directory ($resolvedSrc); skipping code copy (agent code already in place)"
  } else {
    Copy-Item -Path (Join-Path $AgentSrc '*') -Destination $InstallPath -Recurse -Force -Exclude 'node_modules','tests','appsettings.json','Logs','data'
    Copy-Item -Path $PsScriptSrc -Destination $psScriptDstDir -Force
  }

  # Stage bundled Node.js 20 LTS portable at <InstallPath>\node\ so NSSM can
  # launch <InstallPath>\node\node.exe — no Node pre-req on the target machine.
  # Matches MSI behavior (no air-gap "Node not found" freeze — see
  # 2026-08-23 user feedback). Source = <green>/node/ (sibling of install-agent.ps1)
  # when running from a green package; falls back to PATH-resolved node.exe's
  # directory when no bundled node was staged (e.g., a hand-built bundle).
  #
  # $nodeDst resolution: when src==dst (Windows case-collision; green-pkg
  # layout where start.ps1 set InstallPath = $PSScriptRoot/agent), the
  # bundled Node is at $PSScriptRoot/node (sibling of agent/, NOT inside
  # InstallPath). Using $InstallPath/node would resolve to agent/node
  # (non-existent) and npm install would fail the Test-Path guard below.
  # In that case, point $nodeDst at the bundled dir directly so PATH
  # prepend + npm.cmd invocation work without any copy. On non-case-
  # collides paths (dev tree, or any future layout where InstallPath and
  # AgentSrc are distinct), $nodeDst stays at $InstallPath/node and
  # robocopy refreshes from the bundled dir as before.
  #
  # The robocopy path keeps its Remove-Item guard (real install run on
  # KDLWXOFADSRV1 — round 3). Remove-Item was a self-wipe trap when src
  # and dst accidentally mapped to the same physical dir; with the new
  # $nodeDst redirect, src==dst never enters this branch, so Remove-Item
  # is only used in the true separate-dir (dev-tree) case where it is
  # safe.
  $bundledSrc = Join-Path $PSScriptRoot 'node'
  $nodeDst = if ($srcEqDst) { $bundledSrc } else { Join-Path $InstallPath 'node' }
  if ($srcEqDst) {
    Write-Step "src==dst; skipping Node refresh (bundled node already at $nodeDst)"
  } elseif (Test-Path $bundledSrc) {
    Write-Step "copying bundled Node.js from $bundledSrc to $nodeDst"
    if (Test-Path $nodeDst) { Remove-Item $nodeDst -Recurse -Force }
    robocopy $bundledSrc $nodeDst /MIR | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy node failed: $LASTEXITCODE" }
    $LASTEXITCODE = 0
    # Update $node to the install-path copy so NSSM launches the installed
    # node, not the source-tree one. Same resolution rule as start.ps1.
    $node = Join-Path $nodeDst 'node.exe'
  } else {
    # No bundled node — pre-flight above already resolved $node from PATH or
    # an existing install. Just note what we're using for the operator's log.
    Write-Step "no bundled node at <green>/node/; using $node"
  }

  # Always run `npm install --omit=dev` on the target machine to construct
  # node_modules. The canonical install path is always npm install — it
  # produces a production-only dependency tree regardless of what the source
  # contains. Operators reading the install log should see this step explicitly
  # so they know where the runtime deps come from.
  #
  # Invoke npm.cmd by absolute path (not bare `npm`): on real installs we
  # have seen "npm: not recognized" even when the bundled <node>/npm.cmd is
  # in PATH. The most reliable trigger is `& $nodeDst/npm.cmd ...` which
  # bypasses PowerShell's PATH resolution entirely. npm.cmd internally
  # resolves node.exe via %~dp0 (same dir), so ABI parity with NSSM's
  # $nodeDst/node.exe is guaranteed without depending on PATH at all.
  #
  # Prepend the bundled node dir to PATH as defense in depth — if npm.cmd
  # ever spawns a child that resolves `node` from PATH, it'll still find
  # the bundled one (avoids ABI drift if PATH has a different node.exe).
  #
  # Operator directive (2026-09-24): "我们需要在start.ps1 中构建node_modules"
  # — confirmed the install-time npm install path. (Earlier same-day
  # message asked for pre-built; this is the final ruling.)
  $env:PATH = $nodeDst + [IO.Path]::PathSeparator + $env:PATH
  $npmCmd = Join-Path $nodeDst 'npm.cmd'
  if (-not (Test-Path -LiteralPath $npmCmd)) {
    throw "npm.cmd not found at $npmCmd — bundled Node install is incomplete. Re-extract the green package's node/ directory."
  }
  Push-Location $InstallPath
  try {
    Write-Step "constructing node_modules via npm install --omit=dev"
    & $npmCmd install --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install failed: $LASTEXITCODE" }
  } finally { Pop-Location }

  # ---- 本 lineage 的 agent 运行期必需的外部模块 (实测, 不是猜的) ------------
  # 枚举方法 (可复跑): node Server\scripts\audit\check-agent-import-graph.mjs
  #   从 agent.js 出发做可达性遍历, 收集所有**非相对** import 说明符, 剔除
  #   node: 内置模块 ⇒ 得到"运行期真会被 import"的第三方模块。
  #   ADAgent/agent     -> better-sqlite3, pino
  #   MemberAgent/agent -> pino
  # 为什么不写一个跨 lineage 的公共集合: member 的 agent 根本不用
  # better-sqlite3 (member 的 src/local-queue.js 是 AD 采集线的死文件, 全树没人
  # import 它), 硬塞进去等于给非 AD 服务器凭空加一个原生模块依赖。
  # R160 实测: 两条 lineage 的 package.json 都曾经留着 axios / better-sqlite3
  # 这两条**陈旧声明** (member 那份是从 AD 复制过来的), 现已按实测集合清理:
  #   ADAgent/agent/package.json     -> better-sqlite3, pino
  #   MemberAgent/agent/package.json -> pino
  # 探针集合必须与 package.json 的声明**逐字一致**:
  #   声明里有、探针里没有 ⇒ 目标机上白装一个原生模块, 装不上就整次安装失败;
  #   探针里有、声明里没有 ⇒ 探针永远假失败, 把一次本来正常的安装挡在门外。
  # 审计器 Server\scripts\audit\check-green-package-drift.mjs 的 C10 强制这条一致。
  # 判据永远是"agent 会不会在启动第一秒 import 一个不存在的东西"。
  $RequiredRuntimeModules = @('better-sqlite3', 'pino')

  # ---- 装完必须复验: agent 的运行时依赖到底能不能被解析出来 ----------------
  # 旧实现"装完就算成功" ⇒ 依赖其实没装上时, 服务照样注册并启动, 然后在
  # 第一次 import 时炸掉。agent.js 是**静态** import:
  #   agent.js → src/local-queue.js → import Database from 'better-sqlite3'
  # 依赖缺失 ⇒ 进程在启动的第一秒就崩 ⇒ NSSM 拉起 → 再崩 (崩溃重启循环,
  # 正是 R121 / R123 / R124 那一族现场故障的形态)。
  # 判据: **能不能被 require 解析**, 而不是"有没有 node_modules 目录"
  # (npm workspaces / 提升安装会把依赖放到上级目录, 目录判据会永远误判)。
  #
  # 探针写成**临时 .cjs 文件**而不是 `node -e "<js>"`: Windows PowerShell
  # 5.1 传给原生命令的参数会把内层引号吃掉 (实测: 双引号被剥掉, 反引号被
  # 当转义符吃掉 ⇒ node 收到的是语法错误, 退出码 1 而不是 3) —— 于是
  # "依赖缺失"会被误报成"探针本身坏了"。写文件就没有任何命令行转义。
  # 探针用 require.resolve(m, { paths: [root] }) 从目标目录起解析, 这样
  # 提升安装(装在工作区根)的布局也能判对。
  $pkgJsonPath = Join-Path $InstallPath 'package.json'
  if (-not (Test-Path -LiteralPath $pkgJsonPath)) {
    throw ("no package.json under '$InstallPath' — `npm install` had nothing to install (it exits 0 in that " +
           "case!), so the agent would crash on its very first import. Ship agent\package.json + " +
           "agent\package-lock.json in the green package (or pre-seed node_modules on the target for " +
           "offline installs), then re-run.")
  }
  $probeFile = Join-Path ([System.IO.Path]::GetTempPath()) ("addashboard-agent-dep-probe-" + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.cjs')
  # 模块清单以 JSON 数组注入探针源码 (不用字符串拼接去构造 JS 字面量)。
  $probeModsJson = ConvertTo-Json -InputObject @($RequiredRuntimeModules) -Compress
  $probeJs = @'
const root = process.argv[2];
const mods = MODULES_PLACEHOLDER;
const missing = [];
for (const m of mods) {
  try { require.resolve(m, { paths: [root] }); }
  catch (e) { missing.push(m); }
}
if (missing.length) { console.error('MISSING:' + missing.join(',')); process.exit(3); }
console.log('DEPS-OK');
'@
  $probeJs = $probeJs.Replace('MODULES_PLACEHOLDER', $probeModsJson)
  try {
    [System.IO.File]::WriteAllText($probeFile, $probeJs, (New-Object System.Text.UTF8Encoding($false)))
    # Windows PowerShell 5.1 会把"原生命令往 stderr 写了一行"提升成
    # **终止性** NativeCommandError (在 $ErrorActionPreference='Stop' 下)。
    # 探针在"依赖缺失"这个**预期分支**里恰恰要往 stderr 写 MISSING:...
    # ⇒ 脚本会在拿到 $LASTEXITCODE 之前就被打断, 操作员只看到一坨
    # NativeCommandError, 而看不到下面那条"哪个依赖没装上、怎么修"的提示。
    # 所以这里临时把 EAP 降成 Continue, 用 $LASTEXITCODE 判结果。
    $prevEap = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      $depOutput = & $node $probeFile $InstallPath 2>&1
      $depExit = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $prevEap
    }
  } finally {
    if (Test-Path -LiteralPath $probeFile) { Remove-Item -LiteralPath $probeFile -Force -ErrorAction SilentlyContinue }
  }
  if ($null -eq $depExit) {
    # node 根本没跑起来 (路径不对 / 文件被占用 / 权限) ⇒ $LASTEXITCODE 是 $null。
    # 这跟"依赖缺失"是两回事, 提示必须分开写, 否则操作员会去查 node_modules,
    # 而真正的问题在 node 可执行文件本身。
    $depDetail = (($depOutput | ForEach-Object { if ($_ -is [string]) { $_ } else { $_.ToString() } }) -join ' ').Trim()
    throw ("the dependency probe could not run node (no exit code) — node path '$node' is not usable. " +
           "Probe output: $depDetail")
  }
  if ($depExit -ne 0) {
    $depDetail = (($depOutput | ForEach-Object { if ($_ -is [string]) { $_ } else { $_.ToString() } }) -join ' ').Trim()
    throw ("the agent's runtime dependencies are NOT resolvable under '$InstallPath' " +
           "(required: $($RequiredRuntimeModules -join ', '); node exit $depExit): $depDetail. " +
           "The agent imports these modules statically, so a missing one means the service crashes on its " +
           "first import and NSSM restart-loops it. Root cause is usually a missing package.json in the " +
           "shipped agent package — `npm install` with no package.json installs nothing and still exits 0. " +
           "Ship agent\package.json + agent\package-lock.json in the green package (or pre-seed node_modules " +
           "on the target for offline installs), then re-run.")
  }
  # 成功提示里列的模块必须与探针实际检查的**完全一致** (都来自
  # $RequiredRuntimeModules)。多列一个不存在的模块 ⇒ 操作员按提示去排查一个
  # 根本没装也没用的包, 越查越迷 (axios 就属于这种: 它只在
  # port-config-fetcher.js 的注释里出现过, 从来没有被 import; R160 已把两条
  # lineage 的 package.json 里的 axios 声明清掉)。
  Write-Step "agent runtime dependencies verified ($($RequiredRuntimeModules -join ' / ') resolvable)"

  # Delegate the SCM-facing steps to Register-ADDashboardAgent.ps1:
  #   - write appsettings.json (URL / token / agentType)
  #   - NSSM install + 12 parameter set
  #   - service recovery (NSSM AppExit + sc.exe failure)
  #   - Start-Service via NSSM-managed SCM
  # This is the same code path the MSI's ConfigureAgentAction calls (via its
  # own CA; the CA file is not refactored to call this PS1 yet — see project
  # backlog). The green package no longer diverges from the MSI on service
  # recovery because both go through the same logic.
  & (Join-Path $PSScriptRoot 'Register-ADDashboardAgent.ps1') `
      -InstallPath $InstallPath `
      -CenterUrl   $CenterUrl `
      -AgentToken  $AgentToken `
      -AgentType   $AgentType `
      -NodePath    $node
  if ($LASTEXITCODE -ne 0) { throw "Register-ADDashboardAgent.ps1 failed: $LASTEXITCODE" }

  Write-Ok "agent installed on $env:COMPUTERNAME"
}

foreach ($cn in $ComputerName) {
  if ($cn -eq $env:COMPUTERNAME -or $cn -eq 'localhost' -or $cn -eq '.') {
    Install-LocalAgent
  } else {
    Write-Step "remote install on $cn"
    $sess = New-PSSession -ComputerName $cn -ErrorAction Stop
    try {
      $block = [scriptblock]::Create((Get-Content -Raw (Join-Path $PSScriptRoot 'install-agent.ps1')))
      # Pass pre-resolved source paths so the remote scriptblock does not depend
      # on its own $PSScriptRoot (which is null inside Invoke-Command -ScriptBlock).
      Invoke-Command -Session $sess -ScriptBlock $block -ArgumentList @(@($cn), $CenterUrl, $AgentToken, $AgentType, $InstallPath, $AgentSrc, $PsScriptSrc) -ErrorAction Stop
    } finally { Remove-PSSession $sess }
  }
}