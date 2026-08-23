# sync-scripts-mirror.ps1 — mirror the production script set into
# publish/system/scripts/ using robocopy /MIR.
#
# Why: production runs from publish/system/scripts/ (the git-tracked mirror),
# not from the dev-box scripts/. Without a sync script, drift creeps in when
# someone updates a PS1 and forgets the manual mirror copy. The 2026-08-23
# Register-ADDashboardAgent split proved manual `cp` (bash or otherwise) was
# error-prone: bash brings platform-specific escape pitfalls, and there's no
# test-file filter.
#
# Mirrors a curated allow-list of scripts/*.ps1 + scripts/*.js + scripts/*.md
# into publish/system/scripts/, using robocopy /MIR for the actual copy:
#   - robocopy handles directories PS 5.1's Copy-Item -Recurse can't
#     (excludes nested dirs reliably, no -Exclude scoping bugs)
#   - /MIR makes destination exactly match source: extra files in destination
#     that no longer exist in source get deleted (e.g., a removed install-agent.ps1)
#
# ALLOW-LIST (not "all *.ps1"): the source scripts/ has dev-only helpers
# (kill-server.ps1, smoke-test.ps1, verify-mirror.ps1, verify-sandbox.ps1,
# build-publish-zip.ps1, sync-dist.ps1) that are never used on a production
# Windows server — they're dev-box tools. Mirror-curation matters: the mirror
# is what an operator unpacks to C:\addashboard, and dev tooling shipped to
# a production server is dead weight + a fingerprint leak. Adding a new
# production script requires updating $productionScripts below.
#
# Excludes:
#   - *.Tests.ps1        (Pester tests live in scripts/tests/ — never ship)
#   - tests/ directory   (belt-and-suspenders — PS 5.1's Copy-Item -Exclude
#                         doesn't apply to nested dirs under -Recurse, so
#                         robocopy /XD is the only reliable path)
#
# Idempotent: running when source and destination already match is a no-op
# (~0.1s). Same exit-code contract as sync-dist.ps1 (0-3 success, 8+ error).
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$src = Join-Path $projectRoot 'scripts'
$dst = Join-Path $projectRoot 'publish/system/scripts'

if (-not (Test-Path $src)) {
  throw "source scripts/ missing: $src"
}
if (-not (Test-Path $dst)) {
  New-Item -ItemType Directory -Path $dst -Force | Out-Null
}

# Production scripts that ship to C:\addashboard. Mirror what runtime needs;
# do NOT mirror dev-box helpers (kill-server / smoke-test / verify-* / etc.).
# When adding a new production script, append it here.
$productionScripts = @(
  'install-agent.ps1'
  'uninstall-agent.ps1'
  'Register-ADDashboardAgent.ps1'
  'install-center.ps1'
  'uninstall-center.ps1'
  'update-center.ps1'
  'upgrade-center.ps1'
  'upgrade-agent.ps1'
)

# Other files at scripts/ root that ship alongside the .ps1s (used by
# install-center/upgrade-center at runtime, or operator-facing docs).
$productionOther = @(
  'start-prod.js'   # NSSM spawn target for ADDashboardCenter service
  'start.bat'       # operator-facing wrapper around upgrade-agent.ps1 (no PowerShell execution-policy friction)
  'README.md'       # scripts/ overview
)

# Verify each allow-listed script actually exists in source. Fail loudly if
# someone removed a file from source without removing it from this list — a
# silent drift here means the mirror diverges from source on next sync.
foreach ($s in $productionScripts + $productionOther) {
  if (-not (Test-Path -LiteralPath (Join-Path $src $s))) {
    throw "listed script '$s' missing from source $src — remove from sync-scripts-mirror.ps1 if it was retired."
  }
}

# Wipe destination scripts/ root (preserving common/) and rebuild from allow-list.
# robocopy /MIR on a single file at a time would re-scan every iteration;
# Copy-Item -Force is cleaner for an explicit list, and our list is small.
foreach ($existing in Get-ChildItem -LiteralPath $dst -File -ErrorAction SilentlyContinue) {
  Remove-Item -LiteralPath $existing.FullName -Force
}
foreach ($s in $productionScripts + $productionOther) {
  Copy-Item -LiteralPath (Join-Path $src $s) -Destination (Join-Path $dst $s) -Force
}

# Mirror common/ separately — robocopy /MIR handles nested layout cleanly,
# with the same test-file exclusion as build-green-package.ps1:42-46.
$commonSrc = Join-Path $src 'common'
$commonDst = Join-Path $dst 'common'
if (-not (Test-Path $commonSrc)) {
  throw "scripts/common/ missing: $commonSrc"
}
if (Test-Path $commonDst) { Remove-Item $commonDst -Recurse -Force }
$commonArgs = @(
  $commonSrc,
  $commonDst,
  '/MIR',
  '/XD', 'tests',
  '/XF', '*.Tests.ps1',
  '/NFL', '/NDL', '/NJH', '/NJS', '/NP',
  '/R:0', '/W:0'
)
$rc = & robocopy @commonArgs
if ($rc -ge 8) {
  throw "robocopy scripts/common/ -> publish/system/scripts/common/ failed: $rc"
}
$LASTEXITCODE = 0

# Sanity: assert no test files snuck into the mirror. If this ever trips,
# the source convention (tests/ as a sibling directory) was broken.
$testFiles = Get-ChildItem -LiteralPath $dst -Recurse -File -Filter '*.Tests.ps1' -ErrorAction SilentlyContinue
if ($testFiles) {
  throw "test files leaked into mirror: $($testFiles.Name -join ', ')"
}

Write-Host "[sync-scripts] $src -> $dst ($($productionScripts.Count) ps1 + $($productionOther.Count) other + common/)"