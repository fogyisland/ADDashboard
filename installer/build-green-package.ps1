# build-green-package.ps1 — assemble publish/installer/ADDashboardAgent-green/
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
#   publish/installer/ADDashboardAgent-green/
#     agent/              pre-installed agent runtime (lowercase to match
#                         scripts/install-agent.ps1's $AgentSrc default)
#     scripts/            install-agent.ps1 + uninstall-agent.ps1 + common/
#     nssm/nssm.exe       bundled (NSSM.psm1::Get-NssmPath searches
#                         <root>/nssm/ — see scripts/common/NSSM.psm1:30-37)
#     README-green-install.md
#
# Pre-req on the TARGET machine: Node.js 20 LTS on PATH. install-agent.ps1
# calls `Get-Command node.exe -ErrorAction Stop`. Unlike the MSI, this
# bundle does NOT embed Node.js — operators install Node separately.
# (Bundling Node would inflate the zip by ~30 MB and complicate updates.)
[CmdletBinding()]
param(
  # When set, skip rebuilding node_modules. Use this when iterating on the
  # agent source between green-package builds — pass the existing
  # publish/installer/ADDashboardAgent-green/ as the source instead.
  [switch]$SkipNpmInstall
)

$ErrorActionPreference = 'Stop'
$root       = Resolve-Path (Join-Path $PSScriptRoot '..')
$staging    = Join-Path $root 'publish\installer\staging-green'
$greenDst   = Join-Path $root 'publish\installer\ADDashboardAgent-green'
$zipPath    = Join-Path $root 'publish\installer\ADDashboardAgent-green.zip'

if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Force -Path $staging | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $staging 'scripts') | Out-Null

# 1. Stage agent source (exclude tests + appsettings.json + node_modules +
#    package-lock.json + queue.db*). Use robocopy for reliable recursive copy
#    with directory-name exclusion (PS 5.1's Copy-Item -Exclude doesn't apply
#    to nested directories under -Recurse).
#    agent/package.json IS staged — needed at runtime for ESM detection.
#    agent/package-lock.json is NOT staged; we use the root monorepo lockfile
#    below (per Task 3 review of build-msi.ps1 — per-workspace lockfiles
#    drift from the root and ship versions the test suite never ran against).
#    queue.db* are runtime SQLite WAL files from local agent runs — never ship.
$agentSrc = Join-Path $root 'agent'
$agentDst = Join-Path $staging 'agent'
robocopy "$agentSrc" "$agentDst" /MIR /XD "node_modules" "tests" /XF "appsettings.json" "package-lock.json" "queue.db*" | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy agent source failed: $LASTEXITCODE" }
$LASTEXITCODE = 0

# 2. Stage scripts/ — install + uninstall + common/ modules.
#    install-agent.ps1 imports common\Logger.psm1 / NSSM.psm1 / Service.psm1
#    and dot-sources common\Ensure-Nssm.ps1. The layout must match the dev
#    tree (scripts/ at the same depth as agent/) so $PSScriptRoot resolves
#    correctly when the operator runs it on the target machine.
#    Note: robocopy requires dir-to-dir. Single-file items (install-agent.ps1,
#    uninstall-agent.ps1) use Copy-Item; common/ (a directory) uses robocopy.
$scriptsSrc = Join-Path $root 'scripts'
$scriptsDst = Join-Path $staging 'scripts'
foreach ($file in @('install-agent.ps1','uninstall-agent.ps1')) {
  $src = Join-Path $scriptsSrc $file
  $dst = Join-Path $scriptsDst $file
  if (-not (Test-Path $src)) { throw "scripts\$file missing in source tree" }
  Copy-Item -Path $src -Destination $dst -Force
}
$commonSrc = Join-Path $scriptsSrc 'common'
$commonDst = Join-Path $scriptsDst 'common'
if (-not (Test-Path $commonSrc)) { throw "scripts\common\ missing in source tree" }
if (Test-Path $commonDst) { Remove-Item $commonDst -Recurse -Force }
# /XD tests drops scripts/common/tests/ (the *.Tests.ps1 files live there).
# /XF *.Tests.ps1 is belt-and-suspenders in case any test file lands at the
# common/ root in the future.
robocopy "$commonSrc" "$commonDst" /MIR /XD "tests" /XF "*.Tests.ps1" | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy scripts\common failed: $LASTEXITCODE" }
$LASTEXITCODE = 0

# 3. Stage nssm.exe. Get-NssmPath searches <root>/nssm/ (per NSSM.psm1:30-37),
#    so bundling at <green>/nssm/nssm.exe is the cheapest match.
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

# 4. Stage node_modules (npm install --omit=dev, idempotent unless -SkipNpmInstall).
#    install-agent.ps1's Install-LocalAgent has this exact guard at line 73-75:
#      if (-not (Test-Path node_modules)) { npm install --omit=dev }
#    So pre-installing node_modules in the bundle makes first-run install
#    skip the network step entirely on the target — operators don't need
#    npm access from the production box.
$nodeModulesDst = Join-Path $agentDst 'node_modules'
if ((-not $SkipNpmInstall) -and (-not (Test-Path $nodeModulesDst))) {
  # Use the ROOT monorepo lockfile so resolution matches what `npm install`
  # at the repo root produces for the agent workspace. Same rationale as
  # build-msi.ps1:84-117 — per-workspace lockfiles drift and ship versions
  # the test suite never ran against.
  $rootLockSrc = Join-Path $root 'package-lock.json'
  $pkgDst = Join-Path $agentDst 'package.json'
  $lockDst = Join-Path $agentDst 'package-lock.json'
  if (-not (Test-Path $pkgDst)) {
    throw "agent\package.json missing in staging — robocopy step failed silently?"
  }
  if (-not (Test-Path $lockDst)) {
    Copy-Item -Path $rootLockSrc -Destination $lockDst -Force
  }
  Push-Location $agentDst
  try {
    npm install --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install failed: $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
}

# 5. Stage operator guide. README-green-install.md is the per-bundle guide
#    that travels INSIDE the green folder so operators can read it on the
#    target machine without a separate docs download.
$readmeDst = Join-Path $staging 'README-green-install.md'
Copy-Item -Path (Join-Path $PSScriptRoot 'README-green-install.md') -Destination $readmeDst -Force

# 6. Move staging -> final destination (publish/installer/ADDashboardAgent-green/).
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
