# ============================================================================
# Register-ADDashboardAgent.ps1
#
# Single entry point for the three SCM-facing concerns of the AD Dashboard
# agent:
#
#   1. 写配置文件 (appsettings.json) — agent process reads at startup.
#   2. 注册 Node.js 启动 (NSSM install) — wraps node.exe as a Windows service
#      that node itself can't do natively (no SCM signal handling).
#   3. NSSM 服务注册 (12 个 nssm set + NSSM AppExit + sc.exe failure recovery)
#      — matches the MSI path's behavior so operators can switch freely.
#   4. 启动/停止服务 (Start/Stop-ServiceSafe) — wraps `Start-Service` /
#      `Stop-Service` with retry + diag-dump on failure.
#
# Used by:
#   - scripts/install-agent.ps1   (Invoke with -Action Register after copy + npm install)
#   - scripts/uninstall-agent.ps1 (Invoke with -Action Unregister before dir delete)
#   - (Future) MSI ConfigureAgentAction CustomAction — same params, same code path.
#
# Self-contained: no .psm1 imports. The script inlines the helpers it needs so
# there's one file that fully describes the install/register/unregister contract
# and a single grep target for behavior changes. Mirrors the green-package's
# pre-module path and matches the MSI's ConfigureAgentAction.cs surface, so
# any divergence shows up at code-review time.
#
# PowerShell 5.1 + pwsh 7+ compatible. No `??`, no ternary, no `Join-Path -Path a
# -ChildPath b -AdditionalChildPath c` (3-arg). Standard `if` / `Join-Path`.
# ============================================================================

[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$InstallPath,
  # CenterUrl / AgentToken are required for -Action Register, ignored for
  # -Action Unregister (uninstall-agent.ps1 calls with empty strings). The
  # Register branch below validates they are non-empty before use.
  [string]$CenterUrl,
  [string]$AgentToken,
  [ValidateSet('ad','non-ad')]
  [string]$AgentType = 'ad',
  [ValidateSet('Register','Unregister')]
  [string]$Action = 'Register',
  [string]$NssmPath,
  [string]$NodePath,
  [string]$LogDir,
  # Skip Start-ServiceSafe — used by MSI which calls sc.exe start in C# land
  # already and doesn't want a second Start-Service from a child PS process.
  [switch]$SkipStart
)

$ErrorActionPreference = 'Stop'

# ---- Logging (inline; intentionally does NOT import common/Logger.psm1) ----
if (-not $LogDir) {
  $LogDir = Join-Path $InstallPath 'Logs'
}
if (-not (Test-Path $LogDir)) {
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
}
$LogFile = Join-Path $LogDir 'register.log'
function Write-RLog {
  param([string]$Level, [string]$Message)
  $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
  Write-Host $line
  Add-Content -Path $LogFile -Value $line
}
function Write-RStep { param([string]$Message) Write-RLog 'STEP' $Message }
function Write-ROk    { param([string]$Message) Write-RLog 'OK'   $Message }
function Write-RInfo  { param([string]$Message) Write-RLog 'INFO' $Message }
function Write-RErr2  { param([string]$Message) Write-RLog 'ERR'  $Message }

# ---- NSSM path resolution (mirrors common/NSSM.psm1::Get-NssmPath) ----
# Search order:
#   1. $InstallPath\nssm\nssm.exe — MSI install layout (MSI ships nssm
#      alongside the agent at <InstallDir>\nssm\ — see
#      agent-installer/CA/ConfigureAgentAction.cs:247,268,295).
#   2. $PSScriptRoot\nssm\nssm.exe — GREEN-PACKAGE layout (the script lives
#      at <green>/Register-…; build-green-package.ps1 stages nssm at
#      <green>/nssm/nssm.exe alongside it).
#   3. $PSScriptRoot\..\publish\system\nssm\nssm.exe — DEV-TREE layout
#      (running from <project>/scripts/Register-… during local debugging).
#   4-5. Conventional C:\Tools\ fallbacks.
if (-not $NssmPath) {
  $candidates = @(
    (Join-Path $InstallPath 'nssm\nssm.exe'),
    (Join-Path $PSScriptRoot 'nssm\nssm.exe'),
    (Join-Path (Join-Path $PSScriptRoot '..\publish\system\nssm') 'nssm.exe'),
    'C:\Tools\nssm\win64\nssm.exe',
    'C:\Tools\nssm-2.24\win64\nssm.exe'
  )
  foreach ($p in $candidates) {
    if ($p -and (Test-Path -LiteralPath $p)) { $NssmPath = $p; break }
  }
}
if (-not $NssmPath -or -not (Test-Path -LiteralPath $NssmPath)) {
  throw 'nssm.exe not found. Run scripts/common/Ensure-Nssm.ps1 to download it, or pass -NssmPath.'
}

# ---- Node path resolution ----
# Search order mirrors start.ps1 / install-agent.ps1:
#   1. <InstallPath>/node/node.exe — copied there by install-agent.ps1 or
#      start.ps1's hot-update refresh from <green>/node/ (green-package layout).
#   2. node.exe on PATH — operator-installed fallback.
# install-agent.ps1 / start.ps1 always pass -NodePath explicitly after their
# own pre-flight check, so this branch is only hit when Register-… is called
# standalone (e.g., a future MSI C# custom action delegating here without
# going through the PS1 install scripts). Keep both branches anyway so the
# script is independently usable.
if (-not $NodePath) {
  $candidates = @(
    (Join-Path $InstallPath 'node\node.exe'),
    (Join-Path $PSScriptRoot 'node\node.exe')
  )
  foreach ($p in $candidates) {
    if ($p -and (Test-Path -LiteralPath $p)) { $NodePath = $p; break }
  }
  if (-not $NodePath) {
    $onPath = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($onPath) { $NodePath = $onPath.Source }
  }
}
if (-not $NodePath) {
  throw 'node.exe not found. Install Node.js 20 LTS and pass -NodePath, or ensure <InstallPath>/node/node.exe exists (green-package layout).'
}

$ServiceName = 'ADReplicationAgent'

# ============================================================================
# Step 1: 写配置文件 (appsettings.json)
#
# Same JSON shape install-agent.ps1 has been writing inline. Matches what the
# agent process's loadConfig expects (snake_case keys where the agent code
# already uses them, camelCase for the rest — see agent/src/config.js for
# the schema this contract satisfies).
# ============================================================================
function Write-AppsettingsJson {
  $cfg = [ordered]@{
    centerUrl                = $CenterUrl
    agentId                  = $env:COMPUTERNAME
    agentToken               = $AgentToken
    logLevel                 = 'info'
    pollingIntervalMinutes   = 15
    heartbeatIntervalSeconds = 5
    discoveryIntervalHours   = 1
    queueDbPath              = (Join-Path $InstallPath 'queue.db')
    psScriptPath             = (Join-Path $InstallPath 'scripts\collect-replication.ps1')
    psDiscoveryScriptPath    = (Join-Path $InstallPath 'scripts\collect-discovery.ps1')
    healthCheckIntervalMs    = 600000
    agentType                = $AgentType
  }
  $jsonPath = Join-Path $InstallPath 'appsettings.json'
  # 2026-08-24 round-8: PowerShell 5.1 `Set-Content -Encoding UTF8` writes a
  # UTF-8 BOM (EF BB BF) as the first 3 bytes. Node's JSON.parse rejects
  # those bytes with `SyntaxError: Unexpected token ''` and the agent
  # crashes on startup. Use [IO.File]::WriteAllText with a no-BOM
  # UTF8Encoding so appsettings.json is plain UTF-8. The agent's
  # loadConfig also strips a leading BOM defensively (defense-in-depth
  # for installs done by hand-edited configs), but we should never produce
  # a BOM in the first place from our installer.
  $json = $cfg | ConvertTo-Json
  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($jsonPath, $json, $utf8NoBom)
  Write-ROk "wrote $jsonPath"
}

# ============================================================================
# Step 2: NSSM install (idempotent — refreshes parameters if service exists)
# ============================================================================
function Invoke-Nssm {
  param([string[]]$Arguments)
  & $NssmPath @Arguments | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "nssm $($Arguments -join ' ') failed: $LASTEXITCODE"
  }
}

function Install-NssmServiceRegistration {
  $displayName = if ($AgentType -eq 'non-ad') {
    'AD Dashboard Agent (Member)'
  } else {
    "AD Replication Agent (on $env:COMPUTERNAME)"
  }
  $description = if ($AgentType -eq 'non-ad') {
    'AD Dashboard member-server monitor (self-register + heartbeat + package fetch)'
  } else {
    'AD Replication collection agent'
  }

  $existed = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($existed) {
    Write-RInfo "$ServiceName already installed; refreshing NSSM parameters"
  } else {
    Invoke-Nssm @('install', $ServiceName, "`"$NodePath`"")
  }
  Invoke-Nssm @('set', $ServiceName, 'AppDirectory',         $InstallPath)
  Invoke-Nssm @('set', $ServiceName, 'AppParameters',        'agent.js')
  Invoke-Nssm @('set', $ServiceName, 'DisplayName',          $displayName)
  Invoke-Nssm @('set', $ServiceName, 'Description',          $description)
  Invoke-Nssm @('set', $ServiceName, 'Start',                'SERVICE_AUTO_START')
  Invoke-Nssm @('set', $ServiceName, 'DependOnService',      'DNS Client', 'Netlogon')
  Invoke-Nssm @('set', $ServiceName, 'AppStdout',            (Join-Path $LogDir "$ServiceName-stdout.log"))
  Invoke-Nssm @('set', $ServiceName, 'AppStderr',            (Join-Path $LogDir "$ServiceName-stderr.log"))
  Invoke-Nssm @('set', $ServiceName, 'AppRotateFiles',       '1')
  Invoke-Nssm @('set', $ServiceName, 'AppRotateOnline',      '1')
  Invoke-Nssm @('set', $ServiceName, 'AppRotateBytes',       '10485760')
  Invoke-Nssm @('set', $ServiceName, 'AppEnvironmentExtra',  'NODE_ENV=production')
  Write-ROk "NSSM parameters set for $ServiceName"
}

# ============================================================================
# Step 3: 服务恢复 (NSSM-level + Windows-level)
#
# This is the part the green package was MISSING — install-agent.ps1 never
# called Set-ServiceRecovery, so green-package installs lacked the sc.exe
# failure recovery that the MSI's ConfigureAgentAction.SetServiceRecovery sets.
# Consolidating into Register-ADDashboardAgent.ps1 closes that gap and ensures
# both paths converge on identical service behavior.
# ============================================================================
function Set-ServiceRecoveryRegistration {
  # NSSM-level: restart cleanly on process.exit(0). AppExit requires the
  # sub-parameter form `<exit_code|Default> <action>` — NSSM 2.24 rejects
  # the bare `AppExit Restart` form with "requires a subparameter!".
  Invoke-Nssm @('set', $ServiceName, 'AppExit',        'Default', 'Restart')
  Invoke-Nssm @('set', $ServiceName, 'AppRestartDelay','2000')

  # Windows-level: restart on crash (OOM, segfault, kill -9). The syntax
  # `reset= 60` requires a SPACE after `=`; sc.exe is picky about that.
  $scArgs = @('failure', $ServiceName, 'reset=', '60',
              'actions=', 'restart/5000/restart/10000/restart/30000')
  $p = Start-Process -FilePath 'sc.exe' -ArgumentList $scArgs `
                     -NoNewWindow -Wait -PassThru
  if ($p.ExitCode -ne 0) {
    throw "sc.exe failure $ServiceName failed: exit $($p.ExitCode)"
  }
  Write-ROk "service recovery set: NSSM AppExit=Default Restart + sc failure reset=60 actions=restart/5000/restart/10000/restart/30000"
}

# ============================================================================
# Step 4: Start / Stop service
# ============================================================================
function Start-ServiceRegistration {
  $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if (-not $svc) {
    Write-RErr2 "$ServiceName is not registered; cannot start."
    return $false
  }
  if ($svc.Status -eq 'Running') {
    Write-ROk "$ServiceName already running"
    return $true
  }
  try {
    Start-Service -Name $ServiceName -ErrorAction Stop
  } catch {
    $msg = $_.Exception.InnerException.Message
    if (-not $msg) { $msg = $_.Exception.Message }
    $win32 = ''
    if ($_.Exception.InnerException -and
        $_.Exception.InnerException.GetType().FullName -match 'Win32Exception') {
      $win32 = " (Win32: $($_.Exception.InnerException.NativeErrorCode))"
    }
    Write-RErr2 "Start-Service failed: $msg$win32"
    return $false
  }
  for ($i = 0; $i -lt 20; $i++) {
    if ((Get-Service -Name $ServiceName).Status -eq 'Running') {
      Write-ROk "$ServiceName started"
      return $true
    }
    Start-Sleep 1
  }
  Write-RErr2 "$ServiceName did not reach Running within 20s"
  return $false
}

function Stop-ServiceRegistration {
  $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if (-not $svc) { return $true }
  if ($svc.Status -eq 'Stopped') { return $true }
  Stop-Service -Name $ServiceName -Force -ErrorAction Stop
  for ($i = 0; $i -lt 30; $i++) {
    if ((Get-Service -Name $ServiceName).Status -eq 'Stopped') { return $true }
    Start-Sleep 1
  }
  return $false
}

function Remove-ServiceRegistration {
  $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($svc) {
    [void](Stop-ServiceRegistration)
    & $NssmPath remove $ServiceName confirm | Out-Null
    Write-ROk "nssm removed $ServiceName"
  }
}

# ============================================================================
# Dispatch
# ============================================================================
switch ($Action) {
  'Register' {
    if ([string]::IsNullOrWhiteSpace($CenterUrl)) {
      throw '-CenterUrl is required for -Action Register'
    }
    if ([string]::IsNullOrWhiteSpace($AgentToken)) {
      throw '-AgentToken is required for -Action Register'
    }
    Write-RStep "Register-ADDashboardAgent: $InstallPath (agentType=$AgentType)"
    Write-AppsettingsJson
    Install-NssmServiceRegistration
    Set-ServiceRecoveryRegistration
    if (-not $SkipStart) {
      if (-not (Start-ServiceRegistration)) { exit 1 }
    }
    Write-ROk "register complete"
  }
  'Unregister' {
    Write-RStep "Unregister-ADDashboardAgent: $InstallPath"
    Remove-ServiceRegistration
    Write-ROk "unregister complete"
  }
}