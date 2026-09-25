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
# ── Intentionally NOT mirrored ──
#
# publish/system/center/data/packages/<name>/<version>/ — these are the
# bundled built-in package sources read by seedBuiltinPackages (see
# center/src/services/builtin-packages.js). Unlike every other entry in
# $roots below, this tree IS the source of truth: the seeder copies
# files from publish/system/center/data/packages/ into the runtime
# data/packages/ tree on first normal-mode start. There is no
# repo-root-side origin to mirror FROM — the content has lived in
# publish/ since R12 (commit 24b1baa) and was just renamed in place by
# R82 (e253ed0). If a future change adds a true repo-root origin for
# these files (e.g. publish/system/center/data/packages/<name>/ moved
# to a new top-level location like packages/<name>/), add the new path
# here AND update .gitignore + verify-mirror's $roots + the
# builtin-packages-tracked test in lockstep. Until then, do NOT add
# publish/system/center/data/packages/ to $roots — robocopy would
# overwrite the source with itself, which is a no-op but obscures any
# future divergence.
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
#   - installer:  tests/ (C# AgentInstaller test project — full bin/obj
#                            from local dotnet builds leaks there, never
#                            ship dev-binaries alongside the MSI source)
#   - installer:  bin/, obj/ at the source root (defense-in-depth — the
#                C# project drops its build outputs there)
#
# Excluded files (per-root) — dev-box tools that build the green package
# or MSI locally. The MSI source tree (agent-installer/) is what gets
# mirrored; the *build* scripts run on the dev box to produce the .msi,
# the .msi itself isn't part of the mirror (operators download from a
# release channel, not from publish/system/installer/).
$roots = @(
  # R90 cleanup: this script ONLY mirrors the SERVER-END runtime bundle
  # under publish/system/. Agent client-side code (publish/installer/
  # agentInstall/agent/) and MSI source (publish/installer/) are NOT
  # server-side runtime — they have their own dedicated ship targets
  # and their own dedicated sync scripts (sync-agentInstall-mirror.ps1).
  # Mirroring them here was the original R12 mistake that left a stale
  # copy of agent.js + appsettings.json (dev-Box config) under
  # publish/system/agent/, and a stale copy of MSI source under
  # publish/system/installer/. The server bundle must contain only what
  # the center actually needs to boot.
  #
  # ── Intentionally NOT mirrored here ──
  #  - agent/                → publish/installer/agentInstall/agent/    (CLIENT)
  #  - installer/            → publish/installer/                       (MSI build source)
  #  - installer/agentInstall/{common,node,scripts,...}              (CLIENT install bundle)
  #
  # If you need to add a server-bundle source root, append it here AND
  # verify-mirror.ps1's $roots in lockstep — both scripts share the
  # same mirror contract and must agree on what is server-end.
  @{ Src = 'center\src';     Dst = 'center\src';     ExcludeDirs = @();         ExcludeFiles = @() }
  @{ Src = 'center\web';     Dst = 'center\web';     ExcludeDirs = @('dist', 'tests'); ExcludeFiles = @() }
  @{ Src = 'db\migrations';  Dst = 'db\migrations';  ExcludeDirs = @();         ExcludeFiles = @() }
  # R89.x: db/schema/ holds the consolidated initial schema (01-tables.sql
  # + 02-seed-roles.sql, mysql + mssql variants). The init wizard reads
  # these in fresh-install mode (no migration history). Until R84 they
  # lived in db/migrations/ + the seeder; R84 split them out so a fresh
  # install can apply the entire schema in one transaction without
  # replaying per-migration round trips.
  @{ Src = 'db\schema';      Dst = 'db\schema';      ExcludeDirs = @();         ExcludeFiles = @() }
  # Operator-facing docs (architecture / operations / runbooks / specs /
  # plans / reports / archive / wpf-fix-review). Mirror so a deployed
  # green package has self-contained documentation next to the runtime.
  @{ Src = 'docs';           Dst = 'docs';           ExcludeDirs = @();         ExcludeFiles = @() }
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
  if ($r.ExcludeFiles -and $r.ExcludeFiles.Count -gt 0) {
    foreach ($xf in $r.ExcludeFiles) { $args += $xf }
  }
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
#
# R89 also requires center/package.json — the dependency manifest
# Ensure-CenterNodeModules reads at install time. Without it in the
# mirror, deploy installs have nothing to install from and the center
# comes up with `Cannot find package 'express'` (or any other declared
# dep). In-place installs read the dev tree's center/package.json;
# deploy installs read the mirror's copy. Both need to exist for the
# two install modes to stay equivalent.
#
# center/package-lock.json is NOT mirrored: the repo doesn't ship one
# (install-center.ps1 runs `npm install --omit=dev` on the target, which
# generates a fresh lockfile there). Adding it here would either fail
# silently if the source file doesn't exist (pre-R89.1 behavior — see
# `if (-not (Test-Path $src)) throw` below) or commit a stale lockfile
# that drifts out of sync with center/package.json. Deploy installs
# must always regenerate the lockfile to match the actual installed
# versions on the target host.
$fileRoots = @(
  'center\server.js'
  'center\package.json'
)
foreach ($f in $fileRoots) {
  $src = Join-Path $projectRoot $f
  $dstFile = Join-Path $dst $f
  if (-not (Test-Path $src)) { throw "source missing: $src" }
  $dstDir = Split-Path -Parent $dstFile
  if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Path $dstDir -Force | Out-Null }
  Copy-Item -Path $src -Destination $dstFile -Force
}

Write-Host "[sync-source-mirror] done"