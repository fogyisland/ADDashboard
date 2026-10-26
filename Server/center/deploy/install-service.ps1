# R158.X+UI.publish.deploy (2026-10-19) — install-service.ps1
# 后续服务器 1-click 注册 ADDashboardCenter Windows 服务.
# 0 落 NSSM AppEnvironmentExtra 真值到注册表 (R158.95-ext DB password 锁 + 操作员 directive "0 copy 真值"):
#   - .env 必操作员手动维护 (cp .env.example .env + 填 DB_PWD/LICENSE_KEY/JWT_SECRET)
#   - NSSM 仅 set AppEnvironmentExtra PORT/NODE_ENV/LOG_DIR (3 个非敏感)
#   - DB_PWD/LICENSE_KEY/JWT_SECRET 由 server.js 启动时 dotenv 读 (NSSM 0 落注册表)
#   - 这样后续服务器操作员 copy 镜像后 0 必传 .env 真值到 NSSM, register 流程 0 触凭证固化
#
# 用法 (RDP 到 target server 后):
#   powershell -ExecutionPolicy Bypass -File .\deploy\install-service.ps1
#
# 必预跑:
#   - Node.js v22+ (https://nodejs.org or choco install nodejs)
#   - NSSM 2.24+ (https://nssm.cc or choco install nssm)
#   - .env 真值已填 (DB_PWD / LICENSE_KEY / JWT_SECRET)
#
# 步骤:
#   1. verify node / nssm / .env (3 必填 KV 0 空)
#   2. npm ci (装 22 deps, --omit=dev)
#   3. nssm install (幂等: 已存在 0 覆盖, 0 必先 uninstall)
#   4. nssm set AppDirectory / log / rotate / restart (0 sensitive KV)
#   5. ensure Logs dir

$ErrorActionPreference = 'Stop'
$ServiceName = 'ADDashboardCenter'
$AppDir = (Resolve-Path "$PSScriptRoot\..").Path

Write-Host "=== install-service.ps1 ===" -ForegroundColor Cyan
Write-Host "Service: $ServiceName"
Write-Host "AppDirectory: $AppDir"

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

# === 步骤 1: verify deps ===
try { $nodeVer = (node --version).Trim() } catch { Write-Host "ERR: node not found. Run: choco install nodejs" -ForegroundColor Red; exit 1 }
Write-Host "[1/5] node: $nodeVer"

# nssm 版本探测: **绝对不要执行 `nssm --version`** —— 实测在本机会挂死
# (15s / 120s 两次都是 exit 124 超时, stdout/stderr 全空), 会把整条安装链卡住。
# 改读 nssm.exe 的文件版本信息 (VersionInfo.FileVersion → "2.24");
# FileVersion 为空就退回"文件存在"判定。
$NssmExe = Resolve-NssmExe
if (-not $NssmExe) { Write-Host "ERR: nssm not found. Run: choco install nssm" -ForegroundColor Red; exit 1 }
$nssmVer = $null
try { $nssmVer = (Get-Item -LiteralPath $NssmExe).VersionInfo.FileVersion } catch { $nssmVer = $null }
if (-not $nssmVer) { $nssmVer = 'unknown (file found, no version info)' }
Write-Host "[2/5] nssm: $nssmVer ($NssmExe)"

# verify .env 必填 KV 0 空 (0 echo value, 仅 check 存在)
if (-not (Test-Path "$AppDir\.env")) { Write-Host "ERR: .env not found. Run: copy .env.example .env + 填真值" -ForegroundColor Red; exit 1 }
$envMap = @{}
Get-Content "$AppDir\.env" | ForEach-Object {
  if ($_ -match '^\s*([^#][^=]*)=(.*)$') { $envMap[$Matches[1].Trim()] = $Matches[2].Trim() }
}
$missing = @()
foreach ($k in @('DB_PWD', 'LICENSE_KEY', 'JWT_SECRET')) {
  if (-not $envMap[$k] -or $envMap[$k] -eq '') { $missing += $k }
}
if ($missing.Count -gt 0) {
  Write-Host "ERR: .env missing KV: $($missing -join ', ')" -ForegroundColor Red
  Write-Host "Run: notepad .env + 填 DB_PWD / LICENSE_KEY / JWT_SECRET" -ForegroundColor Yellow
  exit 1
}
Write-Host "[3/5] .env: 3/3 必填 KV OK (value 0 echo)"

# === 依赖探针 (R160) ===
# "依赖是否真的到位"的唯一判据: **能不能被 require 解析**, 不是 "node_modules 目录
# 存不存在"。npm workspaces (Server/package.json 的 workspaces = ["center","agent"])
# 会把依赖**提升到工作区根** —— 实测 Server/center/node_modules 根本不存在, 300+
# 个包全在 Server/node_modules ⇒ 用目录存在性判定 ⇒ 永远为假 ⇒ 每次都重跑 npm ci
# (而 --omit=dev 还会顺手把根 node_modules 里的 vite / vitest 剪掉, 之后本地
# `npm run build:web` 直接 "vite: not found")。
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

# === 步骤 2: npm ci ===
if (Test-CenterDepsResolvable -AppDir $AppDir) {
  Write-Host "[4/5] deps: 已可解析 (express/pino), skip npm ci"
} else {
  Write-Host "[4/5] npm ci ... (装 22 deps, --omit=dev)"
  Push-Location $AppDir
  $npmOutput = ''
  $npmExit = 0
  try {
    # PS 5.1 原生命令 stderr 陷阱: EAP=Stop 时 npm 往 stderr 写任何内容 (哪怕是
    # 普通进度输出) 都会把脚本带崩; 而 `2>&1 | Select-Object -Last 20` 还会把真正
    # 的失败原因吞掉。改成 EAP=Continue + $LASTEXITCODE 判定, 失败时把捕获到的
    # 尾部文本一起报出来。
    $prevEap = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      $npmOutput = (& npm ci --omit=dev 2>&1 | Out-String)
      $npmExit = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $prevEap
    }
  } finally {
    Pop-Location
  }
  if ($npmExit -ne 0) {
    Write-Host "ERR: npm ci failed (exit $npmExit)" -ForegroundColor Red
    $tail = (($npmOutput -split "`r?`n") | Where-Object { $_.Trim() -ne '' } | Select-Object -Last 20) -join "`n"
    if ($tail) { Write-Host "npm ci 输出 (尾部 20 行):" -ForegroundColor Yellow; Write-Host $tail -ForegroundColor Yellow }
    exit 1
  }
  Write-Host "[4/5] npm ci: OK"
  if (-not (Test-CenterDepsResolvable -AppDir $AppDir)) {
    Write-Host "ERR: npm ci 跑完了, 但依赖仍不可解析 (express/pino)" -ForegroundColor Red
    exit 1
  }
}

# === 步骤 3: nssm install (幂等: 已存在 0 覆盖, 0 必先 uninstall) ===
$existing = Get-NssmServiceStatus -Name $ServiceName -Exe $NssmExe
if ($existing) {
  Write-Host "[5/5] service already installed: $ServiceName" -ForegroundColor Yellow
  $reinstall = Read-Host "Reinstall? (y/N)"
  if ($reinstall -ne 'y') { Write-Host "skip install, exit"; exit 0 }
  Write-Host "uninstall existing first ..."
  # `2>&1` 在 PS 5.1 + EAP=Stop 下会因 nssm 的 stderr 直接终止脚本; 这里不重定向
  # stderr (nssm 的报错仍会打到控制台, 操作员看得见), 只用 Out-Null 吞掉 stdout。
  nssm stop $ServiceName | Out-Null
  nssm remove $ServiceName confirm
}

nssm install $ServiceName node server.js
if ($LASTEXITCODE -ne 0) { Write-Host "ERR: nssm install failed" -ForegroundColor Red; exit 1 }
Write-Host "[5/5] nssm install: OK"

# === 步骤 4: nssm set (0 sensitive KV 落注册表) ===
# **Logs 目录必须先于 nssm set 存在** (R160 修):
#   AppStdout / AppStderr 指向 $AppDir\Logs\*.log, 而 nssm 在**服务启动时**才去
#   打开这两个文件 —— 目标目录不存在 ⇒ nssm 打不开日志文件 ⇒ 服务起不来 (或者
#   起来了但没有日志, 更糟: 排障时没有任何证据)。旧实现把 Logs 目录的创建放在
#   **步骤 5**, 也就是 nssm set **之后**, 于是在全新目标机上 (Logs 目录还不存在)
#   注册表里的 AppStdout/AppStderr 指向一个不存在的目录。绿色包镜像里 Logs 是
#   排除项 (构建产物), 所以"全新目标机"恰恰是默认路径 ⇒ 这个 bug 每次必中。
#   现在顺序反过来: 先建目录, 再让 nssm 指过去。
$logsDir = "$AppDir\Logs"
if (-not (Test-Path -LiteralPath $logsDir)) {
  New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
}
Write-Host "[4/5] Logs dir (先于 nssm set 创建): $logsDir"

nssm set $ServiceName AppDirectory $AppDir
nssm set $ServiceName AppStdout "$AppDir\Logs\service-stdout.log"
nssm set $ServiceName AppStderr "$AppDir\Logs\service-stderr.log"
nssm set $ServiceName AppRotateFiles 1
nssm set $ServiceName AppRotateBytes 1048576
nssm set $ServiceName Start SERVICE_AUTO_START
nssm set $ServiceName AppStopMethodStop 1
nssm set $ServiceName AppStopMethodConsole 0
nssm set $ServiceName AppStopMethodWindow 0
nssm set $ServiceName AppKillProcessTree 1
nssm set $ServiceName AppRestartDelay 5000

# AppEnvironmentExtra: 仅非敏感 KV (PORT/NODE_ENV/LOG_DIR)
# DB_PWD/LICENSE_KEY/JWT_SECRET 由 server.js 启动时 dotenv 读 (0 落注册表, R158.95-ext 锁)
$envExtra = @()
foreach ($k in @('PORT', 'NODE_ENV', 'LOG_DIR')) {
  if ($envMap[$k]) { $envExtra += "$k=$($envMap[$k])" }
}
if ($envExtra.Count -gt 0) {
  # AppEnvironmentExtra 的每个 KV 必须是**独立**的 argv token:
  #   nssm set <svc> AppEnvironmentExtra <kv1> <kv2> ...
  # 旧代码 `($envExtra -join ' ')` 把 3 个 KV 拼成**一个** token, NSSM 只会当成
  # 一个畸形的环境变量名 ⇒ PORT / NODE_ENV / LOG_DIR 全部丢失
  # (同主链 NSSM.psm1:185-191 记录的 DependOnService 坑: 多参数要各自成 token)。
  # 用数组 splat 展开成独立 token。
  nssm set $ServiceName AppEnvironmentExtra @envExtra
  if ($LASTEXITCODE -ne 0) { Write-Host "ERR: nssm set AppEnvironmentExtra failed (exit $LASTEXITCODE)" -ForegroundColor Red; exit 1 }
}
Write-Host "[5/5] nssm set: AppDirectory / Logs / Rotate / RestartDelay / Environment (3 non-sensitive KV)"

# === 步骤 5: 复核 Logs dir (目录已在步骤 4 之前建好) ===
# 这里不再是"第一次创建" —— 步骤 4 之前就已经建好了 (nssm 需要一个存在的目录
# 才能打开 AppStdout/AppStderr)。步骤 5 只做**复核**: 万一中间被人删了,
# 服务的日志路径就会指向一个不存在的目录, 与其让服务起来之后没有日志,
# 不如在这里直接报错。
if (-not (Test-Path -LiteralPath $logsDir)) {
  New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
  Write-Host "[5/5] Logs dir (re-created): $logsDir" -ForegroundColor Yellow
} else {
  Write-Host "[5/5] Logs dir: $logsDir"
}

Write-Host ""
Write-Host "=== install-service.ps1 DONE ===" -ForegroundColor Green
Write-Host "0 落 DB_PWD/LICENSE_KEY/JWT_SECRET 到 NSSM 注册表 (R158.95-ext 锁 + 操作员 directive '0 copy 真值')"
Write-Host "Next: powershell -ExecutionPolicy Bypass -File .\deploy\start.ps1 -Wait"
