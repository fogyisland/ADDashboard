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
  [string]$PsScriptSrc,
  # 远程安装时**目标机**上的安装目录。留空 = 与本机 $InstallPath 同路径
  # (机群统一布局的常见做法: 每台 DC 都装到同一个盘符/目录)。
  # 远端分支会把它传给目标机上那份暂存的 install-agent.ps1。
  [string]$RemoteInstallPath
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
  # 判据 = 目录里有 agent.js, 不是"目录存在"。
  # NSSM 的启动契约 (Register-ADDashboardAgent.ps1): AppDirectory=<InstallPath>
  # + AppParameters='agent.js' ⇒ agent.js 必须在**安装目录根**。只判目录存在
  # 会把一个空的 / 半成品的 agent\ 目录当成有效源码 ⇒ 装出一个起不来的服务
  # (而且报错点在服务启动时, 离根因很远)。
  if (Test-Path -LiteralPath (Join-Path $greenPkgAgent 'agent.js')) {
    $InstallPath = $greenPkgAgent
  } elseif (Test-Path -LiteralPath (Join-Path $devTreeAgent 'agent.js')) {
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
# Test-SamePath / ConvertTo-ComparablePath —— 路径等值判定 (大小写不敏感 +
# 忽略尾部分隔符)。**不要**用内联的 (Resolve-Path).ProviderPath +
# [string]::Equals(..., OrdinalIgnoreCase): Resolve-Path **保留**尾部分隔符
# (实测 'D:\pkg\scripts\' ≠ 'D:\pkg\scripts'), 操作员在路径末尾多打一个
# '\' 就会让"防误删 / 防自拷贝"的守卫直接落空 —— 2026-10-25 center 版那场
# 事故的同款缺口。
Import-Module (Join-Path $PSScriptRoot 'common\Service.psm1') -Force
# Service.psm1 的 Start-ServiceSafe / Remove-ServiceSafe 依赖 NSSM.psm1 的
# Get-NssmPath —— 一起导入, 免得调用时才炸 "Get-NssmPath 不是可识别的命令"。
Import-Module (Join-Path $PSScriptRoot 'common\NSSM.psm1') -Force
# Push LogDir into Logger.psm1's module-scoped $Script:LogDir (Write-Step /
# Write-Ok etc. can't see the caller's variable directly).
$Script:LogDir = Join-Path $InstallPath 'Logs'
if (-not (Test-Path $Script:LogDir)) { New-Item -ItemType Directory -Path $Script:LogDir -Force | Out-Null }
# R119 — per-module/per-route server-side log directory. The agent's
# Logger.psm1 (Set-LogModule) writes rotated files into <LogDir>/APP/
# (one file per PS module name). Mkdir here so the first write after a
# fresh install doesn't EACCES on a non-existent parent. Logger.psm1
# also mkdirs on demand as a second line of defence.
$Script:AppLogDir = Join-Path $Script:LogDir 'APP'
if (-not (Test-Path $Script:AppLogDir)) { New-Item -ItemType Directory -Path $Script:AppLogDir -Force | Out-Null }
Set-LogDir $Script:LogDir
# R119 — pick this script's per-module log file under <LogDir>/APP/install-agent.log
# (dual-writes into the legacy <LogDir>/install.log via Logger.psm1::Write-Log).
Set-LogModule 'install-agent'
# R119.B boot fingerprint — single line naming the running version + git commit so
# operators can prove which code is installed without a separate file lookup.
$mfst = Get-AgentManifest
$commit = if ($mfst -and $mfst.gitCommit) { $mfst.gitCommit } else { 'unknown' }
Write-Info ("{0} v{1} (commit={2})" -f $MyInvocation.MyCommand.Name, (Get-AgentVersion), $commit)

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
  # 同上: 判据是 agent.js 在不在, 不是目录在不在。
  if (Test-Path -LiteralPath (Join-Path $greenPkgAgent 'agent.js')) {
    $AgentSrc = $greenPkgAgent
  } elseif (Test-Path -LiteralPath (Join-Path $devTreeAgent 'agent.js')) {
    $AgentSrc = $devTreeAgent
  } else {
    throw "agent/ source not found. Tried '$greenPkgAgent' (green-package layout) and '$devTreeAgent' (dev-tree layout). Verify the bundle layout — agentInstall/ expects agent/, common/, nssm/ as siblings."
  }
}
if (-not $PsScriptSrc) { $PsScriptSrc = Join-Path $AgentSrc 'scripts\collect-replication.ps1' }
# 采集脚本必须在。agent 的 appsettings.json 里 psScriptPath 指向
# <InstallPath>\scripts\collect-replication.ps1 —— 缺了它, 服务能注册、能启动,
# 但一次采集都跑不了 (而且要等到第一次采集任务才暴露)。
# 旧实现直接 Copy-Item 一个可能不存在的路径 ⇒ 抛 "Cannot find path", 报错
# 完全不指向"源码树不完整"这个真正的根因。
if (-not (Test-Path -LiteralPath $PsScriptSrc)) {
  throw "collect-replication.ps1 not found at '$PsScriptSrc' — the agent's appsettings.json points psScriptPath at <InstallPath>\scripts\collect-replication.ps1, so a missing collector means a silently broken agent. Check the source layout: agent\scripts\collect-replication.ps1 must exist in the bundle being installed."
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
$bundledGreenNodeSibling = Join-Path (Join-Path $PSScriptRoot '..') 'node\node.exe'
$bundledInstalledNode = Join-Path $InstallPath 'node\node.exe'
$node = $null
# 候选位置必须同时覆盖 **脚本同级** 和 **上一级**:
#   - 绿包: 脚本在 <green>\agentInstall\ 下, 捆绑 node 在 <green>\node\ (上一级)
#   - dev tree: 脚本在 <Server>\scripts\ 下, 捆绑 node 在 <Server>\node\ (上一级)
# 旧实现只看脚本同级 (Join-Path $PSScriptRoot 'node'), 在这两种布局下都找不到
# 捆绑 node ⇒ 静默退到 PATH 上的 node ⇒ "绿包自带 Node" 这个卖点被丢掉, 目标机
# 没装 Node 就直接装不了, 而日志里看不出任何异常。
foreach ($nodeCandidate in @($bundledGreenNode, $bundledGreenNodeSibling, $bundledInstalledNode)) {
  if (Test-Path -LiteralPath $nodeCandidate) { $node = $nodeCandidate; break }
}
if (-not $node) {
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
  # 判据用 Test-SamePath (大小写不敏感 + 忽略尾部分隔符)。旧实现的内联比较
  # 在路径末尾带 '\' 时会落空 (Resolve-Path 保留尾分隔符) ⇒ 明明是同一个
  # 目录却走进 Copy-Item 分支, 撞上 "Cannot use the item itself to overwrite
  # the item"。Windows 上 <root>\agent 与 <root>\Agent 是同一个物理目录,
  # 大小写折叠必须算数。
  $srcEqDst = Test-SamePath -PathA $AgentSrc -PathB $InstallPath
  if ($srcEqDst) {
    Write-Step "source and install path resolve to the same directory ($AgentSrc); skipping code copy (agent code already in place)"
  } else {
    Copy-Item -Path (Join-Path $AgentSrc '*') -Destination $InstallPath -Recurse -Force -Exclude 'node_modules','tests','appsettings.json','Logs'
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
  # 捆绑 node 的源目录: 脚本同级 与 上一级 都要看 (理由同上面的 pre-flight)。
  # 判据是"目录里真的有 npm.cmd", 不是"目录存在" —— 绿包里的 node/ 可能只带了
  # corepack (没有 node.exe / npm.cmd), 照拷过去只会在下面的 npm.cmd 检查上炸,
  # 而失败点离真正的根因 (绿包 node/ 不完整) 隔了上百行。
  $bundledSrc = $null
  foreach ($bundledCandidate in @(
      (Join-Path $PSScriptRoot 'node'),
      (Join-Path (Join-Path $PSScriptRoot '..') 'node'))) {
    if (Test-Path -LiteralPath (Join-Path $bundledCandidate 'npm.cmd')) { $bundledSrc = $bundledCandidate; break }
  }
  # src==dst 时 $nodeDst 直接指向捆绑目录 (不拷贝), 但**必须先确认那里真的有
  # npm.cmd** —— 旧实现无条件把 $nodeDst 设成 $PSScriptRoot\node, 而那个目录在
  # dev tree (Server\scripts\node) 与绿包里都可能根本不存在 ⇒ 必然在下面的
  # npm.cmd 检查上抛 "npm.cmd not found at ...", 把"没捆绑 node"报成
  # "Node 安装不完整", 现场完全对不上。实测本仓库就是这条路径:
  #   Server\agent\agent.js 存在 ⇒ InstallPath = Server\Agent
  #   Test-SamePath(Server\agent, Server\Agent) = True (Windows 大小写折叠)
  #   ⇒ srcEqDst = True ⇒ 旧实现把 $nodeDst 指向 Server\scripts\node (不存在)
  #   ⇒ 必然在 npm.cmd 检查处抛异常, 脚本装不下去。
  $nodeDst = if ($srcEqDst -and $bundledSrc) { $bundledSrc } else { Join-Path $InstallPath 'node' }
  if ($srcEqDst -and $bundledSrc) {
    $bundledNodeExe = Join-Path $nodeDst 'node.exe'
    if (Test-Path -LiteralPath $bundledNodeExe) { $node = $bundledNodeExe }
    Write-Step "src==dst; skipping Node refresh (bundled node already at $nodeDst)"
  } elseif ($bundledSrc) {
    # 防自毁: 目标目录不能是源目录本身, 也不能在源目录**里面**。
    # 旧实现无条件 `Remove-Item $nodeDst -Recurse -Force` 然后 robocopy /MIR ——
    # 一旦 $nodeDst 与 $bundledSrc 指向同一个物理目录 (Windows 大小写不敏感
    # + 尾分隔符差异, 例如 <green>\node 与 <green>\Node\), 这一行就把**源**
    # 删了, 紧接着的 robocopy 复制的是一片空白 ⇒ 目标机上没有 node.exe,
    # 而失败点在几千行之外的 npm 步骤上, 现场完全对不上。
    if (Test-SamePath -PathA $nodeDst -PathB $bundledSrc) {
      Write-Step "bundled Node source and target are the same directory ($nodeDst); skipping the refresh copy"
      $node = Join-Path $nodeDst 'node.exe'
    } else {
      Write-Step "copying bundled Node.js from $bundledSrc to $nodeDst"
      if (Test-Path -LiteralPath $nodeDst) { Remove-Item -LiteralPath $nodeDst -Recurse -Force }
      robocopy $bundledSrc $nodeDst /MIR | Out-Null
      if ($LASTEXITCODE -ge 8) { throw "robocopy node failed: $LASTEXITCODE" }
      $LASTEXITCODE = 0
      # Update $node to the install-path copy so NSSM launches the installed
      # node, not the source-tree one. Same resolution rule as start.ps1.
      $node = Join-Path $nodeDst 'node.exe'
    }
  } else {
    # 没有捆绑 node: 用 PATH 上那个 node 所在目录 (npm.cmd 与 node.exe 同目录)。
    # 旧实现这里只打一行日志就往下走, 然后
    #   $npmCmd = Join-Path $nodeDst 'npm.cmd'   ($nodeDst = <InstallPath>\node,
    #   根本不存在) ⇒ 必然 throw "npm.cmd not found at ..."。
    # 也就是说"没有捆绑 node"这条分支**从来没跑通过** —— 现在补上。
    $nodeDir = Split-Path -Parent $node
    if (-not $nodeDir) {
      throw "cannot determine the directory of node.exe ($node) — install Node.js 20 LTS, or ship the green package's node/ directory"
    }
    $nodeDst = $nodeDir
    Write-Step "no bundled node at <green>/node/; using $node (npm from $nodeDir)"
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
    throw "npm.cmd not found at $npmCmd — the Node install in '$nodeDst' is incomplete. Re-extract the green package's node/ directory, or install Node.js 20 LTS so that npm.cmd sits next to node.exe."
  }
  Push-Location $InstallPath
  try {
    Write-Step "constructing node_modules via npm install --omit=dev"
    & $npmCmd install --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install failed: $LASTEXITCODE" }
  } finally { Pop-Location }

  # ---- 装完必须复验: agent 的运行时依赖到底能不能被解析出来 ----------------
  # 旧实现"装完就算成功" ⇒ 依赖其实没装上时, 服务照样注册并启动, 然后在
  # 第一次 import 时炸掉。agent.js 是**静态** import:
  #   agent.js → src/local-queue.js → import Database from 'better-sqlite3'
  # 依赖缺失 ⇒ 进程在启动的第一秒就崩 ⇒ NSSM 拉起 → 再崩 (崩溃重启循环,
  # 正是 R121 / R123 / R124 那一族现场故障的形态)。
  # 判据与中心端一致 (Service.psm1::Test-NodeDepsResolvable): **能不能被
  # require 解析**, 而不是"有没有 node_modules 目录" (npm workspaces 会把
  # 依赖提升到工作区根, 目录判据在那种布局下永远误判)。
  #
  # 探针写成**临时 .cjs 文件**而不是 `node -e "<js>"`: Windows PowerShell
  # 5.1 传给原生命令的参数会把内层引号吃掉 (实测: 双引号被剥掉, 反引号被
  # 当转义符吃掉 ⇒ node 收到的是语法错误, 退出码 1 而不是 3) —— 于是
  # "依赖缺失"会被误报成"探针本身坏了"。写文件就没有任何命令行转义。
  # 探针用 require.resolve(m, { paths: [root] }) 从目标目录起解析, 这样
  # 提升安装(装在工作区根)的布局也能判对。
  $probeFile = Join-Path ([System.IO.Path]::GetTempPath()) ("addashboard-agent-dep-probe-" + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.cjs')
  $probeJs = @'
const root = process.argv[2];
const mods = ['better-sqlite3', 'pino'];
const missing = [];
for (const m of mods) {
  try { require.resolve(m, { paths: [root] }); }
  catch (e) { missing.push(m); }
}
if (missing.length) { console.error('MISSING:' + missing.join(',')); process.exit(3); }
console.log('DEPS-OK');
'@
  try {
    [System.IO.File]::WriteAllText($probeFile, $probeJs, (New-Object System.Text.UTF8Encoding($false)))
    # Windows PowerShell 5.1 会把"原生命令往 stderr 写了一行"提升成
    # **终止性** NativeCommandError (在 $ErrorActionPreference='Stop' 下)。
    # 探针在"依赖缺失"这个**预期分支**里恰恰要往 stderr 写 MISSING:...
    # ⇒ 脚本会在拿到 $LASTEXITCODE 之前就被打断, 操作员只看到一坨
    # NativeCommandError, 而看不到下面那条"哪个依赖没装上、怎么修"的提示。
    # 所以这里临时把 EAP 降成 Continue, 用 $LASTEXITCODE 判结果
    # (与 scripts/prepare-release.ps1 里 Invoke-StepScript 同一个套路)。
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
    throw ("the agent's runtime dependencies are NOT resolvable under '$InstallPath' (node exit $depExit): $depDetail. " +
           "agent.js statically imports better-sqlite3 (src/local-queue.js), so the service would crash-loop on startup. " +
           "Root cause is usually a missing package.json in the shipped agent package — `npm install` with no package.json " +
           "installs nothing and still exits 0. Ship agent\package.json + agent\package-lock.json in the green package " +
           "(or pre-seed node_modules on the target for offline installs), then re-run.")
  }
  # 模块清单必须与上面的探针**逐字一致** (const mods = ['better-sqlite3', 'pino'])。
  # 旧实现这里写的是 "better-sqlite3 / axios / pino" —— axios 从来没有被任何
  # lineage 的 payload import 过 (实测枚举 agent/src + agent.js 的裸 import:
  # 只有 better-sqlite3 / pino 是外部依赖, 其余全是 node:* 内置; axios 只在
  # port-config-fetcher.js 的注释里出现过)。R160 已把两条 lineage 的
  # package.json 里的 axios 声明清掉。
  # 成功提示里多列一个不存在的模块 ⇒ 操作员按提示去排查 axios, 越查越迷。
  Write-Step "agent runtime dependencies verified (better-sqlite3 / pino resolvable)"

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

# ---------------------------------------------------------------------------
# 远程安装 (WinRM)
#
# 旧实现:
#   $block = [scriptblock]::Create((Get-Content -Raw (Join-Path $PSScriptRoot 'install-agent.ps1')))
#   Invoke-Command -Session $sess -ScriptBlock $block -ArgumentList @(@($cn), ...)
#
# 四个致命问题 (2026-10-25 实测):
#   1. 远端 scriptblock 里 $PSScriptRoot 是**空的** (实测: Invoke-Command
#      -ScriptBlock 内 $PSScriptRoot = "") ⇒ 脚本体里
#      `Import-Module (Join-Path $PSScriptRoot 'common\Logger.psm1')` 直接抛
#      "无法将自变量绑定到参数 'Path'，因为它是空字符串"
#      ⇒ **远程安装 100% 失败**, 而且报错完全指不到根因。
#   2. 目标机上根本没有 common\ / agent\ / node\ / nssm\。即使 1 修好,
#      随后的 Import-Module / Copy-Item 也全部找不到文件。
#   3. 传给远端的 $AgentSrc 是**本机**路径 (D:\ToolDevelop\...\agent),
#      在目标机上不存在 ⇒ 代码拷贝必然失败。
#   4. 远端拿到的 ComputerName 是 @($cn) —— 如果操作员是用 IP 连的,
#      远端看到的 $env:COMPUTERNAME 与 $cn 不相等 ⇒ 远端会拿同一个 IP 再连
#      自己 ⇒ 无限递归。
#
# 现在的做法: 把安装链需要的东西**暂存**到目标机, 然后以**脚本文件**
# (不是 scriptblock) 的方式调用那份暂存脚本。这样远端脚本里的 $PSScriptRoot
# 就是暂存目录, common\Logger.psm1 / agent\ / node\ / nssm\ 全部按相对路径
# 解析得通; 而且安装逻辑仍然只有一份 (Install-LocalAgent) —— 本地和远程
# 走同一条代码路径, 不会有两份实现漂移。
# ---------------------------------------------------------------------------
function Resolve-PackageDir {
  param([Parameter(Mandatory)][string]$Name)
  $candidates = @(
    (Join-Path $PSScriptRoot $Name),
    (Join-Path (Join-Path $PSScriptRoot '..') $Name)
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return (Resolve-Path -LiteralPath $candidate).Path }
  }
  return $null
}

function Install-RemoteAgent {
  param(
    [Parameter(Mandatory)]$Session,
    [Parameter(Mandatory)][string]$Target
  )
  $stageName = 'ADDashboard-agentInstall-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
  $remoteStage = Join-Path ([System.IO.Path]::GetTempPath()) $stageName
  Write-Step "staging the install bundle to $Target ($remoteStage)"

  # 1) 远端建暂存目录
  Invoke-Command -Session $Session -ScriptBlock {
    param($StagePath)
    if (Test-Path -LiteralPath $StagePath) {
      Remove-Item -LiteralPath $StagePath -Recurse -Force
    }
    foreach ($sub in @('', 'common', 'agent', 'node', 'nssm')) {
      $dir = if ($sub) { Join-Path $StagePath $sub } else { $StagePath }
      New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
  } -ArgumentList $remoteStage

  # 2) 本脚本 + Register 入口 + common\ 模块
  Copy-Item -ToSession $Session -LiteralPath (Join-Path $PSScriptRoot 'install-agent.ps1') -Destination $remoteStage -Force
  Copy-Item -ToSession $Session -LiteralPath (Join-Path $PSScriptRoot 'Register-ADDashboardAgent.ps1') -Destination $remoteStage -Force
  $commonDir = Join-Path $PSScriptRoot 'common'
  if (Test-Path -LiteralPath $commonDir) {
    Get-ChildItem -LiteralPath $commonDir -File -Force | ForEach-Object {
      Copy-Item -ToSession $Session -LiteralPath $_.FullName -Destination (Join-Path $remoteStage 'common') -Force
    }
  }

  # 3) agent 源码 (逐项拷, 跳过运行期/本机专属的东西)
  $skipTop = @('node_modules', 'tests', 'Logs', 'appsettings.json')
  foreach ($item in (Get-ChildItem -LiteralPath $AgentSrc -Force)) {
    if ($skipTop -contains $item.Name) { continue }
    Copy-Item -ToSession $Session -LiteralPath $item.FullName -Destination (Join-Path $remoteStage 'agent') -Recurse -Force
  }

  # 4) 捆绑 node + nssm (没有就靠目标机自带的)
  $pkgNode = Resolve-PackageDir -Name 'node'
  if ($pkgNode) {
    Write-Step "staging bundled Node.js from $pkgNode"
    Copy-Item -ToSession $Session -Path (Join-Path $pkgNode '*') -Destination (Join-Path $remoteStage 'node') -Recurse -Force
  } else {
    Write-Warn2 "no bundled node/ directory found next to the scripts — the target must have Node.js 20 LTS on PATH"
  }
  $pkgNssm = Resolve-PackageDir -Name 'nssm'
  if ($pkgNssm) {
    Copy-Item -ToSession $Session -Path (Join-Path $pkgNssm '*') -Destination (Join-Path $remoteStage 'nssm') -Recurse -Force
  } else {
    Write-Warn2 "no nssm/ directory found next to the scripts — the target must have NSSM installed"
  }

  # 5) 在目标机上跑那份暂存脚本 (传目标机自己的计算机名 ⇒ 走本地分支,
  #    不会在远端再发起一次远程连接)
  $remoteInstallPath = if ($RemoteInstallPath) { $RemoteInstallPath } else { $InstallPath }
  $remoteComputer = Invoke-Command -Session $Session -ScriptBlock { $env:COMPUTERNAME }
  Write-Step "running the staged installer on $remoteComputer (install path: $remoteInstallPath)"
  Invoke-Command -Session $Session -ScriptBlock {
    param($StagePath, $InstallPathOnTarget, $Url, $Token, $Type, $Me)
    & (Join-Path $StagePath 'install-agent.ps1') `
        -ComputerName @($Me) `
        -CenterUrl    $Url `
        -AgentToken   $Token `
        -AgentType    $Type `
        -InstallPath  $InstallPathOnTarget `
        -AgentSrc     (Join-Path $StagePath 'agent')
  } -ArgumentList $remoteStage, $remoteInstallPath, $CenterUrl, $AgentToken, $AgentType, $remoteComputer

  # 6) 清理暂存目录 (best-effort — 清理失败不影响安装结果)
  try {
    Invoke-Command -Session $Session -ScriptBlock {
      param($StagePath)
      if (Test-Path -LiteralPath $StagePath) { Remove-Item -LiteralPath $StagePath -Recurse -Force }
    } -ArgumentList $remoteStage
  } catch {
    Write-Warn2 "could not clean up the remote staging dir $remoteStage : $($_.Exception.Message)"
  }
  Write-Ok "remote install finished on $Target"
}

foreach ($cn in $ComputerName) {
  if ($cn -eq $env:COMPUTERNAME -or $cn -eq 'localhost' -or $cn -eq '.') {
    Install-LocalAgent
    continue
  }
  Write-Step "remote install on $cn"
  $sess = New-PSSession -ComputerName $cn -ErrorAction Stop
  try {
    Install-RemoteAgent -Session $sess -Target $cn
  } finally { Remove-PSSession $sess }
}