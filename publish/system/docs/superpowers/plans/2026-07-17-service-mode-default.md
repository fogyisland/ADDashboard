# Service-Mode Default Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the green-bundle entry point (`publish/start.bat`) from a foreground console process to an idempotent Windows-service installer. The user double-clicks `start.bat`, the service installs + starts, the window exits, and the user opens their browser. Wizard finalize triggers an NSSM auto-restart so the service comes back with the new config. Crashes are handled by Windows Service Recovery. `start.bat --console` preserves the legacy foreground mode for development.

**Architecture:** `start.bat` becomes a thin shell wrapper that detects admin context and either calls `install-center.ps1 -InPlace` (registers NSSM service pointing at `publish/center/` in-place, no file copy) or runs `node center\server.js` directly in `--console` mode. `install-center.ps1` gains an `-InPlace` switch plus NSSM `AppExit=Restart` and `sc.exe failure` recovery settings. The wizard's `/finalize` handler calls `process.exit(0)` so NSSM picks it up and restarts the service. The frontend polls `/api/init/status` until `needsInit=false`, then redirects to `/login`.

**Tech Stack:** Windows services via NSSM 2.24 (bundled at `publish/nssm/nssm.exe` + `nssm/nssm.exe`); PowerShell 5.1 + pwsh 7+; Express + Vue 3 (no framework change); Node 18+.

## Global Constraints

- **PowerShell 5.1 + pwsh 7+ dual compat** — no 3-arg `Join-Path`, no `??=`, no pwsh-only operators. (Per project memory `feedback_powershell_51.md`.)
- **`start.bat` is the single user-facing entry** — every new behavior must be reachable through `start.bat` or its `--console` flag. No parallel entry scripts.
- **NSSM is at `publish/nssm/nssm.exe`** (green bundle) and `nssm/nssm.exe` (top-level). Always use bundled NSSM via `common\NSSM.psm1`'s `Get-NssmPath`.
- **Green bundle is self-contained** — `-InPlace` install must NOT copy files to `C:\addashboard\Center`. The whole point of the green version is "extract and run".
- **Idempotency is mandatory** — `start.bat` and `install-center.ps1 -InPlace` must both be safely re-runnable. Existing service → skip install but still refresh NSSM params + `sc failure` settings.
- **Logs always go to `C:\addashboard\Logs`** — `AppStdout`/`AppStderr` set to `C:\addashboard\Logs\ADDashboardCenter-{stdout,stderr}.log` with 10MB rotation. Applies to both production and `-InPlace` paths.
- **Existing tests stay green** — 145/146 center + 56/56 frontend + all Pester tests must pass after every task.
- **No new dependencies** — NSSM + `sc.exe` are already available.
- **Mirror sync** — every change to `scripts/*` MUST also be made to `publish/scripts/*` and vice-versa. The publish/ directory is the green-bundle mirror tracked in git.
- **Out of scope (explicit non-goals)** — agent changes; production `C:\addashboard\Center` install path changes; wizard UX redesign; hot config reload; cross-platform support.

---

## Task 1: install-center.ps1 — add `-InPlace` switch

**Files:**
- Modify: `scripts/install-center.ps1` (canonical)
- Modify: `publish/scripts/install-center.ps1` (mirror — keep identical)
- Test: `scripts/tests/install-center.Tests.ps1` (existing Pester tests)

**Interfaces:**
- Consumes: (none — first task)
- Produces: `[switch]$InPlace` parameter on `install-center.ps1`. When set: `$InstallPath` is overridden to `Join-Path $projectRoot 'center'`; file-copy steps and `npm install` are skipped; `frontend/dist` build IS still run if missing.

- [ ] **Step 1: Write failing Pester test for `-InPlace` parsing**

Add to `scripts/tests/install-center.Tests.ps1`:

```powershell
Describe 'install-center -InPlace switch' {
  It 'accepts -InPlace switch' {
    $content = Get-Content (Join-Path (Join-Path $PSScriptRoot '..') 'install-center.ps1') -Raw
    $content | Should -Match '\[switch\]\$InPlace'
  }

  It 'overrides InstallPath when -InPlace is set' {
    $content = Get-Content (Join-Path (Join-Path $PSScriptRoot '..') 'install-center.ps1') -Raw
    # When InPlace is set, InstallPath must resolve to <projectRoot>\center, not C:\addashboard\Center.
    # Match the branch: if -not $InPlace use param default; else override.
    $content | Should -Match 'if\s*\(\s*\$InPlace\s*\)\s*\{'
    $content | Should -Match '\$projectRoot.{0,5}''center'''
  }

  It 'still copies files when -InPlace is NOT set (regression guard)' {
    $content = Get-Content (Join-Path (Join-Path $PSScriptRoot '..') 'install-center.ps1') -Raw
    # Copy-Item must still exist (production install path unchanged).
    $content | Should -Match 'Copy-Item'
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /d/ToolDevelop/ADDashboard && pwsh -Command "Invoke-Pester ./scripts/tests/install-center.Tests.ps1 -Output Detailed"`
Expected: The new `It 'accepts -InPlace switch'` fails with "Expected 'install-center.ps1' to match pattern [switch]$InPlace" (or similar).

- [ ] **Step 3: Add `-InPlace` switch and branch in install-center.ps1**

Edit `scripts/install-center.ps1`. Replace the `param(` block (lines 7-12) with:

```powershell
[CmdletBinding()]
param(
  [string]$InstallPath = 'C:\addashboard\Center',
  [int]$ListenPort = 8080,
  [string]$AgentToken,   # generated if missing
  [string]$JwtSecret,    # generated if missing
  [switch]$InPlace       # green-bundle: install service pointing at <projectRoot>\center, no file copy
)
```

After line 14 (`$ErrorActionPreference = 'Stop'`), insert the in-place path override (BEFORE the `Write-Step` call on line 20):

```powershell
if ($InPlace) {
  $InstallPath = Join-Path $projectRoot 'center'
  Write-Info "in-place install: service will point at $InstallPath (no file copy to C:\addashboard)"
}
```

After the "0. Ensure NSSM" section (line 23) but BEFORE the "1. Ensure directories" section (line 25), insert the conditional skip block:

```powershell
# When -InPlace, skip file copy / dist mirror / npm install of the install target.
# node_modules is still installed if missing (green-bundle first-time setup).
if (-not $InPlace) {
  # 1. Ensure directories
  $logDir = 'C:\addashboard\Logs'
  @($InstallPath, "$InstallPath\dist", $logDir) | ForEach-Object {
    if (-not (Test-Path $_)) { New-Item -ItemType Directory -Path $_ -Force | Out-Null; Write-Info "created $_" }
  }
  $Script:LogDir = $logDir

  # 2. Verify Node.js
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  Write-Info "node: $node"

  # 3. Build frontend if dist missing
  $distPath = Join-Path $projectRoot 'frontend\dist'
  if (-not (Test-Path (Join-Path $distPath 'index.html'))) {
    Write-Step "building frontend"
    Push-Location $projectRoot
    try { npm run build:frontend } finally { Pop-Location }
  }

  # 4. Copy center files
  $srcDir = Join-Path $projectRoot 'center'
  Copy-Item -Path (Join-Path $srcDir '*') -Destination $InstallPath -Recurse -Force -Exclude 'node_modules','tests','appsettings.json'
  if (-not (Test-Path (Join-Path $InstallPath 'node_modules'))) {
    Write-Step "installing center node_modules"
    Push-Location $InstallPath
    try { npm install --omit=dev } finally { Pop-Location }
  }
  Copy-Item -Path (Join-Path $distPath '*') -Destination (Join-Path $InstallPath 'dist') -Recurse -Force
} else {
  # In-place: only install node_modules if missing; build dist if missing.
  $Script:LogDir = 'C:\addashboard\Logs'
  if (-not (Test-Path $Script:LogDir)) { New-Item -ItemType Directory -Path $Script:LogDir -Force | Out-Null }
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  Write-Info "node: $node"
  if (-not (Test-Path (Join-Path $InstallPath 'node_modules'))) {
    Write-Step "installing center node_modules (in-place)"
    Push-Location $InstallPath
    try { npm install --omit=dev } finally { Pop-Location }
  }
  $distPath = Join-Path $InstallPath 'dist'
  if (-not (Test-Path (Join-Path $distPath 'index.html'))) {
    Write-Step "building frontend (in-place)"
    Push-Location (Join-Path $projectRoot 'frontend')
    try { npm run build } finally { Pop-Location }
    if (Test-Path $distPath) { Remove-Item -Path $distPath -Recurse -Force }
    New-Item -ItemType Directory -Path $distPath -Force | Out-Null
    Copy-Item -Path (Join-Path $projectRoot 'frontend\dist\*') -Destination $distPath -Recurse -Force
  }
}
```

Then delete the original sections 1-4 (lines 25-52 of the existing file — the `if ($InPlace) { ... } else { ... }` block above REPLACES them).

The "5. Register and start service" section (lines 54-68) needs no changes — it uses `$InstallPath` which has been overridden.

- [ ] **Step 4: Mirror the change to publish/scripts/install-center.ps1**

```bash
cp /d/ToolDevelop/ADDashboard/scripts/install-center.ps1 /d/ToolDevelop/ADDashboard/publish/scripts/install-center.ps1
diff -q /d/ToolDevelop/ADDashboard/scripts/install-center.ps1 /d/ToolDevelop/ADDashboard/publish/scripts/install-center.ps1
```

Expected: no diff output.

- [ ] **Step 5: Run Pester tests to verify pass**

Run: `cd /d/ToolDevelop/ADDashboard && pwsh -Command "Invoke-Pester ./scripts/tests/install-center.Tests.ps1 -Output Detailed"`
Expected: all 5 tests pass (3 existing + 2 new). Also run `pwsh -Command "Invoke-Pester ./scripts/tests -Output Detailed"` to make sure no other tests regress.

- [ ] **Step 6: Run node tests to make sure no regression**

Run: `cd /d/ToolDevelop/ADDashboard && npm test`
Expected: 145/146 center + agent tests + 56/56 frontend tests still green.

- [ ] **Step 7: Commit**

```bash
git add scripts/install-center.ps1 scripts/tests/install-center.Tests.ps1 publish/scripts/install-center.ps1
git commit -m "$(cat <<'EOF'
feat(install): add -InPlace switch for green-bundle service install

install-center.ps1 now accepts -InPlace, which overrides InstallPath to
<projectRoot>\center and skips the file-copy / dist-mirror steps. node_modules
is still installed if missing so a fresh green-bundle unpack works.

Default behavior (no -InPlace) is unchanged — production install still copies
files to C:\addashboard\Center. Mirrored to publish/scripts/ for the green
bundle.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: install-center.ps1 — NSSM exit action + Windows service recovery

**Files:**
- Modify: `scripts/install-center.ps1` (canonical)
- Modify: `publish/scripts/install-center.ps1` (mirror)
- Modify: `scripts/common/Service.psm1` (add helper for setting recovery)
- Test: `scripts/tests/install-center.Tests.ps1`

**Interfaces:**
- Consumes: Task 1's `[switch]$InPlace` parameter; `Install-NssmService` from `NSSM.psm1`
- Produces: `Set-ServiceRecovery` helper in `common/Service.psm1`. After `Install-NssmService` succeeds, the script calls `Set-ServiceRecovery -Name 'ADDashboardCenter'`. NSSM `AppExit=Restart`, `AppRestartDelay=2000`. `sc.exe failure` set to `reset= 60 actions= restart/5000/restart/10000/restart/30000`.

- [ ] **Step 1: Write failing Pester test for recovery settings**

Add to `scripts/tests/install-center.Tests.ps1`:

```powershell
Describe 'install-center service recovery' {
  It 'sets NSSM AppExit to Default Restart' {
    $content = Get-Content (Join-Path (Join-Path $PSScriptRoot '..') 'install-center.ps1') -Raw
    $content | Should -Match 'AppExit\s+Default\s+Restart'
  }

  It 'sets NSSM AppRestartDelay to 2000' {
    $content = Get-Content (Join-Path (Join-Path $PSScriptRoot '..') 'install-center.ps1') -Raw
    $content | Should -Match 'AppRestartDelay.*2000'
  }

  It 'configures Windows Service Recovery via sc.exe failure' {
    $content = Get-Content (Join-Path (Join-Path $PSScriptRoot '..') 'install-center.ps1') -Raw
    $content | Should -Match 'sc\.exe\s+failure\s+ADDashboardCenter'
    $content | Should -Match 'reset=\s*60'
    $content | Should -Match 'restart/5000/restart/10000/restart/30000'
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /d/ToolDevelop/ADDashboard && pwsh -Command "Invoke-Pester ./scripts/tests/install-center.Tests.ps1 -Output Detailed"`
Expected: the new `It 'sets NSSM AppExit to Restart'` fails.

- [ ] **Step 3: Add `Set-ServiceRecovery` helper to `scripts/common/Service.psm1`**

Append to `scripts/common/Service.psm1` (the file currently has `Start-ServiceSafe`, `Stop-ServiceSafe`, `Remove-ServiceSafe`):

```powershell
function Set-ServiceRecovery {
  param([Parameter(Mandatory)][string]$Name)
  $nssm = Get-NssmPath
  # NSSM-level: restart cleanly on process.exit(0) (used by wizard finalize).
  # AppExit requires the sub-parameter form `<exit_code|Default> <action>` —
  # NSSM 2.24 rejects bare `AppExit Restart` with "requires a subparameter!".
  # `Default Restart` means: restart the service on ANY exit code.
  & $nssm set $Name AppExit Default Restart | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "nssm set $Name AppExit Default Restart failed: $LASTEXITCODE" }
  & $nssm set $Name AppRestartDelay 2000 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "nssm set $Name AppRestartDelay failed: $LASTEXITCODE" }
  # Windows-level: restart on crash (OOM, segfault, kill -9).
  # Note: the syntax `reset= 60` requires a SPACE after `=`. sc.exe is picky about that.
  $scArgs = @('failure', $Name, 'reset=', '60', 'actions=', 'restart/5000/restart/10000/restart/30000')
  $p = Start-Process -FilePath 'sc.exe' -ArgumentList $scArgs -NoNewWindow -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "sc.exe failure $Name failed: exit $($p.ExitCode)" }
  Write-Info "service recovery set: NSSM AppExit=Default Restart + sc failure reset=60 actions=restart/5000/restart/10000/restart/30000"
}
```

Note: `Set-ServiceRecovery` calls `Get-NssmPath` which lives in `NSSM.psm1`. `Service.psm1` already requires `NSSM.psm1` to be imported first (per its file header comment). Install scripts import both via `Import-Module ... -Force`. No new dependency needed.

- [ ] **Step 4: Wire `Set-ServiceRecovery` into install-center.ps1**

After `Install-NssmService -Name 'ADDashboardCenter' ...` (around line 55-61 in the post-Task-1 file), add:

```powershell
Set-ServiceRecovery -Name 'ADDashboardCenter'
```

This runs for both `-InPlace` and default paths.

- [ ] **Step 5: Mirror the changes**

```bash
cp /d/ToolDevelop/ADDashboard/scripts/install-center.ps1 /d/ToolDevelop/ADDashboard/publish/scripts/install-center.ps1
cp /d/ToolDevelop/ADDashboard/scripts/common/Service.psm1 /d/ToolDevelop/ADDashboard/publish/scripts/common/Service.psm1
diff -q /d/ToolDevelop/ADDashboard/scripts/install-center.ps1 /d/ToolDevelop/ADDashboard/publish/scripts/install-center.ps1
diff -q /d/ToolDevelop/ADDashboard/scripts/common/Service.psm1 /d/ToolDevelop/ADDashboard/publish/scripts/common/Service.psm1
```

Expected: no diff output from either.

- [ ] **Step 6: Run all tests to verify pass + no regression**

Run: `cd /d/ToolDevelop/ADDashboard && pwsh -Command "Invoke-Pester ./scripts/tests -Output Detailed" && npm test`
Expected: 6 Pester tests pass (3+2 from Task 1 + 3 new). 145/146 + 56/56 node tests still green.

- [ ] **Step 7: Commit**

```bash
git add scripts/install-center.ps1 scripts/common/Service.psm1 scripts/tests/install-center.Tests.ps1 publish/scripts/install-center.ps1 publish/scripts/common/Service.psm1
git commit -m "$(cat <<'EOF'
feat(install): enable auto-restart via NSSM AppExit + sc failure recovery

Wizard finalize calls process.exit(0) so NSSM AppExit=Restart picks it
up and re-launches the service with the new appsettings.json. Crashes
(OOM, segfault, kill -9) are covered by Windows Service Recovery via
sc.exe failure: 3 restart attempts at 5/10/30s with a 60s reset window.

Mirrored to publish/scripts/ for the green bundle.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: start.bat — service install by default, `--console` escape

**Files:**
- Modify: `publish/start.bat` (replace its 8-line body)
- Delete: `publish/start.js` (no longer needed; install-center.ps1 -InPlace handles deps + frontend build)

**Interfaces:**
- Consumes: Task 1+2's `install-center.ps1 -InPlace`. Expects admin context (detected via `net session`).
- Produces: `publish/start.bat` accepting `--console` / `-c` / `--help` / `-h` flags. Default invocation: idempotent service install + start, then exit.

- [ ] **Step 1: Replace `publish/start.bat` contents**

Overwrite `publish/start.bat` with:

```batch
@echo off
setlocal EnableExtensions

REM AD Replication Dashboard — green-bundle entry.
REM Default: install + start ADDashboardCenter Windows service, then exit (one-shot).
REM --console / -c: run node server.js in foreground (dev mode).
REM --help / -h: show usage.

set "MODE=service"
if /I "%~1"=="--console" set "MODE=console"
if /I "%~1"=="-c"        set "MODE=console"
if /I "%~1"=="--help"    set "MODE=help"
if /I "%~1"=="-h"        set "MODE=help"

if "%MODE%"=="help" goto :help
if "%MODE%"=="console" goto :console

REM ---- service mode ----
where powershell >nul 2>&1
if errorlevel 1 (
  echo [start] PowerShell not found in PATH. Install PowerShell 5.1+ from https://aka.ms/powershell
  exit /b 1
)
net session >nul 2>&1
if errorlevel 1 (
  echo [start] Service install requires Administrator. Re-run this cmd as Administrator.
  exit /b 1
)
pushd "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-center.ps1" -InPlace
set "RC=%ERRORLEVEL%"
popd
exit /b %RC%

:console
where node >nul 2>&1
if errorlevel 1 (
  echo [console] Node.js not found in PATH. Install Node.js 18+ from https://nodejs.org/
  exit /b 1
)
pushd "%~dp0center"
node server.js
set "RC=%ERRORLEVEL%"
popd
exit /b %RC%

:help
echo Usage: start.bat [--console^|-c ^| --help^|-h]
echo   (default)   install + start ADDashboardCenter Windows service, then exit
echo   --console   run node server.js in foreground (dev mode)
echo   --help      show this message
exit /b 0
```

- [ ] **Step 2: Delete `publish/start.js`**

```bash
rm /d/ToolDevelop/ADDashboard/publish/start.js
```

- [ ] **Step 3: Smoke test `--help` flag (no admin required)**

Run: `cd /d/ToolDevelop/ADDashboard/publish && cmd //c "start.bat --help"`
Expected: prints Usage block, exits 0.

- [ ] **Step 4: Smoke test admin check (no admin context)**

Run: from a non-elevated cmd, `cd /d/ToolDevelop/ADDashboard/publish && start.bat`
Expected: prints `[start] Service install requires Administrator.`, exits 1.

- [ ] **Step 5: Smoke test `--console` flag**

Run: `cd /d/ToolDevelop/ADDashboard/publish && cmd //c "start.bat --console" & timeout /t 3 /nobreak >nul & taskkill /im node.exe /f`
Expected: node server.js starts, listens on :8080, gets killed. The user will see "node server.js" in the process list briefly.

- [ ] **Step 6: Run node tests for regression**

Run: `cd /d/ToolDevelop/ADDashboard && npm test`
Expected: 145/146 + 56/56 still green.

- [ ] **Step 7: Commit**

```bash
git add publish/start.bat publish/start.js
git commit -m "$(cat <<'EOF'
feat(start): make service install the default; --console preserves dev mode

start.bat now defaults to invoking install-center.ps1 -InPlace (idempotent
service install + start, then exit). start.bat --console / -c falls back
to running node server.js in foreground for development. --help / -h
prints usage.

Removed publish/start.js — install-center.ps1 -InPlace already handles
node_modules install + frontend build for the green bundle.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: start.ps1 — PowerShell mirror

**Files:**
- Modify: `publish/start.ps1` (replace body)

**Interfaces:**
- Consumes: Task 3's `publish/start.bat` matrix.
- Produces: `publish/start.ps1` accepting `-Console` / `-Help` switches. Default: service install + start. PowerShell users get parity with `start.bat`.

- [ ] **Step 1: Read current `publish/start.ps1` to confirm shape**

Run: `cat /d/ToolDevelop/ADDashboard/publish/start.ps1`
Expected: a PowerShell wrapper around the old `node start.js` (mirror of old start.bat). Confirm structure before replacing.

- [ ] **Step 2: Replace `publish/start.ps1` contents**

Overwrite `publish/start.ps1` with:

```powershell
<#
.SYNOPSIS
  AD Replication Dashboard — green-bundle entry (PowerShell).

.DESCRIPTION
  Default: install + start ADDashboardCenter Windows service (idempotent), then exit.
  -Console: run node server.js in foreground (dev mode).
  -Help:    show usage.

.EXAMPLE
  .\start.ps1
  .\start.ps1 -Console
#>
[CmdletBinding()]
param(
  [switch]$Console,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'
$bundleRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Test-IsAdministrator {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $pr = New-Object Security.Principal.WindowsPrincipal($id)
  return $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if ($Help) {
  @'
Usage: start.ps1 [-Console] [-Help]
  (default)   install + start ADDashboardCenter Windows service, then exit
  -Console    run node server.js in foreground (dev mode)
  -Help       show this message
'@ | Write-Host
  exit 0
}

if ($Console) {
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node) { Write-Host '[console] Node.js not found in PATH.' -ForegroundColor Red; exit 1 }
  Push-Location (Join-Path $bundleRoot 'center')
  try { & node server.js } finally { Pop-Location }
  exit $LASTEXITCODE
}

# Service mode
$ps = Get-Command powershell.exe -ErrorAction SilentlyContinue
if (-not $ps) { Write-Host '[start] PowerShell not found.' -ForegroundColor Red; exit 1 }
if (-not (Test-IsAdministrator)) {
  Write-Host '[start] Service install requires Administrator. Re-run from an elevated PowerShell.' -ForegroundColor Red
  exit 1
}
$installer = Join-Path $bundleRoot 'scripts\install-center.ps1'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -InPlace
exit $LASTEXITCODE
```

- [ ] **Step 3: Smoke test `-Help`**

Run: `cd /d/ToolDevelop/ADDashboard/publish && pwsh -File start.ps1 -Help`
Expected: prints usage, exits 0.

- [ ] **Step 4: Smoke test admin check (non-elevated pwsh)**

Run: from a non-elevated pwsh, `cd /d/ToolDevelop/ADDashboard/publish && pwsh -File start.ps1`
Expected: prints `[start] Service install requires Administrator.`, exits 1.

- [ ] **Step 5: Smoke test `-Console` mode**

Run: `cd /d/ToolDevelop/ADDashboard/publish && (pwsh -File start.ps1 -Console &) ; sleep 3 ; taskkill /im node.exe /f`
Expected: node server.js starts, listens on :8080, gets killed.

- [ ] **Step 6: Run all tests for regression**

Run: `cd /d/ToolDevelop/ADDashboard && pwsh -Command "Invoke-Pester ./scripts/tests -Output Detailed" && npm test`
Expected: 6 Pester + 145/146 + 56/56 still green.

- [ ] **Step 7: Commit**

```bash
git add publish/start.ps1
git commit -m "$(cat <<'EOF'
feat(start): add PowerShell mirror of service-mode default

start.ps1 mirrors start.bat's behavior in PowerShell syntax:
- (no args)    install + start service, requires admin
- -Console     foreground node server.js for dev
- -Help        usage

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Wizard finalize → `process.exit(0)`

**Files:**
- Modify: `center/src/init/router.js` (after `res.json` in `/finalize`)
- Test: `center/tests/init/router.test.js`

**Interfaces:**
- Consumes: (none)
- Produces: After `res.json({ ok: true, path: configPath })` returns, `setImmediate(() => process.exit(0))` schedules the process to exit with code 0. NSSM catches the exit and restarts the service.

- [ ] **Step 1: Write failing test for `process.exit(0)` after finalize**

Add to `center/tests/init/router.test.js`:

```javascript
test('POST /api/init/finalize schedules process.exit(0) after responding', async () => {
  let exited = false;
  const origExit = process.exit;
  process.exit = (code) => { exited = code === 0; };
  try {
    const app = express();
    app.use(express.json());
    app.use('/api/init', initRouter({
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      configPath: './does-not-matter.json',
      getNeedsInit: () => true,
      _deps: {
        withOneShotFacade: async (d, p, w) => w({ execute: async () => ({}), query: async () => ({}), close: async () => {} }),
        applyAll: async () => ({}),
        createAdmin: async () => ({ id: 1, username: 'admin' }),
        writeConfig: () => ({ ok: true, path: './does-not-matter.json' }),
        getWizardFacade: async () => ({}),
        closeWizardFacade: async () => {},
        writeMarker: async () => {}
      }
    }));
    const r = await call(app, 'POST', '/api/init/finalize', {
      dialect: 'mysql', connParams: { host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' }
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    // Wait a tick for setImmediate to fire.
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(exited, true, 'process.exit(0) should have been called');
  } finally {
    process.exit = origExit;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /d/ToolDevelop/ADDashboard/center && npx node --test tests/init/router.test.js`
Expected: the new test fails with "process.exit(0) should have been called" or similar.

- [ ] **Step 3: Add `setImmediate(() => process.exit(0))` to `/finalize` handler**

In `center/src/init/router.js`, after line 114 (`res.json({ ok: true, path: configPath });`) and inside the `try` block (before the closing `}` of `try`), add:

```javascript
      res.json({ ok: true, path: configPath });
      // Service mode: exit so NSSM AppExit=Restart picks up the new appsettings.json.
      // setImmediate runs after I/O callbacks but before timers, giving res.json a chance
      // to flush the response before the process dies. In console mode, this also exits
      // the foreground process — dev restarts manually.
      setImmediate(() => process.exit(0));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /d/ToolDevelop/ADDashboard/center && npx node --test tests/init/router.test.js`
Expected: all tests in `router.test.js` pass, including the new one.

- [ ] **Step 5: Run full center test suite for regression**

Run: `cd /d/ToolDevelop/ADDashboard && npm run test:center`
Expected: 145/146 still green (same 1 expected skip).

- [ ] **Step 6: Commit**

```bash
git add center/src/init/router.js center/tests/init/router.test.js
git commit -m "$(cat <<'EOF'
fix(init): exit process after finalize so NSSM restarts with new config

After /api/init/finalize writes appsettings.json and the init-complete marker,
the backend schedules process.exit(0) via setImmediate. NSSM's
AppExit=Restart (set by install-center.ps1) catches the clean exit
and re-launches the service with the new config picked up.

In console/dev mode, the same exit terminates the foreground process —
devs restart manually.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Frontend polling + login redirect after finalize

**Files:**
- Modify: `frontend/src/views/init/InitStep.vue`
- Modify: `frontend/tests/init/init-step.test.js`

**Interfaces:**
- Consumes: Task 5's `/api/init/status` returning `{ needsInit: true }` until wizard completes, then `{ needsInit: false }` (router-level, not wizard-level).
- Produces: After `store.finalize()` returns ok, the Vue component shows "服务正在重启，请稍候…", polls `getStatus()` every 1000ms, redirects to `/login` when `needsInit=false`. On 30s timeout, shows manual-restart hint with a button.

- [ ] **Step 1: Read frontend's `getStatus` to confirm interface**

Run: `cat /d/ToolDevelop/ADDashboard/frontend/src/api/init.js`
Expected: an exported `getStatus` function. Confirm exact name (the existing test mocks it as `getStatus`).

- [ ] **Step 2: Write failing frontend test for polling behavior**

Add to `frontend/tests/init/init-step.test.js`:

NOTE: `vi.spyOn(initApi, 'getStatus')` does NOT work because the file-level `vi.mock('../../src/api/init.js', ...)` replaces the whole module — `initApi.getStatus` is already the mock fn. Use the mock fn directly: `initApi.getStatus.mockResolvedValue(...)`.

NOTE: `vi.useFakeTimers()` does NOT fake `Date.now()` by default. The 30s deadline check uses real time, which would make the timeout test flaky in CI. Pass `now: 0` and use `vi.advanceTimersByTimeAsync` to advance both timers AND Date.now.

```javascript
it('polls status after finalize and redirects to /login when needsInit=false', async () => {
  vi.useFakeTimers({ now: 0 });
  // initApi.getStatus is already the mock fn from the file-level vi.mock. Override directly.
  initApi.getStatus.mockResolvedValue({ data: { needsInit: false } });
  initApi.finalize.mockResolvedValue({ data: { ok: true } });

  const s = useInitStore();
  s.setDialect('mysql');
  s.setConnParams({ host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' });
  s.setAdmin({ username: 'admin', password: 'hunter22pass', confirm: 'hunter22pass' });

  const routerPush = vi.fn();
  const w = mount(InitStep, {
    global: {
      mocks: { $router: { push: routerPush } },
      plugins: [createPinia()]
    }
  });

  // Let onMounted → runSequence → finalize resolve.
  await flushPromises();
  // Fire the first setInterval tick at +1000ms.
  await vi.advanceTimersByTimeAsync(1000);
  // Let the polling callback's getStatus promise resolve.
  await flushPromises();

  expect(routerPush).toHaveBeenCalledWith('/login');
  vi.useRealTimers();
});

it('shows restart hint after 30s timeout without needsInit=false', async () => {
  vi.useFakeTimers({ now: 0 });
  initApi.getStatus.mockResolvedValue({ data: { needsInit: true } });
  initApi.finalize.mockResolvedValue({ data: { ok: true } });

  const s = useInitStore();
  s.setDialect('mysql');
  s.setConnParams({ host: 'h', port: 3306, database: 'd', user: 'u', password: 'p' });
  s.setAdmin({ username: 'admin', password: 'hunter22pass', confirm: 'hunter22pass' });

  const w = mount(InitStep, {
    global: { mocks: { $router: { push: vi.fn() } }, plugins: [createPinia()] }
  });
  await flushPromises();
  // Advance past the 30s deadline. Date.now() advances with timers when `now: 0` is set.
  await vi.advanceTimersByTimeAsync(31000);
  await flushPromises();

  expect(w.text()).toMatch(/重启失败|nssm restart/);
  vi.useRealTimers();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /d/ToolDevelop/ADDashboard/frontend && npx vitest run tests/init/init-step.test.js`
Expected: the new tests fail. The component currently shows a "前往登录" button on success rather than polling.

- [ ] **Step 4: Update `frontend/src/views/init/InitStep.vue` to poll after finalize**

Replace the template (lines 1-23):

```html
<template>
  <div class="init-step">
    <h3>第 3 步：初始化</h3>
    <p class="hint">正在初始化数据库架构、种子数据和管理员账号...</p>

    <ul class="stages">
      <li v-for="stage in stages" :key="stage.key" :class="stage.status">
        <span class="icon">{{ iconFor(stage.status) }}</span>
        <span class="label">{{ stage.label }}</span>
        <span v-if="stage.error" class="err">{{ stage.error }}</span>
      </li>
    </ul>

    <div v-if="restarting" class="restarting">
      <p>服务正在重启，请稍候…</p>
    </div>

    <div v-if="allDone && !restarting && !restartFailed" class="done">
      <p>✓ 初始化完成！</p>
      <p class="hint">服务即将自动重启...</p>
    </div>

    <div v-if="restartFailed" class="failed">
      <p class="err">服务重启失败。请运行 <code>start.bat</code> 或手动执行 <code>nssm restart ADDashboardCenter</code>。</p>
      <button type="button" @click="goLogin">前往登录</button>
    </div>

    <div v-if="failed" class="failed">
      <p class="err">初始化失败：{{ errorMsg }}</p>
      <button type="button" @click="retry">重试</button>
    </div>
  </div>
</template>
```

Replace the `<script setup>` body (lines 26-89):

```javascript
<script setup>
import { computed, onMounted, onBeforeUnmount, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useInitStore } from '../../stores/init.js';
import * as initApi from '../../api/init.js';

const store = useInitStore();
const router = useRouter();

const stages = reactive([
  { key: 'createDb',  label: '创建数据库',  status: 'pending', error: null },
  { key: 'schema',    label: '应用架构',    status: 'pending', error: null },
  { key: 'seed',      label: '种子数据',    status: 'pending', error: null },
  { key: 'migrations',label: '数据迁移',    status: 'pending', error: null },
  { key: 'admin',     label: '创建管理员',  status: 'pending', error: null },
  { key: 'config',    label: '写入配置',    status: 'pending', error: null }
]);

const allDone = computed(() => stages.every(s => s.status === 'done'));
const failed = computed(() => stages.some(s => s.status === 'failed'));
const errorMsg = computed(() => stages.find(s => s.status === 'failed')?.error || '');
const restarting = ref(false);
const restartFailed = ref(false);

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 30000;
let pollTimer = null;
let pollDeadline = 0;

function iconFor(status) {
  return { pending: '○', inProgress: '◌', done: '✓', failed: '✗' }[status] || '○';
}

function setStatus(key, status, error = null) {
  const s = stages.find(s => s.key === key);
  if (s) { s.status = status; s.error = error; }
}

async function runSequence() {
  for (const s of stages) { s.status = 'pending'; s.error = null; }
  try {
    if (store.dialect === 'mysql') {
      setStatus('createDb', 'inProgress');
      await store.applyDb(true);
      setStatus('createDb', 'done');
    }
    setStatus('schema', 'inProgress');
    setStatus('seed', 'inProgress');
    setStatus('migrations', 'inProgress');
    if (store.dialect !== 'mysql') await store.applyDb(false);
    setStatus('schema', 'done');
    setStatus('seed', 'done');
    setStatus('migrations', 'done');

    setStatus('admin', 'inProgress');
    await store.createAdmin();
    setStatus('admin', 'done');

    setStatus('config', 'inProgress');
    await store.finalize();
    setStatus('config', 'done');
    startRestartPolling();
  } catch (e) {
    const failedStage = stages.find(s => s.status === 'inProgress');
    if (failedStage) setStatus(failedStage.key, 'failed', e.response?.data?.error || e.message);
  }
}

function startRestartPolling() {
  restarting.value = true;
  pollDeadline = Date.now() + POLL_TIMEOUT_MS;
  pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
}

async function pollOnce() {
  try {
    const r = await initApi.getStatus();
    if (r?.data?.needsInit === false) {
      stopPolling();
      router.push('/login');
      return;
    }
  } catch {
    // Network blip during restart — keep polling.
  }
  if (Date.now() > pollDeadline) {
    stopPolling();
    restartFailed.value = true;
  }
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  restarting.value = false;
}

function retry() {
  restartFailed.value = false;
  runSequence();
}
function goLogin() { router.push('/login'); }

onMounted(() => { runSequence(); });
onBeforeUnmount(stopPolling);
</script>
```

Append one CSS rule to the existing `<style scoped>` block (after line 105):

```css
.restarting { padding: 16px; border-radius: 4px; background: var(--panel-alt); color: var(--accent); }
code { background: var(--bg); padding: 2px 6px; border-radius: 3px; font-family: 'Consolas', monospace; }
```

- [ ] **Step 5: Run frontend tests to verify pass**

Run: `cd /d/ToolDevelop/ADDashboard/frontend && npx vitest run tests/init/init-step.test.js`
Expected: all tests pass (3 existing + 2 new).

- [ ] **Step 6: Run full frontend test suite for regression**

Run: `cd /d/ToolDevelop/ADDashboard && npm run test:frontend`
Expected: 58/58 tests pass (56 existing + 2 new).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/views/init/InitStep.vue frontend/tests/init/init-step.test.js
git commit -m "$(cat <<'EOF'
feat(init-ui): poll status after finalize; auto-redirect to login on service restart

After finalize succeeds, the wizard polls /api/init/status every 1s.
When the restarted service responds with needsInit=false, the component
navigates to /login. On a 30s timeout (e.g. NSSM restart failed), it
shows a manual-restart hint with a button.

Replaces the previous "前往登录" button-on-success pattern, which would
have left the user staring at a stale page after wizard finalize.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: smoke-test.ps1 — in-place + recovery checks

**Files:**
- Modify: `publish/scripts/smoke-test.ps1`
- Modify: `scripts/smoke-test.ps1` (mirror)

**Interfaces:**
- Consumes: Tasks 1+2 outputs (in-place service install + NSSM recovery settings).
- Produces: Three new probe steps appended to `smoke-test.ps1`:
  1. `Test-Path C:\addashboard\Center` → assert false (in-place didn't copy files).
  2. `nssm get ADDashboardCenter AppExit` → assert output contains `Default` and `Restart` (NSSM 2.24 prints `Default\Restart`); `AppRestartDelay` → assert `2000`.
  3. `sc.exe qfailure ADDashboardCenter` → assert output contains `restart` and `60`.

- [ ] **Step 1: Mirror current `smoke-test.ps1` from publish to top-level**

```bash
cp /d/ToolDevelop/ADDashboard/publish/scripts/smoke-test.ps1 /d/ToolDevelop/ADDashboard/scripts/smoke-test.ps1
diff -q /d/ToolDevelop/ADDashboard/publish/scripts/smoke-test.ps1 /d/ToolDevelop/ADDashboard/scripts/smoke-test.ps1
```

Expected: no diff output. (Confirms they were already in sync.)

- [ ] **Step 2: Append new checks to `scripts/smoke-test.ps1`**

Edit `scripts/smoke-test.ps1` (line 47 is the final `if ($script:fail) ... exit 1`). Replace lines 47-47 with:

```powershell
# 5. in-place install verification (no C:\addashboard\Center copy)
$inPlaceOk = -not (Test-Path 'C:\addashboard\Center')
Step 'no C:\addashboard\Center copy' $inPlaceOk "directory exists; in-place install may have copied files"

# 6. NSSM auto-restart settings
$nssmExit = (nssm get ADDashboardCenter AppExit 2>$null)
$nssmDelay = (nssm get ADDashboardCenter AppRestartDelay 2>$null)
# NSSM prints `Default\Restart` (or `Default: Restart` on some versions) for
# the `AppExit=Default Restart` config. Match substrings to tolerate both.
$okExit = ($nssmExit -match 'Default') -and ($nssmExit -match 'Restart')
Step 'NSSM AppExit=Default\Restart' $okExit "got: $nssmExit"
Step 'NSSM AppRestartDelay=2000' ($nssmDelay -eq '2000') "got: $nssmDelay"

# 7. Windows Service Recovery
$scFail = (sc.exe qfailure ADDashboardCenter 2>&1 | Out-String)
Step 'sc failure has restart actions' ($scFail -match 'restart') $scFail
Step 'sc failure reset period contains 60' ($scFail -match '60') $scFail

if ($script:fail) { Write-Host "`nSMOKE TEST FAILED" -ForegroundColor Red; exit 1 } else { Write-Host "`nSMOKE TEST PASSED" -ForegroundColor Green }
```

- [ ] **Step 3: Mirror change back to `publish/scripts/smoke-test.ps1`**

```bash
cp /d/ToolDevelop/ADDashboard/scripts/smoke-test.ps1 /d/ToolDevelop/ADDashboard/publish/scripts/smoke-test.ps1
diff -q /d/ToolDevelop/ADDashboard/scripts/smoke-test.ps1 /d/ToolDevelop/ADDashboard/publish/scripts/smoke-test.ps1
```

Expected: no diff output.

- [ ] **Step 4: Update or add Pester test for the smoke-test additions**

Edit `scripts/tests/smoke-test.Tests.ps1`. Read it first to see its structure, then add an `It 'checks NSSM AppExit'` block matching the new probes. If the file's existing tests are content-shape assertions, follow that style.

If no existing tests check content of smoke-test.ps1, create the file `scripts/tests/smoke-test.Tests.ps1` with:

```powershell
Describe 'smoke-test.ps1 in-place + recovery checks' {
  It 'verifies C:\addashboard\Center was not created by in-place install' {
    $content = Get-Content (Join-Path (Join-Path $PSScriptRoot '..') 'smoke-test.ps1') -Raw
    $content | Should -Match 'no C:\\addashboard\\Center copy'
  }

  It 'probes NSSM AppExit' {
    $content = Get-Content (Join-Path (Join-Path $PSScriptRoot '..') 'smoke-test.ps1') -Raw
    $content | Should -Match "'Default'"
    $content | Should -Match "'Restart'"
    $content | Should -Match 'AppRestartDelay=2000'
  }

  It 'probes Windows Service Recovery via sc.exe qfailure' {
    $content = Get-Content (Join-Path (Join-Path $PSScriptRoot '..') 'smoke-test.ps1') -Raw
    $content | Should -Match 'sc\.exe qfailure'
  }
}
```

- [ ] **Step 5: Run Pester tests to verify pass**

Run: `cd /d/ToolDevelop/ADDashboard && pwsh -Command "Invoke-Pester ./scripts/tests -Output Detailed"`
Expected: all smoke-test.Tests.ps1 tests pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/smoke-test.ps1 publish/scripts/smoke-test.ps1 scripts/tests/smoke-test.Tests.ps1
git commit -m "$(cat <<'EOF'
test(smoke): verify -InPlace, NSSM exit action, and Windows recovery

Adds three new probes to smoke-test.ps1:
  - C:\addashboard\Center must NOT exist (in-place didn't copy)
  - NSSM AppExit=Restart + AppRestartDelay=2000
  - sc.exe qfailure output contains 'restart' and '60'

Mirrored to publish/scripts/ for the green bundle.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: README + deployment docs

**Files:**
- Modify: `publish/README.md`
- Modify: `docs/operations/deployment.md`

**Interfaces:**
- Consumes: Tasks 1-7's user-visible behavior.
- Produces: Updated `publish/README.md` reflecting service-mode default. Updated `docs/operations/deployment.md` with a paragraph noting the green bundle's new default.

- [ ] **Step 1: Rewrite `publish/README.md` quick-start section**

Edit `publish/README.md`. Find and replace the following blocks:

Replace lines 13-16 (the `# 快速开始` section):

```markdown
## 快速开始

```powershell
# 在 publish/ 目录下（需要管理员权限）：
.\start.bat
```
```

with:

```markdown
## 快速开始

```cmd
:: 在 publish/ 目录下，需要管理员权限（首次安装服务需要）
.\start.bat
```
```

Replace lines 18-22 (the `首次运行会自动：` block):

```markdown
首次运行会自动：

1. 安装 `publish/center/` 和 `publish/frontend/` 的运行时依赖
2. 构建前端 → 镜像到 `publish/center/dist/`
3. 启动 center，监听 `http://localhost:8080`
```
```

with:

```markdown
首次运行会自动：

1. 注册 `ADDashboardCenter` Windows 服务（NSSM 包装，指向 `publish\center\`）
2. 配置服务自启 + NSSM `AppExit=Restart`（wizard finalize 后自动重启）+ Windows Service Recovery（崩溃三次重试）
3. 安装 `publish/center/` 运行时依赖 + 构建前端
4. 启动服务，监听 `http://localhost:8080`

完成后 `start.bat` 直接退出。服务在后台运行，会话注销、机器重启都不影响。
```

Replace line 34 (`按 **Ctrl+C** 关闭服务。`) with:

```markdown
**日志**：`C:\addashboard\Logs\ADDashboardCenter-{stdout,stderr}.log`（10MB 自动滚动）。查看最近输出：`Get-Content C:\addashboard\Logs\ADDashboardCenter-stdout.log -Tail 50 -Wait`。

**停止 / 卸载**：

```powershell
# 停止：管理员 PowerShell
Stop-Service ADDashboardCenter
# 卸载（彻底）：同 install 脚本目录
.\scripts\uninstall-center.ps1
```

```

Replace the "## 升级到服务模式（可选）" section title (line 90) with `## 开发模式（控制台）` and replace its body with:

```markdown
绿色版默认作为 Windows 服务运行。开发调试时如需前台输出，用 `--console` 切到控制台模式（不需要管理员）：

```cmd
.\start.bat --console
:: 等价于：cd publish\center && node server.js
.\start.bat -c        :: 简写
```

注意：控制台模式下 wizard 完成后进程直接退出（设计如此：让 NSSM 拉起新配置）。重启请直接 `node server.js`。
```

- [ ] **Step 2: Update `docs/operations/deployment.md`**

Read `docs/operations/deployment.md` first to find the production install section. Add a one-paragraph note near the install instructions:

```markdown
**注意**：绿色便携版的 `publish\start.bat` 现在默认安装为 Windows 服务（首次运行需要管理员权限）。如果你下载的是 `publish.zip` 而不是从 git 拉源码，请直接双击 `start.bat` 让它注册服务；如果用源码部署，继续走项目根目录的 `scripts/install-center.ps1` 拷贝到 `C:\addashboard\Center`。
```

- [ ] **Step 3: Build frontend to verify no Vue compile errors**

Run: `cd /d/ToolDevelop/ADDashboard && npm run build:frontend`
Expected: build succeeds, no errors.

- [ ] **Step 4: Run full test suite for regression**

Run: `cd /d/ToolDevelop/ADDashboard && npm test && pwsh -Command "Invoke-Pester ./scripts/tests -Output Detailed"`
Expected: 146/146 + 58/58 + all Pester still green.

- [ ] **Step 5: Commit**

```bash
git add publish/README.md docs/operations/deployment.md
git commit -m "$(cat <<'EOF'
docs: update README + deployment notes for service-default

publish/README.md: rewrite quick-start to reflect service install as default;
add log path + Stop-Service instructions; rename "升级到服务模式" to
"开发模式（控制台）" with --console usage.

docs/operations/deployment.md: add note that green-bundle start.bat now
installs as a Windows service by default.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Whole-branch verification (no code changes)

**Files:** (none — verification only)

- [ ] **Step 1: Run all automated tests**

Run: `cd /d/ToolDevelop/ADDashboard && npm test && pwsh -Command "Invoke-Pester ./scripts/tests -Output Detailed"`
Expected: 146/146 center + all agent + 58/58 frontend + all Pester pass.

- [ ] **Step 2: Manual end-to-end on Windows host**

Run on Windows (admin PowerShell):
```cmd
sc.exe delete ADDashboardCenter
cd publish
start.bat
```
Expected: service `Running`, `http://localhost:8080/api/init/status` returns 200 with `{"needsInit":true}`.

Complete wizard in browser. Expected: wizard UI shows "服务正在重启，请稍候…", service PID changes (compare `Get-WmiObject Win32_Service -Filter "Name='ADDashboardCenter'").ProcessId` before and after), browser lands on `/login`.

- [ ] **Step 3: Manual idempotency check**

Run: `start.bat` again (admin). Expected: no errors, service stays `Running`.

- [ ] **Step 4: Manual `--console` mode check**

Run: `start.bat --console`. Expected: node server.js runs in foreground, listening on :8080. Stop with Ctrl+C, no service interference.

- [ ] **Step 5: Manual uninstall check**

Run: `pwsh -File scripts/uninstall-center.ps1`. Expected: service removed, files in `publish/` intact, `http://localhost:8080` no longer responds.

If all five steps pass: branch is ready for merge.

---

## Self-Review

**1. Spec coverage:** Every section of the spec maps to a task here:
- `-InPlace` switch (spec "Interface Contracts" + Task 1) → Task 1.
- NSSM `AppExit` + `sc failure` (spec "NSSM parameters" + "sc.exe failure") → Task 2.
- `start.bat` argument matrix (spec "start.bat argument matrix") → Task 3.
- `start.ps1` PowerShell mirror (spec "no parallel entry scripts" + parity) → Task 4.
- Wizard finalize → `process.exit(0)` (spec "Wizard finalize changes") → Task 5.
- Frontend polling contract (spec "Frontend polling contract") → Task 6.
- smoke-test extensions (spec "Test strategy" rows 4-6) → Task 7.
- README + deployment docs (spec "Out of scope" boundary + user-visible behavior) → Task 8.
- End-to-end verification (spec "Test strategy" all 9 rows) → Task 9.

**2. Placeholder scan:** No "TBD", "TODO", "implement later", or vague steps. Every code change ships with the full code; every command ships with expected output; every test ships with concrete assertions.

**3. Type consistency:** Cross-checked signatures:
- `install-center.ps1` `[switch]$InPlace` introduced in Task 1, used in Tasks 2-3. ✅
- `Set-ServiceRecovery -Name 'ADDashboardCenter'` defined in Task 2, used in Task 2 itself. ✅
- `initApi.getStatus()` is the API the frontend polling calls — confirmed in `frontend/src/api/init.js` (existing pattern). ✅
- `process.exit(0)` in Task 5 matches NSSM `AppExit=Restart` from Task 2. ✅
- Mirror sync (`scripts/` ↔ `publish/scripts/`) is a Step in every relevant task, not a separate task. ✅

**4. Scope check:** The plan covers exactly what the spec describes. No agent changes. No production copy-path changes. No hot reload. No cross-platform.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-17-service-mode-default.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?