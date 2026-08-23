# upgrade-agent.ps1 — unified install / hot-update entry for the AD Dashboard
# Agent (green-package path).
#
# Why this exists (mirrors center's upgrade-center.ps1):
#   Pre-2026-08-23, operators had to choose between install-agent.ps1 (first-time
#   only) and update-agent.ps1 (legacy hot-fix that ASSUMES the service exists).
#   Neither told you "this is the one to run" — easy to pick the wrong one and
#   either fail with "service not found" or re-apply config on an already-set
#   install. center has upgrade-center.ps1 as the single entry; this script
#   brings the agent path up to parity.
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

if (-not $InstallPath) {
  $InstallPath = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')) 'Agent')
}

$ErrorActionPreference = 'Stop'
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Import-Module (Join-Path $PSScriptRoot 'common\Logger.psm1') -Force

# Push LogDir into Logger.psm1's module-scoped $Script:LogDir so Write-Log can
# tee install.log without us having to wire it through every call.
$Script:LogDir = Join-Path $InstallPath 'Logs'
if (-not (Test-Path $Script:LogDir)) {
  New-Item -ItemType Directory -Path $Script:LogDir -Force | Out-Null
}
Set-LogDir $Script:LogDir

# Pre-flight: Node.js 20 LTS is required (green package does NOT bundle
# Node — unlike MSI). Fail fast before we prompt for CenterUrl/AgentToken
# so the operator doesn't type creds only to discover Node is missing.
# See installer/README-green-install.md "目标机器前置条件".
$nodePreFlight = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodePreFlight) {
  throw "node.exe not found on PATH. The green package does NOT bundle Node.js (unlike the MSI). Install Node.js 20 LTS x64 first — see installer/README-green-install.md. If node.exe IS installed but missing from PATH, add its directory to PATH and re-run."
}
$nodeMajor = ($nodePreFlight.Version.Major.ToString())
if ([int]$nodeMajor -ne 20) {
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
  if ($LASTEXITCODE -ne 0) { throw "install-agent.ps1 failed: $LASTEXITCODE" }
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
  for ($i = 0; $i -lt 30; $i++) {
    if ((Get-Service -Name $ServiceName).Status -eq 'Stopped') { break }
    Start-Sleep 1
  }
}

# Copy new agent code (exclude node_modules + tests + appsettings.json — node
# resolves at runtime via npm install; appsettings.json holds the live token
# + CenterUrl we just don't want to clobber).
$agentSrc = Join-Path $projectRoot 'agent'
Write-Step "copying $agentSrc → $InstallPath"
Copy-Item -Path (Join-Path $agentSrc '*') -Destination $InstallPath -Recurse -Force `
  -Exclude 'node_modules','tests','appsettings.json'

# Copy latest collect-replication.ps1 to the runtime scripts\ dir. install-agent.ps1
# does this on first install too; doing it again here keeps the running service
# in sync after the upgrade.
$psScriptDstDir = Join-Path $InstallPath 'scripts'
if (-not (Test-Path $psScriptDstDir)) {
  New-Item -ItemType Directory -Path $psScriptDstDir -Force | Out-Null
}
Copy-Item -Path (Join-Path $agentSrc 'scripts\collect-replication.ps1') `
          -Destination $psScriptDstDir -Force

# npm install — production-only, no audit noise in CI logs.
Push-Location $InstallPath
try {
  Write-Step "npm install --omit=dev"
  npm install --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm install failed: $LASTEXITCODE" }
} finally { Pop-Location }

# Restart service.
Write-Step "starting $ServiceName"
Start-Service -Name $ServiceName -ErrorAction Stop
for ($i = 0; $i -lt 20; $i++) {
  if ((Get-Service -Name $ServiceName).Status -eq 'Running') {
    Write-Ok "$ServiceName started"
    return
  }
  Start-Sleep 1
}
throw "$ServiceName did not reach Running within 20s — see $(Join-Path $Script:LogDir 'install.log')"