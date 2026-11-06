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
  # R161.23 (2026-10-29): the default used to be 'ad' — a verbatim copy of
  # the AD/DC bundle's registration script. This bundle registers the
  # member-server service (memberServiceAgent) and the non-AD collector,
  # so omitting -AgentType must NOT ask for the DC lineage.
  [ValidateSet('ad','non-ad')]
  [string]$AgentType = 'non-ad',
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

# ---- Version (read from version.inf — single source of truth) ----
Import-Module (Join-Path $PSScriptRoot 'common\Version.psm1') -Force
$ReleaseVersion = Get-ComponentVersion -Component 'version'
if (-not $ReleaseVersion) {
  throw "version.inf missing or [components] version key unset. Verify the green package is complete."
}

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
function Write-RWarn  { param([string]$Message) Write-RLog 'WARN' $Message }
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

$ServiceName = 'memberServiceAgent'

# ============================================================================
# Step 1: 写配置文件 (appsettings.json)
#
# Same JSON shape install-agent.ps1 has been writing inline. Matches what the
# agent process's loadConfig expects (snake_case keys where the agent code
# already uses them, camelCase for the rest — see agent/src/config.js for
# the schema this contract satisfies).
# ============================================================================
function Write-AppsettingsJson {
  # R161.23 (2026-10-29) — lineage-aware collector path (see the comment at
  # the psScriptPath entry below). The non-AD lineage ships one collector:
  # scripts\collect.ps1.
  $collectorScriptName = if ($AgentType -eq 'non-ad') { 'collect.ps1' } else { 'collect-replication.ps1' }
  $collectorPath = Join-Path $InstallPath ('scripts\' + $collectorScriptName)
  $cfg = [ordered]@{
    centerUrl                = $CenterUrl
    agentId                  = $env:COMPUTERNAME
    agentToken               = $AgentToken
    logLevel                 = 'info'
    pollingIntervalMinutes   = 15
    heartbeatIntervalSeconds = 5
    discoveryIntervalHours   = 1
    queueDbPath              = (Join-Path $InstallPath 'queue.db')
    # R161.23 (2026-10-29): lineage-aware collector path.
    # The MemberAgent bundle is the NON-AD lineage and ships exactly one
    # collector: scripts\collect.ps1 (eventlog + ADWeb + DFSR).
    # collect-replication.ps1 / collect-discovery.ps1 are AD/DC collectors and
    # are NOT shipped in this bundle — the old config pointed at files that do
    # not exist on the target machine.
    psScriptPath             = $collectorPath
    psDiscoveryScriptPath    = $collectorPath
    healthCheckIntervalMs    = 600000
    agentType                = $AgentType
    # 2026-10-02 R0.1.1+ — dashboard integration. New installs get the safe
    # loopback defaults baked in so the dashboard's "改密码" tab works
    # immediately. Operators can rotate the password post-install via the UI
    # or by editing appsettings.json directly. Pre-0.1.1 installs get these
    # fields auto-applied by start.ps1's schema migration step (one-time
    # backfill on next upgrade) — see start.ps1:Apply-AppsettingsSchemaMigration.
    username                 = 'admin'
    password                 = 'YWRtaW4='         # base64('admin')
    port                     = 8080
    dashboardEnabled         = $true
    # 2026-10-02 R0.1.1+ — stamp version from version.inf so the agent
    # can self-report its build in heartbeats and the dashboard header.
    agentVersion             = $ReleaseVersion
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
    "AD Dashboard Agent (Member) v$ReleaseVersion"
  } else {
    "AD Replication Agent (on $env:COMPUTERNAME) v$ReleaseVersion"
  }
  $description = if ($AgentType -eq 'non-ad') {
    "AD Dashboard member-server monitor v$ReleaseVersion (self-register + heartbeat + package fetch)"
  } else {
    "AD Replication collection agent v$ReleaseVersion"
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
# Step 3.5 — Log retention (R158.60.11)
#
# NSSM rotates stdout/stderr at 10MB (AppRotateBytes=10485760, set in
# Set-NssmParameters). Rotated backups accumulate at <LogDir>\<svc>-*.log
# indefinitely; without a sweep the log directory grows until the disk fills.
# Register a daily 00:05 task that calls LogRetention.ps1 to delete backups
# older than 7 days. Live files (<svc>-stderr.log / -stdout.log with no
# timestamp suffix) are NEVER touched — NSSM holds an open handle and
# deleting them breaks the service.
#
# Best-effort: if LogRetention.ps1 is missing on the target machine (older
# ship) the function logs a warning and continues; the rest of the install
# (NSSM + service recovery + start) is unaffected. Re-running Register on
# the same machine overwrites the task with the same definition.
# ============================================================================
function Register-LogRetentionTask {
  $taskName = "ADDashboardAgent-LogRetention"
  $scriptPath = Join-Path $InstallPath 'LogRetention.ps1'
  if (-not (Test-Path -LiteralPath $scriptPath)) {
    Write-RWarn "LogRetention.ps1 not found at $scriptPath — skipping retention task registration (older ship template?)"
    return
  }
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -LogDir `"$LogDir`" -ServiceName `"$ServiceName`" -RetentionDays 7"
  $trigger = New-ScheduledTaskTrigger -Daily -At '00:05'
  # SYSTEM + ServiceAccount + RunLevel=Highest: same execution context as the
  # NSSM-wrapped service, no user password required at trigger time, no
  # interactive logon (Task Scheduler will not start the task if a user
  # principal is offline). -Force makes this idempotent — re-running
  # Register-ADDashboardAgent.ps1 just overwrites the task with the same
  # definition rather than prompting "task exists".
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -Compatibility 'Win8'
  try {
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
      -Principal $principal -Settings $settings -Force | Out-Null
    Write-ROk "registered scheduled task '$taskName' (daily 00:05, runs LogRetention.ps1)"
  } catch {
    Write-RWarn "Register-ScheduledTask '$taskName' failed: $($_.Exception.Message) — retention will not run automatically; install continues"
  }
}

# ============================================================================
# 崩溃重启循环检测 (服务状态 ≠ 应用存活)
# ============================================================================
# NSSM 配了 `AppExit Default Restart` + `AppRestartDelay 2000`
# (见本文件 Set-NssmParameters) ⇒ **服务状态永远是 Running**: NSSM 只是不停
# 把崩掉的 node 拉起来接着崩 ⇒ `Status -eq 'Running'` **不是**健康判据。
# R121 现场证据: 10 分钟崩 13 次, 而服务一直显示 Running —— 只看服务状态的
# 装机脚本会把一个崩溃重启循环的 agent 报成"启动成功"。
#
# 真正的判据: NSSM 拉起的 node 子进程在观察窗口内**还活着** (PID 没换)。
# NSSM 直接 spawn 应用 (nssm.exe -> node.exe) ⇒ 用 Win32_Process 的
# ParentProcessId 从服务 PID 反查那个 node.exe。
#
# 兜底 (父进程查不到时): 按注册表里 NSSM 记录的 Application 路径 + 命令行
# 含 agent.js 匹配 —— 某些包装层下应用不是 nssm.exe 的直接子进程。
#
# 返回 @{ ok = <bool>; detail = <string> }。
# CIM 不可用 ⇒ ok=$true (降级为"跳过检查") —— 判不出 ≠ 判为坏, 不能因为
# 探针不可用就把一次正常安装报成失败。
function Test-AgentProcessHealthy {
  param(
    [Parameter(Mandatory = $true)][string]$ServiceName,
    [int]$ObservationSeconds = 5,
    [int]$DiscoveryAttempts = 5
  )

  $allNodeProcs = @()
  try {
    $allNodeProcs = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop)
  } catch {
    return @{ ok = $true; detail = "process introspection unavailable ($($_.Exception.Message)) - crash-restart check skipped" }
  }

  # NSSM 记录的 Application (服务进程就是 nssm.exe, 由它 spawn 应用)
  $appPath = $null
  try {
    $paramKey = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName\Parameters"
    $appPath = (Get-ItemProperty -Path $paramKey -Name 'Application' -ErrorAction SilentlyContinue).Application
  } catch {
    $appPath = $null
  }

  # 发现阶段: NSSM 报 Running 与应用进程真正 spawn 之间有几百毫秒的窗口 ⇒
  # 查不到就重试几次, 避免把"还没 spawn"误判成"秒崩"。
  $candidates = @{}
  for ($attempt = 1; $attempt -le $DiscoveryAttempts; $attempt++) {
    $candidates = @{}
    $svcProcId = 0
    try {
      $svcWin32 = Get-CimInstance Win32_Service -Filter "Name = '$ServiceName'" -ErrorAction SilentlyContinue
      if ($svcWin32) { $svcProcId = [int]$svcWin32.ProcessId }
    } catch {
      $svcProcId = 0
    }
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
    if ($attempt -lt $DiscoveryAttempts) {
      Start-Sleep -Seconds 1
      try {
        $allNodeProcs = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop)
      } catch {
        break
      }
    }
  }

  $pids0 = @($candidates.Keys)
  if ($pids0.Count -eq 0) {
    return @{ ok = $false; detail = "the service '$ServiceName' is Running but no agent node.exe process could be found after $DiscoveryAttempts attempt(s) - the app either never started or died instantly (NSSM keeps restarting it)" }
  }

  # 观察窗口: 崩溃重启循环里的 node 会在 AppRestartDelay(2s) 内换新 PID
  Start-Sleep -Seconds $ObservationSeconds

  $alive = @()
  foreach ($p in $pids0) {
    if (Get-Process -Id $p -ErrorAction SilentlyContinue) { $alive += $p }
  }
  if ($alive.Count -lt $pids0.Count) {
    $dead = @($pids0 | Where-Object { $alive -notcontains $_ })
    return @{ ok = $false; detail = "the agent process died within ${ObservationSeconds}s of the service start (pid(s) $($dead -join ',') are gone; NSSM restarted the app) - crash-restart loop" }
  }
  return @{ ok = $true; detail = "agent process (pid $($pids0 -join ',')) survived the ${ObservationSeconds}s stabilization window" }
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
    $health = Test-AgentProcessHealthy -ServiceName $ServiceName
    if (-not $health.ok) {
      Write-RErr2 "$ServiceName is already Running but the agent process is NOT healthy: $($health.detail)"
      return $false
    }
    Write-ROk "$ServiceName already running; $($health.detail)"
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
      $health = Test-AgentProcessHealthy -ServiceName $ServiceName
      if (-not $health.ok) {
        Write-RErr2 "$ServiceName reached Running but the agent process is NOT healthy: $($health.detail)"
        return $false
      }
      Write-ROk "$ServiceName started; $($health.detail)"
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
  # R158.60.11 — also unregister the retention task so uninstall leaves
  # no Task Scheduler orphan pointing at <InstallPath>\LogRetention.ps1.
  $taskName = "ADDashboardAgent-LogRetention"
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($existing) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-ROk "unregistered scheduled task '$taskName'"
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
    Register-LogRetentionTask
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