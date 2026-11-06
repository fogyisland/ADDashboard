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

# Walks $SourceDir and copies every file into $TargetDir, preserving the
# relative layout.
#
# ★ WHY THIS EXISTS (2026-10-29 部署审计):
#   `Copy-Item -Path "$SourceDir\*" -Recurse -Exclude <names>` 的排除条件
#   **只作用于通配符展开的第一层** —— 实测:
#     Copy-Item -Path 'src\*' -Recurse -Exclude 'tests'
#   仍会把 src\web\tests\ 整个拷过去, src\web\node_modules\ 也一样。
#   后果 (Windows 交付): 目标机上多出 web\tests\ 与 web\vitest.config.js,
#   而 Linux 交付包**故意**不带它们 (见 scripts/audit/check-linux-package-sync.mjs
#   的 C4 检查) ⇒ 两棵交付树的目录结构不一致。
#
#   这里的实现是**逐目录手工遍历**, 在每一层都按名字排除 ⇒ 排除在任意深度
#   都生效; 匹配大小写不敏感 (Windows 文件系统语义), 与 Copy-Item -Exclude
#   保持一致。
#
# 排除命中的是**任何一级**的目录名或文件名 (不只是顶层)。空目录也会在
# 目标端建出来 (保持目录结构)。
#
# Returns a hashtable: @{ Files = <int>; Excluded = <int>; Message = <text> }
function Copy-TreeContent {
  param(
    [Parameter(Mandatory)][string]$SourceDir,
    [Parameter(Mandatory)][string]$TargetDir,
    [string[]]$Exclude = @()
  )
  $excluded = @{}
  foreach ($name in $Exclude) {
    if ([string]::IsNullOrWhiteSpace($name)) { continue }
    $excluded[$name.ToLowerInvariant()] = $true
  }

  $sourceItem = Get-Item -LiteralPath $SourceDir
  $sourceRoot = $sourceItem.FullName.TrimEnd('\', '/')
  $copiedFiles = 0
  $excludedEntries = 0

  # 显式栈 (不用递归) —— 目标树可能很深, 递归在 PowerShell 里会撞上默认
  # 的作用域深度, 而且栈能让我们在**进入**被排除的目录之前就把它剪掉
  # (Get-ChildItem -Recurse 会先进入再过滤, 于是 node_modules 里十万个
  # 文件照样被枚举一遍)。
  $stack = New-Object System.Collections.Stack
  $stack.Push($sourceItem)

  while ($stack.Count -gt 0) {
    $current = $stack.Pop()
    $children = @(Get-ChildItem -LiteralPath $current.FullName -Force -ErrorAction SilentlyContinue)
    foreach ($child in $children) {
      if ($excluded.ContainsKey($child.Name.ToLowerInvariant())) {
        $excludedEntries++
        continue
      }
      $relative = $child.FullName.Substring($sourceRoot.Length).TrimStart('\', '/')
      $destination = Join-Path $TargetDir $relative
      if ($child.PSIsContainer) {
        if (-not (Test-Path -LiteralPath $destination)) {
          New-Item -ItemType Directory -Path $destination -Force | Out-Null
        }
        $stack.Push($child)
        continue
      }
      $destinationDir = Split-Path -Parent $destination
      if (-not (Test-Path -LiteralPath $destinationDir)) {
        New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null
      }
      Copy-Item -LiteralPath $child.FullName -Destination $destination -Force
      $copiedFiles++
    }
  }

  $message = "copied $copiedFiles file(s) from $SourceDir -> $TargetDir"
  if ($excludedEntries -gt 0) {
    $message += " (excluded $excludedEntries entr$(if ($excludedEntries -eq 1) { 'y' } else { 'ies' }): $($Exclude -join ', '))"
  }
  return @{ Files = $copiedFiles; Excluded = $excludedEntries; Message = $message }
}

# R161.25 (2026-10-29 部署审计) — 中心交付代码拷贝的**统一排除清单**。
#
# 之前 install-center.ps1 / upgrade-center.ps1 / update-center.ps1 各自维护
# 一份列表 (内容还不一致), 而且那份列表**只作用于顶层** (Copy-Item -Exclude
# 的语义) ⇒ 两棵树 (Windows 目标机 vs Linux 交付包) 的目录结构不一致。
# 现在集中在这里, 且排除在**任意深度**都生效 (见 Copy-TreeContent)。
#
# 每一项都有理由:
#   node_modules  — 目标机自己 `npm install --omit=dev` 重装 (装的是目标机
#                   自己的平台二进制, 拷过去的是开发机的)
#   tests         — 测试用例, 生产不跑 (含嵌套的 web/tests)
#   vitest.config.js — 前端测试配置, 依赖 vitest/jsdom (devDependency),
#                   目标机上根本装不上 ⇒ `npm run test:web` 必然是死脚本
#   appsettings.json — 操作员自有配置 (DB 密码 / jwtSecret / agentToken),
#                   覆盖它 = 生产事故
#   .install-hash — "这台机器的依赖装到哪一版"的运行期标记, 属目标机
#   Logs          — 目标机自己的运行日志 (Windows 大小写不敏感, 一个名字
#                   同时盖住 logs/ 与 Logs/)
#   .env          — ★ init 完成标记 (ADDASHBOARD_INITIALIZED=1)。**漏掉它
#                   ⇒ 源树的标记被拷到目标机, 而 appsettings.json 被排除
#                   ⇒ 目标机 markerLocked=true + config=null ⇒ server.js
#                   process.exit(2) ⇒ 服务永远起不来, 向导也进不去**
#   publish-sync.mjs / audit / _backup_... — 源树开发工具, 依赖**不随交付
#                   包发布**的树 (publish/ 镜像树、agent/ 树), 在目标机上
#                   要么报一堆假阳性要么直接失败
function Get-CenterCopyExclusions {
  # R161.25 (2026-10-29 部署审计) — 这份清单是**中心安装/升级/更新三条链
  # 共用的唯一排除表** (install-center / upgrade-center / update-center 全部
  # 调它) ⇒ 一处改, 三处同步。
  #
  # 'package-lock.json' (R161.25 新增): 目标机的依赖由
  # `npm install --omit=dev` 就地生成 —— lock 是**安装产物**, 不是交付物。
  # 源树里曾经躺着一份 2026-10-13 的**过期嵌套 lock** (419 个包 / 无
  # @modelcontextprotocol/sdk / 无 zod), 它会被原样拷到 <root>\Center,
  # 于是目标机的 npm install 拿一份**跟 package.json 对不上**的 lock 当基准
  # ⇒ 依赖树解析结果不可预期 (npm 会先去满足那份旧 lock, 再补差异)。
  # Linux 交付包早就把 center/package-lock.json 列入 FORBIDDEN_PATHS
  # (check-linux-package-sync.mjs 的 C4), README 也写着"那是脏文件, 删掉它"
  # —— 现在 Windows 侧对齐。
  return @(
    'node_modules',
    'tests',
    'vitest.config.js',
    'appsettings.json',
    '.install-hash',
    'Logs',
    '.env',
    'publish-sync.mjs',
    'audit',
    'package-lock.json',
    '_backup_pre_diag_cleanup_20261015_203424'
  )
}

# R161.25 — 读**机器级**的 init 完成标记 (Windows 注册表
# HKLM\SOFTWARE\ADDashboard\Initialized)。
#
# 为什么要在部署脚本里查它: 标记是**机器全局**的 (不是按安装目录),
# 所以在一台**曾经装过中心**的机器上做全新安装时, 即使目标目录里既没有
# .env 也没有 appsettings.json, hasMarker() 依然返回 true ⇒
# server.js 走 `markerLocked && !config` 分支 ⇒ process.exit(2) ⇒
# 服务起不来 + 向导进不去, 而日志里只有一行 "init marker present but
# config missing"。安装脚本必须在**启动服务之前**就把这件事挑明, 并给
# 出可执行的一条命令。
#
# 返回 @{ Present = <bool>; Detail = <text> }
function Get-CenterInitMarkerRegistryState {
  if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    return @{ Present = $false; Detail = 'not Windows — no registry marker' }
  }
  $key = 'HKLM\SOFTWARE\ADDashboard'
  $value = 'Initialized'
  $prevEap = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $out = & reg.exe query $key /v $value 2>$null
    $exitCode = $LASTEXITCODE
  } catch {
    $exitCode = 1
    $out = $null
  } finally {
    $ErrorActionPreference = $prevEap
  }
  if ($exitCode -eq 0 -and $out) {
    return @{ Present = $true; Detail = "registry marker present: $key\$value" }
  }
  return @{ Present = $false; Detail = "registry marker absent: $key\$value" }
}

# R161.25 (2026-10-29 部署审计) — 把 <源树>\build-manifest.json 复制到
# **<安装目录的上一级>**。
#
# 中心进程读的是 <repoRoot>\build-manifest.json (server.js:430) ⇒ repoRoot =
# <安装目录的上一级>。而旧实现只拷 center/ 与 db/ ⇒ 在**自定义安装路径**
# 下 (例如 -InstallPath D:\ADDashboard\Center), 目标机的上一级根本没有
# build-manifest.json ⇒ 中心启动指纹退化成 "build-manifest.json unreadable;
# boot fingerprint degraded" ⇒ 操作员**无法证明目标机上跑的是哪一版**。
# 默认布局 (installParent == 源树根) 是"碰巧"有, 不是设计出来的。
#
# 刻意**不**复制 package.json: 源树根的 package.json 是 npm workspaces 的
# 根清单, 把它放到目标机上会改变 `npm install` 的语义 (从普通安装变成
# workspace 安装 ⇒ 连带装 agent 工作区 ⇒ 原生模块 better-sqlite3 在离线
# 生产机上装不上)。中心对 <repoRoot>\package.json 的引用只是版本号的
# 兜底, 缺了不影响运行。
function Sync-CenterBuildManifest {
  param(
    [Parameter(Mandatory)][string]$SourceRoot,
    [Parameter(Mandatory)][string]$InstallPath
  )
  $manifestSrc = Join-Path $SourceRoot 'build-manifest.json'
  if (-not (Test-Path -LiteralPath $manifestSrc)) {
    # 不抛: build-manifest.json 是"启动指纹"这一个用途的辅助文件, 缺它
    # 只让指纹退化, 不影响服务运行。抛出来会把整个部署卡死在非关键文件上。
    return @{ Copied = $false; Target = ''; Message = "build-manifest.json not found at $manifestSrc — center boot fingerprint will degrade" }
  }
  $installAbs = if (Test-Path -LiteralPath $InstallPath) {
    (Resolve-Path -LiteralPath $InstallPath).Path
  } else {
    [System.IO.Path]::GetFullPath($InstallPath)
  }
  $installParent = Split-Path -Parent $installAbs
  if (-not $installParent) { $installParent = $SourceRoot }
  $manifestTarget = Join-Path $installParent 'build-manifest.json'
  if (Test-SamePath -PathA $manifestSrc -PathB $manifestTarget) {
    return @{ Copied = $false; Target = $manifestTarget; Message = "build-manifest.json already in place ($manifestTarget)" }
  }
  Copy-Item -LiteralPath $manifestSrc -Destination $manifestTarget -Force
  return @{ Copied = $true; Target = $manifestTarget; Message = "build-manifest.json copied -> $manifestTarget" }
}

# R161.25 (2026-10-29 部署审计) — 把 <源树>\db 同步到 **<安装目录的上一级>\db**。
#
# 为什么 db/ 必须在安装目录的**上一级**: 中心进程的 repoRoot = server.js 所在
# 目录的父目录 (server.js:329-330), 而迁移引擎扫的是
# <repoRoot>\db\migrations\<dialect>\ (src/services/migrations.js 的
# resolveMigrationsDir)。安装目录 = <installParent>\center ⇒ repoRoot =
# <installParent> ⇒ db/ 必须待在 <installParent>。
#
# ★ 为什么升级/更新路径也必须做这件事: 旧实现里 **只有 install-center.ps1
# 拷 db/**, upgrade-center.ps1 / update-center.ps1 都不拷 ⇒ 目标机上的
# db/migrations/ 永远停在**首次安装时**的那一版 ⇒ 新发布的迁移脚本永远到不了
# 目标机 ⇒ 升级脚本第 8 步"列出 pending 迁移"列出来的是**旧清单** ⇒
# "no pending migrations — DB is up-to-date" ⇒ **升级"成功"了, 但数据库
# 停在旧 schema**。这是本次部署审计里最隐蔽的一条 (静默降级, 不报错)。
#
# 用 Copy-DirectoryContent (overlay, 不删) 而不是 Sync: db/ 是随代码发布的
# 内容, 但删除目标目录是破坏性操作 —— 宁可多留一个陈旧文件, 也不能在部署
# 脚本里删东西。
function Sync-CenterDbDirectory {
  param(
    [Parameter(Mandatory)][string]$SourceRoot,
    [Parameter(Mandatory)][string]$InstallPath
  )
  $dbSrc = Join-Path $SourceRoot 'db'
  if (-not (Test-Path -LiteralPath $dbSrc)) {
    throw "the db/ directory (baseline + migrations) is missing at $dbSrc — the center cannot build or upgrade the schema without it"
  }
  $installAbs = if (Test-Path -LiteralPath $InstallPath) {
    (Resolve-Path -LiteralPath $InstallPath).Path
  } else {
    [System.IO.Path]::GetFullPath($InstallPath)
  }
  $installParent = Split-Path -Parent $installAbs
  if (-not $installParent) { $installParent = $SourceRoot }
  $dbTarget = Join-Path $installParent 'db'
  $copy = Copy-DirectoryContent -SourceDir $dbSrc -TargetDir $dbTarget
  return @{
    Source  = $dbSrc
    Target  = $dbTarget
    Status  = $copy.Status
    Message = $copy.Message
  }
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
  $result = Copy-TreeContent -SourceDir $SourceDir -TargetDir $TargetDir -Exclude $Exclude
  return @{ Status = 'copied'; Files = $result.Files; Excluded = $result.Excluded; Message = $result.Message }
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
  $result = Copy-TreeContent -SourceDir $SourceDir -TargetDir $TargetDir -Exclude $Exclude
  return @{ Status = 'replaced'; Files = $result.Files; Excluded = $result.Excluded; Message = $result.Message }
}

function Wait-ForHttpOk {
  # Poll a local URL until it returns 2xx. Service "Running" in SCM only
  # means NSSM launched the node process; Express still has to load modules
  # + bind the listening socket, which is 2-15s on cold cache. Without this
  # wait the install script's "probe health" call races the boot and prints
  # "unreachable" even though the service is fine.
  #
  # ★ 2026-10-29 部署审计: 旧实现把 **4xx 也算成功**
  #   (`$resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500`)。
  #   探的是 /api/init/status —— 它在 init 与正常两种模式下**都**返回 200
  #   (src/init/router.js:33, 两处模式都挂载), 所以 404/500 一定意味着
  #   "跑的不是这份代码"(旧二进制 / 路由没挂上 / 进程起不来),
  #   而旧实现会把这种状态报成 "probe green" ⇒ 安装脚本打印成功, 服务
  #   实际上不可用。收紧成只认 2xx。
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
  $lastStatus = $null
  while ((Get-Date) -lt $deadline) {
    $attempt++
    try {
      $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
      $lastStatus = $resp.StatusCode
      if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300) {
        Write-Host "[INFO] http probe: $Url returned $($resp.StatusCode) on attempt $attempt"
        return $true
      }
    } catch {
      # Connection refused / timeout — server still booting. Keep polling.
      # NOTE: 4xx/5xx 在 PS 5.1 / 7 里都是**抛出** WebException 而不是
      # 返回响应对象 ⇒ 上面那个 2xx 分支根本走不到 4xx。catch 里要把
      # 响应状态码取出来, 否则探针失败时操作员只看到 "连接被拒绝",
      # 看不出服务端其实回了 404 (路由不对 / 跑的是旧代码)。
      $statusCode = $null
      if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
        try { $statusCode = [int]$_.Exception.Response.StatusCode } catch { $statusCode = $null }
      }
      if ($statusCode) { $lastStatus = $statusCode }
    }
    Start-Sleep $IntervalSeconds
  }
  if ($lastStatus) {
    Write-Host "[INFO] http probe: $Url last responded with HTTP $lastStatus (not 2xx)"
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

# R161.27 (2026-11-06) — **自带 Node 优先**的运行时解析。
#
# 操作员 directive: 「将 Node 变更为 Server 目录下的 Node 服务器，而不需要
# 安装其他的 Node 环境」⇒ 部署链上所有 node / npm 调用必须**优先**用交付树
# 自带的 <root>\node\（node.exe + npm.cmd 已随包），本机 PATH 上没装 Node
# 也能完成安装与启动；只有自带的不在时才回落 PATH（开发机行为不变）。
#
# 解析顺序:
#   1. <projectRoot>\node\node.exe / node\npm.cmd   ← 绿包/源树都命中
#   2. PATH 上的 node.exe / npm.cmd                 ← 开发机回落
# 两者都拿不到 ⇒ 返回 $null, 调用方负责给出能看懂的报错（而不是让
# `Get-Command node.exe` 在深处抛 "Cannot find path" —— 与部署毫无关系）。
function Get-BundledNodeRuntime {
  param(
    [Parameter(Mandatory)] [string]$ProjectRoot,
    [ValidateSet('node', 'npm')] [string]$Kind = 'node'
  )

  $bundledExe = if ($Kind -eq 'node') { Join-Path $ProjectRoot 'node\node.exe' }
                else { Join-Path $ProjectRoot 'node\npm.cmd' }
  if (Test-Path -LiteralPath $bundledExe) { return $bundledExe }

  $command = Get-Command -Name ($Kind + '.exe') -ErrorAction SilentlyContinue
  if (-not $command) { $command = Get-Command -Name ($Kind + '.cmd') -ErrorAction SilentlyContinue }
  if (-not $command -and $Kind -eq 'npm') { $command = Get-Command -Name 'npm' -ErrorAction SilentlyContinue }
  if ($command) { return $command.Source }
  return $null
}

# R161.26 (2026-10-29 部署审计第二轮) — npm **工作区**感知的依赖安装。
#
# 病根 (实测, 2026-10-29; Server/ 是 workspaces 根: workspaces ["center","agent"])
# ----------------------------------------------------------------------------
#   在**工作区成员目录**里跑 `npm install --omit=dev`, npm 认的 install root
#   是**工作区根** (Server/package.json) —— 依赖被提升到 <root>\node_modules,
#   而**成员自己的 devDependencies 会被一起剪掉**:
#     实测 (Server 源树 dry-run): "removed 141 packages" = vite / vitest /
#     jsdom / supertest / @vue/test-utils / @vitejs/plugin-vue / rollup ...
#     ⇒ 装完这台机器**再也 build 不出前端、跑不了 web 测试**, 而下一条命令
#     报的是 "vite: not found" —— 与部署毫无关系, 现场离原因十万八千里。
#     实测 (D:\temp\wsprobe5 三工作区探针): 成员目录跑 ⇒ 剪掉的是**本成员**
#     的 devDeps, **兄弟工作区的依赖原样保留** (agent 的 is-odd 没被动过)
#     ⇒ 这条病根**只伤自己**, 不伤兄弟。
#
#   另一半 (同样是实测): 兄弟工作区 (agent) 的**原生依赖** better-sqlite3
#   **只有在工作区根上跑 install 时**才会被拉进来 (Server 源树 dry-run:
#   "add better-sqlite3 11.10.0" + prebuild-install / node-abi /
#   napi-build-utils 等 30 个包)。它要下载预编译二进制, 或者现场拉 C++
#   工具链 —— **离线目标机直接装不上** ⇒ 安装器抛错 ⇒ 服务装不上。
#   旧代码之所以躲过这一劫, 靠的是"cwd 恰好在成员目录"这个**巧合** ——
#   代码里没有任何东西说明这件事; 而 install-center.ps1 里紧挨着的
#   `npm install --workspace=center --include=dev` 恰恰是**在根上**跑的。
#   ⇒ 所以作用域必须**显式**写进命令行 (`--workspace=<member>`), 而不是
#     靠 cwd 的启发式。
#
# 修法
# ----------------------------------------------------------------------------
#   1. 装之前**记下**共享根里有没有中心的构建/测试工具链 (node_modules\vite);
#   2. 装: 工作区成员 ⇒ 在**工作区根**上跑 `--workspace=<member>` (显式限定,
#      不依赖 npm 对 cwd 的启发式); 非成员 (交付包布局) ⇒ 原地装, 行为不变;
#      **落位不变** —— 成员目录跑和根上带 --workspace 跑, 依赖都提升到
#      <root>\node_modules (实测: 三工作区探针下两者对兄弟工作区的效果
#      完全一致), 所以目标机上的安装位置与历史行为逐字节相同;
#   3. 装完**复验**依赖可解析 —— 失败当场抛, 绝不带着残缺依赖启动服务;
#   4. 装完如果工具链被剪掉了 ⇒ **把它装回来**。
#      生产目标机上 center 的 devDependencies 本来就没装 ⇒ 第 1 步记的是
#      "没有" ⇒ 第 4 步是 no-op ⇒ **目标机行为一个字节都不变**。

# npm 的 workspaces 条目可以是 glob ("packages/*"), 转成正则才能匹配成员路径。
# 顺序不能反: '**' 里也含 '*', 先替 '**' 才不会把 '**' 拆成两个 '*'。
function ConvertTo-WorkspaceGlobRegex {
  param([Parameter(Mandatory)] [string]$Pattern)
  $escaped = [regex]::Escape($Pattern)
  $escaped = $escaped -replace '\\\*\\\*', '.*'
  $escaped = $escaped -replace '\\\*', '[^/]*'
  return ('^' + $escaped + '$')
}

# 找出 $StartDir 所在的 npm **工作区成员**上下文。
#
# 返回 @{ Root = <工作区根绝对路径>; Member = <成员相对路径, 用 '/' 分隔> }
# 或 $null (不是任何工作区的成员 —— 交付包布局就是这种)。
#
# 判定规则 (与 npm 自己的行为一致):
#   · 从 $StartDir 的**父目录**开始往上找;
#   · 某个祖先目录里有 package.json, 且它的 workspaces 字段是**非空数组**;
#   · $StartDir 相对该根的路径**命中**其中某个条目 (条目可以是 glob)。
function Get-NpmWorkspaceContext {
  param([Parameter(Mandatory)] [string]$StartDir)

  $start = $null
  # 先 Test-Path: Resolve-Path 对不存在的路径会写一行错误到错误流 (即使被
  # catch 吞掉, 那行噪音也会跟着打进安装日志)。目录不存在 ⇒ 不是成员。
  if (Test-Path -LiteralPath $StartDir) {
    try { $start = (Resolve-Path -LiteralPath $StartDir).Path } catch { $start = $null }
  }
  if (-not $start) { return $null }

  $dir = Split-Path -Parent $start
  while ($dir -and -not [string]::IsNullOrEmpty($dir)) {
    $manifestPath = Join-Path $dir 'package.json'
    if (Test-Path -LiteralPath $manifestPath) {
      $entries = @()
      try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        $workspaces = $manifest.workspaces
        if ($workspaces -is [string]) {
          $entries = @($workspaces)
        } elseif ($workspaces -and ($workspaces -is [System.Collections.IEnumerable])) {
          foreach ($item in $workspaces) { if ($item) { $entries += [string]$item } }
        } elseif ($workspaces -and ($workspaces.PSObject.Properties.Name -contains 'packages')) {
          foreach ($item in @($workspaces.packages)) { if ($item) { $entries += [string]$item } }
        }
      } catch {
        $entries = @()
      }
      if ($entries.Count -gt 0) {
        $relative = $start.Substring($dir.Length).TrimStart('\', '/') -replace '\\', '/'
        if ($relative) {
          foreach ($entry in $entries) {
            if ($relative -match (ConvertTo-WorkspaceGlobRegex -Pattern $entry)) {
              return @{ Root = $dir; Member = $relative }
            }
          }
        }
      }
    }
    $parent = Split-Path -Parent $dir
    if (-not $parent -or $parent -eq $dir) { break }
    $dir = $parent
  }
  return $null
}

# 装中心的生产依赖 —— install / upgrade / update **三条链共用**这一份实现。
#
# 本函数**自己不写日志** (Logger.psm1 不在 Service.psm1 的作用域里 ——
# 模块函数看不到调用脚本的私有作用域), 只返回结果对象给调用方打印。
# 失败一律 throw (绝不吞), 调用方不要自己再判退出码。
function Install-CenterNodeDeps {
  param(
    [Parameter(Mandatory)] [string]$InstallPath,
    [string[]]$Probe = @('express', 'pino'),
    [string]$ProjectRoot
  )

  $context = Get-NpmWorkspaceContext -StartDir $InstallPath

  # R161.27 — 自带 Node 优先: <root>\node\npm.cmd 在就用它, 没有才用 PATH。
  # $ProjectRoot 缺省 = 工作区根 (workspace 布局) / 安装目录 (交付包布局)。
  $npmRoot = if ($context) { $context.Root } else { $InstallPath }
  if (-not $ProjectRoot) { $ProjectRoot = $npmRoot }
  $npmCmd = Get-BundledNodeRuntime -ProjectRoot $ProjectRoot -Kind 'npm'
  if (-not $npmCmd) {
    throw "npm not found — neither <root>\node\npm.cmd (bundled) nor npm on PATH. 交付树自带 node\ 必须完整 (node.exe + npm.cmd), 或者本机装 Node 20 LTS 并加入 PATH。"
  }
  # npm.cmd 与 node.exe 必须同目录 (npm 内部要用相邻的 node 前缀) ⇒ 把自带
  # node\ 前置到 PATH, 让 npm.cmd 起的子进程 (node-gyp / prebuild-install)
  # 也用同一份 node, 不吃系统 PATH 上的旧版本。
  $bundledNodeExe = Get-BundledNodeRuntime -ProjectRoot $ProjectRoot -Kind 'node'
  if ($bundledNodeExe) {
    $env:PATH = (Split-Path -Parent $bundledNodeExe) + ';' + $env:PATH
  }

  # 装之前记下共享根里有没有中心的构建/测试工具链 —— `--omit=dev` 会把它剪掉。
  $devToolingMarker = $null
  $hadDevTooling = $false
  if ($context) {
    $devToolingMarker = Join-Path $context.Root 'node_modules\vite'
    $hadDevTooling = Test-Path -LiteralPath $devToolingMarker
  }

  if ($context) {
    # 工作区成员 ⇒ 在**工作区根**上跑, 并显式限定到本工作区:
    #   · 不把兄弟工作区 (agent) 的原生依赖 better-sqlite3 一起装;
    #   · 依赖仍然装在工作区根的 node_modules (与既有布局一致, 不改
    #     目标机上的落位 ⇒ 离线机的 "up to date" 快路径不受影响)。
    Push-Location $context.Root
    try {
      & $npmCmd install --omit=dev --no-audit --no-fund --workspace=$($context.Member)
      if ($LASTEXITCODE -ne 0) {
        throw "npm install --omit=dev --workspace=$($context.Member) failed at $($context.Root) (exit $LASTEXITCODE)"
      }
    } finally { Pop-Location }
  } else {
    # 交付包布局 (中心旁边没有 workspaces 根) ⇒ 原地装, 与历史行为一致。
    Push-Location $InstallPath
    try {
      & $npmCmd install --omit=dev --no-audit --no-fund
      if ($LASTEXITCODE -ne 0) {
        throw "npm install --omit=dev failed in $InstallPath (exit $LASTEXITCODE)"
      }
    } finally { Pop-Location }
  }

  # 装完复验 —— npm 失败时绝不能把哈希记成成功 (服务带着残缺依赖启动 ⇒
  # 崩溃重启循环, R121 / R123 / R124 家族)。探针用**同一份** node:
  # PATH 上有多个 node 版本时, "npm 装的树" 和 "探针解析的树" 必须是同一
  # 个 node 下的行为。
  $probeNode = if ($bundledNodeExe) { $bundledNodeExe } else { 'node' }
  if (-not (Test-NodeDepsResolvable -InstallPath $InstallPath -Probe $Probe -NodeExe $probeNode)) {
    throw "dependencies still not resolvable after npm install in $InstallPath — 离线服务器请预置 node_modules 或 npm 缓存后重试 (绝不带着残缺依赖启动服务)"
  }

  # 把被 `--omit=dev` 剪掉的构建/测试工具链装回来。
  # 只在"装之前本机就有"时才恢复 ⇒ 生产目标机 (devDependencies 本来就没装)
  # 这一步永远是 no-op。
  $devToolingRestored = $false
  $devToolingRestoreFailed = $false
  if ($hadDevTooling -and -not (Test-Path -LiteralPath $devToolingMarker)) {
    Push-Location $context.Root
    try {
      & $npmCmd install --workspace=$($context.Member) --include=dev --no-audit --no-fund
      if ($LASTEXITCODE -ne 0) { $devToolingRestoreFailed = $true }
      else { $devToolingRestored = $true }
    } catch {
      $devToolingRestoreFailed = $true
    } finally { Pop-Location }
  }

  $mode = 'standalone'
  $root = $InstallPath
  $member = ''
  if ($context) {
    $mode = 'workspace'
    $root = $context.Root
    $member = $context.Member
  }

  return @{
    Mode = $mode
    Root = $root
    Member = $member
    DevToolingRestored = $devToolingRestored
    DevToolingRestoreFailed = $devToolingRestoreFailed
  }
}
