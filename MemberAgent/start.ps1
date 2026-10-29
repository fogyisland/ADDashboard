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
#   - Get-Service memberServiceAgent registered → HOT UPDATE:
#       stop service → copy new agent/* + scripts/collect.ps1 →
#       npm install --omit=dev → start service. Always restart (per design).
#   - Not registered → FIRST-TIME INSTALL: if -CenterUrl / -AgentToken were
#     passed on the command line use them (automation / WinRM); otherwise
#     Read-Host prompts in the terminal. SecureString for the token so it
#     doesn't echo. Delegates the actual SCM-facing steps to
#     install-agent.ps1, which then converges on the single registration
#     entry point shared with uninstall-agent.ps1. No duplication.
#
# Detect "installed" via Get-Service memberServiceAgent:
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
  # R161.23 (2026-10-29): the default used to be 'ad' — a verbatim copy of
  # the AD/DC bundle's install chain. The MemberAgent bundle IS the non-AD
  # lineage (service memberServiceAgent, collector scripts\collect.ps1), so
  # omitting -AgentType must NOT produce an AD/DC-flavoured install.
  [ValidateSet('ad','non-ad')]
  [string]$AgentType = 'non-ad'
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
Import-Module (Join-Path $PSScriptRoot 'common\Version.psm1') -Force

# 2026-10-02 R0.1.1+ — single version source. Read from version.inf at the
# project root (sibling of this script). Missing file = fail loud so a
# truncated green package is caught before the operator types creds.
$ReleaseVersion = Get-ComponentVersion -Component 'version'
if (-not $ReleaseVersion) {
  throw "version.inf missing or [components] version key unset at $(Join-Path $PSScriptRoot 'version.inf'). Verify the green package is complete."
}

trap {
  if ($_.Exception) { Write-Err2 $_.Exception.Message }
  continue
}

$initialLogDir = if ($InstallPath) {
  Join-Path $InstallPath 'Logs'
} else {
  Join-Path $PSScriptRoot 'Logs'
}
# 2026-10-02 — stop pre-creating an empty Logs\ directory on first run.
# Operators used to wonder why a blank Logs\ showed up before any work
# happened. Logger.psm1's Set-LogDir just records the path; actual files
# land there only when Write-Step / Write-Ok first run. If the path
# doesn't exist at that point, Add-Content surfaces a clear error instead
# of a silent half-empty tree.
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
# 2026-10-02 — same rationale as the initialLogDir block above: no longer
# mkdir an empty Logs\ up front. The directory appears on disk the first
# time a STEP/OK/Write-Err line lands, which is the first moment it has
# anything useful to hold.
Set-LogDir $Script:LogDir

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
Write-Step "release version: $ReleaseVersion"
Write-Step "using Node.js: $nodeExe"
# Surface major version warning (green package is pinned to Node 20 LTS).
$nodeMajor = (& $nodeExe --version 2>$null) -replace '^v(\d+)\..*','$1'
if ($nodeMajor -ne '20') {
  Write-Step "WARNING: node.exe reports major version $nodeMajor — green package expects 20 LTS. Continuing anyway; if npm install fails, install Node 20 LTS."
}

$ServiceName = 'memberServiceAgent'
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
  if ($LASTEXITCODE -ne 0) { throw "install-agent.ps1 failed: $LASTEXITCODE" }
  # 2026-10-02 R0.1.1+ — schema migration. Register-ADDashboardAgent.ps1
  # already wrote a full appsettings.json for new installs, but re-run the
  # migration as a no-op safety net (only fills missing keys, never
  # overwrites existing values) so a hand-edited appsettings.json or a
  # partial install doesn't leave the new schema gaps unbackfilled.
  Apply-AppsettingsSchemaMigration -InstallPath $InstallPath
  Write-Ok "first-time install complete"
  return
}

# ============================================================================
# Apply-AppsettingsSchemaMigration — backfill schema gaps on upgrade.
#
# 2026-10-02 R0.1.1+ — first introduced for the dashboard integration
# (username / password / port / dashboardEnabled). Each schema-version bump
# adds an `if ($missing -contains '<key>') { $cfg.<key> = <default> }` block
# below; never overwrites operator-set values. Runs on both first-install
# (post-install-agent.ps1, no-op since Register-ADDashboardAgent.ps1 already
# wrote the full shape) and hot-update (backfills pre-0.1.1 installs so the
# next agent boot sees a complete appsettings.json).
#
# Atomic write via tmp + rename. UTF-8 no-BOM — Node JSON.parse rejects BOM.
# If no migration is needed (file already has all known keys), does nothing
# and returns 0 — safe to call every run.
# ============================================================================
function Apply-AppsettingsSchemaMigration {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$InstallPath)

  $jsonPath = Join-Path $InstallPath 'appsettings.json'
  if (-not (Test-Path -LiteralPath $jsonPath)) {
    # Register-ADDashboardAgent.ps1 writes appsettings.json on first install;
    # if it's missing here we're in an unexpected state. Let the agent boot
    # fail loudly rather than silently re-create a partial file.
    Write-Step "no appsettings.json at $jsonPath — skipping migration (Register-ADDashboardAgent should have written it)"
    return
  }

  # Read current. PowerShell's Get-Content handles UTF-8 BOM transparently
  # (it strips it when parsing), so we don't need to manually strip here —
  # but the resulting JSON object round-trips cleanly when we rewrite.
  $raw = Get-Content -LiteralPath $jsonPath -Raw
  if ([string]::IsNullOrWhiteSpace($raw)) { return }
  $cfg = $raw | ConvertFrom-Json
  if ($null -eq $cfg) { return }

  # Use a PSCustomObject-style detection — ConvertFrom-Json yields
  # PSCustomObject, and the .<key> test returns $null for missing keys.
  $added = @()

  # R0.1.1+ — dashboard integration.
  if ($null -eq $cfg.username) {
    $cfg | Add-Member -NotePropertyName 'username' -NotePropertyValue 'admin' -Force
    $added += 'username'
  }
  if ($null -eq $cfg.password) {
    $cfg | Add-Member -NotePropertyName 'password' -NotePropertyValue 'YWRtaW4=' -Force
    $added += 'password'
  }
  if ($null -eq $cfg.port) {
    $cfg | Add-Member -NotePropertyName 'port' -NotePropertyValue 8080 -Force
    $added += 'port'
  }
  if ($null -eq $cfg.dashboardEnabled) {
    $cfg | Add-Member -NotePropertyName 'dashboardEnabled' -NotePropertyValue $true -Force
    $added += 'dashboardEnabled'
  }
  if ($null -eq $cfg.agentVersion -and $ReleaseVersion) {
    $cfg | Add-Member -NotePropertyName 'agentVersion' -NotePropertyValue $ReleaseVersion -Force
    $added += 'agentVersion'
  }

  if ($added.Count -eq 0) {
    Write-Step "appsettings.json schema migration: no-op (already complete)"
    return
  }

  # Atomic write — tmp + rename so a crash mid-write doesn't leave the
  # operator's appsettings.json half-baked. UTF-8 no-BOM (Node JSON.parse
  # rejects BOM; see appsettings.example.json comment for context).
  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  $tmpPath = "$jsonPath.tmp.$PID.$([DateTime]::UtcNow.Ticks)"
  try {
    $json = $cfg | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($tmpPath, $json, $utf8NoBom)
    Move-Item -LiteralPath $tmpPath -Destination $jsonPath -Force
  } catch {
    if (Test-Path -LiteralPath $tmpPath) {
      Remove-Item -LiteralPath $tmpPath -Force -ErrorAction SilentlyContinue
    }
    throw "appsettings.json migration failed: $($_.Exception.Message)"
  }
  Write-Step "appsettings.json schema migration: backfilled [$($added -join ', ')]"
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
  for ($i = 0; $i -lt 30; $i++) {
    if ((Get-Service -Name $ServiceName).Status -eq 'Stopped') { break }
    Start-Sleep 1
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
# Save the boolean to $srcEqDst so the single-file collector-script
# copy below can gate on the same condition.
$resolvedSrc = (Resolve-Path -LiteralPath $agentSrc -ErrorAction SilentlyContinue).ProviderPath
$resolvedDst = (Resolve-Path -LiteralPath $InstallPath -ErrorAction SilentlyContinue).ProviderPath
$srcEqDst = $resolvedSrc -and $resolvedDst -and [string]::Equals($resolvedSrc, $resolvedDst, [StringComparison]::OrdinalIgnoreCase)
if ($srcEqDst) {
  Write-Step "source and install path resolve to the same directory ($resolvedSrc); skipping code copy"
} else {
  Copy-Item -Path (Join-Path $agentSrc '*') -Destination $InstallPath -Recurse -Force `
    -Exclude 'node_modules','tests','appsettings.json','Logs','data'
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
} elseif (Test-Path (Join-Path $bundledGreenNodeDir 'node.exe')) {
  Write-Step "refreshing bundled Node.js from $bundledGreenNodeDir to $nodeDst"
  robocopy $bundledGreenNodeDir $nodeDst /MIR | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy node failed: $LASTEXITCODE" }
  $LASTEXITCODE = 0
}

# Copy the lineage's collector script to the runtime scripts\ dir. install-agent.ps1
# does this on first install too; doing it again here keeps the running service
# in sync after the upgrade. Skipped on Windows case-collision (src==dst)
# because the file is already in place; copy would fail with "Cannot use the
# item itself to overwrite the item".
#
# R161.23 (2026-10-29): the script was hardcoded to the AD/DC collector
# collect-replication.ps1. The MemberAgent bundle is the NON-AD lineage and
# ships exactly one collector: scripts\collect.ps1 (eventlog + ADWeb + DFSR).
# Hardcoding the DC collector here made every hot-update on a member server
# fail with "Cannot find path ... collect-replication.ps1".
$collectorScriptName = if ($AgentType -eq 'non-ad') { 'collect.ps1' } else { 'collect-replication.ps1' }
$collectorSrcPath = Join-Path $agentSrc ('scripts\' + $collectorScriptName)
$psScriptDstDir = Join-Path $InstallPath 'scripts'
if (-not (Test-Path $psScriptDstDir)) {
  New-Item -ItemType Directory -Path $psScriptDstDir -Force | Out-Null
}
if ($srcEqDst) {
  Write-Step "src==dst; skipping $collectorScriptName single-file copy (already in place)"
} else {
  if (-not (Test-Path -LiteralPath $collectorSrcPath)) {
    throw ("collector script not found: '$collectorSrcPath'. agentType='$AgentType' expects 'scripts\collect.ps1' in the non-AD lineage — verify the green package layout.")
  }
  Copy-Item -Path $collectorSrcPath -Destination $psScriptDstDir -Force
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
  throw "npm.cmd not found at $npmCmd — bundled Node install is incomplete. Re-extract the green package's node/ directory."
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

# ---- 本 lineage 的 agent 运行期必需的外部模块 (实测, 不是猜的) --------------
# 枚举方法 (可复跑): node Server\scripts\audit\check-agent-import-graph.mjs
#   从 agent.js 出发做可达性遍历, 收集所有**非相对** import 说明符, 剔除
#   node: 内置模块 ⇒ 得到"运行期真会被 import"的第三方模块。
#   ADAgent/agent     -> better-sqlite3, pino
#   MemberAgent/agent -> pino
# 为什么不写一个跨 lineage 的公共集合: member 的 agent 根本不用
# better-sqlite3。R161.23 起, AD 采集线的 src/local-queue.js (member 树里
# 唯一 import better-sqlite3 的模块, 而且本来就没人 import 它) 已经从
# member bundle 里**彻底删除** —— 硬塞进去等于给非 AD 服务器凭空加一个
# 原生模块依赖。
# R160 实测: 两条 lineage 的 package.json 都曾经留着 axios / better-sqlite3
# 这两条**陈旧声明** (member 那份是从 AD 复制过来的), 现已按实测集合清理:
#   ADAgent/agent/package.json     -> better-sqlite3, pino
#   MemberAgent/agent/package.json -> pino
# 探针集合必须与 package.json 的声明**逐字一致**:
#   声明里有、探针里没有 ⇒ 目标机上白装一个原生模块, 装不上就整次安装失败;
#   探针里有、声明里没有 ⇒ 探针永远假失败, 把一次本来正常的热更新挡在门外。
# 审计器 Server\scripts\audit\check-green-package-drift.mjs 的 C10 强制这条一致。
$RequiredRuntimeModules = @('pino')

# ---- 启动前必须复验: agent 的运行时依赖到底能不能被解析出来 ----------------
# 旧实现"npm install 退出 0 ⇒ 直接 Start-Service"。但 npm 退出 0 **不保证**
# 依赖可用:
#   - <InstallPath> 里没有 package.json 时, npm install 什么都不装, 照样退出 0
#   - 依赖装到了上级目录 (npm workspaces 提升) 时, 本地目录看着是空的
# 依赖缺失 ⇒ agent.js 的**静态** import (agent.js → src/logger.js →
# import pino from 'pino') 在启动第一秒就炸 ⇒ NSSM 拉起 → 再崩
# ⇒ 崩溃重启循环。而且下面那个 "等 20s 变 Running" 的循环在崩溃重启的窗口里
# **会看到 Running** ⇒ 脚本误报"启动成功", 操作员以为装好了, 现场却在刷日志。
#
# 判据: **能不能被 require 解析**, 而不是"有没有 node_modules 目录"。
# 探针写成**临时 .cjs 文件**而不是 `node -e "<js>"`: Windows PowerShell 5.1
# 传给原生命令的参数会把内层引号吃掉 (实测: 双引号被剥掉, 反引号被当转义符
# 吃掉 ⇒ node 收到的是语法错误, 退出码 1 而不是 3) —— 于是"依赖缺失"会被
# 误报成"探针本身坏了"。写文件就没有任何命令行转义。
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
  # Windows PowerShell 5.1 会把"原生命令往 stderr 写了一行"提升成**终止性**
  # NativeCommandError (在 $ErrorActionPreference='Stop' 下)。探针在"依赖缺失"
  # 这个**预期分支**里恰恰要往 stderr 写 MISSING:... ⇒ 脚本会在拿到
  # $LASTEXITCODE 之前就被打断, 操作员只看到一坨 NativeCommandError, 而看不到
  # 下面那条"哪个依赖没装上、怎么修"的提示。所以这里临时把 EAP 降成
  # Continue, 用 $LASTEXITCODE 判结果。
  $prevEap = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $depOutput = & $nodeExe $probeFile $InstallPath 2>&1
    $depExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prevEap
  }
} finally {
  if (Test-Path -LiteralPath $probeFile) { Remove-Item -LiteralPath $probeFile -Force -ErrorAction SilentlyContinue }
}
if ($null -eq $depExit) {
  # node 根本没跑起来 (路径不对 / 文件被占用 / 权限) ⇒ $LASTEXITCODE 是 $null。
  # 这跟"依赖缺失"是两回事, 提示必须分开写。
  $depDetail = (($depOutput | ForEach-Object { if ($_ -is [string]) { $_ } else { $_.ToString() } }) -join ' ').Trim()
  throw ("the dependency probe could not run node (no exit code) — node path '$nodeExe' is not usable. " +
         "Probe output: $depDetail")
}
if ($depExit -ne 0) {
  $depDetail = (($depOutput | ForEach-Object { if ($_ -is [string]) { $_ } else { $_.ToString() } }) -join ' ').Trim()
  throw ("the agent's runtime dependencies are NOT resolvable under '$InstallPath' " +
         "(required: $($RequiredRuntimeModules -join ', '); node exit $depExit): $depDetail. " +
         "The agent imports these modules statically, so a missing one means the service crashes on its " +
         "first import and NSSM restart-loops it. npm install exited 0 but the modules are missing — check " +
         "that <InstallPath>\package.json declares them and that they are installed for production, then re-run.")
}
# 成功提示里列的模块必须与探针实际检查的**完全一致** (都来自
# $RequiredRuntimeModules)。多列一个不存在的模块 ⇒ 操作员按提示去排查一个
# 根本没装也没用的包, 越查越迷。
Write-Step "agent runtime dependencies verified ($($RequiredRuntimeModules -join ' / ') resolvable)"

# 2026-10-02 R0.1.1+ — schema migration. Backfill any new appsettings.json
# fields added since the operator's existing install was first registered,
# before the new agent boots (which would otherwise pick up defaults only
# in-memory and never persist them, leaving the dashboard's port/password
# stuck at code defaults if the operator later restarts after editing).
Apply-AppsettingsSchemaMigration -InstallPath $InstallPath

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