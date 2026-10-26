# start-dashboard.ps1 — 本地监控面板启动器(CLI 自启模式)
#
# 启动逻辑:
#   1. 检查端口占用(预检,避免 Node 启动后才发现冲突)
#   2. 读 agent/appsettings.json 中的 port(默认 8080),也可以用 -Port 临时覆盖
#   3. 启动 node dashboard/server.js,前台运行(Ctrl-C 干净退出)
#   4. -Background 改为后台运行
#
# 注意:这是 dashboard 的独立 CLI 模式,用于**开发和调试**。生产环境由
# `agent/agent.js` 通过 `startDashboard()` in-process 启动 dashboard,
# 共用同一个 Node 进程、事件循环、文件句柄。改密码也由 agent 进程直接写
# appsettings.json,不需要走 IPC。
[CmdletBinding()]
param(
  [int]$Port,
  [switch]$OpenBrowser,
  [switch]$Background
)

$ErrorActionPreference = 'Stop'

$rootDir = $PSScriptRoot
$logDir  = Join-Path $rootDir 'Logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

# 加载 Logger
Import-Module (Join-Path $rootDir 'common\Logger.psm1') -Force
Set-LogDir $logDir

trap { if ($_.Exception) { Write-Err2 $_.Exception.Message }; continue }

# 解析 node
$nodeExe = $null
$bundledNode = Join-Path $rootDir 'node\node.exe'
if (Test-Path $bundledNode) { $nodeExe = $bundledNode }
else {
  $onPath = (Get-Command node.exe -ErrorAction SilentlyContinue)
  if ($onPath) { $nodeExe = $onPath.Source }
}
if (-not $nodeExe) { throw 'node.exe not found (no bundled node/, no PATH).' }

# 解析 dashboard 路径
$dashboardDir = Join-Path $rootDir 'dashboard'
$serverJs = Join-Path $dashboardDir 'server.js'
if (-not (Test-Path $serverJs)) { throw "dashboard\server.js not found at $dashboardDir" }

# 决定端口:CLI > appsettings.json > 默认 8080
$effectivePort = $Port
if (-not $effectivePort) {
  $appJson = Join-Path $rootDir 'agent\appsettings.json'
  $exampleJson = Join-Path $rootDir 'agent\appsettings.example.json'
  $cfgRaw = $null
  if (Test-Path $appJson)      { $cfgRaw = Get-Content $appJson -Raw -Encoding UTF8 }
  elseif (Test-Path $exampleJson) { $cfgRaw = Get-Content $exampleJson -Raw -Encoding UTF8 }
  if ($cfgRaw) {
    try {
      $cfg = $cfgRaw | ConvertFrom-Json -ErrorAction Stop
      if ($cfg.port) { $effectivePort = [int]$cfg.port }
    } catch { Write-Warn2 "appsettings.json parse failed: $($_.Exception.Message)" }
  }
  if (-not $effectivePort) { $effectivePort = 8080 }
}

# 端口冲突预检
# R161.8 (2026-10-26) — 原实现把本机网卡地址**写死成某一个具体地址**
#   (那是当初开发那台机器的 LAN 地址)。换机后的缺陷: 监听在 192.168.x.x /
#   10.x.x.x 等**本机**地址上的同名端口进程检不出来 ⇒ 预检放行 ⇒ 真正 bind
#   时才 EADDRINUSE 崩，且报错信息指向 start-dashboard 而不是真实占用者。
#   改为运行时枚举本机所有单播地址 + 回环/通配符字面量。
$localAddresses = @('127.0.0.1', '::1', '0.0.0.0', '::')
try {
  $localAddresses += @(
    [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
      ForEach-Object { $_.GetIPProperties().UnicastAddresses } |
      ForEach-Object { ($_.Address.ToString() -split '%')[0] } |
      Where-Object { $_ }
  )
} catch {
  Write-Warn2 "local address enumeration failed (fallback: loopback/wildcard only): $($_.Exception.Message)"
}
$localAddresses = @($localAddresses | Select-Object -Unique)
$listener = Get-NetTCPConnection -LocalPort $effectivePort -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $localAddresses -contains ((([string]$_.LocalAddress) -split '%')[0]) }
if ($listener) {
  throw "port $effectivePort is already in use (pid=$($listener[0].OwningProcess)). Re-run with -Port <other>."
}

Write-Step "starting dashboard on http://127.0.0.1:$effectivePort/  (logs: $logDir\dashboard-*.log)"

# 启动参数
$nodeArgs = @('dashboard/server.js')
if ($Port) { $nodeArgs += @('--port', "$Port") }

$stdoutLog = Join-Path $logDir 'dashboard-stdout.log'
$stderrLog = Join-Path $logDir 'dashboard-stderr.log'

if ($Background) {
  $proc = Start-Process -FilePath $nodeExe `
    -ArgumentList $nodeArgs `
    -WorkingDirectory $rootDir `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -WindowStyle Hidden `
    -PassThru
  Write-Ok "started in background, PID=$($proc.Id)"
  if ($OpenBrowser) { Start-Sleep -Seconds 1; Start-Process "http://127.0.0.1:$effectivePort/" }
  return
}

if ($OpenBrowser) {
  Start-Job -ScriptBlock {
    param($url)
    Start-Sleep -Milliseconds 800
    Start-Process $url
  } -ArgumentList "http://127.0.0.1:$effectivePort/" | Out-Null
}

# 前台启动,Ctrl-C 干净退出
& $nodeExe @nodeArgs
