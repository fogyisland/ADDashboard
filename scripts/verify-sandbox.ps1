# verify-sandbox.ps1 — cross-language drift check
#
# Confirms the .NET DDL sandbox (PackageDesigner.Sandbox.SandboxService) and
# the Node.js DDL sandbox (center/src/packages/ddl-sandbox.js) agree on the
# shared fixture Tests/fixtures/sandbox-cases.json.
#
# Both engines are exercised against the SAME fixture, so agreement is
# transitive: if both pass the fixture, they pass each other.
#
# Requires:
#   * Node.js (any modern LTS) on PATH — for scripts/run-sandbox-cases.js
#   * .NET 8 SDK on PATH — for dotnet test
#
# Usage:
#   pwsh ./scripts/verify-sandbox.ps1
#   powershell -File scripts/verify-sandbox.ps1
#
# Output:
#   On success: prints OK — .NET sandbox matches Node.js output
#               exits 0
#   On failure: prints a FAIL summary with the failing step
#               exits 1
#
# PowerShell 5.1 AND pwsh 7+ compatible — no pwsh-only syntax.

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

# Distinct exit codes retained from the brief so external CI can tell
# which leg failed: 2 = Node runner failed, 3 = .NET test failed.
$ExitNode = 2
$ExitDotnet = 3

$RepoRoot = (Get-Location).Path
$NodeScript = Join-Path $RepoRoot 'scripts/run-sandbox-cases.js'
$Fixture    = Join-Path $RepoRoot 'Tests/fixtures/sandbox-cases.json'
$TestProj   = Join-Path $RepoRoot 'PackageDesigner.Tests.csproj'

Write-Host '== WPF sandbox cross-language drift check ==' -ForegroundColor Cyan
Write-Host "Repo root: $RepoRoot"

# ---- Step 1: Node.js runner ----------------------------------------------
if (-not (Test-Path $NodeScript)) {
    Write-Host "FAIL — missing runner: $NodeScript" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $Fixture)) {
    Write-Host "FAIL — missing fixture: $Fixture" -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host '== Running sandbox-cases against Node.js (scripts/run-sandbox-cases.js) ==' -ForegroundColor Cyan
Write-Host "Fixture: $Fixture"
$nodeOutput = & node $NodeScript $Fixture
$nodeExit = $LASTEXITCODE
$nodeOutput | ForEach-Object { Write-Host $_ }
if ($nodeExit -ne 0) {
    Write-Host "FAIL — Node.js sandbox runner exited $nodeExit" -ForegroundColor Red
    exit $ExitNode
}

# ---- Step 2: .NET test runner --------------------------------------------
if (-not (Test-Path $TestProj)) {
    Write-Host "FAIL — missing test project: $TestProj" -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host '== Running sandbox-cases against .NET (SandboxGoldenTests) ==' -ForegroundColor Cyan
# No --no-build: a fresh checkout may never have compiled the test project,
# and --no-build fails hard in that case. dotnet test will rebuild on
# demand. The --filter selects only SandboxGoldenTests so we are not
# running the entire WPF test surface from this script — that is what
# `dotnet test PackageDesigner.Tests.csproj` is for in the brief.
$netOutput = & dotnet test $TestProj --filter 'FullyQualifiedName~SandboxGoldenTests' 2>&1
$netExit = $LASTEXITCODE
$netOutput | ForEach-Object { Write-Host $_ }
if ($netExit -ne 0) {
    Write-Host "FAIL — .NET SandboxGoldenTests exited $netExit" -ForegroundColor Red
    exit $ExitDotnet
}

# ---- Step 3: verdict -----------------------------------------------------
Write-Host ''
Write-Host '== Both engines agreed with the shared fixture ==' -ForegroundColor Cyan
Write-Host 'OK - .NET sandbox matches Node.js output for all fixtures.' -ForegroundColor Green
exit 0
