# sync-source-mirror.ps1 — sync source files into publish/system/<same-path>.
#
# Mirrors the convention documented in verify-mirror.ps1: every non-test
# source file under center/src, center/web (skipping dist/ + tests/),
# agent, db/migrations, and the root-level center/server.js must have a
# byte-identical mirror at publish/system/<same-path>.
#
# Why this exists: previous R rounds relied on `cp -r` bash + manual
# exclude lists, which consistently drifted (the R73.1 / R75 mirror was
# stale across multiple commits and verify-mirror flagged 8+ drift items
# per push). robocopy /MIR + /XD for the excluded directories is the
# only reliable way to keep the source mirror in lockstep.
#
# Idempotent. Run after every feature commit before pushing.

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dst = Join-Path $projectRoot 'publish\system'

# Source-roots → destination-mirror-roots mapping.
# Each source is mirrored under publish/system/<src-rel-path>.
# Excluded subdirs (per-root):
#   - center/web: dist/ (build output, mirrored separately by sync-dist.ps1),
#                tests/ (frontend tests, never shipped to runtime users)
#   - agent:      tests/ (node:test unit tests, never shipped)
$roots = @(
  @{ Src = 'center\src'; Dst = 'center\src'; ExcludeDirs = @() }
  @{ Src = 'center\web'; Dst = 'center\web'; ExcludeDirs = @('dist', 'tests') }
  @{ Src = 'agent';       Dst = 'agent';       ExcludeDirs = @('tests') }
  @{ Src = 'db\migrations'; Dst = 'db\migrations'; ExcludeDirs = @() }
)

foreach ($r in $roots) {
  $src = Join-Path $projectRoot $r.Src
  $dstPath = Join-Path $dst $r.Dst
  if (-not (Test-Path $src)) { throw "source missing: $src" }
  if (-not (Test-Path $dstPath)) { New-Item -ItemType Directory -Path $dstPath -Force | Out-Null }
  $args = @($src, $dstPath, '/MIR', '/NJH', '/NJS', '/NDL', '/NFL', '/NP', '/R:1', '/W:1')
  if ($r.ExcludeDirs.Count -gt 0) {
    foreach ($xd in $r.ExcludeDirs) { $args += "/XD"; $args += $xd }
  }
  # Files we never want in the mirror (test artifacts that might sneak in
  # if a developer adds one at the root of a source dir):
  $args += '/XF'; $args += '*.test.js'; $args += '*.spec.js'
  $robocopyOutput = & robocopy @args 2>&1
  # robocopy exit codes: 0=no change, 1=files copied, 2=extra files deleted, 3=both.
  # 8+ are real errors. 0-7 are success.
  $rc = $LASTEXITCODE
  if ($rc -ge 8) {
    throw "robocopy failed (exit $rc) for $($r.Src): $robocopyOutput"
  }
}

# Single-file roots (top-level files that ship alongside the mirrored
# subtree but aren't in any directory). center/server.js is the center
# entry point — if it drifts from source, the shipped center fails to
# boot (see R73 verify-mirror incident). /MIR on a single file = copy.
$fileRoots = @('center\server.js')
foreach ($f in $fileRoots) {
  $src = Join-Path $projectRoot $f
  $dstFile = Join-Path $dst $f
  if (-not (Test-Path $src)) { throw "source missing: $src" }
  $dstDir = Split-Path -Parent $dstFile
  if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Path $dstDir -Force | Out-Null }
  Copy-Item -Path $src -Destination $dstFile -Force
}

Write-Host "[sync-source-mirror] done"