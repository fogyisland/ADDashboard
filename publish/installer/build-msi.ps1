[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$staging = Join-Path $root 'publish\installer\staging'
if (-not (Test-Path $staging)) { New-Item -ItemType Directory -Force -Path $staging | Out-Null }

# 1. Stage agent source (exclude tests + appsettings.json + node_modules).
#    Use robocopy for reliable recursive copy with directory-name exclusion: PS 5.1's
#    Copy-Item -Exclude doesn't apply to nested directories under -Recurse.
#    robocopy exit codes 8+ indicate real failures; 0-7 are success/info.
#    Note: agent/package.json is staged (needed at runtime for ESM detection).
#    agent/package-lock.json is NOT staged — we use the root monorepo lockfile
#    below (Task 3 review: per-workspace lockfiles drift from the root and
#    ship versions the test suite never runs against).
$agentSrc = Join-Path $root 'agent'
$agentDst = Join-Path $staging 'agent'
if (Test-Path $agentDst) { Remove-Item $agentDst -Recurse -Force }
robocopy "$agentSrc" "$agentDst" /MIR /XD "node_modules" "tests" /XF "appsettings.json" "package-lock.json" | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy agent source failed: $LASTEXITCODE" }
# robocopy returns 0-7 on success; 1 = "files copied". Reset $LASTEXITCODE so
# downstream checks (npm install, Invoke-WebRequest) aren't poisoned by it.
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
  "discoveryIntervalHours": 4,
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

# 4. Stage node_modules (npm install --omit=dev, idempotent).
#    Installs into staging/node_modules (NOT staging/agent/node_modules)
#    because the runtime layout has node_modules as a sibling of node/ and
#    src/ under INSTALLDIR; Task 4's CA sets the working dir accordingly.
#    Prepend the staged Node 20 to PATH so prebuild-install fetches the
#    matching native binary (NODE_MODULE_VERSION 115); without this, a
#    build host running a newer Node (e.g. 25.x) would download a binary
#    that the staged Node 20 cannot load.
$nodeModulesDst = Join-Path $staging 'node_modules'
if (-not (Test-Path $nodeModulesDst)) {
  $origPath = $env:PATH
  $env:PATH = "$nodeDir;$env:PATH"
  Push-Location $staging
  try {
    # Drive npm with the ROOT monorepo lockfile so resolution matches what
    # `npm install` at the repo root produces for the agent workspace
    # (axios 1.18.1, better-sqlite3 11.10.0, pino 9.14.0). The lockfile is
    # a super-set of the agent's needs; npm ci installs only the deps
    # declared in the staging package.json (the agent's deps). Using the
    # root lockfile eliminates the drift found by Task 3 review: a per-
    # workspace agent lockfile (now removed) was resolving axios 1.19.0
    # because it was generated in a temp dir outside the workspace.
    $rootLockSrc = Join-Path $root 'package-lock.json'
    $pkgDst = Join-Path $staging 'package.json'
    $lockDst = Join-Path $staging 'package-lock.json'
    # The staging cwd's "package.json" must declare only the agent's deps so
    # npm ci installs the correct subset (no center/frontend bloat). The
    # root's package.json includes all three workspaces; use the agent's.
    if (-not (Test-Path $pkgDst)) {
      Copy-Item -Path (Join-Path $root 'agent\package.json') -Destination $pkgDst -Force
    }
    if (-not (Test-Path $lockDst)) {
      Copy-Item -Path $rootLockSrc -Destination $lockDst -Force
    }
    npm ci --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed: $LASTEXITCODE" }
    # Cleanup staging-root package.json + lockfile; node_modules remains
    Remove-Item $pkgDst -Force -ErrorAction SilentlyContinue
    Remove-Item $lockDst -Force -ErrorAction SilentlyContinue
  } finally {
    Pop-Location
    $env:PATH = $origPath
  }
}

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

Push-Location (Join-Path $root 'publish\installer\agent-installer')
try {
  dotnet build -c Release -p:Platform=x64
  if ($LASTEXITCODE -ne 0) { throw "dotnet build failed: $LASTEXITCODE" }
} finally { Pop-Location }
