# Normalizes a path into a comparable form: absolute, no trailing separator,
# lower-cased. Windows paths are case-insensitive, so 'D:\pkg\Center' and
# 'd:\pkg\center' are the SAME directory — and the install scripts default to
# 'Center' while the source tree ships 'center'. That case-only difference is
# what made the green-package installer delete its own UI (2026-10-25):
#
#   install-center.ps1 -InPlace:
#     $distPath    = <root>\center\dist      (the directory the service serves)
#     $shippedDist = <root>\center\dist      (the "source" to copy from)
#     Remove-Item $distPath  →  Copy-Item $shippedDist\* → $distPath
#
# Source and target are the same directory, so the copy had nothing left to
# copy and the service started serving "ENOENT: ...\center\dist\index.html".
#
# PS 5.1: [System.IO.Path]::GetFullPath throws on malformed input — catch and
# fall back to the raw string so the comparison never becomes the thing that
# breaks the installer.
function ConvertTo-ComparablePath {
  param([Parameter(Mandatory)][string]$Path)
  $full = $Path
  try {
    $full = [System.IO.Path]::GetFullPath($Path)
  } catch {
    $full = $Path
  }
  $trimmed = $full.TrimEnd('\', '/')
  # Never trim a root path down to a bare drive letter ('D:\' → 'D:').
  if ($trimmed.Length -lt 3) {
    $trimmed = $full
  }
  return $trimmed.ToLowerInvariant()
}

# $true when two paths point at the same location (case-insensitive on
# Windows, trailing-separator-insensitive). Both paths may be relative or not
# yet exist — the comparison is purely lexical, which is exactly what the
# copy-before-delete call sites need.
function Test-SamePath {
  param(
    [Parameter(Mandatory)][string]$PathA,
    [Parameter(Mandatory)][string]$PathB
  )
  return ((ConvertTo-ComparablePath -Path $PathA) -eq (ConvertTo-ComparablePath -Path $PathB))
}

# Copies the CONTENTS of $SourceDir into $TargetDir (overlay semantics —
# existing files in the target are overwritten, nothing is deleted).
#
# Guarded against the self-copy trap: when source and target are the same
# directory the copy is skipped and 'same-path' is returned. Without that
# guard, Copy-Item would either throw ("source and destination are the same")
# or, in the replace-variant below, delete the directory it is about to copy
# from.
#
# Returns a hashtable: @{ Status = 'copied'|'same-path'|'source-missing'|'source-empty'|'target-created'; Message = <text> }
function Copy-DirectoryContent {
  param(
    [Parameter(Mandatory)][string]$SourceDir,
    [Parameter(Mandatory)][string]$TargetDir,
    [string[]]$Exclude = @()
  )
  if (-not (Test-Path -LiteralPath $SourceDir)) {
    return @{ Status = 'source-missing'; Message = "source directory not found: $SourceDir" }
  }
  if (Test-SamePath -PathA $SourceDir -PathB $TargetDir) {
    return @{ Status = 'same-path'; Message = "source == target ($SourceDir) — copy skipped" }
  }
  if (-not (Get-ChildItem -LiteralPath $SourceDir -Force -ErrorAction SilentlyContinue | Select-Object -First 1)) {
    return @{ Status = 'source-empty'; Message = "source directory is empty: $SourceDir" }
  }
  if (-not (Test-Path -LiteralPath $TargetDir)) {
    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
  }
  $copyArgs = @{
    Path        = (Join-Path $SourceDir '*')
    Destination = $TargetDir
    Recurse     = $true
    Force       = $true
  }
  if ($Exclude.Count -gt 0) { $copyArgs['Exclude'] = $Exclude }
  Copy-Item @copyArgs
  return @{ Status = 'copied'; Message = "copied $SourceDir -> $TargetDir" }
}

# Replaces the contents of $TargetDir with the contents of $SourceDir
# (delete-then-copy semantics). Used for the web UI dist, where a stale file
# left over from a previous build would otherwise be served.
#
# Same self-copy guard as Copy-DirectoryContent: when source and target are
# the same directory nothing is deleted — that is the 2026-10-25 data-loss
# bug (the installer deleted the very dist it was about to copy).
#
# Returns a hashtable: @{ Status = 'replaced'|'same-path'|'source-missing'|'source-empty'; Message = <text> }
function Sync-DirectoryContent {
  param(
    [Parameter(Mandatory)][string]$SourceDir,
    [Parameter(Mandatory)][string]$TargetDir,
    [string[]]$Exclude = @()
  )
  if (-not (Test-Path -LiteralPath $SourceDir)) {
    return @{ Status = 'source-missing'; Message = "source directory not found: $SourceDir" }
  }
  if (Test-SamePath -PathA $SourceDir -PathB $TargetDir) {
    return @{ Status = 'same-path'; Message = "source == target ($SourceDir) — replace skipped (nothing deleted)" }
  }
  if (-not (Get-ChildItem -LiteralPath $SourceDir -Force -ErrorAction SilentlyContinue | Select-Object -First 1)) {
    return @{ Status = 'source-empty'; Message = "source directory is empty: $SourceDir" }
  }
  if (Test-Path -LiteralPath $TargetDir) {
    Remove-Item -LiteralPath $TargetDir -Recurse -Force
  }
  New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
  $copyArgs = @{
    Path        = (Join-Path $SourceDir '*')
    Destination = $TargetDir
    Recurse     = $true
    Force       = $true
  }
  if ($Exclude.Count -gt 0) { $copyArgs['Exclude'] = $Exclude }
  Copy-Item @copyArgs
  return @{ Status = 'replaced'; Message = "replaced $TargetDir with $SourceDir" }
}

function Wait-ForHttpOk {
  # Poll a local URL until it returns 2xx (or any HTTP response — the server
  # binding the port is the signal we want). Service "Running" in SCM only
  # means NSSM launched the node process; Express still has to load modules
  # + bind the listening socket, which is 2-15s on cold cache. Without this
  # wait the install script's "probe health" call races the boot and prints
  # "unreachable" even though the service is fine.
  #
  # Self-contained: does NOT call Write-Info (Logger.psm1 isn't always in
  # scope at import time and a missing command throws a CommandNotFoundException
  # that the outer catch swallows — making the function silently return $false
  # even when the probe succeeded). Inline Write-Host with the same prefix
  # is fine; install-center.ps1 routes Logger output the same way.
  param(
    [Parameter(Mandatory)][string]$Url,
    [int]$TimeoutSeconds = 30,
    [int]$IntervalSeconds = 1
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $attempt = 0
  while ((Get-Date) -lt $deadline) {
    $attempt++
    try {
      $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
      if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500) {
        Write-Host "[INFO] http probe: $Url returned $($resp.StatusCode) on attempt $attempt"
        return $true
      }
    } catch {
      # Connection refused / timeout — server still booting. Keep polling.
    }
    Start-Sleep $IntervalSeconds
  }
  return $false
}

# Reads one NSSM parameter value as a trimmed string.
#
# `nssm get <svc> <param>` writes the value + CRLF to stdout. For a parameter
# that is NOT set it writes an EMPTY LINE — or nothing at all, depending on
# the parameter and build. The old inline form
#   (& $nssm get $Name AppStderr 2>$null | Select-Object -First 1).Trim()
# therefore threw "You cannot call a method on a null-valued expression" when
# the command produced no output at all. That is now a NORMAL state for the
# center: Disable-NssmStderr resets AppStderr to "no redirection", so the
# parameter is unset by design — and the crash would happen inside the
# startup diagnostic dump, masking the real startup failure it was written
# to surface. Returns '' when the parameter is unset or unreadable.
function Get-NssmParamValue {
  param(
    [Parameter(Mandatory)][string]$NssmPath,
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$Param
  )
  # R160 修复 (2026-10-25): 旧实现 `& $NssmPath get $Name $Param 2>$null`
  # 在 **Windows PowerShell 5.1** + $ErrorActionPreference='Stop' 下会被
  # 提升成**终止性** RemoteException。
  # 实测 (PS 5.1.26100.9711, EAP=Stop):
  #   `& cmd.exe /c "echo X 1>&2" 2>&1`   → 抛 RemoteException
  #   `& cmd.exe /c "echo X 1>&2" 2>$null` → **也**抛 RemoteException
  #   `& cmd.exe /c "echo X 1>&2"` (不重定向) → 不抛
  # 也就是说 **`2>$null` 并不比 `2>&1` 安全** —— 只有"完全不重定向"或
  # "把 $ErrorActionPreference 临时降成 Continue"才是安全的。
  #
  # 而 nssm 恰恰爱往 stderr 写: 实测 `nssm status <不存在的服务>` →
  # exit 3 + stdout 为空 + stderr = "Can't open service!"。
  # 于是本函数(它没有任何 try/catch)会在"服务起不来"的**诊断块**里
  # 抛出, 把唯一能给出 AppDirectory / Application / Win32 错误码的那段
  # 信息全部打掉 —— 正好打在最需要它的地方。
  #
  # 修法: 临时降 EAP + 包 try/catch。拿不到就返回 '' (契约不变:
  # "未设置或读不到都返回空串"), 但不再把调用方带崩。
  $raw = $null
  $prevEap = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $raw = & $NssmPath get $Name $Param 2>$null | Select-Object -First 1
  } catch {
    Write-Host "[startup-diag] nssm get $Name $Param failed: $($_.Exception.Message)"
    return ''
  } finally {
    $ErrorActionPreference = $prevEap
  }
  if ($null -eq $raw) { return '' }
  return ([string]$raw).Trim()
}

# Requires NSSM.psm1 to be imported first (uses Get-NssmPath).
function Start-ServiceSafe {
  param([Parameter(Mandatory)][string]$Name, [int]$WaitSeconds = 15)
  $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if (-not $svc) {
    Write-Host "[ERR] Start-ServiceSafe: service '$Name' is not registered. Run Install-NssmService first."
    return $false
  }
  if ($svc.Status -eq 'Running') { return $true }
  if ($svc.Status -eq 'StartPending') {
    # Another caller is already starting the service. Wait for it instead of issuing
    # a second Start-Service (which can fail with "service already starting").
    Write-Host "[INFO] Start-ServiceSafe: $Name is StartPending; waiting for it to reach Running"
  } else {
    # Pre-flight: dump the NSSM parameters so the failure log makes the actual cause
    # obvious. Start-Service's generic "cannot start service" wraps a useful Win32
    # error code (e.g. ERROR_PATH_NOT_FOUND = 3 when AppDirectory is missing), but
    # PowerShell's ServiceCommandException discards it. The NSSM-side stderr log
    # usually has the real reason too, but operators don't always know to check.
    $nssm = Get-NssmPath
    # nssm get writes the value + CR/LF to stdout. Select-Object -First 1 takes
    # the first line; .Trim() strips the trailing whitespace. Without this,
    # Test-Path below throws "illegal character in path" (ItemExistsArgumentError)
    # because `$appDir` ends with `\r\n` — the second silent failure in this
    # install chain caused by the FIRST round of diagnostics.
    #
    # Get-NssmParamValue adds the missing null-safety on top of the trim:
    # a parameter that is not set (AppStderr after Disable-NssmStderr reset)
    # can yield NO output at all, and `.Trim()` on $null throws inside the
    # diagnostic dump itself — hiding the real startup error.
    $appDir       = Get-NssmParamValue -NssmPath $nssm -Name $Name -Param 'AppDirectory'
    $appBin       = Get-NssmParamValue -NssmPath $nssm -Name $Name -Param 'Application'
    $appArgs      = Get-NssmParamValue -NssmPath $nssm -Name $Name -Param 'AppParameters'
    $appStdErrLog = Get-NssmParamValue -NssmPath $nssm -Name $Name -Param 'AppStderr'
    # Wrap Test-Path in try/catch so a single bad path doesn't kill the diag
    # dump — best-effort. Show "(test-path failed)" if Test-Path itself throws
    # even after trim (e.g. genuinely illegal character in the configured path).
    $appDirExists = try { if ($appDir) { Test-Path -LiteralPath $appDir } else { $false } } catch { $false }
    $appBinExists = try { if ($appBin) { Test-Path -LiteralPath $appBin } else { $false } } catch { $false }
    $diag = @"
[startup-diag] $Name @ $(Get-Date -Format 'o')
  Status=$($svc.Status) StartType=$($svc.StartType)
  AppDirectory=$appDir
  Application=$appBin
  AppParameters=$appArgs
  AppStderr=$appStdErrLog
  AppDirectory exists? $(if ($appDirExists) { 'YES' } else { if ($appDir) { 'NO — NSSM will fail to launch' } else { '(test-path failed)' } })
  Application exists? $(if ($appBinExists) { 'YES' } else { if ($appBin) { 'NO — NSSM will fail to launch' } else { '(test-path failed)' } })
"@
    Write-Host $diag
    if ($Script:LogDir) {
      $diagFile = Join-Path $Script:LogDir "$Name-startup-diag.log"
      Add-Content -Path $diagFile -Value $diag -ErrorAction SilentlyContinue
    }
    try {
      Start-Service -Name $Name -ErrorAction Stop
    } catch {
      $msg = $_.Exception.InnerException.Message
      if (-not $msg) { $msg = $_.Exception.Message }
      $win32 = ''
      if ($_.Exception.InnerException -and $_.Exception.InnerException.GetType().FullName -match 'Win32Exception') {
        $win32 = " (Win32: $($_.Exception.InnerException.NativeErrorCode))"
      }
      Write-Host "[ERR] Start-Service failed for $Name : $msg$win32"
      Write-Host "[ERR] Check NSSM stderr log at: $appStdErrLog (most likely root cause lives there)"
      return $false
    }
  }
  for ($i=0; $i -lt $WaitSeconds; $i++) {
    if ((Get-Service -Name $Name).Status -eq 'Running') { return $true }
    Start-Sleep 1
  }
  return $false
}

function Stop-ServiceSafe {
  param([Parameter(Mandatory)][string]$Name, [int]$WaitSeconds = 30)
  # R160 修复 (2026-10-25): 服务**根本没注册**时, 旧实现
  #   (Get-Service ... -ErrorAction SilentlyContinue).Status -eq 'Stopped'
  # 对 $null 求值为 false ⇒ 落到 Stop-Service -ErrorAction Stop ⇒ 抛
  # "Cannot find service"。调用方 (update-center.ps1:45 / upgrade-center.ps1:132)
  # 于是看到一条毫无上下文的错误, 分不清"服务还没装"和"停不掉"。
  # 语义上"确保服务处于停止状态": 没注册 = 必然没在跑 = 已经满足 ⇒ $true。
  $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if (-not $svc) {
    Write-Host "[INFO] Stop-ServiceSafe: service '$Name' is not registered — nothing to stop."
    return $true
  }
  if ($svc.Status -eq 'Stopped') { return $true }
  Stop-Service -Name $Name -Force -ErrorAction Stop
  for ($i=0; $i -lt $WaitSeconds; $i++) {
    if ((Get-Service -Name $Name).Status -eq 'Stopped') { return $true }
    Start-Sleep 1
  }
  return $false
}

function Remove-ServiceSafe {
  param([Parameter(Mandatory)][string]$Name)
  if (Get-Service -Name $Name -ErrorAction SilentlyContinue) {
    Stop-ServiceSafe -Name $Name | Out-Null
    $nssm = (Get-NssmPath)
    & $nssm remove $Name confirm | Out-Null
  }
}

function Set-ServiceRecovery {
  param([Parameter(Mandatory)][string]$Name)
  $nssm = Get-NssmPath
  # NSSM-level: restart cleanly on process.exit(0) (used by wizard finalize).
  # AppExit requires the sub-parameter form `<exit_code|Default> <action>` — NSSM
  # 2.24 rejects the bare `AppExit Restart` form with "requires a subparameter!".
  # `Default Restart` means: restart the service on ANY exit code.
  & $nssm set $Name AppExit Default Restart | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "nssm set $Name AppExit Default Restart failed: $LASTEXITCODE" }
  & $nssm set $Name AppRestartDelay 2000 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "nssm set $Name AppRestartDelay failed: $LASTEXITCODE" }
  # Windows-level: restart on crash (OOM, segfault, kill -9).
  # Note: the syntax `reset= 60` requires a SPACE after `=`. sc.exe is picky about that.
  $scArgs = @('failure', $Name, 'reset=', '60', 'actions=', 'restart/5000/restart/10000/restart/30000')
  $p = Start-Process -FilePath 'sc.exe' -ArgumentList $scArgs -NoNewWindow -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "sc.exe failure $Name failed: exit $($p.ExitCode)" }
  Write-Info "service recovery set: NSSM AppExit=Default Restart + sc failure reset=60 actions=restart/5000/restart/10000/restart/30000"
}

# R160 (2026-10-25) — "依赖是否真的到位"的唯一判据: 能不能被 require 解析。
#
# 为什么不用 "Test-Path <InstallPath>\node_modules":
#   npm workspaces 会把依赖**提升到工作区根**的 node_modules。
#   `npm install --omit=dev` 跑在 <root>\center 里, 实际装到的是
#   <root>\node_modules —— <root>\center\node_modules 永远不会出现。
#   用目录存在性做判据 ⇒ "已就绪" 永远为假 ⇒ 每次安装都重跑一次 npm
#   install; 而 `--omit=dev` 还会顺手把根 node_modules 里的 vite / vitest
#   这些 devDependencies 剪掉, 之后本地 `npm run build:web` 直接
#   "vite: not found"。这是 2026-10-25 恢复安装链时实测到的真实行为。
#
# 探针: center 直接依赖里最有代表性的几个 (express = HTTP 框架,
# pino = 日志) 做 require.resolve 探针 —— 全部解析成功才算到位。
# 只探 2 个, 不全量遍历: 目的是判断"有没有装上", 不是逐个校验版本。
function Test-NodeDepsResolvable {
  param(
    [Parameter(Mandatory)] [string]$InstallPath,
    [string[]]$Probe = @('express', 'pino'),
    [string]$NodeExe = 'node'
  )
  if (-not (Test-Path -LiteralPath $InstallPath)) { return $false }
  foreach ($moduleName in $Probe) {
    $resolved = $false
    Push-Location $InstallPath
    try {
      # process.argv[1] = 第一个用户参数 (node -e 时 argv[0] 是 exe 本身),
      # 用参数传模块名, 不把它拼进 JS 源码。
      & $NodeExe -e "try{require.resolve(process.argv[1]);process.exit(0)}catch(e){process.exit(1)}" $moduleName 2>$null | Out-Null
      $resolved = ($LASTEXITCODE -eq 0)
    } catch {
      $resolved = $false
    } finally {
      Pop-Location
    }
    if (-not $resolved) { return $false }
  }
  return $true
}
