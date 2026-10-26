# R158.X+UI.publish.deploy (2026-10-19) — verify.ps1
# 后续服务器 1-click verify ADDashboardCenter 部署健康.
# 6 维 verify (0 触凭证固化 / 0 落 NSSM 注册表真值):
#   1. node v22+        — runtime
#   2. nssm 2.24+       — service manager
#   3. .env 必填 KV     — DB_PWD/LICENSE_KEY/JWT_SECRET 0 空 (R158.95-ext 锁)
#   4. deps resolvable  — express/pino 能被 require 解析 (npm ci 装过)
#   5. service status   — RUNNING / STOPPED / not installed
#   6. /healthz         — HTTP 200 (就绪) / 503 (init 模式未初始化, 进程活着)
# 0 必任何 KV 真值到屏幕 (echo 仅 key 列表, 0 echo value).

$ErrorActionPreference = 'Stop'
$ServiceName = 'ADDashboardCenter'
$AppDir = (Resolve-Path "$PSScriptRoot\..").Path
$fail = 0

Write-Host "=== verify.ps1 ===" -ForegroundColor Cyan
Write-Host "AppDirectory: $AppDir"

# === nssm helpers (R160) ===
# 为什么需要这两个 helper:
#   1) PS 5.1 下只要 $ErrorActionPreference='Stop', 给原生 exe 加 2>&1 / 2>$null
#      都会把它的 stderr 提升成**终止性** RemoteException (实测:
#      `& cmd.exe /c 'echo oops 1>&2' 2>$null` 直接 TERMINATED)。nssm status 对
#      "服务不存在" 会往 stderr 写 "Can't open service!" 并 exit 3 —— 而"服务没装"
#      恰恰是未安装 / 已卸载的**正常路径**, 不该把脚本带崩。
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

# === 依赖探针 (R160) ===
# "依赖是否真的到位"的唯一判据: **能不能被 require 解析**, 不是 "node_modules 目录
# 存不存在"。npm workspaces (Server/package.json 的 workspaces = ["center","agent"])
# 会把依赖**提升到工作区根** —— 实测 Server/center/node_modules 根本不存在, 300+
# 个包全在 Server/node_modules ⇒ 用目录存在性判定 ⇒ 永远 FAIL, 哪怕安装完全正常。
# 探针优先复用主链实现 (Server/scripts/common/Service.psm1::Test-NodeDepsResolvable);
# 拿不到该模块 (绿色包布局不同 / 模块缺失) 就退化成同款本地 node -e 探测。
function Test-CenterDepsResolvable {
  param([Parameter(Mandatory)][string]$AppDir)
  # 目录都不存在 ⇒ 直接判"没装" (否则下面的 Push-Location 会抛一条裸错误)。
  if (-not (Test-Path -LiteralPath $AppDir)) { return $false }
  $modulePath = Join-Path $AppDir '..\scripts\common\Service.psm1'
  if (Test-Path -LiteralPath $modulePath) {
    try {
      # EAP 临时降级: 主链模块里的 node 探针用 `2>$null`, 在 EAP=Stop 下会被
      # PS 5.1 提升成终止性 RemoteException。
      $prevEap = $ErrorActionPreference
      try {
        $ErrorActionPreference = 'Continue'
        Import-Module $modulePath -Force -ErrorAction Stop
        if (Get-Command -Name Test-NodeDepsResolvable -ErrorAction SilentlyContinue) {
          return [bool](Test-NodeDepsResolvable -InstallPath $AppDir)
        }
      } finally {
        $ErrorActionPreference = $prevEap
      }
    } catch {
      Write-Host "WARN: Service.psm1 不可用, 退化为本地探针 ($($_.Exception.Message))" -ForegroundColor Yellow
    }
  }
  # 本地退化探针: node -e 的 require.resolve。JS 里不用任何引号 (PS 5.1 的原生
  # 参数解析器会把双引号吃掉); cwd 必须是 center 目录 —— node 从 cwd 往上找
  # node_modules, center/node_modules 不存在时会命中 Server/node_modules。
  $prevEap = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    Push-Location $AppDir
    try {
      foreach ($moduleName in @('express', 'pino')) {
        & node -e "try{require.resolve(process.argv[1]);process.exit(0)}catch(e){process.exit(1)}" $moduleName 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { return $false }
      }
    } finally {
      Pop-Location
    }
  } catch {
    return $false
  } finally {
    $ErrorActionPreference = $prevEap
  }
  return $true
}

# [1/6] node
try { $nodeVer = (node --version).Trim() } catch { Write-Host "[1/6] FAIL: node not found" -ForegroundColor Red; $fail++ }
if ($nodeVer) { Write-Host "[1/6] node: $nodeVer" }

# [2/6] nssm — 版本探测**不执行 `nssm --version`** (实测在本机会挂死: 15s / 120s
# 两次都是 exit 124 超时, stdout/stderr 全空), 改读 nssm.exe 的文件版本信息。
$NssmExe = Resolve-NssmExe
if (-not $NssmExe) {
  Write-Host "[2/6] FAIL: nssm not found (PATH + 常见安装位置都没有). Run: choco install nssm" -ForegroundColor Red
  $fail++
} else {
  $nssmVer = $null
  try { $nssmVer = (Get-Item -LiteralPath $NssmExe).VersionInfo.FileVersion } catch { $nssmVer = $null }
  if (-not $nssmVer) { $nssmVer = 'unknown (file found, no version info)' }
  Write-Host "[2/6] nssm: $nssmVer ($NssmExe)"
}

# [3/6] .env 必填 KV (0 echo value)
if (Test-Path "$AppDir\.env") {
  $envMap = @{}
  Get-Content "$AppDir\.env" | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]*)=(.*)$') { $envMap[$Matches[1].Trim()] = $Matches[2].Trim() }
  }
  $missing = @()
  foreach ($k in @('DB_PWD', 'LICENSE_KEY', 'JWT_SECRET')) {
    if (-not $envMap[$k] -or $envMap[$k] -eq '') { $missing += $k }
  }
  if ($missing.Count -gt 0) {
    Write-Host "[3/6] FAIL: .env missing KV: $($missing -join ', ')" -ForegroundColor Red
    $fail++
  } else {
    Write-Host "[3/6] .env: 3/3 必填 KV (DB_PWD / LICENSE_KEY / JWT_SECRET) OK (value 0 echo)"
  }
} else {
  Write-Host "[3/6] FAIL: .env not found. Run: copy .env.example .env + 填真值" -ForegroundColor Red
  $fail++
}

# [4/6] 依赖可解析 (0 看 node_modules 目录是否存在 — workspaces 会把依赖提升到根)
if (Test-CenterDepsResolvable -AppDir $AppDir) {
  $pkgRoot = Join-Path $AppDir '..\node_modules'
  $depCount = 0
  if (Test-Path -LiteralPath $pkgRoot) { $depCount = (Get-ChildItem -LiteralPath $pkgRoot -Directory -ErrorAction SilentlyContinue).Count }
  Write-Host "[4/6] deps: express/pino 可被 require 解析 ($depCount packages @ $pkgRoot)"
} else {
  Write-Host "[4/6] FAIL: 依赖不可解析 (express/pino). Run: npm ci --omit=dev" -ForegroundColor Red
  $fail++
}

# [5/6] service status
if (-not $NssmExe) {
  Write-Host "[5/6] skip service status (nssm not found, 见 [2/6])" -ForegroundColor Yellow
  $svcStatus = $null
} else {
  $svcStatus = Get-NssmServiceStatus -Name $ServiceName -Exe $NssmExe
  if ($null -ne $svcStatus) {
    Write-Host "[5/6] service $ServiceName : $svcStatus"
  } else {
    Write-Host "[5/6] service not installed. Run: .\deploy\install-service.ps1" -ForegroundColor Yellow
  }
}

# [6/6] /healthz (仅 when service running)
if ($svcStatus -match 'SERVICE_RUNNING') {
  $port = 8080
  if (Test-Path "$AppDir\.env") {
    $cfg = Get-Content "$AppDir\.env" | Where-Object { $_ -match '^PORT=' }
    if ($cfg -match '^PORT=(\d+)') { $port = $Matches[1] }
  }
  # 200 = 完全就绪; 503 = 进程活着但还没初始化 (init 模式) —— 属正常, 不算失败。
  $healthCode = Get-HealthStatusCode -Url "http://localhost:$port/healthz"
  if ($healthCode -eq 200) {
    Write-Host "[6/6] health: 200 OK (fully ready)" -ForegroundColor Green
  } elseif ($healthCode -eq 503) {
    Write-Host "[6/6] health: 503 (进程活着, 未初始化 — init 模式属正常)" -ForegroundColor Yellow
  } else {
    Write-Host "[6/6] FAIL: health check failed (code=$healthCode)" -ForegroundColor Red
    $fail++
  }
} else {
  Write-Host "[6/6] skip health check (service not running)"
}

Write-Host ""
if ($fail -eq 0) { Write-Host "=== verify.ps1 PASS (6/6) ===" -ForegroundColor Green; exit 0 }
else { Write-Host "=== verify.ps1 FAIL ($fail 项) ===" -ForegroundColor Red; exit 1 }
