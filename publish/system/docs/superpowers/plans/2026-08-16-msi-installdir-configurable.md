# MSI INSTALLDIR Configurable + LogDir Follows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the MSI agent installer's `INSTALLDIR` (and therefore log directory) reflect the operator-supplied path on `msiexec` command line, while preserving byte-identical behavior for the un-overridden default (`C:\addashboard\Agent` → `C:\addashboard\Logs`).

**Architecture:** The MSI CustomAction `ConfigureAgentAction` already receives `INSTALLDIR` through `CustomActionData` (existing plumbing — `INSTALLDIR`, `CENTERURL`, `AGENTTOKEN`, `AGENTTYPE`, `PRESERVE_APPSETTINGS`). The only real change is replacing the hardcoded `LogDir = "C:\addashboard\Logs"` field default with a derived computation `Path.Combine(data.InstallDir, "..", "Logs")` at the time `SetNssmParameters` writes `AppStdout`/`AppStderr`. Tests + README follow.

**Tech Stack:** WiX Toolset 5.0+ (MSI), C# (`WixToolset.Dtf.WindowsInstaller` CA), xUnit (`ConfigureAgentActionTests.cs`), Pester 6.0.0 (`msi-smoke.Tests.ps1`).

**Spec:** This plan implements the design brainstormed in chat on 2026-08-16. The existing MSI spec [`docs/superpowers/specs/2026-08-11-msi-agent-installer-design.md`](2026-08-11-msi-agent-installer-design.md) already documents `INSTALLDIR` as a configurable property (lines 150, 160, 473) and Self-Contained Monitoring Package spec is preserved in CA-owned `appsettings.json` (ConfigureAgentAction.cs header notes). The plan argues from this in-chat design rather than a separate spec doc because the change is small (5 files, ~30 net lines) and the existing spec already governs the override path.

## Global Constraints

- **Backward compat by default:** Unmodified `msiexec /i ADDashboardAgent.msi /qn` must produce byte-identical install to v1.0.0 — `INSTALLDIR=C:\addashboard\Agent`, log dir `C:\addashboard\Logs`. Major upgrade (same `ProductCode` + `UpgradeCode`) preserves the existing path.
- **MSI does not implement `LogDir` as MSI Property** — `LogDir` is a derived C# field, not a public property. Operators cannot override `LogDir` separately from `INSTALLDIR`.
- **PowerShell 5.1 + pwsh 7+ dual compat** for any Pester test edits (no `??`, no ternary `?:`, no 3-arg `Join-Path`).
- **C# / WiX 5 maintain compatibility** with `WixToolset.Dtf.WindowsInstaller.CustomActionData` dictionary semantics (no `string`-ctor bug — use parameterless ctor + `.Add(key, value)` in tests).
- **Agent runtime does NOT read `installPath`/`INSTALLDIR` from `appsettings.json`** — agent derives paths from `__dirname` at startup. No change to `agent/src/` is needed.
- **Tier 4 frozen:** `docs/superpowers/specs/2026-08-11-msi-agent-installer-design.md` and `docs/superpowers/plans/2026-08-11-msi-agent-installer.md` (which contain 50 C:\addashboard examples) are NOT modified — they're historical audit trail.

---

## File Structure

```
publish/installer/agent-installer/
├── CA/
│   ├── ConfigureAgentAction.cs        # Modified — remove LogDir default, add DeriveLogDir()
│   └── ConfigureAgentAction.cs (unchanged in all other areas)
└── tests/
    ├── AgentInstaller.CA.Tests/
    │   └── ConfigureAgentActionTests.cs  # Modified — add LogDir_DerivedFromInstallDir test
    └── msi-smoke.Tests.ps1              # Modified — $InstallDir default = $env:TEMP\msi-agent-test, add log dir assertion

publish/installer/
└── README.md                            # Modified — INSTALLDIR override section + log path update
```

Files changed: 5. **No Product.wxs / Files.wxs / CustomActions.wxs change** — those already do the right thing (the MSI `Type=51` SetProperty CA in `WixUI_InstallDir` wixlib propagates `INSTALLDIR` → `WIXUI_INSTALLDIR` in `CostFinalize`; that wiring is already done).

---

### Task 1: ConfigureAgentAction — derive LogDir from InstallDir

**Files:**
- Modify: `publish/installer/agent-installer/CA/ConfigureAgentAction.cs:42-50` (remove `LogDir` field default)
- Modify: `publish/installer/agent-installer/CA/ConfigureAgentAction.cs:159-183` (replace `Data.LogDir` usage with derivation)
- Test: `publish/installer/tests/AgentInstaller.CA.Tests/ConfigureAgentActionTests.cs:295-298` (add new test)

**Interfaces:**
- Consumes: existing `ConfigureAgentData { InstallDir, CenterUrl, AgentToken, AgentType, PreserveAppsettings }` (no other change)
- Produces: `internal static string DeriveLogDir(string installDir)` — pure helper, `InstallDir + "..\Logs"` resolved via `Path.GetFullPath`. SetNssmParameters calls `DeriveLogDir(data.InstallDir)` instead of reading `data.LogDir`.

**Self-review note:** `data.LogDir` field is removed entirely (not just its default). Nothing else reads it — `SetNssmParameters` is the only consumer (lines 176-177). xUnit tests don't reference `data.LogDir`.

- [ ] **Step 1: Write the failing test**

Add at the end of `ConfigureAgentActionTests.cs` (before the closing braces), just after the `ParseCustomActionData_PartialKeys_OnlyPopulatesPresent` block:

```csharp
// ---------------------------------------------------------------------
//  DeriveLogDir — LogDir follows InstallDir
//
//  Production rule (per 2026-08-16 design): LogDir is derived from
//  InstallDir at install time, not stored as a hardcoded field. The
//  derived value is `<InstallDir>\..\Logs` resolved to an absolute path
//  via Path.GetFullPath. When InstallDir = C:\addashboard\Agent (the
//  un-overridden default), LogDir = C:\addashboard\Logs (byte-identical
//  to the v1.0.0 hardcoded value). When InstallDir = D:\Dashboard\Agent,
//  LogDir = D:\Dashboard\Logs.
// ---------------------------------------------------------------------

[Theory]
[InlineData(@"C:\addashboard\Agent", @"C:\addashboard\Logs")]
[InlineData(@"D:\Dashboard\Agent", @"D:\Dashboard\Logs")]
[InlineData(@"C:\Program Files\ADDashboard\Agent", @"C:\Program Files\ADDashboard\Logs")]
[InlineData(@"C:\Agent", @"C:\Logs")]
public void DeriveLogDir_FollowsInstallDir(string installDir, string expected)
{
    Assert.Equal(expected, ConfigureAgentAction.DeriveLogDir(installDir));
}

[Fact]
public void DeriveLogDir_NormalisesRelativeSegment()
{
    // Path.GetFullPath must collapse the ".." segment. Equivalent
    // inputs (trailing slash, no slash, redundant dots) all resolve
    // to the same absolute path.
    Assert.Equal(
        ConfigureAgentAction.DeriveLogDir(@"C:\addashboard\Agent"),
        ConfigureAgentAction.DeriveLogDir(@"C:\addashboard\Agent\"));
    Assert.Equal(
        ConfigureAgentAction.DeriveLogDir(@"C:\addashboard\Agent"),
        ConfigureAgentAction.DeriveLogDir(@"C:\addashboard\Agent\.\"));
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd "D:/ToolDevelop/ADDashboard/publish/installer/tests/AgentInstaller.CA.Tests"
"/c/Program Files/dotnet/dotnet.exe" test --nologo --filter "FullyQualifiedName~DeriveLogDir"
```

Expected: build error `ConfigureAgentAction.DeriveLogDir` does not exist (method missing).

- [ ] **Step 3: Implement DeriveLogDir + remove LogDir field default**

Edit `publish/installer/agent-installer/CA/ConfigureAgentAction.cs`:

**3a.** Remove the `LogDir` field default from `ConfigureAgentData` (line 49). Replace:

```csharp
        public string LogDir = @"C:\addashboard\Logs";
```

with:

```csharp
        // LogDir is derived from InstallDir at install time via DeriveLogDir()
        // (see SetNssmParameters). It is intentionally NOT a stored field —
        // when InstallDir is supplied via INSTALLDIR=, the log dir must follow,
        // not stay at a hardcoded C:\addashboard\Logs.
```

**3b.** In `SetNssmParameters` (line 159), replace `data.LogDir` with a local `var logDir = DeriveLogDir(data.InstallDir);` computed at the top of the method (after reading `nssm` and `hostname`). The two `Path.Combine(data.LogDir, ...)` calls on lines 176-177 become `Path.Combine(logDir, ...)`. Full method body after the change:

```csharp
        internal static void SetNssmParameters(ConfigureAgentData data)
        {
            var nssm = Path.Combine(data.InstallDir, "nssm", "nssm.exe");
            var hostname = Environment.MachineName;
            var logDir = DeriveLogDir(data.InstallDir);
            var displayName = data.AgentType == "non-ad"
                ? "AD Dashboard Agent (Member)"
                : $"AD Replication Agent (on {hostname})";
            var description = data.AgentType == "non-ad"
                ? "AD Dashboard member-server monitor (self-register + heartbeat + package fetch)"
                : "AD Replication collection agent";

            RunNssmSet(nssm, "AppDirectory",         data.InstallDir);
            RunNssmSet(nssm, "AppParameters",        "agent.js");
            RunNssmSet(nssm, "DisplayName",          displayName);
            RunNssmSet(nssm, "Description",          description);
            RunNssmSet(nssm, "Start",                "SERVICE_AUTO_START");
            RunNssmSet(nssm, "DependOnService",      "DNS Client,Netlogon");
            RunNssmSet(nssm, "AppStdout",            Path.Combine(logDir, "ADReplicationAgent-stdout.log"));
            RunNssmSet(nssm, "AppStderr",            Path.Combine(logDir, "ADReplicationAgent-stderr.log"));
            RunNssmSet(nssm, "AppRotateFiles",       "1");
            RunNssmSet(nssm, "AppRotateOnline",      "1");
            RunNssmSet(nssm, "AppRotateBytes",       "10485760");
            RunNssmSet(nssm, "AppEnvironmentExtra",  "NODE_ENV=production");
            // LocalSystem default — no ObjectName set, matches install-agent.ps1.
        }
```

**3c.** Add the `DeriveLogDir` helper just before `RunNssmSet` (around line 276, after `RunProcess` block, before `RunNssmSet`):

```csharp
        /// <summary>
        /// Derive the log directory from the install directory.
        /// LogDir = InstallDir's parent + "\Logs", resolved to an absolute
        /// path via Path.GetFullPath. When InstallDir = C:\addashboard\Agent
        /// (the un-overridden default), LogDir = C:\addashboard\Logs — byte-
        /// identical to the v1.0.0 hardcoded value. When InstallDir = D:\foo
        /// \Agent, LogDir = D:\foo\Logs — follows the install (symmetric with
        /// PS1 install-agent.ps1 which uses `<InstallPath>\Logs`).
        /// </summary>
        internal static string DeriveLogDir(string installDir)
        {
            return Path.GetFullPath(Path.Combine(installDir, "..", "Logs"));
        }
```

- [ ] **Step 4: Run all xUnit tests to verify they pass + no regression**

```bash
cd "D:/ToolDevelop/ADDashboard/publish/installer/tests/AgentInstaller.CA.Tests"
"/c/Program Files/dotnet/dotnet.exe" test --nologo
```

Expected: all tests pass (the existing 29 tests + the new 5 `DeriveLogDir_*` tests + the new `DeriveLogDir_NormalisesRelativeSegment` test = 35 total). Verify no test failure with `tests Passed: 35, Failed: 0, Skipped: 0` (or similar count).

- [ ] **Step 5: Commit**

```bash
cd "D:/ToolDevelop/ADDashboard"
git add publish/installer/agent-installer/CA/ConfigureAgentAction.cs
git add publish/installer/tests/AgentInstaller.CA.Tests/ConfigureAgentActionTests.cs
git commit -m "fix(msi): derive LogDir from InstallDir instead of hardcoding C:\\addashboard\\Logs

The MSI agent installer's LogDir used to be a hardcoded field default
(@"C:\addashboard\Logs") on ConfigureAgentData. With INSTALLDIR=
configurable on the msiexec command line (Product.wxs WIXUI_INSTALLDIR
propagates to INSTALLDIR via the WixUI_InstallDir wixlib's Type=51
SetProperty CA in CostFinalize), a hardcoded LogDir would silently
write logs to C:\addashboard\Logs even when the operator installed
to D:\Dashboard\Agent — making logs impossible to find.

Replace the field default with a DeriveLogDir(installDir) helper that
computes <InstallDir>\\..\\Logs at install time. When InstallDir =
C:\addashboard\Agent (the un-overridden default), LogDir = C:\addashboard
\Logs — byte-identical to the v1.0.0 behavior. When InstallDir = D:\foo\
Agent, LogDir = D:\foo\Logs — follows the install.

This matches the PS1 install-agent.ps1 convention (Join-Path $InstallPath
'Logs') and the per-row '跟 INSTALLDIR 走' decision from the 2026-08-16
brainstorm.

Add 5 DeriveLogDir unit tests covering the default, cross-drive, spaces-
in-path, no-trailing-slash, and relative-segment-normalisation cases.

29 → 35 xUnit tests, all green.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 2: msi-smoke.Tests.ps1 — tempdir default + log dir assertion

**Files:**
- Modify: `publish/installer/tests/msi-smoke.Tests.ps1:96` (change `$InstallDir` default)
- Modify: `publish/installer/tests/msi-smoke.Tests.ps1:218-219` (extend existing It block with log dir path assertion)

**Interfaces:**
- Consumes: existing `-InstallDir` parameter (still operator-overridable)
- Produces: tests now default to `$env:TEMP\msi-agent-test` (no C:\addashboard pollution on the test host) and assert `<InstallDir>\..\Logs` is the log dir

**Self-review note:** The existing It block `writes appsettings.json with correct keys` (line 208-219) already touches `appsettings.json` paths. The new log dir assertion is a sibling check — verify the NSSM service was configured with the derived log dir. Use `sc.exe qc` (query config) which dumps the full service config including `AppDirectory`, not just `qfailure` (recovery).

- [ ] **Step 1: Change `$InstallDir` default**

Edit `publish/installer/tests/msi-smoke.Tests.ps1` line 96 (the `[CmdletBinding()]` param block). Replace:

```powershell
  [string]$InstallDir = 'C:\addashboard\Agent',
```

with:

```powershell
  [string]$InstallDir = (Join-Path -Path $env:TEMP -ChildPath 'msi-agent-test'),
```

Note: `[CmdletBinding()]` evaluates `[string]$InstallDir = '...'` at parse time, but `Join-Path` runs at function-call time which is fine because `$env:TEMP` is available in any host context. Existing callers passing `-InstallDir 'C:\addashboard\Agent'` (the documented example) still work — the default is just the fallback.

- [ ] **Step 2: Add log dir assertion to the existing It block**

Edit `It 'writes appsettings.json with correct keys'` (line 208-219). After the existing `psScriptPath` / `psDiscoveryScriptPath` assertions, add:

```powershell
    $expectedLogDir = [System.IO.Path]::GetFullPath((Join-Path -Path $script:InstallDir -ChildPath '..\Logs'))
    # Resolve to absolute so the qc output strings line up on cross-drive
    # cases (InstallDir = D:\foo\Agent → expectedLogDir = D:\foo\Logs).

    $qcOut = sc.exe qc $script:ServiceName | Out-String
    # NSSM's AppStdout = <LogDir>\ADReplicationAgent-stdout.log via SetNssmParameters.
    $qcOut | Should -Match ([regex]::Escape($expectedLogDir))
```

Insert this just before the closing `}` of the `It` block (line 219). The full block now reads:

```powershell
  It 'writes appsettings.json with correct keys' {
    if ($script:SkipReason) { Set-ItResult -Skipped -Because $script:SkipReason; return }
    $cfgPath = Join-Path -Path $script:InstallDir -ChildPath 'appsettings.json'
    $cfg = Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json
    $cfg.centerUrl                  | Should -Be $script:CenterUrl
    $cfg.agentToken                 | Should -Be $script:AgentToken
    $cfg.agentType                  | Should -Be $script:AgentType
    $cfg.pollingIntervalMinutes     | Should -Be 15
    $cfg.heartbeatIntervalSeconds   | Should -Be 5
    $cfg.psScriptPath               | Should -BeLike '*\scripts\collect-replication.ps1'
    $cfg.psDiscoveryScriptPath      | Should -BeLike '*\scripts\collect-discovery.ps1'

    $expectedLogDir = Join-Path -Path $script:InstallDir -ChildPath '..\Logs'
    # Resolve to absolute so the qc output strings line up on cross-drive
    # cases (InstallDir = D:\foo\Agent → expectedLogDir = D:\foo\Logs).
    $expectedLogDir = [System.IO.Path]::GetFullPath($expectedLogDir)

    $qcOut = sc.exe qc $script:ServiceName | Out-String
    # NSSM's AppStdout = <LogDir>\ADReplicationAgent-stdout.log via SetNssmParameters.
    $qcOut | Should -Match ([regex]::Escape($expectedLogDir))
  }
```

- [ ] **Step 3: Update BeforeAll cleanup to handle the new $env:TEMP default**

Find the pre-cleanup block in `BeforeAll` (lines 159-168):

```powershell
    if (Get-Service -Name $script:ServiceName -ErrorAction SilentlyContinue) {
      try {
        sc.exe stop $script:ServiceName | Out-Null
        Start-Sleep -Seconds 2
      } catch { }
      try { sc.exe delete $script:ServiceName | Out-Null } catch { }
    }
    if (Test-Path -LiteralPath $script:InstallDir) {
      try { Remove-Item -LiteralPath $script:InstallDir -Recurse -Force } catch { }
    }
```

The `$InstallDir` is now under `$env:TEMP`, so the `Remove-Item -LiteralPath $script:InstallDir` step cleans the test subdir. **No change needed** — the existing pattern already removes the test install dir. Just confirm the parent `$env:TEMP\msi-agent-test` is recreated fresh.

- [ ] **Step 4: Run Pester tests to verify static analysis + skip path**

```bash
cd "D:/ToolDevelop/ADDashboard"
"/c/Program Files/PowerShell/7-preview/pwsh.exe" -NoProfile -Command "Invoke-Pester -Path 'publish/installer/tests/msi-smoke.Tests.ps1' -Output Minimal"
```

Expected: all 6 It blocks run, all skip with `$script:SkipReason = 'Not running as Administrator...'` (or similar). Tests Passed: 0, Failed: 0, Skipped: 6. **No new failures.** If a test fails, re-check the Step 2 regex escape for the log dir path.

- [ ] **Step 5: Commit**

```bash
cd "D:/ToolDevelop/ADDashboard"
git add publish/installer/tests/msi-smoke.Tests.ps1
git commit -m "test(msi): default InstallDir to \$env:TEMP\\msi-agent-test + assert LogDir

The Pester E2E smoke previously defaulted to InstallDir=
C:\\addashboard\\Agent — same as the production MSI default. On a
dev box the test pattern itself does not install (SkipReason on
non-admin hosts), but the default value lived in the test body and
would silently install MSI to C:\\addashboard\\Agent if a Windows
VM ran the script without an explicit -InstallDir override.

Switch default to Join-Path \$env:TEMP 'msi-agent-test' so the test
host never pollutes C:\\ root, even if a future script caller forgets
to override. Callers passing -InstallDir 'C:\\addashboard\\Agent'
(the documented example) still work — the default is just the fallback.

Add a log dir assertion to the existing 'writes appsettings.json with
correct keys' It block: pull the NSSM service config via sc.exe qc and
verify AppStdout points at <InstallDir>\\..\\Logs (the new derived
value). RegEx-escape the path so spaces in InstallDir (e.g.,
'C:\\Program Files\\ADDashboard\\Agent') don't break the match.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 3: README — INSTALLDIR override section + log path update

**Files:**
- Modify: `publish/installer/README.md:9-19` (add "### 自定义安装路径" section under "## 直接使用")
- Modify: `publish/installer/README.md:85` (update log path row in "数据落盘" table)

**Interfaces:**
- Consumes: existing README structure (mirror conventions of `publish/system/README.md`)
- Produces: documentation that operators can copy-paste to install to a non-default path

**Self-review note:** The README is in `publish/installer/`, not mirrored to `publish/system/installer/` (the installer subfolder is a separate codebase). No `publish_sync` mirror needed.

- [ ] **Step 1: Add "### 自定义安装路径" section**

Edit `publish/installer/README.md`. After the existing "## 直接使用" subsections (after line 19, before "## 重新构建" on line 21), add:

```markdown
### 自定义安装路径

默认装到 `C:\addashboard\Agent`。要装到其他路径，在 `msiexec` 命令行加 `INSTALLDIR=`：

```cmd
msiexec /i ADDashboardAgent.msi /qn INSTALLDIR="D:\Dashboard\Agent"
```

日志路径自动跟随 INSTALLDIR：装到 `D:\Dashboard\Agent` 时日志落到 `D:\Dashboard\Logs\`，跟 PS1 installer (`<InstallPath>\Logs`) 行为一致。带空格的路径也支持（如 `C:\Program Files\ADDashboard\Agent`），但需用英文双引号包住。

不传 `INSTALLDIR=` 时保持向后兼容（v1.0.0 升级路径不变，MajorUpgrade 原地升级）。
```

**3a.** Markdown caveat: the existing README uses fenced code blocks with no language tag (e.g., ` ```cmd `). Match that style. The triple-backtick fence inside the section needs no extra escapes since the inner block is the README's own code example, but verify the rendering: each fence line has its own triple-backtick, so this self-references cleanly. If a Markdown linter rejects it, drop the inner block: just inline the `msiexec` command as a single line.

- [ ] **Step 2: Update log path in 数据落盘 table**

Edit `publish/installer/README.md` line 85. Replace:

```markdown
| Agent 日志 | `C:\addashboard\Logs\ADDashboardAgent-{stdout,stderr}.log` |
```

with:

```markdown
| Agent 日志 | `<INSTALLDIR>\..\Logs\ADReplicationAgent-{stdout,stderr}.log`（默认 `C:\addashboard\Logs`） |
```

- [ ] **Step 3: Verify render**

Read the edited file and confirm the new section is well-formed. Expected: the new "### 自定义安装路径" section appears between "## 直接使用" and "## 重新构建", and the log path row in the 数据落盘 table reflects the new derived location.

- [ ] **Step 4: Commit**

```bash
cd "D:/ToolDevelop/ADDashboard"
git add publish/installer/README.md
git commit -m "docs(msi): document INSTALLDIR override + log dir follows InstallDir

Add '### 自定义安装路径' section under '## 直接使用' with the
msiexec INSTALLDIR= example and a note that log dir follows INSTALLDIR
(matching PS1 install-agent.ps1's <InstallPath>\\Logs convention).

Update the 数据落盘 table log path row to show the derived location
<INSTALLDIR>\\..\\Logs instead of the hardcoded C:\\addashboard\\Logs.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 4: Whole-branch review (opus)

**Files:** None modified in this task. Read-only review.

**Goal:** Independent review of the 3 prior commits for spec compliance, code quality, and backward-compat correctness. Flag any silent behavior change for v1.0.0 un-overridden installs.

**Review package:** `git diff HEAD~3..HEAD -- publish/installer/`

**Reviewer checklist:**
1. **Spec compliance** — all 3 design decisions (default INSTALLDIR unchanged / LogDir follows InstallDir / test default to `$env:TEMP\msi-agent-test`) are implemented as designed.
2. **Backward compat** — verify the un-overridden default (`msiexec /i ADDashboardAgent.msi /qn`) still produces `C:\addashboard\Agent` install + `C:\addashboard\Logs` logs. Cross-check: `DeriveLogDir(@"C:\addashboard\Agent") == @"C:\addashboard\Logs"`.
3. **No silent behavior change for MajorUpgrade** — `ProductCode` and `UpgradeCode` are unchanged.
4. **Tests cover the new behavior** — `DeriveLogDir_FollowsInstallDir` 4 inline cases + `DeriveLogDir_NormalisesRelativeSegment` + the Pester `It` block extended with log dir assertion.
5. **README Pester test is syntax-clean** — `[CmdletBinding()]` default still parses under PS 5.1 + pwsh 7+; no `??` / ternary / 3-arg `Join-Path`.
6. **Tier 4 frozen** — `docs/superpowers/specs/2026-08-11-msi-agent-installer-design.md` and `docs/superpowers/plans/2026-08-11-msi-agent-installer.md` are NOT modified.
7. **MSI is the only path** — agent `appsettings.json` does NOT need `installPath` because agent derives paths from `__dirname` at runtime. Verify no `agent/src/` change.

- [ ] **Step 1: Dispatch opus whole-branch review**

Use the `superpowers:requesting-code-review` skill, dispatching on the most capable model with the diff scope:

```bash
cd "D:/ToolDevelop/ADDashboard"
git diff HEAD~3..HEAD -- publish/installer/ > .superpowers/sdd/msi-installdir-configurable-review-package.txt
```

Then dispatch the review per the skill's prompt template, passing the diff file plus the 7 checklist items above.

- [ ] **Step 2: Handle reviewer verdict**

**If NEEDS FIXES:** Apply the fix in a follow-up commit, then dispatch a scoped re-review (the same review package, this time only the new fix commit's diff). Common scope: 1 fix round.

**If READY TO MERGE:** Final cleanup commit (if any minor nits), then merge to main and push origin:

```bash
cd "D:/ToolDevelop/ADDashboard"
git push origin main
```

- [ ] **Step 3: Update memory + project_next_session_prompt**

After successful merge, append a progress note to `progress_2026_08_16.md` with the final commit hashes, xUnit test count, and any reviewer findings worth carrying forward. Update `MEMORY.md` index with a one-line pointer if the change materially shifts the project's MSI defaults story.

---

## Self-Review

**1. Spec coverage:** Each of the 3 user-confirmed decisions (default INSTALLDIR unchanged / LogDir follows InstallDir / test default to `$env:TEMP\msi-agent-test`) maps to:
- Default INSTALLDIR unchanged → Task 1 (no Product.wxs change) + Task 3 README (documents "保持向后兼容")
- LogDir follows InstallDir → Task 1 (DeriveLogDir + SetNssmParameters) + Task 2 (Pester log dir assertion) + Task 3 (README update)
- Test default → Task 2 (Pester InstallDir default)

**2. Placeholder scan:** No "TBD" / "TODO" / "implement later" in any task. All code blocks are complete. Read-back of Task 1 Step 3b shows the full new `SetNssmParameters` body — no abbreviated sections.

**3. Type consistency:** `DeriveLogDir(string installDir) -> string` (Task 1) is referenced consistently. `ConfigureAgentAction.DeriveLogDir` is the fully-qualified name used in both Task 1 (definition) and Task 1 (tests). `data.InstallDir` is the field name throughout (vs `data.InstallDir` + `data.LogDir` in the v1.0.0 code — `LogDir` is removed entirely in Task 1 Step 3a, so no name collision).

**4. Interface consistency:** CustomActionData flow (lines 85-94 of `ConfigureAgentAction.cs`) is not touched. `INSTALLDIR` key continues to be parsed the same way. No MSI Property table change.

**5. Check the editor's expectation:** The user said "OK" after the design proposal. The plan implements exactly what was proposed in Section 1-6 of the design. No scope creep.
