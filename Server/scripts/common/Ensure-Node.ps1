# Downloads Node.js 20 LTS portable (Windows x64) if not already staged locally.
# Idempotent: re-running is a no-op when an existing node.exe is found.
# Requires PowerShell 5.1+ (Invoke-WebRequest + Expand-Archive are 5.0+).
#
# Why this exists:
#   The green package is supposed to be self-contained (no Node pre-requisite
#   on the target machine). Pre-2026-08-23 the install scripts assumed Node was
#   on PATH — operators on air-gapped targets had no way to install Node
#   separately without violating the no-network policy. Now we bundle Node
#   20 LTS portable inside the green package; this script is the build-time
#   bootstrap that downloads + extracts Node into publish/system/node/ so
#   build-green-package.ps1 can stage it into agentInstall/node/.
#
#   Pinning Node 20 LTS (not 22/24): agent code is ESM-only and uses
#   better-sqlite3 11.x native bindings, which target the Node 20 ABI. Moving
#   off 20 requires rebuilding every native dep + re-running the WPF smoke
#   tests; defer until 20 EOL (2026-04-30 → already passed; staying on 20
#   for stability is the conservative call).
#
# Self-contained target path (single source of truth for "where is Node?"):
#   <ProjectRoot>/publish/system/node/node.exe
# This matches NSSM.psm1's pattern and keeps the layout uniform with nssm.
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ProjectRoot
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'Logger.psm1') -Force

# R119 — per-module log file for this helper. Logger.psm1's default
# $Script:LogDir resolves to publish-root Logs/, so the dual-write Write-Log
# below lands in <publish-root>/Logs/install.log (legacy) and in
# <publish-root>/Logs/APP/ensure-node.log (R119). The mkdir APP/ below is
# idempotent on a fresh checkout and closes the R91.4 race where the first
# Write-Log after Set-LogModule would EACCES on a missing APP/ parent.
$publishRoot = Join-Path $ProjectRoot 'publish/system'
$Script:AppLogDir = Join-Path (Join-Path $publishRoot 'Logs') 'APP'
if (-not (Test-Path $Script:AppLogDir)) { New-Item -ItemType Directory -Path $Script:AppLogDir -Force | Out-Null }
Set-LogModule 'ensure-node'
# R119.B boot fingerprint — single line naming the running version + git
# commit so operators can prove which code is installed.
$mfst = Get-AgentManifest
$commit = if ($mfst -and $mfst.gitCommit) { $mfst.gitCommit } else { 'unknown' }
Write-Info ("{0} v{1} (commit={2})" -f $MyInvocation.MyCommand.Name, (Get-AgentVersion), $commit)

# Single source of truth for "where is the bundled node?": everything that
# needs Node (install-agent.ps1, Register-ADDashboardAgent.ps1, build-green-
# package.ps1) probes <ProjectRoot>/publish/system/node/node.exe first.
#
# publish/system 拼接护栏: 调用方传的 ProjectRoot 有两种 —— 仓库根 <root>,
# 或者已经是 <root>/publish/system (绿色包 -InPlace 安装链)。旧实现无条件
# 拼 'publish/system', 后一种会变成 publish/system/publish/system ⇒
# node 落在没人看的地方, 而 install-agent.ps1 找的是 <root>/publish/system/node
# ⇒ 永远"找不到捆绑 node", 每次安装都退回到 PATH 上的 node。
$projectLeaf = Split-Path -Leaf $ProjectRoot
$parentLeaf  = Split-Path -Leaf (Split-Path -Parent $ProjectRoot)
if ($projectLeaf -eq 'system' -and $parentLeaf -eq 'publish') {
  $pkgRoot = $ProjectRoot
} else {
  $pkgRoot = Join-Path $ProjectRoot 'publish/system'
}
$nodeDir = Join-Path $pkgRoot 'node'
$nodeExe = Join-Path $nodeDir 'node.exe'
# 运行时契约: 调用方 (install-agent.ps1 / build-green-package.ps1) 不只用
# node.exe, 还要用 **npm.cmd** 跑 `npm install`。旧实现的"已经装好了"判据
# 只看 node.exe ⇒ 一个**半成品**的 node 目录 (比如解压中断 / 网络中断后
# 只落下了 corepack.*) 会被当成"已就绪"直接 return, 而它的 npm.cmd 不存在
# ⇒ 后面 `npm install` 以 "npm 不是内部或外部命令" 失败, 绿色包里的 node
# 就是个不能用的壳。判据必须覆盖调用方真正会用到的三个可执行文件。
$requiredNodeFiles = @('node.exe', 'npm.cmd', 'npx.cmd')
$missingNodeFiles = @($requiredNodeFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $nodeDir $_)) })
if ($missingNodeFiles.Count -eq 0) {
  Write-Info "node already at $nodeExe"
  return $nodeExe
}
if ($missingNodeFiles.Count -lt $requiredNodeFiles.Count) {
  # 半成品目录 —— 明确说出来, 不要让"看起来装好了"混过去。
  Write-Info "node dir $nodeDir is INCOMPLETE (missing: $($missingNodeFiles -join ', ')) — re-staging the full runtime"
}

if (-not (Test-Path $nodeDir)) {
  New-Item -ItemType Directory -Path $nodeDir -Force | Out-Null
}

# Pin to a specific Node 20 LTS patch — latest -v20.x — so the green package
# is reproducible regardless of when the build runs. Bump explicitly when
# the agent's native deps (better-sqlite3) are rebuilt for a newer Node 20.
$nodeVersion = '20.20.2'
$url         = "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip"
# 每次运行用**独立**的临时目录。旧实现用固定的 %TEMP%\node-v<ver>.zip 和
# %TEMP%\node-extract-<ver> —— 两个并发的构建 (或者同一台机器上两个用户)
# 会互相删对方的下载目录/解压目录, 表现是"偶尔下载到一半就失败"或者
# "解压出来的 node 少了几个文件"。finally 里也只删自己那一份。
$workDir = Join-Path ([System.IO.Path]::GetTempPath()) ("addashboard-ensure-node-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$zipPath = Join-Path $workDir "node-v$nodeVersion.zip"
$extract = Join-Path $workDir 'extract'
New-Item -ItemType Directory -Path $workDir -Force | Out-Null

Write-Step "downloading Node.js $nodeVersion LTS x64 from $url"
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
  Expand-Archive -Path $zipPath -DestinationPath $extract -Force
  # The zip extracts to <extract>\node-v<ver>-win-x64\ with node.exe at the
  # top. Move the contents (not the folder) so the staged layout matches the
  # official portable Node layout — npm.cmd / npx.cmd / node_modules/ all
  # land at <publish/system/node/> alongside node.exe.
  $srcRoot = Join-Path $extract "node-v$nodeVersion-win-x64"
  if (-not (Test-Path -LiteralPath $srcRoot)) {
    throw "unexpected Node zip layout: $srcRoot not found (the archive extracted to: $((Get-ChildItem -LiteralPath $extract -Force -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name) -join ', '))"
  }
  # **先在解压目录里验, 再往 $nodeDir 里写** —— 旧实现先把文件铺进 $nodeDir,
  # 复制到一半失败 (磁盘满 / 中断) 就在目标目录留下一个**半成品**的 node,
  # 而脚本照旧 return "成功"。现在顺序反过来: 源不全 ⇒ 一个字节都不落地。
  $srcMissing = @($requiredNodeFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $srcRoot $_)) })
  if ($srcMissing.Count -gt 0) {
    throw "the downloaded archive node-v$nodeVersion-win-x64 is incomplete (missing: $($srcMissing -join ', ')) — refusing to stage a half-baked runtime into $nodeDir"
  }
  Get-ChildItem -Path $srcRoot -Force | ForEach-Object {
    Copy-Item -Path $_.FullName -Destination $nodeDir -Recurse -Force
  }
  # 复制完必须验证三个可执行文件真的在位 —— 否则函数会 return 一个不能用的
  # 路径, 调用方 (build-green-package.ps1) 照样报"成功", 而绿色包里的 node
  # 只是个壳 (这正是本仓库 Server\node\ 只剩 corepack 的成因)。
  $dstMissing = @($requiredNodeFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $nodeDir $_)) })
  if ($dstMissing.Count -gt 0) {
    throw "node runtime incomplete after staging into $nodeDir (missing: $($dstMissing -join ', ')) — the staged node will NOT work; remove $nodeDir and re-run"
  }
  Write-Info "node installed at $nodeExe (node.exe / npm.cmd / npx.cmd verified)"
  return $nodeExe
}
finally {
  if (Test-Path -LiteralPath $workDir) {
    Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
