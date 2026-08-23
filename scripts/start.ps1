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

if (-not $InstallPath) {
  # Layout-independent default: agent/ sibling (green package) → use
  # script's own dir; agent/ at parent (dev tree) → use parent. Mirror
  # the resolution below so first-time-install and hot-update agree on
  # the same root.
  $greenPkgAgent = Join-Path $PSScriptRoot 'agent'
  $devTreeAgent  = Join-Path (Join-Path $PSScriptRoot '..') 'agent'
  if (Test-Path $greenPkgAgent) {
    $InstallPath = Join-Path $PSScriptRoot 'Agent'
  } elseif (Test-Path $devTreeAgent) {
    $InstallPath = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')) 'Agent'
  } else {
    throw "agent/ source not found. Tried '$greenPkgAgent' (green-package layout) and '$devTreeAgent' (dev-tree layout). Verify the bundle layout."
  }
}

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'common\Logger.psm1') -Force

# Push LogDir into Logger.psm1's module-scoped $Script:LogDir so Write-Log can
# tee install.log without us having to wire it through every call.
$Script:LogDir = Join-Path $InstallPath 'Logs'
if (-not (Test-Path $Script:LogDir)) {
  New-Item -ItemType Directory -Path $Script:LogDir -Force | Out-Null
}
Set-LogDir $Script:LogDir

# Pre-flight: Node.js 20 LTS — green package bundles it at <green>/node/
# (see installer/build-green-package.ps1 step 4) so air-gapped targets don't
# need a separate Node install. Search order:
#   1. <green>/node/node.exe — bundled by build-green-package.ps1
#   2. <InstallPath>/node/node.exe — already-copied by a prior install/upgrade
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
Copy-Item -Path (Join-Path $agentSrc '*') -Destination $InstallPath -Recurse -Force `
  -Exclude 'node_modules','tests','appsettings.json','Logs'

# Refresh bundled Node.js if present in the green package. New green-package
# releases may pin a newer Node 20 patch; mirroring <green>/node/ → <InstallPath>/node/
# keeps the running node in sync. robocopy /MIR + idempotent on identical bytes.
# Variable name distinct from the pre-flight $bundledGreenNode (file) above —
# this is the directory, not the exe.
$bundledGreenNodeDir = Join-Path $PSScriptRoot 'node'
$nodeDst = Join-Path $InstallPath 'node'
if (Test-Path (Join-Path $bundledGreenNodeDir 'node.exe')) {
  Write-Step "refreshing bundled Node.js from $bundledGreenNodeDir to $nodeDst"
  robocopy $bundledGreenNodeDir $nodeDst /MIR | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy node failed: $LASTEXITCODE" }
  $LASTEXITCODE = 0
}

# Copy latest collect-replication.ps1 to the runtime scripts\ dir. install-agent.ps1
# does this on first install too; doing it again here keeps the running service
# in sync after the upgrade.
$psScriptDstDir = Join-Path $InstallPath 'scripts'
if (-not (Test-Path $psScriptDstDir)) {
  New-Item -ItemType Directory -Path $psScriptDstDir -Force | Out-Null
}
Copy-Item -Path (Join-Path $agentSrc 'scripts\collect-replication.ps1') `
          -Destination $psScriptDstDir -Force

# Prepend the install-path node dir to PATH so npm install uses the same Node
# version NSSM launches. Without this, PATH's npm (could be a different
# version, or absent on air-gapped targets) would either rebuild node_modules
# against the wrong ABI or fail with "npm not recognized". Mirrors the same
# guard in install-agent.ps1's Install-LocalAgent.
$env:PATH = $nodeDst + [IO.Path]::PathSeparator + $env:PATH

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