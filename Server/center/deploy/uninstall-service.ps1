# R158.X+UI.publish.deploy (2026-10-19) — uninstall-service.ps1
# 后续服务器 1-click 卸载 ADDashboardCenter Windows 服务.
# 0 删 .env / 0 删 node_modules / 0 删 src/. 0 删任何凭证.
# 镜像下次 install 可复用: 走 .\deploy\install-service.ps1 重 register.

param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ServiceName = 'ADDashboardCenter'
$AppDir = (Resolve-Path "$PSScriptRoot\..").Path

Write-Host "=== uninstall-service.ps1 ===" -ForegroundColor Cyan
Write-Host "Service: $ServiceName"
Write-Host "AppDirectory: $AppDir (0 删)"

# === nssm helpers (R160) ===
# 为什么需要这两个 helper:
#   1) PS 5.1 下只要 $ErrorActionPreference='Stop', 给原生 exe 加 2>&1 / 2>$null
#      都会把它的 stderr 提升成**终止性** RemoteException (实测:
#      `& cmd.exe /c 'echo oops 1>&2' 2>$null` 直接 TERMINATED)。nssm status 对
#      "服务不存在" 会往 stderr 写 "Can't open service!" 并 exit 3 —— 而"服务没装"
#      恰恰是卸载 / 首次安装的**正常路径**, 不该把脚本带崩。
#      nssm 的 stdout/stderr 分离是可靠的: 状态文本在 stdout, 错误在 stderr,
#      所以用 EAP=Continue + $LASTEXITCODE 判定, **不合并** stderr。
#   2) nssm 的 stdout 是 **UTF-16LE** (实测字节 53 00 45 00 52 00 ...)。PowerShell
#      按 [Console]::OutputEncoding 解码 ⇒ 得到的字符串每个字符后面夹一个 NUL
#      ("S\x00E\x00R\x00...") ⇒ `-match 'SERVICE_STOPPED'` 永远为假 (PS 5.1 / PS 7
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

$NssmExe = Resolve-NssmExe
if (-not $NssmExe) { Write-Host "ERR: nssm not found. Run: choco install nssm" -ForegroundColor Red; exit 1 }

$status = Get-NssmServiceStatus -Name $ServiceName -Exe $NssmExe
if ($null -eq $status) {
  Write-Host "WARN: service $ServiceName not installed, skip"
  exit 0
}
Write-Host "[1/4] service status: $status"

# 步骤 1: stop (graceful)
if ($status -notmatch 'SERVICE_STOPPED') {
  Write-Host "[1/4] stopping service ..."
  nssm stop $ServiceName
  $wait = 0
  while ($wait -lt 30) {
    Start-Sleep -Seconds 1
    $wait++
    $s = Get-NssmServiceStatus -Name $ServiceName -Exe $NssmExe
    if ($s -match 'SERVICE_STOPPED') { break }
  }
}

# 步骤 2: confirm (操作员授权)
if (-not $Force) {
  $confirm = Read-Host "Uninstall service $ServiceName ? (y/N)"
  if ($confirm -ne 'y') { Write-Host "skip uninstall, exit"; exit 0 }
}

# 步骤 3: nssm remove
nssm remove $ServiceName confirm
if ($LASTEXITCODE -ne 0) { Write-Host "ERR: nssm remove failed" -ForegroundColor Red; exit 1 }
Write-Host "[2/4] nssm remove: OK"

# 步骤 4: verify
$s = Get-NssmServiceStatus -Name $ServiceName -Exe $NssmExe
if ($null -eq $s) {
  Write-Host "[3/4] verified: service removed" -ForegroundColor Green
} else {
  Write-Host "[3/4] WARN: still exists (status: $s)" -ForegroundColor Yellow
}

# 步骤 5: 清理 Logs (选, 0 必)
$logsDir = "$AppDir\Logs"
if (Test-Path $logsDir) {
  if ($Force) {
    Write-Host "[4/4] -Force: remove Logs dir"
    Remove-Item $logsDir -Recurse -Force -ErrorAction SilentlyContinue
  } else {
    Write-Host "[4/4] keep Logs dir (use -Force to remove)"
  }
}

Write-Host ""
Write-Host "=== uninstall-service.ps1 DONE ===" -ForegroundColor Green
Write-Host "0 删: .env / node_modules / src/ / dist/ / db/ / web/ / .env.example"
Write-Host "Reinstall: powershell -ExecutionPolicy Bypass -File .\deploy\install-service.ps1"
