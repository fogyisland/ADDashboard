# Build publish.zip from publish/ directory. Write to $env:TEMP first to avoid
# antivirus scan interference, then move into publish/.
$ErrorActionPreference = 'Stop'
$publish = (Resolve-Path (Join-Path $PSScriptRoot '..\publish')).Path
$zipPath = Join-Path $publish 'publish.zip'
$tmpZip = Join-Path $env:TEMP ("publish-{0}.zip" -f [Guid]::NewGuid().ToString('N').Substring(0, 8))

if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
if (Test-Path $tmpZip) { Remove-Item $tmpZip -Force }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$archive = [System.IO.Compression.ZipFile]::Open($tmpZip, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    # Exclude gitignored dev/build outputs (matches .gitignore patterns).
    # These sit on disk after running `dotnet publish` (WPF designer) or
    # `installer/build-msi.ps1` (MSI staging with embedded node + node_modules)
    # but are NEVER shipped to users — they would bloat publish.zip from
    # ~1.3 MB to 125+ MB. Pattern matches .gitignore conventions:
    #   publish/designer/      (WPF self-contained)
    #   publish/installer/staging/  (MSI build dir with embedded node)
    $excludeDirs = @(
        (Join-Path $publish 'designer'),
        (Join-Path $publish (Join-Path 'installer' 'staging'))
    )
    $files = Get-ChildItem -Path $publish -Recurse -File | Where-Object {
        $abs = $_.FullName
        -not ($excludeDirs | Where-Object { $abs.StartsWith($_, [System.StringComparison]::OrdinalIgnoreCase) })
    }
    foreach ($f in $files) {
        $rel = $f.FullName.Substring($publish.Length).TrimStart('\', '/').Replace('\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $f.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally {
    $archive.Dispose()
}

# Move into publish/, replacing any prior zip
Move-Item -Path $tmpZip -Destination $zipPath -Force

$zi = Get-Item $zipPath
Write-Host "[build-publish] $zipPath ($('{0:N2}' -f ($zi.Length / 1MB)) MB)"