# sync-dist.ps1 — sync fresh build output to the git-tracked publish mirror.
#
# 2026-08-23: pulled out of build-publish-zip.ps1 so the build→sync→zip
# chain is unbreakable. Without this step, publish.zip can ship a stale
# dist (the 2026-08-22 morning 500-error was this exact class of bug:
# service kept serving an old dist because the mirror wasn't refreshed
# between `npm run build:web` and `build-publish-zip.ps1`).
#
# Idempotent: running multiple times is safe. robocopy /MIR makes the
# destination exactly match the source, deleting any files in the
# destination that no longer exist in the source (e.g., removed
# code-split chunks after a frontend refactor).
#
# Source: center/dist/ (gitignored, fresh build output of `npm run build:web`)
# Destination: publish/system/center/dist/ (git-tracked per .gitignore
#   negation `!publish/system/center/dist/`, so the build output is
#   versioned alongside the source it was built from).
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$srcDist = Join-Path $projectRoot 'center/dist'
$dstDist = Join-Path $projectRoot 'publish/system/center/dist'

if (-not (Test-Path $srcDist)) {
  throw "source dist missing: $srcDist — run 'npm run build:web' first"
}
if (-not (Test-Path $dstDist)) {
  New-Item -ItemType Directory -Path $dstDist -Force | Out-Null
}

# robocopy exit codes:
#   0 = no change (source and destination already identical)
#   1 = files copied to destination
#   2 = extra files / directories deleted from destination
#   3 = both 1 and 2 (copy + cleanup)
# All of 0-3 are success. 8+ = error.
# Flags: /MIR mirror, /NFL /NDL /NJH /NJS /NP quiet output, /R:0 /W:0 no retries.
$robocopyArgs = @(
  $srcDist,
  $dstDist,
  '/MIR',
  '/NFL', '/NDL', '/NJH', '/NJS', '/NP',
  '/R:0', '/W:0'
)
$rc = & robocopy @robocopyArgs
if ($rc -ge 8) {
  throw "robocopy failed with exit code $rc syncing $srcDist -> $dstDist"
}

# Count files synced for the operator log
$fileCount = (Get-ChildItem -Path $dstDist -Recurse -File | Measure-Object).Count
Write-Host "[sync-dist] $srcDist -> $dstDist ($fileCount files, robocopy exit $rc)"
