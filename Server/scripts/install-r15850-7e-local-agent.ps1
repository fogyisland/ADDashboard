# install-r15850-7e-local-agent.ps1
# One-shot installer for operator's local agent.
#
# Why this script:
#   D:\agentInstall\agent\ has 0.1.2 source (agent.js + build-manifest.json
#   synced by R158.50.7e) + 119 npm packages already installed, but no
#   appsettings.json and no nssm service. This script:
#     1. Writes appsettings.json (UTF-8 NO BOM)
#     2. Registers ADReplicationAgent nssm service
#     3. Sets service recovery (NSSM AppExit + sc.exe failure)
#     4. Starts the service
#
# Pre-req:
#   - D:\dashboard\agent\agent.js contains VERSION='0.1.2' (R158.50.7e)
#   - D:\agentInstall\agent\node_modules\ has 119 packages (KDL true install
#     bundle, copied 2026-10-02 by R158.48)
#   - D:\agentInstall\agent\agent.js has been synced from D:\dashboard\agent\
#     (sha 971A55B851C4)
#
# Run on operator host:
#   powershell -ExecutionPolicy Bypass -File install-r15850-7e-local-agent.ps1

[CmdletBinding()]
param(
  # R160 (2026-10-25) — 明文 agent token 不再硬编码在仓库里。
  # 旧实现把一个**真实可用**的 token 写死在源码中: 任何拿到这个仓库/脚本
  # 的人都能以这台 agent 的身份向中心注册、拉取升级包 ⇒ 凭据泄露。
  # 该 token 已经泄漏, 必须在中心侧轮换 (agent_token / appsettings)。
  # 现在从参数或环境变量读取, 缺了就当场失败 —— 绝不"空 token 装上去"。
  [string]$AgentToken = $env:ADDASHBOARD_AGENT_TOKEN
)

$ErrorActionPreference = 'Stop'

$InstallPath = 'D:\agentInstall\agent'
$agentInstallRoot = 'D:\agentInstall'
$CenterUrl   = 'http://localhost:8080'
$ServiceName = 'ADReplicationAgent'

if ([string]::IsNullOrWhiteSpace($AgentToken)) {
    throw "agent token missing. Pass -AgentToken '<token>' or set `$env:ADDASHBOARD_AGENT_TOKEN. (The token previously hardcoded in this script has been removed and MUST be rotated on the center side.)"
}

# Pre-flight: confirm files are in place
if (-not (Test-Path (Join-Path $InstallPath 'agent.js'))) {
    throw "FAIL: $InstallPath\agent.js missing"
}
if (-not (Test-Path (Join-Path $InstallPath 'build-manifest.json'))) {
    throw "FAIL: $InstallPath\build-manifest.json missing"
}
if (-not (Test-Path (Join-Path $InstallPath 'node_modules'))) {
    throw "FAIL: $InstallPath\node_modules missing (run npm install first)"
}

# Confirm agent.js reads VERSION from version.inf (R158.50.7e fix)
$agentJsContent = Get-Content (Join-Path $InstallPath 'agent.js') -Raw
if ($agentJsContent -notmatch 'function readVersionFromInf') {
    throw "FAIL: agent.js does not contain readVersionFromInf() — R158.50.7e fix not applied."
}
if ($agentJsContent -match "const VERSION\s*=\s*['\`]0\.1\.\d+['\`]\s*;") {
    throw "FAIL: agent.js still has a hardcoded VERSION literal — should read from version.inf."
}
# Confirm version.inf has agent = 0.1.2
$viLines = Get-Content (Join-Path $agentInstallRoot 'version.inf')
$agentVerLine = $viLines | Where-Object { $_ -match '^\s*agent\s*=' } | Select-Object -First 1
if (-not $agentVerLine -or $agentVerLine -notmatch '=\s*0\.1\.2') {
    throw "FAIL: version.inf agent line not 0.1.2. Currently: $agentVerLine"
}
Write-Host "✓ agent.js reads VERSION from version.inf; version.inf agent = 0.1.2"

# Confirm center is up
try {
    $r = Invoke-WebRequest -Uri "$CenterUrl/api/dashboard/agents" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
    Write-Host "✓ centre web port 8080 reachable, status $($r.StatusCode)"
} catch {
    Write-Host "⚠ centre web port 8080 NOT reachable yet): $($_.Exception.Message)"
    Write-Host "  (continuing — service will retry on first heartbeat)"
}

# Step 1: write appsettings.json (UTF-8 NO BOM — R93 round-8 fix)
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
    agentType                = 'ad'
}
$jsonPath = Join-Path $InstallPath 'appsettings.json'
$json = $cfg | ConvertTo-Json
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($jsonPath, $json, $utf8NoBom)
Write-Host "✓ wrote $jsonPath (utf8 no-bom)"

# Step 2: locate nssm.exe
$NssmPath = $null
$candidates = @(
    (Join-Path $InstallPath 'nssm\nssm.exe'),
    'D:\dashboard\nssm\nssm.exe',
    (Join-Path $PSScriptRoot 'nssm\nssm.exe'),
    'C:\Tools\nssm\win64\nssm.exe',
    'C:\Tools\nssm-2.24\win64\nssm.exe'
)
foreach ($p in $candidates) {
    if (Test-Path $p) { $NssmPath = $p; break }
}
if (-not $NssmPath) {
    throw "nssm.exe not found at: $($candidates -join ' / '). Install NSSM first."
}
Write-Host "✓ using nssm: $NssmPath"

# Step 3: locate node.exe
$NodePath = $null
$nodeCandidates = @(
    (Join-Path $InstallPath 'node\node.exe'),
    (Join-Path $PSScriptRoot 'node\node.exe'),
    'C:\Program Files\nodejs\node.exe'
)
foreach ($p in $nodeCandidates) {
    if (Test-Path $p) { $NodePath = $p; break }
}
if (-not $NodePath) {
    throw "node.exe not found at: $($nodeCandidates -join ' / ')"
}
Write-Host "✓ using node: $NodePath"

# Step 4: nssm install (idempotent)
# 统一封装: 每个 nssm 调用都查退出码。旧实现 `& $NssmPath set ... | Out-Null`
# 一律不查 —— 参数名不被 2.24 支持 / 权限不足 / 服务名不存在, 全部静默
# 通过, 脚本照样打印 "✓ nssm parameters set", 而服务起来是残的。
function Invoke-NssmChecked {
    param([Parameter(Mandatory)][string[]]$Arguments)
    & $NssmPath @Arguments | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "nssm $($Arguments -join ' ') failed: $LASTEXITCODE"
    }
}

$existed = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existed) {
    Write-Host "service $ServiceName already installed"
} else {
    # 不手工加引号 —— PowerShell 自己会给含空格的参数加引号, 再加一层
    # 会让 nssm 收到带字面引号的路径 (实测 argv 形态), 服务启动时找不到 exe。
    Invoke-NssmChecked @('install', $ServiceName, $NodePath)
    Write-Host "✓ nssm installed $ServiceName"
}

# Step 5: nssm parameters
# 先把重定向日志目录建出来 —— NSSM 启动时打不开重定向文件会报
# "Failed to create redirection file" 并让服务起不来。旧实现**从不**创建
# <InstallPath>\Logs, 于是这一步之后是"服务已注册、参数已配好、但起不来"
# 的半成品, 而且 stdout/stderr 全丢。
$agentLogDir = Join-Path $InstallPath 'Logs'
if (-not (Test-Path -LiteralPath $agentLogDir)) {
    New-Item -ItemType Directory -Path $agentLogDir -Force | Out-Null
    Write-Host "✓ created $agentLogDir"
}

Invoke-NssmChecked @('set', $ServiceName, 'AppDirectory', $InstallPath)
Invoke-NssmChecked @('set', $ServiceName, 'AppParameters', 'agent.js')
Invoke-NssmChecked @('set', $ServiceName, 'DisplayName', "AD Replication Agent (on $env:COMPUTERNAME)")
Invoke-NssmChecked @('set', $ServiceName, 'Description', 'AD Replication collection agent')
Invoke-NssmChecked @('set', $ServiceName, 'Start', 'SERVICE_AUTO_START')
Invoke-NssmChecked @('set', $ServiceName, 'DependOnService', 'DNS Client', 'Netlogon')
Invoke-NssmChecked @('set', $ServiceName, 'AppStdout', (Join-Path $agentLogDir "$ServiceName-stdout.log"))
Invoke-NssmChecked @('set', $ServiceName, 'AppStderr', (Join-Path $agentLogDir "$ServiceName-stderr.log"))
Invoke-NssmChecked @('set', $ServiceName, 'AppRotateFiles', '1')
Invoke-NssmChecked @('set', $ServiceName, 'AppRotateOnline', '1')
Invoke-NssmChecked @('set', $ServiceName, 'AppRotateBytes', '10485760')
Invoke-NssmChecked @('set', $ServiceName, 'AppEnvironmentExtra', 'NODE_ENV=production')
Write-Host "✓ nssm parameters set"

# Step 6: service recovery
Invoke-NssmChecked @('set', $ServiceName, 'AppExit', 'Default', 'Restart')
Invoke-NssmChecked @('set', $ServiceName, 'AppRestartDelay', '2000')
$p = Start-Process -FilePath 'sc.exe' -ArgumentList @('failure', $ServiceName, 'reset=', '60', 'actions=', 'restart/5000/restart/10000/restart/30000') -NoNewWindow -Wait -PassThru
if ($p.ExitCode -ne 0) {
    throw "sc.exe failure $ServiceName failed: exit $($p.ExitCode)"
}
Write-Host "✓ service recovery set"

# Step 7: start
$svc = Get-Service -Name $ServiceName
if ($svc.Status -eq 'Running') {
    Write-Host "✓ $ServiceName already running"
} else {
    Start-Service -Name $ServiceName -ErrorAction Stop
    for ($i = 0; $i -lt 20; $i++) {
        if ((Get-Service -Name $ServiceName).Status -eq 'Running') {
            Write-Host "✓ $ServiceName started"
            break
        }
        Start-Sleep 1
    }
}

Write-Host ""
Write-Host "VERIFICATION:"
# 旧实现打印 `agent.js:58 : $line58` —— $line58 从未赋值 ⇒ 永远是一行空,
# 看着像有版本信息, 实际什么都没有。改成打印真正读到的东西。
Write-Host "  agent version (version.inf): $agentVerLine"
Write-Host "  build version: $((Get-Content (Join-Path $InstallPath 'build-manifest.json') -Raw | ConvertFrom-Json).version)"
Write-Host "  service state: $((Get-Service -Name $ServiceName).Status)"
Write-Host ""
Write-Host "NEXT STEPS:"
Write-Host "  1. Wait 30s for first heartbeat"
Write-Host "  2. Check D:\agentInstall\agent\Logs\ADReplicationAgent-stdout.log"
Write-Host "  3. Verify centre sees operator host as agentVersion='0.1.2'"
Write-Host "  4. For KDLFLOFADSRV2: rerun KDL update path (file sync + nssm restart)"