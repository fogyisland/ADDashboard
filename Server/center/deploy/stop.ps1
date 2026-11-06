# R158.X+UI.publish.deploy (2026-10-19) — stop.ps1
# 后续服务器 1-click 停止 ADDashboardCenter Windows 服务.
# 优雅停: nssm stop (走 AppStopMethodStop, 等 30s 兜底, SIGKILL 兜底).
# 0 改 NSSM 注册 (R158.95-ext + 操作员 directive "0 触凭证固化").

param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ServiceName = 'ADDashboardCenter'

Write-Host "=== stop.ps1 ===" -ForegroundColor Cyan

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
Write-Host "[1/3] service status: $status"

if ($status -match 'SERVICE_STOPPED') {
  Write-Host "[2/3] service already stopped, skip"
} else {
  # R160 修: 旧实现的 -Force 分支与默认分支**逐字节相同** (都是 `nssm stop` +
  # 同一个 30s 等待循环), 只有提示语不同 ⇒ -Force 是个**空开关**, 而它打印的
  # "immediate, no graceful wait" 是**假话** —— 实际上照样等 30s。
  # 现在的语义:
  #   默认   : nssm stop (走 AppStopMethodStop 的优雅停) → 等 30s → 不行再 stop 一次
  #   -Force : nssm stop → 只等 5s → 还没停就**直接杀进程** (Stop-Process -Force)
  #            ⇒ 真的"立即", 适合服务卡死不响应 stop 的场景
  # 注意: 杀进程需要管理员权限; 没有权限时脚本会明确报错, 而不是假装成功。
  $waitBudget = 30
  if ($Force) { $waitBudget = 5 }
  Write-Host ("[2/3] " + $(if ($Force) { "-Force: nssm stop, 只等 ${waitBudget}s, 不停就杀进程" } else { "nssm stop (优雅停, 等 ${waitBudget}s 兜底)" }))
  nssm stop $ServiceName

  $wait = 0
  while ($wait -lt $waitBudget) {
    Start-Sleep -Seconds 1
    $wait++
    $s = Get-NssmServiceStatus -Name $ServiceName -Exe $NssmExe
    if ($s -match 'SERVICE_STOPPED') { break }
  }
  $s = Get-NssmServiceStatus -Name $ServiceName -Exe $NssmExe
  if ($s -notmatch 'SERVICE_STOPPED') {
    if ($Force) {
      # 直接杀服务进程。ProcessId 从 SCM 拿 (Win32_Service), 不用 $pid 这个
      # 名字 —— 它是 PowerShell 的自动变量 ($PID = 当前进程), 赋值会炸。
      $servicePid = 0
      $svcInfo = Get-CimInstance -ClassName Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
      if ($svcInfo -and $svcInfo.ProcessId) { $servicePid = [int]$svcInfo.ProcessId }
      if ($servicePid -gt 0) {
        Write-Host "[2/3] -Force: kill service process PID $servicePid" -ForegroundColor Yellow
        try {
          Stop-Process -Id $servicePid -Force -ErrorAction Stop
        } catch {
          Write-Host ("ERR: -Force kill PID $servicePid failed: " + $_.Exception.Message) -ForegroundColor Red
          Write-Host "     (杀别的用户的进程需要管理员权限 —— 请用管理员 PowerShell 重跑)" -ForegroundColor Yellow
          exit 1
        }
        Start-Sleep -Seconds 2
      } else {
        Write-Host "WARN: -Force but could not resolve the service PID (SCM query failed or PID=0) — falling back to a second nssm stop" -ForegroundColor Yellow
        nssm stop $ServiceName
        Start-Sleep -Seconds 2
      }
    } else {
      Write-Host "WARN: service not stopped after ${waitBudget}s, force kill" -ForegroundColor Yellow
      nssm stop $ServiceName
      Start-Sleep -Seconds 2
    }
  }
  if ($LASTEXITCODE -ne 0) { Write-Host "ERR: nssm stop failed" -ForegroundColor Red; exit 1 }
  Write-Host "[2/3] nssm stop: OK"
}

# === 步骤 3: verify ===
$s = Get-NssmServiceStatus -Name $ServiceName -Exe $NssmExe
if ($s -match 'SERVICE_STOPPED') { Write-Host "[3/3] verified: stopped" -ForegroundColor Green }
else { Write-Host "WARN: not stopped (status: $s)" -ForegroundColor Yellow }

Write-Host ""
Write-Host "=== stop.ps1 DONE ===" -ForegroundColor Green
Write-Host "Start:  powershell -ExecutionPolicy Bypass -File .\deploy\start.ps1"
