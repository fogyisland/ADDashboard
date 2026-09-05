# verify-mirror.ps1 — auto-scan source ↔ publish/ mirror parity.
#
# Convention: every non-test source file under center/, agent/, and
# db/migrations/ is mirrored byte-identical into publish/system/<same-path>
# (see project memory feedback_full_chain_cleanup.md). Test files are NOT
# mirrored — that's the runtime-only bundle convention (publish/ is what users
# run on C:\addashboard, not what we develop in). The web source under
# center/web/ is also mirrored (the frontend workspace was merged into center
# in 2026-08-22, see docs/superpowers/specs/2026-08-22-center-merge-design.md).
# The shipped web build lives at center/dist/ → publish/system/center/dist/.
#
# This script auto-discovers source files under each root and verifies each
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
# `center/web` is the merged frontend workspace; we mirror its source but
# skip `dist/` (build output, mirrored separately as center/dist → center/dist)
# and `tests/` (frontend test files, not shipped to runtime users).
$roots = @(
  'center/src',
  'center/web',
  'agent',
  'db/migrations'
)

# Single-file roots: top-level files that ship alongside the mirrored
# subtree but aren't inside any of the $roots directories. `center/server.js`
# is the center entry point and the operator's green-package installer
# copies it to the production install target; if it drifts from the source
# the shipped center will fail to boot (T13 R=1 lesson: packageRouter
# import was retired in T13 but the mirror wasn't synced, so the shipped
# server.js still imported a deleted export and `npm start` blew up).
# The loop below processes these as if they were one-element roots so they
# get the same hash check + orphan detection as $roots entries.
$rootFiles = @(
  'center/server.js'
)

# Source file extensions. Excludes README.md / package.json / *.json config /
# etc — only code we actually ship to users.
$extensions = @('*.js', '*.vue', '*.sql')

# Subdir names to skip during the mirror scan. `dist/` is build output and is
# mirrored separately (center/dist → publish/system/center/dist). `tests/` is
# for in-repo testing only and is NOT shipped to runtime users. `node_modules/`
# is dev-only and never mirrored.
$skipSubdirs = @('dist', 'tests', 'node_modules')

# Test-related filenames that must NEVER be mirrored to publish/system/. They
# live in source (so devs can run `npm test` / `npm run test:web`) but are
# runtime-bundle dead weight (see .gitignore + build-publish-zip.ps1
# $excludeFilePatterns). Patterns are matched against the file's relative
# path from project root with a word-boundary segment check, the same way
# $skipSubdirs is applied.
$skipFiles = @('vitest.config.js')

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

# Regression guards — assert the new layout (2026-08-22 center+frontend merge).
# If `publish/system/frontend/` exists it means the old layout was resurrected
# (the merge permanently moved web files into center/web/). Also assert the
# shipped web bundle is present at publish/system/center/dist/index.html.
$frontendMirror = Join-Path $projectRoot 'publish/system/frontend'
if (Test-Path -LiteralPath $frontendMirror) {
  Pair-Line 'publish/system/frontend/' $false 'must NOT exist (web is under center/web/ now)'
  $fail = $true
}
$shippedDist = Join-Path $projectRoot 'publish/system/center/dist/index.html'
if (-not (Test-Path -LiteralPath $shippedDist)) {
  Pair-Line 'publish/system/center/dist/index.html' $false 'shipped web bundle missing'
  $missing++
}

# Build a set of all source files for orphan-detection later.
$sourceRelSet = @{}

# Process a single source file: hash-check it against its mirror, add to the
# source-rel set, and tally pass/drift/missing. Reused by both the directory-
# root loop and the single-file loop ($rootFiles) so both go through identical
# skip/hash logic.
function Process-SourceFile($f) {
  $relPath = $f.FullName.Substring($projectRoot.Length).TrimStart('\', '/').Replace('\', '/')
  # Skip files under configured skip-subdirs (dist/, tests/, node_modules/).
  # These are either built (mirrored via a separate path), in-repo only, or
  # dev-only and never ship to runtime users. The check uses word-boundary
  # segments to avoid matching e.g. `dist` as part of another folder name.
  $skip = $false
  foreach ($sub in $skipSubdirs) {
    if ($relPath -match ("(?:^|/){0}/" -f [regex]::Escape($sub))) {
      $skip = $true
      break
    }
  }
  # Also skip test-related filenames (vitest.config.js, etc). Same rationale
  # as $skipSubdirs: never mirrored to publish/system/. Matching is by
  # basename, so the skip applies regardless of how deep the file lives in
  # the source tree.
  if (-not $skip) {
    $fileName = Split-Path -Path $relPath -Leaf
    if ($skipFiles -contains $fileName) {
      $skip = $true
    }
  }
  if ($skip) { return }
  $sourceRelSet[$relPath] = $true

  $mirrorRel = "publish/system/$relPath"
  $mirrorAbs = Join-Path $projectRoot $mirrorRel

  if (-not (Test-Path -LiteralPath $mirrorAbs)) {
    Pair-Line $relPath $false 'mirror missing'
    $script:missing++
    return
  }

  $leftHash = (Get-FileHash -Algorithm SHA256 -Path $f.FullName).Hash
  $rightHash = (Get-FileHash -Algorithm SHA256 -Path $mirrorAbs).Hash

  if ($leftHash -eq $rightHash) {
    Pair-Line $relPath $true ''
    $script:pass++
  } else {
    Pair-Line $relPath $false "hash mismatch ($leftHash vs $rightHash)"
    $script:drift++
  }
}

foreach ($root in $roots) {
  $srcAbs = Join-Path $projectRoot $root
  if (-not (Test-Path -LiteralPath $srcAbs)) { continue }

  $files = Get-ChildItem -Path $srcAbs -Recurse -File -Include $extensions -ErrorAction SilentlyContinue
  foreach ($f in $files) {
    Process-SourceFile $f
  }
}

# Single-file roots: process each as a one-file root so it gets the same
# hash + skip + orphan treatment as the directory roots. This is what
# caught the T13 R=1 server.js drift — without this, top-level files like
# center/server.js silently fall outside the mirror scan and a stale mirror
# ships with the next green-package install.
foreach ($rootFile in $rootFiles) {
  $srcAbs = Join-Path $projectRoot $rootFile
  if (-not (Test-Path -LiteralPath $srcAbs)) { continue }
  Process-SourceFile (Get-Item -LiteralPath $srcAbs)
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
    # Apply the same skip rules as the source scan: skip files under
    # $skipSubdirs segments and skip test-related filenames. Without this,
    # a non-mirrored vitest.config.js in the source tree would be flagged as
    # orphan because the source scan skipped it.
    $skip = $false
    foreach ($sub in $skipSubdirs) {
      if ($relPath -match ("(?:^|/){0}/" -f [regex]::Escape($sub))) {
        $skip = $true
        break
      }
    }
    if (-not $skip) {
      $fileName = Split-Path -Path $relPath -Leaf
      if ($skipFiles -contains $fileName) {
        $skip = $true
      }
    }
    if ($skip) { continue }
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
