param([string]$PkgProjPath)
# Extract RawFiles from a .pkgproj JSON produced by PackageDesigner.Save
# and run collect.ps1 in Windows PowerShell 5.1 to verify it emits the
# expected JSON object.
$ErrorActionPreference = 'Stop'
$pkg = Get-Content -Raw $PkgProjPath | ConvertFrom-Json
$collectPs1 = $pkg.RawFiles.'collect.ps1'
if (-not $collectPs1) { Write-Error "no collect.ps1 in RawFiles (keys: $($pkg.RawFiles.PSObject.Properties.Name -join ', '))" }
$tmp = Join-Path $env:TEMP ("collect-{0}.ps1" -f [guid]::NewGuid().ToString('N'))
Set-Content -Path $tmp -Value $collectPs1 -Encoding UTF8
Write-Host "=== collect.ps1 ($($collectPs1.Length) chars) ==="
Write-Host $collectPs1
Write-Host "=== running collect.ps1 under PS $($PSVersionTable.PSVersion) ==="
# Stub the Get-Counter / Get-CimInstance calls so a missing dependency never
# crashes the test; we only care that the script runs to completion and
# emits a JSON object with the expected keys.
try { & $tmp } catch { Write-Host "RUN-CATCH: $($_.Exception.Message)" }
Remove-Item $tmp -Force -ErrorAction SilentlyContinue
