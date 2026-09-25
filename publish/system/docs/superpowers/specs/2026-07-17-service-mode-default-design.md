# Service Mode as Default — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the green-bundle entry point (`publish/start.bat`) from a foreground console process to a Windows-service installer. The user opens a browser instead of babysitting a terminal; service auto-restarts on clean exit (wizard finalize) and on crash.

**Architecture:** `start.bat` becomes an idempotent shell that calls `install-center.ps1 -InPlace` (which registers an NSSM service pointing at `publish/center/` in-place, with no file copy), waits for the service to reach `Running`, and exits. The wizard's `/finalize` handler calls `process.exit(0)` after writing `appsettings.json`; NSSM's `AppExit=Restart` picks it up and re-launches the service with the new config. Crashes are covered by `sc.exe failure` recovery. `start.bat --console` preserves the legacy console mode for development.

**Tech Stack:** Windows services via NSSM 2.24 (bundled at `publish/nssm/nssm.exe`), PowerShell 5.1 + pwsh 7+ (existing constraint), Express + Vue 3 (no change), Node 18+.

## Global Constraints

- **PowerShell 5.1 + pwsh 7+ dual compat** — no 3-arg `Join-Path`, no `??=`-style pwsh-only operators. (Per project memory `feedback_powershell_51.md`.)
- **`start.bat` is the user-facing entry** — every new behavior must be reachable through `start.bat` or its `--console` flag. Do not introduce a parallel entry script.
- **NSSM is at `publish/nssm/nssm.exe`** — always use the bundled binary, not a system-installed NSSM. Scripts locate it via `common\NSSM.psm1`'s `Get-NssmPath`.
- **Green bundle is self-contained** — service install must not copy files to `C:\addashboard\Center` when `-InPlace` is set. The whole point of green version is "extract and run".
- **Idempotency is mandatory** — `start.bat` and `install-center.ps1 -InPlace` must both be safely re-runnable: existing service → skip install but still refresh NSSM params + `sc failure` settings.
- **Logs always go to `C:\addashboard\Logs`** — `AppStdout` / `AppStderr` paths are set to `C:\addashboard\Logs\ADDashboardCenter-{stdout,stderr}.log` with 10MB rotation. This applies to both production and `-InPlace` paths.
- **Existing tests stay green** — 145/146 center + 56/56 frontend tests must pass after every task.
- **No new dependencies** — NSSM + `sc.exe` are already available; do not pull in anything else.
- **No changes to agent** — `install-agent.ps1` and agent-side behavior are out of scope. Green-bundle `start.bat` does not start the agent today and will continue to not start it after this change.
- **Out of scope (explicit non-goals)** — hot config reload; cross-platform support; production `C:\addashboard\Center` install path changes; wizard UX redesign.

---

## File Structure

**Files modified by this plan:**

- `publish/start.bat` — entry shell, default → service install; `--console` → node foreground.
- `publish/start.ps1` — PowerShell mirror of `start.bat` (same matrix, PowerShell syntax).
- `publish/scripts/install-center.ps1` — add `-InPlace` switch; add NSSM `AppExit=Restart` + `AppRestartDelay=2000`; add `sc.exe failure` recovery.
- `center/src/init/router.js` — `process.exit(0)` via `setImmediate` after `/finalize` returns 200.
- `frontend/src/views/init/InitStep.vue` — after finalize 200, poll `/api/init/status` until `needsInit=false`, then route to `/login`; 30s timeout with manual restart hint.
- `publish/scripts/smoke-test.ps1` — extend with new checks: NSSM `AppExit`, `AppRestartDelay`, `sc.exe qfailure` settings, in-place install verification (no `C:\addashboard\Center`).
- `publish/README.md` — rewrite "green version = console, service mode = optional upgrade" → "green version = service by default; `--console` for dev".
- `docs/operations/deployment.md` — add a one-paragraph note that green-bundle `start.bat` now installs as service by default (link to updated README).

**Files NOT touched (kept as-is):**

- `publish/scripts/uninstall-center.ps1` — already removes the service; works for both in-place and C:\ installs.
- `publish/scripts/update-center.ps1` — already handles upgrades; will pick up in-place installs automatically because it works by service name.
- `publish/scripts/install-agent.ps1`, `agent/*` — out of scope.
- `publish/nssm/nssm.exe` — already bundled.
- `publish/scripts/common/*` modules — used as-is.

## Interface Contracts

These are the public-facing contracts every task in this plan must conform to:

**`install-center.ps1` parameters:**
```
[CmdletBinding()]
param(
  [string]$InstallPath = 'C:\addashboard\Center',   # ignored when -InPlace
  [int]$ListenPort = 8080,
  [string]$AgentToken,
  [string]$JwtSecret,
  [switch]$InPlace   # NEW: skip file copy, point NSSM at $projectRoot\center
)
```

When `-InPlace` is set:
- `$InstallPath` is overridden to `Join-Path $projectRoot 'center'`
- File copy steps (`Copy-Item` from `$srcDir`, `npm install`, dist mirror) are skipped
- `npm install --omit=dev` IS still run if `node_modules` is missing (green-bundle first-time setup)
- `frontend/dist` build IS still run if `index.html` missing
- NSSM `AppDirectory` is set to `$InstallPath` (which is `publish\center` when `-InPlace`)

**`start.bat` argument matrix:**
- (no args) — install + start service, exit. Requires admin.
- `--console` / `-c` — `node server.js` in foreground from `publish\center\`. No admin needed.
- `--help` / `-h` — usage message, exit 0.

**`/api/init/finalize` response:**
- HTTP 200 with `{ ok: true, path: configPath }` (unchanged)
- Backend then calls `setImmediate(() => process.exit(0))` AFTER `res.json` returns
- NSSM (when running under service) catches the exit, waits `AppRestartDelay=2000ms`, restarts service with new `appsettings.json`
- In console dev mode, the same `process.exit(0)` simply terminates the foreground process — dev restarts manually

**Frontend polling contract (after finalize 200):**
- Display message: "服务正在重启，请稍候..."
- `GET /api/init/status` every 1000ms
- When `body.needsInit === false` → `router.push('/login')`
- After 30s without success → show error with text "服务重启失败。请运行 `start.bat` 或手动执行 `nssm restart ADDashboardCenter`" + a `start.bat` button.

**NSSM parameters set by `install-center.ps1 -InPlace`:**
- `AppDirectory = publish\center`
- `AppParameters = server.js`
- `AppStdout = C:\addashboard\Logs\ADDashboardCenter-stdout.log`
- `AppStderr = C:\addashboard\Logs\ADDashboardCenter-stderr.log`
- `AppRotateFiles = 1`
- `AppRotateOnline = 1`
- `AppRotateBytes = 10485760` (10 MB)
- `AppExit = Restart` (NEW)
- `AppRestartDelay = 2000` (NEW)
- `Start = 2` (auto-start)
- `DisplayName = "AD Replication Dashboard Center"`
- `Description = "AD Replication Dashboard Center (Node.js + Express + Vue 3)"`
- `AppEnvironmentExtra = NODE_ENV=production`

**`sc.exe failure ADDashboardCenter`:**
```
actions= restart/5000/restart/10000/restart/30000
reset= 60
```
- First failure → restart after 5s
- Second failure → restart after 10s
- Third failure → restart after 30s
- Fourth+ failure → no action
- 60s of healthy running resets the failure counter

---

## Task Breakdown

Tasks are ordered to keep the build green after every step. Each task is one commit.

### Task 1: install-center.ps1 — add -InPlace switch (skeleton)

**Files:**
- Modify: `publish/scripts/install-center.ps1`

**What:** Add the `[switch]$InPlace` parameter to the param block. Branch at the top: when `$InPlace`, override `$InstallPath` to `Join-Path $projectRoot 'center'`, log "in-place install: $InstallPath", and skip all file-copy + dist-mirror steps. Also skip `npm install --omit=dev` IF `node_modules` exists; only run it on first-time setup. Do NOT yet add NSSM `AppExit` / `AppRestartDelay` / `sc failure` — those are Task 2.

**Pass criteria:**
- `pwsh -File scripts/install-center.ps1 -InPlace` (or PS 5.1 equivalent) on a clean publish dir → service installed pointing at `publish\center`, no `C:\addashboard\Center` directory created, `Test-Path C:\addashboard\Center` returns false.
- `pwsh -File scripts/install-center.ps1` without `-InPlace` (production path) → still copies files to `C:\addashboard\Center` as before.
- 145/146 + 56/56 tests still green.

**Commit:** `feat(install): add -InPlace switch for green-bundle service install`

### Task 2: install-center.ps1 — NSSM exit action + Windows service recovery

**Files:**
- Modify: `publish/scripts/install-center.ps1`

**What:** After `Install-NssmService` succeeds (Task 1's last step), run:
- `nssm set ADDashboardCenter AppExit Default Restart` (NSSM 2.24 requires the sub-parameter `<exit_code|Default> <action>`; bare `AppExit Restart` is rejected with "requires a subparameter!")
- `nssm set ADDashboardCenter AppRestartDelay 2000`
- `sc.exe failure ADDashboardCenter reset= 60 actions= restart/5000/restart/10000/restart/30000`

These run both for `-InPlace` and for the default production path. Wrap in a helper `Set-ServiceRecovery` in `publish/scripts/common/Service.psm1` so it's reusable.

**Pass criteria:**
- `nssm get ADDashboardCenter AppExit` → output contains `Default` and `Restart` (NSSM 2.24 prints `Default\Restart`)
- `nssm get ADDashboardCenter AppRestartDelay` → `2000`
- `sc.exe qfailure ADDashboardCenter` → shows three `restart` actions with 5000/10000/30000 delays and `RESET_PERIOD` containing 60
- Re-running `install-center.ps1 -InPlace` is idempotent (no error from re-setting values)

**Commit:** `feat(install): enable auto-restart via NSSM AppExit + sc failure recovery`

### Task 3: start.bat — service install by default, --console escape

**Files:**
- Modify: `publish/start.bat`

**What:** Replace the current 8-line wrapper (which calls `node start.js`) with the decision tree from the design:
- No args → check admin via `net session`, pushd publish root, call `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-center.ps1 -InPlace`, exit with that script's `$LASTEXITCODE`.
- `--console` / `-c` → `node center\server.js` in foreground.
- `--help` / `-h` → usage text.
- Delete `publish/start.js` — its only job (bootstrapping center's deps + serving `server.js`) is now done by `install-center.ps1 -InPlace`.

**Pass criteria:**
- From a non-admin cmd window: `start.bat` exits with `[start] 需要管理员权限` and code 1; `start.bat --console` works.
- From an admin cmd window on a clean publish dir: `start.bat` exits 0, service is `Running`, `http://localhost:8080/api/init/status` returns 200.
- Re-running `start.bat` (admin) exits 0 without reinstalling.
- `start.bat --console` behaves identically to old behavior: `node center\server.js` in foreground.

**Commit:** `feat(start): make service install the default; --console preserves dev mode`

### Task 4: start.ps1 — PowerShell mirror

**Files:**
- Modify: `publish/start.ps1`

**What:** Replace contents with the same logic as `start.bat` but in PowerShell syntax: `param([string]$Mode = 'service')` block, `switch ($Mode)` over `service` / `console` / `help`, admin check via `[Security.Principal.WindowsPrincipal]([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`. Service path invokes `& ".\scripts\install-center.ps1" -InPlace` directly and exits with its `$LASTEXITCODE`. Console path `node ".\center\server.js"` in foreground.

**Pass criteria:**
- `pwsh -File start.ps1` (admin) → installs + starts service (same as Task 3 outcome).
- `pwsh -File start.ps1 --console` → foreground `node server.js`.
- Non-admin invocation exits cleanly with a helpful message.

**Commit:** `feat(start): add PowerShell mirror of service-mode default`

### Task 5: Wizard finalize → process.exit(0)

**Files:**
- Modify: `center/src/init/router.js`

**What:** After `res.json({ ok: true, path: configPath })` in the `/finalize` handler, schedule `process.exit(0)` via `setImmediate`. Reasoning: `res.json` is synchronous in Express 4 (it serializes and calls `res.send` immediately, which schedules the write), but the actual socket flush happens on next tick. `setImmediate` runs after I/O callbacks but before timers, giving the response a chance to flush. No need for a fixed delay; if the socket is closed before flush, the client sees an abrupt close, which the frontend already handles via the polling logic.

**Pass criteria:**
- New center test: `POST /api/init/finalize` with valid wizard body → response is 200, then process exits with code 0 (test uses `child_process.spawn` + `node server.js`, sends the request, asserts exit code 0).
- All 145/146 existing tests still green.

**Commit:** `fix(init): exit process after finalize so NSSM restarts with new config`

### Task 6: Frontend polling + login redirect after finalize

**Files:**
- Modify: `frontend/src/views/init/InitStep.vue`

**What:** After the existing `await initApi.finalize(...)` call returns 200 successfully, replace the current "前往登录" button click flow with: immediately show "服务正在重启，请稍候…" and start a `setInterval` polling `initApi.status()` every 1000ms. On `status.needsInit === false`, clear the interval and `router.push('/login')`. On 30s elapsed without success, clear the interval and show a manual-restart hint with a button that re-runs `start.bat` (informational only — actual rerun is the user's responsibility). The existing 前往登录 button is replaced (no longer the trigger) since service restart is now automatic.

**Pass criteria:**
- New frontend vitest: mock `initApi.finalize` → 200, mock `initApi.status` → first 29 calls return `{needsInit:true}`, 30th returns `{needsInit:false}` → assert `router.push('/login')` was called.
- All 56/56 existing tests still green.
- Manual browser test: complete wizard on a service-mode install → see "服务正在重启" → service restarts → browser lands on `/login` within ~3s.

**Commit:** `feat(init-ui): poll status after finalize; auto-redirect to login on service restart`

### Task 7: smoke-test.ps1 — in-place + recovery checks

**Files:**
- Modify: `publish/scripts/smoke-test.ps1`

**What:** Add three new checks at the end of the existing smoke test:
1. `Test-Path C:\addashboard\Center` → assert false (verifies -InPlace didn't copy files).
2. `nssm get ADDashboardCenter AppExit` → assert output contains `Default` and `Restart` (handle NSSM 2.24's `Default\Restart` printout); `AppRestartDelay` → assert `2000`.
3. `sc.exe qfailure ADDashboardCenter` → assert output contains `restart` and `60`.

These run after the existing healthcheck/login/dashboard probes.

**Pass criteria:**
- After running `install-center.ps1 -InPlace` + the wizard, `pwsh -File scripts/smoke-test.ps1` exits 0 with all three new checks passing.
- Tests #1-#3 (existing) still pass.

**Commit:** `test(smoke): verify -InPlace, NSSM exit action, and Windows recovery`

### Task 8: README + deployment docs

**Files:**
- Modify: `publish/README.md`
- Modify: `docs/operations/deployment.md`

**What:**
- `publish/README.md`: rewrite the section currently titled "绿色版 = console, service mode = optional upgrade" to reflect that `start.bat` is now the service installer. Keep `--console` documented as the dev escape. Update the quick-start section so users no longer expect a long-running console. Add a note that logs go to `C:\addashboard\Logs\ADDashboardCenter-{stdout,stderr}.log`. Keep the "升级到服务模式" section but rename it to "切换到控制台模式" with `start.bat --console` (i.e., the inverse direction).
- `docs/operations/deployment.md`: add a one-paragraph note in the install section: "Note: green-bundle `publish/start.bat` now installs as a Windows service by default. For production cross-DC deployments, continue using `install-center.ps1` from the project root (copies to `C:\addashboard\Center`)."

**Pass criteria:**
- A user reading `publish/README.md` cold can run `start.bat` as their first action and reach `/init` in their browser, without ever seeing a console process.

**Commit:** `docs: update README + deployment notes for service-default`

### Task 9: Whole-branch verification

**Files:** (no changes — verification only)

**What:** Run all the existing test suites end-to-end on the branch:
1. `npm test` in `center/` — expect 145/146 (the one expected skip).
2. `npm test` in `frontend/` — expect 56/56.
3. Pester tests in `tests/` if applicable.
4. End-to-end manual: `sc.exe delete ADDashboardCenter`, fresh `start.bat`, complete wizard, verify service restart via PID change, verify `/login` reachable, then `uninstall-center.ps1` clean removal.

**Pass criteria:** No regressions; all nine end-to-end test rows from the design (test plan table) pass.

**Commit:** none — verification only.

---

## Self-Review

**Spec coverage:** The original ask "convert the entire program to a service" was scoped by the user to center-only (Q2 answer). Every section of the design touches only center-related code. The agent and `install-agent.ps1` are explicitly out of scope.

**Placeholder scan:** No TBDs. Every section has concrete file paths, exact commands, exact values (NSSM params, `sc failure` actions, polling interval, timeout). All test rows have concrete pass criteria.

**Internal consistency:** The `-InPlace` switch is referenced consistently in install-center.ps1 (Task 1+2), start.bat (Task 3), start.ps1 (Task 4), and the README (Task 8). The `process.exit(0)` decision (Task 5) and frontend polling (Task 6) form a closed loop: backend exits → NSSM restarts → new config → `needsInit:false` → frontend redirects. The recovery layers (NSSM `AppExit=Restart` for clean exit, `sc failure` for crashes) don't overlap and don't conflict.

**Scope check:** This is a focused change: one entry shell, one install script param, one wizard handler, one Vue view, one smoke test extension, two doc files. Right-sized for a single implementation plan. No decomposition needed.

**Ambiguity check:** The "service exists but config differs" case is covered by idempotent `nssm set` + `sc failure` on every run. The "what if wizard finalize but user can't poll?" case is covered by the 30s timeout with manual-restart hint. The "console mode after wizard finalize exits" case is documented as dev-restarts-manually. No two-way interpretations remain.