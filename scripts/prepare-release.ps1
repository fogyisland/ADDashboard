# prepare-release.ps1 — one-shot release preparation. Runs the five sync
# scripts in dependency order, then verifies each mirror. Replaces the manual
# sequence operator used to run before every push:
#
#   1. .\scripts\sync-source-mirror.ps1     # center/src + center/web + db/migrations + db/schema + docs
#   2. .\scripts\sync-dist.ps1              # center/dist (post build:web) → publish/system/center/dist
#   3. .\scripts\sync-scripts-mirror.ps1    # scripts/{allow-list} → publish/system/scripts (R88+ no-wipe)
#   4. .\installer\sync-agentInstall.ps1    # agent/ + scripts/{install,start,…} + common/ + README
#                                          # → publish/installer/agentInstall/  (CLIENT green package)
#   5. .\scripts\verify-mirror.ps1          # assert byte-identical for the server bundle
#   6. .\installer\verify-agentInstall.ps1  # assert byte-identical for the client green package
#
# Pre-R88 each script ran independently with no shared "did the whole chain
# succeed?" signal. Operators routinely missed step 2 (stale dist), 3 (drift),
# or 4 (no verification). This wrapper enforces the order, surfaces a single
# pass/fail summary, and exits non-zero if any step fails — so CI / a
# pre-push hook can call it once instead of remembering four names.
#
# The script does NOT push, commit, or restart NSSM. It only stages
# publish/system/ + publish/installer/agentInstall/ to be in sync with
# source. The operator reviews the diff and commits when satisfied.
#
# R90: split the sync scope into two verify endpoints:
#   - verify-mirror.ps1 (server-side publish/system/)
#   - verify-agentInstall.ps1 (client-side publish/installer/agentInstall/)
# R82/R12 previously merged them into one ship; the agentInstall/ bundle
# ships to customer machines and is just as load-bearing — a drift here
# is a customer-visible bug, not a dev-tree smell. Splitting the verify
# surfaces "which half drifted" instead of a single FAIL that could mean
# either.
#
# Usage:
#   .\scripts\prepare-release.ps1
#
# Exit codes:
#   0 — all six steps passed; both bundles in sync with source
#   1 — one or more steps failed; see the [FAIL] line in the summary table
#   2 — pre-flight failed (npm run build:web missing or stale); see the
#       [PRE-FAIL] line in the summary table
#
# PowerShell 5.1 + pwsh 7+ compatible. No `??`, no ternary, no 3-arg
# Join-Path. Follows the project's existing sync-script conventions
# (ProjectRoot = Resolve-Path(PSScriptRoot/..); $ErrorActionPreference = 'Stop').
[CmdletBinding()]
param(
  [switch]$SkipBuildCheck,  # skip the "is dist fresh?" pre-flight (debugging only)
  [switch]$SkipDist          # skip sync-dist (when center/dist hasn't been built yet — R90.x)
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

$steps = @(
  @{ Name = 'sync-source-mirror';  Script = 'sync-source-mirror.ps1';   Skip = $false; Dir = 'scripts' }
  @{ Name = 'sync-dist';           Script = 'sync-dist.ps1';            Skip = $SkipDist; Dir = 'scripts' }
  @{ Name = 'sync-scripts-mirror'; Script = 'sync-scripts-mirror.ps1';  Skip = $false; Dir = 'scripts' }
  @{ Name = 'sync-agentInstall';   Script = 'sync-agentInstall.ps1';    Skip = $false; Dir = 'installer' }
  @{ Name = 'verify-mirror';       Script = 'verify-mirror.ps1';        Skip = $false; Dir = 'scripts' }
  @{ Name = 'verify-agentInstall'; Script = 'verify-agentInstall.ps1';  Skip = $false; Dir = 'installer' }
)

function Invoke-Step {
  param(
    [Parameter(Mandatory)] [string]$Name,
    [Parameter(Mandatory)] [string]$Script
  )
  $path = Join-Path (Join-Path $projectRoot 'scripts') $Script
  if (-not (Test-Path -LiteralPath $path)) {
    Write-Host ("[FAIL ] {0,-22} script missing: {1}" -f $Name, $path) -ForegroundColor Red
    return @{ Name = $Name; Ok = $false; Detail = 'script missing' }
  }
  Write-Host ""
  Write-Host ("[run  ] {0,-22} {1}" -f $Name, $Script) -ForegroundColor Cyan
  $stdout = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $path 2>&1
  $rc = $LASTEXITCODE
  if ($rc -eq 0) {
    Write-Host ("[ok   ] {0,-22} rc=0" -f $Name) -ForegroundColor Green
    return @{ Name = $Name; Ok = $true; Detail = '' }
  } else {
    Write-Host ("[FAIL ] {0,-22} rc={1}" -f $Name, $rc) -ForegroundColor Red
    Write-Host ($stdout -join "`n")
    return @{ Name = $Name; Ok = $false; Detail = "rc=$rc" }
  }
}

# ---------- Pre-flight: is dist fresh? -------------------------------------
# sync-dist silently no-ops if center/dist is missing AND will copy whatever
# is there regardless of age. A stale dist (dist older than web/src) is the
# #1 cause of "I pushed the fix but users still see the old UI" incidents
# (the 2026-08-22 morning 500-error was this exact class). Surface it here
# so the operator either rebuilds or passes -SkipBuildCheck knowingly.
$preflightOk = $true
$preflightDetail = ''
if (-not $SkipBuildCheck) {
  $srcWeb = Join-Path $projectRoot 'center/web'
  $distPath = Join-Path $projectRoot 'center/dist/index.html'
  if (Test-Path -LiteralPath $distPath) {
    $distTime = (Get-Item -LiteralPath $distPath).LastWriteTime
    $newestSrc = $null
    if (Test-Path $srcWeb) {
      $newestSrc = Get-ChildItem -Path $srcWeb -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch '[\\/]node_modules[\\/]' } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    }
    if ($newestSrc -and $newestSrc.LastWriteTime -gt $distTime) {
      $preflightOk = $false
      $preflightDetail = "center/dist/index.html is older than newest web/src ({0:o} < {1:o}). Run 'npm run build:web' first or pass -SkipBuildCheck." -f $distTime, $newestSrc.LastWriteTime
      Write-Host ("[PRE-FAIL] {0}" -f $preflightDetail) -ForegroundColor Red
    }
  }
}

if (-not $preflightOk) {
  Write-Host ""
  Write-Host "release preparation ABORTED before any sync step" -ForegroundColor Red
  exit 2
}

# ---------- Run the four sync steps in order -------------------------------
$results = @()
foreach ($s in $steps) {
  if ($s.Skip) {
    Write-Host ""
    Write-Host ("[skip ] {0,-22} (skip flag set)" -f $s.Name) -ForegroundColor Yellow
    $results += @{ Name = $s.Name; Ok = $true; Detail = 'skipped' }
    continue
  }
  $path = Join-Path (Join-Path $projectRoot $s.Dir) $s.Script
  Write-Host ""
  Write-Host ("[run  ] {0,-22} {1}\{2}" -f $s.Name, $s.Dir, $s.Script) -ForegroundColor Cyan
  if (-not (Test-Path -LiteralPath $path)) {
    Write-Host ("[FAIL ] {0,-22} script missing: {1}" -f $s.Name, $path) -ForegroundColor Red
    $results += @{ Name = $s.Name; Ok = $false; Detail = 'script missing' }
    break
  }
  $stdout = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $path 2>&1
  $rc = $LASTEXITCODE
  if ($rc -eq 0) {
    Write-Host ("[ok   ] {0,-22} rc=0" -f $s.Name) -ForegroundColor Green
    $results += @{ Name = $s.Name; Ok = $true; Detail = '' }
  } else {
    Write-Host ("[FAIL ] {0,-22} rc={1}" -f $s.Name, $rc) -ForegroundColor Red
    Write-Host ($stdout -join "`n")
    $results += @{ Name = $s.Name; Ok = $false; Detail = "rc=$rc" }
    break   # stop on first failure; subsequent steps may depend on prior state
  }
}

# ---------- Summary --------------------------------------------------------
Write-Host ""
Write-Host "============== prepare-release summary ==============" -ForegroundColor Cyan
$width = 22
foreach ($r in $results) {
  $tag = if ($r.Ok) { '[ok   ]' } else { '[FAIL ]' }
  $color = if ($r.Ok) { 'Green' } else { 'Red' }
  $line = "{0} {1,-$width} {2}" -f $tag, $r.Name, $r.Detail
  Write-Host $line -ForegroundColor $color
}

$failed = $results | Where-Object { -not $_.Ok }
if ($failed) {
  Write-Host ""
  Write-Host ("{0} of {1} steps failed" -f $failed.Count, $results.Count) -ForegroundColor Red
  Write-Host "publish/ is NOT in sync with source — DO NOT push." -ForegroundColor Red
  exit 1
} else {
  Write-Host ""
  Write-Host "all steps passed — publish/system/ + publish/installer/agentInstall/ match source. Review git status and commit." -ForegroundColor Green
  Write-Host "  git status publish/" -ForegroundColor Gray
  Write-Host "  git diff --stat HEAD publish/" -ForegroundColor Gray
  exit 0
}