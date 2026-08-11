[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$agentDir = Join-Path $root 'installer\agent-installer'
Push-Location $agentDir
try {
    & dotnet build -c Release -p:Platform=x64
    if ($LASTEXITCODE -ne 0) {
        throw "dotnet build failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}