# Downloads Node.js 20 LTS portable (Windows x64) if not already staged locally.
# Idempotent: re-running is a no-op when an existing node.exe is found.
# Requires PowerShell 5.1+ (Invoke-WebRequest + Expand-Archive are 5.0+).
#
# Why this exists:
#   The green package is supposed to be self-contained (no Node pre-requisite
#   on the target machine). Pre-2026-08-23 the install scripts assumed Node was
#   on PATH — operators on air-gapped targets had no way to install Node
#   separately without violating the no-network policy. Now we bundle Node
#   20 LTS portable inside the green package; this script is the build-time
#   bootstrap that downloads + extracts Node into publish/system/node/ so
#   build-green-package.ps1 can stage it into agentInstall/node/.
#
#   Pinning Node 20 LTS (not 22/24): agent code is ESM-only and uses
#   better-sqlite3 11.x native bindings, which target the Node 20 ABI. Moving
#   off 20 requires rebuilding every native dep + re-running the WPF smoke
#   tests; defer until 20 EOL (2026-04-30 → already passed; staying on 20
#   for stability is the conservative call).
#
# Self-contained target path (single source of truth for "where is Node?"):
#   <ProjectRoot>/publish/system/node/node.exe
# This matches NSSM.psm1's pattern and keeps the layout uniform with nssm.
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ProjectRoot
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'Logger.psm1') -Force

# Single source of truth for "where is the bundled node?": everything that
# needs Node (install-agent.ps1, Register-ADDashboardAgent.ps1, build-green-
# package.ps1) probes <ProjectRoot>/publish/system/node/node.exe first.
$nodeDir = Join-Path (Join-Path (Join-Path $ProjectRoot 'publish') 'system') 'node'
$nodeExe = Join-Path $nodeDir 'node.exe'
if (Test-Path $nodeExe) {
  Write-Info "node already at $nodeExe"
  return $nodeExe
}

if (-not (Test-Path $nodeDir)) {
  New-Item -ItemType Directory -Path $nodeDir -Force | Out-Null
}

# Pin to a specific Node 20 LTS patch — latest -v20.x — so the green package
# is reproducible regardless of when the build runs. Bump explicitly when
# the agent's native deps (better-sqlite3) are rebuilt for a newer Node 20.
$nodeVersion = '20.20.2'
$url         = "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip"
$zipPath     = Join-Path $env:TEMP "node-v$nodeVersion.zip"
$extract     = Join-Path $env:TEMP "node-extract-$nodeVersion"

if (Test-Path $extract) { Remove-Item -Path $extract -Recurse -Force }

Write-Step "downloading Node.js $nodeVersion LTS x64 from $url"
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
  Expand-Archive -Path $zipPath -DestinationPath $extract -Force
  # The zip extracts to <extract>\node-v<ver>-win-x64\ with node.exe at the
  # top. Move the contents (not the folder) so the staged layout matches the
  # official portable Node layout — npm.cmd / npx.cmd / node_modules/ all
  # land at <publish/system/node/> alongside node.exe.
  $srcRoot = Join-Path $extract "node-v$nodeVersion-win-x64"
  Get-ChildItem -Path $srcRoot -Force | ForEach-Object {
    Copy-Item -Path $_.FullName -Destination $nodeDir -Recurse -Force
  }
  Write-Info "node installed at $nodeExe"
  return $nodeExe
}
finally {
  if (Test-Path $zipPath) { Remove-Item -Path $zipPath -Force -ErrorAction SilentlyContinue }
  if (Test-Path $extract) { Remove-Item -Path $extract -Recurse -Force -ErrorAction SilentlyContinue }
}
