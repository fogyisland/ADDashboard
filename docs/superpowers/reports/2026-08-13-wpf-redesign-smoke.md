# WPF Redesign — Smoke Test Report (2026-08-13)

**Status:** DEFERRED to Windows 11 VM — manual smoke (flows 1-7 in spec §Acceptance Criteria) cannot run in this SDD session.

## Evidence available now

### Build

- Command: `dotnet build PackageDesigner.csproj -c Release --no-incremental`
- Result: Build succeeded. **6 Warning(s)** 0 Error(s).
- Warnings are pre-existing and documented in the SDD ledger (Task 9):
  - CS0642 — possible mistaken empty statement — `ViewModels/MetricEditorViewModel.cs:87`
  - CS8602 (×2) — possible null reference dereference — `ViewModels/MetricEditorViewModel.cs:166`, `:172`
  - xUnit2012 — `Assert.True` for collection membership — `Tests/ViewModel/MetricEditorViewModelTests.cs:131` (plus a duplicate emission for the WPF temp-proj `PackageDesigner_ndcyazno_wpftmp.csproj`)
- Per resolution #4: do NOT fix these — they are known and accepted.

### Publish

- Command: `dotnet publish PackageDesigner.csproj -c Release -r win-x64 --self-contained`
- Exit code: 0
- Output path: `bin/PackageDesigner/Release/net8.0-windows/win-x64/publish/PackageDesigner.exe`
- Directory size: **163 MB** (261 files, self-contained `win-x64`)
- The actual on-disk path uses the `Release/<tfm>/<rid>/publish/` convention. The brief's `bin/PackageDesigner/publish/` shorthand refers to this same final location.

### Test suite

- Command: `dotnet test PackageDesigner.Tests.csproj -c Release`
- Result: **Passed: 108, Failed: 0, Skipped: 0, Total: 108** (255 ms)

### Static check

- Warning count: **6** (after `dotnet build -c Release --no-incremental`)
- Error count: **0**

## Deferred

- Manual smoke flows 1-7 listed in `docs/superpowers/specs/2026-08-11-wpf-package-designer-redesign.md` § Acceptance Criteria
- To be executed on the Windows 11 VM before Task 11 whole-branch review
- If any smoke fails, file a block on Task 11 and re-open Task 6/7