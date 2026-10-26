# Module-scoped state — function calls DO NOT cross modules to read $Script: in
# the caller's scope, so each module that wants shared state owns its own
# $Script: variable plus an explicit setter. See Set-NssmLogDir / Set-NssmPath.
$Script:NssmPath = $null
# Default LogDir resolves relative to the script's own publish root (parent of
# scripts/common/) — install/update/uninstall callers always override this via
# Set-NssmLogDir, but the fallback matters for any ad-hoc use of the module.
$Script:LogDir = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'Logs'
if (-not (Test-Path -LiteralPath $Script:LogDir)) {
  New-Item -ItemType Directory -Path $Script:LogDir -Force | Out-Null
}

# R160 — 本模块自己依赖 Logger.psm1 的 Write-Info / Write-Warn2, 但之前是
# **隐式**依赖: NSSM.psm1 从不 import Logger.psm1, 谁用谁负责导入。
# 只要有人只 `Import-Module NSSM.psm1` (install-center.ps1 就是这种用法),
# Disable-NssmStderr 里的 Write-Warn2 就是"未识别的命令" ⇒ 抛
# CommandNotFoundException ⇒ 一个"绝不该抛"的函数把安装流程带崩。
# 这里显式导入 (同目录, 无循环依赖: Logger.psm1 不依赖 NSSM.psm1)。
# PowerShell 按路径缓存模块 ⇒ 调用方自己导入过 Logger.psm1 时拿到的是
# **同一个**模块实例, Set-LogDir 之类的状态不会分叉。
try {
  Import-Module (Join-Path $PSScriptRoot 'Logger.psm1') -ErrorAction Stop
} catch {
  # 导入失败不能把整个模块带崩 —— Write-NssmLog 会退化成 Write-Host。
  Write-Host ("[NSSM] Logger.psm1 unavailable ({0}) — falling back to console logging" -f $_.Exception.Message)
}

# 内部日志出口: 优先用 Logger.psm1 的双写日志, 模块缺失时退化成 Write-Host。
# 存在的意义是"日志本身永远不能把调用方带崩"。
function Write-NssmLog {
  param([ValidateSet('INFO','WARN')][string]$Level, [string]$Message)
  $fn = if ($Level -eq 'WARN') { 'Write-Warn2' } else { 'Write-Info' }
  $cmd = Get-Command -Name $fn -ErrorAction SilentlyContinue
  if ($cmd) { & $fn $Message } else { Write-Host ("[{0}] {1}" -f $Level, $Message) }
}

function Set-NssmPath {
  param([string]$Path)
  $Script:NssmPath = $Path
}

function Set-NssmLogDir {
  param([string]$Path)
  if ($Path) {
    $Script:LogDir = $Path
    if (-not (Test-Path -LiteralPath $Script:LogDir)) {
      New-Item -ItemType Directory -Path $Script:LogDir -Force | Out-Null
    }
  }
}

function Get-NssmPath {
  if ($Script:NssmPath -and (Test-Path -LiteralPath $Script:NssmPath)) { return $Script:NssmPath }
  # Search order — all $PSScriptRoot-relative so the same module resolves
  # nssm correctly regardless of where the script tree lives:
  #   1. <root>/publish/system/nssm/nssm.exe  — dev tree (canonical, post-Ensure-Nssm)
  #   2. <root>/nssm/nssm.exe                 — alt dev tree
  #   3. <root>/scripts/../nssm/nssm.exe      — GREEN PACKAGE (script at
  #      <green>/agentInstall/common/, nssm bundled at <green>/agentInstall/nssm/).
  #      Without this candidate, Ensure-Nssm.ps1 — invoked by install-agent.ps1
  #      before delegating to Register-ADDashboardAgent.ps1 — fails to find
  #      the bundled nssm and falls through to a network download, which is
  #      both wasteful AND breaks air-gapped installs that legitimately bundle
  #      nssm at <green>/nssm/.
  #   4. C:\Tools\nssm\win64\nssm.exe         — operator-installed copy
  #   5. C:\Tools\nssm-2.24\win64\nssm.exe     — operator-installed copy
  #   6. <root>/tools/nssm.exe                — alt
  $candidates = @(
    (Join-Path (Join-Path $PSScriptRoot '..\..\publish\system\nssm') 'nssm.exe'),
    (Join-Path (Join-Path $PSScriptRoot '..\..\nssm') 'nssm.exe'),
    (Join-Path (Join-Path $PSScriptRoot '..\nssm') 'nssm.exe'),
    'C:\Tools\nssm\win64\nssm.exe',
    'C:\Tools\nssm-2.24\win64\nssm.exe',
    (Join-Path $PSScriptRoot '..\..\tools\nssm.exe')
  )
  foreach ($p in $candidates) { if (Test-Path -LiteralPath $p) { $Script:NssmPath = $p; return $p } }
  throw "nssm.exe not found. Ensure publish/system/nssm/nssm.exe exists in the repo, or run scripts/common/Ensure-Nssm.ps1 to download it."
}

function Invoke-Nssm {
  param([string[]]$Arguments)
  $nssm = Get-NssmPath
  & $nssm @Arguments
  if ($LASTEXITCODE -ne 0) { throw "nssm $($Arguments -join ' ') failed: $LASTEXITCODE" }
}

# Turns NSSM's stderr redirection OFF for a service.
#
# NSSM 2.24 has NO syntax for "set this parameter to an empty value":
# `nssm set <svc> AppStderr ""` makes NSSM print its usage banner and exit 1.
# Real failure (2026-10-25, `start.bat` install of ADDashboardCenter on
# DESKTOP-G0P5C1T): the install aborted at that call with
#   "nssm set ADDashboardCenter AppStderr  failed: 1"
# which left the service registered + fully parameterised BUT the install
# script never reached Set-ServiceRecovery / Start-ServiceSafe / the HTTP
# probe — i.e. a successful `nssm install` followed by a hard failure.
#
# The supported way to switch a redirection OFF is `nssm reset <svc> AppStderr`:
# it drops the parameter back to NSSM's default, and for AppStderr that default
# is "no redirection" — exactly the state the center needs, because NSSM's
# append-then-rename on the rotated log path races pino-roll's own rename
# (truncated tail / EBADF).
#
# Never throws: stderr routing is a logging preference, not a reason to abort
# a service install. Returns $true when the reset succeeded, $false otherwise.
function Disable-NssmStderr {
  param([Parameter(Mandatory)][string]$Name)
  $exitCode = 0
  try {
    # Get-NssmPath 在找不到 nssm.exe 时会 throw。旧实现把它放在 try 外面
    # ⇒ 这个"绝不该抛"的函数在 nssm 缺失时**直接抛出去**, 把整个安装流程
    # 带崩 —— 而 stderr 路由只是个日志偏好, 失败也该继续装。
    $nssm = Get-NssmPath
    & $nssm @('reset', $Name, 'AppStderr') | Out-Null
    $exitCode = $LASTEXITCODE
  } catch {
    # PowerShell 7 with $PSNativeCommandUseErrorActionPreference = $true turns a
    # native command's non-zero exit code into a terminating error. Stderr
    # routing is a logging preference — it must never abort an install.
    $exitCode = 1
    Write-NssmLog -Level 'WARN' -Message "nssm reset $Name AppStderr raised: $($_.Exception.Message)"
  }
  if ($exitCode -eq 0) {
    Write-NssmLog -Level 'INFO' -Message "nssm reset $Name AppStderr — stderr capture off (pino-roll is sole writer of the rotated log)"
    return $true
  }
  Write-NssmLog -Level 'WARN' -Message "nssm reset $Name AppStderr failed (exit $exitCode); keeping the previous AppStderr target"
  return $false
}

function Install-NssmService {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$Application,
    [Parameter(Mandatory)][string]$AppDirectory,
    [Parameter(Mandatory)][string]$AppParameters,
    [string[]]$DependOnService = @(),
    [string]$DisplayName = $Name,
    [string]$Description = '',
    [ValidateSet('SERVICE_AUTO_START','SERVICE_DELAYED_AUTO_START','SERVICE_DEMAND_START','SERVICE_DISABLED')]
    [string]$Start = 'SERVICE_AUTO_START'
  )
  $existed = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if ($existed) {
    # Service already registered — skip `nssm install` (would error "service already
    # exists") but ALWAYS re-apply NSSM parameters. Skipping the parameter pass on
    # re-install is the root cause of multiple real-world NSSM bugs (AppExit
    # sub-parameter, AppDirectory pointing at old code, log path, rotation, etc.):
    # any installer change to those settings never reached the existing service.
    Write-Info "Service $Name already installed; refreshing NSSM parameters"
  } else {
    Invoke-Nssm @('install', $Name, $Application)
  }
  Set-NssmParameters -Name $Name -AppDirectory $AppDirectory -AppParameters $AppParameters `
    -DependOnService $DependOnService -DisplayName $DisplayName -Description $Description -Start $Start
}

function Set-NssmParameters {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$AppDirectory,
    [Parameter(Mandatory)][string]$AppParameters,
    [string[]]$DependOnService = @(),
    [string]$DisplayName = $Name,
    [string]$Description = '',
    [ValidateSet('SERVICE_AUTO_START','SERVICE_DELAYED_AUTO_START','SERVICE_DEMAND_START','SERVICE_DISABLED')]
    [string]$Start = 'SERVICE_AUTO_START'
  )
  Invoke-Nssm @('set', $Name, 'AppDirectory', $AppDirectory)
  Invoke-Nssm @('set', $Name, 'AppParameters', $AppParameters)
  Invoke-Nssm @('set', $Name, 'DisplayName', $DisplayName)
  if ($Description) { Invoke-Nssm @('set', $Name, 'Description', $Description) }
  Invoke-Nssm @('set', $Name, 'Start', $Start)
  Invoke-Nssm @('set', $Name, 'AppStdout', (Join-Path $Script:LogDir "$Name-stdout.log"))
  Invoke-Nssm @('set', $Name, 'AppStderr', (Join-Path $Script:LogDir "$Name-stderr.log"))
  Invoke-Nssm @('set', $Name, 'AppRotateFiles', '1')
  Invoke-Nssm @('set', $Name, 'AppRotateOnline', '1')
  Invoke-Nssm @('set', $Name, 'AppRotateBytes', '10485760')
  if ($DependOnService.Count -gt 0) {
    # NSSM's DependOnService takes multiple service-name positional args, NOT a
    # comma-joined string. Real install run on KDLWXOFADSRV1 (2026-08-24) hit
    # "DNS Client,Netlogon: 服务不存在" when the array was joined — NSSM
    # parses "DNS Client,Netlogon" as one service-name literal and OpenService
    # fails. Splat the array so PowerShell emits each name as a separate argv
    # token (matches NSSM's `nssm set <svc> DependOnService <svc1> [<svc2> ...]`
    # signature). Note: bare `Invoke-Nssm @('set', $Name, 'DependOnService') +
    # $DependOnService` is a parser trap — `@()` is interpreted as a splat and
    # the `+ $arr` is silently dropped. Wrap in parens to force expression
    # evaluation. The MSI path's equivalent fix: RunNssmSetMulti at
    # installer/agent-installer/CA/ConfigureAgentAction.cs:283.
    Invoke-Nssm (@('set', $Name, 'DependOnService') + $DependOnService)
  }
  Invoke-Nssm @('set', $Name, 'AppEnvironmentExtra', 'NODE_ENV=production')
}
