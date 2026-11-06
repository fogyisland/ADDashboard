# R158.X+UI.publish.deploy (2026-10-19) — install-service.ps1
# 后续服务器 1-click 注册 ADDashboardCenter Windows 服务.
#
# ★ R161.25 (2026-10-29 部署审计) — 凭据模型订正。
#   本文件旧注释 (以及旧实现) 说: ".env 必操作员手动维护, 填 DB_PWD /
#   LICENSE_KEY / JWT_SECRET" —— **那三个键中心从来不读**:
#     · DB 口令 / jwtSecret / agentToken 全部来自 **appsettings.json**,
#       而 appsettings.json 是**初始化向导**在目标机上生成的 (POST /api/init/*);
#     · center/.env 只承载**初始化标记** ADDASHBOARD_INITIALIZED=1
#       (src/init/marker.js) —— 它是向导跑完之后由服务自己写的, 不是安装前置;
#     · LICENSE_KEY 在中心这条链路上根本不存在。
#   ⇒ 旧实现把 ".env 里有没有 DB_PWD/LICENSE_KEY/JWT_SECRET" 当成**安装闸门**,
#     于是在**全新目标机**上 (此时 .env 还不存在, 正确状态就是"没有") 必然
#     exit 1 —— 这个安装器**从来没有、也不可能**在干净机器上装成功。
#     闸门已改成真实的前置条件 (node / nssm / server.js / dist / 上一级 db/)。
#
# ★ 0 落 NSSM AppEnvironmentExtra 真值到注册表 (R158.95-ext DB password 锁 +
#   操作员 directive "0 copy 真值"):
#   - NSSM 仅 set AppEnvironmentExtra NODE_ENV/PORT/LOG_DIR (非敏感)
#   - 任何凭据都不进 NSSM 注册表, 也不进 AppEnvironmentExtra
#   - DB 口令 / jwtSecret / agentToken 由 appsettings.json 提供 (向导生成)
#
# 用法 (RDP 到 target server 后):
#   powershell -ExecutionPolicy Bypass -File .\deploy\install-service.ps1
#   powershell -ExecutionPolicy Bypass -File .\deploy\install-service.ps1 -Force
#
# 参数:
#   -Force  服务已存在时**直接覆盖** NSSM 参数 (默认: 报出来并以 0 退出,
#           绝不交互 —— 交互式 Read-Host 在无人值守部署里会把脚本**挂死**)。
#
# 必预跑:
#   - Node.js v22+ (https://nodejs.org or choco install nodejs)
#   - NSSM 2.24+ (https://nssm.cc or choco install nssm)
#   - <center> 的**上一级**有 db/ (基线 + 迁移; 向导建库那一步读它)
#
# 步骤:
#   1. verify node / nssm
#   2. verify 交付物 (server.js / dist/index.html / 上一级 db/)
#   3. 装依赖 (npm install --omit=dev; 目标机上没有 lock ⇒ 不能用 npm ci)
#   4. nssm install / set (幂等: 已存在则只刷新参数)
#   5. ensure Logs dir (必须先于 nssm set 指向它)
#   6. 汇总 (服务**不**自动启动 —— 首次启动走初始化向导)

# ★ PowerShell 铁律: param() 必须是脚本的**第一条语句**
#   (注释不算; 任何赋值/Import 都算语句)。放在 $ErrorActionPreference 之后
#   会直接语法报错。
[CmdletBinding()]
param(
  [switch]$Force
)

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
Write-Host "[1/6] node: $nodeVer"

# nssm 版本探测: **绝对不要执行 `nssm --version`** —— 实测在本机会挂死
# (15s / 120s 两次都是 exit 124 超时, stdout/stderr 全空), 会把整条安装链卡住。
# 改读 nssm.exe 的文件版本信息 (VersionInfo.FileVersion → "2.24");
# FileVersion 为空就退回"文件存在"判定。
$NssmExe = Resolve-NssmExe
if (-not $NssmExe) { Write-Host "ERR: nssm not found. Run: choco install nssm" -ForegroundColor Red; exit 1 }
$nssmVer = $null
try { $nssmVer = (Get-Item -LiteralPath $NssmExe).VersionInfo.FileVersion } catch { $nssmVer = $null }
if (-not $nssmVer) { $nssmVer = 'unknown (file found, no version info)' }
Write-Host "[2/6] nssm: $nssmVer ($NssmExe)"

# ★ R161.25 — node 的**绝对路径**必须先钉住。
#   旧实现 `nssm install $ServiceName node server.js` 写的是**裸 "node"**:
#   NSSM 用 LocalSystem 启动服务时, 它的 PATH **不含**操作员装的 node 目录
#   (node 装在 %ProgramFiles%\nodejs, 只有交互式会话的 PATH 里有) ⇒ 服务
#   起来就报 "node 不是内部或外部命令" ⇒ 服务永远不运行, 而安装脚本一路报 OK。
#   主链 (Server/scripts/install-center.ps1) 用的是
#   `(Get-Command node.exe).Source` (绝对路径) —— 这里对齐。
$nodeExe = $null
try { $nodeExe = (Get-Command node.exe -ErrorAction Stop).Source } catch { $nodeExe = $null }
if (-not $nodeExe) { Write-Host "ERR: node.exe not resolvable via PATH" -ForegroundColor Red; exit 1 }
Write-Host "      node.exe: $nodeExe"

# === 步骤 2: verify 交付物 ===
# ★ R161.25 — 旧实现拿 ".env 里有 DB_PWD/LICENSE_KEY/JWT_SECRET" 当安装闸门,
#   而那三个键**中心根本不读** (凭据在 appsettings.json, 由向导生成; .env 只
#   承载 ADDASHBOARD_INITIALIZED 标记)。在干净机器上 .env 正确地**不存在**
#   ⇒ 旧闸门必然 exit 1 ⇒ 这个安装器永远装不上。
#   换成**真实**的前置条件: 服务跑起来需要什么?
#     · server.js          —— 入口
#     · dist/index.html    —— 前端静态资源 (缺了 = 每个页面 404)
#     · <上一级>\db\       —— 基线 + 迁移 (缺了 = 向导第 3 步直接报
#                             "找不到基线文件", 现场离原因十万八千里)
$missingFiles = @()
if (-not (Test-Path -LiteralPath (Join-Path $AppDir 'server.js'))) { $missingFiles += 'server.js' }
if (-not (Test-Path -LiteralPath (Join-Path $AppDir 'dist\index.html'))) { $missingFiles += 'dist\index.html' }
if ($missingFiles.Count -gt 0) {
  Write-Host "ERR: missing deliverable(s): $($missingFiles -join ', ')  (under $AppDir)" -ForegroundColor Red
  Write-Host "     the tree is incomplete — re-copy the whole center/ folder" -ForegroundColor Yellow
  exit 1
}
# db/ 必须在 center 的**上一级** (src/init/schema-applier.js 的 resolveRepoRoot
# 找的是 <cwd>/..; 服务进程的 cwd = AppDirectory = center)。
$appParent = Split-Path -Parent $AppDir
$dbRoot = Join-Path $appParent 'db'
if (-not (Test-Path -LiteralPath (Join-Path $dbRoot 'migrations'))) {
  Write-Host "ERR: db\migrations not found at $dbRoot" -ForegroundColor Red
  Write-Host "     the init wizard builds the schema from there; without it the wizard fails at the 'create database' step" -ForegroundColor Yellow
  Write-Host "     fix: copy the db/ folder next to the center/ folder" -ForegroundColor Yellow
  exit 1
}
Write-Host "[3/6] deliverables: server.js / dist\index.html / db\migrations OK"

# .env 现在**只承载初始化标记**, 由向导跑完之后自己写 —— 存在与否都不该是
# 安装闸门。这里只做"看一眼", 便于操作员知道当前处于向导前还是向导后。
$envPath = Join-Path $AppDir '.env'
$envMap = @{}
if (Test-Path -LiteralPath $envPath) {
  Get-Content -LiteralPath $envPath | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]*)=(.*)$') { $envMap[$Matches[1].Trim()] = $Matches[2].Trim() }
  }
  if ($envMap['ADDASHBOARD_INITIALIZED']) {
    Write-Host "[4/6] .env: init marker PRESENT (this install was initialized before) — service will start in normal mode"
  } else {
    Write-Host "[4/6] .env: present but no init marker — service will start in INIT mode (wizard at /init)"
  }
} else {
  Write-Host "[4/6] .env: absent — service will start in INIT mode (wizard at /init). This is the correct state on a fresh target."
}

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
      Write-Host "WARN: Service.psm1 not usable, falling back to the local probe ($($_.Exception.Message))" -ForegroundColor Yellow
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

# === 步骤 3: 装依赖 ===
# ★ R161.25 — `npm ci` ⇒ `npm install`。
#   npm ci 的**硬前提**是当前目录里有 package-lock.json (否则直接 EUSAGE 退出)。
#   目标机上的 center/ **没有** lock: 交付包里不带 (Linux 交付包把它列进了
#   FORBIDDEN_PATHS; Windows 侧 R161.25 也把它加进了拷贝排除清单, 并且删掉了
#   源树里那份过期的嵌套 lock —— 它是 2026-10-13 的旧快照, 无 sdk / 无 zod)。
#   ⇒ 旧实现这一步必然 `ERR: npm ci failed (exit 1)`, 而且报的错
#   ("npm ci can only install with an existing package-lock.json") 与
#   "文件没带过来" 这件事**离得很远**。
#   npm install 不需要 lock, 会就地生成一份 —— 这正是主链
#   (Server/scripts/install-center.ps1) 一直在用的命令。
if (Test-CenterDepsResolvable -AppDir $AppDir) {
  Write-Host "[5/6] deps: already resolvable (express/pino), skipping npm install"
} else {
  Write-Host "[5/6] npm install --omit=dev ..."
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
      $npmOutput = (& npm.cmd install --omit=dev --no-audit --no-fund 2>&1 | Out-String)
      $npmExit = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $prevEap
    }
  } finally {
    Pop-Location
  }
  if ($npmExit -ne 0) {
    Write-Host "ERR: npm install --omit=dev failed (exit $npmExit)" -ForegroundColor Red
    $tail = (($npmOutput -split "`r?`n") | Where-Object { $_.Trim() -ne '' } | Select-Object -Last 20) -join "`n"
    if ($tail) { Write-Host "npm output (last 20 lines):" -ForegroundColor Yellow; Write-Host $tail -ForegroundColor Yellow }
    Write-Host "offline server? pre-stage node_modules or the npm cache, then retry — never start the service with a broken dependency tree" -ForegroundColor Yellow
    exit 1
  }
  Write-Host "[5/6] npm install: OK"
  if (-not (Test-CenterDepsResolvable -AppDir $AppDir)) {
    Write-Host "ERR: npm install finished, but the dependencies are still not resolvable (express/pino)" -ForegroundColor Red
    exit 1
  }
}

# === 步骤 4: nssm install (幂等) ===
# ★ R161.25 — 旧实现在"服务已存在"时用 `Read-Host "Reinstall? (y/N)"` 问一句。
#   交互式提示在**无人值守**部署 (计划任务 / CI / 复制粘贴到 RDP) 里会把脚本
#   **挂死**在那儿 —— 屏幕上什么也不发生, 操作员以为脚本卡住了。
#   现在: 已存在 ⇒ 默认**只刷新 NSSM 参数**(这正是主链 Install-NssmService 的
#   语义: 跳过 nssm install, 但**永远**重刷参数), 不问任何问题;
#   要真正重装 (remove + install) 用 -Force。
$existing = Get-NssmServiceStatus -Name $ServiceName -Exe $NssmExe
if ($existing) {
  if ($Force) {
    Write-Host "[6/6] service already installed ($existing) — -Force: removing and re-installing" -ForegroundColor Yellow
    # `2>&1` 在 PS 5.1 + EAP=Stop 下会因 nssm 的 stderr 直接终止脚本; 这里不重定向
    # stderr (nssm 的报错仍会打到控制台, 操作员看得见), 只用 Out-Null 吞掉 stdout。
    nssm stop $ServiceName | Out-Null
    nssm remove $ServiceName confirm
    nssm install $ServiceName $nodeExe
    if ($LASTEXITCODE -ne 0) { Write-Host "ERR: nssm install failed (exit $LASTEXITCODE)" -ForegroundColor Red; exit 1 }
    Write-Host "[6/6] nssm install: OK (re-installed)"
  } else {
    Write-Host "[6/6] service already installed ($existing) — refreshing NSSM parameters (use -Force to remove + re-install)" -ForegroundColor Yellow
  }
} else {
  nssm install $ServiceName $nodeExe
  if ($LASTEXITCODE -ne 0) { Write-Host "ERR: nssm install failed (exit $LASTEXITCODE)" -ForegroundColor Red; exit 1 }
  Write-Host "[6/6] nssm install: OK"
}

# === 步骤 5: nssm set (0 sensitive KV 落注册表) ===
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
Write-Host "      Logs dir (created before nssm set points at it): $logsDir"

nssm set $ServiceName AppDirectory $AppDir
nssm set $ServiceName AppParameters 'server.js'
nssm set $ServiceName AppStdout "$AppDir\Logs\service-stdout.log"
nssm set $ServiceName AppStderr "$AppDir\Logs\service-stderr.log"
nssm set $ServiceName AppRotateFiles 1
nssm set $ServiceName AppRotateOnline 1
nssm set $ServiceName AppRotateBytes 10485760
nssm set $ServiceName Start SERVICE_AUTO_START
nssm set $ServiceName AppStopMethodStop 1
nssm set $ServiceName AppStopMethodConsole 0
nssm set $ServiceName AppStopMethodWindow 0
nssm set $ServiceName AppKillProcessTree 1
nssm set $ServiceName AppRestartDelay 5000

# AppEnvironmentExtra: 仅非敏感 KV (NODE_ENV / PORT / LOG_DIR)
# 任何凭据都不进注册表 (R158.95-ext 锁): DB 口令 / jwtSecret / agentToken 由
# appsettings.json 提供, appsettings.json 由**初始化向导**在目标机上生成。
$envExtra = @('NODE_ENV=production')
foreach ($k in @('PORT', 'LOG_DIR')) {
  if ($envMap[$k]) { $envExtra += "$k=$($envMap[$k])" }
}
# AppEnvironmentExtra 的每个 KV 必须是**独立**的 argv token:
#   nssm set <svc> AppEnvironmentExtra <kv1> <kv2> ...
# 旧代码 `($envExtra -join ' ')` 把 3 个 KV 拼成**一个** token, NSSM 只会当成
# 一个畸形的环境变量名 ⇒ PORT / NODE_ENV / LOG_DIR 全部丢失
# (同主链 NSSM.psm1:185-191 记录的 DependOnService 坑: 多参数要各自成 token)。
# 用数组 splat 展开成独立 token。
nssm set $ServiceName AppEnvironmentExtra @envExtra
if ($LASTEXITCODE -ne 0) { Write-Host "ERR: nssm set AppEnvironmentExtra failed (exit $LASTEXITCODE)" -ForegroundColor Red; exit 1 }
Write-Host "      nssm set: AppDirectory / AppParameters / Logs / Rotate / RestartDelay / Environment (non-sensitive only)"

# === 步骤 6: 复核 Logs dir ===
# 这里不再是"第一次创建" —— 步骤 5 之前就已经建好了 (nssm 需要一个存在的目录
# 才能打开 AppStdout/AppStderr)。这一步只做**复核**: 万一中间被人删了,
# 服务的日志路径就会指向一个不存在的目录, 与其让服务起来之后没有日志,
# 不如在这里直接报错。
if (-not (Test-Path -LiteralPath $logsDir)) {
  New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
  Write-Host "      Logs dir (re-created): $logsDir" -ForegroundColor Yellow
} else {
  Write-Host "      Logs dir: $logsDir"
}

Write-Host ""
Write-Host "=== install-service.ps1 DONE ===" -ForegroundColor Green
Write-Host "no credential is written to the NSSM registry (R158.95-ext lock)"
Write-Host "Next: powershell -ExecutionPolicy Bypass -File .\deploy\start.ps1 -Wait"
Write-Host "Then: open http://<host>:8080/init and finish the wizard (it writes center\appsettings.json)"
