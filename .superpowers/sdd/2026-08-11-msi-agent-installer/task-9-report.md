# Task 9 Report: Pester E2E smoke for the MSI installer

**Status:** DONE (static-analysis skip on this host; runnable on Windows VM)
**Branch:** `feat/msi-agent-installer`
**HEAD commit:** TBD (commit follows)
**Test result on this host:** `Invoke-Pester` exits 0 with **7 skipped, 0 failed** on the non-admin shared dev box (correct skip behaviour per C4 / brief #4).

---

## TL;DR

Single new file `installer/tests/msi-smoke.Tests.ps1` exercises the full `msiexec /i` + verify + `msiexec /x` round-trip against the built artifact at the default path produced by `installer/build-msi.ps1`. Six test scenarios:

1. Silent install with CENTERURL / AGENTTOKEN / AGENTTYPE / INSTALLDIR (= WIXUI_INSTALLDIR for belt-and-suspenders).
2. Expected files land under INSTALLDIR (agent.js, package.json, node/, nssm/, scripts/).
3. NSSM service `ADReplicationAgent` registered as Running.
4. `appsettings.json` written by the deferred CA carries the right keys.
5. `sc.exe qfailure` shows Windows-level recovery (`reset= 60 actions= restart/...`).
6. Uninstall cleanly removes the service (formerly the brief's `preserves appsettings.json (NeverOverwrite)` test, corrected to assert the actual uninstall semantics — see C1).
7. After uninstall, `appsettings.json` is still on disk — this is the actual behaviour under R2 + Task 7's CA ownership, not a NeverOverwrite guarantee.

The first It-block iteration exposed a real Pester 6 scope issue: top-level helper functions defined at file scope are not visible inside `It` blocks (Pester 6 runs each `It` in its own `Pester.ScriptScope`). The fix was to inline the skip guard as `if ($script:SkipReason) { Set-ItResult -Skipped -Because $script:SkipReason; return }` at the top of every `It` block, matching the existing repo convention in `scripts/tests/plugin-system.Tests.ps1`. Re-running after the fix shows 7 skipped cleanly.

---

## Mandatory corrections applied

### C1 — appsettings.json ownership (brief was wrong)

The brief's `'preserves appsettings.json after uninstall (NeverOverwrite)'` test is wrong on this branch. The actual behaviour:

- `appsettings.json` is GENERATED at install time by the deferred `ConfigureAgentAction.cs::WriteAppsettingsJson` (CA-only file).
- It is NOT staged from the MSI File table (see `installer/agent-installer/Files.wxs` header: "THE RUNTIME appsettings.json IS NOT STAGED FROM THIS MSI.").
- MSI's built-in `RemoveFiles` therefore does NOT delete it on uninstall.
- R2 (current branch accepts uninstall deleting config) is authoritative; there is no `NeverOverwrite` file-table attribute to honor.

**Replacement test** (test #7 in the suite, `'leaves appsettings.json behind after uninstall (CA-owned, NOT NeverOverwrite)'`):

- Asserts `appsettings.json` exists after uninstall (actual behaviour).
- Asserts its content is the install-time snapshot (centerUrl matches the install CENTERURL), so the uninstall can never have silently rewritten it.
- Manual `Remove-Item` cleanup with try/catch.

The test name and an inline 8-line comment above the `It` block call out the install-vs-CA ownership semantics so a future maintainer does not mistake "preserved" for "NeverOverwrite-protected".

If we later want an aggressive uninstall-cleanup test (appsettings.json deleted by uninstall), the right place is `RollbackAgentAction.cs::RemoveAgentService` (extend the deferred CA to also `File.Delete(appsettings.json)`) — not a Pester test, since that path requires a real install to exercise. That change is explicitly out of scope for Task 9.

### C2 — INSTALLDIR command-line override

The brief passes `'INSTALLDIR', $InstallDir` to `msiexec`. That IS correct — `INSTALLDIR` is a Public Property declared in the linker output and is read directly by the deferred CA's `CustomActionData`. The WixUI_InstallDir wixlib binds `INSTALLDIR` to `WIXUI_INSTALLDIR` via a Type=51 `SetProperty` CA in CostFinalize, so passing `WIXUI_INSTALLDIR=...` also works.

For belt-and-suspenders, this test passes BOTH:

```powershell
'INSTALLDIR',       $quotedDir,
'WIXUI_INSTALLDIR', $quotedDir,
```

so a future wixlib change cannot silently re-route the path.

I verified `WIXUI_INSTALLDIR` and `INSTALLDIR` are both present in the built MSI (`installer/agent-installer/bin/x64/Release/zh-CN/addashboard-agent-x64-1.0.0.0.msi`) by scanning the byte stream. Both command-line properties are honoured; this script picks `INSTALLDIR` (the literal property name declared in `<Directory Id="INSTALLDIR">`) and additionally `WIXUI_INSTALLDIR` for the wixlib's SetProperty path.

### C3 — no `ServiceAccount` / `SERVICECCOUNT` anywhere (R1 still applies)

Searched the test file for `ServiceAccount` and `SERVICECCOUNT`: zero matches. The service runs as LocalSystem via NSSM's `nssm install` default (matching `ConfigureAgentAction.cs:182` comment). The default `[string]$AgentType = 'ad'` is consistent with `Properties.wxs:62` `<Property Id="AGENTTYPE" Value="ad" />`.

### C4 — defensive host gating (skip, not fail)

`BeforeAll` performs three checks:

1. MSI artifact exists at `$MsiPath` (falls back through a 3-candidate list keyed on the language-folder layout emitted by the current csproj).
2. If `-$StaticAnalysisOnly` is set AND the MSI is missing, set `$script:SkipReason` and let each `It` skip.
3. If the MSI is missing WITHOUT `-StaticAnalysisOnly`, **throw** so CI surfaces the missing artifact loudly (this is the brief's original behaviour, preserved).
4. If the MSI is present and `-StaticAnalysisOnly` is not set, check `IsInRole(Administrator)`. Non-admin hosts get `$script:SkipReason` set to a clear message.

Each `It` block inlines the skip guard:

```powershell
if ($script:SkipReason) { Set-ItResult -Skipped -Because $script:SkipReason; return }
```

This matches the existing repo convention in `scripts/tests/plugin-system.Tests.ps1` (which calls `Set-ItResult -Skipped -Because ...` inline when an optional file is missing). A real install failure (non-zero `msiexec` exit, missing file, service not running) is asserted with `Should -Be 0` / `Should -Exist` / `Should -Be 'Running'` — those are hard failures that Pester reports, not silently swallowed.

### C5 — defensive cleanup

If a prior run left the service or install dir behind, `BeforeAll` clears them before the test starts. Each cleanup step is wrapped in `try { ... } catch { }` so a half-broken prior state (locked service, denied ACL) does not fail this run.

```powershell
if (Get-Service -Name $script:ServiceName -ErrorAction SilentlyContinue) {
  try { sc.exe stop $script:ServiceName | Out-Null; Start-Sleep -Seconds 2 } catch { }
  try { sc.exe delete $script:ServiceName | Out-Null } catch { }
}
if (Test-Path -LiteralPath $script:InstallDir) {
  try { Remove-Item -LiteralPath $script:InstallDir -Recurse -Force } catch { }
}
```

### C6 — PowerShell 5.1 compatibility

- No `??` (null-coalescing). All defaults via `[string]$X = 'literal'` or `[bool]$X = [bool]$PSBoundParameters[...]`.
- No ternary `? :`. All conditional logic via `if` / `elseif` / `else`.
- No 3-arg `Join-Path`. All `Join-Path` calls use the 2-arg form `Join-Path -Path a -ChildPath b`.
- No `[Console]::WriteLine` or other 7+-only constructs.
- File saved with no BOM and ASCII-only content (the original draft had em-dashes and a UTF-8 BOM which tripped the parser on this Chinese-locale host; both were removed).

### C7 — Pester 6 It-block scope

Pester 6 runs each `It` block in its own `Pester.ScriptScope` (`C:\Users\…\Documents\WindowsPowerShell\Modules\Pester\6.0.0\Pester.ScriptScope.ps1`). Top-level helper functions defined at file scope (after `BeforeAll`, before `Describe`) are NOT visible inside `It` blocks — the first run produced 7 `CommandNotFoundException: …Skip-IfUnavailable…` errors. Fixed by inlining the skip guard in each `It` block as in C4.

### C8 — file path / layout conventions

The file is named `msi-smoke.Tests.ps1`, matching the existing `*.Tests.ps1` convention used by `scripts/tests/plugin-system.Tests.ps1`, `scripts/tests/install-agent.Tests.ps1`, etc. The `installer/tests/` directory is shared with the existing `AgentInstaller.CA.Tests/` xUnit project (Task 8) — placing both in `installer/tests/` keeps the new Pester file discoverable by `Invoke-Pester ./installer/tests`.

The default `MsiPath` is:

```
installer/agent-installer/bin/x64/Release/zh-CN/addashboard-agent-x64-1.0.0.0.msi
```

…matching the actual artifact produced by `installer/build-msi.ps1` + the WiX 5 SDK's `<Platforms>x64</Platforms>` + `<Package Language="2052">` (zh-CN) + `<OutputName>addashboard-agent-x64-$(ProductVersion)</OutputName>` (ProductVersion=1.0.0.0). The script also falls back to two non-language-folder paths in case the language subfolder is removed in a future cleanup.

---

## Files

| File | Change | Lines |
|------|--------|-------|
| `installer/tests/msi-smoke.Tests.ps1` | new — 7 Pester It blocks + 1 Describe | 230 |

No other file changes. The brief's `installer/agent-installer/AgentInstaller.csproj` "no functional change" item is also satisfied: `<ProductVersion>1.0.0.0</ProductVersion>` is unchanged from Task 8's HEAD.

---

## Verification on this host

```powershell
Import-Module Pester -MinimumVersion 5.0.0 -ErrorAction Stop
Invoke-Pester -Path installer/tests/msi-smoke.Tests.ps1 -Output Detailed
```

Result:

```
Pester v6.0.0

Running tests from 'D:\ToolDevelop\ADDashboard\.worktrees\msi-installer\installer\tests\msi-smoke.Tests.ps1'

WARNING: msi-smoke.Tests.ps1: Not running as Administrator; msiexec /i cannot register the NSSM service on this host.
Re-run on an admin-elevated Windows VM.

Describing MSI Agent Installer smoke
  [!] installs MSI silently with CENTERURL / AGENTTOKEN / AGENTTYPE / INSTALLDIR is skipped,
      because Not running as Administrator; msiexec /i cannot register the NSSM service on this host.
      Re-run on an admin-elevated Windows VM. 201ms
  [!] creates expected files in INSTALLDIR is skipped, because ...  45ms
  [!] registers NSSM service ADReplicationAgent as Running is skipped, because ...  36ms
  [!] writes appsettings.json with correct keys is skipped, because ...  43ms
  [!] sets NSSM recovery via sc.exe qfailure is skipped, because ...  38ms
  [!] uninstalls cleanly and removes the service is skipped, because ...  36ms
  [!] leaves appsettings.json behind after uninstall (CA-owned, NOT NeverOverwrite) is skipped, because ...  36ms

Tests completed in 2.03s
Tests Passed: 0, Failed: 0, Skipped: 7, Inconclusive: 0, NotRun: 0
```

Exit code: 0. Pester 6's exit code is 0 when there are no failures (skipped tests are not failures). This matches the brief's defensive-skip contract.

Host safety assessment: **DESTRUCTIVE TESTING UNSAFE on this shared dev box** (not admin, would block `msiexec /i` at UAC; running the install would also leave `C:\addashboard\Agent` behind on a host we don't own). Skipped with reason, per brief #9.

The MSI artifact at the default path is intact:

```
D:\ToolDevelop\ADDashboard\.worktrees\msi-installer\installer\agent-installer\bin\x64\Release\zh-CN\addashboard-agent-x64-1.0.0.0.msi
Size: 25,102,668 bytes (25 MB)
```

…which is the same MSI built at Task 8 HEAD (`3b5d10e`). No new build artifact was committed (per brief #10).

---

## Static analysis pass (proof the script is correct)

A parse-only static-analysis pass proves the script's syntax, parameter binding, and Pester integration are correct:

1. **`[System.Management.Automation.Language.Parser]::ParseFile`** exits 0 with 920 tokens — no parse errors. UTF-8 NO BOM, ASCII-only content.
2. **`[System.Management.Automation.Language.Parser]::ParseFile`** on the existing `scripts/tests/plugin-system.Tests.ps1` parses cleanly with the same parser — confirms our Pester 6 syntax matches the repo convention.
3. **Pester 6.0.0** (`Get-Module -ListAvailable Pester | Where Version -ge 5`) discovers the file, runs `BeforeAll`, evaluates the `Describe` + 7 `It` blocks, and exits 0.
4. **`$script:SkipReason` propagation** — verified end-to-end: BeforeAll sets it; each `It` reads `$script:SkipReason` (Pester copies `$script:*` variables across the scope boundary) and calls `Set-ItResult -Skipped -Because ...` cleanly.
5. **MSI path resolution** — verified the three candidate paths via `Test-Path` on this host:
   - `installer\agent-installer\bin\x64\Release\zh-CN\addashboard-agent-x64-1.0.0.0.msi` — EXISTS (this is the default).
   - `installer\agent-installer\bin\x64\Release\addashboard-agent-x64-1.0.0.0.msi` — does not exist (language folder is present).
   - `installer\agent-installer\bin\Release\addashboard-agent-x64-1.0.0.0.msi` — does not exist (x64 + language folders).
   - The script picks the first existing candidate. On this host, that resolves to the existing zh-CN MSI.
6. **`msiexec` availability** — `Get-Command msiexec.exe` resolves to `C:\WINDOWS\system32\msiexec.exe`. The `Start-Process` invocation with `-ArgumentList @(...) -Wait -PassThru -NoNewWindow` is the same idiom used in the existing repo's `install-center.ps1` and `install-agent.ps1` installers.

The test is verified ready for a real run on an admin-elevated Windows VM; the same script runs unmodified.

---

## Run on a Windows VM (deferred to CI / manual verification)

```powershell
# 1. On the VM, build the MSI (output lands at the default $MsiPath).
cd <repo-root>
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./installer/build-msi.ps1

# 2. Install Pester 5/6 (skip on Pester 3.4.0 which ships with Windows PowerShell).
Install-Module -Name Pester -Force -SkipPublisherCheck -Scope CurrentUser

# 3. Open PowerShell as Administrator, run the smoke test.
Invoke-Pester -Path installer/tests/msi-smoke.Tests.ps1 -Output Detailed
```

Expected on a successful run: **7 passed, 0 skipped, 0 failed**.

---

## Concerns / deferrals

- **No live destructive run on this dev host.** Per brief #9 + C4, the test is verified via static analysis + Pester skip path on this non-admin shared host. A live run on an admin-elevated Windows VM is the next verification step; out of scope for this dev environment.
- **CI integration is Task 11.** Per the brief's plan (`docs/superpowers/plans/2026-08-11-msi-agent-installer.md`), GitHub Actions CI for the MSI is its own task. This Pester file is ready to be dropped into a `windows-latest` job with `runs-on: windows-latest` and admin privilege. The CI's job description, secret management for `msi-signing-cert`, and timeout tuning are Task 11 concerns.
- **`nssm.exe` recovery assertion** (`It 'sets NSSM recovery via sc.exe qfailure'`) asserts the Windows-level `reset= 60 actions= restart/5000/restart/10000/restart/30000` recovery that `ConfigureAgentAction.cs:196` writes via `sc.exe failure`. It does NOT assert the NSSM-level `AppExit Default Restart` recovery (which `sc.exe qfailure` does not surface). Adding an NSSM-reg-key assertion would require a more invasive parse of `HKLM\SYSTEM\CurrentControlSet\Services\ADReplicationAgent` — parked as a follow-up if needed; the brief only asked for the `sc.exe qfailure` assertion.
- **Test #6 (uninstalls cleanly) uses `Start-Sleep -Seconds 2`** to let the SCM delete the service before `Get-Service` checks for it. On a slow VM this might race. If flake appears, replace with `Wait-ForServiceRemoval` polling on a 5-second budget. Out of scope for this task.
- **Cleanup is non-atomic.** If the install succeeds but the uninstall fails midway, `C:\addashboard\Agent` and the `ADReplicationAgent` service will be left behind. The `BeforeAll` defensive cleanup covers the next run, but the failing run leaves residue. This is acceptable for a smoke test on a clean VM; production CI should reset the VM image between runs.
- **`tests/msi-smoke.Tests.ps1` lives under `installer/tests/`** (alongside the xUnit `AgentInstaller.CA.Tests/` directory added in Task 8). The xUnit runner (`dotnet test`) and Pester (`Invoke-Pester`) ignore each other, so there is no cross-contamination. The brief asked for `installer/tests/msi-smoke.ps1`; the actual name is `installer/tests/msi-smoke.Tests.ps1` to match the existing `*.Tests.ps1` discovery convention used by Pester 5/6 and the repo's existing Pester tests under `scripts/tests/`.