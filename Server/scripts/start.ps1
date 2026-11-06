# start.ps1 — unified install / hot-update entry for the AD Dashboard Agent
# (green-package path). This is the single operator-facing entry point;
# start.bat and upgrade-agent.ps1 have been folded into this file.
#
# Why this exists (mirrors center's upgrade-center.ps1):
#   Pre-2026-08-23, operators had to choose between install-agent.ps1 (first-time
#   only) and update-agent.ps1 (legacy hot-fix that ASSUMES the service exists).
#   Neither told you "this is the one to run" — easy to pick the wrong one and
#   either fail with "service not found" or re-apply config on an already-set
#   install. center has upgrade-center.ps1 as the single entry; this script
#   brings the agent path up to parity.
#
# Why .ps1 (not .bat):
#   The earlier start.bat → powershell.exe wrapper could freeze when the
#   user's console had non-interactive stdin (some RDP / WinRM / Task Scheduler
#   contexts): Read-Host would block waiting for input that never arrived,
#   and the .bat's CMD intermediate made it hard to tell whether the hang was
#   in CMD or PowerShell. Going direct (.ps1 from the user's PowerShell window)
#   preserves console attachment and surfaces any prompt immediately.
#
# Behavior:
#   - Get-Service ADReplicationAgent registered → HOT UPDATE:
#       stop service → copy new agent/* + scripts/collect-replication.ps1 →
#       npm install --omit=dev → start service. Always restart (per design).
#   - Not registered → FIRST-TIME INSTALL: if -CenterUrl / -AgentToken were
#     passed on the command line use them (automation / WinRM); otherwise
#     Read-Host prompts in the terminal. SecureString for the token so it
#     doesn't echo. Delegates the actual SCM-facing steps to
#     install-agent.ps1, which then converges on the single registration
#     entry point shared with uninstall-agent.ps1. No duplication.
#
# Detect "installed" via Get-Service ADReplicationAgent:
#   The service name is the single source of truth (both MSI and green package
#   register it under the same name). We don't trust file presence at
#   <InstallPath>\ alone because that could be a partial install from a crash
#   mid-way, or a leftover from an uninstalled-by-update flow.
#
# PowerShell 5.1 + pwsh 7+ compatible. No `??`, no ternary, no 3-arg Join-Path.
# [CmdletBinding()] default param values evaluate in parameter-binding scope
# where $PSScriptRoot is empty — defaults are resolved in the body instead.
[CmdletBinding()]
param(
  [string]$InstallPath,
  [string]$ComputerName,
  [string]$CenterUrl,
  [string]$AgentToken,
  [ValidateSet('ad','non-ad')]
  [string]$AgentType = 'ad'
)

# Set up error logging BEFORE any code that can throw. The trap fires on every
# terminating error below (and re-throws via `continue`), so install.log always
# contains a breadcrumb for the "started then stopped" case — the operator
# opens install.log and sees [ERROR] with the actual exception message.
# Without this, throws only reach the console + NSSM stderr capture, forcing
# operators to cross-reference two logs to find the root cause.
#
# InstallPath may not be passed yet — first-time install path. Fall back to
# $PSScriptRoot\Logs\ (sibling of start.ps1, writable on both green-pkg and
# dev-tree layouts) so even the early "agent/ source not found" throw gets
# captured. Re-set to <InstallPath>\Logs\ once $InstallPath is resolved.
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'common\Logger.psm1') -Force
# Test-SamePath: 路径等值判定 (大小写不敏感 + 忽略尾部分隔符)。内联的
# (Resolve-Path).ProviderPath + [string]::Equals(..., OrdinalIgnoreCase)
# 在路径末尾带 '\' 时会落空 (Resolve-Path 保留尾分隔符, 实测
# 'D:\pkg\scripts\' ≠ 'D:\pkg\scripts') ⇒ 同目录判定失效, Copy-Item 撞上
# "Cannot use the item itself to overwrite the item"。
Import-Module (Join-Path $PSScriptRoot 'common\Service.psm1') -Force

trap {
  if ($_.Exception) { Write-Err2 $_.Exception.Message }
  # 热更失败时的**服务恢复**。脚本在热更路径里把服务停掉 (Stop-Service), 之后
  # 还有 4 个可抛异常的落点 (拷代码 / robocopy node / 拷 collect 脚本 /
  # npm install), 中间**没有 try/finally** ⇒ 任意一处失败, trap 直接 break
  # 出去 ⇒ **服务永远停在 Stopped**, 生产 agent 直接下线, 而脚本只打印一行
  # 错误, 操作员根本不知道 agent 已经掉了。
  # 现在在 trap 里补一次"尽力把服务拉起来": 服务已存在且处于 Stopped 时尝试
  # Start-Service; 拉不起来就明确告诉操作员 agent 处于 DOWN 状态、需要人工
  # 介入。注意这**不吞错误** —— 下面的 break 依旧让退出码 = 1。
  try {
    if ($ServiceName) {
      $svcAfterFailure = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
      if ($svcAfterFailure -and $svcAfterFailure.Status -eq 'Stopped') {
        Write-Warn2 "failure recovery: $ServiceName was left Stopped by this run — attempting to start it"
        try {
          Start-Service -Name $ServiceName -ErrorAction Stop
          Write-Warn2 "$ServiceName start issued — VERIFY it is really running and that its code is intact (Get-Service $ServiceName | Select Status)"
        } catch {
          Write-Err2 "could not start $ServiceName ($($_.Exception.Message)) — the agent is DOWN and must be started manually"
        }
      }
    }
  } catch {
    Write-Warn2 "failure-recovery attempt itself failed: $($_.Exception.Message)"
  }
  # 旧实现是 `continue` —— 实测 (2026-10-25): trap 里 continue 会**吞掉**错误,
  # 脚本从 throw 之后继续往下跑, 最后 powershell.exe 退出码 = 0。操作员看到
  # "脚本跑完了" 就以为装好了, 实际服务根本没注册 (agent/ 找不到 / 凭据没填
  # / install-agent.ps1 失败, 全部被静默吞掉)。
  # `break` = 终止当前作用域并让错误继续向上传播 ⇒ 退出码 = 1, 调度器
  # (Task Scheduler / CI) 才能看到失败。日志仍然照写 (上面的 Write-Err2)。
  break
}

$initialLogDir = if ($InstallPath) {
  Join-Path $InstallPath 'Logs'
} else {
  Join-Path $PSScriptRoot 'Logs'
}
if (-not (Test-Path $initialLogDir)) {
  New-Item -ItemType Directory -Path $initialLogDir -Force | Out-Null
}
Set-LogDir $initialLogDir

if (-not $InstallPath) {
  # Layout-independent default:
  #   GREEN PACKAGE: agent/ is a sibling of start.ps1 → $InstallPath IS the
  #     agent/ directory. NSSM's AppDirectory + AppParameters='agent.js'
  #     contract (Register-ADDashboardAgent.ps1:184-185) requires
  #     $InstallPath/agent.js to be the literal entry file, which lives
  #     inside agent/, not at the agentInstall/ root. Picking $PSScriptRoot/
  #     Agent/ (capital A) used to be the default — on Windows case-
  #     insensitive FS that case-folds to the same agent/ dir, but
  #     $InstallPath/node then resolved to agent/node (non-existent); the
  #     bundled Node is at the sibling $PSScriptRoot/node.
  #   DEV TREE: agent/ is one level up at the repo root → $InstallPath is
  #     <repo>/Agent/ (separate dir on case-sensitive FS so source edits
  #     don't affect the running install). On Windows this case-collides
  #     with agent/ and is handled by the src==dst gate below.
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

# $InstallPath is now resolved (or an earlier throw left a breadcrumb in
# install.log via the trap above). Point LogDir at the canonical
# <InstallPath>\Logs\ so subsequent STEP / OK lines and any later throw
# land in the operator-expected location.
$Script:LogDir = Join-Path $InstallPath 'Logs'
if (-not (Test-Path $Script:LogDir)) {
  New-Item -ItemType Directory -Path $Script:LogDir -Force | Out-Null
}
Set-LogDir $Script:LogDir
# R119 — per-module log file for this entry (dual-writes into legacy
# <LogDir>/install.log via Logger.psm1::Write-Log). The early Set-LogDir
# above the $InstallPath resolution lands lines in the initial LogDir;
# from here on every Write-* lands in <LogDir>/APP/start.log so a
# operator's tail -f on the per-module dir sees only this script's stream.
Set-LogModule 'start'
# R119.B boot fingerprint — single line naming the running version + git
# commit so operators can prove which code is installed.
$mfst = Get-AgentManifest
$commit = if ($mfst -and $mfst.gitCommit) { $mfst.gitCommit } else { 'unknown' }
Write-Info ("{0} v{1} (commit={2})" -f $MyInvocation.MyCommand.Name, (Get-AgentVersion), $commit)

# Pre-flight: Node.js 20 LTS — green package bundles it at <green>/node/
# (see installer/build-green-package.ps1 step 4) so air-gapped targets don't
# need a separate Node install. Search order:
#   1. <green>/node/node.exe — bundled by build-green-package.ps1
#   2. <InstallPath>/node/node.exe — already-copied by a prior install/upgrade
#      (only valid on dev-tree layout where InstallPath is a separate dir
#      from the green-package root; on green-pkg InstallPath IS agent/ and
#      the bundled Node stays at $PSScriptRoot/node, not $InstallPath/node)
#   3. node.exe on PATH — operator-installed fallback (legacy, pre-bundling)
# If none found, fail fast BEFORE prompting for CenterUrl/AgentToken so the
# operator doesn't type creds only to discover Node is missing.
$bundledGreenNode = Join-Path $PSScriptRoot 'node\node.exe'
$bundledInstalledNode = Join-Path $InstallPath 'node\node.exe'
$nodeExe = $null
if (Test-Path -LiteralPath $bundledGreenNode) { $nodeExe = $bundledGreenNode }
elseif (Test-Path -LiteralPath $bundledInstalledNode) { $nodeExe = $bundledInstalledNode }
else {
  $nodeOnPath = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($nodeOnPath) { $nodeExe = $nodeOnPath.Source }
}
if (-not $nodeExe) {
  throw "node.exe not found. The green package SHOULD bundle Node.js 20 LTS at <green>\node\node.exe — verify the bundle layout. If you have a custom bundle without Node, install Node 20 LTS and add it to PATH. See installer/README-green-install.md."
}
Write-Step "using Node.js: $nodeExe"
# Surface major version warning (green package is pinned to Node 20 LTS).
$nodeMajor = (& $nodeExe --version 2>$null) -replace '^v(\d+)\..*','$1'
if ($nodeMajor -ne '20') {
  Write-Step "WARNING: node.exe reports major version $nodeMajor — green package expects 20 LTS. Continuing anyway; if npm install fails, install Node 20 LTS."
}

$ServiceName = 'ADReplicationAgent'
$installed = [bool](Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)

if (-not $installed) {
  # ----------------------------------------------------------------------
  # First-time install — prompt for missing values, then delegate.
  # ----------------------------------------------------------------------
  Write-Step "service not registered — first-time install ($InstallPath)"

  if (-not $CenterUrl) {
    $CenterUrl = Read-Host 'Enter CenterUrl (e.g., http://center.example.com:8080)'
    if (-not $CenterUrl) {
      throw 'CenterUrl is required for first-time install. Pass -CenterUrl ''http://...'' or run interactively.'
    }
  }

  if (-not $AgentToken) {
    # AsSecureString hides input on the console. Convert back to plain text
    # because the registration entry point writes appsettings.json with the
    # token in plain text — there's no value-add in keeping SecureString
    # across the process boundary when the on-disk format is plain text anyway.
    $secure = Read-Host -AsSecureString 'Enter AgentToken'
    if (-not $secure) {
      throw 'AgentToken is required for first-time install. Pass -AgentToken ''<token>'' or run interactively.'
    }
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
      $AgentToken = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    } finally {
      [void][System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
  }

  if (-not $ComputerName) {
    # Interactive first-time install on the local machine is the common case.
    # Operators upgrading multiple targets explicitly pass -ComputerName.
    $ComputerName = $env:COMPUTERNAME
  }

  Write-Step "delegating to install-agent.ps1 (ComputerName=$ComputerName, AgentType=$AgentType)"
  & (Join-Path $PSScriptRoot 'install-agent.ps1') `
      -ComputerName $ComputerName `
      -CenterUrl    $CenterUrl `
      -AgentToken   $AgentToken `
      -InstallPath  $InstallPath `
      -AgentType    $AgentType
  # $LASTEXITCODE 只能当**辅助信号** (实测 2026-10-25):
  #   - 只有**原生命令**会写它; 子脚本自己的 throw 根本不写它 (异常作为
  #     终止性错误冒泡, 由上面的 trap 兜住 ⇒ 退出码 1);
  #   - 子脚本内部跑过的 robocopy (退出码 1 = "有文件被复制" = 成功) 反而
  #     会污染它 ⇒ 可能把一次成功的安装判成失败。
  # 所以真正判成败的是"终态": 服务到底注册了没有。
  #
  # 旧实现在这里对 $LASTEXITCODE **抛异常** —— 而这恰恰是最不可靠的那条路:
  # install-agent.ps1 的**远程分支**在本机一次原生命令都没跑 (只有
  # New-PSSession / Invoke-Command), 所以父作用域的 $LASTEXITCODE 原封不动
  # 保留着**调用前**的值。操作员在同一个会话里先跑过任何退出码非 0 的原生命令
  # (robocopy→1 / npm→1 / git diff→1) ⇒ 远程安装明明成功, 这里却抛
  # "install-agent.ps1 reported a failure (exit 1)" ⇒ 退出码 1, 调度器判失败,
  # "first-time install complete" 那行永远打不出来。
  # 真正的失败路径是: 子脚本 throw → 终止性错误冒泡 → 本脚本的 trap → 退出码 1。
  # 所以这里降级为告警, 把否决权交给下面的终态验证。
  if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) {
    Write-Warn2 "install-agent.ps1 left \$LASTEXITCODE = $LASTEXITCODE — advisory only (it may be stale from an earlier native command; genuine failures surface as terminating errors and are caught by the trap). Verdict comes from the service-registration check below."
  }
  # 终态验证 —— 目标不是"脚本跑完了", 而是"服务注册了"。
  # 远程目标 (ComputerName 不是本机) 的服务注册在远端, 本机查不到, 跳过。
  $isLocalTarget = ($ComputerName -eq $env:COMPUTERNAME -or $ComputerName -eq 'localhost' -or $ComputerName -eq '.')
  if ($isLocalTarget) {
    $registeredNow = [bool](Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)
    if (-not $registeredNow) {
      throw "install-agent.ps1 returned but service '$ServiceName' is not registered — first-time install did not complete"
    }
  }
  Write-Ok "first-time install complete"
  return
}

# ----------------------------------------------------------------------
# Hot update — always restart per design (simplified contract).
# Hash-checking the diff to skip npm install when files match was considered
# but rejected: npm install is cheap enough that a "did anything change?"
# gate adds risk (stale package-lock.json from a partial install gets stuck)
# for negligible savings on a hot-update path that operators expect to actually
# update something. Always restart, always npm install, no surprises.
# ----------------------------------------------------------------------
Write-Step "service registered — hot update ($InstallPath)"

$svc = Get-Service -Name $ServiceName
if ($svc.Status -ne 'Stopped') {
  Write-Step "stopping $ServiceName"
  Stop-Service -Name $ServiceName -Force -ErrorAction Stop
  $stoppedCleanly = $false
  for ($i = 0; $i -lt 30; $i++) {
    if ((Get-Service -Name $ServiceName).Status -eq 'Stopped') { $stoppedCleanly = $true; break }
    Start-Sleep 1
  }
  # 旧实现循环跑完就静默继续 ⇒ 紧接着的 Copy-Item -Force 去覆盖一个**还在
  # 运行、文件被 node 进程占着**的服务目录 ⇒ 抛 "文件被另一进程占用", 或者
  # 更糟: 覆盖成功而进程仍跑着旧代码, 磁盘与内存不一致。必须当场拒绝。
  if (-not $stoppedCleanly) {
    throw "$ServiceName did not stop within 30s — refusing to overwrite a running service's files. Stop it manually (Stop-Service -Name '$ServiceName' -Force), wait for Stopped, then re-run."
  }
}

# Copy new agent code (exclude node_modules + tests + appsettings.json — node
# resolves at runtime via npm install; appsettings.json holds the live token
# + CenterUrl we just don't want to clobber).
# Layout-independent resolution (same logic as InstallPath default above):
$greenPkgAgent = Join-Path $PSScriptRoot 'agent'
$devTreeAgent  = Join-Path (Join-Path $PSScriptRoot '..') 'agent'
if (Test-Path $greenPkgAgent) {
  $agentSrc = $greenPkgAgent
} elseif (Test-Path $devTreeAgent) {
  $agentSrc = $devTreeAgent
} else {
  throw "agent/ source not found. Tried '$greenPkgAgent' (green-package layout) and '$devTreeAgent' (dev-tree layout)."
}
Write-Step "copying $agentSrc → $InstallPath"
# Detect Windows case-insensitive source/destination collision. The green
# package layout places source under <root>/agent and default install under
# <root>/Agent; on Windows those collapse to the same physical directory
# and Copy-Item refuses to overwrite files with themselves. Skip when src==dst.
# Save the boolean to $srcEqDst so the single-file collect-replication.ps1
# copy below can gate on the same condition.
$srcEqDst = Test-SamePath -PathA $agentSrc -PathB $InstallPath
if ($srcEqDst) {
  Write-Step "source and install path resolve to the same directory ($agentSrc); skipping code copy"
} else {
  Copy-Item -Path (Join-Path $agentSrc '*') -Destination $InstallPath -Recurse -Force `
    -Exclude 'node_modules','tests','appsettings.json','Logs'
}

# Refresh bundled Node.js if present in the green package. New green-package
# releases may pin a newer Node 20 patch; mirroring <green>/node/ → <InstallPath>/node/
# keeps the running node in sync. robocopy /MIR is idempotent on identical bytes.
# Variable name distinct from the pre-flight $bundledGreenNode (file) above —
# this is the directory, not the exe.
#
# $nodeDst resolution: when src==dst (Windows case-collision; green-pkg
# layout where InstallPath IS agent/), the bundled Node is at
# $PSScriptRoot/node (sibling of agent/, NOT inside InstallPath). Using
# $InstallPath/node would resolve to agent/node (non-existent) and
# npm install would fail the Test-Path guard below. In that case, point
# $nodeDst at the bundled dir directly so PATH prepend + npm.cmd
# invocation work without any copy. On non-case-collides paths (dev tree,
# or any future layout where InstallPath and agentSrc are distinct),
# $nodeDst stays at $InstallPath/node and robocopy refreshes from the
# bundled dir as before.
$bundledGreenNodeDir = Join-Path $PSScriptRoot 'node'
$nodeDst = if ($srcEqDst) { $bundledGreenNodeDir } else { Join-Path $InstallPath 'node' }
if ($srcEqDst) {
  Write-Step "src==dst; skipping Node refresh (bundled node already at $nodeDst)"
} elseif (Test-Path -LiteralPath (Join-Path $bundledGreenNodeDir 'node.exe')) {
  # robocopy /MIR 在源和目标是同一个目录时没有意义 (而且会报
  # "Source and destination cannot be the same")。判一下再刷。
  if (Test-SamePath -PathA $bundledGreenNodeDir -PathB $nodeDst) {
    Write-Step "bundled Node source and target are the same directory ($nodeDst); skipping the refresh"
  } else {
    Write-Step "refreshing bundled Node.js from $bundledGreenNodeDir to $nodeDst"
    robocopy $bundledGreenNodeDir $nodeDst /MIR | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy node failed: $LASTEXITCODE" }
    $LASTEXITCODE = 0
  }
}

# Copy latest collect-replication.ps1 to the runtime scripts\ dir. install-agent.ps1
# does this on first install too; doing it again here keeps the running service
# in sync after the upgrade. Skipped on Windows case-collision (src==dst)
# because the file is already in place; copy would fail with "Cannot use the
# item itself to overwrite the item".
$psScriptDstDir = Join-Path $InstallPath 'scripts'
if (-not (Test-Path $psScriptDstDir)) {
  New-Item -ItemType Directory -Path $psScriptDstDir -Force | Out-Null
}
if ($srcEqDst) {
  Write-Step "src==dst; skipping collect-replication.ps1 single-file copy (already in place)"
} else {
  Copy-Item -Path (Join-Path $agentSrc 'scripts\collect-replication.ps1') `
            -Destination $psScriptDstDir -Force
}

# Prepend the install-path node dir to PATH so npm install uses the same Node
# version NSSM launches. Without this, PATH's npm (could be a different
# version, or absent on air-gapped targets) would either rebuild node_modules
# against the wrong ABI or fail with "npm not recognized". Mirrors the same
# guard in install-agent.ps1's Install-LocalAgent.
$env:PATH = $nodeDst + [IO.Path]::PathSeparator + $env:PATH

# Invoke npm.cmd by absolute path (not bare `npm`): same fix as
# install-agent.ps1 — PowerShell's PATH resolution can miss npm.cmd even
# when the bundled node/ is prepended (real install on KDLWXOFADSRV1 hit
# "npm: not recognized"). & $nodeDst/npm.cmd bypasses PATH and uses the
# bundled node via %~dp0 inside npm.cmd. ABI parity with NSSM guaranteed.
$npmCmd = Join-Path $nodeDst 'npm.cmd'
if (-not (Test-Path -LiteralPath $npmCmd)) {
  # 没有捆绑 node 时, $nodeDst = <InstallPath>\node 不存在, 但 PATH 上那个
  # node 的目录里通常有 npm.cmd。旧实现直接抛, 于是"没捆绑 node"的机器
  # 永远更新不了 —— 现在退到 node.exe 所在目录。
  $nodeExeDir = Split-Path -Parent $nodeExe
  $fallbackNpm = Join-Path $nodeExeDir 'npm.cmd'
  if ($nodeExeDir -and (Test-Path -LiteralPath $fallbackNpm)) {
    $nodeDst = $nodeExeDir
    $npmCmd = $fallbackNpm
    Write-Step "no npm.cmd in the install-path node dir; using $npmCmd"
  } else {
    throw "npm.cmd not found at $npmCmd (nor next to $nodeExe) — the Node install is incomplete. Re-extract the green package's node/ directory, or install Node.js 20 LTS with npm."
  }
}

# npm install — production-only, no audit noise in CI logs. Must run in
# $InstallPath (where package.json lives), NOT in $nodeDst (the bundled
# Node dir has no package.json). src==dst on green-pkg means
# InstallPath = $PSScriptRoot/agent, which is the agent source dir —
# Push-Location there before npm install.
Push-Location $InstallPath
try {
  Write-Step "npm install --omit=dev"
  & $npmCmd install --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm install failed: $LASTEXITCODE" }
} finally { Pop-Location }

# 依赖**可解析性**复验 —— 光看 npm install 的退出码不够。
# agent.js 是静态 import: agent.js → src/local-queue.js →
#   import Database from 'better-sqlite3'
# 依赖缺失 ⇒ 进程在启动的第一秒就崩 ⇒ NSSM 拉起 → 再崩 (崩溃重启循环, 正是
# R121 / R123 / R124 那一族现场故障的形态)。而本仓库的 Server\agent\package.json
# **不存在** ⇒ npm workspaces 会静默跳过 agent 这个 workspace (实测 exit 0,
# 什么都不装) ⇒ 依赖其实一个都没装上, 而 npm 依然报成功。
# 少了这道复验, 脚本把服务拉起 → node 第一秒 ERR_MODULE_NOT_FOUND → 下面那个
# "started" 判定只在崩溃间隙读一次 SCM 状态, 极可能读到 'Running' ⇒ 脚本打印
# "started" 并 exit 0, 故障被完全掩盖。
# 探针模块集 = agent 源码里**实际**引用的外部依赖 (实测: better-sqlite3 +
# pino; axios 从来没有被任何 lineage 的 payload import 过 —— 它只在
# port-config-fetcher.js 的注释里出现过, 带上它只会造成假失败, R160 已把
# 两条 lineage 的 package.json 里的 axios 声明清掉)。
if (-not (Test-NodeDepsResolvable -InstallPath $InstallPath -Probe @('better-sqlite3', 'pino') -NodeExe $nodeExe)) {
  throw "agent runtime dependencies are NOT resolvable under '$InstallPath' (better-sqlite3 / pino). npm install exited 0 but the modules are missing — the agent would crash on its first import and NSSM would restart-loop. Check that <InstallPath>\package.json declares them (the agent workspace is silently skipped by npm when it has no package.json) and that they are installed for production."
}

# Restart service.
Write-Step "starting $ServiceName"
Start-Service -Name $ServiceName -ErrorAction Stop
$reachedRunning = $false
for ($i = 0; $i -lt 20; $i++) {
  $svcState = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($svcState -and $svcState.Status -eq 'Running') { $reachedRunning = $true; break }
  Start-Sleep 1
}
if (-not $reachedRunning) {
  throw "$ServiceName did not reach Running within 20s — see $(Join-Path $Script:LogDir 'install.log')"
}

# ---- 崩溃重启循环检测 (服务状态 ≠ 应用存活) ---------------------------------
# 上面那个循环只看 **服务状态**。而本服务是 NSSM 托管的:
#   AppExit = Default Restart, AppRestartDelay = 2000
# ⇒ 子进程 (node agent.js) 崩了, **NSSM 自己的进程仍然是 Running**, 它只是
# 把 node 再拉起来接着崩 (R121 现场: 10 分钟 13 次崩溃, 而服务状态一直是
# Running)。所以 "Status -eq 'Running'" 对崩溃重启循环**完全无效**: 脚本会
# 打印 "started" 并 exit 0, 故障被完全掩盖 —— 操作员以为装好了, 现场在刷日志。
#
# 真正的判据: **agent 的 node 子进程在观察窗口内是不是还活着 (PID 没变)**。
# NSSM 直接 spawn 应用 (nssm.exe -> node.exe), 所以可以用 Win32_Process 的
# ParentProcessId 从服务 PID 反查那个 node.exe。
# 实测 (PS 5.1, D:\temp\r160-nssm-child-detection-test.ps1): 子进程能被
# ParentProcessId 精确发现; 崩溃后 NSSM 重建的子进程 **PID 会变**; 子进程
# 死透则查不到 ⇒ "同一批 PID 在窗口之后仍然存在" 就是一个可靠的存活判据。
$agentStderrLog = Join-Path $Script:LogDir "$ServiceName-stderr.log"
$introspectionOk = $false
$allNodeProcs = @()
try {
  $allNodeProcs = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop)
  $introspectionOk = $true
} catch {
  Write-Info "process introspection unavailable ($($_.Exception.Message)) — the crash-restart check is skipped"
}

if ($introspectionOk) {
  # 服务进程 = nssm.exe (SCM 记录的那个)。应用进程 = 它的直接子进程。
  # 候选集合: 首选"服务进程的直接子进程" (权威判据); 只有在找不到直接子进程
  # 时才退到"命令行带 agent.js 且可执行文件路径等于 NSSM 记录的
  # Application"这个兜底 (NSSM 2.x 把 Application 写在
  # HKLM\SYSTEM\CurrentControlSet\Services\<svc>\Parameters\Application)。
  $appPath = $null
  try {
    $paramKey = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName\Parameters"
    $appPath = (Get-ItemProperty -Path $paramKey -Name 'Application' -ErrorAction SilentlyContinue).Application
  } catch { $appPath = $null }

  # 发现阶段: NSSM 把服务报成 Running 与应用进程真正 spawn 之间有几百毫秒
  # 的窗口 ⇒ 查不到就重试 (最多 5 次, 间隔 1s), 避免把"还没 spawn"误判成
  # "秒崩"。重试期间重新取进程表 —— 崩溃重启循环里的 node 每次 PID 都不同。
  $candidates = @{}
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    $candidates = @{}
    $svcProcId = 0
    try {
      $svcWin32 = Get-CimInstance Win32_Service -Filter "Name = '$ServiceName'" -ErrorAction SilentlyContinue
      if ($svcWin32) { $svcProcId = [int]$svcWin32.ProcessId }
    } catch { $svcProcId = 0 }
    if ($svcProcId -gt 0) {
      foreach ($c in @($allNodeProcs | Where-Object { [int]$_.ParentProcessId -eq $svcProcId })) {
        $candidates[[int]$c.ProcessId] = $true
      }
    }
    if ($candidates.Count -eq 0 -and $appPath) {
      foreach ($c in @($allNodeProcs | Where-Object {
        $_.CommandLine -and ($_.CommandLine -match 'agent\.js') -and $_.ExecutablePath -and ($_.ExecutablePath -ieq $appPath)
      })) {
        $candidates[[int]$c.ProcessId] = $true
      }
    }
    if ($candidates.Count -gt 0) { break }
    if ($attempt -lt 5) {
      Start-Sleep -Seconds 1
      try {
        $allNodeProcs = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop)
      } catch { break }
    }
  }

  $pids0 = @($candidates.Keys)
  if ($pids0.Count -eq 0) {
    throw ("the service '$ServiceName' is Running but no agent node process could be found " +
           "(service pid $svcProcId, NSSM Application '$appPath'). NSSM's AppExit=Default Restart keeps the " +
           "SERVICE 'Running' while the app crash-loops, so the service state alone proves nothing. " +
           "Check the agent's stderr log: $agentStderrLog")
  }
  # 观察窗口必须盖过 NSSM 的 AppRestartDelay (2000ms) 的至少一个完整重启
  # 周期, 否则重建动作还没发生, 看不出 PID 变了。
  Start-Sleep -Seconds 5
  $alivePids = @()
  foreach ($p in $pids0) {
    if (Get-Process -Id $p -ErrorAction SilentlyContinue) { $alivePids += $p }
  }
  if ($alivePids.Count -lt $pids0.Count) {
    $deadPids = @($pids0 | Where-Object { $alivePids -notcontains $_ })
    throw ("the agent process died within 5s of the service start (pid(s) $($deadPids -join ',') are gone; " +
           "NSSM restarted the app — this is a crash-restart loop). NSSM's AppExit=Default Restart keeps the " +
           "SERVICE 'Running' while the app crash-loops, so the service state alone proves nothing. " +
           "Check the agent's stderr log: $agentStderrLog")
  }
  Write-Ok "$ServiceName started; agent process (pid $($pids0 -join ',')) survived the 5s stabilization window"
} else {
  Write-Ok "$ServiceName started (process introspection unavailable — the crash-restart check was skipped)"
}