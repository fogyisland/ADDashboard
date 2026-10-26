# R119.B.UPGRADE helper — append a new round entry to build-manifest.json.
#
# Single source of truth for "what version is shipped?" is
# <root>/build-manifest.json (and its mirror copy at
# <root>/agent/build-manifest.json). This script appends a new round entry
# to both files atomically while preserving historical rounds (append-only
# discipline — never modify or delete a previous entry).
#
# Usage:
#   pwsh -File scripts/release/append-manifest.ps1 -RoundId R119.B.UPGRADE -Tag "withModuleLogger + APP/ log"
#   pwsh -File scripts/release/append-manifest.ps1 -RoundId R120 -Tag "..." -RootPath D:\ToolDevelop\ADDashboard
#
# Idempotency:
#   - If a round with the same `id` already exists, the script exits 0 and
#     prints a notice without modifying anything. This makes it safe to
#     re-run after a partial failure.
#
# Schema invariants (preserved across every run):
#   - top-level keys: `version` (semver X.Y.Z), `buildTime` (ISO 8601 UTC),
#     `gitCommit` (sha), `rounds[]`, `features[]`
#   - each rounds[i] has: { id, tag, shippedAt }
#   - features[] is append-only too; passing -Features "f1,f2" appends new
#     entries (deduped by exact string match), preserves existing ones
#
# This script is intentionally PS 5.1-compatible (Get-Content -Raw,
# ConvertFrom-Json, Set-Content -Encoding UTF8 with explicit BOM handling).
[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidatePattern('^R\d+(\.\d+)?(\.\w+)?$')]
  [string]$RoundId,

  [Parameter(Mandatory)]
  [ValidateNotNullOrEmpty()]
  [string]$Tag,

  [string[]]$Features = @(),

  # Round summary. 两份 manifest 里**每一条** round 都带 summary 字段
  # (实际文件: build-manifest.json 的 rounds[i] = {id, tag, shippedAt, summary})。
  # 旧实现只写 {id, tag, shippedAt} ⇒ 用本脚本追加的 round 会是**唯一一个
  # 没有 summary 的条目**, 与既有 schema 不一致。传了就写, 没传就不写
  # (保持向后兼容)。
  [string]$Summary = '',

  # Next-version bump. Defaults to "auto" = patch-bump the current version
  # string (e.g. "1.0.119" -> "1.0.120"). Pass explicit "X.Y.Z" to override.
  [string]$NextVersion = 'auto',

  # Root of the tree holding build-manifest.json + agent/build-manifest.json.
  # 默认 = 本脚本自己的位置往上两级 (scripts/release/ → 树根)。旧默认是
  # (Get-Location).Path —— 在**任何**别的目录下调用都会写到一棵不相关的树,
  # 或者报一句让人摸不着头脑的 "manifest not found at C:\...\build-manifest.json"。
  [string]$RootPath
)

$ErrorActionPreference = 'Stop'

function Resolve-ManifestPath {
  param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][ValidateSet('root','agent')][string]$Which)
  if ($Which -eq 'root') {
    return (Join-Path $Root 'build-manifest.json')
  }
  return (Join-Path $Root 'agent/build-manifest.json')
}

function Bump-PatchVersion {
  param([Parameter(Mandatory)][string]$Current)
  if ($Current -notmatch '^(\d+)\.(\d+)\.(\d+)$') {
    Write-Warning "version '$Current' is not semver X.Y.Z; leaving unchanged"
    return $Current
  }
  $major = [int]$Matches[1]
  $minor = [int]$Matches[2]
  $patch = [int]$Matches[3] + 1
  return ("{0}.{1}.{2}" -f $major, $minor, $patch)
}

function Get-CurrentGitCommit {
  # Returns the short SHA of HEAD of the **target tree**, or 'unknown' if git
  # is unavailable / the tree is not a git checkout. Never throws.
  #
  # 两个修复:
  #   1) 旧实现 `catch { }` 是**空 catch** —— 违反项目规范 (禁止静默吞错),
  #      而且操作员完全看不出"gitCommit=unknown"是怎么来的。现在明确 warn。
  #   2) 旧实现用 `git rev-parse HEAD` —— 读的是**当前工作目录**的仓库,
  #      不是 $RootPath 的仓库。操作员在别处 (或子目录) 调用时, 写进
  #      manifest 的 commit 是另一棵树的 sha ⇒ 指纹指向错误的提交。
  #      现在用 `git -C <root>`。
  param([Parameter(Mandatory)][string]$Root)
  try {
    $sha = (& git -C $Root rev-parse HEAD 2>$null) | Select-Object -First 1
    if ($sha -and $sha.Length -ge 7) { return $sha.Trim() }
    Write-Warning "git returned no commit for '$Root' (not a git checkout? detached with no HEAD?) — gitCommit will be 'unknown'."
  } catch {
    Write-Warning "cannot read git commit from '$Root': $($_.Exception.Message) — gitCommit will be 'unknown'."
  }
  return 'unknown'
}

function Read-Manifest {
  param([Parameter(Mandatory)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "manifest not found at $Path"
  }
  $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
  $obj = $raw | ConvertFrom-Json
  if (-not $obj) { throw "manifest at $Path is empty or unparseable" }
  return $obj
}

function Write-ManifestAtomic {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)]$Obj
  )
  $json = $Obj | ConvertTo-Json -Depth 10
  # Atomic write: write to .tmp then rename, so a crash mid-write never
  # leaves the manifest half-written. PS 5.1 lacks Rename-Item cross-volume
  # so we resolve both to the same directory first.
  $dir = Split-Path -Path $Path -Parent
  $tmp = Join-Path $dir ('.manifest.tmp.' + [Guid]::NewGuid().ToString('N') + '.json')
  try {
    # Use UTF8 with NO BOM — JSON parsers (incl. Node + PowerShell + VS Code
    # + diff tools) all handle BOM-free UTF-8 cleanly. PS 5.1's default
    # Set-Content -Encoding UTF8 writes BOM; use [IO.File]::WriteAllText
    # to bypass that.
    [System.IO.File]::WriteAllText($tmp, $json, [System.Text.UTF8Encoding]::new($false))
    Move-Item -Path $tmp -Destination $Path -Force
  } catch {
    if (Test-Path $tmp) { Remove-Item -Path $tmp -Force -ErrorAction SilentlyContinue }
    throw
  }
}

function Update-Manifest {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$RoundId,
    [Parameter(Mandatory)][string]$Tag,
    [string]$Summary,
    [string[]]$Features,
    [Parameter(Mandatory)][string]$NextVersion,
    [Parameter(Mandatory)][string]$GitCommit,
    # 时间戳由主流程**一次性**算好再传给两个 manifest —— 同一个发布轮次在
    # 两份文件里必须是同一个时间戳。旧实现每个 Update-Manifest 调用各自
    # Get-Date ⇒ 同一次发布在 root / agent 两份 manifest 里记的是两个不同
    # 的时间 (还会差一秒), 事后对账"这轮到底什么时候发的"会得到两个答案。
    [Parameter(Mandatory)][string]$Timestamp
  )

  $mfst = Read-Manifest -Path $Path

  # Idempotency: if this RoundId is already in rounds[], no-op.
  $existingRounds = @()
  if ($mfst.rounds) { $existingRounds = @($mfst.rounds) }
  $alreadyShipped = $existingRounds | Where-Object { $_.id -eq $RoundId } | Select-Object -First 1
  if ($alreadyShipped) {
    # Write-Host 而不是 Write-Output: Write-Output 会把这一行塞进函数
    # 的**返回值**, 于是 $rootChanged 变成 @("  [skip] ...", $false) 这种
    # 数组 —— 1) 操作员在控制台上**看不到**这行进度; 2) `-not $rootChanged`
    # 对非空数组永远为 $false ⇒ 末尾的 "already shipped — no-op" 分支
    # 永远不会触发。同一个函数的 [ok] 行也是同样下场。
    Write-Host "  [skip] $Path already has round $RoundId (shippedAt=$($alreadyShipped.shippedAt))"
    return $false
  }

  $newRound = [ordered]@{
    id        = $RoundId
    tag       = $Tag
    shippedAt = $Timestamp
  }
  if ($Summary) { $newRound['summary'] = $Summary }
  $mfst.rounds = @($existingRounds + $newRound)

  # Append new features (deduped by exact string); preserve existing ones.
  $existingFeatures = @()
  if ($mfst.features) { $existingFeatures = @($mfst.features) }
  if ($Features -and $Features.Count -gt 0) {
    # PS 5.1 New-Object quirk: it binds the HashSet[string] ctor's int-capacity
    # overload when the arg looks stringy. Use the AddRange(IEnumerable[string])
    # method instead — which has unambiguous type resolution.
    $seen = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($e in @($existingFeatures)) { [void]$seen.Add([string]$e) }
    foreach ($f in $Features) {
      $trimmed = $f.Trim()
      if (-not $trimmed) { continue }
      if (-not $seen.Contains($trimmed)) {
        $seen.Add($trimmed) | Out-Null
        $existingFeatures += $trimmed
      }
    }
  }
  $mfst.features = $existingFeatures

  # Bump version. Always refresh gitCommit + buildTime.
  if ($NextVersion -eq 'auto') {
    $mfst.version = Bump-PatchVersion -Current ([string]$mfst.version)
  } else {
    if ($NextVersion -notmatch '^\d+\.\d+\.\d+$') {
      throw "-NextVersion '$NextVersion' is not semver X.Y.Z"
    }
    $mfst.version = $NextVersion
  }
  $mfst.gitCommit = $GitCommit
  $mfst.buildTime = $Timestamp

  Write-ManifestAtomic -Path $Path -Obj $mfst
  Write-Host "  [ok]   $Path  → round $RoundId appended, version=$($mfst.version), commit=$GitCommit"
  return $true
}

# --- main --------------------------------------------------------------------

# RootPath 默认值 = 本脚本自己的位置往上两级 (scripts/release/ → 树根)。
# 旧默认 (Get-Location).Path 意味着"在哪个目录敲的命令就改哪棵树" ——
# 在 scripts\ 下敲就找不到 manifest, 在 C:\ 下敲就报一句莫名其妙的
# "manifest not found at C:\build-manifest.json"。
if (-not $RootPath) {
  $RootPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
}

$rootMfst = Resolve-ManifestPath -Root $RootPath -Which root
$agentMfst = Resolve-ManifestPath -Root $RootPath -Which agent

# 两份 manifest 必须**都**在, 才动任何一份。缺一份就整体放弃 ——
# 否则 tree 停在半更新状态 (一份有新 round、另一份没有, 版本号也只 bump
# 了一半), 而这种状态最难受: 谁也说不清当前 shipped 的是哪一轮。
$missing = @()
if (-not (Test-Path -LiteralPath $rootMfst)) { $missing += $rootMfst }
if (-not (Test-Path -LiteralPath $agentMfst)) { $missing += $agentMfst }
if ($missing.Count -gt 0) {
  throw ("manifest(s) not found under '$RootPath': " + ($missing -join ', ') +
         " — nothing was modified. Pass -RootPath '<tree that contains build-manifest.json and agent\build-manifest.json>'.")
}

# Resolve -Features: accept either a string array or a comma-separated string
# (PS 5.1 doesn't auto-split CSV). When called from another script with
# -Features @('f1','f2') the array passes through untouched; when called
# from the CLI with -Features "f1,f2" we split it once here.
if ($Features.Count -eq 1 -and $Features[0] -match ',') {
  $Features = $Features[0] -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
}

$gitCommit = Get-CurrentGitCommit -Root $RootPath
# 一次发布 = 一个时间戳, 两份 manifest 共用 (见 Update-Manifest 的说明)。
$timestamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

Write-Output "appending $RoundId → both manifests under $RootPath (timestamp $timestamp)"
$rootChanged = Update-Manifest -Path $rootMfst -RoundId $RoundId -Tag $Tag -Summary $Summary -Features $Features -NextVersion $NextVersion -GitCommit $gitCommit -Timestamp $timestamp
$agentChanged = Update-Manifest -Path $agentMfst -RoundId $RoundId -Tag $Tag -Summary $Summary -Features $Features -NextVersion $NextVersion -GitCommit $gitCommit -Timestamp $timestamp

if (-not $rootChanged -and -not $agentChanged) {
  Write-Output "round $RoundId already shipped in both manifests — no-op"
  exit 0
}
if ($rootChanged -ne $agentChanged) {
  # 一边写了、另一边上一轮就已经写过 = 上一次发布只完成了一半 (进程中途
  # 被杀 / Ctrl-C)。必须说出来: 否则操作员以为两边的 version 一样。
  Write-Warning "round $RoundId was already present in one manifest and has just been added to the other — the previous run of this script was interrupted half-way. Note: the two manifests are independent version tracks (center X.Y.Z, agent 0.Y.Z); their 'version' fields are expected to differ."
}
exit 0