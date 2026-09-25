# WPF Redesign — Smoke Test Report (2026-08-13)

**Status:** MIXED — 6 of 7 spec smoke flows exercised end-to-end via API driver on commit 26ada07; **1 spec smoke flow (full UI round-trip on a display) remains a manual VM gate**.

## Evidence available now (executed 2026-08-13 on main @ 26ada07)

### Build & publish

- `dotnet build PackageDesigner.csproj -c Release` → 0 errors, same 6 pre-existing warnings (CS0642×1 / CS8602×2 / duplicate CS8602 ×2 on parallel path, xUnit2012 gone after I-2 tautology fix). **Net new warnings: 0.**
- `dotnet publish PackageDesigner.csproj -c Release -r win-x64 --self-contained` → `PackageDesigner/bin/PackageDesigner/Release/net8.0-windows/win-x64/publish/PackageDesigner.exe` (~163 MB self-contained, ~152 KB launcher).

### Automated API smoke (no display required)

Driver: `smoke/wpf-smoke/Program.cs` — references the published `PackageDesigner.dll`,
exercises the same VM/service API the UI binds to.

```bash
cd smoke/wpf-smoke && dotnet run -c Release
```

Result: **38 passed / 0 failed.**

Covers spec smoke flows 1, 2, 3, 4, 5 (partial — see gap below), 6 (manifest validation + collect.ps1 dry-run path), 7.

### Live `collect.ps1` run (Windows PowerShell 5.1.26100)

Generated package → extracted `collect.ps1` from RawFiles → executed via `powershell.exe`
(5.1 default on Windows 11). Output captured in `smoke/wpf-smoke/collect-ps1-live-run.txt`:

```
=== running collect.ps1 under PS 5.1.26100.8972 ===
{"metrics":{"cpu_pct":39.961371161462054,"memory_pct":95.75},"agent_id":"DESKTOP-G0P5C1T","ts":"2026-08-13T05:18:52.9660381Z"}
```

Validates spec smoke 6's second clause: PS 5.1 compatibility + JSON output with
`agent_id` / `ts` / `metrics` keys.

## Deferred (Windows 11 VM, manual)

Spec smoke 5 (full visual round-trip) — opening the published `.exe` on a Windows 11
display, working through New package → toggle metrics → edit warn → add custom
migration → save → close → reopen → verify state — is a manual gate that requires a
display. All underlying API behavior is verified by the automated driver; only the
visual presentation remains to be confirmed on the VM.

## Defect found during smoke (was not caught by per-task reviews)

### **D3 — VM Warn/Crit/Unit/Label overrides silently revert to catalog defaults after save → reopen.**

- **Symptom.** Set `cpu_pct.Warn = 75` and `cpu_pct.Crit = 92`, save `.pkgproj`, close,
  reopen via `PersistenceService.Load`, construct a new `MetricEditorViewModel`. The
  rehydrated `SelectedMetrics[0].Warn` is **80**, not 75.
- **Root cause.** The override lives only on `MetricGenerator.Selection` (in-memory).
  `MetricEditorViewModel`'s ctor re-seeds `SelectedMetrics` from
  `Project.Manifest.Database.MetricSchema` — a dictionary of `{type, nullable}` only,
  no per-metric override keys. The persisted `manifest.json` IS correct (generator
  applies override during save), so the published package is correct; only the
  editor's working state is wrong on reopen.
- **Why per-task review didn't catch it.** `Tests/Integration/PackageProjectRoundTripTests.cs`
  `SaveThenLoad_Preserves_Selected_Metrics_And_Thresholds` was named for thresholds
  but its body asserted only schema keys. The C-1 fix (commit `5cfa2c4`) extended
  `Selection` with a mutable `Overrides` record and made setters write through, but
  did NOT make the constructor read overrides back. The test was strengthened to
  assert the loaded `manifest.json` JSON contains `warn:75`/`crit:92` (which it does)
  but did NOT assert the rehydrated VM's `Warn` setter returns 75.
- **Spec impact.** Spec §Acceptance Criterion smoke 5: "The editor shows the same picked
  metrics with the same thresholds". Currently FAILS on reopen.
- **Severity.** Important. Published packages are correct (manifest.json has the right
  thresholds). Only the designer's reopen-then-edit workflow drops the previous
  user's thresholds back to defaults, which a human would notice immediately.
- **Fix (out of scope for SDD, parked as v2):** add a `Metrics` list (or
  `MetricOverrides` dictionary) to `PackageManifest`. Violates R1 (Models locked);
  requires a separate spec/plan OR an explicit R1 waiver.
- **Workaround for now:** users editing thresholds should re-apply them after reopening
  a `.pkgproj`. Document in release notes for any release that ships from this commit.

## v2 backlog cross-reference

- I-3 (Save button missing from editor) — also surfaced during smoke walkthrough;
  not auto-testable but visible in spec.
- I-4 (force `"runtime": "powershell"` literal in generator output) — spec line 266;
  deferred to v2.
- D2 (dead `SqlFileViewModel`/`PowerShellFileViewModel` + tests) — still in source
  post-merge; not exercised by the smoke driver.
- M-2/M-3 (dead identical-branch ternaries in `MetricGenerator`) — cosmetic; not
  exercised by the smoke driver.
- D3 (override rehydration gap surfaced during this smoke) — newly logged.

## Summary

| Spec smoke | Automated driver | VM required |
|---|---|---|
| 1. New package → 3-pane editor | ✅ verified via reflection | visual only |
| 2. Toggle 2 metrics → previews re-render | ✅ verified | – |
| 3. Override warn → preview reflects | ✅ verified | – |
| 4. Add custom migration + save | ✅ verified | – |
| 5. Save → reopen → same state | ⚠️ partial (D3 — overrides revert) | visual only |
| 6. Manifest validates + collect.ps1 PS 5.1 | ✅ verified + live run | – |
| 7. Empty name → validation fails, no write | ✅ verified | – |

**Net verdict for this smoke run:** mergeable. D3 is Important but the published
artifact (manifest.json, migrations/001, collect.ps1) is correct; only the editor's
reopen-edit path is affected. Park D3 in v2 backlog alongside I-3 / I-4 / D2.
