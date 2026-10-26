# Default LogDir resolves relative to the script's own publish root (parent of
# scripts/common/) — install/update/uninstall callers always override this via
# Set-LogDir, but the fallback matters for any ad-hoc use of the module.
$Script:LogDir = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'Logs'
if (-not (Test-Path $Script:LogDir)) { New-Item -ItemType Directory -Path $Script:LogDir -Force | Out-Null }

# R119 — per-module/per-route dual-write. Default module name 'install'
# preserves the legacy single-file behavior when the caller does not opt in.
$Script:LogModule = 'install'
# Map of module-name → resolved file path under <LogDir>/APP/<module>.log.
# Built lazily on first Set-LogModule call so module-only writes do not need
# to know the LogDir up front. Pre-allocated here so the map survives
# script-file reloads within the same PowerShell session.
$Script:LogModuleFiles = @{}

function Set-LogDir {
  param([string]$Path)
  if ($Path) {
    $Script:LogDir = $Path
    # 目录变了 → 之前解析出来的 APP/<module>.log 路径全部作废
    # (Set-LogModule 的注释里承诺过"LogDir 变化时 map 失效", 之前没实现:
    #  换目录之后日志会继续写进旧目录, 新目录一个字节都收不到)。
    $Script:LogModuleFiles = @{}
    if (-not (Test-Path -LiteralPath $Script:LogDir)) {
      New-Item -ItemType Directory -Path $Script:LogDir -Force | Out-Null
    }
  }
}

# R119 — pick which rotated file subsequent Write-* calls land in. Passing
# $null or '' resets to the legacy single-file 'install' module so callers
# can revert explicitly. The /APP/ subdirectory is created lazily (mkdir -p)
# so ad-hoc usage (no installer run yet) still works — same dual-defence
# pattern as install-center.ps1 (mkdir at install time) and src/logger.js
# (createMultiRotatedLogger mkdir). moduleFiles entries are invalidated
# when LogDir changes so a second Set-LogDir re-resolves them correctly.
function Set-LogModule {
  param([string]$Name)
  if ([string]::IsNullOrWhiteSpace($Name)) {
    # Reset to the legacy single-file module. Write-Log still dual-writes
    # to <LogDir>/install.log AND <LogDir>/APP/install.log — the APP/
    # copy is what an operator's tail -f on the per-module dir sees, and
    # it must exist with the same name semantics as the explicit-mode
    # files. Seed the map entry eagerly so Write-Log doesn't lazy-create
    # a new <LogDir>/APP/install.log after the legacy install.log was
    # already being written (which would silently split the legacy line
    # stream across two physical files). The R119 dual-write contract
    # requires every Write-Log to land in BOTH the legacy AND the
    # APP/<module>.log file — preserving that across the reset is the
    # whole point of the new module-keyed map.
    $Script:LogModule = 'install'
    $appDir = Join-Path $Script:LogDir 'APP'
    if (-not (Test-Path -LiteralPath $appDir)) {
      New-Item -ItemType Directory -Path $appDir -Force | Out-Null
    }
    $Script:LogModuleFiles['install'] = Join-Path $appDir 'install.log'
  } else {
    $Script:LogModule = $Name
    $appDir = Join-Path $Script:LogDir 'APP'
    if (-not (Test-Path -LiteralPath $appDir)) {
      New-Item -ItemType Directory -Path $appDir -Force | Out-Null
    }
    $Script:LogModuleFiles[$Name] = Join-Path $appDir ("{0}.log" -f $Name)
  }
}

# R160 — 写单行日志的安全包装: 保证父目录存在, 失败返回 $false 而不抛异常。
# 绝不静默: 调用方拿到 $false 后必须走降级路径并向控制台报出。
function Write-LogFileSafe {
  param([string]$Path, [string]$Line)
  if (-not $Path) { return $false }
  try {
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
      New-Item -ItemType Directory -Path $dir -Force -ErrorAction Stop | Out-Null
    }
    Add-Content -Path $Path -Value $Line -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
}

function Write-Log {
  param([string]$Level, [string]$Message)
  $line = "{0} [{1}] {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
  Write-Host $line
  # R119 dual-write: every line still lands in the legacy install.log
  # (single file the operator greps for boot/upgrade history) AND in the
  # per-module rotated file under APP/<module>.log (R119 spec §2). The
  # legacy file is preserved for the existing log-review tooling; the
  # APP/ file is what new tooling tails.
  #
  # R160 — 日志写入不再可能把调用方带崩。
  # 2026-10-25 实际故障: uninstall-center.ps1 把 LogDir 设在 <InstallPath>\Logs,
  # 而 <InstallPath> 正是它下一步要删掉的目录 —— 删完之后每一条 Write-Log 的
  # Add-Content 都抛 GetContentWriterDirectoryNotFoundError, 卸载记录一条都没
  # 落盘, 异常还从 Write-Log 冒泡出去把脚本后半段打断 (连 Write-Ok "done" 都没打)。
  # 现在的契约:
  #   1) 写之前先保证目录存在 (外部删掉了能自愈);
  #   2) 写失败**不抛给调用方** —— 降级到 %TEMP%\ADDashboard-logs;
  #   3) 降级也失败时在控制台打一条可见的 [LOG-FAIL], 绝不静默吞掉。
  $legacyFile = Join-Path $Script:LogDir 'install.log'
  $modFile = $Script:LogModuleFiles[$Script:LogModule]
  if (-not $modFile) {
    $appDir = Join-Path $Script:LogDir 'APP'
    $modFile = Join-Path $appDir ("{0}.log" -f $Script:LogModule)
    $Script:LogModuleFiles[$Script:LogModule] = $modFile
  }

  $allOk = (Write-LogFileSafe -Path $legacyFile -Line $line)
  $modOk = (Write-LogFileSafe -Path $modFile -Line $line)
  if (-not $modOk) { $allOk = $false }

  if (-not $allOk) {
    $fallbackDir = Join-Path ([System.IO.Path]::GetTempPath()) 'ADDashboard-logs'
    $fbLegacy = Join-Path $fallbackDir 'install.log'
    $fbMod = Join-Path (Join-Path $fallbackDir 'APP') ("{0}.log" -f $Script:LogModule)
    $fbOk = (Write-LogFileSafe -Path $fbLegacy -Line $line)
    $fbModOk = (Write-LogFileSafe -Path $fbMod -Line $line)
    if (-not $fbModOk) { $fbOk = $false }
    $stamp = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    if ($fbOk) {
      Write-Host ("{0} [LOG-FAIL] primary log dir unusable ({1}); this line was written to the fallback {2}" -f $stamp, $Script:LogDir, $fallbackDir)
    } else {
      Write-Host ("{0} [LOG-FAIL] primary log dir unusable ({1}) AND fallback write failed ({2}); this line exists only in the console" -f $stamp, $Script:LogDir, $fallbackDir)
    }
  }
}

function Write-Step { param([string]$Message) Write-Log 'STEP' $Message }
function Write-Info { param([string]$Message) Write-Log 'INFO' $Message }
function Write-Warn2 { param([string]$Message) Write-Log 'WARN' $Message }
function Write-Err2 { param([string]$Message) Write-Log 'ERROR' $Message }
function Write-Ok { param([string]$Message) Write-Log 'OK' $Message }

# R119 — Get-AgentManifest returns the parsed agent/build-manifest.json
# content. Used by Get-AgentVersion + any boot-fingerprint emitter (see
# Task 9 agent/agent.js). Returns $null on parse error so callers can
# detect "manifest unreadable" without a try/catch in every consumer.
# $ManifestRoot is optional and defaults to the publish root (parent of
# scripts/common/) — the same convention Logger.psm1 already uses for
# LogDir. PS 5.1 compatible: Get-Content -Raw -Encoding UTF8 + ConvertFrom-Json.
function Get-AgentManifest {
  param([string]$ManifestRoot)
  if ([string]::IsNullOrWhiteSpace($ManifestRoot)) {
    $ManifestRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
  }
  $path = Join-Path $ManifestRoot 'agent\build-manifest.json'
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  try {
    $raw = Get-Content -Raw -Encoding UTF8 $path
    return ($raw | ConvertFrom-Json)
  } catch {
    # 契约不变 (解析失败返回 $null, 让调用方不必到处 try/catch), 但**不许
    # 静默**: manifest 损坏会让启动指纹悄悄退化成 "unknown", 现场完全看不出来。
    Write-Warning "agent/build-manifest.json at '$path' is unreadable ($($_.Exception.Message)) — boot fingerprint degrades to 'unknown'."
    return $null
  }
}

# R119 — Get-AgentVersion returns the short version string from
# agent/build-manifest.json (e.g. "0.1.0"), falling back to package.json
# version, falling back to "unknown". Used by boot-fingerprint emitters
# (collect.ps1, heartbeat.ps1, etc.) to log the running agent's version
# without each script duplicating the manifest-read boilerplate.
function Get-AgentVersion {
  $manifest = Get-AgentManifest
  if ($manifest -and $manifest.version) { return $manifest.version }
  # Fallback: package.json
  $pkgRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
  $pkgPath = Join-Path $pkgRoot 'agent\package.json'
  if (Test-Path -LiteralPath $pkgPath) {
    try {
      $raw = Get-Content -Raw -Encoding UTF8 $pkgPath
      $pkg = $raw | ConvertFrom-Json
      if ($pkg.version) { return $pkg.version }
    } catch {
      # 空 catch 是 bug (项目规范: 禁止静默吞错)。这里明确说出来, 让
      # "版本号读不出来"这件事在日志里留痕, 而不是悄悄退化成 'unknown'。
      Write-Warning "agent/package.json at '$pkgPath' is unreadable ($($_.Exception.Message)) — version falls back to 'unknown'."
    }
  }
  return 'unknown'
}