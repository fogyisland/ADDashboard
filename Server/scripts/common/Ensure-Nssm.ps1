# Downloads NSSM 2.24 if not already present locally.
# Idempotent: re-running is a no-op when an existing nssm.exe is found.
# Requires PowerShell 5.1+ (Invoke-WebRequest + Expand-Archive are 5.0+).
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ProjectRoot
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'Logger.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'NSSM.psm1') -Force

# R119 — per-module log file for this helper. Logger.psm1's default
# $Script:LogDir resolves to publish-root Logs/, so the dual-write Write-Log
# below lands in <publish-root>/Logs/install.log (legacy) and in
# <publish-root>/Logs/APP/ensure-nssm.log (R119). The mkdir APP/ below is
# idempotent on a fresh checkout and closes the R91.4 race where the first
# Write-Log after Set-LogModule would EACCES on a missing APP/ parent.
$publishRoot = Join-Path $ProjectRoot 'publish/system'
$Script:AppLogDir = Join-Path (Join-Path $publishRoot 'Logs') 'APP'
if (-not (Test-Path $Script:AppLogDir)) { New-Item -ItemType Directory -Path $Script:AppLogDir -Force | Out-Null }
Set-LogModule 'ensure-nssm'
# R119.B boot fingerprint — single line naming the running version + git
# commit so operators can prove which code is installed.
$mfst = Get-AgentManifest
$commit = if ($mfst -and $mfst.gitCommit) { $mfst.gitCommit } else { 'unknown' }
Write-Info ("{0} v{1} (commit={2})" -f $MyInvocation.MyCommand.Name, (Get-AgentVersion), $commit)

# Single source of truth for "where is nssm?": NSSM.psm1::Get-NssmPath
# searches both <root>/publish/system/nssm/ and <root>/nssm/, so it works for
# the canonical install (ProjectRoot = repo root, nssm bundled at
# <root>/publish/system/nssm/) AND the green-bundle -InPlace install
# (ProjectRoot = publish/system/, nssm bundled at publish/system/nssm/).
try {
  $existing = Get-NssmPath
  if ($existing -and (Test-Path $existing)) {
    Write-Info "nssm already at $existing"
    return $existing
  }
} catch {
  # No nssm found in any candidate path. Fall through to download.
}

# Download to <ProjectRoot>/publish/system/nssm/ — keeps the bundle layout
# consistent regardless of which root called us.
#
# publish/system 拼接护栏 (同 Ensure-Node.ps1): 调用方传的 ProjectRoot 可能
# 已经是 <root>/publish/system (绿色包 -InPlace 链)。旧实现无条件再拼一层
# 'publish/system' ⇒ nssm 落到 publish/system/publish/system/nssm, 而
# Get-NssmPath 找的是 publish/system/nssm ⇒ 永远"没装上"。
$projectLeaf = Split-Path -Leaf $ProjectRoot
$parentLeaf  = Split-Path -Leaf (Split-Path -Parent $ProjectRoot)
if ($projectLeaf -eq 'system' -and $parentLeaf -eq 'publish') {
  $pkgRoot = $ProjectRoot
} else {
  $pkgRoot = Join-Path $ProjectRoot 'publish/system'
}
$nssmDir  = Join-Path $pkgRoot 'nssm'
$nssmExe  = Join-Path $nssmDir 'nssm.exe'

if (-not (Test-Path $nssmDir)) {
  New-Item -ItemType Directory -Path $nssmDir -Force | Out-Null
}

$url      = 'https://nssm.cc/release/nssm-2.24.zip'
# 独立临时目录 (同 Ensure-Node.ps1): 固定的 %TEMP%\nssm-2.24.zip /
# %TEMP%\nssm-extract 会让并发的构建互相删除对方的文件。
$workDir  = Join-Path ([System.IO.Path]::GetTempPath()) ("addashboard-ensure-nssm-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$zipPath  = Join-Path $workDir 'nssm-2.24.zip'
$extract  = Join-Path $workDir 'extract'
New-Item -ItemType Directory -Path $workDir -Force | Out-Null

Write-Step "downloading NSSM 2.24 from $url"
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
  Expand-Archive -Path $zipPath -DestinationPath $extract -Force
  $srcExe = Join-Path (Join-Path (Join-Path $extract 'nssm-2.24') 'win64') 'nssm.exe'
  if (-not (Test-Path -LiteralPath $srcExe)) {
    throw "unexpected NSSM zip layout: $srcExe not found (the archive extracted to: $((Get-ChildItem -LiteralPath $extract -Force -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name) -join ', '))"
  }
  Copy-Item -Path $srcExe -Destination $nssmExe -Force
  # 复制完必须验证 —— 否则会 return 一个不存在的路径, 调用方照样报"成功"。
  if (-not (Test-Path -LiteralPath $nssmExe)) {
    throw "nssm.exe missing after copying to $nssmExe"
  }
  Set-NssmPath -Path $nssmExe
  Write-Info "nssm installed at $nssmExe"
  return $nssmExe
}
finally {
  if (Test-Path -LiteralPath $workDir) {
    Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
