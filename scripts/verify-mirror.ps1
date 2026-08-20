# verify-mirror.ps1 — auto-scan source ↔ publish/ mirror parity.
#
# Convention: every non-test source file under center/, agent/, frontend/, and
# db/migrations/ is mirrored byte-identical into publish/system/<same-path>
# (see project memory feedback_full_chain_cleanup.md). Test files are NOT
# mirrored — that's the runtime-only bundle convention (publish/ is what users
# run on C:\addashboard, not what we develop in).
#
# This script auto-discovers source files under four roots and verifies each
# one has a byte-identical mirror. It also flags orphan mirror files (in
# publish/system/... but with no source counterpart — usually stale).
#
# Why auto-scan instead of a hand-maintained list: the previous hand-written
# list (49 pairs as of 2026-08-20) drifted behind reality — new source files
# were added in earlier SDDs (frontend/src/lib/notify.js, ErrorBanner.vue)
# without being mirrored, and the list wasn't updated. Auto-scan closes the
# gap permanently: any new source file is mirrored or the verify fails.
#
# Usage:
#   pwsh -File scripts\verify-mirror.ps1
#
# Compatible with PowerShell 5.1+ (no ternary `? :`, no 3-arg Join-Path, no
# -AsHashtable, no null-coalescing `??`). See feedback_powershell_51.md.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
# Resolve-Path returns a PathInfo object, NOT a string. Use .Path so .Length
# returns the byte count (otherwise .Substring(0) returns the whole path and
# relPath becomes "D:/ToolDevelop/..." instead of "center/src/...", producing
# invalid mirror paths like "publish/system/D:/ToolDevelop/...").
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

# Source roots that get mirrored under publish/system/<same-relative-path>.
# Tests live under <pkg>/tests/ at the repo root, never inside src/, so a
# plain recursive scan of these roots naturally excludes test files.
$roots = @(
  'center/src',
  'frontend/src',
  'agent',
  'db/migrations'
)

# Source file extensions. Excludes README.md / package.json / *.json config /
# etc — only code we actually ship to users.
$extensions = @('*.js', '*.vue', '*.sql')

$pass = 0
$drift = 0
$missing = 0
$orphan = 0
$fail = $false

function Pair-Line($n, $ok, $detail) {
  $status = if ($ok) { 'PASS' } else { "FAIL $detail" }
  $line = "{0,-86} {1}" -f $n, $status
  if ($ok) {
    Write-Host $line
  } else {
    Write-Host $line -ForegroundColor Red
    $script:fail = $true
  }
}

# Build a set of all source files for orphan-detection later.
$sourceRelSet = @{}

foreach ($root in $roots) {
  $srcAbs = Join-Path $projectRoot $root
  if (-not (Test-Path -LiteralPath $srcAbs)) { continue }

  $files = Get-ChildItem -Path $srcAbs -Recurse -File -Include $extensions -ErrorAction SilentlyContinue
  foreach ($f in $files) {
    # Normalize to forward-slash relative path from project root.
    $relPath = $f.FullName.Substring($projectRoot.Length).TrimStart('\', '/').Replace('\', '/')
    # Test files live under <pkg>/tests/ at the repo root and are NOT mirrored
    # to publish/system/ (publish is the runtime-only bundle users run, not what
    # we develop in). Skip them so they don't show up as "missing mirror".
    if ($relPath -match '/tests/') { continue }
    $sourceRelSet[$relPath] = $true

    $mirrorRel = "publish/system/$relPath"
    $mirrorAbs = Join-Path $projectRoot $mirrorRel

    if (-not (Test-Path -LiteralPath $mirrorAbs)) {
      Pair-Line $relPath $false 'mirror missing'
      $missing++
      continue
    }

    $leftHash = (Get-FileHash -Algorithm SHA256 -Path $f.FullName).Hash
    $rightHash = (Get-FileHash -Algorithm SHA256 -Path $mirrorAbs).Hash

    if ($leftHash -eq $rightHash) {
      Pair-Line $relPath $true ''
      $pass++
    } else {
      Pair-Line $relPath $false "hash mismatch ($leftHash vs $rightHash)"
      $drift++
    }
  }
}

# Orphan check: any file under publish/system/<root>/ that has no source
# counterpart under <root>/. These usually indicate a deleted-but-not-cleaned
# source file (caller forgot to delete the mirror), or a stale hand-copied
# artifact. Flag them but DON'T auto-delete — that's a manual decision.
foreach ($root in $roots) {
  $mirrorRootAbs = Join-Path $projectRoot (Join-Path 'publish/system' $root)
  if (-not (Test-Path -LiteralPath $mirrorRootAbs)) { continue }

  $files = Get-ChildItem -Path $mirrorRootAbs -Recurse -File -Include $extensions -ErrorAction SilentlyContinue
  foreach ($f in $files) {
    $relPath = $f.FullName.Substring($projectRoot.Length).TrimStart('\', '/').Replace('\', '/')
    # Strip the "publish/system/" prefix to get the equivalent source-relative path.
    $srcRelativeFromMirror = $relPath -replace '^publish/system/', ''
    if (-not $sourceRelSet.ContainsKey($srcRelativeFromMirror)) {
      Pair-Line $relPath $false 'orphan (no source counterpart)'
      $orphan++
    }
  }
}

Write-Host ''
Write-Host ("summary: {0} pass, {1} drift, {2} missing, {3} orphan" -f $pass, $drift, $missing, $orphan)
if ($fail) {
  Write-Host 'MIRROR VERIFY FAILED' -ForegroundColor Red
  exit 1
} else {
  Write-Host 'MIRROR VERIFY PASSED' -ForegroundColor Green
  exit 0
}
