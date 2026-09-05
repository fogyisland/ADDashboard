# Build publish.zip from publish/ directory. Write to $env:TEMP first to avoid
# antivirus scan interference, then move into publish/.
#
# Includes ALL operator-deliverable artifacts from publish/:
#   - publish/installer/ADDashboardAgent.msi   (MSI build artifact)
#   - publish/installer/agentInstall/          (green package folder)
#   - publish/installer/agentInstall.zip       (green package archive)
# Both MSI and green-package paths are first-class install options — see
# installer/README.md §"路径选择" for when to use which.
$ErrorActionPreference = 'Stop'
$publish = (Resolve-Path (Join-Path $PSScriptRoot '..\publish')).Path
$zipPath = Join-Path $publish 'publish.zip'
$tmpZip = Join-Path $env:TEMP ("publish-{0}.zip" -f [Guid]::NewGuid().ToString('N').Substring(0, 8))

# Always sync the fresh dist into the git-tracked publish mirror before
# zipping. The build→sync→zip chain is unbreakable: skipping sync means
# publish.zip can ship a stale dist (the 2026-08-22 morning 500-error
# was this exact class of bug). sync-dist.ps1 is idempotent — running it
# when source and destination already match is a no-op (~0.1s).
. (Join-Path $PSScriptRoot 'sync-dist.ps1')

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
        (Join-Path $publish (Join-Path 'installer' 'staging')),
        # build-green-package.ps1 staging dir (moved to agentInstall/ at end of
        # build; should never persist, but exclude defensively in case a build
        # was interrupted mid-copy).
        (Join-Path $publish (Join-Path 'installer' 'staging-agentInstall'))
    )
    # Test files must never reach the published bundle — operators unpack
    # publish.zip to C:\addashboard on Windows servers. Even if a stray test
    # file slips past the .gitignore + verify-mirror checks, this filter
    # strips it from the zip. Source tests live under <pkg>/tests/ at the
    # repo root; the mirror convention excludes them, this is the safety net.
    $excludeFilePatterns = @(
        '\.test\.[^.]+$',
        '\.spec\.[^.]+$',
        '[\\/]vitest\.config\.js$',
        '[\\/]smoke-test\.ps1$'
    )
    $files = Get-ChildItem -Path $publish -Recurse -File | Where-Object {
        $abs = $_.FullName
        if ($excludeDirs | Where-Object { $abs.StartsWith($_, [System.StringComparison]::OrdinalIgnoreCase) }) { return $false }
        if ($excludeFilePatterns | Where-Object { $abs -match $_ }) { return $false }
        return $true
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