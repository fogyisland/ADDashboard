[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
# build-msi.ps1 lives at <repo>/installer/, so $root is the repo root.
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$staging = Join-Path $root 'publish\installer\staging'
if (-not (Test-Path $staging)) { New-Item -ItemType Directory -Force -Path $staging | Out-Null }

# 1. Stage agent source (exclude tests + appsettings.json + node_modules +
#    package-lock.json). Use robocopy for reliable recursive copy with
#    directory-name exclusion: PS 5.1's Copy-Item -Exclude doesn't apply
#    to nested directories under -Recurse. robocopy exit codes 8+ indicate
#    real failures; 0-7 are success/info.
#    Note: agent/package.json is staged (needed at runtime for ESM detection).
#    agent/package-lock.json is NOT staged — see step 4 comment for why we no
#    longer copy a lockfile into the MSI.
#    agent/node_modules is NOT staged — see step 4 comment for why.
$agentSrc = Join-Path $root 'agent'
$agentDst = Join-Path $staging 'agent'
if (Test-Path $agentDst) { Remove-Item $agentDst -Recurse -Force }
robocopy "$agentSrc" "$agentDst" /MIR /XD "node_modules" "tests" /XF "appsettings.json" "package-lock.json" | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy agent source failed: $LASTEXITCODE" }
# robocopy returns 0-7 on success; 1 = "files copied". Reset $LASTEXITCODE so
# downstream checks (Invoke-WebRequest) aren't poisoned by it.
$LASTEXITCODE = 0

# 2. Stage appsettings.template.json
$templateDst = Join-Path $staging 'appsettings.template.json'
@'
{
  "centerUrl": "CHANGEME",
  "agentId": "AUTO_HOSTNAME",
  "agentToken": "CHANGEME",
  "logLevel": "info",
  "pollingIntervalMinutes": 15,
  "heartbeatIntervalSeconds": 5,
  "discoveryIntervalHours": 1,
  "queueDbPath": "INSTALLDIR\\queue.db",
  "psScriptPath": "INSTALLDIR\\scripts\\collect-replication.ps1",
  "psDiscoveryScriptPath": "INSTALLDIR\\scripts\\collect-discovery.ps1",
  "healthCheckIntervalMs": 600000,
  "agentType": "ad"
}
'@ | Set-Content -Path $templateDst -Encoding UTF8 -NoNewline

# 3. Stage Node.js 20 LTS x64 (download once; idempotent).
#    node-lts-version: bump here when a newer 20.x LTS is needed.
$nodeDir = Join-Path $staging 'node'
$nodeVersion = '20.18.0'
$nodeZipUrl = "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip"
$nodeZip = Join-Path $env:TEMP "node-v$nodeVersion-win-x64.zip"
if (-not (Test-Path (Join-Path $nodeDir 'node.exe'))) {
  if (-not (Test-Path $nodeZip)) {
    Write-Host "Downloading Node.js $nodeVersion from $nodeZipUrl"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    # Invoke-WebRequest in PS 5.1 does NOT update $LASTEXITCODE on success;
    # verify by file presence + non-zero size instead.
    Invoke-WebRequest -Uri $nodeZipUrl -OutFile $nodeZip -UseBasicParsing
    if (-not (Test-Path $nodeZip)) { throw "Node.js download produced no file: $nodeZip" }
    $zipSize = (Get-Item $nodeZip).Length
    if ($zipSize -lt 1MB) { throw "Node.js download suspiciously small ($zipSize bytes): $nodeZip" }
  }
  $extract = Join-Path $env:TEMP "node-extract"
  if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
  Expand-Archive -Path $nodeZip -DestinationPath $extract -Force
  # The zip extracts to node-v20.x.x-win-x64/; move contents up one level
  $inner = Get-ChildItem -Path $extract -Directory | Select-Object -First 1
  if ($null -eq $inner) { throw "Node.js zip extraction produced no directory: $nodeZip" }
  if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
  Move-Item -Path $inner.FullName -Destination $nodeDir
  Remove-Item $extract -Recurse -Force
  Remove-Item $nodeZip -Force
}

# 4. (intentionally empty — node_modules + lockfile are NOT staged here.)
#
#    Why this step is gone (2026-08-23): the MSI used to run `npm ci
#    --omit=dev` at build time to pre-populate staging/node_modules, then
#    bundle ~700+ files via Files.wxs. The deferred ConfigureAgentAction now
#    runs `npm install --omit=dev` against the staged Node 20 + the staged
#    agent/package.json on the TARGET machine, so node_modules is constructed
#    fresh after install. Rationale mirrors build-green-package.ps1:1's
#    comment — ~50 MB smaller MSI, no platform-ABI drift across hosts, and
#    one source of truth for deps (the target's npm, not a build host's
#    stale node_modules). The target machine needs npm registry access;
#    see ConfigureAgentAction.cs::RunNpmInstall for the failure modes.

# 5. Stage NSSM (copy from publish/nssm). Task 4's ConfigureAgentAction calls
#    `nssm install ADReplicationAgent` at install time, so nssm.exe must be in
#    the bundle. The installer copies it to staging\nssm\nssm.exe; the MSI
#    ships it at INSTALLDIR\nssm\nssm.exe.
$nssmSrc = Join-Path $root 'publish\system\nssm\nssm.exe'
$nssmDstDir = Join-Path $staging 'nssm'
$nssmDst = Join-Path $nssmDstDir 'nssm.exe'
if (-not (Test-Path $nssmDst)) {
  if (-not (Test-Path $nssmSrc)) {
    throw "publish/nssm/nssm.exe not found. Run scripts/common/Ensure-Nssm.ps1 to download it."
  }
  if (-not (Test-Path $nssmDstDir)) { New-Item -ItemType Directory -Path $nssmDstDir -Force | Out-Null }
  Copy-Item -Path $nssmSrc -Destination $nssmDst -Force
}

Push-Location (Join-Path $root 'installer\agent-installer')
try {
  dotnet build -c Release -p:Platform=x64
  if ($LASTEXITCODE -ne 0) { throw "dotnet build failed: $LASTEXITCODE" }
} finally { Pop-Location }

# Copy the built MSI into publish/installer/ (the only artifact the publish
# bundle ships from this tree). The csproj's OutputName includes the full
# 4-segment version (e.g. addashboard-agent-x64-1.0.0.0.msi); we copy it to
# the stable artifact path so users see a single MSI named the same way
# regardless of which version was just built. Recursive search picks up the
# zh-CN folder layout (current default) and any future flat layout.
$builtMsi = Get-ChildItem -Path (Join-Path $root 'installer\agent-installer\bin') -Filter '*.msi' -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match 'addashboard-agent-x64-' } |
            Select-Object -First 1 -ExpandProperty FullName
$publishedMsi = Join-Path $root 'publish\installer\ADDashboardAgent.msi'
if (-not $builtMsi) {
  throw "Built MSI not found under installer\agent-installer\bin. dotnet build succeeded but emitted no MSI matching 'addashboard-agent-x64-*.msi'?"
}
Copy-Item -Path $builtMsi -Destination $publishedMsi -Force
Write-Host "Copied MSI to $publishedMsi"
