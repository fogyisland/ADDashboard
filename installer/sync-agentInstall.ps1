# sync-agentInstall.ps1 — rebuild publish/installer/agentInstall/ from
# current source (scripts/, scripts/common/, agent/, README-green-install.md,
# publish/system/node/).
#
# This replaces the destructive build-green-package.ps1 (which staged +
# wiped + moved to publish/installer/agentInstall/) with an in-place,
# idempotent sync. Same inputs, same outputs, no zip — operator zip
# workflow runs separately via build-agentInstall-zip.ps1 (R90.x).
#
# Why in-place (not staging + move):
#   - The previous design treated agentInstall/ as a build artifact.
#     But the green package IS the agent install path on the target
#     machine — operators `git pull` then rsync to /green/. An in-place
#     sync keeps the working tree matching what shipped last build, and
#     lets git track individual file changes between releases instead
#     of "Replace tree" diffs that obscure what actually changed.
#   - Idempotent: running when source and destination match is a no-op.
#     Operator can run this after every sync source commit and only the
#     changed files land in the publish mirror.
#   - Robocopy /MIR makes destination exactly match source: extra files
#     in destination that no longer exist in source get deleted (e.g.
#     a retired scripts/install-*.ps1). This is the same contract as
#     sync-source-mirror.ps1 and sync-scripts-mirror.ps1.
#
# Why this lives under installer/ (not scripts/):
#   - The companion build-msi.ps1 + build-msi.cmd live in installer/.
#   - The MSI source tree is installer/agent-installer/. Green package
#     and MSI are two install paths for the same agent — they share a
#     parent dir for discoverability.
#   - scripts/ is reserved for sync + install + ops tooling that runs
#     against the green-bundle scripts themselves (e.g.
#     scripts/install-agent.ps1 is a runtime artifact that ALSO ships
#     inside the green bundle — recursive).
#
# Excludes:
#   - agent/tests/      (node:test unit tests, never ship)
#   - agent/appsettings.json (per-host runtime config, dev-Box specific)
#   - agent/package-lock.json (target's `npm install --omit=dev` resolves
#                              from package.json — never ship lockfile)
#   - agent/queue.db*   (runtime SQLite WAL from local agent runs)
#   - scripts/common/tests/ (Pester tests live under tests/, never ship)
#   - scripts/*.Tests.ps1 (belt-and-suspenders)
#
# Idempotent + non-wiping at the publish/installer/agentInstall/ root
# (robocopy /MIR only deletes files that pre-existed in source-side trees
# listed below; nothing outside the 4 synced subtrees is touched).
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$greenDst = Join-Path $root 'publish\installer\agentInstall'

if (-not (Test-Path $greenDst)) {
  New-Item -ItemType Directory -Path $greenDst -Force | Out-Null
}

# 1. Mirror agent/ -> publish/installer/agentInstall/agent/.
#    Exclude tests/ + per-host files (appsettings.json, queue.db*,
#    package-lock.json). node_modules is gitignored — install-agent.ps1
#    runs `npm install --omit=dev` on the target machine to construct
#    node_modules fresh (operator directive 2026-09-24: "我们需要在
#    start.ps1 中构建node_modules"). This keeps the bundle small and
#    avoids shipping ~50-80 MB of ABI-platform-specific binaries.
$agentSrc = Join-Path $root 'agent'
$agentDst = Join-Path $greenDst 'agent'
if (-not (Test-Path $agentSrc)) { throw "source missing: $agentSrc" }
if (-not (Test-Path $agentDst)) { New-Item -ItemType Directory -Path $agentDst -Force | Out-Null }
$agentArgs = @(
  $agentSrc, $agentDst,
  '/MIR', '/NJH', '/NJS', '/NDL', '/NFL', '/NP', '/R:1', '/W:1',
  '/XD', 'tests',
  '/XF', 'appsettings.json', 'package-lock.json', 'queue.db*'
)
$rc = & robocopy @agentArgs 2>&1
if ($LASTEXITCODE -ge 8) { throw "robocopy agent source failed: $LASTEXITCODE" }
$LASTEXITCODE = 0

# 2. Stage bundled Node.js 20 LTS x64 portable into agentInstall/node/.
#    install-agent.ps1 invokes `& <green>/node/npm.cmd install --omit=dev`
#    on the target machine; npm.cmd internally runs `node
#    node_modules/npm/bin/npm-cli.js` — that file ships with the official
#    Node 20 portable zip, so the bundled node MUST be the full extract,
#    not a stripped binaries-only copy. Sanity-checked below.
#
#    Source = <ProjectRoot>/publish/system/node/ (gitignored cache,
#    canonical location per Ensure-Node.ps1:R34). Ensure-Node downloads
#    + extracts Node 20.20.2 there on first run; this step robocopies
#    the entire tree into agentInstall/node/. If publish/system/node/
#    doesn't exist yet, Ensure-Node.ps1 first to bootstrap the download
#    (same auto-bootstrap pattern install-center.ps1 uses for NSSM).
$projectRoot = $root.Path
$nodeSrc = Join-Path (Join-Path (Join-Path $projectRoot 'publish') 'system') 'node'
$nodeDst = Join-Path $greenDst 'node'
if (-not (Test-Path (Join-Path $nodeSrc 'node.exe'))) {
  Write-Host "[sync-agentInstall] publish/system/node/ missing — bootstrapping via Ensure-Node.ps1"
  & (Join-Path (Join-Path (Join-Path $projectRoot 'scripts') 'common') 'Ensure-Node.ps1') -ProjectRoot $projectRoot
}
if (-not (Test-Path $nodeDst)) { New-Item -ItemType Directory -Path $nodeDst -Force | Out-Null }
$nodeArgs = @(
  $nodeSrc, $nodeDst,
  '/MIR', '/NJH', '/NJS', '/NDL', '/NFL', '/NP', '/R:1', '/W:1'
)
$rc = & robocopy @nodeArgs 2>&1
if ($LASTEXITCODE -ge 8) { throw "robocopy node failed: $LASTEXITCODE" }
$LASTEXITCODE = 0
foreach ($must in @('node.exe', 'npm.cmd', 'node_modules\npm\bin\npm-cli.js', 'node_modules\npm\bin\npm-prefix.js')) {
  if (-not (Test-Path -LiteralPath (Join-Path $nodeDst $must))) {
    throw "node staging incomplete: missing $must in $nodeDst. Re-run sync-agentInstall.ps1 after Ensure-Node.ps1 has populated publish/system/node/."
  }
}

# 3. Mirror scripts/{install,uninstall,Register,start}-*.ps1 ->
#    publish/installer/agentInstall/<same-filename>.ps1
#    These are operator entry points; they live at agentInstall/ root
#    so `& C:\green\agentInstall\start.ps1` reads as "the installer is
#    the package" rather than buried under scripts/. Same convention
#    as npm/pip/MSI: entry is the leaf artifact.
$scriptsSrc = Join-Path $root 'scripts'
$entryScripts = @('install-agent.ps1','uninstall-agent.ps1','Register-ADDashboardAgent.ps1','start.ps1')
foreach ($f in $entryScripts) {
  $src = Join-Path $scriptsSrc $f
  if (-not (Test-Path $src)) { throw "scripts\$f missing in source tree" }
  Copy-Item -LiteralPath $src -Destination (Join-Path $greenDst $f) -Force
}

# 4. Mirror scripts/common/ -> publish/installer/agentInstall/common/.
#    Used by install-agent.ps1 (Logger.psm1, NSSM.psm1, Service.psm1,
#    Ensure-Nssm.ps1, Ensure-Node.ps1). /XD tests drops Pester tests;
#    /XF *.Tests.ps1 is belt-and-suspenders.
$commonSrc = Join-Path $scriptsSrc 'common'
$commonDst = Join-Path $greenDst 'common'
if (-not (Test-Path $commonSrc)) { throw "scripts\common\ missing: $commonSrc" }
$commonArgs = @(
  $commonSrc, $commonDst,
  '/MIR', '/NJH', '/NJS', '/NDL', '/NFL', '/NP', '/R:1', '/W:1',
  '/XD', 'tests',
  '/XF', '*.Tests.ps1'
)
$rc = & robocopy @commonArgs 2>&1
if ($LASTEXITCODE -ge 8) { throw "robocopy scripts/common failed: $LASTEXITCODE" }
$LASTEXITCODE = 0

# 5. Mirror installer/README-green-install.md ->
#    publish/installer/agentInstall/README-green-install.md
#    The README travels INSIDE the green folder so operators can read
#    it on the target machine without a separate docs download.
$readmeSrc = Join-Path $PSScriptRoot 'README-green-install.md'
$readmeDst = Join-Path $greenDst 'README-green-install.md'
Copy-Item -LiteralPath $readmeSrc -Destination $readmeDst -Force

# 6. Stage nssm.exe at <green>/nssm/nssm.exe.
#
#    Register-ADDashboardAgent.ps1:R82-89's candidate list looks for nssm
#    at $PSScriptRoot\nssm\nssm.exe second (green-package layout) — but
#    R90 sync-agentInstall.ps1 did NOT actually stage nssm there, leaving
#    the green package without an NSSM path on the target. The "we'll find
#    it in publish/system/" reasoning only held for dev-tree installs;
#    operator machines don't have that path. R91.1 ships it explicitly.
#
#    Source = <ProjectRoot>/publish/system/nssm/nssm.exe (canonical repo
#    location, downloaded by scripts/common/Ensure-Nssm.ps1). Ensure-Nssm
#    auto-runs if publish/system/nssm/nssm.exe is missing — same "ensure
#    before sync" pattern as the node step.
#
#    Why ship here instead of relying on system PATH: target machines are
#    domain controllers / member servers with locked-down software
#    policies; a portable NSSM inside the bundle is the only reliable
#    install path. Matches MSI behavior — MSI also stages nssm alongside
#    the agent at <InstallDir>\nssm\ (ConfigureAgentAction.cs:247,268,295).
$projectRootForNssm = $root.Path
$nssmSrc = Join-Path (Join-Path (Join-Path $projectRootForNssm 'publish') 'system') 'nssm\nssm.exe'
$nssmDstDir = Join-Path $greenDst 'nssm'
$nssmDst = Join-Path $nssmDstDir 'nssm.exe'
if (-not (Test-Path -LiteralPath $nssmSrc)) {
  Write-Host "[sync-agentInstall] publish/system/nssm/nssm.exe missing — bootstrapping via Ensure-Nssm.ps1"
  & (Join-Path (Join-Path (Join-Path $projectRootForNssm 'scripts') 'common') 'Ensure-Nssm.ps1') -ProjectRoot $projectRootForNssm
}
if (-not (Test-Path $nssmSrc)) { throw "publish/system/nssm/nssm.exe still missing after Ensure-Nssm bootstrap: $nssmSrc" }
if (-not (Test-Path $nssmDstDir)) { New-Item -ItemType Directory -Path $nssmDstDir -Force | Out-Null }
Copy-Item -LiteralPath $nssmSrc -Destination $nssmDst -Force

# Sanity: assert no test files snuck into the mirror outside tests/.
$stray = Get-ChildItem -LiteralPath $greenDst -Recurse -File -Filter '*.Tests.ps1' -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notmatch '[\\/]tests[\\/]' }
if ($stray) {
  throw "test files leaked into agentInstall mirror outside tests/: $($stray.Name -join ', ')"
}

Write-Host "[sync-agentInstall] $greenDst (agent + 4 ps1 + common/ + node/ + nssm/ + README, in-place)"