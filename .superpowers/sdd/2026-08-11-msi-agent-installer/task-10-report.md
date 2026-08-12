# Task 10 Report — Spec-mirror NSSM config drift test

**Status:** DONE_WITH_CONCERNS
**Date:** 2026-08-12
**Branch/worktree:** `D:\ToolDevelop\ADDashboard\.worktrees\msi-installer` (branch `main` in worktree)

---

## 1. File created

| Field | Value |
|---|---|
| Path | `installer/tests/spec-mirror.Tests.ps1` |
| Lines | 176 |
| Bytes | 9,817 |
| BOM | **absent** (`hasBOM: False`, first 3 bytes `60,35,10` = `<`, `#`, `\n`) |
| Encoding | UTF-8 without BOM; `nonAscii: 0` (pure ASCII, no em-dashes in regex strings or messages) |
| PS 5.1 parse | `[System.Management.Automation.Language.Parser]::ParseFile` → `PS5.1 parse errors: 0` |
| Pester | 6.0.0 on this host (also 3.4.0 present; test imports `-MinimumVersion 5.0`) |

Encoding was produced BOM-free directly and verified by byte inspection rather than
assumed (`Set-Content -Encoding UTF8` on PS 5.1 would have emitted a BOM).

### R1 compliance
`Select-String 'ServiceAccount|SERVICECCOUNT|ObjectName'` → 2 matches, both inside the
`.NOTES` doc comment stating the key is *deliberately absent* (LocalSystem default). No
key of that name is asserted or introduced. This mirrors the existing convention in
`installer/tests/msi-smoke.Tests.ps1` (its C3 note does the same).

---

## 2. Deviations from the brief

### D1 — filename `spec-mirror-tests.ps1` → `spec-mirror.Tests.ps1`
Per the instructions and the Task 9 precedent. Confirmed load-bearing, not cosmetic:
directory-level discovery (`Invoke-Pester -Path installer\tests`) reports
`Running tests from 2 files` and lists the new file. A `-tests.ps1` suffix does not match
Pester's default `*.Tests.ps1` discovery pattern and would have been invisible to CI
(relevant to Task 11). Documented in a top-of-file `.NOTES` block.

### D2 — dropped the brief's `AppEnvironmentExtra` exclusion (**would have failed the build**)
The brief filters the C# key set with:

```powershell
Where-Object { $_ -ne 'AppEnvironmentExtra' } |  # PS1 doesn't set this either
```

The inline claim is **stale**. `scripts/common/NSSM.psm1:96` *does* set it:

```powershell
Invoke-Nssm @('set', $Name, 'AppEnvironmentExtra', 'NODE_ENV=production')
```

and Task 4 added the matching `ConfigureAgentAction.cs:181`
`RunNssmSet(nssm, "AppEnvironmentExtra", "NODE_ENV=production")`. The filter strips the
key from the **C# side only**, leaving it on the PS1 side, so `missingInCa` would be
non-empty on a branch where both sides actually agree. Verified empirically before
writing the test:

```
CA  (12): AppDirectory, AppEnvironmentExtra, AppParameters, AppRotateBytes, AppRotateFiles, AppRotateOnline, AppStderr, AppStdout, DependOnService, Description, DisplayName, Start
PS1 (12): AppDirectory, AppEnvironmentExtra, AppParameters, AppRotateBytes, AppRotateFiles, AppRotateOnline, AppStderr, AppStdout, DependOnService, Description, DisplayName, Start
missingInCa (no filter): []
missingInCa (brief's AppEnvironmentExtra filter): [AppEnvironmentExtra]
```

The brief's remediation path ("add them to `SetNssmParameters` and re-run") is not
applicable — the call already exists. The correct fix is to delete the stale exclusion.
No exclusion list is kept at all; an empty allow-list is the strongest form of the
assertion. Both sides are an exact 12/12 match.

### D3 — added a second `It`: both key sets are non-empty
Regex source-scraping has one dominant rot mode: rename `RunNssmSet`, the regex matches
nothing, `$missingInCa` is trivially empty, and the test passes forever asserting nothing.
The guard converts that silent no-op into a loud failure with a "fix the regex, do not
delete this test" message. It does not widen the drift check's scope. Test count is
therefore 2, not the brief's 1.

### D4 — added comment stripping (**found by doing Step 3; see §4**)
Not in the brief. Required to make the brief's own Step 3 verification meaningful.
Detail in §4.

---

## 3. Pester run output (final, green)

```
Pester v6.0.0

Running tests from 1 files.

Running tests from 'D:\ToolDevelop\ADDashboard\.worktrees\msi-installer\installer\tests\spec-mirror.Tests.ps1'
Describing NSSM spec mirror between MSI CA and install-agent.ps1
  [+] extracts a non-empty NSSM key set from both sources 368ms
  [+] C# CA nssm set keys are a superset of PS1 nssm set keys 35ms
Tests completed in 1.85s
Tests Passed: 2, Failed: 0, Skipped: 0, Inconclusive: 0, NotRun: 0
```

Directory-level run (proves discovery + no regression against Task 9's file):

```
Running tests from 2 files.
WARNING: msi-smoke.Tests.ps1: Not running as Administrator; msiexec /i cannot register the NSSM service on this host.
Re-run on an admin-elevated Windows VM.
[+] D:\...\installer\tests\msi-smoke.Tests.ps1 1.41s
[+] D:\...\installer\tests\spec-mirror.Tests.ps1 400ms
Tests completed in 1.85s
Tests Passed: 2, Failed: 0, Skipped: 7, Inconclusive: 0, NotRun: 0
```

The 7 skips are Task 9's smoke tests skipping on a non-admin host, which is their designed
behaviour. The new test requires no admin, no registry, and no built MSI — it is pure
static source analysis and runs anywhere, including CI.

---

## 4. Step 3 red-green evidence — and the defect it exposed

### 4a. First attempt: injected drift, test **still passed** (false green)

Transient edit to `ConfigureAgentAction.cs:178`:

```csharp
// TRANSIENT DRIFT PROBE - restore immediately (Task 10 Step 3)
// RunNssmSet(nssm, "AppRotateFiles",       "1");
```

Result:

```
Describing NSSM spec mirror between MSI CA and install-agent.ps1
  [+] extracts a non-empty NSSM key set from both sources 165ms
  [+] C# CA nssm set keys are a superset of PS1 nssm set keys 22ms
Tests completed in 1.32s
Tests Passed: 2, Failed: 0, Skipped: 0, Inconclusive: 0, NotRun: 0
```

**This is the defect.** The brief's Step 3 instructs you to verify the test by *commenting
out* a `RunNssmSet` call — but a raw-text regex has no notion of C# comments, so
`// RunNssmSet(nssm, "AppRotateFiles", "1");` still matched and the test reported parity
for a call that no longer executes. The brief's designated proof-of-life is precisely the
scenario the test failed to catch, and it is a realistic rot path (disable a line while
debugging, forget to restore).

### 4b. Fix (D4): strip comments before extraction

Both sources are now passed through a comment stripper before the key regex. The
alternation matches **string literals first** and a `MatchEvaluator` returns those
verbatim, replacing only comment matches with empty — so a `//` inside a URL literal or a
`#` inside a PowerShell string is not mistaken for a comment start (standard
scanner-ordering trick).

- C# form: `@"verbatim"` / `"regular"` strings kept; `/* block */` and `// line` dropped.
- PS1 form: `'single'` / `"double"` strings kept; `<# block #>` and `# line` dropped.

A first cut of the evaluator preserved only double-quoted strings, which deleted the
PowerShell single-quoted keys and collapsed `PsKeys` to 0 — caught by probing before
committing, and exactly the failure mode the D3 non-empty guard exists to catch at
runtime. The evaluator now preserves any quoted literal (`"`, `'`, `@`).

### 4c. Re-run with drift still injected — **RED, as intended**

```
Describing NSSM spec mirror between MSI CA and install-agent.ps1
  [+] extracts a non-empty NSSM key set from both sources 169ms
  [-] C# CA nssm set keys are a superset of PS1 nssm set keys 197ms
   Expected $null or empty, because ConfigureAgentAction.SetNssmParameters must set every
   NSSM parameter that Set-NssmParameters (scripts/common/NSSM.psm1) sets, or an
   MSI-installed service is configured more weakly than a script-installed one.
   Missing in CA: AppRotateFiles. Fix: add the matching RunNssmSet(nssm, 'Key', value)
   call to ConfigureAgentAction.cs., but got 'AppRotateFiles'.
   at $missingInCa | Should -BeNullOrEmpty -Because "...",
   D:\ToolDevelop\ADDashboard\.worktrees\msi-installer\installer\tests\spec-mirror.Tests.ps1:174
Tests completed in 1.74s
Tests Passed: 1, Failed: 1, Skipped: 0, Inconclusive: 0, NotRun: 0
```

The message names the missing key, both files, the consequence, and the fix.

### 4d. Line restored — **GREEN**

```
$ git diff --stat
(no output — ConfigureAgentAction.cs byte-identical to HEAD)
```

```
Describing NSSM spec mirror between MSI CA and install-agent.ps1
  [+] extracts a non-empty NSSM key set from both sources 368ms
  [+] C# CA nssm set keys are a superset of PS1 nssm set keys 35ms
Tests completed in 1.85s
Tests Passed: 2, Failed: 0, Skipped: 0, Inconclusive: 0, NotRun: 0
```

The commented-out state was transient and is **not** committed — confirmed by an empty
`git diff --stat` against HEAD for the `.cs` file.

---

## 5. Concerns / parked items

### C7 (parked for whole-branch review) — regex scope excludes the multi-arg form
Per instruction, both regexes are left at the brief's scope:

- C# side: `RunNssmSet\(\s*nssm\s*,\s*"([^"]+)"` — matches only the simple helper.
  `RunNssmSet\(` cannot match `RunNssmSetMulti(` because the literal `(` must follow
  immediately.
- PS1 side: `Invoke-Nssm\s+@\('set',\s*\$\w+\s*,\s*'([^']+)'` — matches only the array form.

**Uncovered by the parity check:** the `AppExit` / `AppRestartDelay` pair, set on the C#
side by `ConfigureAgentAction.SetServiceRecovery` via `RunNssmSetMulti` (lines 192–193)
and on the PS1 side by `Service.psm1 Set-ServiceRecovery` via direct invocation
`& $nssm set $Name AppExit Default Restart` (lines 41 and 43). Both sides currently *do*
set them identically — the two files carry cross-referencing comments about NSSM 2.24
rejecting the bare `AppExit Restart` form — so there is **no live drift today**, but the
test would not catch it if one side dropped them.

**Design decision taken:** leave both regexes as written; the brief is the authoritative
scope. **Question for the whole-branch reviewer:** should the test widen to also match
`RunNssmSetMulti(` and `& $nssm set $Name Key`? Widening would bring `AppExit` and
`AppRestartDelay` under the same guarantee. This was not taken unilaterally. The
rationale is recorded in the file's `.NOTES` so a maintainer reading the test does not
assume coverage that is not there.

### Sole reason for DONE_WITH_CONCERNS
The task is complete and green. The status reflects (a) the parked C7 scope question above
and (b) that two brief-specified details were corrected rather than followed literally —
D2 (stale `AppEnvironmentExtra` exclusion, which would have produced a failing test on a
correct branch) and D4 (comment stripping, without which the brief's own Step 3 gives a
false green). Both are documented in-file and above, and both are reviewer-visible
decisions rather than silent departures.

---

## 6. What surprised me

1. **The brief's Step 3 verification did not work as written.** Commenting out a line is
   the natural way to inject drift, and it is what the brief prescribes — but it is
   invisible to a raw-text regex. Had Step 3 been skipped, or performed by *deleting* the
   line instead of commenting it, the gap would have shipped and the test would have been
   weaker than everyone believed. This is a direct argument for actually running
   red-green checks rather than reasoning about them.

2. **The brief's exclusion comment contradicted the source.** `# PS1 doesn't set this
   either` is false as of `NSSM.psm1:96`. Copying the brief verbatim would have produced a
   red test on a branch with zero real drift — the worst outcome for a drift test, since
   the natural response is to weaken the assertion.

3. **Both sides are already a perfect 12/12 match** on the simple form. Tasks 4 and the
   PS1 installer converged without this test existing, so it lands as a regression guard
   rather than a bug-finder — apart from the two latent problems in the test's own design
   above.

4. **The PS1 comment-stripping first cut silently zeroed the key set** rather than
   erroring. That is the exact failure the D3 non-empty guard was added for, encountered
   during development before the guard's value was theoretical. Good validation that D3
   earns its place.

---

## 7. Commits

| Hash | Message |
|---|---|
| `f98dd34` | `test(msi): spec-mirror drift test (NSSM config parity C# vs PS1)` |
| (this file) | `docs(msi): Task 10 - spec-mirror drift test report` |

`ConfigureAgentAction.cs` is unmodified by this task (verified via empty `git diff --stat`
after restoring the Step 3 probe).
