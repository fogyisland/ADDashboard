#requires -RunAsAdministrator
<#
2026-09-23 R87.1 — Fix the build environment on a green-installed server.

Why this exists
- Green install (start.ps1) failed because:
    (a) `npm install` failed on better-sqlite3 native build (Node 25 too new,
        Python broken)
    (b) Once (a) fails, ALL packages fail to install (npm exits 1) — including
        pure-JS deps like express, vite, axios
    (c) So `npm run build:web` fails with "vite: not found"
- better-sqlite3 is ONLY used by agent/src/local-queue.js, not center. So on the
  center server we can skip native builds entirely.

What this script does (idempotent, safe to re-run)
  1. Locate the install root (parent dir of this script, OR explicit -Path)
  2. Wipe stale node_modules to clear out the half-failed install state
  3. Run `npm install --omit=dev --ignore-scripts` at the root — installs all
     pure-JS deps and SKIPS every postinstall (including node-gyp)
  4. Run `npm install --workspace=center --include=dev --ignore-scripts` so
     vite/vitest land
  5. Run `npm install --workspace=agent --ignore-scripts` — better-sqlite3
     remains uninstalled on the center server (we DON'T need agent on center)
  6. Run `npm run build:web` and report dist/index.html status
  7. DO NOT restart the NSSM service — operator does that with
     force-restart-center.ps1 after this script completes

Usage
  # from the install root (e.g. D:\dashboard\)
  .\scripts\fix-build-env.ps1

  # or override the install root
  .\scripts\fix-build-env.ps1 -InstallPath 'D:\dashboard'

Exit codes
  0  — build:web succeeded, center/dist/index.html present
  1  — any step failed; see [fix-build-env] log lines
#>

[CmdletBinding()]
param(
    [string]$InstallPath = ''
)

$ErrorActionPreference = 'Stop'

# ---------- 1. Locate install root -----------------------------------------
if (-not $InstallPath) {
    # Default: assume this script lives at <install-root>\scripts\fix-build-env.ps1
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $InstallPath = Split-Path -Parent $scriptDir
}
$InstallPath = (Resolve-Path -LiteralPath $InstallPath -ErrorAction Stop).Path
Write-Host "[fix-build-env] install root: $InstallPath" -ForegroundColor Cyan

if (-not (Test-Path -LiteralPath (Join-Path $InstallPath 'package.json'))) {
    Write-Host "[fix-build-env] FATAL: $InstallPath\package.json not found" -ForegroundColor Red
    Write-Host "  Pass -InstallPath to point at the install root (the dir containing package.json)" -ForegroundColor Red
    exit 1
}

# ---------- 2. Wipe stale node_modules -------------------------------------
$rootNm = Join-Path $InstallPath 'node_modules'
$centerNm = Join-Path $InstallPath 'center\node_modules'
$agentNm = Join-Path $InstallPath 'agent\node_modules'

foreach ($p in @($rootNm, $centerNm, $agentNm)) {
    if (Test-Path -LiteralPath $p) {
        Write-Host "[fix-build-env] removing stale $($p.Substring($InstallPath.Length))" -ForegroundColor Yellow
        Remove-Item -LiteralPath $p -Recurse -Force
    }
}

# ---------- 3. Pure-JS deps at root (no native build) ----------------------
Write-Host "[fix-build-env] step 1/4: npm install --omit=dev --ignore-scripts (root)" -ForegroundColor Cyan
& npm install --omit=dev --ignore-scripts --no-audit --no-fund 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) {
    Write-Host "[fix-build-env] FAIL: root npm install exited $LASTEXITCODE" -ForegroundColor Red
    exit 1
}

# ---------- 4. center workspace — vite (devDep) + runtime deps ------------
Write-Host "[fix-build-env] step 2/4: npm install --workspace=center (with dev for vite)" -ForegroundColor Cyan
Push-Location $InstallPath
try {
    & npm install --workspace=center --include=dev --ignore-scripts --no-audit --no-fund 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[fix-build-env] FAIL: center npm install exited $LASTEXITCODE" -ForegroundColor Red
        exit 1
    }
} finally { Pop-Location }

# ---------- 5. agent workspace — skip better-sqlite3 -----------------------
# agent is not needed on the center server. We install with --ignore-scripts so
# any future agent dep that needs native build will silently skip. better-sqlite3
# will NOT be installed here — if you actually need agent on this machine,
# fix Python or downgrade Node, then re-run without --ignore-scripts.
Write-Host "[fix-build-env] step 3/4: npm install --workspace=agent --ignore-scripts (skips better-sqlite3)" -ForegroundColor Cyan
Push-Location $InstallPath
try {
    & npm install --workspace=agent --ignore-scripts --no-audit --no-fund 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[fix-build-env] WARN: agent npm install exited $LASTEXITCODE (expected — better-sqlite3 skipped)" -ForegroundColor Yellow
    }
} finally { Pop-Location }

# ---------- 6. Build the web bundle ----------------------------------------
$centerDir = Join-Path $InstallPath 'center'
$distIndex = Join-Path $centerDir 'dist\index.html'

Write-Host "[fix-build-env] step 4/4: npm run build:web" -ForegroundColor Cyan
Push-Location $InstallPath
try {
    & npm run build:web 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[fix-build-env] FAIL: build:web exited $LASTEXITCODE" -ForegroundColor Red
        exit 1
    }
} finally { Pop-Location }

# ---------- 7. Verify dist output ------------------------------------------
if (Test-Path -LiteralPath $distIndex) {
    $size = (Get-Item -LiteralPath $distIndex).Length
    Write-Host "[fix-build-env] OK: $distIndex present ($size bytes)" -ForegroundColor Green
    Write-Host ""
    Write-Host "Next step: restart NSSM service manually to pick up new dist/" -ForegroundColor Green
    Write-Host "  nssm restart ADDashboardCenter   # or run force-restart-center.ps1" -ForegroundColor Gray
    exit 0
} else {
    Write-Host "[fix-build-env] FAIL: $distIndex missing after build" -ForegroundColor Red
    exit 1
}