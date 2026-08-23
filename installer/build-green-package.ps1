# build-green-package.ps1 — assemble publish/installer/agentInstall/
# (a "green" / portable agent bundle) and its zip.
#
# Why this exists alongside build-msi.ps1:
#   - MSI is the production install path (SCCM / GPO / msiexec /qn). It bundles
#     Node.js + node_modules + nssm + CAs in a single atomic installer.
#   - Green package is the SECONDARY path for ops who can't or won't use the
#     MSI (air-gapped environments, MSI install debugging, dev / test rigs).
#     Operator copies the folder to the target and runs install-agent.ps1.
#     Same service name (ADReplicationAgent), same NSSM config — operators
#     can switch between paths freely.
#
# Layout produced:
#   publish/installer/agentInstall/
#     agent/                       pre-installed agent runtime (lowercase to
#                                  match scripts/install-agent.ps1's $AgentSrc default)
#     install-agent.ps1            LOCAL install script (file-copy + npm install +
#                                  delegates SCM-facing steps to Register-…)
#     uninstall-agent.ps1          LOCAL uninstall script (delegates to
#                                  Register-… -Action Unregister)
#     Register-ADDashboardAgent.ps1  single entry point shared by install/
#                                  uninstall + (future) MSI CAs
#     common/                      Logger.psm1 + NSSM.psm1 + Service.psm1 +
#                                  Ensure-Nssm.ps1 — modules used by install/
#                                  uninstall's file-copy + npm-install phase
#     nssm/nssm.exe                bundled (Register-… searches
#                                  <PSScriptRoot>\nssm\nssm.exe — see
#                                  scripts/Register-ADDashboardAgent.ps1:73-82)
#     README-green-install.md
#
# Pre-req on the TARGET machine: Node.js 20 LTS on PATH. install-agent.ps1
# calls `Get-Command node.exe -ErrorAction Stop`. Unlike the MSI, this
# bundle does NOT embed Node.js — operators install Node separately.
# (Bundling Node would inflate the zip by ~30 MB and complicate updates.)
#
# Why PS1 files live at agentInstall/ root (not under scripts/):
#   - Operator expectation: `& C:\green\agentInstall\install-agent.ps1` reads
#     as "the installer is the package" rather than "the installer is one
#     sub-component of the package". Same convention as `npm install`,
#     `pip install`, MSI's `msiexec /i foo.msi` — the entry point is the
#     leaf artifact, not buried under a subdir.
#   - Single-grep target: the three PS1 files form the install surface;
#     having them at root means `ls agentInstall/*.ps1` enumerates the
#     install scripts with no further navigation.
#   - common/ stays a sibling: install-agent.ps1 imports
#     `$PSScriptRoot\common\Logger.psm1` — same `$PSScriptRoot` whether the
#     script lives at <green>/ or <green>/scripts/, the import path is
#     symmetric.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root       = Resolve-Path (Join-Path $PSScriptRoot '..')
$staging    = Join-Path $root 'publish\installer\staging-agentInstall'
$greenDst   = Join-Path $root 'publish\installer\agentInstall'
$zipPath    = Join-Path $root 'publish\installer\agentInstall.zip'

if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Force -Path $staging | Out-Null

# 1. Stage agent source (exclude tests + appsettings.json + node_modules +
#    package-lock.json + queue.db*). Use robocopy for reliable recursive copy
#    with directory-name exclusion (PS 5.1's Copy-Item -Exclude doesn't apply
#    to nested directories under -Recurse).
#    agent/package.json IS staged — needed at runtime for ESM detection.
#    agent/node_modules is NOT staged — install-agent.ps1 runs
#    `npm install --omit=dev` on the target machine to construct it fresh
#    (canonical install path, see install-agent.ps1:75-87). Shipping a
#    prebuilt node_modules is redundant: ~50 MB double-source-of-truth,
#    platform-ABI drift risk across hosts, and lockfile drift from the
#    monorepo root. The green package is small + deterministic to build
#    without it; the target machine's npm is the single resolver.
#    agent/package-lock.json is NOT staged — same reason; the target
#    machine's `npm install` resolves semver ranges from package.json,
#    which is what the test suite runs against anyway.
#    queue.db* are runtime SQLite WAL files from local agent runs — never ship.
$agentSrc = Join-Path $root 'agent'
$agentDst = Join-Path $staging 'agent'
robocopy "$agentSrc" "$agentDst" /MIR /XD "node_modules" "tests" /XF "appsettings.json" "package-lock.json" "queue.db*" | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy agent source failed: $LASTEXITCODE" }
$LASTEXITCODE = 0

# 2. Stage PS1 files at agentInstall/ root + common/ as a sibling. The dev
#    tree keeps scripts/ one level below projectRoot/, but the green package
#    flattens that to <green>/{install,uninstall,Register}-*.ps1 + common/ —
#    operator expects `& C:\green\agentInstall\install-agent.ps1`, not
#    `& C:\green\agentInstall\scripts\install-agent.ps1`. install-agent.ps1
#    imports common\Logger.psm1 and dot-sources common\Ensure-Nssm.ps1 via
#    `$PSScriptRoot\common\…`, which resolves identically whether the script
#    lives at <green>/ or <green>/scripts/.
#    Register-ADDashboardAgent.ps1 is the single entry point for the
#    SCM-facing steps (appsettings.json write + NSSM install + NSSM
#    parameters + sc.exe failure recovery + Start/Stop service) —
#    install-agent.ps1 and uninstall-agent.ps1 both delegate to it. The
#    layout must keep $PSScriptRoot correct when the operator runs it on
#    the target machine; with PS1 files at <green>/ root, $PSScriptRoot
#    resolves to <green>/ and Register-…'s nssm path candidate
#    `$PSScriptRoot\nssm\nssm.exe` matches the bundled nssm at <green>/nssm/.
$scriptsSrc = Join-Path $root 'scripts'
foreach ($file in @('install-agent.ps1','uninstall-agent.ps1','Register-ADDashboardAgent.ps1','start.ps1')) {
  $src = Join-Path $scriptsSrc $file
  $dst = Join-Path $staging $file
  if (-not (Test-Path $src)) { throw "scripts\$file missing in source tree" }
  Copy-Item -Path $src -Destination $dst -Force
}
$commonSrc = Join-Path $scriptsSrc 'common'
$commonDst = Join-Path $staging 'common'
if (-not (Test-Path $commonSrc)) { throw "scripts\common\ missing in source tree" }
if (Test-Path $commonDst) { Remove-Item $commonDst -Recurse -Force }
# /XD tests drops scripts/common/tests/ (the *.Tests.ps1 files live there).
# /XF *.Tests.ps1 is belt-and-suspenders in case any test file lands at the
# common/ root in the future.
robocopy "$commonSrc" "$commonDst" /MIR /XD "tests" /XF "*.Tests.ps1" | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy scripts\common failed: $LASTEXITCODE" }
$LASTEXITCODE = 0

# 3. Stage nssm.exe at <green>/nssm/nssm.exe. Register-ADDashboardAgent.ps1's
#    candidate list (Register-…:73-82) searches `$PSScriptRoot\nssm\nssm.exe`
#    first; with the script at <green>/ root, $PSScriptRoot = <green>/ and the
#    candidate resolves to the bundled nssm.
#    Source: publish/system/nssm/nssm.exe (the canonical repo location,
#    downloaded by scripts/common/Ensure-Nssm.ps1).
$nssmSrc = Join-Path $root 'publish\system\nssm\nssm.exe'
$nssmDstDir = Join-Path $staging 'nssm'
$nssmDst = Join-Path $nssmDstDir 'nssm.exe'
if (-not (Test-Path $nssmDst)) {
  if (-not (Test-Path $nssmSrc)) {
    throw "publish\system\nssm\nssm.exe not found. Run scripts\common\Ensure-Nssm.ps1 -ProjectRoot '$root' first to download NSSM 2.24."
  }
  if (-not (Test-Path $nssmDstDir)) { New-Item -ItemType Directory -Path $nssmDstDir -Force | Out-Null }
  Copy-Item -Path $nssmSrc -Destination $nssmDst -Force
}

# 4. (intentionally empty — node_modules + lockfile are NOT staged here; the
#    target machine's `install-agent.ps1` runs `npm install --omit=dev` to
#    construct node_modules fresh. See step 1's comment for the rationale.)

# 5. Stage operator guide. README-green-install.md is the per-bundle guide
#    that travels INSIDE the green folder so operators can read it on the
#    target machine without a separate docs download.
$readmeDst = Join-Path $staging 'README-green-install.md'
Copy-Item -Path (Join-Path $PSScriptRoot 'README-green-install.md') -Destination $readmeDst -Force

# 6. Move staging -> final destination (publish/installer/agentInstall/).
#    Use Move-Item rather than leaving as staging/ so the publish bundle has
#    a stable, descriptive artifact name. Atomic on the same volume.
if (Test-Path $greenDst) { Remove-Item $greenDst -Recurse -Force }
Move-Item -Path $staging -Destination $greenDst -Force

# 7. Build the zip for download / WinRM-friendly transfer. Large (>50 MB
#    with node_modules) but operators expect a single-file artifact for
#    copying to air-gapped targets.
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
# Write to $env:TEMP first to dodge antivirus scan interference, then move
# into publish/. Same pattern as scripts/build-publish-zip.ps1:5-6.
$tmpZip = Join-Path $env:TEMP ("green-{0}.zip" -f [Guid]::NewGuid().ToString('N').Substring(0, 8))
$archive = [System.IO.Compression.ZipFile]::Open($tmpZip, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  $files = Get-ChildItem -Path $greenDst -Recurse -File
  foreach ($f in $files) {
    $rel = $f.FullName.Substring($greenDst.Length).TrimStart('\', '/').Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $f.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally {
  $archive.Dispose()
}
Move-Item -Path $tmpZip -Destination $zipPath -Force

$size = (Get-Item $zipPath).Length
Write-Host "[build-green] $greenDst"
Write-Host "[build-green] $zipPath ($('{0:N2}' -f ($size / 1MB)) MB)"
