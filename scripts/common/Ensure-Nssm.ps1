# Downloads NSSM 2.24 to <projectRoot>/nssm/nssm.exe if missing.
# Idempotent: re-running is a no-op when the binary is already in place.
# Requires PowerShell 5.1+ (Invoke-WebRequest + Expand-Archive are 5.0+).
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ProjectRoot
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'Logger.psm1') -Force

$nssmDir  = Join-Path $ProjectRoot (Join-Path 'publish' 'nssm')
$nssmExe  = Join-Path $nssmDir 'nssm.exe'

if (Test-Path $nssmExe) {
  Write-Info "nssm already at $nssmExe"
  return $nssmExe
}

if (-not (Test-Path $nssmDir)) {
  New-Item -ItemType Directory -Path $nssmDir -Force | Out-Null
}

$url      = 'https://nssm.cc/release/nssm-2.24.zip'
$zipPath  = Join-Path $env:TEMP 'nssm-2.24.zip'
$extract  = Join-Path $env:TEMP 'nssm-extract'

if (Test-Path $extract) { Remove-Item -Path $extract -Recurse -Force }

Write-Step "downloading NSSM 2.24 from $url"
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
  Expand-Archive -Path $zipPath -DestinationPath $extract -Force
  $srcExe = Join-Path (Join-Path (Join-Path $extract 'nssm-2.24') 'win64') 'nssm.exe'
  Copy-Item -Path $srcExe -Destination $nssmExe -Force
  Write-Info "nssm installed at $nssmExe"
  return $nssmExe
}
finally {
  if (Test-Path $zipPath) { Remove-Item -Path $zipPath -Force -ErrorAction SilentlyContinue }
  if (Test-Path $extract) { Remove-Item -Path $extract -Recurse -Force -ErrorAction SilentlyContinue }
}
