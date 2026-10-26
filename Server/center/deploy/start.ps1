# R158.X+UI.publish.deploy (2026-10-19) — start.ps1
# 后续服务器 1-click 启动 ADDashboardCenter Windows 服务.
# 0 落 NSSM AppEnvironmentExtra 真值到注册表 (R158.95-ext DB password 锁 + 操作员 directive "0 copy 真值"):
#   - .env 必操作员手动维护 (cp .env.example .env + 填 DB_PWD/LICENSE_KEY/JWT_SECRET)
#   - NSSM 仅 set AppEnvironmentExtra PORT/NODE_ENV/LOG_DIR (3 个非敏感)
#   - DB_PWD/LICENSE_KEY/JWT_SECRET 由 server.js 启动时 dotenv 读 (NSSM 0 落注册表)
#   - 这样后续服务器操作员 copy 镜像后 0 必传 .env 真值到 NSSM, register 流程 0 触凭证固化
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File .\deploy\start.ps1
# 选参:
#   -Force  强制 start (即使 status=running 也 stop + start)
#   -Wait   start 后等 5s + verify /healthz (200 = 就绪, 503 = init 模式未初始化)

param(
  [switch]$Force,
  [switch]$Wait
)

$ErrorActionPreference = 'Stop'
$ServiceName = 'ADDashboardCenter'
$AppDir = (Resolve-Path "$PSScriptRoot\..").Path

Write-Host "=== start.ps1 ===" -ForegroundColor Cyan

# === nssm helpers (R160) ===
# 为什么需要这两个 helper:
#   1) PS 5.1 下只要 $ErrorActionPreference='Stop', 给原生 exe 加 2>&1 / 2>$null
#      都会把它的 stderr 提升成**终止性** RemoteException (实测:
#      `& cmd.exe /c 'echo oops 1>&2' 2>$null` 直接 TERMINATED)。nssm status 对
#      "服务不存在" 会往 stderr 写 "Can't open service!" 并 exit 3 —— 而"服务没装"
#      恰恰是首次安装 / 已卸载的**正常路径**, 不该把脚本带崩。
#      nssm 的 stdout/stderr 分离是可靠的: 状态文本在 stdout, 错误在 stderr,
#      所以用 EAP=Continue + $LASTEXITCODE 判定, **不合并** stderr。
#   2) nssm 的 stdout 是 **UTF-16LE** (实测字节 53 00 45 00 52 00 ...)。PowerShell
#      按 [Console]::OutputEncoding 解码 ⇒ 得到的字符串每个字符后面夹一个 NUL
#      ("S\x00E\x00R\x00...") ⇒ `-match 'SERVICE_RUNNING'` 永远为假 (PS 5.1 / PS 7
#      实测都是 False) ⇒ 比对前必须先把 NUL 去掉。
function Resolve-NssmExe {
  # 找 nssm.exe: 先看 PATH, 再看常见安装位置; 找不到返回 $null, 让调用方给出明确
  # 报错 (而不是崩在 CommandNotFoundException 上)。找到但不在 PATH 上时, 把它的
  # 目录加进**本次会话**的 PATH, 这样后面所有 `nssm ...` 裸调用仍然可用。
  $cmd = Get-Command nssm -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    'C:\Tools\nssm\win64\nssm.exe',
    'C:\Tools\nssm-2.24\win64\nssm.exe',
    (Join-Path $PSScriptRoot '..\..\publish\system\nssm\nssm.exe'),
    (Join-Path $PSScriptRoot '..\..\nssm\nssm.exe')
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      $resolved = (Resolve-Path -LiteralPath $candidate).Path
      $dir = Split-Path -Parent $resolved
      if (($env:PATH -split ';') -notcontains $dir) { $env:PATH = "$dir;$env:PATH" }
      return $resolved
    }
  }
  return $null
}

function Get-NssmServiceStatus {
  # 返回 nssm status 的状态文本 (已去掉 UTF-16LE 解码残留的 NUL);
  # 服务未注册 (exit 3 + stdout 空) 时返回 $null —— 调用方据此判"装没装"。
  param(
    [Parameter(Mandatory)][string]$Name,
    [string]$Exe
  )
  # 调用方没找到 nssm.exe 时 $Exe 为空 ⇒ 视同"状态未知" ⇒ $null (而不是崩在
  # 参数绑定上)。
  if (-not $Exe) { return $null }
  $prevEap = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $out = & $Exe status $Name 2>$null
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prevEap
  }
  if ($code -ne 0) { return $null }
  return ((($out | Out-String) -replace [char]0, '').Trim())
}

# === /healthz 健康探测 helper (R160) ===
# 端点是 **/healthz**, 不是 /api/health —— center/src/app.js 把 healthzRouter 挂在
# 根路径 /healthz; 而 SPA fallback 的正则
#   app.get(/^\/(?!api\/|healthz|config\.json|mcp\/|mcp-write\/).*/)
# 把 api/ 排除在外 ⇒ /api/health 必然 404, 健康的系统也会被判 FAIL。
# 接受 200 和 503: 200 = 完全就绪; 503 = 进程活着但还没初始化 (init 模式), 属**正常**。
# Invoke-WebRequest 对非 2xx 会抛异常, 所以状态码要从异常对象里取回来
# (PS 5.1 = WebException.Response.StatusCode, PS 7 = HttpResponseException.Response
# .StatusCode); 两个都取不到 = 连不上 (服务没起来)。
function Get-HealthStatusCode {
  param([Parameter(Mandatory)][string]$Url, [int]$TimeoutSec = 5)
  try {
    $r = Invoke-WebRequest $Url -UseBasicParsing -TimeoutSec $TimeoutSec
    return [int]$r.StatusCode
  } catch {
    $response = $null
    try { $response = $_.Exception.Response } catch { $response = $null }
    if ($null -ne $response) {
      try { return [int]$response.StatusCode } catch { return 0 }
    }
    return 0
  }
}

$NssmExe = Resolve-NssmExe
if (-not $NssmExe) { Write-Host "ERR: nssm not found. Run: choco install nssm" -ForegroundColor Red; exit 1 }

# verify service 已注册
$status = Get-NssmServiceStatus -Name $ServiceName -Exe $NssmExe
if ($null -eq $status) {
  Write-Host "ERR: service $ServiceName not installed. Run: .\deploy\install-service.ps1" -ForegroundColor Red
  exit 1
}
Write-Host "[1/3] service status: $status"

# idempotent: 已 running 0 必重复 start (除非 -Force)
if ($status -match 'SERVICE_RUNNING' -and -not $Force) {
  Write-Host "[2/3] service already running, skip start (use -Force to restart)"
} else {
  if ($status -match 'SERVICE_RUNNING' -and $Force) {
    Write-Host "[2/3] -Force: stop + start"
    # `2>&1` 在 PS 5.1 + EAP=Stop 下会因 nssm 的 stderr 直接终止脚本; 这里不重定向
    # stderr (nssm 的报错仍会打到控制台), 只用 Out-Null 吞掉 stdout。
    nssm stop $ServiceName | Out-Null
    nssm rotate $ServiceName | Out-Null
    Start-Sleep -Seconds 2
  }
  nssm start $ServiceName
  if ($LASTEXITCODE -ne 0) { Write-Host "ERR: nssm start failed (exit $LASTEXITCODE)" -ForegroundColor Red; exit 1 }
  Write-Host "[2/3] nssm start: OK"
}

# === 步骤 3: verify (选 -Wait) ===
if ($Wait) {
  Write-Host "[3/3] waiting 5s + health check ..."
  Start-Sleep -Seconds 5
  $port = 8080
  if (Test-Path "$AppDir\.env") {
    $cfg = Get-Content "$AppDir\.env" | Where-Object { $_ -match '^PORT=' }
    if ($cfg -match '^PORT=(\d+)') { $port = $Matches[1] }
  }
  # 200 = 完全就绪; 503 = 进程活着但还没初始化 (init 模式) —— 属正常, 不算失败。
  $healthCode = Get-HealthStatusCode -Url "http://localhost:$port/healthz"
  if ($healthCode -eq 200) { Write-Host "[3/3] health: 200 OK (fully ready)" -ForegroundColor Green }
  elseif ($healthCode -eq 503) { Write-Host "[3/3] health: 503 (进程活着, 未初始化 — init 模式属正常)" -ForegroundColor Yellow }
  elseif ($healthCode -gt 0) { Write-Host "WARN: health: $healthCode" -ForegroundColor Yellow }
  else { Write-Host "WARN: health check failed (连不上 http://localhost:$port/healthz)" -ForegroundColor Yellow }
  Write-Host "Tail Logs\service-stdout.log (last 20 lines):"
  if (Test-Path "$AppDir\Logs\service-stdout.log") { Get-Content "$AppDir\Logs\service-stdout.log" -Tail 20 }
} else {
  Write-Host "[3/3] skip wait + health check (use -Wait to verify)"
}

Write-Host ""
Write-Host "=== start.ps1 DONE ===" -ForegroundColor Green
Write-Host "Verify: Get-Service $ServiceName | Select Status, StartType"
Write-Host "Stop:   powershell -ExecutionPolicy Bypass -File .\deploy\stop.ps1"
Write-Host "Logs:   Get-Content .\Logs\service-stdout.log -Wait -Tail 20"
